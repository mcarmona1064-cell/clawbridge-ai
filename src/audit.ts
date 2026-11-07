/**
 * Audit log API.
 *
 * `audit()` never throws into the caller: losing an audit row must not
 * break an approval or a delivery, so failures are logged loudly instead.
 * Rows hold who/what/where and small details, never message text or
 * secrets.
 */
import crypto from 'crypto';

import { getDb, hasTable } from './db/connection.js';
import { log } from './log.js';

export type AuditAction =
  | 'approval.requested'
  | 'approval.decided'
  | 'approval.expired'
  | 'host_exec.run'
  | 'host_exec.denied'
  | 'provider.switched'
  | 'role.granted'
  | 'role.revoked'
  | 'identity.linked'
  | 'identity.unlinked'
  | 'memory.team_write'
  | 'memory.forget'
  | 'message.posted'
  | 'budget.paused'
  | 'policy.changed'
  | 'egress.blocked'
  | (string & {});

export interface AuditEntry {
  actor?: string | null;
  target?: string | null;
  agentGroupId?: string | null;
  channelType?: string | null;
  detail?: Record<string, unknown>;
}

export interface AuditRow {
  id: number;
  at: string;
  action: string;
  actor: string | null;
  target: string | null;
  agent_group_id: string | null;
  channel_type: string | null;
  detail_json: string;
  prev_hash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

function rowHash(prev: string, r: Omit<AuditRow, 'id' | 'prev_hash' | 'hash'>): string {
  const canonical = JSON.stringify([
    prev,
    r.at,
    r.action,
    r.actor,
    r.target,
    r.agent_group_id,
    r.channel_type,
    r.detail_json,
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** Append one audit row. Never throws. */
export function audit(action: AuditAction, entry: AuditEntry = {}): void {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return; // no central DB in this process (tests, one-off CLI commands)
  }
  try {
    if (!hasTable(db, 'audit_log')) return;
    db.transaction(() => {
      const last = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get() as
        | { hash: string }
        | undefined;
      const prev = last?.hash ?? GENESIS;
      const row = {
        at: new Date().toISOString(),
        action,
        actor: entry.actor ?? null,
        target: entry.target ?? null,
        agent_group_id: entry.agentGroupId ?? null,
        channel_type: entry.channelType ?? null,
        detail_json: JSON.stringify(entry.detail ?? {}),
      };
      db.prepare(
        `INSERT INTO audit_log (at, action, actor, target, agent_group_id, channel_type, detail_json, prev_hash, hash)
         VALUES (@at, @action, @actor, @target, @agent_group_id, @channel_type, @detail_json, @prev_hash, @hash)`,
      ).run({ ...row, prev_hash: prev, hash: rowHash(prev, row) });
    })();
  } catch (err) {
    log.error('Audit write failed', { action, err });
  }
}

export function readAudit(opts: { since?: string; action?: string; limit?: number } = {}): AuditRow[] {
  const db = getDb();
  if (!hasTable(db, 'audit_log')) return [];
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.since) {
    where.push('at >= ?');
    params.push(opts.since);
  }
  if (opts.action) {
    where.push('action LIKE ?');
    params.push(opts.action.endsWith('*') ? `${opts.action.slice(0, -1)}%` : opts.action);
  }
  const sql = `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id ${
    opts.limit ? `LIMIT ${Math.max(1, Math.floor(opts.limit))}` : ''
  }`;
  return db.prepare(sql).all(...params) as AuditRow[];
}

/** Walk the hash chain. Returns the first broken row id, or null when intact. */
export function verifyAuditChain(): { ok: true; rows: number } | { ok: false; brokenAt: number; reason: string } {
  const rows = readAudit();
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev)
      return { ok: false, brokenAt: r.id, reason: 'previous-hash mismatch (row removed or reordered)' };
    const expected = rowHash(prev, r);
    if (r.hash !== expected) return { ok: false, brokenAt: r.id, reason: 'row contents changed' };
    prev = r.hash;
  }
  return { ok: true, rows: rows.length };
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Export rows as JSONL (one JSON object per line) or CSV. */
export function exportAudit(format: 'jsonl' | 'csv', opts: { since?: string; action?: string } = {}): string {
  const rows = readAudit(opts);
  if (format === 'jsonl') {
    return rows
      .map((r) => JSON.stringify({ ...r, detail: JSON.parse(r.detail_json), detail_json: undefined }))
      .join('\n');
  }
  const cols = [
    'id',
    'at',
    'action',
    'actor',
    'target',
    'agent_group_id',
    'channel_type',
    'detail_json',
    'hash',
  ] as const;
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n');
}
