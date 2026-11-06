/**
 * Memory scope: which Hindsight banks a session may read from and write to.
 *
 * Two kinds of bank:
 *
 * - **Conversation banks** — one hard partition per (agent group, messaging
 *   group). A DM is its own messaging group, so one person's DM memories can
 *   never be recalled in another DM, a channel, or another agent group. Runs
 *   with no messaging group behind them (agent-to-agent traffic, system tasks)
 *   get an internal bank per agent group, which never contains DM content.
 *   Turns are retained here automatically.
 *
 * - **Team bank** — one per agent group, readable from every conversation in
 *   that group. Nothing is ever retained here automatically: a fact only
 *   enters through an explicit, approved promotion (see
 *   src/modules/team-memory/), so private content can't drift into it.
 *
 * Every memory carries provenance tags stamped by the host (never by the
 * model): where it came from (`origin:dm|group|internal|admin`), which
 * conversation (`conversation:<messagingGroupId>`), and for team facts who
 * proposed and approved it.
 */
import type { MessagingGroup, Session } from '../types.js';

/** Scope slug for a session's conversation bank. Fed to `bankId()`, which sanitizes it. */
export function memoryScopeForSession(session: Pick<Session, 'agent_group_id' | 'messaging_group_id'>): string {
  const conversation = session.messaging_group_id ? session.messaging_group_id : 'internal';
  return `${session.agent_group_id}--${conversation}`;
}

/** Unique conversation scopes for a set of sessions (e.g. for nightly maintenance). */
export function memoryScopesForSessions(
  sessions: Array<Pick<Session, 'agent_group_id' | 'messaging_group_id'>>,
): string[] {
  return [...new Set(sessions.map(memoryScopeForSession))];
}

/** Scope slug for an agent group's shared team bank. */
export function teamScopeForAgentGroup(agentGroupId: string): string {
  return `${agentGroupId}--team`;
}

/**
 * Banks a session may read, in prompt order: the agent group's team facts
 * first, then this conversation's own memories.
 */
export function readableScopesForSession(session: Pick<Session, 'agent_group_id' | 'messaging_group_id'>): string[] {
  return [teamScopeForAgentGroup(session.agent_group_id), memoryScopeForSession(session)];
}

export type MemoryOrigin = 'dm' | 'group' | 'internal' | 'admin';

/** Where a session's messages come from, judged by the host from the messaging group. */
export function originForSession(
  session: Pick<Session, 'messaging_group_id'>,
  messagingGroup: Pick<MessagingGroup, 'is_group'> | null | undefined,
): MemoryOrigin {
  if (!session.messaging_group_id) return 'internal';
  // Unknown messaging group: treat as a DM, the most restrictive origin.
  if (!messagingGroup) return 'dm';
  return messagingGroup.is_group ? 'group' : 'dm';
}

/** Host-stamped provenance tags for a memory. Order is stable for tests. */
export function provenanceTags(opts: {
  origin: MemoryOrigin;
  messagingGroupId?: string | null;
  proposedBy?: string | null;
  approvedBy?: string | null;
}): string[] {
  const tags = [`origin:${opts.origin}`];
  if (opts.messagingGroupId) tags.push(`conversation:${opts.messagingGroupId}`);
  if (opts.proposedBy) tags.push(`proposed_by:${opts.proposedBy}`);
  if (opts.approvedBy) tags.push(`approved_by:${opts.approvedBy}`);
  return tags;
}
