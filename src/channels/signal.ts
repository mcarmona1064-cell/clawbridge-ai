/**
 * Signal channel adapter — native, over signal-cli's JSON-RPC daemon.
 *
 * Signal has no bot API, so ClawBridge runs as a Signal account (a
 * dedicated number is recommended) through signal-cli:
 *
 *   signal-cli -a +15550001111 daemon --tcp 127.0.0.1:7583
 *
 * Reads from ~/.clawbridge/.env:
 *   SIGNAL_ACCOUNT      the bot's number, e.g. +15550001111
 *   SIGNAL_RPC          host:port of the daemon (default 127.0.0.1:7583)
 *   SIGNAL_ATTACHMENTS  signal-cli's attachments folder
 *                       (default ~/.local/share/signal-cli/attachments)
 *
 * Behaviour: DMs and groups; in groups only @mentions and replies to the
 * bot are addressed to it. Sender id `signal:<number or uuid>` and the
 * profile name. Voice notes are transcribed. Outbound: plain text split at
 * 2000 characters, edits, reactions, typing and files. Question cards
 * become numbered replies (Signal has no buttons). Errors from the daemon
 * throw so delivery retries.
 */
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { isAudioLike, transcribeAudio } from '../transcription.js';
import type {
  ChannelAdapter,
  ChannelSetup,
  InboundFile,
  InboundMessage,
  OutboundFile,
  OutboundMessage,
} from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { emojiFor, parseOutbound, renderChunks, SeenSet } from './render.js';

const CHANNEL_TYPE = 'signal';
const MAX_TEXT = 2000;
const RPC_TIMEOUT_MS = 20_000;

export class SignalRpcError extends Error {
  constructor(
    readonly method: string,
    readonly detail: string,
  ) {
    super(`Signal ${method} failed: ${detail}`);
    this.name = 'SignalRpcError';
  }
}

interface Envelope {
  source?: string;
  sourceNumber?: string | null;
  sourceUuid?: string;
  sourceName?: string;
  timestamp?: number;
  dataMessage?: {
    timestamp?: number;
    message?: string | null;
    groupInfo?: { groupId: string };
    mentions?: Array<{ number?: string | null; uuid?: string }>;
    quote?: { author?: string; authorNumber?: string | null; authorUuid?: string };
    attachments?: Array<{ id: string; contentType?: string; filename?: string | null; size?: number }>;
  };
}

/** Where a conversation lives: `signal:<number>` for DMs, `signal:group.<id>` for groups. */
export function signalTarget(platformId: string): { recipient: string[] } | { groupId: string } {
  const rest = platformId.startsWith(`${CHANNEL_TYPE}:`) ? platformId.slice(CHANNEL_TYPE.length + 1) : platformId;
  return rest.startsWith('group.') ? { groupId: rest.slice('group.'.length) } : { recipient: [rest] };
}

/** Outbound message ids are `<author>|<timestamp>`, so reactions and edits know whose message it is. */
export function parseSignalMessageId(id: string): { author: string; timestamp: number } | null {
  const [author, ts] = id.split('|');
  return author && /^\d+$/.test(ts ?? '') ? { author, timestamp: Number(ts) } : null;
}

export type RpcCall = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** A newline-delimited JSON-RPC connection to the signal-cli daemon. */
export class SignalRpc {
  private socket: net.Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; method: string }
  >();

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly onNotification: (method: string, params: Record<string, unknown>) => void,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.port, this.host, () => resolve());
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => this.onData(chunk));
      socket.on('error', (err) => {
        reject(err);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
      });
      socket.on('close', () => {
        this.socket = null;
      });
      this.socket = socket;
    });
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        const error = msg.error as { message?: string } | undefined;
        if (error) p.reject(new SignalRpcError(p.method, error.message ?? 'error'));
        else p.resolve((msg.result as Record<string, unknown>) ?? {});
      } else if (typeof msg.method === 'string') {
        this.onNotification(msg.method, (msg.params as Record<string, unknown>) ?? {});
      }
    }
  }

  call: RpcCall = (method, params) => {
    const socket = this.socket;
    if (!socket) return Promise.reject(new SignalRpcError(method, 'not connected to signal-cli'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SignalRpcError(method, 'timed out'));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', method, params, id })}\n`);
    });
  };
}

