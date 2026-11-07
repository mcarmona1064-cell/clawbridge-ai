/**
 * Admin alerts (startup errors, health problems, sweeps).
 *
 * Alerts go only to the people who run this install: every owner and
 * global admin, once each, to the chat they chose with /notify-here or
 * else their DM on any linked account. They never go to group chats or to
 * the customers an agent talks to. If no admin is reachable yet (early
 * startup), the direct Telegram fallback is used when it is configured.
 */
import { log } from '../log.js';
import { readEnvFile } from '../env.js';

/** Alerts are written with Telegram-style <b> tags; turn them into Markdown for every channel. */
export function alertMarkdown(text: string): string {
  return text
    .replace(/<b>([\s\S]*?)<\/b>/g, '**$1**')
    .replace(/<i>([\s\S]*?)<\/i>/g, '_$1_')
    .replace(/<code>([\s\S]*?)<\/code>/g, '`$1`')
    .replace(/<[^>]+>/g, '');
}

export async function sendAdminAlert(text: string): Promise<void> {
  try {
    const { getDeliveryAdapter } = await import('../delivery.js');
    const { pickApprover, pickApprovalDelivery } = await import('../modules/approvals/primitive.js');
    const { primaryUserId } = await import('../db/user-links.js');
    const adapter = getDeliveryAdapter();
    let delivered = 0;
    if (adapter) {
      const people = new Set<string>();
      for (const userId of pickApprover(null)) {
        const person = primaryUserId(userId);
        if (people.has(person)) continue;
        people.add(person);
        const target = await pickApprovalDelivery([userId], '');
        if (!target) continue;
        try {
          await adapter.deliver(
            target.messagingGroup.channel_type,
            target.messagingGroup.platform_id,
            null,
            'chat',
            JSON.stringify({ text: alertMarkdown(text) }),
          );
          delivered++;
        } catch (err) {
          log.warn('Admin alert delivery failed', { userId: target.userId, err });
        }
      }
    }
    if (delivered === 0) await telegramFallback(text);
  } catch (err) {
    log.warn('Admin alert failed', { err });
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
