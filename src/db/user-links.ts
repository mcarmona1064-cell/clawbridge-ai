/**
 * Cross-channel identity: one person, several accounts.
 *
 * An alias account (whatsapp:15551234567) is linked to a primary account
 * (slack:U123) only after the primary account confirms. Every check that
 * asks "who is this?" — roles, admin privilege, membership, approver
 * routing, per-person memory, usage — resolves through these helpers, so a
 * person keeps their role whichever channel they write from.
 */
import { getDb, hasTable } from './connection.js';

function ready(): boolean {
  return hasTable(getDb(), 'user_links');
}

/** The primary account for a user id (itself when not linked). */
export function primaryUserId(userId: string): string {
  if (!ready()) return userId;
  const row = getDb().prepare('SELECT primary_id FROM user_links WHERE alias_id = ?').get(userId) as
    | { primary_id: string }
    | undefined;
  return row?.primary_id ?? userId;
}

/** Every account that belongs to the same person as `userId`, primary first. */
export function identityIds(userId: string): string[] {
  const primary = primaryUserId(userId);
  if (!ready()) return [primary];
  const aliases = getDb()
    .prepare('SELECT alias_id FROM user_links WHERE primary_id = ? ORDER BY linked_at')
    .all(primary) as Array<{ alias_id: string }>;
  return [primary, ...aliases.map((a) => a.alias_id)];
}

export function linkedAliases(primaryId: string): Array<{ alias_id: string; linked_at: string; approved_by: string }> {
  if (!ready()) return [];
  return getDb()
    .prepare('SELECT alias_id, linked_at, approved_by FROM user_links WHERE primary_id = ? ORDER BY linked_at')
    .all(primaryId) as Array<{ alias_id: string; linked_at: string; approved_by: string }>;
}

export function createUserLink(aliasId: string, primaryId: string, approvedBy: string): void {
  getDb()
    .prepare(`INSERT OR REPLACE INTO user_links (alias_id, primary_id, linked_at, approved_by) VALUES (?, ?, ?, ?)`)
    .run(aliasId, primaryId, new Date().toISOString(), approvedBy);
}

export function removeUserLink(aliasId: string): boolean {
  if (!ready()) return false;
  return getDb().prepare('DELETE FROM user_links WHERE alias_id = ?').run(aliasId).changes > 0;
}

/** SQL fragment and params for "user_id belongs to this person". */
export function identityClause(userId: string, column = 'user_id'): { sql: string; params: string[] } {
  const ids = identityIds(userId);
  return { sql: `${column} IN (${ids.map(() => '?').join(', ')})`, params: ids };
}

// ── Notification preference ──

/** The account where this person wants approvals and alerts, if they chose one. */
export function notifyUserIdFor(userId: string): string | null {
  if (!hasTable(getDb(), 'user_prefs')) return null;
  const row = getDb().prepare('SELECT notify_user_id FROM user_prefs WHERE user_id = ?').get(primaryUserId(userId)) as
    | { notify_user_id: string | null }
    | undefined;
  return row?.notify_user_id ?? null;
}

export function setNotifyUserId(userId: string, notifyUserId: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO user_prefs (user_id, notify_user_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET notify_user_id = excluded.notify_user_id, updated_at = excluded.updated_at`,
    )
    .run(primaryUserId(userId), notifyUserId, new Date().toISOString());
}
