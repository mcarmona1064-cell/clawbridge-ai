import crypto from 'crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, factories, env } = vi.hoisted(() => ({
  handlers: new Map<string, (req: Request) => Promise<Response>>(),
  factories: new Map<string, { factory: () => unknown }>(),
  env: {
    WHATSAPP_PHONE_NUMBER_ID: 'PHONE1',
    WHATSAPP_ACCESS_TOKEN: 'wa-token',
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'verify',
    WHATSAPP_APP_SECRET: 'wa-secret',
  } as Record<string, string>,
}));
vi.mock('../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../env.js', () => ({ readEnvFile: () => ({ ...env }) }));
vi.mock('../webhook-server.js', () => ({
  registerRawWebhookHandler: (name: string, h: (req: Request) => Promise<Response>) => handlers.set(name, h),
}));
vi.mock('./channel-registry.js', () => ({
  registerChannelAdapter: (type: string, reg: { factory: () => unknown }) => factories.set(type, reg),
}));
vi.mock('../transcription.js', () => ({ isAudioLike: () => false, transcribeAudio: vi.fn() }));

import { readAudit } from '../audit.js';
import { closeDb, getDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import type { ChannelAdapter, ChannelSetup } from './adapter.js';
import './whatsapp.js';
import { templatePayload, WhatsAppPolicyError } from './whatsapp.js';

const sends: Array<Record<string, unknown>> = [];
vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
  sends.push(JSON.parse(String(init?.body ?? '{}')));
  return new Response(JSON.stringify({ messages: [{ id: 'wamid.out' }] }), { status: 200 });
});

async function start(): Promise<{ adapter: ChannelAdapter; setup: { onInbound: ReturnType<typeof vi.fn> } }> {
  const adapter = factories.get('whatsapp')!.factory() as ChannelAdapter;
  const setup = { onInbound: vi.fn(), onAction: vi.fn(), onMetadata: vi.fn(), onInboundEvent: vi.fn() };
  await adapter.setup(setup as unknown as ChannelSetup);
  return { adapter, setup };
}

let n = 0;
async function inbound(text: string): Promise<void> {
  const body = JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: '15551', profile: { name: 'Ana' } }],
              messages: [
                { from: '15551', id: `wamid.${++n}`, timestamp: '1700000000', type: 'text', text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'wa-secret').update(body).digest('hex');
  await handlers.get('whatsapp')!(
    new Request('http://x/webhook/whatsapp', { method: 'POST', body, headers: { 'x-hub-signature-256': sig } }),
  );
  await new Promise((r) => setTimeout(r, 20));
}

const reply = { kind: 'chat', content: { text: 'Your invoice is ready.' } };

describe('whatsapp messaging rules', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    sends.length = 0;
    delete env.WHATSAPP_TEMPLATE_NAME;
  });
  afterEach(() => closeDb());

  it('STOP opts the person out: nothing reaches the agent or the person until START', async () => {
    const { adapter, setup } = await start();
    await inbound('STOP');
    expect(setup.onInbound).not.toHaveBeenCalled();
    expect(String((sends.at(-1)?.text as { body: string }).body)).toMatch(/unsubscribed/);

    await expect(adapter.deliver('whatsapp:15551', null, reply)).rejects.toBeInstanceOf(WhatsAppPolicyError);
    await inbound('what about my order?');
    expect(setup.onInbound).not.toHaveBeenCalled();

    await inbound('Start');
    await inbound('what about my order?');
    expect(setup.onInbound).toHaveBeenCalledTimes(1);
    await expect(adapter.deliver('whatsapp:15551', null, reply)).resolves.toBe('wamid.out');
    expect(readAudit().map((r) => r.action)).toEqual(
      expect.arrayContaining(['contact.opted_out', 'message.blocked', 'contact.opted_in']),
    );
  });

  it('allows free-form replies inside the 24-hour window', async () => {
    const { adapter } = await start();
    await inbound('hi');
    await adapter.deliver('whatsapp:15551', null, reply);
    expect(sends.at(-1)).toMatchObject({ type: 'text' });
  });

  it('refuses free-form sends outside the window, or uses the configured template', async () => {
    const { adapter } = await start();
    await inbound('hi');
    getDb().prepare("UPDATE contact_state SET last_inbound_at = '2020-01-01T00:00:00.000Z'").run();
    await expect(adapter.deliver('whatsapp:15551', null, reply)).rejects.toThrow(/24-hour reply window/);

    env.WHATSAPP_TEMPLATE_NAME = 'clawbridge_update';
    const { adapter: withTemplate } = await start();
    await withTemplate.deliver('whatsapp:15551', null, reply);
    expect(sends.at(-1)).toMatchObject({
      type: 'template',
      template: { name: 'clawbridge_update', components: [{ parameters: [{ text: 'Your invoice is ready.' }] }] },
    });
  });

  it('flattens template variables (no newlines, capped length)', () => {
    const p = templatePayload('t', 'en_US', `**Report**\n\nline one\n\tline two ${'x'.repeat(2000)}`) as {
      template: { components: Array<{ parameters: Array<{ text: string }> }> };
    };
    const text = p.template.components[0].parameters[0].text;
    expect(text).not.toMatch(/\n|\t| {2,}/);
    expect(text.length).toBeLessThanOrEqual(900);
    expect(text.startsWith('*Report* line one line two')).toBe(true);
  });
});
