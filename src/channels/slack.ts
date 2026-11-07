/**
 * Slack channel adapter — Events API webhook for inbound, Web API for outbound.
 * Reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET from ~/.clawbridge/.env.
 *
 * In your Slack app (api.slack.com/apps):
 *   Event Subscriptions → Request URL: http(s)://<host>:3000/webhook/slack
 *   Subscribe to bot events: app_mention, message.channels, message.groups,
 *     message.im, message.mpim
 *   Interactivity & Shortcuts → Request URL: the same /webhook/slack URL
 *     (approval and question buttons post back here)
 *   Bot token scopes: see SLACK_BOT_SCOPES below.
 *
 * Behaviour:
 *   - Every inbound message carries `senderId: slack:<user>` and a display
 *     name, so access policies, admin commands, approvers and per-person
 *     memory work.
 *   - Events are acknowledged immediately and processed in the background
 *     (Slack retries anything not acked within 3 s). Retries and duplicate
 *     deliveries (message + app_mention for one post) are dropped.
 *   - A top-level @mention in a channel starts a thread under that message.
 *   - Every Web API call checks HTTP status and Slack's `ok`, retries on 429
 *     with Retry-After, and throws on failure so delivery can retry.
 *   - Outbound supports text (split to Slack's limits), edits, reactions,
 *     question/approval buttons, and file uploads.
 */
import crypto from 'crypto';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { namespacedPlatformId } from '../platform-id.js';
import { registerRawWebhookHandler } from '../webhook-server.js';
import type { ChannelAdapter, ChannelSetup, InboundFile, InboundMessage, OutboundMessage } from './adapter.js';
import { normalizeOptions, type NormalizedOption } from './ask-question.js';
import { resolveChoiceValue, SeenSet } from './render.js';
import { registerChannelAdapter } from './channel-registry.js';
import { isAudioLike, transcribeAudio } from '../transcription.js';

const CHANNEL_TYPE = 'slack';
const SLACK_API = 'https://slack.com/api';
const INBOUND_FILE_SIZE_CAP = 50 * 1024 * 1024; // 50 MB — matches Telegram / WhatsApp / Discord

/** Bot token scopes the adapter uses. Setup and docs list these. */
export const SLACK_BOT_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'channels:read',
  'chat:write',
  'files:read',
  'files:write',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'im:write',
  'mpim:history',
  'mpim:read',
  'reactions:write',
  'users:read',
] as const;

/** Slack's markdown block holds up to 12,000 characters; leave headroom. */
export const SLACK_MAX_MARKDOWN = 11_000;
/** `text` is the notification/fallback field; Slack truncates past 40k. */
const SLACK_MAX_FALLBACK = 3_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_AFTER_S = 30;
const USER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly slackError: string,
    readonly status: number,
  ) {
    super(`Slack ${method} failed: ${slackError} (HTTP ${status})`);
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Call a Slack Web API method. Throws SlackApiError on HTTP errors or
 * `ok: false`, and retries 429s up to MAX_RATE_LIMIT_RETRIES times.
 */
export async function slackApiCall(
  token: string,
  method: string,
  body: Record<string, unknown>,
  opts: { fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Record<string, unknown>> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryAfter = Math.min(Number(res.headers.get('retry-after')) || 1, MAX_RETRY_AFTER_S);
      log.warn('[slack] rate limited, retrying', { method, retryAfter, attempt });
      await sleep(retryAfter * 1000);
      continue;
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok || json['ok'] !== true) {
      throw new SlackApiError(method, String(json['error'] ?? `http_${res.status}`), res.status);
    }
    return json;
  }
}

/** Split text into chunks no longer than `limit`, preferring paragraph and line breaks. */
export function splitSlackText(text: string, limit = SLACK_MAX_MARKDOWN): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/** One chat.postMessage body for a markdown chunk. */
export function markdownMessage(text: string): { text: string; blocks: unknown[] } {
  return {
    text: text.length > SLACK_MAX_FALLBACK ? `${text.slice(0, SLACK_MAX_FALLBACK - 1)}…` : text,
    blocks: [{ type: 'markdown', text }],
  };
}

/** Block Kit card for an ask_question / approval with one button per option. */
export function questionMessage(
  questionId: string,
  title: string,
  question: string,
  options: NormalizedOption[],
): { text: string; blocks: unknown[] } {
  return {
    text: `${title}: ${question}`.slice(0, SLACK_MAX_FALLBACK),
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: title.slice(0, 150), emoji: true } },
      // A markdown block renders the agent's standard Markdown (section mrkdwn would not).
      ...(question ? [{ type: 'markdown', text: question.slice(0, 11_000) }] : []),
      {
        type: 'actions',
        block_id: `ncq:${questionId}`,
        elements: options.slice(0, 25).map((opt, idx) => ({
          type: 'button',
          action_id: `ncq:${questionId}:${idx}`,
          value: String(idx),
          text: { type: 'plain_text', text: opt.label.slice(0, 75), emoji: true },
          ...(opt.value === 'approve' ? { style: 'primary' } : opt.value === 'reject' ? { style: 'danger' } : {}),
        })),
      },
    ],
  };
}

