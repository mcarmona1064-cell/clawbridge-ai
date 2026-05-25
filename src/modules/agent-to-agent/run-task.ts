/**
 * `run_task` delivery-action handler.
 *
 * Spawns an ephemeral one-shot agent group, routes a task prompt to it, and
 * records the task in `ephemeral_tasks` so the host sweep can clean it up
 * once it replies or times out. No persistent footprint — group, session,
 * and filesystem are all removed by the sweep after completion.
 */
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';
import { createDestination } from './db/agent-destinations.js';
import { createEphemeralTask } from '../../db/ephemeral-tasks.js';

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
    wakeContainer(fresh).catch((err) => log.error('run_task: failed to wake caller after notify', { err }));
  }
}

export async function handleRunTask(content: Record<string, unknown>, session: Session): Promise<void> {
  const prompt = content.prompt as unknown;
  const role = typeof content.role === 'string' ? content.role : null;
  const timeoutMinutes = Math.min(
    Math.max(typeof content.timeout_minutes === 'number' ? content.timeout_minutes : 10, 1),
    60,
  );

  if (typeof prompt !== 'string' || !prompt) {
    notifyAgent(session, 'run_task failed: prompt is required.');
    return;
  }

  const shortId = Math.random().toString(36).slice(2, 10);
  let folder = `ephemeral-${shortId}`;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) {
    folder = `ephemeral-${shortId}-${suffix}`;
    suffix++;
  }

  const resolvedPath = path.resolve(GROUPS_DIR, folder);
  if (!resolvedPath.startsWith(path.resolve(GROUPS_DIR) + path.sep)) {
    notifyAgent(session, 'run_task failed: invalid folder path.');
    return;
  }

  const agentGroupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const taskId = `etask-${Date.now()}-${shortId}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + timeoutMinutes * 60 * 1000).toISOString();

  const roleSection = role ? `${role}\n\n---\n\n` : '';
  const instructions =
    `${roleSection}` +
    `## IMPORTANT: You are a one-time task agent.\n\n` +
    `Your only job is to complete the assigned task and send your result to your creator ` +
    `using \`<message to="parent">...</message>\`.\n\n` +
    `- Send ONE focused reply with your complete result.\n` +
    `- Do not ask follow-up questions — work with the information given.\n` +
    `- After sending your result, your work is done. This container will be cleaned up automatically.\n`;

  const newGroup: AgentGroup = {
    id: agentGroupId,
    name: `task-${shortId}`,
    folder,
    description: 'Ephemeral one-time task agent',
    agent_provider: null,
    created_at: now.toISOString(),
  };

  createAgentGroup(newGroup);
  initGroupFilesystem(newGroup, { instructions });

  const callerDestName = `task-${shortId.slice(0, 8)}`;
  createDestination({
    agent_group_id: session.agent_group_id,
    local_name: callerDestName,
    target_type: 'agent',
    target_id: agentGroupId,
    created_at: now.toISOString(),
  });
  createDestination({
    agent_group_id: agentGroupId,
    local_name: 'parent',
    target_type: 'agent',
    target_id: session.agent_group_id,
    created_at: now.toISOString(),
  });

  createEphemeralTask({
    id: taskId,
    caller_group_id: session.agent_group_id,
    caller_session_id: session.id,
    task_agent_group_id: agentGroupId,
    task_agent_folder: folder,
    created_at: now.toISOString(),
    expires_at: expiresAt,
  });

  const { routeAgentMessage } = await import('./agent-route.js');
  try {
    await routeAgentMessage(
      {
        id: `rtask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        platform_id: agentGroupId,
        content: JSON.stringify({ text: prompt, task_id: taskId }),
      },
      session,
    );
  } catch (err) {
    log.warn('run_task: initial routing failed', { taskId, err: (err as Error).message });
    notifyAgent(session, `Task created but initial routing failed — will retry automatically.`);
    return;
  }

  notifyAgent(
    session,
    `Task agent started (id: ${taskId.slice(-8)}, timeout: ${timeoutMinutes}min). It will reply when done.`,
  );
  log.info('Ephemeral task created', { taskId, agentGroupId, folder, caller: session.agent_group_id });
}
