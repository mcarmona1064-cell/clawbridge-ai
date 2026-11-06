/**
 * Memory scope: which Hindsight bank a session may read from and write to.
 *
 * Every conversation gets its own hard partition: one bank per
 * (agent group, messaging group). A DM is its own messaging group, so one
 * person's DM memories can never be recalled in another DM, a channel, or
 * another agent group. Runs with no messaging group behind them (agent-to-agent
 * traffic, system tasks) get an internal bank per agent group, which never
 * contains DM content.
 *
 * Sharing knowledge across conversations is deliberately NOT done here: it
 * needs host-stamped visibility (public vs private origin) and an explicit
 * promotion step, so nothing private can drift into a shared bank by accident.
 */
import type { Session } from '../types.js';

/** Scope slug for a session. Fed to `bankId()`, which sanitizes it. */
export function memoryScopeForSession(session: Pick<Session, 'agent_group_id' | 'messaging_group_id'>): string {
  const conversation = session.messaging_group_id ? session.messaging_group_id : 'internal';
  return `${session.agent_group_id}--${conversation}`;
}

/** Unique scopes for a set of sessions (e.g. for nightly maintenance). */
export function memoryScopesForSessions(
  sessions: Array<Pick<Session, 'agent_group_id' | 'messaging_group_id'>>,
): string[] {
  return [...new Set(sessions.map(memoryScopeForSession))];
}
