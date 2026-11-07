import { describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./env.js', () => ({ readEnvFile: () => ({}), setEnvValues: vi.fn() }));
vi.mock('./webhook-server.js', () => ({ registerRawWebhookHandler: vi.fn() }));
vi.mock('./channels/channel-registry.js', () => ({ registerChannelAdapter: vi.fn() }));

import { ensureTemplate, templateDefinition, TEMPLATE_NAME } from './whatsapp-template.js';

const env = { WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_BUSINESS_ACCOUNT_ID: '123' };

describe('WhatsApp template helper', () => {
  it('submits a one-variable utility template when none exists', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(init?.method === 'POST' ? { id: 'tpl', status: 'PENDING' } : { data: [] }));
    };
    expect(await ensureTemplate(env, fetchImpl)).toEqual({ status: 'PENDING', created: true });
    const sent = JSON.parse(String(calls[1].init?.body));
    expect(sent).toMatchObject({ name: TEMPLATE_NAME, category: 'UTILITY' });
    expect(sent.components[0].text).toContain('{{1}}');
    expect(templateDefinition('es_MX').language).toBe('es_MX');
  });

  it('reports an existing template instead of creating another', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ data: [{ name: TEMPLATE_NAME, status: 'APPROVED' }] }));
    expect(await ensureTemplate(env, fetchImpl)).toEqual({ status: 'APPROVED', created: false });
  });

  it('explains what is missing', async () => {
    expect(await ensureTemplate({}, fetch)).toMatchObject({
      error: expect.stringContaining('WHATSAPP_BUSINESS_ACCOUNT_ID'),
    });
  });
});
