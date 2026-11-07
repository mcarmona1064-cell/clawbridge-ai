/**
 * Delivery action handlers for scheduling.
 *
 * The container can't write to inbound.db (host-owned). When the agent calls
 * schedule_task / cancel_task / etc. via MCP, the container writes a
 * `kind='system'` outbound message with an `action` field. The delivery path
 * reaches into this module via the delivery-action registry and we apply the
 * change to inbound.db here.
 */
import type Database from 'better-sqlite3';

import { wakeContainer } from '../../container-runner.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { TIMEZONE } from '../../config.js';
import { retractSessionAction } from '../../claim-gate.js';
import { cancelTask, insertTask, pauseTask, resumeTask, updateTask, type TaskUpdate } from './db.js';

/** Recurring jobs that run more often than this per day must have a condition script. */
export const MAX_UNGATED_RUNS_PER_DAY = 4;

/** How many times a cron expression fires in the next 24 hours (capped at 1000). */
export async function runsPerDay(recurrence: string, from = new Date()): Promise<number> {
  const { CronExpressionParser } = await import('cron-parser');
  const interval = CronExpressionParser.parse(recurrence, { tz: TIMEZONE, currentDate: from });
  const end = from.getTime() + 24 * 60 * 60 * 1000;
  let n = 0;
  while (n < 1000) {
    const next = interval.next().getTime();
    if (next > end) break;
    n++;
  }
  return n;
}

/**
 * Why a schedule must be refused, or null if it is fine:
 * - a scheduled job may not create recurring jobs (no runaway chains);
 * - frequent jobs need a condition script, so they cost nothing when there is nothing to do.
 */
export async function scheduleRefusal(opts: {
  recurrence: string | null;
  script: string | null;
  fromTask: boolean;
}): Promise<string | null> {
  if (!opts.recurrence) return null;
  if (opts.fromTask) {
    return 'A scheduled job cannot create another recurring job. Ask the person to set it up, or schedule a one-off reminder instead.';
  }
  let perDay: number;
  try {
    perDay = await runsPerDay(opts.recurrence);
  } catch {
    return `"${opts.recurrence}" is not a valid cron expression.`;
  }
  if (perDay > MAX_UNGATED_RUNS_PER_DAY && !opts.script) {
    return `This job would run ${perDay} times a day. Jobs that run more than ${MAX_UNGATED_RUNS_PER_DAY} times a day need a condition script (the "script" field) that checks whether there is anything to do and only then wakes you, so quiet runs cost nothing. Add a script, or use a less frequent schedule.`;
  }
  return null;
}

export async function handleScheduleTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const prompt = content.prompt as string;
  const script = content.script as string | null;
  const processAfter = content.processAfter as string;
  const recurrence = (content.recurrence as string) || null;

  const refusal = await scheduleRefusal({ recurrence, script, fromTask: content.fromTask === true });
  if (refusal) {
    log.info('Scheduled task refused', { taskId, recurrence, reason: refusal });
    retractSessionAction(session.id, 'schedule_task');
    notifySession(session, `schedule_task ${taskId} was NOT created: ${refusal}`);
    return;
  }

  insertTask(inDb, {
    id: taskId,
    processAfter,
    recurrence,
    platformId: (content.platformId as string) ?? null,
    channelType: (content.channelType as string) ?? null,
    threadId: (content.threadId as string) ?? null,
    content: JSON.stringify({ prompt, script }),
  });
  log.info('Scheduled task created', { taskId, processAfter, recurrence });
}

export async function handleCancelTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  cancelTask(inDb, taskId);
  log.info('Task cancelled', { taskId });
}

export async function handlePauseTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  pauseTask(inDb, taskId);
  log.info('Task paused', { taskId });
}

export async function handleResumeTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  resumeTask(inDb, taskId);
  log.info('Task resumed', { taskId });
}

export async function handleUpdateTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const update: TaskUpdate = {};
  if (typeof content.prompt === 'string') update.prompt = content.prompt;
  if (typeof content.processAfter === 'string') update.processAfter = content.processAfter;
  if (content.recurrence === null || typeof content.recurrence === 'string') {
    update.recurrence = content.recurrence as string | null;
  }
  if (content.script === null || typeof content.script === 'string') {
    update.script = content.script as string | null;
  }
  const touched = updateTask(inDb, taskId, update);
  log.info('Task updated', { taskId, touched, fields: Object.keys(update) });
  if (touched === 0) {
    // Notify the agent that update_task matched nothing. Replicates the
    // old notifyAgent helper that used to live in delivery.ts — inlined
    // here so scheduling doesn't depend on delivery's private helpers.
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `update_task: no live task matched id "${taskId}".`,
        sender: 'system',
        senderId: 'system',
      }),
    });
    const fresh = getSession(session.id);
    if (fresh) {
      wakeContainer(fresh).catch((err) =>
        log.error('Failed to wake container after update_task notification', { err }),
      );
    }
  }
}

/** Tell the agent (as a system message) and wake it so it can tell the person. */
function notifySession(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sched-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) void wakeContainer(fresh).catch((err) => log.warn('Wake after schedule refusal failed', { err }));
}
