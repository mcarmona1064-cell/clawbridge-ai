/**
 * Host sweep — periodic maintenance of all session DBs.
 *
 * Two-DB architecture:
 *   - Reads processing_ack + container_state from outbound.db
 *   - Writes to inbound.db (host-owned) for status updates + recurrence
 *   - Uses heartbeat file mtime for liveness (never polls DB for it)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 *
 * Stuck / idle detection (replaces the old IDLE_TIMEOUT setTimeout + 10-min
 * heartbeat threshold):
 *
 *   If the container isn't running and there are 'processing' rows left over
 *   (e.g. it crashed mid-turn) → reset them to pending with backoff +
 *   tries++. Existing retry machinery does the rest.
 *
 *   If the container IS running:
 *     1. Absolute ceiling: heartbeat age > max(30 min, current_bash_timeout)
 *        → kill. Covers the "alive but silent for 30 min" case. Extended
 *        only while Bash is declared as running longer, honouring the
 *        user's own timeout directive. Kill then resets processing rows.
 *
 *     2. Message-scoped stuck: for each 'processing' row, tolerance =
 *        max(60s, current_bash_timeout_ms_if_Bash_running). If
 *        (claim_age > tolerance) AND (heartbeat_mtime <= status_changed)
 *        → kill + reset this message + tries++. Semantics: "container
 *        claimed a message and went quiet past tolerance since the claim."
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { getActiveSessions, getSessionsByAgentGroup, deleteSession } from './db/sessions.js';
import { getAgentGroup, deleteAgentGroup } from './db/agent-groups.js';
import {
  countDueMessages,
  getContainerState,
  getMessageForRetry,
  getProcessingClaims,
  markMessageFailed,
  retryWithBackoff,
  syncProcessingAcks,
  type ContainerState,
} from './db/session-db.js';
import { DATA_DIR, GROUPS_DIR } from './config.js';
import { log } from './log.js';
import { openInboundDb, openOutboundDb, inboundDbPath, heartbeatPath, writeSessionMessage } from './session-manager.js';
import { sendAdminAlert } from './shared/admin-alert.js';
import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import type { Session } from './types.js';
import { hasTable } from './db/connection.js';
import { getDb } from './db/connection.js';
import {
  getPendingDroppedA2a,
  updateDroppedA2aRetry,
  markDroppedA2aDelivered,
  markDroppedA2aFailed,
} from './db/dropped-a2a.js';
import { getTasksToCleanup, markEphemeralTaskCleaned } from './db/ephemeral-tasks.js';
import { deleteAgentHealth, getAllAgentHealth } from './db/agent-health.js';
import { getExpiredFanOutTasksToNotify, expireOldFanOutTasks } from './db/fan-out-tasks.js';
import { getSession } from './db/sessions.js';
import {
  MemoryManager,
  runReflectionAgent,
  generateCrossClientReport,
  hindsightReflect,
  memoryScopesForSessions,
  isHindsightAvailable,
} from './memory/index.js';

const SWEEP_INTERVAL_MS = 60_000;
// Absolute idle ceiling for a running container. If the heartbeat file hasn't
// been touched in this long, the container is either stuck or doing genuinely
// nothing — kill and restart on the next inbound.
export const ABSOLUTE_CEILING_MS = 30 * 60 * 1000;
// Stuck tolerance window applied per 'processing' claim — "did we see any
// signs of life since this message was claimed?"
export const CLAIM_STUCK_MS = 60 * 1000;
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

export type StuckDecision =
  | { action: 'ok' }
  | { action: 'kill-ceiling'; heartbeatAgeMs: number; ceilingMs: number }
  | { action: 'kill-claim'; messageId: string; claimAgeMs: number; toleranceMs: number };

/**
 * Pure decision for whether a running container should be killed this sweep
 * tick. Inputs are all deterministic; filesystem + DB reads happen in the
 * caller.
 */
