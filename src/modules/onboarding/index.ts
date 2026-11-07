/**
 * Onboarding conversation.
 *
 * The first time an owner or admin DMs an agent, the agent offers a
 * one-minute setup. Four plain questions (what the business does, who is
 * on the team, which tools, what to help with first); each answer is saved
 * as an approved team fact (the owner gave it, so it needs no approval
 * card) and into the agent's team profile, which every conversation reads.
 * It ends with three starter tasks as choices; picking one sends it to the
 * agent as if the owner had typed it.
 *
 * It runs on the host, so it behaves the same on every channel and costs no
 * model tokens. "skip" skips a question, "stop setup" ends it, and
 * /onboard starts it again at any time.
 */
import fs from 'fs';
import path from 'path';

import { audit } from '../../audit.js';
import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb, hasTable } from '../../db/connection.js';
import { registerAskQuestionRender } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { clickerIdFor } from '../approvals/response-handler.js';
import { primaryUserId } from '../../db/user-links.js';
import { hasAdminPrivilege } from '../permissions/db/user-roles.js';

export const QUESTIONS = [
  { key: 'business', label: 'What we do', q: 'What does your business or team do, in a sentence or two?' },
  {
    key: 'people',
    label: 'Who is on the team',
    q: "Who's on the team, and who should I take requests from? Names and roles are enough.",
  },
  {
    key: 'tools',
    label: 'Tools we use',
    q: 'Which tools do you use day to day? For example Gmail, Google Sheets, HubSpot, Shopify or Notion.',
  },
  { key: 'goals', label: 'Help wanted first', q: 'What would you most like my help with first?' },
] as const;

type Key = (typeof QUESTIONS)[number]['key'];
type Answers = Partial<Record<Key, string>>;

interface Row {
  agent_group_id: string;
  user_id: string;
  status: 'offered' | 'active' | 'done' | 'declined';
  step: number;
  answers_json: string;
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
}

const OFFER_ID = (ag: string) => `onb-offer-${ag}`;
const START_ID = (ag: string) => `onb-start-${ag}`;

function ready(): boolean {
  try {
    return hasTable(getDb(), 'onboarding');
  } catch {
    return false;
  }
}

function getRow(agentGroupId: string): Row | undefined {
  return getDb().prepare('SELECT * FROM onboarding WHERE agent_group_id = ?').get(agentGroupId) as Row | undefined;
}

function saveRow(row: Row): void {
  getDb()
    .prepare(
      `INSERT INTO onboarding (agent_group_id, user_id, status, step, answers_json, channel_type, platform_id, thread_id, updated_at)
       VALUES (@agent_group_id, @user_id, @status, @step, @answers_json, @channel_type, @platform_id, @thread_id, @updated_at)
       ON CONFLICT(agent_group_id) DO UPDATE SET user_id = excluded.user_id, status = excluded.status, step = excluded.step,
         answers_json = excluded.answers_json, channel_type = excluded.channel_type, platform_id = excluded.platform_id,
         thread_id = excluded.thread_id, updated_at = excluded.updated_at`,
    )
    .run({ ...row, updated_at: new Date().toISOString() });
}

async function send(
  row: Pick<Row, 'channel_type' | 'platform_id' | 'thread_id'>,
  content: Record<string, unknown>,
): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return;
  await adapter.deliver(
    row.channel_type,
    row.platform_id,
    row.thread_id,
    content.type ? 'chat-sdk' : 'chat',
    JSON.stringify(content),
  );
}

function agentName(agentGroupId: string): string {
  return getAgentGroup(agentGroupId)?.name ?? 'your assistant';
}

/** Starter tasks shaped by the answers. */
export function starterTasks(answers: Answers): string[] {
  const goal = answers.goals?.trim();
  const tools = answers.tools?.trim();
  return [
    goal ? `Help me with this first: ${goal.slice(0, 120)}` : 'Help me plan my week',
    'Every weekday at 9:00, send me a short list of what needs my attention today',
    tools ? `Show me what you can do with the tools we use (${tools.slice(0, 80)})` : 'Show me what you can do',
  ];
}

