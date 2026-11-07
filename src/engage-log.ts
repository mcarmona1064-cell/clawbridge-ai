/**
 * Reply / stay-quiet decisions, so "why didn't it answer?" has an answer.
 * One row per (message, wired agent), kept for 7 days. /why shows the
 * recent ones for a chat in plain words.
 */
import { getDb, hasTable } from './db/connection.js';

export type EngageReason =
  | 'mentioned'
  | 'direct message'
  | 'answers everything here'
  | 'thread it joined'
  | 'matched its trigger'
  | 'not mentioned'
  | 'not allowed to use this agent'
  | 'outside sender scope';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
let lastPrune = 0;

function ready(): boolean {
  try {
    return hasTable(getDb(), 'engage_log');
  } catch {
    return false;
  }
}

export function recordEngageDecision(row: {
  channelType: string;
  platformId: string;
  threadId: string | null;
  agentGroupId: string;
  userId: string | null;
  engaged: boolean;
  reason: EngageReason;
}): void {
  if (!ready()) return;
  const db = getDb();
  db.prepare(
    `INSERT INTO engage_log (at, channel_type, platform_id, thread_id, agent_group_id, user_id, engaged, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    row.channelType,
    row.platformId,
    row.threadId,
    row.agentGroupId,
    row.userId,
    row.engaged ? 1 : 0,
    row.reason,
  );
  if (Date.now() - lastPrune > 60 * 60 * 1000) {
    lastPrune = Date.now();
    db.prepare('DELETE FROM engage_log WHERE at < ?').run(new Date(Date.now() - RETENTION_MS).toISOString());
  }
}

/** Plain reason for a decision the router made. */
export function engageReason(opts: {
  engages: boolean;
  accessOk: boolean;
  scopeOk: boolean;
  isMention: boolean;
  isDm: boolean;
  engageMode: string;
  pattern: string | null;
}): EngageReason {
  if (!opts.engages) return 'not mentioned';
  if (!opts.accessOk) return 'not allowed to use this agent';
  if (!opts.scopeOk) return 'outside sender scope';
  if (opts.isDm) return 'direct message';
  if (opts.isMention) return 'mentioned';
  if (opts.engageMode === 'pattern')
    return (opts.pattern ?? '.') === '.' ? 'answers everything here' : 'matched its trigger';
  return 'thread it joined';
}

export function whyText(channelType: string, platformId: string, limit = 8): string {
  if (!ready()) return 'No decisions recorded yet.';
  const rows = getDb()
    .prepare(
      `SELECT at, engaged, reason FROM engage_log WHERE channel_type = ? AND platform_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(channelType, platformId, limit) as Array<{ at: string; engaged: number; reason: string }>;
  if (rows.length === 0) return 'No decisions recorded for this chat in the last 7 days.';
  return [
    '**Recent messages here**',
    ...rows.map(
      (r) =>
        `• ${new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — ${r.engaged ? 'answered' : 'stayed quiet'} (${r.reason})`,
    ),
    '',
    'Admins can change this with /reply mentions or /reply all.',
  ].join('\n');
}