export function decideStuckAction(args: {
  now: number;
  heartbeatMtimeMs: number; // 0 when heartbeat file absent
  containerState: ContainerState | null;
  claims: Array<{ message_id: string; status_changed: string }>;
}): StuckDecision {
  const { now, heartbeatMtimeMs, containerState, claims } = args;
  const declaredBashMs = bashTimeoutMs(containerState);

  // Ceiling check only applies when we have an actual heartbeat timestamp.
  // A freshly-spawned container hasn't had any SDK activity yet so no
  // heartbeat file exists — if we treated that as infinitely stale we'd
  // kill every container within seconds of spawn. Genuinely-dead containers
  // that never wrote a heartbeat are caught by the separate "container
  // process not running" cleanup path, not here. If a fresh container is
  // hanging at the gate (claimed a message but never did anything) the
  // claim-stuck check below handles it.
  if (heartbeatMtimeMs !== 0) {
    const heartbeatAge = now - heartbeatMtimeMs;
    const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredBashMs ?? 0);
    if (heartbeatAge > ceiling) {
      return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling };
    }
  }

  const tolerance = Math.max(CLAIM_STUCK_MS, declaredBashMs ?? 0);
  for (const claim of claims) {
    const claimedAt = Date.parse(claim.status_changed);
    if (Number.isNaN(claimedAt)) continue;
    const claimAge = now - claimedAt;
    if (claimAge <= tolerance) continue;
    if (heartbeatMtimeMs > claimedAt) continue;
    return { action: 'kill-claim', messageId: claim.message_id, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  return { action: 'ok' };
}

let running = false;
let lastDecayDate = ''; // YYYY-MM-DD of last nightly decay run
let lastReflectDate = ''; // YYYY-MM-DD of last evening reflect run
/** Cap on banks reflected per evening, to bound LLM cost. */
const MAX_REFLECT_SCOPES = 25;
let lastWeeklyReportDate = ''; // YYYY-Www of last weekly cross-client report

export function startHostSweep(): void {
  if (running) return;
  running = true;
  sweep();
}

export function stopHostSweep(): void {
  running = false;
}

async function sweep(): Promise<void> {
  if (!running) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await sweepSession(session);
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }

  try {
    // Nightly memory decay — runs once at/after 2am each calendar day
    await runNightlyMemoryDecay();
    // Evening reflect — runs once between 19:00 and 20:00 each day
    await runEveningReflect();
    // Weekly cross-client report — runs Sunday midnight
    await runWeeklyCrossClientReport();
  } catch (err) {
    log.error('Host sweep nightly task error', { err });
  }

  try {
    await retryDroppedA2aMessages();
  } catch (err) {
    log.error('Host sweep A2A retry error', { err });
  }

  try {
    await cleanupExpiredFanOutTasks();
  } catch (err) {
    log.error('Host sweep fan-out timeout error', { err });
  }

  try {
    await checkAgentHealthAlerts();
  } catch (err) {
    log.error('Host sweep agent health alert error', { err });
  }

  try {
    await cleanupEphemeralTasks();
  } catch (err) {
    log.error('Host sweep ephemeral task cleanup error', { err });
  }

  if (running) setTimeout(sweep, SWEEP_INTERVAL_MS);
}

async function runNightlyMemoryDecay(): Promise<void> {
  const now = new Date();
  // Only run between 02:00 and 03:00 local time, once per calendar day
  if (now.getHours() !== 2) return;
  const today = now.toISOString().slice(0, 10);
  if (lastDecayDate === today) return;
  lastDecayDate = today;

  log.info('[memory] Running nightly decay pass');
  try {
    const sessions = getActiveSessions();
    const clientIds = new Set<string>();
    clientIds.add('global');
    for (const session of sessions) {
      clientIds.add(session.id);
    }
    for (const clientId of clientIds) {
      const manager = new MemoryManager(clientId);
      await manager.runDecay();
    }
    log.info('[memory] Nightly decay complete', { clients: clientIds.size });
  } catch (err) {
    log.error('[memory] Nightly decay failed', { err });
  }
}

async function runEveningReflect(): Promise<void> {
  const now = new Date();
  // Run once between 19:00 and 20:00 local time each day
  if (now.getHours() !== 19) return;
  const today = now.toISOString().slice(0, 10);
  if (lastReflectDate === today) return;
  lastReflectDate = today;

  if (!(await isHindsightAvailable())) return;
  try {
    // Reflect inside each active conversation's own bank — never across them.
    const scopes = memoryScopesForSessions(getActiveSessions()).slice(0, MAX_REFLECT_SCOPES);
    for (const scope of scopes) {
      await hindsightReflect(scope, 'key user preferences, communication style, and recurring patterns');
    }
    log.info('[hindsight] Evening reflect complete', { scopes: scopes.length });
  } catch (err) {
    log.warn('[hindsight] Evening reflect failed', { err });
  }
}

