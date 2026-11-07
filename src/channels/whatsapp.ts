/**
 * WhatsApp channel adapter — Meta Cloud API (the official Business API).
 *
 * Reads from ~/.clawbridge/.env:
 *   WHATSAPP_PHONE_NUMBER_ID      the business number's id
 *   WHATSAPP_ACCESS_TOKEN         a permanent system-user token
 *   WHATSAPP_WEBHOOK_VERIFY_TOKEN any string; Meta echoes it when you save the webhook
 *   WHATSAPP_APP_SECRET           the Meta app secret, used to verify webhook signatures
 *   WHATSAPP_GRAPH_VERSION        optional, defaults to GRAPH_VERSION below
 *
 * In your Meta app (developers.facebook.com):
 *   WhatsApp → Configuration → Callback URL: https://<public host>/webhook/whatsapp
 *   Webhook fields: messages
 *
 * Behaviour:
 *   - Every webhook POST is checked against X-Hub-Signature-256 when
 *     WHATSAPP_APP_SECRET is set (strongly recommended; doctor warns without it).
 *   - Webhooks are acknowledged at once and processed in the background;
 *     Meta's retries of the same message are dropped by message id.
 *   - Inbound messages carry `senderId: whatsapp:<wa_id>` and the contact's
 *     profile name, so access policies, approvals and per-person memory work.
 *   - Question and approval cards use reply buttons (up to 3) or a list
 *     (up to 10). The channel layer turns bigger cards into numbered replies.
 *   - Text is converted to WhatsApp formatting and split at 4096 characters.
 *   - Files are uploaded and sent as image, video, audio or document.
 *   - Every Graph API call checks the HTTP status and the error body, retries
 *     rate limits, and throws so delivery can retry instead of losing a message.
 *
 * Media handling (inbound): Meta's webhook delivers a media descriptor
 * `{id, mime_type, ...}` with no bytes. Fetching takes two requests
 * (GET /{media-id} → {url}, then GET url with the token), and the URL
 * expires after about 5 minutes, so media is fetched on receipt.
 */
import crypto from 'crypto';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { namespacedPlatformId } from '../platform-id.js';
import { registerRawWebhookHandler } from '../webhook-server.js';
import { isAudioLike, transcribeAudio } from '../transcription.js';
import type {
  ChannelAdapter,
  ChannelSetup,
  InboundFile,
  InboundMessage,
  OutboundFile,
  OutboundMessage,
} from './adapter.js';
import type { NormalizedOption } from './ask-question.js';
import { registerChannelAdapter } from './channel-registry.js';
import {
  choiceId,
  emojiFor,
  fitLabel,
  parseChoiceId,
  parseOutbound,
  renderChunks,
  resolveChoiceValue,
  SeenSet,
  toWhatsApp,
} from './render.js';

const CHANNEL_TYPE = 'whatsapp';
export const GRAPH_VERSION = 'v23.0';
const INBOUND_FILE_SIZE_CAP = 50 * 1024 * 1024; // 50 MB — matches Telegram
const WA_MAX_TEXT = 4096;
const WA_MAX_INTERACTIVE_BODY = 1024;
const WA_BUTTON_TITLE_MAX = 20;
const WA_LIST_TITLE_MAX = 24;
const WA_LIST_DESC_MAX = 72;
const MAX_RATE_LIMIT_RETRIES = 3;
/** Graph error codes that mean "slow down". */
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131048, 131056]);

/** WhatsApp message types that carry an attached media descriptor. */
const MEDIA_TYPES = ['image', 'video', 'audio', 'voice', 'document', 'sticker'] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

interface WaMediaDescriptor {
  id: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
}

