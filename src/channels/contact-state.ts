/**
 * Reply-window and opt-out state per chat (see migration 017).
 *
 * Every function is a no-op without the central DB (tests, one-off CLI),
 * so adapters can call them unconditionally.
 */
import { getDb, hasTable } from '../db/connection.js';

function db(): ReturnType<typeof getDb> | null {
  try {
    const d = getDb();
    return hasTable(d, 'contact_state') ? d : null;
  } catch {
    return null;
  }
}

export function recordInbound(channelType: string, platformId: string, at = new Date()): void {
  db()
    ?.prepare(
      `INSERT INTO contact_state (channel_type, platform_id, last_inbound_at) VALUES (?, ?, ?)
       ON CONFLICT(channel_type, platform_id) DO UPDATE SET last_inbound_at = excluded.last_inbound_at`,
    )
    .run(channelType, platformId, at.toISOString());
}

export function lastInboundAt(channelType: string, platformId: string): Date | null {
  const row = db()
    ?.prepare('SELECT last_inbound_at FROM contact_state WHERE channel_type = ? AND platform_id = ?')
    .get(channelType, platformId) as { last_inbound_at: string | null } | undefined;
  return row?.last_inbound_at ? new Date(row.last_inbound_at) : null;
}

export function setOptedOut(channelType: string, platformId: string, optedOut: boolean): void {
  db()
    ?.prepare(
      `INSERT INTO contact_state (channel_type, platform_id, opted_out_at) VALUES (?, ?, ?)
       ON CONFLICT(channel_type, platform_id) DO UPDATE SET opted_out_at = excluded.opted_out_at`,
    )
    .run(channelType, platformId, optedOut ? new Date().toISOString() : null);
}

export function isOptedOut(channelType: string, platformId: string): boolean {
  const row = db()
    ?.prepare('SELECT opted_out_at FROM contact_state WHERE channel_type = ? AND platform_id = ?')
    .get(channelType, platformId) as { opted_out_at: string | null } | undefined;
  return !!row?.opted_out_at;
}

/**
 * Where a chat stands against a reply window of `hours`:
 * 'open' (inside), 'closed' (outside), or 'unknown' (no inbound on record).
 */
export function replyWindow(
  channelType: string,
  platformId: string,
  hours: number,
  now = Date.now(),
): 'open' | 'closed' | 'unknown' {
  const last = lastInboundAt(channelType, platformId);
  if (!last) return 'unknown';
  return now - last.getTime() < hours * 60 * 60 * 1000 ? 'open' : 'closed';
}

const OPT_OUT = new Set(['stop', 'stop all', 'unsubscribe', 'cancel', 'end', 'quit', 'opt out', 'optout']);
const OPT_IN = new Set(['start', 'unstop', 'subscribe', 'opt in', 'optin', 'resume']);

/** Is this whole message an opt-out ("STOP") or opt-in ("START") keyword? */
export function optKeyword(text: string): 'out' | 'in' | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '');
  if (OPT_OUT.has(t)) return 'out';
  if (OPT_IN.has(t)) return 'in';
  return null;
}