async function runWeeklyCrossClientReport(): Promise<void> {
  const now = new Date();
  // Only run on Sunday (0) between midnight and 01:00 local time
  if (now.getDay() !== 0 || now.getHours() !== 0) return;

  // ISO week key: YYYY-Www
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
  const weekKey = `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  if (lastWeeklyReportDate === weekKey) return;
  lastWeeklyReportDate = weekKey;

  log.info('[memory] Running weekly cross-client report', { week: weekKey });
  try {
    const sessions = getActiveSessions();
    const clientSlugs = new Set<string>();
    clientSlugs.add('global');
    for (const session of sessions) {
      clientSlugs.add(session.id);
    }
    const clientIds = [...clientSlugs];
    if (clientIds.length < 2) {
      log.debug('[memory] Not enough clients for weekly report', { count: clientIds.length });
      return;
    }
    await generateCrossClientReport(clientIds);
  } catch (err) {
    log.error('[memory] Weekly cross-client report failed', { err });
  }
}

async function sweepSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  const inPath = inboundDbPath(agentGroup.id, session.id);
  if (!fs.existsSync(inPath)) return;

  let inDb: Database.Database;
  let outDb: Database.Database | null = null;
  try {
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return;
  }

  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
  } catch {
    // outbound.db might not exist yet (container hasn't started)
  }

  try {
    // 1. Sync processing_ack → messages_in status
    if (outDb) {
      syncProcessingAcks(inDb, outDb);
    }

    // 2. Wake a container if work is due and nothing is running. Ordered
    // before the crashed-container cleanup so a fresh container gets a chance
    // to clean its own orphan processing_ack rows on startup (see
    // container/agent-runner/src/db/connection.ts). Otherwise the reset path
    // would keep bumping process_after into the future, dueCount would stay 0,
    // and the wake would never fire.
    const dueCount = countDueMessages(inDb);
    if (dueCount > 0 && !isContainerRunning(session.id)) {
      log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
      await wakeContainer(session);
    }

    const alive = isContainerRunning(session.id);

    // 3. Running-container SLA: absolute ceiling + per-claim stuck rules.
    if (alive && outDb) {
      enforceRunningContainerSla(inDb, outDb, session, agentGroup.id);
    }

    // 4. Crashed-container cleanup: processing rows left behind get retried.
    // Only fires when wake in step 2 didn't pick up the work (no due messages,
    // or wake failed). resetStuckProcessingRows itself is idempotent — it
    // skips messages already scheduled for a future retry.
    if (!alive && outDb) {
      resetStuckProcessingRows(inDb, outDb, session, 'container not running');
    }

    // 5. Recurrence fanout for completed recurring tasks.
    // MODULE-HOOK:scheduling-recurrence:start
    const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
    await handleRecurrence(inDb, session);
    // MODULE-HOOK:scheduling-recurrence:end
  } finally {
    inDb.close();
    outDb?.close();
  }
}

function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}

function bashTimeoutMs(state: ContainerState | null): number | null {
  if (!state || state.current_tool !== 'Bash') return null;
  return typeof state.tool_declared_timeout_ms === 'number' ? state.tool_declared_timeout_ms : null;
}

function enforceRunningContainerSla(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  agentGroupId: string,
): void {
  const decision = decideStuckAction({
    now: Date.now(),
    heartbeatMtimeMs: heartbeatMtimeMs(agentGroupId, session.id),
    containerState: getContainerState(outDb),
    claims: getProcessingClaims(outDb),
  });

  if (decision.action === 'ok') return;

  if (decision.action === 'kill-ceiling') {
    log.warn('Killing container past absolute ceiling', {
      sessionId: session.id,
      heartbeatAgeMs: decision.heartbeatAgeMs,
      ceilingMs: decision.ceilingMs,
    });
    killContainer(session.id, 'absolute-ceiling');
    resetStuckProcessingRows(inDb, outDb, session, 'absolute-ceiling');
    return;
  }

  log.warn('Killing container — message claimed then silent', {
    sessionId: session.id,
    messageId: decision.messageId,
    claimAgeMs: decision.claimAgeMs,
    toleranceMs: decision.toleranceMs,
  });
  killContainer(session.id, 'claim-stuck');
  resetStuckProcessingRows(inDb, outDb, session, 'claim-stuck');
}

function resetStuckProcessingRows(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
): void {
  const claims = getProcessingClaims(outDb);
  const now = Date.now();
  for (const { message_id } of claims) {
    const msg = getMessageForRetry(inDb, message_id, 'pending');
    if (!msg) continue;

    // Already rescheduled for a future retry — don't bump tries again. The
    // wake path (sweep step 2) will fire when process_after elapses and a
    // fresh container will clean the orphan claim on startup.
    if (msg.processAfter && Date.parse(msg.processAfter) > now) continue;

    if (msg.tries >= MAX_TRIES) {
      markMessageFailed(inDb, msg.id);
      log.warn('Message marked as failed after max retries', {
        messageId: msg.id,
        sessionId: session.id,
        reason,
      });
      const agentGrp = getAgentGroup(session.agent_group_id);
      const agentName = agentGrp?.name ?? session.agent_group_id.slice(-8);
      sendSweepAlert(
        `⚠️ <b>Message permanently failed: ${agentName}</b>\n\n` +
          `Message <code>${msg.id.slice(-12)}</code> could not be processed after ${MAX_TRIES} attempts.\n` +
          `Reason: ${reason}\n\n` +
          `Check the agent logs — it may need a restart or manual intervention.`,
      ).catch(() => {
        /* non-critical */
      });
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      retryWithBackoff(inDb, msg.id, backoffSec);
      log.info('Reset stale message with backoff', {
        messageId: msg.id,
        tries: msg.tries,
        backoffMs,
        reason,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// A2A retry — re-delivers messages that failed their initial routing attempt
// ---------------------------------------------------------------------------

const MAX_A2A_RETRIES = 4;
const A2A_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000]; // 30s, 2m, 10m, 30m

async function retryDroppedA2aMessages(): Promise<void> {
  if (!hasTable(getDb(), 'dropped_a2a_messages')) return;

  const pending = getPendingDroppedA2a();
  if (pending.length === 0) return;

  const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');

  for (const row of pending) {
    if (row.retry_count >= MAX_A2A_RETRIES) {
      markDroppedA2aFailed(row.id);
      log.warn('A2A retry: max retries reached, marking failed', {
        id: row.id,
        source: row.source_group_id,
        target: row.target_group_id,
      });
      // Notify source agent that the delivery permanently failed.
      try {
        const srcSessionRow = getDb()
          .prepare(
            "SELECT id FROM sessions WHERE agent_group_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
          )
          .get(row.source_group_id) as { id: string } | undefined;
        const srcSession = srcSessionRow ? getSession(srcSessionRow.id) : undefined;
        if (srcSession) {
          const targetGrp = getAgentGroup(row.target_group_id);
          const targetName = targetGrp?.name ?? row.target_group_id.slice(-8);
          writeSessionMessage(row.source_group_id, srcSession.id, {
            id: `a2a-fail-${row.id}-${Date.now()}`,
            kind: 'chat',
            timestamp: new Date().toISOString(),
            platformId: row.source_group_id,
            channelType: 'agent',
            threadId: null,
            content: JSON.stringify({
              text: `[Delivery failed — your message to "${targetName}" could not be delivered after ${MAX_A2A_RETRIES} attempts. The message has been dropped.]`,
              sender: 'system',
              senderId: 'system',
            }),
          });
          const fresh = getSession(srcSession.id);
          if (fresh) {
            wakeContainer(fresh).catch((err) =>
              log.error('A2A retry: failed to wake source after permanent failure', { err }),
            );
          }
        }
      } catch (notifyErr) {
        log.error('A2A retry: source notification error', { id: row.id, err: notifyErr });
      }
      continue;
    }

    // Reconstruct a minimal session from the source group's active session
    const sourceSession = getSession(
      (
        getDb()
          .prepare(
            "SELECT id FROM sessions WHERE agent_group_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
          )
          .get(row.source_group_id) as { id: string } | undefined
      )?.id ?? '',
    );
    if (!sourceSession) {
      const nextBackoff = A2A_BACKOFF_MS[Math.min(row.retry_count, A2A_BACKOFF_MS.length - 1)];
      updateDroppedA2aRetry(row.id, row.retry_count + 1, new Date(Date.now() + nextBackoff).toISOString());
      log.warn('A2A retry: source session not found, rescheduling', { id: row.id });
      continue;
    }

    try {
      await routeAgentMessage(
        { id: row.id, platform_id: row.target_group_id, content: row.msg_content },
        sourceSession,
      );
      markDroppedA2aDelivered(row.id);
      log.info('A2A retry: delivered', { id: row.id, retryCount: row.retry_count + 1 });
    } catch (err) {
      const nextRetryCount = row.retry_count + 1;
      const backoffMs = A2A_BACKOFF_MS[Math.min(nextRetryCount - 1, A2A_BACKOFF_MS.length - 1)];
      updateDroppedA2aRetry(row.id, nextRetryCount, new Date(Date.now() + backoffMs).toISOString());
      log.warn('A2A retry: still failing', {
        id: row.id,
        attempt: nextRetryCount,
        err: (err as Error).message,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Agent health alerts
// ---------------------------------------------------------------------------

const AGENT_ERROR_THRESHOLD = 3;
const agentAlertCooldown = new Map<string, number>(); // agentGroupId -> last alert timestamp

async function sendSweepAlert(text: string): Promise<void> {
  await sendAdminAlert(text);
}

async function checkAgentHealthAlerts(): Promise<void> {
  if (!hasTable(getDb(), 'agent_health')) return;
  const rows = getAllAgentHealth();
  const now = Date.now();
  for (const row of rows) {
    if (row.consecutive_errors < AGENT_ERROR_THRESHOLD) continue;
    const lastAlert = agentAlertCooldown.get(row.agent_group_id) ?? 0;
    if (now - lastAlert < 60 * 60 * 1000) continue; // 1h cooldown
    agentAlertCooldown.set(row.agent_group_id, now);
    const grp = getAgentGroup(row.agent_group_id);
    const name = grp?.name ?? row.agent_group_id.slice(-8);
    log.warn('agent-health-alert: consecutive error threshold reached', {
      agentGroupId: row.agent_group_id,
      name,
      errors: row.consecutive_errors,
    });
    await sendSweepAlert(
      `⚠️ <b>Agent struggling: ${name}</b>\n\n` +
        `${row.consecutive_errors} consecutive errors\n` +
        `Last error: ${row.last_error ?? 'unknown'}\n\n` +
        `Check the agent\'s logs or restart it if needed.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Fan-out timeout notifications
// ---------------------------------------------------------------------------

async function cleanupExpiredFanOutTasks(): Promise<void> {
  if (!hasTable(getDb(), 'fan_out_tasks')) return;
  const tasks = getExpiredFanOutTasksToNotify();
  if (tasks.length === 0) return;

  for (const task of tasks) {
    try {
      const replies = JSON.parse(task.replies) as Record<string, string>;
      const targets = JSON.parse(task.target_group_ids) as string[];
      const replied = Object.keys(replies);
      const missing = targets.filter((id) => !(id in replies));

      const replyLines = replied.map((id) => {
        const grp = getAgentGroup(id);
        const name = grp?.name ?? id.slice(-8);
        const text = replies[id] ?? '';
        return `<b>${name}</b>: ${text.length > 200 ? text.slice(0, 200) + '...' : text}`;
      });
      const missingNames = missing.map((id) => getAgentGroup(id)?.name ?? id.slice(-8));

      let timeoutMsg = `[fan_out timed out — ${replied.length}/${targets.length} agents replied]`;
      if (replyLines.length > 0) {
        timeoutMsg += `\n\nPartial results:\n${replyLines.join('\n')}`;
      }
      if (missingNames.length > 0) {
        timeoutMsg += `\n\nNo reply from: ${missingNames.join(', ')}`;
      }

      const orcSessionRow = getDb()
        .prepare(
          "SELECT id FROM sessions WHERE agent_group_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
        )
        .get(task.orchestrator_group_id) as { id: string } | undefined;
      const orcSession = orcSessionRow ? getSession(orcSessionRow.id) : undefined;

      if (orcSession) {
        writeSessionMessage(task.orchestrator_group_id, orcSession.id, {
          id: `fanout-timeout-${task.id}-${Date.now()}`,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          platformId: task.orchestrator_group_id,
          channelType: 'agent',
          threadId: null,
          content: JSON.stringify({ text: timeoutMsg, sender: 'system', senderId: 'system' }),
        });
        const fresh = getSession(orcSession.id);
        if (fresh) {
          wakeContainer(fresh).catch((err) => log.error('fan-out timeout: failed to wake orchestrator', { err }));
        }
      }

      log.info('fan-out: timeout notification sent to orchestrator', {
        taskId: task.id,
        replied: replied.length,
        total: targets.length,
      });
    } catch (err) {
      log.error('fan-out timeout notification error', { taskId: task.id, err });
    }
  }

  expireOldFanOutTasks();
}

// ---------------------------------------------------------------------------
// Ephemeral task cleanup
// ---------------------------------------------------------------------------

async function cleanupEphemeralTasks(): Promise<void> {
  if (!hasTable(getDb(), 'ephemeral_tasks')) return;
  const tasks = getTasksToCleanup();
  if (tasks.length === 0) return;
  const { deleteAllDestinationsTouching } = await import('./modules/agent-to-agent/db/agent-destinations.js');
  const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
  for (const task of tasks) {
    try {
      const taskSessions = getSessionsByAgentGroup(task.task_agent_group_id);
      for (const sess of taskSessions) {
        if (isContainerRunning(sess.id)) killContainer(sess.id, 'ephemeral-task-cleanup');
      }
      // For tasks that timed out without a reply, notify the caller before cleanup.
      if (task.status === 'running') {
        try {
          const callerActive = getSessionsByAgentGroup(task.caller_group_id).find((s) => s.status === 'active');
          if (callerActive) {
            const timeoutMsg = `[Task timed out — task agent did not reply within the timeout window. Task: ${task.id.slice(-8)}]`;
            writeSessionMessage(task.caller_group_id, callerActive.id, {
              id: `etask-timeout-${task.id}-${Date.now()}`,
              kind: 'chat',
              timestamp: new Date().toISOString(),
              platformId: task.caller_group_id,
              channelType: 'agent',
              threadId: null,
              content: JSON.stringify({ text: timeoutMsg, sender: 'system', senderId: 'system' }),
            });
            const freshCaller = getSession(callerActive.id);
            if (freshCaller) {
              wakeContainer(freshCaller).catch((err) =>
                log.error('ephemeral-task timeout: failed to wake caller', { err }),
              );
            }
            log.info('Ephemeral task: timeout notification sent to caller', { taskId: task.id });
          }
        } catch (notifyErr) {
          log.error('Ephemeral task timeout notification error', { taskId: task.id, err: notifyErr });
        }
      }
      const callerSessions = getSessionsByAgentGroup(task.caller_group_id);
      deleteAllDestinationsTouching(task.task_agent_group_id);
      for (const cs of callerSessions) {
        try {
          writeDestinations(task.caller_group_id, cs.id);
        } catch {
          /* non-critical */
        }
      }
      for (const sess of taskSessions) deleteSession(sess.id);
      deleteAgentHealth(task.task_agent_group_id);
      deleteAgentGroup(task.task_agent_group_id);
      fs.rmSync(path.join(GROUPS_DIR, task.task_agent_folder), { recursive: true, force: true });
      fs.rmSync(path.join(DATA_DIR, 'v2-sessions', task.task_agent_group_id), { recursive: true, force: true });
      markEphemeralTaskCleaned(task.id);
      log.info('Ephemeral task cleaned up', {
        taskId: task.id,
        reason: task.status === 'replied' ? 'replied' : 'expired',
        agentGroupId: task.task_agent_group_id,
      });
    } catch (err) {
      log.error('Ephemeral task cleanup error', { taskId: task.id, err });
    }
  }
}