export function profileMarkdown(answers: Answers): string {
  const lines = [
    'Told by the owner during setup. Treat it as background, and ask before acting on anything that looks out of date.',
    '',
  ];
  for (const q of QUESTIONS) {
    const a = answers[q.key];
    if (a) lines.push(`- **${q.label}:** ${a.replace(/\s+/g, ' ').trim()}`);
  }
  return lines.join('\n');
}

export function teamProfilePath(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'team-profile.md');
}

// ── Entry points used by the router ──

export interface OnboardingContext {
  agentGroupId: string;
  userId: string | null;
  isDm: boolean;
  channelType: string;
  platformId: string;
  threadId: string | null;
  text: string;
}

/**
 * Called for every chat message routed to an agent. Returns true when the
 * message was an onboarding answer (and must not reach the agent).
 */
export async function handleOnboardingTurn(ctx: OnboardingContext): Promise<boolean> {
  if (!ready() || !ctx.userId) return false;
  const row = getRow(ctx.agentGroupId);
  if (!row || row.status !== 'active') return false;
  if (primaryUserId(row.user_id) !== primaryUserId(ctx.userId) || row.platform_id !== ctx.platformId) return false;

  const text = ctx.text.trim();
  if (/^(stop setup|cancel setup|exit setup)$/i.test(text)) {
    saveRow({ ...row, status: 'declined' });
    await send(row, { text: 'Okay, setup stopped. Send /onboard any time to pick it up again.' });
    return true;
  }
  const answers = JSON.parse(row.answers_json) as Answers;
  const q = QUESTIONS[row.step];
  if (q && !/^skip$/i.test(text)) answers[q.key] = text.slice(0, 600);
  const next = row.step + 1;
  if (next < QUESTIONS.length) {
    saveRow({ ...row, step: next, answers_json: JSON.stringify(answers) });
    await send(row, { text: `${QUESTIONS[next].q}\n\n_(${next + 1}/${QUESTIONS.length} · "skip" to skip)_` });
    return true;
  }
  saveRow({ ...row, status: 'done', step: next, answers_json: JSON.stringify(answers) });
  await finish(row, answers);
  return true;
}

/** After an owner/admin's DM is routed: offer setup once. */
export async function maybeOfferOnboarding(ctx: OnboardingContext): Promise<void> {
  if (!ready() || !ctx.userId || !ctx.isDm) return;
  if (getRow(ctx.agentGroupId)) return;
  if (!hasAdminPrivilege(ctx.userId, ctx.agentGroupId)) return;
  saveRow({
    agent_group_id: ctx.agentGroupId,
    user_id: ctx.userId,
    status: 'offered',
    step: 0,
    answers_json: '{}',
    channel_type: ctx.channelType,
    platform_id: ctx.platformId,
    thread_id: ctx.threadId,
  });
  await send(
    { channel_type: ctx.channelType, platform_id: ctx.platformId, thread_id: ctx.threadId },
    {
      type: 'ask_question',
      questionId: OFFER_ID(ctx.agentGroupId),
      title: 'Quick setup?',
      question: `Four short questions so ${agentName(ctx.agentGroupId)} knows your business. Takes about a minute.`,
      options: OFFER_OPTIONS,
    },
  );
}

/** /onboard: start (again) now, in this chat. */
export async function startOnboarding(ctx: OnboardingContext): Promise<string | null> {
  if (!ready() || !ctx.userId) return 'Setup is not available yet. Restart ClawBridge to apply the update.';
  if (!hasAdminPrivilege(ctx.userId, ctx.agentGroupId)) return 'Only an owner or admin can run setup.';
  const prev = getRow(ctx.agentGroupId);
  saveRow({
    agent_group_id: ctx.agentGroupId,
    user_id: ctx.userId,
    status: 'active',
    step: 0,
    answers_json: prev?.answers_json ?? '{}',
    channel_type: ctx.channelType,
    platform_id: ctx.platformId,
    thread_id: ctx.threadId,
  });
  return `${QUESTIONS[0].q}\n\n_(1/${QUESTIONS.length} · "skip" to skip, "stop setup" to stop)_`;
}

