/**
 * Adapter contract suite.
 *
 * Every first-class channel adapter runs the same checks against a fake of
 * its platform: who sent a message, DM vs group, mention handling, retries
 * and duplicates, question cards and clicks, long-text splitting, edits,
 * files, voice notes, errors that throw instead of being marked delivered,
 * and rate-limit backoff. A channel that can't do something by nature (e.g.
 * WhatsApp Cloud API has no groups) says so in its harness, and the check
 * is skipped with that reason, never silently passed.
 */
import crypto from 'crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, factories, renderMock } = vi.hoisted(() => ({
  handlers: new Map<string, (req: Request) => Promise<Response>>(),
  factories: new Map<string, { factory: () => unknown }>(),
  renderMock: vi.fn(),
}));

vi.mock('../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_SIGNING_SECRET: 'slack-secret',
    TELEGRAM_BOT_TOKEN: 'tg-token',
    WHATSAPP_PHONE_NUMBER_ID: 'PHONE1',
    WHATSAPP_ACCESS_TOKEN: 'wa-token',
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'verify',
    WHATSAPP_APP_SECRET: 'wa-secret',
  }),
}));
vi.mock('../webhook-server.js', () => ({
  registerRawWebhookHandler: (name: string, h: (req: Request) => Promise<Response>) => handlers.set(name, h),
}));
vi.mock('./channel-registry.js', () => ({
  registerChannelAdapter: (type: string, reg: { factory: () => unknown }) => factories.set(type, reg),
}));
vi.mock('../db/sessions.js', () => ({ getAskQuestionRender: renderMock }));
vi.mock('./channel-layer.js', () => ({ recordNumberedPrompt: vi.fn() }));
vi.mock('./telegram-pairing.js', () => ({ interceptPairingMessage: () => false }));
vi.mock('../transcription.js', () => ({
  isAudioLike: (mime: string) => mime.startsWith('audio/'),
  transcribeAudio: vi.fn(async () => 'hello from a voice note'),
}));

import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { capabilitiesFor } from './capabilities.js';
import { createDiscordAdapter, type DiscordClientLike } from './discord.js';
import './slack.js';
import './telegram.js';
import './whatsapp.js';

// ── Shared fixtures ──

interface Call {
  api: string;
  body: Record<string, unknown>;
}

interface Harness {
  channelType: string;
  adapter: ChannelAdapter;
  setup: {
    onInbound: ReturnType<typeof vi.fn>;
    onAction: ReturnType<typeof vi.fn>;
    onMetadata: ReturnType<typeof vi.fn>;
  };
  dmPlatformId: string;
  calls: Call[];
  dm(id: string, text: string): Promise<void>;
  /** Re-deliver the last inbound exactly as the platform would on a retry. Null = platform never redelivers. */
  redeliver: (() => Promise<void>) | null;
  /** Send a group message; null = channel has no groups. */
  group: ((id: string, text: string, mention: boolean) => Promise<void>) | null;
  voice(id: string): Promise<void>;
  click(questionId: string, idx: number, userId: string): Promise<void>;
  unsigned: (() => Promise<Response>) | null;
  isSend(c: Call): boolean;
  textOf(c: Call): string;
  choiceIdsOf(c: Call): string[];
  isEdit(c: Call): boolean;
  isFileSend(c: Call): boolean;
  failNextSend(): void;
  /** Make the next send hit a rate limit; null = the client library handles it internally. */
  rateLimitNextSend: (() => void) | null;
  teardown(): Promise<void>;
}

let route: (url: string, init?: RequestInit) => Promise<Response> = async () =>
  new Response('no route', { status: 500 });
vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) => route(String(url), init));

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

async function until(cond: () => boolean, ms = 1500): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

function mockSetup() {
  return { onInbound: vi.fn(), onAction: vi.fn(), onMetadata: vi.fn(), onInboundEvent: vi.fn() };
}

