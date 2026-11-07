/**
 * iMessage channel adapter — native, macOS only.
 *
 * Reads new messages from the Messages database (~/Library/Messages/chat.db,
 * read-only) and sends with AppleScript through the Messages app, signed in
 * with the Apple ID the assistant should use (a separate Mac user or Apple ID
 * is recommended).
 *
 * Needs, on the Mac that runs ClawBridge:
 *   - Messages signed in to iMessage
 *   - Full Disk Access for the process running ClawBridge (to read chat.db)
 *   - Automation permission to control Messages (asked on first send)
 *
 * Reads from ~/.clawbridge/.env:
 *   IMESSAGE_ENABLED=true     turn the channel on
 *   IMESSAGE_DB               optional path to chat.db
 *
 * Behaviour: DMs and group chats; in groups, a message is addressed to the
 * agent when it says the assistant's name (iMessage has no mentions for
 * bots). Sender id `imessage:<phone or email>`. Plain text; question cards
 * become numbered replies; files are sent as attachments. Only messages that
 * arrive after start are read; history is never replayed.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundFile, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { parseOutbound, renderChunks } from './render.js';

const CHANNEL_TYPE = 'imessage';
const POLL_MS = 2000;
const MAX_TEXT = 10_000;
/** Messages stores dates as nanoseconds since 2001-01-01. */
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

export type ScriptRunner = (script: string) => Promise<string>;

export const osascript: ScriptRunner = (script) =>
  new Promise((resolve, reject) =>
    execFile('osascript', ['-e', script], { timeout: 30_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout),
    ),
  );

/** Quote a string for AppleScript. */
export function asString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

/** AppleScript that sends text (or a file) to a chat id or a person. */
export function sendScript(
  target: { chatGuid: string; handle?: string },
  payload: { text?: string; file?: string },
): string {
  const what = payload.file ? `POSIX file ${asString(payload.file)}` : asString(payload.text ?? '');
  // A DM guid looks like "iMessage;-;+15551234567"; sending to the participant is the most reliable for DMs.
  if (target.handle) {
    return `tell application "Messages" to send ${what} to participant ${asString(target.handle)} of (1st account whose service type = iMessage)`;
  }
  return `tell application "Messages" to send ${what} to chat id ${asString(target.chatGuid)}`;
}

/** Text of a message: the `text` column, or (newer macOS) the string inside `attributedBody`. */
export function messageText(text: string | null, attributedBody: Buffer | null): string {
  if (text) return text;
  if (!attributedBody) return '';
  const marker = attributedBody.indexOf('NSString');
  if (marker < 0) return '';
  let i = attributedBody.indexOf(0x2b, marker); // '+' precedes the length
  if (i < 0) return '';
  i++;
  let len = attributedBody[i];
  i++;
  if (len === 0x81) {
    len = attributedBody.readUInt16LE(i);
    i += 2;
  } else if (len === 0x82) {
    len = attributedBody.readUInt32LE(i);
    i += 4;
  }
  return attributedBody.subarray(i, i + len).toString('utf8');
}

interface Row {
  rowid: number;
  guid: string;
  text: string | null;
  attributedBody: Buffer | null;
  date: number;
  sender: string | null;
  chat_guid: string;
  style: number;
  display_name: string | null;
}

const QUERY = `
  SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.date, h.id AS sender,
         c.guid AS chat_guid, c.style, c.display_name
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c ON c.ROWID = cmj.chat_id
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.ROWID > ? AND m.is_from_me = 0
  ORDER BY m.ROWID LIMIT 200`;

export function createIMessageAdapter(opts: {
  dbPath: string;
  assistantName: string;
  run?: ScriptRunner;
  pollMs?: number;
}): ChannelAdapter {
  const run = opts.run ?? osascript;
  let cfg: ChannelSetup | null = null;
  let db: Database.Database | null = null;
  let lastRow = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const handles = new Map<string, string>(); // chat guid → handle, for DMs
  const nameRe = new RegExp(`\\b${opts.assistantName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');

  async function poll(): Promise<void> {
    if (!db || !cfg) return;
    const rows = db.prepare(QUERY).all(lastRow) as Row[];
    for (const r of rows) {
      lastRow = Math.max(lastRow, r.rowid);
      const text = messageText(r.text, r.attributedBody).replace(/￼/g, '').trim();
      if (!text || !r.sender) continue;
      const isGroup = r.style === 43 || r.chat_guid.includes(';+;');
      if (!isGroup) handles.set(r.chat_guid, r.sender);
      const platformId = `${CHANNEL_TYPE}:${r.chat_guid}`;
      const inbound: InboundMessage = {
        id: r.guid,
        kind: 'chat',
        content: { text, sender: r.sender, senderId: `${CHANNEL_TYPE}:${r.sender}` },
        timestamp: new Date(APPLE_EPOCH_MS + Math.floor(r.date / 1e6)).toISOString(),
        isMention: !isGroup || nameRe.test(text),
        isGroup,
      };
      cfg.onMetadata(platformId, r.display_name ?? r.sender, isGroup);
      await cfg.onInbound(platformId, null, inbound);
    }
  }

  return {
    name: 'imessage',
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    async setup(config) {
      cfg = config;
      db = new Database(opts.dbPath, { readonly: true, fileMustExist: true });
      lastRow = (db.prepare('SELECT COALESCE(MAX(ROWID), 0) AS m FROM message').get() as { m: number }).m;
      timer = setInterval(
        () => void poll().catch((err) => log.warn('[imessage] poll failed', { err })),
        opts.pollMs ?? POLL_MS,
      );
      log.info('[imessage] reading Messages from', { db: opts.dbPath, from: lastRow });
    },

    async teardown() {
      if (timer) clearInterval(timer);
      timer = null;
      db?.close();
      db = null;
    },

    isConnected: () => db !== null,

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage) {
      const chatGuid = platformId.slice(CHANNEL_TYPE.length + 1);
      const handle = handles.get(chatGuid) ?? (chatGuid.includes(';-;') ? chatGuid.split(';-;')[1] : undefined);
      const target = { chatGuid, handle };
      const op = parseOutbound(message);
      if (op.op === 'text' || op.op === 'edit') {
        for (const chunk of renderChunks(op.text, 'plain', MAX_TEXT)) await run(sendScript(target, { text: chunk }));
      }
      const files = (message.files ?? []) as OutboundFile[];
      if (files.length) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbridge-imessage-'));
        for (const f of files) {
          const p = path.join(dir, f.filename.replace(/[^\w.-]/g, '_'));
          fs.writeFileSync(p, f.data);
          await run(sendScript(target, { file: p }));
        }
      }
      return undefined; // Messages doesn't return an id to AppleScript
    },
  };
}

function createAdapter(): ChannelAdapter | null {
  const env = readEnvFile(['IMESSAGE_ENABLED', 'IMESSAGE_DB', 'ASSISTANT_NAME']);
  if (env.IMESSAGE_ENABLED !== 'true' || process.platform !== 'darwin') return null;
  return createIMessageAdapter({
    dbPath: env.IMESSAGE_DB || path.join(os.homedir(), 'Library', 'Messages', 'chat.db'),
    assistantName: env.ASSISTANT_NAME || 'assistant',
  });
}

registerChannelAdapter(CHANNEL_TYPE, { factory: createAdapter });
