/**
 * Adapter contract suite, part 2: Signal, iMessage and email.
 *
 * Same checks as contract.test.ts (sender identity, DM vs group, mentions,
 * redeliveries, voice, cards, splitting, edits, files, errors, rate limits,
 * webhook auth), each against a fake of its platform. These channels have
 * no buttons, so cards arrive as numbered lists (answered by the host).
 */
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (req: Request) => Promise<Response>>() }));
vi.mock('../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }));
vi.mock('../webhook-server.js', () => ({
  registerRawWebhookHandler: (name: string, h: (req: Request) => Promise<Response>) => handlers.set(name, h),
}));
vi.mock('./channel-registry.js', () => ({ registerChannelAdapter: vi.fn() }));
vi.mock('../transcription.js', () => ({
  isAudioLike: (mime: string) => mime.startsWith('audio/'),
  transcribeAudio: vi.fn(async () => 'hello from a voice note'),
}));

import type { ChannelAdapter, ChannelSetup } from './adapter.js';
import { capabilitiesFor } from './capabilities.js';
import { createEmailAdapter } from './email.js';
import { asString, createIMessageAdapter, messageText, sendScript } from './imessage.js';
import { numberedChoicesText } from './render.js';
import { createSignalAdapter, signalTarget } from './signal.js';

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
  expectedSender: string;
  calls: Call[];
  dm(id: string, text: string): Promise<void>;
  redeliver: (() => Promise<void>) | null;
  group: ((id: string, text: string, mention: boolean) => Promise<void>) | null;
  voice: ((id: string) => Promise<void>) | null;
  unsigned: (() => Promise<Response>) | null;
  isSend(c: Call): boolean;
  textOf(c: Call): string;
  isFileSend(c: Call): boolean;
  failNextSend(): void;
  rateLimitNextSend: (() => void) | null;
  teardown(): Promise<void>;
}

const mockSetup = () => ({ onInbound: vi.fn(), onAction: vi.fn(), onMetadata: vi.fn(), onInboundEvent: vi.fn() });
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── Signal: a fake signal-cli JSON-RPC daemon ──