function bodyOf(init?: RequestInit): Record<string, unknown> {
  if (!init?.body || typeof init.body !== 'string') return {};
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ── Slack ──

async function slackHarness(): Promise<Harness> {
  const calls: Call[] = [];
  let failNext = false;
  let limitNext = false;
  route = async (url, init) => {
    if (url.startsWith('https://files.slack.com/')) return new Response(new Uint8Array([1, 2, 3]));
    if (url.startsWith('https://upload.slack.test/')) return new Response('ok');
    const api = url.replace('https://slack.com/api/', '');
    const body = bodyOf(init);
    calls.push({ api, body });
    if (api === 'chat.postMessage' && limitNext) {
      limitNext = false;
      return json({ ok: false, error: 'ratelimited' }, 429, { 'retry-after': '1' });
    }
    if (api === 'chat.postMessage' && failNext) {
      failNext = false;
      return json({ ok: false, error: 'channel_not_found' });
    }
    if (api === 'auth.test') return json({ ok: true, user_id: 'UBOT' });
    if (api === 'users.info') return json({ ok: true, user: { profile: { display_name: 'Ana' } } });
    if (api === 'files.getUploadURLExternal')
      return json({ ok: true, upload_url: 'https://upload.slack.test/1', file_id: 'F9' });
    return json({ ok: true, ts: `${calls.length}.0` });
  };
  const adapter = factories.get('slack')!.factory() as ChannelAdapter;
  const setup = mockSetup();
  await adapter.setup(setup as unknown as ChannelSetup);
  const sign = (body: string) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = 'v0=' + crypto.createHmac('sha256', 'slack-secret').update(`v0:${ts}:${body}`).digest('hex');
    return new Request('http://localhost/webhook/slack', {
      method: 'POST',
      body,
      headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig },
    });
  };
  let last = '';
  const post = async (event: Record<string, unknown>, eventId: string) => {
    last = JSON.stringify({ type: 'event_callback', event_id: eventId, event });
    await handlers.get('slack')!(sign(last));
  };
  return {
    channelType: 'slack',
    adapter,
    setup,
    dmPlatformId: 'slack:D1',
    calls,
    dm: (id, text) =>
      post({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', ts: `${id}.1`, text }, `E${id}`),
    redeliver: async () => void (await handlers.get('slack')!(sign(last))),
    group: (id, text, mention) =>
      post(
        {
          type: 'message',
          channel_type: 'channel',
          channel: 'C1',
          user: 'U1',
          ts: `${id}.1`,
          text: mention ? `<@UBOT> ${text}` : text,
        },
        `E${id}`,
      ),
    voice: (id) =>
      post(
        {
          type: 'message',
          subtype: 'file_share',
          channel_type: 'im',
          channel: 'D1',
          user: 'U1',
          ts: `${id}.1`,
          text: '',
          files: [
            {
              id: 'F1',
              name: 'note.m4a',
              mimetype: 'audio/mp4',
              size: 3,
              url_private_download: 'https://files.slack.com/F1',
            },
          ],
        },
        `E${id}`,
      ),
    click: async (qid, idx, user) => {
      const payload = {
        type: 'block_actions',
        user: { id: user },
        actions: [{ action_id: `ncq:${qid}:${idx}`, value: String(idx) }],
      };
      await handlers.get('slack')!(sign(`payload=${encodeURIComponent(JSON.stringify(payload))}`));
    },
    unsigned: () =>
      handlers.get('slack')!(new Request('http://localhost/webhook/slack', { method: 'POST', body: '{}' })),
    isSend: (c) => c.api === 'chat.postMessage',
    textOf: (c) => {
      const blocks = (c.body.blocks as Array<{ text?: string | { text: string } }> | undefined) ?? [];
      const texts = blocks.map((b) => (typeof b.text === 'string' ? b.text : (b.text?.text ?? ''))).filter(Boolean);
      return texts.length ? texts.join('\n') : String(c.body.text ?? '');
    },
    choiceIdsOf: (c) =>
      ((c.body.blocks as Array<{ type: string; elements?: Array<{ action_id: string }> }>) ?? [])
        .filter((b) => b.type === 'actions')
        .flatMap((b) => b.elements!.map((e) => e.action_id)),
    isEdit: (c) => c.api === 'chat.update',
    isFileSend: (c) => c.api === 'files.completeUploadExternal',
    failNextSend: () => void (failNext = true),
    rateLimitNextSend: () => void (limitNext = true),
    teardown: () => adapter.teardown(),
  };
}

// ── Telegram ──

async function telegramHarness(): Promise<Harness> {
  const calls: Call[] = [];
  const queue: unknown[] = [];
  let failNext = false;
  let limitNext = false;
  let nextMsgId = 100;
  route = async (url, init) => {
    if (url.startsWith('https://api.telegram.org/file/')) return new Response(new Uint8Array([1, 2, 3]));
    const u = new URL(url);
    const api = u.pathname.split('/').pop()!;
    if (api === 'getUpdates') {
      const start = Date.now();
      while (queue.length === 0 && Date.now() - start < 20) await new Promise((r) => setTimeout(r, 2));
      return json({ ok: true, result: queue.splice(0) });
    }
    const body = init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : bodyOf(init);
    calls.push({ api, body: body as Record<string, unknown> });
    const isSend = api.startsWith('send') && api !== 'sendChatAction';
    if (isSend && limitNext) {
      limitNext = false;
      return json({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 1 } }, 429);
    }
    if (isSend && failNext) {
      failNext = false;
      return json({ ok: false, description: 'Bad Request: chat not found' }, 400);
    }
    if (api === 'getMe') return json({ ok: true, result: { id: 999, username: 'cb_bot', is_bot: true } });
    if (api === 'getFile')
      return json({ ok: true, result: { file_id: 'v1', file_unique_id: 'v1', file_path: 'voice/file_1.oga' } });
    return json({ ok: true, result: isSend ? { message_id: nextMsgId++ } : true });
  };
  const adapter = factories.get('telegram')!.factory() as ChannelAdapter;
  const setup = mockSetup();
  await adapter.setup(setup as unknown as ChannelSetup);
  let updateId = 1;
  let last: unknown = null;
  const push = async (update: Record<string, unknown>): Promise<void> => {
    last = { update_id: updateId++, ...update };
    queue.push(last);
    await settle(60);
  };
  const msg = (id: string, chat: Record<string, unknown>, text: string, extra: Record<string, unknown> = {}) => ({
    message: { message_id: Number(id), from: { id: 1, first_name: 'Ana' }, chat, date: 1_700_000_000, text, ...extra },
  });
  return {
    channelType: 'telegram',
    adapter,
    setup,
    dmPlatformId: 'telegram:1',
    calls,
    dm: (id, text) => push(msg(id, { id: 1, type: 'private' }, text)),
    redeliver: async () => {
      queue.push(last);
      await settle(60);
    },
    group: (id, text, mention) =>
      push(
        msg(
          id,
          { id: -100, type: 'supergroup', title: 'Team' },
          mention ? `@cb_bot ${text}` : text,
          mention ? { entities: [{ type: 'mention', offset: 0, length: 7 }] } : {},
        ),
      ),
    voice: (id) =>
      push(
        msg(id, { id: 1, type: 'private' }, '', {
          text: undefined,
          voice: { file_id: 'v1', file_unique_id: 'v1', duration: 2, mime_type: 'audio/ogg' },
        }),
      ),
    click: (qid, idx, user) =>
      push({
        callback_query: {
          id: 'cb1',
          from: { id: Number(user), first_name: 'Bo' },
          data: `ncq:${qid}:${idx}`,
          message: { message_id: 5, chat: { id: 1, type: 'private' }, date: 1_700_000_000, text: 'card' },
        },
      }),
    unsigned: null,
    isSend: (c) => c.api === 'sendMessage',
    textOf: (c) => String(c.body.text ?? ''),
    choiceIdsOf: (c) =>
      (
        (c.body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data: string }>> } | undefined)
          ?.inline_keyboard ?? []
      )
        .flat()
        .map((b) => b.callback_data),
    isEdit: (c) => c.api === 'editMessageText',
    isFileSend: (c) => ['sendDocument', 'sendPhoto', 'sendVideo', 'sendVoice', 'sendAudio'].includes(c.api),
    failNextSend: () => void (failNext = true),
    rateLimitNextSend: () => void (limitNext = true),
    teardown: () => adapter.teardown(),
  };
}

