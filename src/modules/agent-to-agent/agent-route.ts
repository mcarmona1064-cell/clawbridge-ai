/**
 * Agent-to-agent message routing.
 *
 * Outbound messages with `channel_type === 'agent'` target another agent
 * group rather than a channel. Permission is enforced via `agent_destinations` —
 * the source agent must have a row for the target. Content is copied into the
 * target's inbound DB; if the source message had `files` (from `send_file`),
 * the actual bytes are copied from the source's outbox into the target's
 * `inbox/<a2a-msg-id>/` directory and surfaced to the target agent as
 * `attachments` (existing formatter convention — see formatter.ts:230).
 * The target agent can then forward the file onward via its own `send_file`
 * call using the absolute `/workspace/inbox/<a2a-msg-id>/<filename>` path.
 *
 * Self-messages are always allowed (used for system notes injected back into
 * an agent's own session, e.g. post-approval follow-up prompts).
 *
 * Core delivery.ts dispatches into this via a dynamic import guarded by a
 * `channel_type === 'agent'` check. When the module is absent the check in
 * core throws with a "module not installed" message so retry → mark failed.
 */
import fs from 'fs';
import path from 'path';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { inboundDbPath, resolveSession, sessionDir, writeSessionMessage } from '../../session-manager.js';
import { openInboundDb as openInboundDbWriter } from '../../db/session-db.js';
import type { Session } from '../../types.js';
import { hasDestination } from './db/agent-destinations.js';
import { getDb } from '../../db/connection.js';
import { hasTable } from '../../db/connection.js';
import { recordAgentSuccess, recordAgentError } from '../../db/agent-health.js';
import { insertDroppedA2a } from '../../db/dropped-a2a.js';
import {
  getActiveFanOutTasksForOrchestrator,
  recordFanOutReply,
  expireOldFanOutTasks,
} from '../../db/fan-out-tasks.js';
import { getEphemeralTaskByAgentGroup, markEphemeralTaskReplied } from '../../db/ephemeral-tasks.js';

export interface ForwardedAttachment {
  name: string;
  filename: string;
  type: 'file';
  localPath: string;
}

/**
 * Is `name` safe to use as the last segment of a path inside the target
 * agent's inbox directory? Filenames arrive in messages_out content from
 * the source agent — under a multi-agent setup with heterogenous providers
 * (or a compromised / hallucinating sub-agent) they can't be trusted.
 *
 * Rejects:
 *   - empty string
 *   - `.` / `..` (traversal sentinels that path.basename returns as-is)
 *   - anything containing a path separator (`/` or `\`) or NUL
 *   - any value where `path.basename(name) !== name`, catching OS-specific
 *     separators and covering drives/prefixes on Windows runtimes
 */
export function isSafeAttachmentName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name === '.' || name === '..') return false;
  if (/[\\/\0]/.test(name)) return false;
  return path.basename(name) === name;
}

/**
 * Copy file attachments from the source agent's outbox into the target
 * agent's inbox. Returns attachments using the formatter's existing
 * `{name, type, localPath}` convention — target agent reads `localPath`
 * as relative to `/workspace/`, matching how channel-inbound attachments
 * are surfaced today.
 *
 * Missing source files and unsafe (path-traversal) filenames are skipped
 * with a warning rather than failing the whole route — a bad filename
 * reference shouldn't kill the accompanying text.
 */