export class WhatsAppApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly code: number | null,
    readonly detail: string,
  ) {
    super(`WhatsApp ${path} failed: HTTP ${status}${code !== null ? ` code ${code}` : ''} ${detail}`);
    this.name = 'WhatsAppApiError';
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Verify Meta's X-Hub-Signature-256 header (`sha256=<hex HMAC of the raw body>`). */
export function verifyWhatsAppSignature(appSecret: string, rawBody: string, header: string | null): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** Interactive payload for a question card: reply buttons when they fit, else a list. */
export function whatsappQuestionPayload(
  questionId: string,
  title: string,
  question: string,
  options: NormalizedOption[],
): Record<string, unknown> {
  const header = { type: 'text', text: fitLabel(title, 60) };
  if (options.length <= 3) {
    const truncated = options.some((o) => o.label.length > WA_BUTTON_TITLE_MAX);
    // Button titles are capped at 20 characters; spell out long options in the body.
    const legend = truncated ? `\n\n${options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}` : '';
    return {
      type: 'interactive',
      interactive: {
        type: 'button',
        header,
        body: { text: fitLabel(toWhatsApp(question || title) + legend, WA_MAX_INTERACTIVE_BODY) },
        action: {
          buttons: options.map((o, idx) => ({
            type: 'reply',
            reply: {
              id: choiceId(questionId, idx),
              title: truncated ? fitLabel(`${idx + 1}. ${o.label}`, WA_BUTTON_TITLE_MAX) : o.label,
            },
          })),
        },
      },
    };
  }
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      header,
      body: { text: fitLabel(toWhatsApp(question || title), WA_MAX_INTERACTIVE_BODY) },
      action: {
        button: 'Choose',
        sections: [
          {
            title: fitLabel(title, WA_LIST_TITLE_MAX),
            rows: options.slice(0, 10).map((o, idx) => ({
              id: choiceId(questionId, idx),
              title: fitLabel(o.label, WA_LIST_TITLE_MAX),
              ...(o.label.length > WA_LIST_TITLE_MAX ? { description: fitLabel(o.label, WA_LIST_DESC_MAX) } : {}),
            })),
          },
        ],
      },
    },
  };
}

/** Cloud API media type for an outbound file. */
export function whatsappMediaType(filename: string): 'image' | 'video' | 'audio' | 'document' {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (['jpg', 'jpeg', 'png'].includes(ext)) return 'image';
  if (['mp4', '3gp'].includes(ext)) return 'video';
  if (['ogg', 'opus', 'mp3', 'm4a', 'aac', 'amr'].includes(ext)) return 'audio';
  return 'document';
}

function mimeFor(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    mp4: 'video/mp4',
    '3gp': 'video/3gpp',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    amr: 'audio/amr',
    pdf: 'application/pdf',
    csv: 'text/csv',
    txt: 'text/plain',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return map[ext] ?? 'application/octet-stream';
}