export function createSignalAdapter(opts: {
  account: string;
  host: string;
  port: number;
  attachmentsDir: string;
}): ChannelAdapter {
  let cfg: ChannelSetup | null = null;
  let rpc: SignalRpc | null = null;
  const seen = new SeenSet();
  const tmpDir = path.join(os.tmpdir(), 'clawbridge-signal-out');

  async function handleEnvelope(env: Envelope): Promise<void> {
    if (!cfg) return;
    const dm = env.dataMessage;
    if (!dm) return; // receipts, typing, sync messages
    const author = env.sourceNumber || env.sourceUuid || env.source;
    if (!author || author === opts.account) return;
    const ts = dm.timestamp ?? env.timestamp ?? Date.now();
    if (seen.checkAndAdd(`${author}|${ts}`)) return;

    const groupId = dm.groupInfo?.groupId;
    const isGroup = !!groupId;
    const platformId = isGroup ? `${CHANNEL_TYPE}:group.${groupId}` : `${CHANNEL_TYPE}:${author}`;
    const mentionsBot = (dm.mentions ?? []).some((m) => m.number === opts.account);
    const repliesToBot = (dm.quote?.authorNumber ?? dm.quote?.author) === opts.account;
    const isMention = !isGroup || mentionsBot || repliesToBot;

    let text = (dm.message ?? '').replace(/￼/g, '').trim();
    const files: InboundFile[] = [];
    for (const att of dm.attachments ?? []) {
      const file = path.join(opts.attachmentsDir, att.id);
      const filename = att.filename || att.id;
      const mimeType = att.contentType ?? 'application/octet-stream';
      let data: Buffer;
      try {
        data = fs.readFileSync(file);
      } catch {
        text = (text ? text + '\n' : '') + `[file] ${filename} (not available)`;
        continue;
      }
      const transcript = isAudioLike(mimeType) ? await transcribeAudio(data, filename, mimeType) : null;
      text =
        (text ? text + '\n' : '') +
        (transcript ? `[voice] ${transcript}` : `[file] ${filename} mime=${mimeType} size=${data.length}`);
      files.push({ filename, mimeType, data });
    }
    if (!text && files.length === 0) return;

    const inbound: InboundMessage = {
      id: `${author}|${ts}`,
      kind: 'chat',
      content: { text, sender: env.sourceName || author, senderId: `${CHANNEL_TYPE}:${author}` },
      timestamp: new Date(ts).toISOString(),
      isMention,
      isGroup,
      ...(files.length ? { files } : {}),
    };
    cfg.onMetadata(platformId, isGroup ? 'Signal group' : env.sourceName || author, isGroup);
    await cfg.onInbound(platformId, null, inbound);
  }

  const send = async (platformId: string, params: Record<string, unknown>) =>
    rpc!.call('send', { account: opts.account, ...signalTarget(platformId), ...params });

  return {
    name: 'signal',
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    async setup(config) {
      cfg = config;
      rpc = new SignalRpc(opts.host, opts.port, (method, params) => {
        if (method !== 'receive') return;
        void handleEnvelope((params.envelope ?? {}) as Envelope).catch((err) =>
          log.error('[signal] inbound failed', { err }),
        );
      });
      await rpc.connect();
      await rpc.call('subscribeReceive', { account: opts.account }).catch(() => undefined); // older daemons push by default
      log.info('[signal] connected to signal-cli', { account: opts.account });
    },

    async teardown() {
      rpc?.close();
      rpc = null;
    },

    isConnected: () => rpc?.connected ?? false,

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage) {
      if (!rpc) throw new SignalRpcError('send', 'not connected');
      const op = parseOutbound(message);
      if (op.op === 'reaction') {
        const target = parseSignalMessageId(op.messageId);
        const emoji = emojiFor(op.emoji);
        if (target && emoji) {
          await rpc.call('sendReaction', {
            account: opts.account,
            ...signalTarget(platformId),
            emoji,
            targetAuthor: target.author,
            targetTimestamp: target.timestamp,
          });
        }
        return undefined;
      }
      if (op.op === 'edit') {
        const target = parseSignalMessageId(op.messageId);
        if (target) {
          await send(platformId, {
            message: renderChunks(op.text, 'plain', MAX_TEXT)[0],
            editTimestamp: target.timestamp,
          });
          return op.messageId;
        }
      }
      let firstId: string | undefined;
      const text = op.op === 'text' || op.op === 'edit' ? op.text : '';
      for (const chunk of text ? renderChunks(text, 'plain', MAX_TEXT) : []) {
        const res = await send(platformId, { message: chunk });
        firstId ??= `${opts.account}|${res.timestamp}`;
      }
      const files = (message.files ?? []) as OutboundFile[];
      if (files.length) {
        fs.mkdirSync(tmpDir, { recursive: true });
        const paths = files.map((f) => {
          const p = path.join(tmpDir, `${Date.now()}-${f.filename.replace(/[^\w.-]/g, '_')}`);
          fs.writeFileSync(p, f.data);
          return p;
        });
        try {
          const res = await send(platformId, { message: '', attachments: paths });
          firstId ??= `${opts.account}|${res.timestamp}`;
        } finally {
          for (const p of paths) fs.rmSync(p, { force: true });
        }
      }
      return firstId;
    },

    async setTyping(platformId: string) {
      await rpc?.call('sendTyping', { account: opts.account, ...signalTarget(platformId) }).catch(() => undefined);
    },
  };
}

function createAdapter(): ChannelAdapter | null {
  const env = readEnvFile(['SIGNAL_ACCOUNT', 'SIGNAL_RPC', 'SIGNAL_ATTACHMENTS']);
  if (!env.SIGNAL_ACCOUNT) return null;
  const [host, port] = (env.SIGNAL_RPC || '127.0.0.1:7583').split(':');
  return createSignalAdapter({
    account: env.SIGNAL_ACCOUNT,
    host: host || '127.0.0.1',
    port: Number(port) || 7583,
    attachmentsDir: env.SIGNAL_ATTACHMENTS || path.join(os.homedir(), '.local', 'share', 'signal-cli', 'attachments'),
  });
}

registerChannelAdapter(CHANNEL_TYPE, { factory: createAdapter });
