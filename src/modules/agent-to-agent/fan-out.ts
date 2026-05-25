/**
 * fan_out delivery-action handler.
 *
 * Called by the host delivery pipeline when the container emits a system
 * action `action: 'fan_out'`. Sends the same prompt to N target agents in
 * parallel and creates a fan_out_tasks tracking row so replies can be
 * collected and forwarded back to the orchestrator.
 *
 * Reply collection and fan-out completion are handled in agent-route.ts
 * (tryRecordFanOutReply) to avoid a circular import.
 */
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { createFanOutTask } from '../../db/fan-out-tasks.js';
import { getDestinationByName } from './db/agent-destinations.js';

function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after fan-out notify', { err }));
  }
}

export async function handleFanOut(content: Record<string, unknown>, session: Session): Promise<void> {
  const agents = content.agents as unknown;
  const prompt = content.prompt as unknown;
  const collectPrompt = typeof content.collect_prompt === 'string' ? content.collect_prompt : null;
  const expectedSchema =
    content.expected_schema != null
      ? typeof content.expected_schema === 'string'
        ? content.expected_schema
        : JSON.stringify(content.expected_schema)
      : null;

  if (!Array.isArray(agents) || agents.length === 0) {
    notifyAgent(session, 'fan_out failed: agents must be a non-empty array of destination names.');
    return;
  }
  if (typeof prompt !== 'string' || !prompt) {
    notifyAgent(session, 'fan_out failed: prompt is required.');
    return;
  }

  // Resolve each agent name to a target group ID
  const targetGroupIds: string[] = [];
  for (const agentName of agents) {
    if (typeof agentName !== 'string') {
      notifyAgent(session, `fan_out failed: agent name must be a string, got ${typeof agentName}.`);
      return;
    }
    const dest = getDestinationByName(session.agent_group_id, agentName);
    if (!dest || dest.target_type !== 'agent') {
      notifyAgent(session, `fan_out failed: "${agentName}" is not a known agent destination.`);
      return;
    }
    targetGroupIds.push(dest.target_id);
  }

  const now = new Date();
  const taskId = `fo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();

  createFanOutTask({
    id: taskId,
    orchestrator_group_id: session.agent_group_id,
    orchestrator_session_id: session.id,
    target_group_ids: JSON.stringify(targetGroupIds),
    collect_prompt: collectPrompt,
    expected_schema: expectedSchema,
    created_at: now.toISOString(),
    expires_at: expiresAt,
  });

  // Route the prompt to each target agent via dynamic import to avoid circular dep
  const { routeAgentMessage } = await import('./agent-route.js');
  const fanOutMsgBase = `fo-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  for (const targetGroupId of targetGroupIds) {
    const msgId = `${fanOutMsgBase}-${targetGroupId.slice(-6)}`;
    try {
      await routeAgentMessage(
        {
          id: msgId,
          platform_id: targetGroupId,
          content: JSON.stringify({ text: prompt, fan_out_id: taskId }),
        },
        session,
      );
    } catch (err) {
      log.warn('fan_out: failed to route to one target, continuing', {
        targetGroupId,
        err: (err as Error).message,
      });
    }
  }

  notifyAgent(
    session,
    `Fan-out task started (${targetGroupIds.length} agent${targetGroupIds.length === 1 ? '' : 's'}). ` +
      `You will receive a collect message when all have replied.`,
  );
  log.info('Fan-out task created', { taskId, agentCount: targetGroupIds.length, orchestrator: session.agent_group_id });
}
