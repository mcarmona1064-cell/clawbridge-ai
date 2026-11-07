/**
 * Telegram channel — native Bot API long-poll adapter.
 *
 * Reads TELEGRAM_BOT_TOKEN from ~/.clawbridge/.env via readEnvFile (the host
 * doesn't load it into process.env). Speaks the Telegram Bot HTTP API
 * directly via fetch — no SDK dependency.
 *
 * Inbound: a single long-poll loop calls getUpdates with timeout=25 and
 * forwards each message into onInbound. The router uses (channelType,
 * platformId) to look up the messaging_groups row, so platformId here must
 * match what setup/register.ts wrote — `telegram:<chat_id>` per the
 * namespacedPlatformId convention in src/platform-id.ts.
 *
 * Outbound: deliver() POSTs to sendMessage. setTyping uses sendChatAction.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type {
  ChannelAdapter,
  ChannelSetup,
  InboundFile,
  InboundMessage,
  OutboundFile,
  OutboundMessage,
} from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { recordNumberedPrompt } from './channel-layer.js';
import {
  choiceId,
  escapeHtml,
  fitLabel,
  numberedChoicesText,
  parseChoiceId,
  parseOutbound,
  renderChunkPairs,
  renderChunks,
  resolveChoiceValue,
  selectedLabelFor,
  toPlain,
} from './render.js';
import type { NormalizedOption } from './ask-question.js';
import { COMMAND_REGISTRY } from '../shared/commands.js';
import { interceptPairingMessage } from './telegram-pairing.js';
import { transcribeAudio } from '../transcription.js';

const API_BASE = 'https://api.telegram.org';
const LONG_POLL_TIMEOUT_S = 25;
const INBOUND_FILE_SIZE_CAP = 50 * 1024 * 1024; // 50 MB
const TG_MAX_TEXT = 4096;
const TG_CALLBACK_DATA_MAX = 64;
const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * Reactions Telegram accepts, keyed by the names agents use. Telegram only
 * allows a fixed emoji set; anything else is skipped rather than failing.
 */
const TG_REACTIONS: Record<string, string> = {
  eyes: '👀',
  white_check_mark: '👌',
  heavy_check_mark: '👌',
  ok_hand: '👌',
  thumbsup: '👍',
  '+1': '👍',
  thumbsdown: '👎',
  '-1': '👎',
  fire: '🔥',
  tada: '🎉',
  heart: '❤',
  pray: '🙏',
  thinking_face: '🤔',
  hourglass: '⚡',
  zap: '⚡',
  writing_hand: '✍',
  '100': '💯',
};

interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
}

interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TgMessageEntity {
  type: string;
  offset: number;
  length: number;
}

interface TgVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

interface TgAudio extends TgVoice {
  performer?: string;
  title?: string;
  file_name?: string;
}

interface TgVideoNote {
  file_id: string;
  file_unique_id: string;
  duration: number;
  length: number;
  file_size?: number;
}

interface TgDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TgVideo {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  duration: number;
  file_size?: number;
}

interface TgSticker {
  file_id: string;
  width: number;
  height: number;
  is_animated: boolean;
  is_video: boolean;
  emoji?: string;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: TgMessageEntity[];
  caption_entities?: TgMessageEntity[];
  voice?: TgVoice;
  audio?: TgAudio;
  video_note?: TgVideoNote;
  document?: TgDocument;
  photo?: TgPhotoSize[]; // array of sizes — largest is last
  video?: TgVideo;
  animation?: TgDocument; // Telegram sends GIFs as MP4 animations (same shape as document)
  sticker?: TgSticker;
  /** Forum topic the message belongs to (supergroups with topics enabled). */
  message_thread_id?: number;
  is_topic_message?: boolean;
  reply_to_message?: { from?: TgUser };
}

interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

/** Thrown for Bot API errors so delivery can retry or mark the message failed. */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
  ) {
    super(`Telegram ${method} failed: ${status} ${description}`);
    this.name = 'TelegramApiError';
  }
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