async function signalHarness(): Promise<Harness> {
  const calls: Call[] = [];
  let failNext = false;
  let client: net.Socket | null = null;
  let last = '';
  const server = net.createServer((sock) => {
    client = sock;
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl)) as { id: number; method: string; params: Record<string, unknown> };
        buf = buf.slice(nl + 1);
        calls.push({ api: msg.method, body: msg.params });
        if (msg.method === 'send' && failNext) {
          failNext = false;
          sock.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -1, message: 'Unregistered user' } })}\n`,
          );
        } else {
          sock.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { timestamp: 1_700_000_000_000 + calls.length } })}\n`,
          );
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  const attachments = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-signal-att-'));
  fs.writeFileSync(path.join(attachments, 'att1'), 'aac-bytes');

  const adapter = createSignalAdapter({
    account: '+15550000000',
    host: '127.0.0.1',
    port,
    attachmentsDir: attachments,
  });
  const setup = mockSetup();
  await adapter.setup(setup as unknown as ChannelSetup);
  await until(() => client !== null);

  const push = async (dataMessage: Record<string, unknown>, ts: number) => {
    last = `${JSON.stringify({
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: {
          sourceNumber: '+15551111111',
          sourceName: 'Ana',
          timestamp: ts,
          dataMessage: { timestamp: ts, ...dataMessage },
        },
      },
    })}\n`;
    client!.write(last);
    await settle();
  };
  return {
    channelType: 'signal',
    adapter,
    setup,
    dmPlatformId: 'signal:+15551111111',
    expectedSender: 'Ana',
    calls,
    dm: (id, text) => push({ message: text }, Number(id)),
    redeliver: async () => {
      client!.write(last);
      await settle();
    },
    group: (id, text, mention) =>
      push(
        {
          message: text,
          groupInfo: { groupId: 'R3JvdXA=' },
          ...(mention ? { mentions: [{ number: '+15550000000' }] } : {}),
        },
        Number(id),
      ),
    voice: (id) =>
      push({ message: null, attachments: [{ id: 'att1', contentType: 'audio/aac', size: 9 }] }, Number(id)),
    unsigned: null, // local TCP daemon, no webhook
    isSend: (c) => c.api === 'send' && typeof c.body.message === 'string' && c.body.message !== '',
    textOf: (c) => String(c.body.message ?? ''),
    isFileSend: (c) => c.api === 'send' && Array.isArray(c.body.attachments),
    failNextSend: () => void (failNext = true),
    rateLimitNextSend: null, // signal-cli queues and paces sends itself
    teardown: async () => {
      await adapter.teardown();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// ── iMessage: a real chat.db in the Messages schema, and a fake AppleScript runner ──

function makeChatDb(): { file: string; db: Database.Database } {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-imsg-')), 'chat.db');
  const db = new Database(file);
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER, display_name TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER, date INTEGER, is_from_me INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO handle VALUES (1, '+15551111111');
    INSERT INTO chat VALUES (1, 'iMessage;-;+15551111111', '+15551111111', 45, NULL);
    INSERT INTO chat VALUES (2, 'iMessage;+;chat42', 'chat42', 43, 'Team');
    INSERT INTO message VALUES (1, 'old', 'from before start', NULL, 1, 0, 0);
    INSERT INTO chat_message_join VALUES (1, 1);
  `);
  return { file, db };
}

async function imessageHarness(): Promise<Harness> {
  const calls: Call[] = [];
  let failNext = false;
  const { file, db } = makeChatDb();
  let rowid = 1;
  const insert = (chat: number, text: string, guid: string) => {
    rowid++;
    db.prepare('INSERT INTO message VALUES (?, ?, ?, NULL, 1, ?, 0)').run(rowid, guid, text, 700_000_000_000_000_000);
    db.prepare('INSERT INTO chat_message_join VALUES (?, ?)').run(chat, rowid);
  };
  const adapter = createIMessageAdapter({
    dbPath: file,
    assistantName: 'Ava',
    pollMs: 15,
    run: async (script) => {
      if (failNext) {
        failNext = false;
        throw new Error('Messages got an error: Can’t send.');
      }
      calls.push({ api: 'osascript', body: { script } });
      return '';
    },
  });
  const setup = mockSetup();
  await adapter.setup(setup as unknown as ChannelSetup);
  return {
    channelType: 'imessage',
    adapter,
    setup,
    dmPlatformId: 'imessage:iMessage;-;+15551111111',
    expectedSender: '+15551111111', // Messages exposes the handle, not a contact name
    calls,
    dm: async (id, text) => {
      insert(1, text, `g-${id}`);
      await settle();
    },
    redeliver: null, // read by row id; a row is never read twice
    group: async (id, text, mention) => {
      insert(2, mention ? `Ava, ${text}` : text, `g-${id}`);
      await settle();
    },
    voice: null, // audio attachments are not exposed to the bot
    unsigned: null,
    isSend: (c) => /send ".*" to/.test(String(c.body.script)),
    textOf: (c) =>
      String(c.body.script)
        .replace(/^.*?send "(.*)" to .*$/s, '$1')
        .replace(/\\n/g, '\n'),
    isFileSend: (c) => /send POSIX file/.test(String(c.body.script)),
    failNextSend: () => void (failNext = true),
    rateLimitNextSend: null,
    teardown: async () => {
      await adapter.teardown();
      db.close();
    },
  };
}

// ── Email: Postmark inbound webhook + Postmark API ──

async function emailHarness(): Promise<Harness> {
  const calls: Call[] = [];
  let failNext = false;
  let limitNext = false;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (limitNext) {
      limitNext = false;
      calls.push({ api: 'email', body });
      return new Response(JSON.stringify({ ErrorCode: 429, Message: 'Rate limit' }), {
        status: 429,
        headers: { 'retry-after': '1' },
      });
    }
    calls.push({ api: url.replace('https://api.postmarkapp.com/', ''), body });
    if (failNext) {
      failNext = false;
      return new Response(JSON.stringify({ ErrorCode: 406, Message: 'Inactive recipient' }), { status: 422 });
    }
    return new Response(JSON.stringify({ ErrorCode: 0, MessageID: `pm-${calls.length}` }));
  });
  const adapter = createEmailAdapter({ token: 'pm-token', from: 'ava@acme.test', inboundToken: 'inbound-secret' });
  const setup = mockSetup();
  await adapter.setup(setup as unknown as ChannelSetup);
  let last: Record<string, unknown> = {};
  const post = async (mail: Record<string, unknown>) => {
    last = mail;
    await handlers.get('email')!(
      new Request('http://localhost/webhook/email?token=inbound-secret', {
        method: 'POST',
        body: JSON.stringify(mail),
      }),
    );
    await settle();
  };
  return {
    channelType: 'email',
    adapter,
    setup,
    dmPlatformId: 'email:ana@client.test',
    expectedSender: 'Ana',
    calls,
    dm: (id, text) =>
      post({
        MessageID: `m-${id}`,
        FromFull: { Email: 'Ana@Client.test', Name: 'Ana' },
        Subject: 'Plan',
        StrippedTextReply: text,
        Headers: [{ Name: 'Message-ID', Value: `<m-${id}@client.test>` }],
      }),
    redeliver: () => post(last),
    group: null, // each correspondent is a conversation
    voice: null,
    unsigned: () =>
      handlers.get('email')!(new Request('http://localhost/webhook/email?token=wrong', { method: 'POST', body: '{}' })),
    isSend: (c) => c.api === 'email' && typeof c.body.TextBody === 'string' && c.body.TextBody !== '',
    textOf: (c) => String(c.body.TextBody ?? ''),
    isFileSend: (c) =>
      c.api === 'email' && Array.isArray(c.body.Attachments) && (c.body.Attachments as unknown[]).length > 0,
    failNextSend: () => void (failNext = true),
    rateLimitNextSend: () => void (limitNext = true),
    teardown: async () => {
      await adapter.teardown();
      vi.unstubAllGlobals();
    },
  };
}

const card = {
  title: 'Save to team memory?',
  question: 'Payroll runs on the 25th.',
  options: [
    { label: 'Approve', selectedLabel: 'Approved', value: 'approve' },
    { label: 'Reject', selectedLabel: 'Rejected', value: 'reject' },
  ],
};

describe.each([
  ['signal', signalHarness],
  ['imessage', imessageHarness],
  ['email', emailHarness],
] as Array<[string, () => Promise<Harness>]>)('%s adapter contract', (_name, make) => {
  let h: Harness;
  beforeEach(async () => {
    h = await make();
  });
  afterEach(async () => {
    await h.teardown();
  });

  it('stamps who sent a DM, as a namespaced id and a display name', async () => {
    await h.dm('1700000001000', 'what is the plan?');
    await until(() => h.setup.onInbound.mock.calls.length === 1);
    const [platformId, , inbound] = h.setup.onInbound.mock.calls[0];
    expect(platformId).toBe(h.dmPlatformId);
    expect(inbound.isGroup).toBe(false);
    expect(inbound.content.text).toContain('what is the plan?');
    expect(inbound.content.senderId).toMatch(new RegExp(`^${h.channelType}:.+`));
    expect(inbound.content.sender).toBe(h.expectedSender);
  });

  it('never replays history and drops platform redeliveries', async () => {
    await h.dm('1700000002000', 'once only');
    await until(() => h.setup.onInbound.mock.calls.length === 1);
    if (h.redeliver) await h.redeliver();
    await settle();
    expect(h.setup.onInbound).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.setup.onInbound.mock.calls)).not.toContain('from before start');
  });

  it('marks group messages and only treats a mention as addressed to the bot', async () => {
    if (!h.group) return; // see harness
    await h.group('1700000003000', 'chatting among ourselves', false);
    await settle();
    for (const call of h.setup.onInbound.mock.calls) expect(call[2].isMention).toBeFalsy();
    await h.group('1700000004000', 'summarise this', true);
    await until(() => h.setup.onInbound.mock.calls.some((c) => c[2].isMention));
    expect(h.setup.onInbound.mock.calls.find((c) => c[2].isMention)![2].isGroup).toBe(true);
  });

  it('transcribes voice notes', async () => {
    if (!h.voice) return; // see harness
    await h.voice('1700000005000');
    await until(() => h.setup.onInbound.mock.calls.length === 1);
    expect(h.setup.onInbound.mock.calls[0][2].content.text).toContain('[voice] hello from a voice note');
  });

  it('shows question cards as a numbered list (no buttons on this channel)', async () => {
    expect(capabilitiesFor(h.channelType).choices.buttons).toBe(0);
    await h.adapter.deliver(h.dmPlatformId, null, {
      kind: 'chat',
      content: { text: numberedChoicesText(card.title, card.question, card.options) },
    });
    expect(h.textOf(h.calls.filter((c) => h.isSend(c)).pop()!)).toMatch(/1\. Approve[\s\S]*2\. Reject/);
  });

  it("splits long replies within the channel's limit", async () => {
    const max = capabilitiesFor(h.channelType).maxText;
    const long = Array.from(
      { length: Math.ceil((max * 1.6) / 110) },
      (_, i) => `Paragraph ${i}: ${'lorem ipsum '.repeat(8)}`,
    ).join('\n\n');
    await h.adapter.deliver(h.dmPlatformId, null, { kind: 'chat', content: { text: long } });
    const sends = h.calls.filter((c) => h.isSend(c));
    if (h.channelType !== 'email') expect(sends.length).toBeGreaterThan(1); // one email can carry it all
    for (const s of sends) expect(h.textOf(s).length).toBeLessThanOrEqual(max);
  });

  it('applies edits (or sends the new text where the channel cannot edit)', async () => {
    const id = await h.adapter.deliver(h.dmPlatformId, null, { kind: 'chat', content: { text: 'Working on it' } });
    await h.adapter.deliver(h.dmPlatformId, null, {
      kind: 'chat',
      content: { operation: 'edit', messageId: id ?? 'x', text: 'Done: 3 rows' },
    });
    expect(h.calls.some((c) => JSON.stringify(c.body).includes('Done: 3 rows'))).toBe(true);
  });

  it('sends files', async () => {
    await h.adapter.deliver(h.dmPlatformId, null, {
      kind: 'chat',
      content: { text: 'Report attached' },
      files: [{ filename: 'report.pdf', data: Buffer.from('%PDF-1.4') }],
    });
    expect(h.calls.some((c) => h.isFileSend(c))).toBe(true);
  });

  it('throws when the platform rejects a send, so delivery retries', async () => {
    h.failNextSend();
    await expect(h.adapter.deliver(h.dmPlatformId, null, { kind: 'chat', content: { text: 'hi' } })).rejects.toThrow();
  });

  it('waits out a rate limit and then delivers', async () => {
    if (!h.rateLimitNextSend) return; // see harness
    h.rateLimitNextSend();
    await expect(
      h.adapter.deliver(h.dmPlatformId, null, { kind: 'chat', content: { text: 'hi' } }),
    ).resolves.toBeTruthy();
  }, 10_000);

  it('rejects unauthenticated webhooks', async () => {
    if (!h.unsigned) return; // see harness
    expect([401, 403, 404]).toContain((await h.unsigned()).status);
  });
});

describe('channel details', () => {
  it('signal addresses DMs by number and groups by id', () => {
    expect(signalTarget('signal:+1555')).toEqual({ recipient: ['+1555'] });
    expect(signalTarget('signal:group.abc=')).toEqual({ groupId: 'abc=' });
  });

  it('imessage reads text from attributedBody and quotes AppleScript safely', () => {
    const blob = Buffer.concat([
      Buffer.from('streamtyped\u0001NSString\u0001\u0094\u0084\u0001'),
      Buffer.from([0x2b, 5]),
      Buffer.from('hello'),
    ]);
    expect(messageText(null, blob)).toBe('hello');
    expect(asString('say "hi"\nnow')).toBe('"say \\"hi\\"\\nnow"');
    expect(sendScript({ chatGuid: 'iMessage;+;chat42' }, { text: 'x' })).toBe(
      'tell application "Messages" to send "x" to chat id "iMessage;+;chat42"',
    );
  });

  it('email threads replies under the original subject', async () => {
    const h = await emailHarness();
    await h.dm('9', 'can you send the invoice?');
    await h.adapter.deliver(h.dmPlatformId, null, { kind: 'chat', content: { text: 'Here it is.' } });
    const sent = h.calls.at(-1)!.body;
    expect(sent).toMatchObject({ To: 'ana@client.test', Subject: 'Re: Plan', From: 'ava@acme.test' });
    expect(JSON.stringify(sent.Headers)).toContain('<m-9@client.test>');
    await h.teardown();
  });
});
