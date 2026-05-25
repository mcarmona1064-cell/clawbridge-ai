/**
 * Platform-agnostic admin alert.
 *
 * Delivers to all active messaging platforms via their channel adapters.
 * Falls back to direct Telegram API when adapters are not yet initialized
 * (e.g. early startup, before initChannelAdapters completes).
 */
import { getActiveAdapters } from '../channels/channel-registry.js';
import { getAllMessagingGroups } from '../db/messaging-groups.js';
import { log } from '../log.js';
import { readEnvFile } from '../env.js';

export async function sendAdminAlert(text: string): Promise<void> {
  try {
    const adapters = getActiveAdapters();
    if (adapters.length > 0) {
      const groups = getAllMessagingGroups();
      const adapterMap = new Map(adapters.map((a) => [a.channelType, a]));
      const sent = new Set<string>();
      for (const mg of groups) {
        const adapter = adapterMap.get(mg.channel_type);
        if (!adapter || !adapter.isConnected()) continue;
        const key = mg.channel_type + ':' + mg.platform_id;
        if (sent.has(key)) continue;
        sent.add(key);
        try {
          await adapter.deliver(mg.platform_id, null, { kind: 'chat', content: { text } });
        } catch (err) {
          log.warn('Admin alert delivery failed', { channelType: mg.channel_type, platformId: mg.platform_id, err });
        }
      }
      return;
    }
    // Fallback: direct Telegram API when adapters not yet active
    await telegramFallback(text);
  } catch {
    /* non-critical */
  }
}

async function telegramFallback(text: string): Promise<void> {
  const env = readEnvFile(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALERT_CHAT_ID', 'TELEGRAM_CHAT_ID']);
  const token = env['TELEGRAM_BOT_TOKEN'];
  const chatId = env['TELEGRAM_ALERT_CHAT_ID'] || env['TELEGRAM_CHAT_ID'];
  if (!token || !chatId) return;
  await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}
