import { describe, expect, it } from 'vitest';

import { callbackUrls, parseTunnelUrl } from './tunnel.js';

describe('tunnel helper', () => {
  it("finds the quick-tunnel URL in cloudflared's log", () => {
    const log = '2026-11-06T10:00:00Z INF |  https://brave-otter-12ab.trycloudflare.com                    |';
    expect(parseTunnelUrl(log)).toBe('https://brave-otter-12ab.trycloudflare.com');
    expect(parseTunnelUrl('INF Starting tunnel')).toBeNull();
  });

  it('prints the callback URL for each webhook channel', () => {
    expect(callbackUrls('https://x.trycloudflare.com')).toEqual({
      WhatsApp: 'https://x.trycloudflare.com/webhook/whatsapp',
      'Slack (webhook mode)': 'https://x.trycloudflare.com/webhook/slack',
    });
  });
});
