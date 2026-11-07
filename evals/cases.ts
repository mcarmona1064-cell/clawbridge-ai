/**
 * ClawBridge eval cases: two-sided scenarios.
 *
 * Each case pairs what a person does in a chat (the user side) with what
 * the assistant must do (the agent side), and checks it against the real
 * host code: reply/no-reply decisions, memory scoping and leak canaries,
 * approvals, the claim gate, channel rendering, commands and policies.
 *
 * Cases are deterministic. The runner repeats each one three times per
 * provider and requires all three to pass (pass^3).
 */
import { capabilitiesFor, planChoices } from '../src/channels/capabilities.js';
import { interceptNumberedReply, prepareOutbound } from '../src/channels/channel-layer.js';
import { matchNumberedReply, renderChunks, toTelegramHtml, toWhatsApp } from '../src/channels/render.js';
import { optKeyword } from '../src/channels/contact-state.js';
import { gateClaims, recordSessionAction } from '../src/claim-gate.js';
import { handleChatControl } from '../src/chat-controls.js';
import { createAgentGroup } from '../src/db/agent-groups.js';
import { getDb } from '../src/db/connection.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../src/db/messaging-groups.js';
import { createUserLink, primaryUserId } from '../src/db/user-links.js';
import { widensAudience } from '../src/egress-guard.js';
import { engageReason } from '../src/engage-log.js';
import { classifyAgentError, rewriteAgentError } from '../src/friendly-errors.js';
import { memoryScopeForSession, readableScopesForSession } from '../src/memory/scope.js';
import { parsePreset, resolvePreset } from '../src/model-presets.js';
import { handleIdentityCommand } from '../src/modules/identity/index.js';
import { alwaysAllowScope } from '../src/modules/host-exec/index.js';
import { isWriteRequest, availableIntegrations } from '../src/modules/integrations/registry.js';
import { scheduleRefusal } from '../src/modules/scheduling/actions.js';
import { canApprove, grantRole, hasAdminPrivilege } from '../src/modules/permissions/db/user-roles.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import { policyDecision, setPolicy } from '../src/policies.js';
import { evaluateEngage } from '../src/router.js';
import { overBudget, recordUsage, setBudget } from '../src/usage.js';
import type { MessagingGroup, MessagingGroupAgent } from '../src/types.js';

export type Provider = 'claude' | 'codex';

export interface EvalCase {
  id: string;
  area: string;
  /** What the person does. */
  user: string;
  /** What the assistant must do. */
  expect: string;
  run(provider: Provider): Promise<void> | void;
}

class EvalFailure extends Error {}
function check(cond: unknown, why: string): void {
  if (!cond) throw new EvalFailure(why);
}

const now = () => new Date().toISOString();

