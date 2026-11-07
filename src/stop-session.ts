/**
 * Stop the agent turn running for one chat, when a person asks the platform
 * to stop (Slack's stop button, a "!stop" message). Anyone in the chat may
 * stop the agent that is answering them; stopping never deletes anything.
 */
import { audit } from './audit.js';
import { isContainerRunning, killContainer } from './container-runner.js';
import { getMessagingGroupByPlatform } from './db/messaging-groups.js';
import { findSession } from './db/sessions.js';
import { log } from './log.js';

export async function stopChatSession(
  channelType: string,
  platformId: string,
  threadId: string | null,
  userId: string,
): Promise<boolean> {
  const mg = getMessagingGroupByPlatform(channelType, platformId);
  if (!mg) return false;
  const session = (threadId ? findSession(mg.id, threadId) : undefined) ?? findSession(mg.id, null);
  if (!session || !isContainerRunning(session.id)) return false;
  killContainer(session.id, `stopped by ${channelType}:${userId} from the chat`);
  audit('session.stopped', {
    actor: userId.includes(':') ? userId : `${channelType}:${userId}`,
    target: session.id,
    agentGroupId: session.agent_group_id,
    channelType,
  });
  log.info('Session stopped from chat', { sessionId: session.id, channelType, userId });
  return true;
}