async function finish(row: Row, answers: Answers): Promise<void> {
  const group = getAgentGroup(row.agent_group_id);
  if (group) {
    try {
      fs.mkdirSync(path.dirname(teamProfilePath(group.folder)), { recursive: true });
      fs.writeFileSync(teamProfilePath(group.folder), profileMarkdown(answers) + '\n');
    } catch (err) {
      log.warn('Onboarding: could not write team profile', { err });
    }
  }
  // Also save each answer as an approved team fact, so recall finds it.
  try {
    const { saveTeamFact } = await import('../team-memory/index.js');
    for (const q of QUESTIONS) {
      const a = answers[q.key];
      if (!a) continue;
      await saveTeamFact({
        agentGroupId: row.agent_group_id,
        fact: `${q.label}: ${a}`,
        source: 'onboarding',
        origin: 'admin',
        proposedBy: row.user_id,
        approvedBy: row.user_id,
      });
    }
  } catch (err) {
    log.warn('Onboarding: team memory unavailable; profile file still saved', { err: (err as Error).message });
  }
  audit('onboarding.completed', {
    actor: row.user_id,
    agentGroupId: row.agent_group_id,
    detail: { answered: Object.keys(answers) },
  });
  await send(row, {
    type: 'ask_question',
    questionId: START_ID(row.agent_group_id),
    title: 'Thanks — I saved that for the whole team.',
    question: 'Want to try one of these now?',
    options: starterTasks(answers).map((t) => ({ label: t, value: t })),
  });
}

// ── Cards ──

const OFFER_OPTIONS = [
  { label: 'Start setup', selectedLabel: '▶️ Setup started', value: 'start' },
  { label: 'Not now', selectedLabel: 'Maybe later', value: 'later' },
];

function render(id: string) {
  if (!ready()) return undefined;
  if (id.startsWith('onb-offer-')) return { title: 'Quick setup?', options: OFFER_OPTIONS };
  if (id.startsWith('onb-start-')) {
    const row = getRow(id.slice('onb-start-'.length));
    if (!row) return undefined;
    return {
      title: 'Starter tasks',
      options: starterTasks(JSON.parse(row.answers_json) as Answers).map((t) => ({
        label: t,
        selectedLabel: t,
        value: t,
      })),
    };
  }
  return undefined;
}

export async function handleOnboardingResponse(payload: ResponsePayload): Promise<boolean> {
  if (!payload.questionId.startsWith('onb-') || !ready()) return false;
  const isOffer = payload.questionId.startsWith('onb-offer-');
  const agentGroupId = payload.questionId.slice(isOffer ? 'onb-offer-'.length : 'onb-start-'.length);
  const row = getRow(agentGroupId);
  const clicker = clickerIdFor(payload);
  if (!row || !clicker || primaryUserId(clicker) !== primaryUserId(row.user_id)) return true;

  if (isOffer) {
    if (row.status !== 'offered') return true;
    if (payload.value === 'start') {
      saveRow({ ...row, status: 'active', step: 0 });
      await send(row, {
        text: `${QUESTIONS[0].q}\n\n_(1/${QUESTIONS.length} · "skip" to skip, "stop setup" to stop)_`,
      });
    } else {
      saveRow({ ...row, status: 'declined' });
      await send(row, { text: 'No problem. Send /onboard whenever you like.' });
    }
    return true;
  }

  // A starter task: hand it to the agent as if the owner typed it.
  const { routeInbound } = await import('../../router.js');
  await routeInbound({
    channelType: row.channel_type,
    platformId: row.platform_id,
    threadId: row.thread_id,
    message: {
      id: `onb-task-${Date.now()}`,
      kind: 'chat',
      content: JSON.stringify({ text: payload.value, senderId: row.user_id, sender: 'owner' }),
      timestamp: new Date().toISOString(),
      isMention: true,
      isGroup: false,
    },
  });
  return true;
}

registerResponseHandler(handleOnboardingResponse);
registerAskQuestionRender(render);
