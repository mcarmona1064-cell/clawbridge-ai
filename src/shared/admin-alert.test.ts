import { describe, expect, it, vi } from 'vitest';

const sent: Array<{ channelType: string; platformId: string; content: string }> = [];
vi.mock('../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }));
vi.mock('../delivery.js', () => ({
  getDeliveryAdapter: () => ({
    deliver: async (channelType: string, platformId: string, _t: unknown, _k: unknown, content: string) => {
      sent.push({ channelType, platformId, content });
      return 'x';
    },
  }),
}));
vi.mock('../db/user-links.js', () => ({ primaryUserId: (id: string) => (id === 'whatsapp:1' ? 'slack:U1' : id) }));
vi.mock('../modules/approvals/primitive.js', () => ({
  pickApprover: () => ['slack:U1', 'whatsapp:1', 'telegram:7'],
  pickApprovalDelivery: async ([id]: string[]) => ({
    userId: id,
    messagingGroup: { channel_type: id.split(':')[0], platform_id: `${id}-dm` },
  }),
}));

import { alertMarkdown, sendAdminAlert } from './admin-alert.js';

describe('admin alerts', () => {
  it("go once to each owner/admin's DM, never to every chat", async () => {
    await sendAdminAlert('⚠️ <b>ClawBridge startup error</b>\n\nDocker is not running');
    // slack:U1 and whatsapp:1 are the same person: one alert.
    expect(sent.map((s) => s.platformId)).toEqual(['slack:U1-dm', 'telegram:7-dm']);
    expect(JSON.parse(sent[0].content).text).toBe('⚠️ **ClawBridge startup error**\n\nDocker is not running');
  });

  it('converts Telegram-style tags to Markdown', () => {
    expect(alertMarkdown('<b>x</b> <code>y</code> <a href="z">w</a>')).toBe('**x** `y` w');
  });
});