export function forwardAttachedFiles(
  source: { agentGroupId: string; sessionId: string; messageId: string; filenames: string[] },
  target: { agentGroupId: string; sessionId: string; messageId: string },
): ForwardedAttachment[] {
  if (source.filenames.length === 0) return [];

  const sourceDir = path.join(sessionDir(source.agentGroupId, source.sessionId), 'outbox', source.messageId);
  if (!fs.existsSync(sourceDir)) {
    log.warn('agent-route: source outbox dir missing, no files forwarded', {
      sourceMsgId: source.messageId,
      sourceDir,
    });
    return [];
  }

  const targetInboxDir = path.join(sessionDir(target.agentGroupId, target.sessionId), 'inbox', target.messageId);
  try {
    fs.mkdirSync(targetInboxDir, { recursive: true });
  } catch (err) {
    log.warn('agent-route: failed to create target inbox dir, no files forwarded', { targetInboxDir, err });
    return [];
  }

  const attachments: ForwardedAttachment[] = [];
  for (const filename of source.filenames) {
    if (!isSafeAttachmentName(filename)) {
      log.warn('agent-route: rejecting unsafe attachment filename (path traversal attempt?)', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    const src = path.join(sourceDir, filename);
    if (!fs.existsSync(src)) {
      log.warn('agent-route: referenced file missing in source outbox, skipped', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    const dst = path.join(targetInboxDir, filename);
    fs.copyFileSync(src, dst);
    attachments.push({
      name: filename,
      filename,
      type: 'file',
      localPath: `inbox/${target.messageId}/${filename}`,
    });
  }
  return attachments;
}

export interface RoutableAgentMessage {
  id: string;
  platform_id: string | null;
  content: string;
}

export async function routeAgentMessage(msg: RoutableAgentMessage, session: Session): Promise<void> {
  const targetAgentGroupId = msg.platform_id;
  if (!targetAgentGroupId) {
    throw new Error(`agent-to-agent message ${msg.id} is missing a target agent group id`);
  }
  if (
    targetAgentGroupId !== session.agent_group_id &&
    !hasDestination(session.agent_group_id, 'agent', targetAgentGroupId)
  ) {
    throw new Error(
      `unauthorized agent-to-agent: ${session.agent_group_id} has no destination for ${targetAgentGroupId}`,
    );
  }
  if (!getAgentGroup(targetAgentGroupId)) {
    throw new Error(`target agent group ${targetAgentGroupId} not found for message ${msg.id}`);
  }

  // Step 3b: if the outbound message carries reply_to_session, route directly to
  // that session rather than the agent-shared session.
  let replyToSessionId: string | null = null;
  try {
    const parsedContent = JSON.parse(msg.content) as Record<string, unknown>;
    if (typeof parsedContent.reply_to_session === 'string') {
      replyToSessionId = parsedContent.reply_to_session;
    }
  } catch {
    // non-JSON content — fall through to agent-shared
  }

  let targetSession: Session;
  if (replyToSessionId) {
    const directSession = getSession(replyToSessionId);
    if (directSession && directSession.agent_group_id === targetAgentGroupId) {
      targetSession = directSession;
      log.info('agent-route: reply_to_session found, routing directly to parent session', {
        replyToSession: replyToSessionId,
        targetAgentGroupId,
      });
    } else {
      log.warn('agent-route: reply_to_session points to unknown/mismatched session, falling back to agent-shared', {
        replyToSessionId,
        targetAgentGroupId,
      });
      ({ session: targetSession } = resolveSession(targetAgentGroupId, null, null, 'agent-shared'));
    }
  } else {
    ({ session: targetSession } = resolveSession(targetAgentGroupId, null, null, 'agent-shared'));
  }

  const a2aMsgId = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const forwardedContent = forwardFileAttachments(msg, a2aMsgId, session, targetAgentGroupId, targetSession.id);

  // Deliver: write the message, wake the container, update health and fan-out state.
  // On failure: record the error, persist the message for sweep-based retry, re-throw.
  try {
    writeSessionMessage(targetAgentGroupId, targetSession.id, {
      id: a2aMsgId,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: forwardedContent,
      replyToSession: session.id,
    });

    upsertA2aContext(targetAgentGroupId, targetSession.id, session.id, session.agent_group_id);

    log.info('Agent message routed', {
      from: session.agent_group_id,
      to: targetAgentGroupId,
      targetSession: targetSession.id,
      a2aMsgId,
      forwardedFileCount: countForwardedFiles(forwardedContent),
    });

    const fresh = getSession(targetSession.id);
    if (fresh) await wakeContainer(fresh);

    recordAgentSuccess(targetAgentGroupId);

    // Fan-out collection: when a child replies to the orchestrator, check if
    // this completes a waiting fan_out_task and inject a collect message if so.
    if (hasTable(getDb(), 'fan_out_tasks')) {
      let replyText = msg.content;
      try {
        const parsed = JSON.parse(msg.content) as Record<string, unknown>;
        if (typeof parsed.text === 'string') replyText = parsed.text;
      } catch {
        // non-JSON — use raw content as reply text
      }
      collectFanOutReply(session.agent_group_id, targetAgentGroupId, replyText, targetSession);
    }

    // Ephemeral task: when a one-shot task agent sends its reply back, record
    // the result so the sweep can tear down the task container and group.
    if (hasTable(getDb(), 'ephemeral_tasks')) {
      let ephemeralReplyText = msg.content;
      try {
        const ep = JSON.parse(msg.content) as Record<string, unknown>;
        if (typeof ep.text === 'string') ephemeralReplyText = ep.text;
      } catch {
        // non-JSON — use raw content
      }
      checkEphemeralTaskReply(session.agent_group_id, ephemeralReplyText);
    }
  } catch (err) {
    recordAgentError(targetAgentGroupId, (err as Error).message ?? String(err));
    if (hasTable(getDb(), 'dropped_a2a_messages')) {
      const dropId = `drop-${msg.id}`;
      const nextRetry = new Date(Date.now() + 30_000).toISOString();
      insertDroppedA2a({
        id: dropId,
        source_group_id: session.agent_group_id,
        target_group_id: targetAgentGroupId,
        msg_content: msg.content,
        error: (err as Error).message ?? String(err),
        next_retry_at: nextRetry,
        created_at: new Date().toISOString(),
      });
    }
    throw err;
  }
}

/**
 * Parse source content, copy any referenced `files` from source outbox to
 * target inbox, and return a JSON string with an `attachments` array added
 * (formatter.ts:223 already knows how to render this shape).
 *
 * If the source content isn't JSON or has no files, returns the original
 * content string unchanged — this is safe to call on every route.
 */
function forwardFileAttachments(
  msg: RoutableAgentMessage,
  a2aMsgId: string,
  sourceSession: Session,
  targetAgentGroupId: string,
  targetSessionId: string,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(msg.content);
  } catch {
    return msg.content;
  }
  const files = parsed.files as unknown;
  if (!Array.isArray(files) || files.length === 0) return msg.content;
  const filenames = files.filter((f): f is string => typeof f === 'string');
  if (filenames.length === 0) return msg.content;

  const attachments = forwardAttachedFiles(
    {
      agentGroupId: sourceSession.agent_group_id,
      sessionId: sourceSession.id,
      messageId: msg.id,
      filenames,
    },
    {
      agentGroupId: targetAgentGroupId,
      sessionId: targetSessionId,
      messageId: a2aMsgId,
    },
  );

  // Merge into any existing `attachments` (unlikely in a2a context but safe).
  const existing = Array.isArray(parsed.attachments) ? (parsed.attachments as Record<string, unknown>[]) : [];
  parsed.attachments = [...existing, ...attachments];

  return JSON.stringify(parsed);
}

/**
 * Upsert the a2a_context singleton row in the target session's inbound.db.
 * The container's MCP tools read this to include reply_to_session in outbound
 * messages without needing it threaded through every function call.
 *
 * Must open-write-close per the cross-mount invariant (see session-manager.ts).
 */
function upsertA2aContext(
  targetAgentGroupId: string,
  targetSessionId: string,
  replyToSession: string,
  parentAgentGroupId: string,
): void {
  const dbPath = inboundDbPath(targetAgentGroupId, targetSessionId);
  const db = openInboundDbWriter(dbPath);
  try {
    db.pragma('journal_mode = DELETE');
    db.exec(`CREATE TABLE IF NOT EXISTS a2a_context (
      id                     INTEGER PRIMARY KEY CHECK (id = 1),
      reply_to_session       TEXT,
      parent_agent_group_id  TEXT,
      updated_at             INTEGER NOT NULL
    )`);
    db.prepare(
      `INSERT INTO a2a_context (id, reply_to_session, parent_agent_group_id, updated_at)
       VALUES (1, ?, ?, unixepoch())
       ON CONFLICT(id) DO UPDATE SET
         reply_to_session      = excluded.reply_to_session,
         parent_agent_group_id = excluded.parent_agent_group_id,
         updated_at            = excluded.updated_at`,
    ).run(replyToSession, parentAgentGroupId);
  } finally {
    db.close();
  }
  log.debug('a2a_context upserted', { targetSessionId, replyToSession, parentAgentGroupId });
}

function countForwardedFiles(contentStr: string): number {
  try {
    const parsed = JSON.parse(contentStr);
    return Array.isArray(parsed.attachments) ? parsed.attachments.length : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Fan-out collection helpers
// ---------------------------------------------------------------------------

/**
 * Minimal JSON Schema validator — supports `type` (root) and `required` fields.
 * Returns an error string on validation failure, null on success or bad schema.
 */
function validateSchema(text: string, schemaStr: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return 'reply is not valid JSON';
  }
  let schema: { type?: string; required?: string[] };
  try {
    schema = JSON.parse(schemaStr) as typeof schema;
  } catch {
    return null; // unparseable schema — skip validation
  }
  if (schema.type === 'object' && (typeof data !== 'object' || data === null || Array.isArray(data))) {
    return 'expected an object';
  }
  if (schema.required && typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;
    for (const key of schema.required) {
      if (!(key in obj)) return `missing required field "${key}"`;
    }
  }
  return null;
}

/**
 * After routing a reply from sourceGroupId → orchestratorGroupId, check if
 * any waiting fan_out_task has sourceGroupId as a target. If yes, record the
 * reply. When all N targets have replied, inject a collect message.
 */
function collectFanOutReply(
  sourceGroupId: string,
  orchestratorGroupId: string,
  replyText: string,
  orchestratorSession: Session,
): void {
  try {
    expireOldFanOutTasks();
    const tasks = getActiveFanOutTasksForOrchestrator(orchestratorGroupId);
    for (const task of tasks) {
      const targets = JSON.parse(task.target_group_ids) as string[];
      if (!targets.includes(sourceGroupId)) continue;

      let finalReply = replyText;
      if (task.expected_schema) {
        const schemaError = validateSchema(replyText, task.expected_schema);
        if (schemaError) finalReply = `[Schema validation error: ${schemaError}]\n${replyText}`;
      }

      const { allReplied, replies } = recordFanOutReply(task.id, sourceGroupId, finalReply);
      if (!allReplied) {
        log.info('fan-out: reply recorded, waiting for more', {
          taskId: task.id,
          replied: Object.keys(replies).length,
          total: targets.length,
        });
        continue;
      }

      // All N replies collected — build and inject the collect message.
      const replyLines = targets
        .map((gid, i) => `**Agent ${i + 1} (${gid.slice(-8)}):**\n${replies[gid] ?? '(no reply)'}`)
        .join('\n\n');
      let collectMsg = `All ${targets.length} agents have replied:\n\n${replyLines}`;
      if (task.collect_prompt) collectMsg += `\n\n---\n${task.collect_prompt}`;

      writeSessionMessage(orchestratorSession.agent_group_id, orchestratorSession.id, {
        id: `fo-collect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: orchestratorSession.agent_group_id,
        channelType: 'agent',
        threadId: null,
        content: JSON.stringify({ text: collectMsg, sender: 'system', senderId: 'system' }),
      });
      const freshOrch = getSession(orchestratorSession.id);
      if (freshOrch) {
        wakeContainer(freshOrch).catch((err) =>
          log.error('fan-out: failed to wake orchestrator after collect', { err }),
        );
      }
      log.info('fan-out: all replies collected', { taskId: task.id, agents: targets.length });
    }
  } catch (err) {
    log.error('fan-out: collectFanOutReply threw unexpectedly', { err });
  }
}

// ---------------------------------------------------------------------------
// Ephemeral task reply helper
// ---------------------------------------------------------------------------

/**
 * When sourceGroupId is an active ephemeral task agent, record its reply so
 * the host sweep can tear down the container and group on the next tick.
 */
function checkEphemeralTaskReply(sourceGroupId: string, replyText: string): void {
  try {
    const task = getEphemeralTaskByAgentGroup(sourceGroupId);
    if (!task) return;
    markEphemeralTaskReplied(task.id, replyText);
    log.info('ephemeral-task: reply received, marked for cleanup', { taskId: task.id });
  } catch (err) {
    log.error('ephemeral-task: checkEphemeralTaskReply threw', { err });
  }
}
