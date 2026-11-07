/**
 * /help and /tasks — plain-language help, and the scheduled jobs of this
 * agent with a way to cancel them.
 */
import { capabilitiesFor } from '../../channels/capabilities.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { openInboundDb } from '../../session-manager.js';
import { cancelTask } from '../scheduling/db.js';
import { hasAdminPrivilege } from '../permissions/db/user-roles.js';

export function helpText(channelType: string, isAdmin: boolean): string {
  const caps = capabilitiesFor(channelType);
  const lines = [
    "**Here's how to work with me**",
    caps.threads
      ? 'Mention me in a channel and I reply in a thread. In a thread I already joined, just keep talking.'
      : 'Just message me. In a group, mention me so I know it is for me.',
    'Ask in plain words, like "summarise yesterday\'s sales" or "remind me every Monday at 9 to send the report".',
    '',
    '**Controls**',
    '• !stop: stop what I am doing',
    '• !mute [hours] / !unmute: keep me quiet in this chat',
    '• !fast / !deep / !normal: quicker and cheaper, or more careful',
    '• /status: what I am doing and which AI I use',
    '• /tasks: my scheduled jobs',
    '• /link: connect this account with your account on another app',
    '• /notify-here: send your approvals and alerts to this chat',
    '• /accounts: the accounts linked to you',
  ];
  if (isAdmin) {
    lines.push(
      '',
      '**Admin**',
      '• /provider claude|codex: switch the AI',
      '• /teamfact <fact>: save something every conversation should know',
      '• /tasks cancel <id>: cancel a scheduled job',
      '• /approve, /deny: answer a pending approval',
    );
  }
  lines.push('', 'All commands: /commands');
  return lines.join('\n');
}

interface TaskRow {
  id: string;
  process_after: string | null;
  recurrence: string | null;
  status: string;
  content: string;
}

export function listTasks(agentGroupId: string): Array<TaskRow & { sessionId: string }> {
  const out: Array<TaskRow & { sessionId: string }> = [];
  for (const session of getSessionsByAgentGroup(agentGroupId)) {
    let db;
    try {
      db = openInboundDb(agentGroupId, session.id);
    } catch {
      continue;
    }
    try {
      const rows = db
        .prepare(
          `SELECT id, process_after, recurrence, status, content FROM messages_in
           WHERE kind = 'task' AND status IN ('pending', 'paused') ORDER BY process_after`,
        )
        .all() as TaskRow[];
      for (const r of rows) out.push({ ...r, sessionId: session.id });
    } finally {
      db.close();
    }
  }
  return out;
}

function describeTask(t: TaskRow): string {
  let prompt = '';
  try {
    prompt = String((JSON.parse(t.content) as { prompt?: string }).prompt ?? '');
  } catch {
    prompt = t.content;
  }
  const when = t.recurrence ? `repeats (${t.recurrence})` : t.process_after ? `at ${t.process_after}` : 'soon';
  const paused = t.status === 'paused' ? ' [paused]' : '';
  return `• ${prompt.replace(/\s+/g, ' ').slice(0, 90)} — ${when}${paused}  (id ${t.id})`;
}

export function tasksCommand(agentGroupId: string, userId: string | null, args: string): string {
  const [sub, id] = args.trim().split(/\s+/);
  if (sub === 'cancel') {
    if (!userId || !hasAdminPrivilege(userId, agentGroupId)) return 'Only an admin can cancel scheduled jobs.';
    if (!id) return 'Usage: /tasks cancel <id>';
    for (const session of getSessionsByAgentGroup(agentGroupId)) {
      const db = openInboundDb(agentGroupId, session.id);
      try {
        const hit = db
          .prepare(`SELECT 1 FROM messages_in WHERE (id = ? OR series_id = ?) AND kind = 'task'`)
          .get(id, id);
        if (hit) {
          cancelTask(db, id);
          return `Cancelled ${id}.`;
        }
      } finally {
        db.close();
      }
    }
    return `No scheduled job with id ${id}. /tasks lists them.`;
  }
  const tasks = listTasks(agentGroupId);
  if (tasks.length === 0)
    return 'No scheduled jobs. Ask me something like "every weekday at 9, post the sales summary".';
  return [
    `**Scheduled jobs (${tasks.length})**`,
    ...tasks.slice(0, 20).map(describeTask),
    tasks.length > 20 ? `…and ${tasks.length - 20} more` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
