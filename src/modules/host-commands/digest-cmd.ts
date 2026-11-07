/**
 * /digest — opt-in daily digest for one chat.
 *
 *   /digest on [HH:MM]   every weekday at that time (default 09:00), the
 *                        agent posts a short digest of what changed and what
 *                        needs attention here
 *   /digest off          stop it
 *   /digest              show the setting
 *
 * Off by default. If there is nothing worth saying, the agent answers
 * NO_DIGEST and nothing is posted, so a quiet day makes no noise. On
 * WhatsApp, digests outside the 24-hour window go out through the approved
 * template (or are held), like any other message.
 */
import type Database from 'better-sqlite3';

import { audit } from '../../audit.js';
import { openInboundDb } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { cancelTask, insertTask } from '../scheduling/db.js';
import { hasAdminPrivilege } from '../permissions/db/user-roles.js';

/** Reply the agent gives when the digest would say nothing new; never posted. */
export const NO_DIGEST = 'NO_DIGEST';

export const DIGEST_PROMPT = [
  'Daily digest for this chat. In at most 6 short bullets, say what changed since the last digest and what needs attention today',
  '(open questions, deadlines, things waiting on someone). Use only what you know from this conversation, its memory and connected tools.',
  `If there is nothing new worth saying, reply with exactly ${NO_DIGEST} and nothing else.`,
].join(' ');

function digestTaskId(sessionId: string): string {
  return `digest-${sessionId}`;
}

export function parseTime(raw: string | undefined): { hour: number; minute: number } | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec((raw ?? '9:00').trim());
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const ampm = m[3]?.toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}

/** The live digest job in this session, if any (ids are `digest-<session>-<n>`). */
function existing(db: Database.Database, prefix: string): { series_id: string; recurrence: string | null } | undefined {
  return db
    .prepare(
      `SELECT series_id, recurrence FROM messages_in WHERE series_id LIKE ? AND kind = 'task' AND status IN ('pending', 'paused')
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(`${prefix}-%`) as { series_id: string; recurrence: string | null } | undefined;
}

export function digestCommand(opts: {
  session: Session;
  userId: string | null;
  isGroup: boolean;
  args: string;
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
}): string {
  const [sub, time] = opts.args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const prefix = digestTaskId(opts.session.id);
  const db = openInboundDb(opts.session.agent_group_id, opts.session.id);
  try {
    const current = existing(db, prefix);
    if (!sub) {
      if (!current?.recurrence) return 'No daily digest here. /digest on 9:00 starts one (weekdays).';
      const [min, hour] = current.recurrence.split(' ');
      return `Daily digest is on, weekdays at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}. /digest off stops it.`;
    }
    if (opts.isGroup && (!opts.userId || !hasAdminPrivilege(opts.userId, opts.session.agent_group_id))) {
      return 'Only an admin can change the digest in a group.';
    }
    if (sub === 'off') {
      if (current) cancelTask(db, current.series_id);
      audit('digest.changed', { actor: opts.userId, target: opts.session.id, detail: { on: false } });
      return current ? 'Daily digest stopped.' : 'There was no digest running here.';
    }
    if (sub !== 'on') return 'Use /digest on [HH:MM], /digest off or /digest.';
    const t = parseTime(time);
    if (!t) return 'Use a time like /digest on 9:00 or /digest on 5pm.';
    if (current) cancelTask(db, current.series_id);
    const recurrence = `${t.minute} ${t.hour} * * 1-5`;
    const first = new Date();
    first.setHours(t.hour, t.minute, 0, 0);
    if (first.getTime() <= Date.now()) first.setDate(first.getDate() + 1);
    insertTask(db, {
      id: `${prefix}-${Date.now()}`,
      processAfter: first.toISOString(),
      recurrence,
      platformId: opts.platformId,
      channelType: opts.channelType,
      threadId: opts.threadId,
      content: JSON.stringify({ prompt: DIGEST_PROMPT, script: null }),
    });
    audit('digest.changed', { actor: opts.userId, target: opts.session.id, detail: { on: true, recurrence } });
    const hh = String(t.hour).padStart(2, '0');
    const mm = String(t.minute).padStart(2, '0');
    return `Daily digest on: weekdays at ${hh}:${mm}. On quiet days I'll stay silent. /digest off stops it.`;
  } finally {
    db.close();
  }
}