function createAdapter(): ChannelAdapter | null {
  const env = readEnvFile([
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_GRAPH_VERSION',
  ]);
  const phoneNumberId = env['WHATSAPP_PHONE_NUMBER_ID'];
  const accessToken = env['WHATSAPP_ACCESS_TOKEN'];
  const verifyToken = env['WHATSAPP_WEBHOOK_VERIFY_TOKEN'];
  const appSecret = env['WHATSAPP_APP_SECRET'];
  const graph = `https://graph.facebook.com/${env['WHATSAPP_GRAPH_VERSION'] || GRAPH_VERSION}`;
  if (!phoneNumberId || !accessToken) return null;

  let cfg: ChannelSetup | null = null;
  let connected = false;
  const seen = new SeenSet();
  /** Latest inbound message id per chat, for read receipts and typing. */
  const lastInbound = new Map<string, string>();
  let warnedUnsigned = false;

  /** Call the Graph API; throws WhatsAppApiError on failure, retries rate limits. */
  async function graphCall(
    path: string,
    init: { method?: string; json?: unknown; form?: FormData } = {},
    fetchImpl: FetchLike = fetch,
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${graph}/${path}`, {
        method: init.method ?? (init.json || init.form ? 'POST' : 'GET'),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(init.json ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.json ? JSON.stringify(init.json) : init.form,
      });
      let body: Record<string, unknown> = {};
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        /* non-JSON body */
      }
      const error = body['error'] as { code?: number; message?: string; error_data?: { details?: string } } | undefined;
      if (res.ok && !error) return body;
      const code = typeof error?.code === 'number' ? error.code : null;
      if ((res.status === 429 || (code !== null && RATE_LIMIT_CODES.has(code))) && attempt < MAX_RATE_LIMIT_RETRIES) {
        const wait = Math.min(Number(res.headers.get('retry-after')) || 2 ** attempt, 30);
        log.warn('[whatsapp] rate limited, retrying', { path, wait, attempt });
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      throw new WhatsAppApiError(
        path,
        res.status,
        code,
        error?.error_data?.details || error?.message || `http_${res.status}`,
      );
    }
  }

  async function sendMessage(to: string, payload: Record<string, unknown>): Promise<string | undefined> {
    const res = await graphCall(`${phoneNumberId}/messages`, {
      json: { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload },
    });
    const messages = res['messages'] as Array<{ id: string }> | undefined;
    return messages?.[0]?.id;
  }

  async function sendText(to: string, markdown: string): Promise<string | undefined> {
    let first: string | undefined;
    for (const chunk of renderChunks(markdown, 'whatsapp', WA_MAX_TEXT)) {
      const id = await sendMessage(to, { type: 'text', text: { body: chunk, preview_url: true } });
      first ??= id;
    }
    return first;
  }

  async function sendFile(to: string, file: OutboundFile): Promise<string | undefined> {
    const type = whatsappMediaType(file.filename);
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeFor(file.filename));
    form.append('file', new Blob([new Uint8Array(file.data)], { type: mimeFor(file.filename) }), file.filename);
    const uploaded = await graphCall(`${phoneNumberId}/media`, { form });
    const mediaId = uploaded['id'] as string | undefined;
    if (!mediaId) throw new WhatsAppApiError(`${phoneNumberId}/media`, 200, null, 'upload returned no id');
    return sendMessage(to, {
      type,
      [type]: { id: mediaId, ...(type === 'document' ? { filename: file.filename } : {}) },
    });
  }

  /**
   * Fetch media bytes via Meta's two-step flow. Returns null on any failure —
   * the caller still adds a text hint so the agent knows media arrived.
   */
  async function waDownloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string; size: number } | null> {
    try {
      const meta = (await graphCall(mediaId)) as { url?: string; mime_type?: string; file_size?: number };
      if (!meta.url) {
        log.warn('[whatsapp] media metadata missing url', { mediaId });
        return null;
      }
      const size = typeof meta.file_size === 'number' ? meta.file_size : 0;
      if (size > INBOUND_FILE_SIZE_CAP) {
        log.warn('[whatsapp] media exceeds size cap, skipping download', { mediaId, size });
        return null;
      }
      const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!binRes.ok) {
        log.warn('[whatsapp] media bytes fetch failed', { mediaId, status: binRes.status });
        return null;
      }
      const arrayBuffer = await binRes.arrayBuffer();
      return {
        data: Buffer.from(arrayBuffer),
        mimeType: meta.mime_type ?? 'application/octet-stream',
        size: size || arrayBuffer.byteLength,
      };
    } catch (err) {
      log.warn('[whatsapp] media download failed', { mediaId, err: (err as Error).message });
      return null;
    }
  }

  /** Pick a sensible filename for a WhatsApp media descriptor. */
  function fileNameFor(type: MediaType, desc: WaMediaDescriptor): string {
    if (desc.filename) return desc.filename;
    const ext: Record<MediaType, string> = {
      image: '.jpg',
      video: '.mp4',
      audio: '.ogg',
      voice: '.ogg',
      sticker: '.webp',
      document: '',
    };
    return `${type}${ext[type]}`;
  }

  async function handleMessage(msg: Record<string, unknown>, names: Map<string, string>): Promise<void> {
    if (!cfg) return;
    const msgType = msg['type'] as string;
    const from = msg['from'] as string;
    const msgId = msg['id'] as string;
    if (!from || !msgId || seen.checkAndAdd(msgId)) return;
    const platformId = namespacedPlatformId(CHANNEL_TYPE, from);
    lastInbound.set(platformId, msgId);
    const senderId = `${CHANNEL_TYPE}:${from}`;
    const sender = names.get(from) || `+${from}`;

    // A tap on a reply button or list row answers a question card.
    if (msgType === 'interactive' || msgType === 'button') {
      const interactive = msg['interactive'] as
        | { button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string } }
        | undefined;
      const replyId =
        interactive?.button_reply?.id ??
        interactive?.list_reply?.id ??
        (msg['button'] as { payload?: string } | undefined)?.payload;
      const parsed = replyId ? parseChoiceId(replyId) : null;
      if (parsed) {
        cfg.onAction(parsed.questionId, resolveChoiceValue(parsed.questionId, parsed.idx), from);
        return;
      }
      // A template quick-reply with our own payload — treat its text as a message.
      const text =
        interactive?.button_reply?.title ??
        interactive?.list_reply?.title ??
        (msg['button'] as { text?: string } | undefined)?.text;
      if (!text) return;
      return forward(platformId, msgId, { text, sender, senderId }, []);
    }

    let text = '';
    if (msgType === 'text') text = (msg['text'] as { body?: string } | undefined)?.body ?? '';
    if (msgType === 'location') {
      const loc = msg['location'] as { latitude?: number; longitude?: number; name?: string; address?: string };
      text = `[location] ${[loc?.name, loc?.address].filter(Boolean).join(', ')} (${loc?.latitude}, ${loc?.longitude})`;
    }

    const files: InboundFile[] = [];
    if (MEDIA_TYPES.includes(msgType as MediaType)) {
      const type = msgType as MediaType;
      const desc = msg[type] as WaMediaDescriptor | undefined;
      if (desc?.id) {
        if (desc.caption) text = text ? `${text}\n${desc.caption}` : desc.caption;
        const filename = fileNameFor(type, desc);
        const downloaded = await waDownloadMedia(desc.id);
        if (downloaded) {
          const transcript = isAudioLike(downloaded.mimeType)
            ? await transcribeAudio(downloaded.data, filename, downloaded.mimeType)
            : null;
          text =
            (text ? text + '\n' : '') +
            (transcript
              ? `[voice] ${transcript}`
              : `[${type}] ${filename} mime=${downloaded.mimeType} size=${downloaded.size}`);
          files.push({ filename, mimeType: downloaded.mimeType, data: downloaded.data });
        } else {
          const mimeStr = desc.mime_type ? ` mime=${desc.mime_type}` : '';
          text = (text ? text + '\n' : '') + `[${type}] ${filename}${mimeStr} (download failed)`;
        }
      }
    }

    // Reactions, contacts, unsupported types: nothing for the agent to act on.
    if (!text && files.length === 0) return;
    return forward(platformId, msgId, { text, sender, senderId }, files, msg['timestamp'] as string | undefined);
  }

  async function forward(
    platformId: string,
    msgId: string,
    content: { text: string; sender: string; senderId: string },
    files: InboundFile[],
    timestamp?: string,
  ): Promise<void> {
    if (!cfg) return;
    const inbound: InboundMessage = {
      id: msgId,
      kind: 'chat',
      content,
      timestamp: timestamp ? new Date(Number(timestamp) * 1000).toISOString() : new Date().toISOString(),
      // Cloud API conversations are 1:1 with the business number.
      isGroup: false,
      isMention: true,
      ...(files.length > 0 ? { files } : {}),
    };
    cfg.onMetadata(platformId, content.sender, false);
    try {
      await cfg.onInbound(platformId, null, inbound);
    } catch (err) {
      log.error('[whatsapp] onInbound threw', { err });
    }
  }

  async function processWebhook(body: Record<string, unknown>): Promise<void> {
    const entries = (body['entry'] as Array<Record<string, unknown>>) ?? [];
    for (const entry of entries) {
      const changes = (entry['changes'] as Array<Record<string, unknown>>) ?? [];
      for (const change of changes) {
        const value = change['value'] as Record<string, unknown> | undefined;
        if (!value) continue;
        const names = new Map<string, string>();
        for (const c of (value['contacts'] as Array<{ wa_id?: string; profile?: { name?: string } }>) ?? []) {
          if (c.wa_id && c.profile?.name) names.set(c.wa_id, c.profile.name);
        }
        for (const st of (value['statuses'] as Array<Record<string, unknown>>) ?? []) {
          if (st['status'] === 'failed') {
            log.warn('[whatsapp] message delivery failed', { id: st['id'], errors: st['errors'] });
          }
        }
        for (const msg of (value['messages'] as Array<Record<string, unknown>>) ?? []) {
          try {
            await handleMessage(msg, names);
          } catch (err) {
            log.error('[whatsapp] inbound message failed', { err: (err as Error).message });
          }
        }
      }
    }
  }

  return {
    name: 'whatsapp',
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    async setup(config: ChannelSetup) {
      cfg = config;

      registerRawWebhookHandler('whatsapp', async (req) => {
        const url = new URL(req.url);

        // Meta webhook verification (GET request)
        if (req.method === 'GET') {
          if (!verifyToken || url.searchParams.get('hub.verify_token') !== verifyToken) {
            return new Response('Forbidden', { status: 403 });
          }
          return new Response(url.searchParams.get('hub.challenge') ?? 'OK');
        }

        const raw = await req.text();
        if (appSecret) {
          if (!verifyWhatsAppSignature(appSecret, raw, req.headers.get('x-hub-signature-256'))) {
            log.warn('[whatsapp] webhook signature mismatch — request rejected');
            return new Response('Unauthorized', { status: 401 });
          }
        } else if (!warnedUnsigned) {
          warnedUnsigned = true;
          log.warn('[whatsapp] WHATSAPP_APP_SECRET not set — webhook signatures are not being checked');
        }

        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return new Response('Bad Request', { status: 400 });
        }

        // Acknowledge now; Meta retries webhooks that are slow to answer.
        void processWebhook(body).catch((err) => log.error('[whatsapp] webhook processing failed', { err }));
        return new Response(JSON.stringify({ status: 'ok' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      });

      connected = true;
      log.info('[whatsapp] Webhook registered — set the Meta callback URL to /webhook/whatsapp');
    },

    async teardown() {
      connected = false;
    },

    isConnected: () => connected,

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage) {
      const to = platformId.startsWith(`${CHANNEL_TYPE}:`) ? platformId.slice(`${CHANNEL_TYPE}:`.length) : platformId;
      const op = parseOutbound(message);
      let firstId: string | undefined;

      if (op.op === 'reaction') {
        const emoji = emojiFor(op.emoji);
        if (emoji) await sendMessage(to, { type: 'reaction', reaction: { message_id: op.messageId, emoji } });
        return undefined;
      }
      if (op.op === 'question') {
        firstId = await sendMessage(to, whatsappQuestionPayload(op.questionId, op.title, op.question, op.options));
      } else if (op.op === 'text' || op.op === 'edit') {
        // The channel layer turns edits into new messages (WhatsApp can't edit).
        firstId = await sendText(to, op.text);
      }
      for (const f of (message.files ?? []) as OutboundFile[]) {
        const id = await sendFile(to, f);
        firstId ??= id;
      }
      return firstId;
    },

    /** Mark the user's last message read and show "typing…" (cleared by the reply or after 25 s). */
    async setTyping(platformId: string) {
      const messageId = lastInbound.get(platformId);
      if (!messageId) return;
      try {
        await graphCall(`${phoneNumberId}/messages`, {
          json: {
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: messageId,
            typing_indicator: { type: 'text' },
          },
        });
      } catch (err) {
        log.debug('[whatsapp] typing indicator failed', { err: (err as Error).message });
      }
    },
  };
}

registerChannelAdapter(CHANNEL_TYPE, { factory: createAdapter });
