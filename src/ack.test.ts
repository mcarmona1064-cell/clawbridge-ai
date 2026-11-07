import { afterEach, describe, expect, it, vi } from 'vitest';

const sent: Array<[string, string, string | null, string, string]> = [];
vi.mock('./log.js', () => ({ log: { debug: vi.fn() } }));
vi.mock('./delivery.js', () => ({
  getDeliveryAdapter: () => ({
    deliver: async (...args: [string, string, string | null, string, string]) => {
      sent.push(args);
      return undefined;
    },
  }),
}));

import { acknowledgeInbound, platformMessageId } from './ack.js';

describe('instant acknowledgement', () => {
  afterEach(() => {
    sent.length = 0;
    delete process.env.ACK_REACTION;
  });

  it('reacts with 👀 on the message the agent picked up', () => {
    acknowledgeInbound({ channelType: 'telegram', platformId: 'telegram:1', threadId: null, message: { id: 'tg-42' } });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0][4])).toEqual({ operation: 'reaction', messageId: '42', emoji: 'eyes' });
  });

  it('skips WhatsApp (typing and read receipts do the job) and respects ACK_REACTION=off', () => {
    acknowledgeInbound({
      channelType: 'whatsapp',
      platformId: 'whatsapp:1',
      threadId: null,
      message: { id: 'wamid.1' },
    });
    process.env.ACK_REACTION = 'off';
    acknowledgeInbound({ channelType: 'slack', platformId: 'slack:C1', threadId: '1.1', message: { id: '1.1' } });
    expect(sent).toHaveLength(0);
  });

  it('maps adapter ids back to platform ids', () => {
    expect(platformMessageId('telegram', 'tg-7')).toBe('7');
    expect(platformMessageId('slack', '171.22')).toBe('171.22');
  });
});