// ── WhatsApp ──

async function whatsappHarness(): Promise<Harness> {
  const calls: Call[] = [];
  let failNext = false;
  let limitNext = false;
  route = async (url, init) => {
    if (url.startsWith('https://lookaside.fbsbx.test/')) return new Response(new Uint8Array([1, 2, 3]));
    const api = url.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+\//, '');
    const body = init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : bodyOf(init);
    calls.push({ api, body: body as Record<string, unknown> });
    const isSend = api === 'PHONE1/messages' && !('status' in body);
    if (isSend && limitNext) {
      limitNext = false;
      return json({ error: { code: 130429, message: 'Rate limit hit' } }, 429, { 'retry-after': '1' });
    }
    if (isSend && failNext) {
      failNext = false;
      return json({ error: { code: 131026, message: 'Message undeliverable' } }, 400);
    }
    if (api === 'media1') return json({ url: 'https://lookaside.fbsbx.test/m1', mime_type: 'audio/ogg', file_size: 3 });
    if (api === 'PHONE1/media') return json({ id: 'up1' });
    return json({ messages: [{ id: `wamid.out${calls.length}` }] });
  };
  const adapter = factories.get('whatsapp')!.factory() as ChannelAdapter;
  const setup = mockSetup();
  await adapter.setup(setup as unknown as ChannelSetup);
  let last = '';
  const post = async (message: Record<string, unknown>, from = '15551', name = 'Ana') => {
    last = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: from, profile: { name } }],
                messages: [{ from, timestamp: '1700000000', ...message }],
              },
            },
          ],
        },
      ],
    });
    const sig = 'sha256=' + crypto.createHmac('sha256', 'wa-secret').update(last).digest('hex');
    await handlers.get('whatsapp')!(
      new Request('http://localhost/webhook/whatsapp', {
        method: 'POST',
        body: last,
        headers: { 'x-hub-signature-256': sig },
      }),
    );
    await settle();
  };
  const sendBody = (c: Call) => c.body as { text?: { body: string }; interactive?: Record<string, unknown> };
  return {
    channelType: 'whatsapp',
    adapter,
    setup,
    dmPlatformId: 'whatsapp:15551',
    calls,
    dm: (id, text) => post({ id: `wamid.${id}`, type: 'text', text: { body: text } }),
    redeliver: async () => {
      const sig = 'sha256=' + crypto.createHmac('sha256', 'wa-secret').update(last).digest('hex');
      await handlers.get('whatsapp')!(
        new Request('http://localhost/webhook/whatsapp', {
          method: 'POST',
          body: last,
          headers: { 'x-hub-signature-256': sig },
        }),
      );
      await settle();
    },
    group: null, // Cloud API conversations are 1:1 with the business number.
    voice: (id) => post({ id: `wamid.${id}`, type: 'audio', audio: { id: 'media1', mime_type: 'audio/ogg' } }),
    click: (qid, idx, user) =>
      post(
        {
          id: `wamid.click${idx}`,
          type: 'interactive',
          interactive: { type: 'button_reply', button_reply: { id: `ncq:${qid}:${idx}`, title: 'x' } },
        },
        user,
        'Bo',
      ),
    unsigned: () =>
      handlers.get('whatsapp')!(
        new Request('http://localhost/webhook/whatsapp', { method: 'POST', body: '{"entry":[]}' }),
      ),
    isSend: (c) =>
      c.api === 'PHONE1/messages' && !('status' in c.body) && (c.body as { type?: string }).type !== 'reaction',
    textOf: (c) => {
      const b = sendBody(c);
      return b.text?.body ?? String((b.interactive?.body as { text?: string } | undefined)?.text ?? '');
    },
    choiceIdsOf: (c) => {
      const action = (sendBody(c).interactive?.action ?? {}) as {
        buttons?: Array<{ reply: { id: string } }>;
        sections?: Array<{ rows: Array<{ id: string }> }>;
      };
      return [
        ...(action.buttons ?? []).map((b) => b.reply.id),
        ...(action.sections ?? []).flatMap((s) => s.rows.map((r) => r.id)),
      ];
    },
    // WhatsApp can't edit: the edit arrives as a new text message.
    isEdit: (c) => c.api === 'PHONE1/messages' && (c.body as { type?: string }).type === 'text',
    isFileSend: (c) => c.api === 'PHONE1/messages' && (c.body as { type?: string }).type === 'document',
    failNextSend: () => void (failNext = true),
    rateLimitNextSend: () => void (limitNext = true),
    teardown: () => adapter.teardown(),
  };
}