/** Resolve a clicked button back to the option's real value. */
export const resolveSlackOption = resolveChoiceValue;

export { SeenSet };

function createAdapter(): ChannelAdapter | null {
  const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']);
  const token = env['SLACK_BOT_TOKEN'];
  const signingSecret = env['SLACK_SIGNING_SECRET'];
  if (!token || !signingSecret) return null;

  let cfg: ChannelSetup | null = null;
  let botUserId: string | null = null;
  let connected = false;
  const seen = new SeenSet();
  const userNames = new Map<string, { name: string | null; at: number }>();

  const api = (method: string, body: Record<string, unknown>) => slackApiCall(token, method, body);

  async function verifySignature(req: Request, body: string): Promise<boolean> {
    const ts = req.headers.get('x-slack-request-timestamp');
    const sig = req.headers.get('x-slack-signature');
    if (!ts || !sig) return false;
    if (Math.abs(Date.now() / 1000 - parseInt(ts, 10)) > 300) return false;
    const hmac = crypto.createHmac('sha256', signingSecret).update(`v0:${ts}:${body}`).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(`v0=${hmac}`));
    } catch {
      return false;
    }
  }

  /** Display name for a Slack user, cached; null if users.info fails. */
  async function displayName(userId: string): Promise<string | null> {
    const cached = userNames.get(userId);
    if (cached && Date.now() - cached.at < USER_CACHE_TTL_MS) return cached.name;
    let name: string | null = null;
    try {
      const res = await api('users.info', { user: userId });
      const user = res['user'] as Record<string, unknown> | undefined;
      const profile = user?.['profile'] as Record<string, unknown> | undefined;
      name =
        (profile?.['display_name'] as string) ||
        (profile?.['real_name'] as string) ||
        (user?.['real_name'] as string) ||
        (user?.['name'] as string) ||
        null;
    } catch (err) {
      log.debug('[slack] users.info failed', { userId, err: (err as Error).message });
    }
    userNames.set(userId, { name, at: Date.now() });
    return name;
  }

  async function downloadFiles(
    eventFiles: SlackFile[],
    initialText: string,
  ): Promise<{ text: string; files: InboundFile[] }> {
    let text = initialText;
    const files: InboundFile[] = [];
    for (const file of eventFiles) {
      const filename = file.name || file.title || `file.${file.filetype ?? 'bin'}`;
      const mimeType = file.mimetype ?? 'application/octet-stream';
      const size = file.size ?? 0;
      if (size > INBOUND_FILE_SIZE_CAP) {
        const mb = Math.round(size / 1024 / 1024);
        text = (text ? text + '\n' : '') + `[file] ${filename} (${mb}MB — exceeds inbound limit, not downloaded)`;
        continue;
      }
      const downloadUrl = file.url_private_download ?? file.url_private;
      if (!downloadUrl) {
        text = (text ? text + '\n' : '') + `[file] ${filename} mime=${mimeType} (no url)`;
        continue;
      }
      try {
        const res = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) {
          log.warn('[slack] file fetch failed', { filename, status: res.status });
          text = (text ? text + '\n' : '') + `[file] ${filename} mime=${mimeType} (download failed)`;
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (isAudioLike(mimeType)) {
          const transcript = await transcribeAudio(buf, filename, mimeType);
          if (transcript) {
            text = (text ? text + '\n' : '') + `[voice] ${transcript}`;
            files.push({ filename, mimeType, data: buf });
            continue;
          }
        }
        text = (text ? text + '\n' : '') + `[file] ${filename} mime=${mimeType} size=${size || buf.length}`;
        files.push({ filename, mimeType, data: buf });
      } catch (err) {
        log.warn('[slack] file download threw', { filename, err: (err as Error).message });
        text = (text ? text + '\n' : '') + `[file] ${filename} mime=${mimeType} (download failed)`;
      }
    }
    return { text, files };
  }

  /** Process one Events API event (after the HTTP ack). */
  async function handleEvent(event: Record<string, unknown>): Promise<void> {
    const type = event['type'] as string;
    if (type !== 'message' && type !== 'app_mention') return;
    // File uploads arrive as message/file_share; skip edits, deletes, joins, etc.
    const subtype = event['subtype'] as string | undefined;
    if (subtype && subtype !== 'file_share') return;
    // Ignore our own and other bots' messages.
    if (event['bot_id'] || !event['user'] || event['user'] === botUserId) return;

    const channelId = event['channel'] as string;
    const ts = event['ts'] as string;
    // A post that mentions the bot arrives twice (message.* and app_mention).
    if (seen.checkAndAdd(`msg:${channelId}:${ts}`)) return;

    const userId = event['user'] as string;
    const channelType = event['channel_type'] as string | undefined;
    // app_mention events carry no channel_type; they only happen in conversations with others.
    const isGroup = type === 'app_mention' ? true : channelType !== 'im';
    const rawText = (event['text'] as string) ?? '';
    const mentionsBot = type === 'app_mention' || (botUserId ? rawText.includes(`<@${botUserId}>`) : false);
    const isMention = !isGroup || mentionsBot;

    const { text, files } = await downloadFiles((event['files'] as SlackFile[] | undefined) ?? [], rawText);
    if (!text && files.length === 0) return;

    // A top-level @mention in a channel starts a thread under that message.
    const existingThread = (event['thread_ts'] as string | undefined) ?? null;
    const threadTs = existingThread ?? (isGroup && mentionsBot ? ts : null);

    const sender = await displayName(userId);
    const inbound: InboundMessage = {
      id: ts,
      kind: 'chat',
      content: { text, senderId: `slack:${userId}`, ...(sender ? { sender, senderName: sender } : {}) },
      timestamp: new Date(parseFloat(ts) * 1000).toISOString(),
      isMention,
      isGroup,
      ...(files.length > 0 ? { files } : {}),
    };

    if (cfg) {
      const platformId = namespacedPlatformId(CHANNEL_TYPE, channelId);
      cfg.onMetadata(platformId, channelId, isGroup);
      await cfg.onInbound(platformId, threadTs, inbound);
    }
  }

  /** Process an interactivity payload (button clicks). */
  async function handleInteraction(payload: Record<string, unknown>): Promise<void> {
    if (payload['type'] !== 'block_actions' || !cfg) return;
    const user = payload['user'] as Record<string, unknown> | undefined;
    const clicker = (user?.['id'] as string) ?? '';
    const actions = (payload['actions'] as Array<Record<string, unknown>> | undefined) ?? [];
    for (const action of actions) {
      const actionId = (action['action_id'] as string) ?? '';
      if (!actionId.startsWith('ncq:')) continue;
      const parts = actionId.split(':');
      if (parts.length < 3) continue;
      const questionId = parts[1];
      const value = (action['value'] as string | undefined) ?? parts.slice(2).join(':');
      const selected = resolveSlackOption(questionId, value);
      // Raw platform user id; the host namespaces it with the channel type.
      cfg.onAction(questionId, selected, clicker);

      // Replace the buttons with the outcome so the card can't be clicked twice.
      const container = payload['container'] as Record<string, unknown> | undefined;
      const channelId = container?.['channel_id'] as string | undefined;
      const messageTs = container?.['message_ts'] as string | undefined;
      if (channelId && messageTs) {
        const label =
          selected === 'approve' ? '✅ Approved' : selected === 'reject' ? '❌ Rejected' : `Selected: ${selected}`;
        api('chat.update', {
          channel: channelId,
          ts: messageTs,
          text: `${label} by <@${clicker}>`,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${label} by <@${clicker}>` } }],
        }).catch((err) => log.warn('[slack] could not update clicked card', { err: (err as Error).message }));
      }
    }
  }

  async function uploadFiles(
    channelId: string,
    threadTs: string | null,
    files: NonNullable<OutboundMessage['files']>,
  ): Promise<void> {
    const uploaded: Array<{ id: string; title: string }> = [];
    for (const file of files) {
      const ticket = await api('files.getUploadURLExternal', { filename: file.filename, length: file.data.length });
      const res = await fetch(ticket['upload_url'] as string, { method: 'POST', body: new Uint8Array(file.data) });
      if (!res.ok) throw new SlackApiError('files.upload', `http_${res.status}`, res.status);
      uploaded.push({ id: ticket['file_id'] as string, title: file.filename });
    }
    await api('files.completeUploadExternal', {
      files: uploaded,
      channel_id: channelId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }

  return {
    name: 'slack',
    channelType: CHANNEL_TYPE,
    supportsThreads: true,

    async setup(config: ChannelSetup) {
      cfg = config;

      try {
        const auth = await api('auth.test', {});
        botUserId = (auth['user_id'] as string) ?? null;
        log.info('[slack] Authenticated', { user: auth['user'], team: auth['team'] });
      } catch (err) {
        log.warn('[slack] Could not verify bot token', { err: (err as Error).message });
      }

      registerRawWebhookHandler('slack', async (req) => {
        const body = await req.text();

        if (!(await verifySignature(req, body))) {
          log.warn('[slack] Webhook signature verification failed');
          return new Response('Unauthorized', { status: 401 });
        }

        // Interactivity payloads (button clicks) are form-encoded: payload=<json>.
        if (body.startsWith('payload=')) {
          try {
            const payload = JSON.parse(new URLSearchParams(body).get('payload') ?? '{}') as Record<string, unknown>;
            void handleInteraction(payload).catch((err) => log.error('[slack] interaction failed', { err }));
          } catch (err) {
            log.warn('[slack] bad interactivity payload', { err: (err as Error).message });
          }
          return new Response('');
        }

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(body) as Record<string, unknown>;
        } catch {
          return new Response('Bad Request', { status: 400 });
        }

        if (payload['type'] === 'url_verification') {
          return new Response(JSON.stringify({ challenge: payload['challenge'] }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (payload['type'] === 'event_callback') {
          // Slack re-sends events it thinks we missed; process each event_id once.
          const eventId = payload['event_id'] as string | undefined;
          if (eventId && seen.checkAndAdd(`evt:${eventId}`)) return new Response('OK');
          const event = payload['event'] as Record<string, unknown> | undefined;
          // Ack now; Slack retries anything not acknowledged within 3 seconds.
          if (event) void handleEvent(event).catch((err) => log.error('[slack] event handling failed', { err }));
        }

        return new Response('OK');
      });

      connected = true;
      log.info('[slack] Webhook handler ready — set Slack Event and Interactivity URLs to /webhook/slack');
    },

    async teardown() {
      connected = false;
    },

    isConnected: () => connected,

    async deliver(platformId: string, threadId: string | null, message: OutboundMessage) {
      const channelId = platformId.startsWith(`${CHANNEL_TYPE}:`)
        ? platformId.slice(`${CHANNEL_TYPE}:`.length)
        : platformId;
      const content = (message.content ?? {}) as Record<string, unknown>;
      const thread = threadId ? { thread_ts: threadId } : {};

      if (content.operation === 'edit' && content.messageId) {
        const text = (content.text as string) || (content.markdown as string) || '';
        await api('chat.update', {
          channel: channelId,
          ts: content.messageId,
          ...markdownMessage(text.slice(0, SLACK_MAX_MARKDOWN)),
        });
        return content.messageId as string;
      }

      if (content.operation === 'reaction' && content.messageId && content.emoji) {
        const name = String(content.emoji).replace(/^:|:$/g, '');
        try {
          await api('reactions.add', { channel: channelId, timestamp: content.messageId, name });
        } catch (err) {
          // Reacting twice with the same emoji is not a delivery failure.
          if (!(err instanceof SlackApiError && err.slackError === 'already_reacted')) throw err;
        }
        return undefined;
      }

      if (content.type === 'ask_question' && content.questionId && content.options) {
        const title = content.title as string;
        if (!title) {
          log.error('[slack] ask_question missing title — skipping delivery', { questionId: content.questionId });
          return undefined;
        }
        const options = normalizeOptions(content.options as never);
        const res = await api('chat.postMessage', {
          channel: channelId,
          ...thread,
          ...questionMessage(content.questionId as string, title, (content.question as string) ?? '', options),
        });
        return res['ts'] as string | undefined;
      }

      const text = (content.markdown as string) || (content.text as string) || '';
      let firstTs: string | undefined;
      if (text) {
        for (const chunk of splitSlackText(text)) {
          const res = await api('chat.postMessage', { channel: channelId, ...thread, ...markdownMessage(chunk) });
          firstTs ??= res['ts'] as string | undefined;
        }
      }
      if (message.files && message.files.length > 0) {
        await uploadFiles(channelId, threadId, message.files);
      }
      return firstTs;
    },

    async openDM(userHandle: string): Promise<string> {
      const user = userHandle.startsWith(`${CHANNEL_TYPE}:`) ? userHandle.slice(`${CHANNEL_TYPE}:`.length) : userHandle;
      const res = await api('conversations.open', { users: user });
      const channel = res['channel'] as Record<string, unknown> | undefined;
      const id = channel?.['id'] as string | undefined;
      if (!id) throw new SlackApiError('conversations.open', 'no_channel', 200);
      return namespacedPlatformId(CHANNEL_TYPE, id);
    },
  };
}

registerChannelAdapter(CHANNEL_TYPE, { factory: createAdapter });
