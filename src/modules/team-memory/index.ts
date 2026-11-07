/**
 * Team memory — approved facts shared across an agent group's conversations.
 *
 * Conversation memories stay in their own bank (src/memory/scope.ts). The
 * only way into the agent group's shared team bank is an explicit promotion:
 *
 *   1. The agent calls the `propose_team_memory` MCP tool, which writes a
 *      `propose_team_memory` system action.
 *   2. This module validates it and sends an Approve/Reject card to an admin.
 *      The card shows the exact fact and where it came from (a DM, a group
 *      chat, or an internal run).
 *   3. On Approve, the host writes the fact to the team bank, stamped with
 *      provenance tags (origin, conversation, proposer, approver) and the
 *      date. On Reject, nothing is written.
 *
 * Admins can also add a fact directly with `/teamfact <fact>` (see
 * host-commands); issuing the command is the approval.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { hindsightRetain } from '../../memory/hindsight.js';
import { originForSession, provenanceTags, teamScopeForAgentGroup, type MemoryOrigin } from '../../memory/scope.js';
import type { Session } from '../../types.js';
import {
  notifyAgent,
  registerApprovalHandler,
  registerApprovalRejectionHandler,
  requestApproval,
  type ApprovalHandler,
} from '../approvals/index.js';
import { audit } from '../../audit.js';

export const PROPOSE_TEAM_MEMORY_ACTION = 'propose_team_memory';
export const MAX_TEAM_FACT_CHARS = 600;
const MAX_SOURCE_CHARS = 200;

const ORIGIN_LABEL: Record<MemoryOrigin, string> = {
  dm: 'a private DM',
  group: 'a group chat',
  internal: 'an internal run (no chat)',
  admin: 'an admin command',
};

export type TeamFactValidation = { ok: true; fact: string; source: string } | { ok: false; error: string };

/** Normalise and validate a proposed team fact. */
export function validateTeamFact(rawFact: unknown, rawSource?: unknown): TeamFactValidation {
  const fact = typeof rawFact === 'string' ? rawFact.replace(/\s+/g, ' ').trim() : '';
  const source = typeof rawSource === 'string' ? rawSource.replace(/\s+/g, ' ').trim() : '';
  if (!fact) return { ok: false, error: 'a non-empty fact is required' };
  if (fact.length > MAX_TEAM_FACT_CHARS) {
    return { ok: false, error: `facts are limited to ${MAX_TEAM_FACT_CHARS} characters; split it or shorten it` };
  }
  if (source.length > MAX_SOURCE_CHARS) {
    return { ok: false, error: `source is limited to ${MAX_SOURCE_CHARS} characters` };
  }
  return { ok: true, fact, source };
}

/** Write an approved fact to an agent group's team bank, with provenance. */
export async function saveTeamFact(opts: {
  agentGroupId: string;
  fact: string;
  source?: string;
  origin: MemoryOrigin;
  messagingGroupId?: string | null;
  proposedBy?: string | null;
  approvedBy?: string | null;
  now?: Date;
}): Promise<void> {
  const now = opts.now ?? new Date();
  const asOf = now.toISOString().slice(0, 10);
  const content = `${opts.fact} (as of ${asOf}${opts.source ? `, source: ${opts.source}` : ''})`;
  await hindsightRetain(teamScopeForAgentGroup(opts.agentGroupId), content, {
    context: 'team-fact',
    timestamp: now,
    async: false,
    extraTags: provenanceTags({
      origin: opts.origin,
      messagingGroupId: opts.messagingGroupId,
      proposedBy: opts.proposedBy,
      approvedBy: opts.approvedBy,
    }),
  });
  audit('memory.team_write', {
    actor: opts.approvedBy ?? opts.proposedBy ?? null,
    agentGroupId: opts.agentGroupId,
    detail: { origin: opts.origin, proposedBy: opts.proposedBy ?? null, chars: opts.fact.length },
  });
  log.info('[team-memory] fact saved', {
    agentGroupId: opts.agentGroupId,
    origin: opts.origin,
    approvedBy: opts.approvedBy,
  });
}

/** Delivery action: the agent proposed a team fact. Queue it for admin approval. */
export async function handleProposeTeamMemory(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'propose_team_memory failed: agent group not found.');
    return;
  }
  const checked = validateTeamFact(content.fact, content.source);
  if (!checked.ok) {
    notifyAgent(session, `propose_team_memory failed: ${checked.error}.`);
    return;
  }

  const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  const origin = originForSession(session, mg);
  const where = mg?.name ? `${ORIGIN_LABEL[origin]} (${mg.name})` : ORIGIN_LABEL[origin];

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: PROPOSE_TEAM_MEMORY_ACTION,
    payload: {
      fact: checked.fact,
      source: checked.source,
      origin,
      messagingGroupId: session.messaging_group_id,
      proposedBy: `agent:${agentGroup.id}`,
    },
    title: 'Save to team memory?',
    question:
      `Agent "${agentGroup.name}" wants to save this fact for everyone who uses it:\n\n` +
      `"${checked.fact}"\n\n` +
      `Learned in ${where}.${checked.source ? ` Source: ${checked.source}.` : ''}\n` +
      'Approve only if it is accurate and fine for the whole team to see.',
  });
}

export const applyTeamMemory: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  const checked = validateTeamFact(payload.fact, payload.source);
  if (!checked.ok) {
    notify(`Team memory not saved: ${checked.error}.`);
    return;
  }
  await saveTeamFact({
    agentGroupId: session.agent_group_id,
    fact: checked.fact,
    source: checked.source,
    origin: (payload.origin as MemoryOrigin) ?? 'dm',
    messagingGroupId: (payload.messagingGroupId as string | null) ?? null,
    proposedBy: (payload.proposedBy as string | null) ?? null,
    approvedBy: userId || null,
  });
  notify(`Saved to team memory: "${checked.fact}". Every conversation in this agent group can now use it.`);
};

export const rejectTeamMemory: ApprovalHandler = async ({ payload, notify }) => {
  notify(
    `Team memory not saved: an admin rejected "${String(payload.fact ?? '')}". Keep it in this conversation only.`,
  );
};

registerDeliveryAction(PROPOSE_TEAM_MEMORY_ACTION, handleProposeTeamMemory);
registerApprovalHandler(PROPOSE_TEAM_MEMORY_ACTION, applyTeamMemory);
registerApprovalRejectionHandler(PROPOSE_TEAM_MEMORY_ACTION, rejectTeamMemory);