// ── Discord ──

async function discordHarness(): Promise<
  Harness & {
    inThread(id: string, text: string, threadId: string): Promise<void>;
    slash(name: string, arg?: string): Promise<void>;
  }
> {
  const calls: Call[] = [];
  let failNext = false;
  const events = new Map<string, (arg: unknown) => Promise<void>>();
  const channels = new Map<string, Record<string, unknown>>();
  const messages = new Map<string, Record<string, unknown>>();
  let outId = 0;

  const makeChannel = (id: string, extra: Record<string, unknown> = {}) => {
    const ch: Record<string, unknown> = {
      id,
      isThread: () => false,
      name: 'general',
      async send(payload: unknown) {
        if (failNext) {
          failNext = false;
          throw new Error('Missing Access');
        }
        const body = typeof payload === 'string' ? { content: payload } : (payload as Record<string, unknown>);
        calls.push({ api: 'send', body: { channel: id, ...body } });
        const sentId = `out-${++outId}`;
        messages.set(sentId, makeMessage(sentId));
        return { id: sentId };
      },
      sendTyping: async () => calls.push({ api: 'typing', body: { channel: id } }),
      messages: { fetch: async (mid: string) => messages.get(mid) ?? Promise.reject(new Error('Unknown Message')) },
      ...extra,
    };
    channels.set(id, ch);
    return ch;
  };
  const makeMessage = (mid: string, extra: Record<string, unknown> = {}) => ({
    id: mid,
    cleanContent: 'root',
    edit: async (content: string) => calls.push({ api: 'edit', body: { id: mid, content } }),
    react: async (emoji: string) => calls.push({ api: 'react', body: { id: mid, emoji } }),
    startThread: async ({ name }: { name: string }) => {
      calls.push({ api: 'startThread', body: { id: mid, name } });
      return makeChannel(mid, { isThread: () => true, parentId: 'C1', ownerId: 'BOT' });
    },
    ...extra,
  });
  makeChannel('D1');
  makeChannel('C1');

  const client = {
    user: { id: 'BOT', tag: 'cb#0001' },
    on(ev: string, fn: (arg: unknown) => Promise<void>) {
      events.set(ev, fn);
      return client;
    },
    login: async () => 'ok',
    destroy: async () => undefined,
    channels: { fetch: async (id: string) => channels.get(id) ?? null },
    users: { fetch: async (id: string) => ({ createDM: async () => ({ id: `DM-${id}` }) }) },
  };
  route = async (url) =>
    url.startsWith('https://cdn.discord.test/')
      ? new Response(new Uint8Array([1, 2, 3]))
      : new Response('', { status: 404 });

  const adapter = createDiscordAdapter('discord-token', client as unknown as DiscordClientLike);
  const setup = mockSetup();
  await adapter.setup(setup as unknown as ChannelSetup);

  const inbound = async (
    id: string,
    text: string,
    opts: {
      guild?: boolean;
      mention?: boolean;
      channel?: Record<string, unknown>;
      attachments?: Array<Record<string, unknown>>;
    } = {},
  ) => {
    const channel = opts.channel ?? channels.get(opts.guild ? 'C1' : 'D1')!;
    const message = makeMessage(id, {
      author: { id: 'U1', bot: false, username: 'ana', globalName: 'Ana' },
      member: opts.guild ? { displayName: 'Ana' } : null,
      guild: opts.guild ? { id: 'G1' } : null,
      channelId: channel.id,
      channel,
      mentions: { users: { has: (u: string) => !!opts.mention && u === 'BOT' } },
      cleanContent: text,
      content: text,
      attachments: new Map((opts.attachments ?? []).map((a, i) => [String(i), a])),
      createdTimestamp: Date.now(),
    });
    messages.set(id, message);
    await events.get('messageCreate')!(message);
  };

  return {
    channelType: 'discord',
    adapter,
    setup,
    dmPlatformId: 'discord:D1',
    calls,
    dm: (id, text) => inbound(id, text),
    redeliver: null, // The gateway resumes sessions itself; it does not replay delivered events.
    group: (id, text, mention) => inbound(id, text, { guild: true, mention }),
    voice: (id) =>
      inbound(id, '', {
        attachments: [{ name: 'voice.ogg', contentType: 'audio/ogg', size: 3, url: 'https://cdn.discord.test/v.ogg' }],
      }),
    click: async (qid, idx, user) => {
      await events.get('interactionCreate')!({
        isButton: () => true,
        customId: `ncq:${qid}:${idx}`,
        user: { id: user, username: 'bo', globalName: 'Bo' },
        message: { content: 'card' },
        update: async (p: unknown) => calls.push({ api: 'interaction.update', body: p as Record<string, unknown> }),
      });
    },
    unsigned: null,
    isSend: (c) => c.api === 'send' && 'content' in c.body,
    textOf: (c) => String(c.body.content ?? ''),
    choiceIdsOf: (c) =>
      ((c.body.components as Array<{ components: Array<{ custom_id: string }> }>) ?? []).flatMap((r) =>
        r.components.map((b) => b.custom_id),
      ),
    isEdit: (c) => c.api === 'edit',
    isFileSend: (c) => c.api === 'send' && Array.isArray(c.body.files),
    failNextSend: () => void (failNext = true),
    rateLimitNextSend: null, // discord.js queues and retries rate limits inside its REST client.
    teardown: () => adapter.teardown(),
    inThread: (id, text, threadId) => inbound(id, text, { guild: true, channel: channels.get(threadId)! }),
    slash: async (name, arg) => {
      await events.get('interactionCreate')!({
        id: `int-${name}`,
        isChatInputCommand: () => true,
        isButton: () => false,
        commandName: name,
        options: { getString: () => arg ?? null },
        reply: async () => undefined,
        channel: channels.get('C1'),
        channelId: 'C1',
        guildId: 'G1',
        user: { id: 'U1', username: 'ana', globalName: 'Ana' },
      });
    },
  };
}