/** Where to send in Telegram: a chat, optionally one forum topic inside it. */
export interface TgAddress {
  chat_id: string;
  message_thread_id?: number;
}

/**
 * Forum topics are separate conversations: `telegram:<chat>:<topic>`.
 * Plain chats stay `telegram:<chat>`.
 */
export function telegramAddress(platformId: string): TgAddress {
  const rest = platformId.startsWith('telegram:') ? platformId.slice('telegram:'.length) : platformId;
  const [chat, topic] = rest.split(':');
  return topic ? { chat_id: chat, message_thread_id: Number(topic) } : { chat_id: chat };
}

function platformIdFor(chatId: number, topicId?: number): string {
  if (topicId) return `telegram:${chatId}:${topicId}`;
  // Match the form setup/register.ts writes via namespacedPlatformId('telegram', ...).
  // Router does no normalization on inbound, so we MUST emit the prefixed shape.
  return `telegram:${chatId}`;
}

function senderName(user: TgUser | undefined): string {
  if (!user) return 'telegram';
  if (user.first_name && user.last_name) return `${user.first_name} ${user.last_name}`;
  if (user.first_name) return user.first_name;
  if (user.username) return user.username;
  return `telegram:${user.id}`;
}

function detectMention(msg: TgMessage, botUsername: string | null): boolean {
  if (!botUsername) return false;
  const text = msg.text ?? msg.caption ?? '';
  const entities = msg.entities ?? msg.caption_entities ?? [];
  const needle = `@${botUsername.toLowerCase()}`;
  for (const e of entities) {
    if (e.type !== 'mention' && e.type !== 'bot_command') continue;
    const slice = text.substring(e.offset, e.offset + e.length).toLowerCase();
    if (slice.includes(needle)) return true;
  }
  return false;
}

