/**
 * Instant acknowledgement: the moment an agent picks up a message, the
 * person sees a 👀 reaction on it (Slack, Telegram, Discord). WhatsApp gets
 * a read receipt and "typing…" from the typing indicator instead, because
 * reactions there look odd to customers. ACK_REACTION=off turns it off.
 */
import { getDeliveryAdapter } from './delivery.js';
import { log } from './log.js';

const REACTION_CHANNELS = new Set(['slack', 'telegram', 'discord']);

/** The platform's own message id, from the id the adapter put on the inbound. */
export function platformMessageId(channelType: string, inboundId: string): string | null {
  if (!inboundId) return null;
  if (channelType === 'telegram') return inboundId.replace(/^tg-/, '');
  return inboundId;
}

export function acknowledgeInbound(event: {
  channelType: string;
  platformId: string;
  threadId: string | null;
  message: { id: string };
}): void {
  if (process.env.ACK_REACTION === 'off' || !REACTION_CHANNELS.has(event.channelType)) return;
  const messageId = platformMessageId(event.channelType, event.message.id);
  const adapter = getDeliveryAdapter();
  if (!messageId || !adapter) return;
  void adapter
    .deliver(
      event.channelType,
      event.platformId,
      event.threadId,
      'chat',
      JSON.stringify({ operation: 'reaction', messageId, emoji: 'eyes' }),
    )
    .catch((err) => log.debug('Acknowledgement reaction failed', { channelType: event.channelType, err }));
}