// ── The contract ──

const card: OutboundMessage = {
  kind: 'chat-sdk',
  content: {
    type: 'ask_question',
    questionId: 'q-1',
    title: 'Save to team memory?',
    question: 'Payroll runs on the **25th**.',
    options: [
      { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
      { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
    ],
  },
};

const harnesses: Array<[string, () => Promise<Harness>]> = [
  ['slack', slackHarness],
  ['telegram', telegramHarness],
  ['whatsapp', whatsappHarness],
  ['discord', discordHarness],
];

describe.each(harnesses)('%s adapter contract', (_name, make) => {
  let h: Harness;
  beforeEach(async () => {
    renderMock.mockReset();
    renderMock.mockImplementation((id: string) =>
      id === 'q-1' ? { title: 't', options: (card.content as { options: unknown }).options } : undefined,
    );
    h = await make();
  });
  afterEach(async () => {
    await h.teardown();
  });

  it('stamps who sent a DM, as a namespaced id and a display name', async () => {
    await h.dm('11', 'what is the plan?');
    await until(() => h.setup.onInbound.mock.calls.length === 1);
    const [platformId, , inbound] = h.setup.onInbound.mock.calls[0];
    expect(platformId).toBe(h.dmPlatformId);
    expect(inbound.isGroup).toBe(false);
    expect(inbound.content.text).toContain('what is the plan?');
    expect(inbound.content.senderId).toMatch(new RegExp(`^${h.channelType}:.+`));
    expect(inbound.content.sender).toBe('Ana');
  });

  it('drops a platform redelivery of the same message', async () => {
    if (!h.redeliver) return; // see harness: platform never redelivers
    await h.dm('12', 'once only');
    await until(() => h.setup.onInbound.mock.calls.length === 1);
    await h.redeliver();
    await settle(60);
    expect(h.setup.onInbound).toHaveBeenCalledTimes(1);
  });

  it('marks group messages and only treats an @mention as addressed to the bot', async () => {
    if (!h.group) return; // see harness: channel has no groups
    await h.group('21', 'chatting among ourselves', false);
    await settle();
    for (const call of h.setup.onInbound.mock.calls) expect(call[2].isMention).toBeFalsy();
    await h.group('22', 'summarise this', true);
    await until(() => h.setup.onInbound.mock.calls.some((c) => c[2].isMention));
    const addressed = h.setup.onInbound.mock.calls.find((c) => c[2].isMention)!;
    expect(addressed[2].isGroup).toBe(true);
    expect(addressed[2].content.text).toContain('summarise this');
  });

  it('transcribes voice notes', async () => {
    await h.voice('31');
    await until(() => h.setup.onInbound.mock.calls.length === 1);
    expect(h.setup.onInbound.mock.calls[0][2].content.text).toContain('[voice] hello from a voice note');
  });

  it('renders a question card with choice ids the response path understands', async () => {
    await h.adapter.deliver(h.dmPlatformId, null, card);
    const sent = h.calls.filter((c) => h.isSend(c)).pop()!;
    expect(h.choiceIdsOf(sent)).toEqual(['ncq:q-1:0', 'ncq:q-1:1']);
    expect(h.textOf(sent)).toContain('Payroll runs on the');
  });

  it('turns a click into onAction with the option value and the raw clicker id', async () => {
    await h.click('q-1', 1, '9');
    await until(() => h.setup.onAction.mock.calls.length === 1);
    expect(h.setup.onAction).toHaveBeenCalledWith('q-1', 'reject', '9');
  });

  it("splits long replies within the channel's limit", async () => {
    const long = Array.from({ length: 120 }, (_, i) => `Paragraph ${i}: ${'lorem ipsum '.repeat(8)}`).join('\n\n');
    await h.adapter.deliver(h.dmPlatformId, null, { kind: 'chat', content: { text: long } });
    const sends = h.calls.filter((c) => h.isSend(c));
    const max = capabilitiesFor(h.channelType).maxText;
    expect(sends.length).toBeGreaterThan(1);
    for (const s of sends) expect(h.textOf(s).length).toBeLessThanOrEqual(max);
  });

  it('applies edits (or sends the new text where the channel cannot edit)', async () => {
    const id = await h.adapter.deliver(h.dmPlatformId, null, { kind: 'chat', content: { text: 'Working on it…' } });
    await h.adapter.deliver(h.dmPlatformId, null, {
      kind: 'chat',
      content: { operation: 'edit', messageId: id ?? 'out-1', text: 'Done: 3 rows' },
    });
    expect(h.calls.some((c) => h.isEdit(c) && JSON.stringify(c.body).includes('Done: 3 rows'))).toBe(true);
  });

  it('sends files', async () => {
    await h.adapter.deliver(h.dmPlatformId, null, {
      kind: 'chat',
      content: { text: 'Report attached' },
      files: [{ filename: 'report.pdf', data: Buffer.from('%PDF-1.4') }],
    });
    expect(h.calls.some((c) => h.isFileSend(c))).toBe(true);
  });

  it('throws when the platform rejects a send, so delivery retries instead of marking it delivered', async () => {
    h.failNextSend();
    await expect(h.adapter.deliver(h.dmPlatformId, null, { kind: 'chat', content: { text: 'hi' } })).rejects.toThrow();
  });

  it('waits out a rate limit and then delivers', async () => {
    if (!h.rateLimitNextSend) return; // see harness: client library retries internally
    h.rateLimitNextSend();
    await expect(
      h.adapter.deliver(h.dmPlatformId, null, { kind: 'chat', content: { text: 'hi' } }),
    ).resolves.toBeTruthy();
    expect(h.calls.filter((c) => h.isSend(c)).length).toBe(2);
  }, 10_000);

  it('rejects unsigned webhooks', async () => {
    if (!h.unsigned) return; // see harness: no inbound webhook (long poll or gateway)
    const res = await h.unsigned();
    expect(res.status).toBe(401);
  });
});

describe('discord threads', () => {
  it('replies to a top-level mention in a new thread, and follows up there without another mention', async () => {
    const h = await discordHarness();
    await h.group!('500', 'plan the launch', true);
    await until(() => h.setup.onInbound.mock.calls.length === 1);
    const [platformId, threadId] = h.setup.onInbound.mock.calls[0];
    expect(threadId).toBe('500');
    await h.adapter.deliver(platformId, threadId, { kind: 'chat', content: { text: 'On it' } });
    expect(h.calls.find((c) => c.api === 'startThread')?.body).toMatchObject({ id: '500' });
    expect(h.calls.find((c) => h.isSend(c))?.body).toMatchObject({ channel: '500', content: 'On it' });

    // A follow-up typed inside that thread, with no mention, still reaches the agent in the same conversation.
    await h.inThread('501', 'and the budget?', '500');
    await until(() => h.setup.onInbound.mock.calls.length === 2);
    expect(h.setup.onInbound.mock.calls[1].slice(0, 2)).toEqual(['discord:C1', '500']);
    await h.teardown();
  });
});

describe('discord slash commands', () => {
  it('forwards a slash command as the matching text command from that user', async () => {
    const h = await discordHarness();
    await h.slash('status');
    await until(() => h.setup.onInbound.mock.calls.length === 1);
    const [platformId, threadId, inbound] = h.setup.onInbound.mock.calls[0];
    expect(platformId).toBe('discord:C1');
    expect(threadId).toBeNull();
    expect(inbound.content).toMatchObject({ text: '/status', senderId: 'discord:U1', sender: 'Ana' });
    await h.slash('mute', '2');
    await until(() => h.setup.onInbound.mock.calls.length === 2);
    expect(h.setup.onInbound.mock.calls[1][2].content.text).toBe('!mute 2');
    await h.teardown();
  });
});

describe('whatsapp cards', () => {
  it('uses a list for 4–10 options and spells out long button labels', async () => {
    const h = await whatsappHarness();
    const options = ['One', 'Two', 'Three', 'Four', 'Five'];
    await h.adapter.deliver(h.dmPlatformId, null, {
      kind: 'chat-sdk',
      content: { type: 'ask_question', questionId: 'q-2', title: 'Pick a day', question: 'Which day?', options },
    });
    const list = h.calls.filter((c) => h.isSend(c)).pop()!;
    expect((list.body as { interactive: { type: string } }).interactive.type).toBe('list');
    expect(h.choiceIdsOf(list)).toHaveLength(5);

    await h.adapter.deliver(h.dmPlatformId, null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'q-3',
        title: 'Send?',
        question: 'Ready to send?',
        options: ['Send the invoice to the client now', 'Keep it as a draft'],
      },
    });
    const buttons = h.calls.filter((c) => h.isSend(c)).pop()!;
    expect(h.textOf(buttons)).toContain('1. Send the invoice to the client now');
    await h.teardown();
  });
});
