/**
 * Chat controls anyone can type on any channel, handled by the host before
 * the message reaches the agent (so they work while the agent is busy):
 *
 *   !stop             stop what the agent is doing in this chat
 *   !mute [hours]     keep the agent quiet in this chat (default 8 h; groups: admins only)
 *   !unmute           let it talk again
 *
 * Bare words without the "!" are ordinary messages. Muting never drops
 * approvals or numbered answers to cards; those are handled earlier.
 */
import { audit } from './audit.js';
import { getDb, hasTable } from './db/connection.js';
import { getMessagingGroupByPlatform } from './db/messaging-groups.js';
import { log } from './log.js';
import { stopChatSession } from './stop-session.js';

export interface ControlInput {
  channelType: string;
  platformId: string;
  threadId: string | null;
  text: string;
  senderId: string | null;
  isGroup: boolean;
}

const CONTROL = /^!(stop|mute|unmute|fast|deep|normal)\b\s*(.*)$/i;
const DEFAULT_MUTE_HOURS = 8;

export function isChatControl(text: string): boolean {
  return CONTROL.test(text.trim());
}

function ready(): boolean {
  try {
    return hasTable(getDb(), 'chat_mutes');
  } catch {
    return false;
  }
}

export function mutedUntil(channelType: string, platformId: string, now = Date.now()): Date | null {
  if (!ready()) return null;
  const row = getDb()
    .prepare('SELECT until FROM chat_mutes WHERE channel_type = ? AND platform_id = ?')
    .get(channelType, platformId) as { until: string } | undefined;
  if (!row) return null;
  const until = new Date(row.until);
  if (until.getTime() <= now) {
    getDb().prepare('DELETE FROM chat_mutes WHERE channel_type = ? AND platform_id = ?').run(channelType, platformId);
    return null;
  }
  return until;
}

function canManageGroup(senderId: string | null, channelType: string, platformId: string): Promise<boolean> {
  return (async () => {
    if (!senderId) return false;
    const { hasAdminPrivilege, isOwner, isGlobalAdmin } = await import('./modules/permissions/db/user-roles.js');
    if (isOwner(senderId) || isGlobalAdmin(senderId)) return true;
    const mg = getMessagingGroupByPlatform(channelType, platformId);
    if (!mg) return false;
    const agents = getDb()
      .prepare('SELECT agent_group_id FROM messaging_group_agents WHERE messaging_group_id = ?')
      .all(mg.id) as Array<{ agent_group_id: string }>;
    return agents.some((a) => hasAdminPrivilege(senderId, a.agent_group_id));
  })();
}

function humanUntil(d: Date): string {
  const hours = Math.round((d.getTime() - Date.now()) / 3_600_000);
  return hours <= 1 ? 'for the next hour' : `for the next ${hours} hours`;
}

/** Handle a chat control. Returns the reply to post, or null if the text isn't one. */
export async function handleChatControl(input: ControlInput): Promise<string | null> {
  const m = CONTROL.exec(input.text.trim());
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const arg = m[2].trim();

  if (cmd === 'fast' || cmd === 'deep' || cmd === 'normal') {
    const preset = cmd === 'fast' ? 'fast' : cmd === 'deep' ? 'best' : 'balanced';
    return applyPresetToChat(input, preset);
  }

  if (cmd === 'stop') {
    const stopped = await stopChatSession(
      input.channelType,
      input.platformId,
      input.threadId,
      input.senderId ?? 'unknown',
    );
    return stopped ? 'Stopped. Tell me what to do next.' : "I wasn't working on anything here.";
  }

  if (!ready()) return 'Muting needs a restart to apply the latest update.';
  if (input.isGroup && !(await canManageGroup(input.senderId, input.channelType, input.platformId))) {
    return 'Only an admin can mute me in a group. You can still ask me to stop with !stop.';
  }

  if (cmd === 'unmute') {
    getDb()
      .prepare('DELETE FROM chat_mutes WHERE channel_type = ? AND platform_id = ?')
      .run(input.channelType, input.platformId);
    audit('chat.unmuted', { actor: input.senderId, target: input.platformId, channelType: input.channelType });
    return "I'm back. Mention me or message me any time.";
  }

  const hours = arg ? Number(arg.replace(/h(ours?)?$/i, '')) : DEFAULT_MUTE_HOURS;
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) return 'Use !mute, or !mute <hours> (up to 720).';
  const until = new Date(Date.now() + hours * 3_600_000);
  getDb()
    .prepare(
      `INSERT INTO chat_mutes (channel_type, platform_id, until, muted_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(channel_type, platform_id) DO UPDATE SET until = excluded.until, muted_by = excluded.muted_by`,
    )
    .run(input.channelType, input.platformId, until.toISOString(), input.senderId);
  audit('chat.muted', {
    actor: input.senderId,
    target: input.platformId,
    channelType: input.channelType,
    detail: { hours },
  });
  log.info('Chat muted', { channelType: input.channelType, platformId: input.platformId, hours });
  return `Okay, I'll stay quiet here ${humanUntil(until)}. Send !unmute to bring me back.`;
}

/** Switch the model preset for the conversation in this chat; takes effect on the next message. */
async function applyPresetToChat(input: ControlInput, preset: 'fast' | 'balanced' | 'best'): Promise<string> {
  const mg = getMessagingGroupByPlatform(input.channelType, input.platformId);
  const { findSession } = await import('./db/sessions.js');
  const session = mg
    ? ((input.threadId ? findSession(mg.id, input.threadId) : undefined) ?? findSession(mg.id, null))
    : undefined;
  if (!session) return 'Send me a message first, then pick how I should think.';
  const { PRESET_TEXT, setSessionPreset } = await import('./model-presets.js');
  setSessionPreset(session.id, preset);
  const { isContainerRunning, killContainer } = await import('./container-runner.js');
  if (isContainerRunning(session.id)) killContainer(session.id, `model preset changed to ${preset}`);
  audit('model.preset', {
    actor: input.senderId,
    target: session.id,
    channelType: input.channelType,
    detail: { preset },
  });
  return `${PRESET_TEXT[preset]}. I'll use it from your next message.`;
}