function seedOwner(id = 'slack:OWNER'): string {
  upsertUser({ id, kind: id.split(':')[0], display_name: 'Owner', created_at: now() });
  grantRole({ user_id: id, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  return id;
}

function seedAgent(id = 'ag-1'): void {
  createAgentGroup({ id, name: 'Ava', folder: id, agent_provider: null, created_at: now() });
}

function mg(id: string, isGroup: boolean, channel = 'slack'): MessagingGroup {
  const row = {
    id,
    channel_type: channel,
    platform_id: `${channel}:${id}`,
    name: isGroup ? '#team' : null,
    is_group: isGroup ? 1 : 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  } as MessagingGroup;
  createMessagingGroup(row);
  return row;
}

function wiring(
  mgId: string,
  mode: MessagingGroupAgent['engage_mode'],
  pattern: string | null = null,
): MessagingGroupAgent {
  const w = {
    id: `w-${mgId}`,
    messaging_group_id: mgId,
    agent_group_id: 'ag-1',
    engage_mode: mode,
    engage_pattern: pattern,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  } as MessagingGroupAgent;
  createMessagingGroupAgent(w);
  return w;
}

const card = {
  kind: 'chat-sdk',
  content: {
    type: 'ask_question',
    questionId: 'q-eval',
    title: 'Approve?',
    question: 'Send the invoice?',
    options: [
      { label: 'Approve', selectedLabel: 'Approved', value: 'approve' },
      { label: 'Reject', selectedLabel: 'Rejected', value: 'reject' },
    ],
  },
};

export const CASES: EvalCase[] = [
  // ── Reply / no-reply ──
  {
    id: 'reply-01',
    area: 'reply',
    user: 'Chats with a colleague in a group without mentioning the bot',
    expect: 'Stays quiet',
    run() {
      seedAgent();
      const g = mg('g1', true);
      check(!evaluateEngage(wiring(g.id, 'mention'), 'lunch at 1?', false, g, null), 'answered unaddressed chatter');
    },
  },
  {
    id: 'reply-02',
    area: 'reply',
    user: '@mentions the bot in a group',
    expect: 'Answers',
    run() {
      seedAgent();
      const g = mg('g1', true);
      check(evaluateEngage(wiring(g.id, 'mention'), 'summarise this', true, g, null), 'ignored a mention');
    },
  },
  {
    id: 'reply-03',
    area: 'reply',
    user: 'Writes in a DM',
    expect: 'Answers, and the reason recorded is "direct message"',
    run() {
      const r = engageReason({
        engages: true,
        accessOk: true,
        scopeOk: true,
        isMention: true,
        isDm: true,
        engageMode: 'mention',
        pattern: null,
      });
      check(r === 'direct message', `reason was ${r}`);
    },
  },
  {
    id: 'reply-04',
    area: 'reply',
    user: 'Admin turned on "/reply all" for a busy group, then someone posts',
    expect: 'Answers every message there',
    run() {
      seedAgent();
      const g = mg('g1', true);
      check(evaluateEngage(wiring(g.id, 'pattern', '.'), 'anyone?', false, g, null), 'did not answer with reply-all');
    },
  },
  {
    id: 'reply-05',
    area: 'reply',
    user: 'Someone the bot does not know mentions it, but is not allowed to use it',
    expect: 'Stays quiet and records "not allowed"',
    run() {
      const r = engageReason({
        engages: true,
        accessOk: false,
        scopeOk: true,
        isMention: true,
        isDm: false,
        engageMode: 'mention',
        pattern: null,
      });
      check(r === 'not allowed to use this agent', `reason was ${r}`);
    },
  },

  // ── Leak canaries ──
  {
    id: 'leak-01',
    area: 'leak canary',
    user: 'Tells the agent a salary in a DM, then a teammate asks in the team channel',
    expect: "The channel's memory never includes the DM's memory",
    run() {
      const dmScopes = readableScopesForSession({ agent_group_id: 'ag-1', messaging_group_id: 'mg-dm' });
      const groupScopes = readableScopesForSession({ agent_group_id: 'ag-1', messaging_group_id: 'mg-team' });
      const dmOwn = memoryScopeForSession({ agent_group_id: 'ag-1', messaging_group_id: 'mg-dm' });
      check(!groupScopes.includes(dmOwn), 'group can read the DM memory bank');
      check(dmScopes[0] === groupScopes[0], 'team bank differs');
    },
  },
  {
    id: 'leak-02',
    area: 'leak canary',
    user: 'Asks the agent in a DM to post the salary in #general',
    expect: 'The post is held for approval before reaching the group',
    run() {
      check(
        widensAudience({ is_group: 0 } as MessagingGroup, { is_group: 1 } as MessagingGroup),
        'DM-to-group was not held',
      );
      check(
        !widensAudience({ is_group: 1 } as MessagingGroup, { is_group: 1 } as MessagingGroup),
        'group-to-group was held',
      );
    },
  },
  {
    id: 'leak-03',
    area: 'leak canary',
    user: "Another workspace's agent is asked about this team's facts",
    expect: "Team memory is per agent; another agent's banks are not readable",
    run() {
      const a = readableScopesForSession({ agent_group_id: 'ag-1', messaging_group_id: 'mg-1' });
      const b = readableScopesForSession({ agent_group_id: 'ag-2', messaging_group_id: 'mg-1' });
      check(
        a.every((s) => !b.includes(s)),
        'agents share a bank',
      );
    },
  },
  {
    id: 'leak-04',
    area: 'leak canary',
    user: 'A provider error contains an API key',
    expect: 'The person sees a plain message with no key in it',
    run() {
      const { content } = rewriteAgentError(
        { text: 'x', agentError: 'invalid x-api-key sk-ant-api03-SECRET' },
        'ag-eval',
        'Ava',
      );
      check(!JSON.stringify(content).includes('sk-ant'), 'secret reached the chat');
    },
  },

  // ── Approvals and roles ──
  {
    id: 'approve-01',
    area: 'approvals',
    user: 'A bystander clicks Approve on a card',
    expect: 'Only admins and approvers can decide',
    run() {
      seedAgent();
      seedOwner();
      check(!canApprove('slack:STRANGER', 'ag-1'), 'stranger could approve');
      check(canApprove('slack:OWNER', 'ag-1'), 'owner could not approve');
    },
  },
  {
    id: 'approve-02',
    area: 'approvals',
    user: 'The owner links their WhatsApp, then approves from it',
    expect: 'The linked account has the same rights',
    run() {
      seedAgent();
      seedOwner();
      createUserLink('whatsapp:1555', 'slack:OWNER', 'slack:OWNER');
      check(primaryUserId('whatsapp:1555') === 'slack:OWNER', 'not linked');
      check(hasAdminPrivilege('whatsapp:1555', 'ag-1'), 'linked account lost admin');
    },
  },
  {
    id: 'approve-03',
    area: 'approvals',
    user: 'Someone sends "/link 123456" in a group',
    expect: 'Refuses: link codes only work in a DM',
    async run() {
      const reply = await handleIdentityCommand({
        channelType: 'slack',
        platformId: 'slack:C1',
        threadId: null,
        text: '/link 123456',
        senderId: 'slack:U1',
        senderName: 'U',
        isGroup: true,
      });
      check(/direct message/.test(reply ?? ''), `reply was ${reply}`);
    },
  },
  {
    id: 'approve-04',
    area: 'approvals',
    user: 'Taps "Always allow `npm test`"',
    expect: 'Later npm test runs without a card; rm -rf never can be always-allowed',
    run() {
      seedAgent();
      setPolicy('ag-1', 'host_exec', 'npm test', 'allow', 'slack:OWNER');
      check(policyDecision('ag-1', 'host_exec', 'npm test -- --ci') === 'allow', 'rule not applied');
      check(alwaysAllowScope('rm -rf /') === null, 'rm could be always-allowed');
    },
  },

  // ── Claim gate ──
  {
    id: 'claim-01',
    area: 'honesty',
    user: 'Asks for a weekly reminder; the agent says "I\'ve scheduled it" without scheduling',
    expect: 'The reply carries a correction',
    run() {
      const g = gateClaims('sess-claim-1', 'ag-1', "I've scheduled it for every Monday.");
      check(g.flagged.includes('schedule'), 'false claim passed');
    },
  },
  {
    id: 'claim-02',
    area: 'honesty',
    user: 'Same, but the agent really scheduled it',
    expect: 'The reply goes out unchanged',
    run() {
      recordSessionAction('sess-claim-2', 'schedule_task');
      check(gateClaims('sess-claim-2', 'ag-1', "I've scheduled it.").flagged.length === 0, 'true claim flagged');
    },
  },
  {
    id: 'claim-03',
    area: 'honesty',
    user: 'Agent says it saved something to team memory without proposing it',
    expect: 'Correction explains approval is needed',
    run() {
      const g = gateClaims('sess-claim-3', 'ag-1', "I've saved that to team memory.");
      check(/admin's approval/.test(g.text), 'no correction');
    },
  },

  // ── Channels ──
  {
    id: 'channel-01',
    area: 'channels',
    user: 'Gets an approval on Slack, Telegram, WhatsApp and Discord',
    expect: 'Each channel shows tappable choices',
    run() {
      for (const ch of ['slack', 'telegram', 'whatsapp', 'discord'])
        check(planChoices(capabilitiesFor(ch), 2) === 'buttons', `${ch} had no buttons`);
    },
  },
  {
    id: 'channel-02',
    area: 'channels',
    user: 'Gets an approval on iMessage (no buttons) and replies "2"',
    expect: 'The card is a numbered list and "2" answers it',
    run() {
      const out = prepareOutbound({ channelType: 'imessage' }, 'imessage:+1', null, card);
      check(/1\. Approve\n2\. Reject/.test((out?.content as { text: string }).text), 'no numbered list');
      check(matchNumberedReply('2', card.content.options) === 1, 'reply not matched');
      void interceptNumberedReply;
    },
  },
  {
    id: 'channel-03',
    area: 'channels',
    user: 'Receives a long report on Discord (2000-char limit)',
    expect: 'Split into pieces within the limit, code blocks intact',
    run() {
      const md = `Intro\n\n\`\`\`\n${'x\n'.repeat(1500)}\`\`\``;
      const parts = renderChunks(md, 'discord', 2000);
      check(
        parts.length > 1 && parts.every((p) => p.length <= 2000 && (p.match(/```/g) ?? []).length % 2 === 0),
        'bad split',
      );
    },
  },
  {
    id: 'channel-04',
    area: 'channels',
    user: 'Gets **bold** text on Telegram and WhatsApp',
    expect: "Rendered in each app's own format, with HTML escaped on Telegram",
    run() {
      check(toTelegramHtml('**hi** <x>') === '<b>hi</b> &lt;x&gt;', 'telegram format');
      check(toWhatsApp('**hi**') === '*hi*', 'whatsapp format');
    },
  },
  {
    id: 'channel-05',
    area: 'channels',
    user: 'Sends STOP on WhatsApp',
    expect: 'Treated as an opt-out keyword; "stop the report" is not',
    run() {
      check(optKeyword('STOP') === 'out' && optKeyword('Start') === 'in', 'keywords');
      check(optKeyword('stop the report') === null, 'sentence treated as opt-out');
    },
  },

  // ── Controls ──
  {
    id: 'control-01',
    area: 'controls',
    user: 'A non-admin types !mute in a group',
    expect: 'Refused politely; !stop still works for anyone',
    async run() {
      seedAgent();
      const reply = await handleChatControl({
        channelType: 'slack',
        platformId: 'slack:C9',
        threadId: null,
        text: '!mute',
        senderId: 'slack:NOBODY',
        isGroup: true,
      });
      check(/Only an admin/.test(reply ?? ''), `reply was ${reply}`);
    },
  },
  {
    id: 'control-02',
    area: 'controls',
    user: 'Types !deep before a hard question',
    expect: 'Uses the best model of the current provider',
    run(provider) {
      const p = parsePreset('deep');
      check(p === 'best', 'deep not best');
      const r = resolvePreset(provider, p!, {});
      check(provider === 'claude' ? r.model === 'claude-opus-5-5' : r.effort === 'high', `preset ${JSON.stringify(r)}`);
    },
  },

  // ── Errors ──
  {
    id: 'error-01',
    area: 'errors',
    user: 'Asks something while the subscription token expired',
    expect: 'Plain "sign-in problem" message; admin gets the fix',
    run() {
      check(classifyAgentError('401 authentication_error: OAuth token has expired') === 'sign-in', 'not sign-in');
    },
  },
  {
    id: 'error-02',
    area: 'errors',
    user: 'Hits the usage limit',
    expect: 'Told to try again in a few minutes',
    run() {
      check(classifyAgentError('429 Too Many Requests') === 'limit', 'not limit');
    },
  },

  // ── Cost ──
  {
    id: 'cost-01',
    area: 'cost',
    user: 'Team blows through a 10k-token monthly budget',
    expect: 'The agent is held at the cap',
    run(provider) {
      seedAgent();
      setBudget('ag-1', { monthlyTokens: 10_000, monthlyUsd: null }, 'slack:OWNER');
      recordUsage({
        agentGroupId: 'ag-1',
        provider,
        inputTokens: 11_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      check(overBudget('ag-1'), 'not held');
    },
  },
  {
    id: 'cost-02',
    area: 'cost',
    user: 'Asks for a check every 5 minutes',
    expect: 'Refused unless a condition script decides when to wake',
    async run() {
      check(
        !!(await scheduleRefusal({ recurrence: '*/5 * * * *', script: null, fromTask: false })),
        'ungated job accepted',
      );
      check(
        (await scheduleRefusal({ recurrence: '*/5 * * * *', script: 'x', fromTask: false })) === null,
        'gated job refused',
      );
    },
  },
  {
    id: 'cost-03',
    area: 'cost',
    user: 'A scheduled job tries to schedule another recurring job',
    expect: 'Refused (no runaway chains)',
    async run() {
      check(!!(await scheduleRefusal({ recurrence: '0 9 * * *', script: null, fromTask: true })), 'chain allowed');
    },
  },

  // ── Integrations ──
  {
    id: 'apps-01',
    area: 'integrations',
    user: 'Asks to list open GitHub issues',
    expect: 'A read: runs without approval',
    run() {
      const [gh] = availableIntegrations({ GITHUB_TOKEN: 't' });
      check(!isWriteRequest(gh.def, 'GET', '/repos/a/b/issues', undefined), 'read treated as write');
    },
  },
  {
    id: 'apps-02',
    area: 'integrations',
    user: 'Asks to refund a Stripe charge',
    expect: 'A write that always needs approval',
    run() {
      const stripe = availableIntegrations({ STRIPE_SECRET_KEY: 'sk' }).find((i) => i.def.name === 'stripe')!;
      check(isWriteRequest(stripe.def, 'POST', '/v1/refunds', {}) && stripe.def.alwaysAsk === true, 'refund not gated');
    },
  },
  {
    id: 'apps-03',
    area: 'integrations',
    user: 'Asks to search Linear (GraphQL query)',
    expect: 'A read; a mutation would need approval',
    run() {
      const lin = availableIntegrations({ LINEAR_API_KEY: 'k' }).find((i) => i.def.name === 'linear')!;
      check(!isWriteRequest(lin.def, 'POST', '/graphql', { query: '{ viewer { id } }' }), 'query gated');
      check(isWriteRequest(lin.def, 'POST', '/graphql', { query: 'mutation { x }' }), 'mutation not gated');
    },
  },
  {
    id: 'apps-04',
    area: 'integrations',
    user: 'An admin turns GitHub off for this agent',
    expect: 'Every GitHub call is refused',
    run() {
      seedAgent();
      setPolicy('ag-1', 'integration', 'github', 'deny', 'slack:OWNER');
      check(policyDecision('ag-1', 'integration', 'github GET /user') === 'deny', 'not denied');
    },
  },

  // ── Wiring sanity ──
  {
    id: 'db-01',
    area: 'platform',
    user: '(install) a fresh database',
    expect: 'Has the audit log, link, usage, policy and contact tables',
    run() {
      for (const t of [
        'audit_log',
        'user_links',
        'usage_ledger',
        'tool_policies',
        'contact_state',
        'engage_log',
        'onboarding',
        'chat_mutes',
      ]) {
        const row = getDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
        check(row, `missing table ${t}`);
      }
    },
  },
];