async function tgGet<T>(
  token: string,
  method: string,
  params: Record<string, string | number>,
  attempt = 0,
): Promise<T> {
  const url = new URL(`${API_BASE}/bot${token}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new NetworkError(`fetch failed for ${method}: ${(err as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as TgResponse<T>;
  if (!res.ok || !body.ok) {
    if (res.status === 429 && body.parameters?.retry_after && attempt < MAX_RATE_LIMIT_RETRIES) {
      await new Promise((r) => setTimeout(r, Math.min(body.parameters!.retry_after!, 30) * 1000));
      return tgGet<T>(token, method, params, attempt + 1);
    }
    throw new TelegramApiError(method, res.status, body.description ?? '');
  }
  return body.result as T;
}

async function tgPost<T>(token: string, method: string, body: Record<string, unknown>, attempt = 0): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new NetworkError(`fetch failed for ${method}: ${(err as Error).message}`);
  }
  const json = (await res.json().catch(() => ({}))) as TgResponse<T>;
  if (!res.ok || !json.ok) {
    if (res.status === 429 && json.parameters?.retry_after && attempt < MAX_RATE_LIMIT_RETRIES) {
      await new Promise((r) => setTimeout(r, Math.min(json.parameters!.retry_after!, 30) * 1000));
      return tgPost<T>(token, method, body, attempt + 1);
    }
    throw new TelegramApiError(method, res.status, json.description ?? '');
  }
  return json.result as T;
}

async function tgDownloadFile(token: string, fileId: string): Promise<{ data: Buffer; filename: string } | null> {
  const info = await tgGet<TgFile>(token, 'getFile', { file_id: fileId });
  if (!info.file_path) return null;
  const url = `${API_BASE}/file/bot${token}/${info.file_path}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new NetworkError(`fetch failed for file download: ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const filename = (info.file_path.split('/').pop() ?? `${fileId}.bin`).replace(/\.oga$/, '.ogg');
  return { data: buf, filename };
}

async function tgPostMultipart<T>(
  token: string,
  method: string,
  fields: Record<string, string | number>,
  file: { field: string; filename: string; data: Buffer },
): Promise<T> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  // Buffer → Uint8Array (BlobPart) avoids a copy and works under Node 20's fetch.
  const blob = new Blob([new Uint8Array(file.data)]);
  form.append(file.field, blob, file.filename);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/bot${token}/${method}`, { method: 'POST', body: form });
  } catch (err) {
    throw new NetworkError(`fetch failed for ${method}: ${(err as Error).message}`);
  }
  const json = (await res.json().catch(() => ({}))) as TgResponse<T>;
  if (!res.ok || !json.ok) {
    throw new TelegramApiError(method, res.status, json.description ?? '');
  }
  return json.result as T;
}

/** Inline keyboard for a question card: one button per row, or two when labels are short. */
export function telegramKeyboard(
  questionId: string,
  options: NormalizedOption[],
): Array<Array<{ text: string; callback_data: string }>> | null {
  const buttons = options.map((o, idx) => ({ text: fitLabel(o.label, 64), callback_data: choiceId(questionId, idx) }));
  if (buttons.some((b) => Buffer.byteLength(b.callback_data) > TG_CALLBACK_DATA_MAX)) return null;
  const pairUp = buttons.length > 2 && buttons.every((b) => b.text.length <= 18);
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < buttons.length; i += pairUp ? 2 : 1) rows.push(buttons.slice(i, i + (pairUp ? 2 : 1)));
  return rows;
}

/** Send method and field for an outbound file, by type. */
export function telegramFileMethod(filename: string): { method: string; field: string } {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return { method: 'sendPhoto', field: 'photo' };
  if (['mp4', 'mov'].includes(ext)) return { method: 'sendVideo', field: 'video' };
  if (['ogg', 'oga', 'opus'].includes(ext)) return { method: 'sendVoice', field: 'voice' };
  if (['mp3', 'm4a', 'wav'].includes(ext)) return { method: 'sendAudio', field: 'audio' };
  return { method: 'sendDocument', field: 'document' };
}

function createAdapter(): ChannelAdapter | null {
  const { TELEGRAM_BOT_TOKEN: token } = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  if (!token) return null;

  let running = false;
  let botUsername: string | null = null;
  let lastUpdateId = 0;
  let pollPromise: Promise<void> | null = null;

  async function pollLoop(config: ChannelSetup): Promise<void> {
    while (running) {
      try {
        const updates = await tgGet<TgUpdate[]>(token, 'getUpdates', {
          offset: lastUpdateId + 1,
          timeout: LONG_POLL_TIMEOUT_S,
          allowed_updates: '["message","edited_message","callback_query"]',
        });
        for (const upd of updates) {
          // Telegram re-sends anything not yet confirmed by the offset; skip what we've handled.
          if (upd.update_id <= lastUpdateId) continue;
          lastUpdateId = upd.update_id;
          if (upd.callback_query) {
            await handleCallback(upd.callback_query, config);
            continue;
          }
          const msg = upd.message;
          if (!msg) continue;
          await handleMessage(msg, config);
        }
      } catch (err) {
        if (!running) break;
        if (err instanceof NetworkError) {
          log.warn('Telegram poll network error, backing off', { err: err.message });
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        const e = err as Error & { status?: number };
        const message = e.message || '';
        // 409 Conflict means another getUpdates session is active. Pause longer
        // — likely a stale poller from a previous launch — but don't spin.
        if (message.includes('409')) {
          log.warn('Telegram getUpdates conflict (another instance polling); waiting', { err: message });
          await new Promise((r) => setTimeout(r, 10000));
          continue;
        }
        log.error('Telegram poll error', { err: message });
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  /** A button on a question/approval card was pressed. */
  async function handleCallback(cb: TgCallbackQuery, config: ChannelSetup): Promise<void> {
    const parsed = cb.data ? parseChoiceId(cb.data) : null;
    // Always answer the callback so the client stops showing a spinner.
    await tgPost(token, 'answerCallbackQuery', { callback_query_id: cb.id }).catch(() => undefined);
    if (!parsed) return;
    const value = resolveChoiceValue(parsed.questionId, parsed.idx);
    const chosen = selectedLabelFor(parsed.questionId, parsed.idx) ?? value;
    if (cb.message) {
      const original = cb.message.text ?? '';
      await tgPost(token, 'editMessageText', {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        text: `${original}\n\n${chosen} · ${senderName(cb.from)}`.slice(0, TG_MAX_TEXT),
        reply_markup: { inline_keyboard: [] },
      }).catch((err) => log.debug('Telegram: could not update card after click', { err: (err as Error).message }));
    }
    config.onAction(parsed.questionId, value, String(cb.from.id));
  }

  async function transcribeVoice(msg: TgMessage): Promise<string | null> {
    const media = msg.voice ?? msg.audio ?? msg.video_note;
    if (!media) return null;
    try {
      const file = await tgDownloadFile(token, media.file_id);
      if (!file) return null;
      const mime =
        ('mime_type' in media && media.mime_type) ||
        (msg.voice ? 'audio/ogg' : msg.video_note ? 'video/mp4' : 'audio/mpeg');
      return await transcribeAudio(file.data, file.filename, mime);
    } catch (err) {
      log.error('Telegram: voice transcription failed', { err: (err as Error).message });
      return null;
    }
  }

  async function handleMessage(msg: TgMessage, config: ChannelSetup): Promise<void> {
    let text = msg.text ?? msg.caption ?? '';
    if (!text && (msg.voice || msg.audio || msg.video_note)) {
      const transcript = await transcribeVoice(msg);
      if (transcript) text = `[voice] ${transcript}`;
    }

    // Collect file attachments: document, photo (largest size), video, animation, sticker.
    // For every file: append a synthetic text hint for backward compat with containers that
    // don't yet parse the `files` field, and to give the agent a one-line preview.
    // Files exceeding INBOUND_FILE_SIZE_CAP are hinted but not downloaded.
    const files: InboundFile[] = [];

    async function tgCollectFile(opts: {
      fileId: string;
      fileSize?: number;
      filename: string;
      mimeType?: string;
      hintType?: string;
    }): Promise<void> {
      const { fileId, fileSize, filename, mimeType, hintType = 'document' } = opts;
      if (fileSize && fileSize > INBOUND_FILE_SIZE_CAP) {
        const mb = Math.round(fileSize / 1024 / 1024);
        text =
          (text ? text + '\n' : '') +
          `[${hintType}] ${filename} (${mb}MB — exceeds 50MB inbound limit, not downloaded)`;
        return;
      }
      const f = await tgDownloadFile(token, fileId);
      if (!f) return;
      const sizeStr = fileSize ? ` size=${fileSize}` : '';
      const mimeStr = mimeType ? ` mime=${mimeType}` : '';
      text = (text ? text + '\n' : '') + `[${hintType}] ${filename}${mimeStr}${sizeStr}`;
      files.push({ filename, mimeType, data: f.data });
    }

    if (msg.document) {
      await tgCollectFile({
        fileId: msg.document.file_id,
        fileSize: msg.document.file_size,
        filename: msg.document.file_name ?? 'file.bin',
        mimeType: msg.document.mime_type,
      });
    }
    if (msg.photo?.length) {
      const largest = msg.photo[msg.photo.length - 1];
      await tgCollectFile({
        fileId: largest.file_id,
        fileSize: largest.file_size,
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        hintType: 'photo',
      });
    }
    if (msg.video) {
      await tgCollectFile({
        fileId: msg.video.file_id,
        fileSize: msg.video.file_size,
        filename: msg.video.file_name ?? 'video.mp4',
        mimeType: msg.video.mime_type ?? 'video/mp4',
        hintType: 'video',
      });
    }
    if (msg.animation) {
      await tgCollectFile({
        fileId: msg.animation.file_id,
        fileSize: msg.animation.file_size,
        filename: msg.animation.file_name ?? 'animation.mp4',
        mimeType: msg.animation.mime_type ?? 'video/mp4',
        hintType: 'animation',
      });
    }
    if (msg.sticker) {
      const f = await tgDownloadFile(token, msg.sticker.file_id);
      if (f) {
        const filename = f.filename || 'sticker.webp';
        text = (text ? text + '\n' : '') + `[sticker] ${filename} mime=image/webp`;
        files.push({ filename, mimeType: 'image/webp', data: f.data });
      }
    }

    // Drop messages with no text and no files (e.g. unsupported sticker types)
    if (!text && files.length === 0) return;

    const platformId = platformIdFor(msg.chat.id, msg.is_topic_message ? msg.message_thread_id : undefined);
    const isGroup = msg.chat.type !== 'private';
    // Intercept pairing codes during setup — swallow the message if consumed.
    const adminUserId = msg.from ? String(msg.from.id) : undefined;
    if (interceptPairingMessage(text, platformId, isGroup, adminUserId)) return;
    // Replying to one of the bot's messages addresses it too.
    const repliesToBot =
      !!botUsername &&
      msg.reply_to_message?.from?.is_bot === true &&
      msg.reply_to_message.from.username === botUsername;
    const isMention = detectMention(msg, botUsername) || repliesToBot || msg.chat.type === 'private';

    const inbound: InboundMessage = {
      id: `tg-${msg.message_id}`,
      kind: 'chat',
      timestamp: new Date(msg.date * 1000).toISOString(),
      isMention,
      isGroup,
      content: {
        text,
        sender: senderName(msg.from),
        senderId: msg.from ? `telegram:${msg.from.id}` : `telegram:${msg.chat.id}`,
      },
      ...(files.length > 0 ? { files } : {}),
    };

    // Best-effort: surface the chat name so the host can fill in
    // messaging_groups.name on auto-create. No-op on the host side beyond a log
    // line today, but harmless and future-proof.
    const name = msg.chat.title ?? msg.chat.username ?? msg.chat.first_name;
    if (name) config.onMetadata(platformId, name, isGroup);

    try {
      await config.onInbound(platformId, null, inbound);
    } catch (err) {
      log.error('Telegram: onInbound threw', { err });
    }
  }

  /**
   * Send Markdown as Telegram HTML, split at 4096 characters. If Telegram
   * rejects the markup, resend that chunk as plain text rather than failing.
   * Returns the first message's id.
   */
  async function sendText(addr: TgAddress, markdown: string): Promise<string | undefined> {
    let first: string | undefined;
    for (const chunk of renderChunkPairs(markdown, 'telegram-html', TG_MAX_TEXT)) {
      let sent: { message_id: number };
      try {
        sent = await tgPost<{ message_id: number }>(token, 'sendMessage', {
          ...addr,
          text: chunk.out,
          parse_mode: 'HTML',
        });
      } catch (err) {
        if (!(err instanceof TelegramApiError && /can't parse entities/i.test(err.description))) throw err;
        sent = await tgPost<{ message_id: number }>(token, 'sendMessage', {
          ...addr,
          text: toPlain(chunk.md).slice(0, TG_MAX_TEXT),
        });
      }
      first ??= String(sent.message_id);
    }
    return first;
  }

  const adapter: ChannelAdapter = {
    name: 'telegram',
    channelType: 'telegram',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      // getMe doubles as a credentials check. Wrap network errors so the
      // registry's retry-on-NetworkError path engages (channel-registry.ts).
      const me = await tgGet<TgUser>(token, 'getMe', {});
      botUsername = me.username ?? null;
      // If a webhook was previously set, getUpdates returns 409. Clearing is
      // idempotent; keep_pending_updates default behavior preserves backlog.
      try {
        await tgPost(token, 'deleteWebhook', { drop_pending_updates: false });
      } catch (err) {
        log.warn('Telegram deleteWebhook failed (continuing)', { err: (err as Error).message });
      }
      log.info('Telegram bot online', { username: botUsername, id: me.id });
      try {
        const cmds = COMMAND_REGISTRY.filter((cmd) => cmd.description).map((cmd) => ({
          command: cmd.command.slice(1),
          description: cmd.description ?? '',
        }));
        await tgPost(token, 'setMyCommands', { commands: cmds });
        log.info('Telegram commands registered', { count: cmds.length });
      } catch (err) {
        log.warn('Telegram setMyCommands failed (non-fatal)', { err: (err as Error).message });
      }
      running = true;
      pollPromise = pollLoop(config);
    },

    async teardown(): Promise<void> {
      running = false;
      if (pollPromise) {
        try {
          await pollPromise;
        } catch {
          // swallow — teardown is best-effort
        }
        pollPromise = null;
      }
    },

    isConnected(): boolean {
      return running && botUsername !== null;
    },

    async deliver(platformId, threadId, message: OutboundMessage): Promise<string | undefined> {
      const addr = telegramAddress(platformId);
      const chatId = addr.chat_id;
      const files = (message.files ?? []) as OutboundFile[];
      const op = parseOutbound(message);

      if (op.op === 'edit') {
        const [html] = renderChunks(op.text, 'telegram-html', TG_MAX_TEXT);
        try {
          await tgPost(token, 'editMessageText', {
            chat_id: chatId,
            message_id: Number(op.messageId),
            text: html,
            parse_mode: 'HTML',
          });
        } catch (err) {
          if (!(err instanceof TelegramApiError && /not modified/i.test(err.description))) throw err;
        }
        return op.messageId;
      }

      if (op.op === 'reaction') {
        const emoji = TG_REACTIONS[op.emoji] ?? (/\p{Extended_Pictographic}/u.test(op.emoji) ? op.emoji : null);
        if (!emoji) return undefined;
        await tgPost(token, 'setMessageReaction', {
          chat_id: chatId,
          message_id: Number(op.messageId),
          reaction: [{ type: 'emoji', emoji }],
        });
        return undefined;
      }

      let lastMessageId: string | undefined;
      if (op.op === 'question') {
        const keyboard = telegramKeyboard(op.questionId, op.options);
        if (!keyboard) {
          recordNumberedPrompt(op.questionId, 'telegram', platformId, threadId);
          lastMessageId = await sendText(addr, numberedChoicesText(op.title, op.question, op.options));
        } else {
          const body = `<b>${escapeHtml(op.title)}</b>${op.question ? `\n${renderChunks(op.question, 'telegram-html', 3500)[0]}` : ''}`;
          const sent = await tgPost<{ message_id: number }>(token, 'sendMessage', {
            ...addr,
            text: body,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard },
          });
          lastMessageId = String(sent.message_id);
        }
      } else if (op.op === 'text') {
        lastMessageId = await sendText(addr, op.text);
      }

      for (const f of files) {
        const { method, field } = telegramFileMethod(f.filename);
        const sent = await tgPostMultipart<{ message_id: number }>(
          token,
          method,
          { ...addr },
          { field, filename: f.filename, data: f.data },
        );
        lastMessageId ??= String(sent.message_id);
      }
      return lastMessageId;
    },

    async setTyping(platformId): Promise<void> {
      const addr = telegramAddress(platformId);
      const chatId = addr.chat_id;
      try {
        await tgPost(token, 'sendChatAction', { ...addr, action: 'typing' });
      } catch (err) {
        // Typing indicators are nice-to-have — never fail the request over them.
        // Logged at INFO so silent API failures (rate limits, network blips) are visible.
        log.info('Telegram setTyping failed', { err: (err as Error).message, chatId });
      }
    },
  };

  return adapter;
}

registerChannelAdapter('telegram', { factory: createAdapter });
