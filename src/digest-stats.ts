/**
 * Digest scorecard: how many digests were posted in a conversation, and how
 * many got a reaction from a person (any message there within 2 hours).
 * Shown by /digest, so owners can tell whether the digest is worth keeping.
 */
import type Database from 'better-sqlite3';

import { getDb, hasTable } from './db/connection.js';

const ENGAGE_WINDOW_MS = 2 * 60 * 60 * 1000;

function ready(): boolean {
  try {
    return hasTable(getDb(), 'digest_stats');
  } catch {
    return false;
  }
}

export function ensureDigestStatsTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS digest_stats (
    session_id      TEXT PRIMARY KEY,
    posted          INTEGER NOT NULL DEFAULT 0,
    engaged         INTEGER NOT NULL DEFAULT 0,
    last_posted_at  TEXT,
    last_engaged    INTEGER NOT NULL DEFAULT 0
  )`);
}

export function recordDigestPosted(sessionId: string, at = new Date()): void {
  if (!ready()) return;
  getDb()
    .prepare(
      `INSERT INTO digest_stats (session_id, posted, last_posted_at, last_engaged) VALUES (?, 1, ?, 0)
       ON CONFLICT(session_id) DO UPDATE SET posted = posted + 1, last_posted_at = excluded.last_posted_at, last_engaged = 0`,
    )
    .run(sessionId, at.toISOString());
}

/** A person wrote in the conversation: count it once for the latest digest if it is recent. */
export function recordHumanActivity(sessionId: string, now = Date.now()): void {
  if (!ready()) return;
  const row = getDb()
    .prepare('SELECT last_posted_at, last_engaged FROM digest_stats WHERE session_id = ?')
    .get(sessionId) as { last_posted_at: string | null; last_engaged: number } | undefined;
  if (!row?.last_posted_at || row.last_engaged || now - Date.parse(row.last_posted_at) > ENGAGE_WINDOW_MS) return;
  getDb()
    .prepare('UPDATE digest_stats SET engaged = engaged + 1, last_engaged = 1 WHERE session_id = ?')
    .run(sessionId);
}

export function digestScore(sessionId: string): { posted: number; engaged: number } {
  if (!ready()) return { posted: 0, engaged: 0 };
  const row = getDb().prepare('SELECT posted, engaged FROM digest_stats WHERE session_id = ?').get(sessionId) as
    | { posted: number; engaged: number }
    | undefined;
  return { posted: row?.posted ?? 0, engaged: row?.engaged ?? 0 };
}

/** Is the turn being answered a digest? (The latest inbound row is the digest task.) */
export function isDigestTurn(inDb: Database.Database, digestPrompt: string): boolean {
  try {
    const row = inDb.prepare('SELECT kind, content FROM messages_in ORDER BY seq DESC LIMIT 1').get() as
      | { kind: string; content: string }
      | undefined;
    if (row?.kind !== 'task') return false;
    return (JSON.parse(row.content) as { prompt?: string }).prompt === digestPrompt;
  } catch {
    return false;
  }
}
