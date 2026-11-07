/**
 * Email channel adapter — Postmark inbound webhook + Postmark sending API.
 *
 * Each correspondent is a conversation (`email:<address>`). Replies keep the
 * email thread (In-Reply-To / References) and the subject ("Re: …").
 *
 * Reads from ~/.clawbridge/.env:
 *   POSTMARK_SERVER_TOKEN   Postmark server API token (sending)
 *   EMAIL_FROM              the assistant's address, e.g. assistant@yourco.com
 *   EMAIL_INBOUND_TOKEN     secret for the inbound webhook URL
 *
 * In Postmark: Servers → your server → Default Inbound Stream → Settings →
 * Webhook URL: https://<public host>/webhook/email?token=<EMAIL_INBOUND_TOKEN>
 *
 * Behaviour: the quoted history is stripped (StrippedTextReply), files come
 * in and go out as attachments, Postmark's retries are dropped by MessageID,
 * and every send checks Postmark's ErrorCode so failures retry. Question
 * cards become numbered replies.
 */
import crypto from 'crypto';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerRawWebhookHandler } from '../webhook-server.js';
import type {
  ChannelAdapter,
  ChannelSetup,
  InboundFile,
  InboundMessage,
  OutboundFile,
  OutboundMessage,
} from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { parseOutbound, SeenSet, splitText, toPlain, toTelegramHtml } from './render.js';

const CHANNEL_TYPE = 'email';
const POSTMARK = 'https://api.postmarkapp.com';
const MAX_EMAIL_TEXT = 100_000;

export class EmailSendError extends Error {
  constructor(
    readonly code: number,
    detail: string,
  ) {
    super(`Email send failed (${code}): ${detail}`);
    this.name = 'EmailSendError';
  }
}

interface PostmarkInbound {
  MessageID?: string;
  From?: string;
  FromName?: string;
  FromFull?: { Email?: string; Name?: string };
  Subject?: string;
  TextBody?: string;
  StrippedTextReply?: string;
  Headers?: Array<{ Name: string; Value: string }>;
  Attachments?: Array<{ Name: string; Content: string; ContentType: string; ContentLength?: number }>;
}

/** Minimal HTML for email clients from the agent's Markdown. */
export function emailHtml(md: string): string {
  return `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">${toTelegramHtml(md).replace(/\n/g, '<br>')}</div>`;
}

export function createEmailAdapter(opts: { token: string; from: string; inboundToken: string }): ChannelAdapter {
  let cfg: ChannelSetup | null = null;
  const seen = new SeenSet();
  /** Last message we got from each correspondent: subject and Message-ID, for threading. */
  const threads = new Map<string, { subject: string; messageId: string | null }>();

  function tokenOk(given: string | null): boolean {
    if (!given) return false;
    const a = Buffer.from(opts.inboundToken);
    const b = Buffer.from(given);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async function handleInbound(mail: PostmarkInbound): Promise<void> {
    if (!cfg) return;
    const address = (mail.FromFull?.Email ?? mail.From ?? '').toLowerCase().trim();
    if (!address || address === opts.from.toLowerCase()) return;
    if (mail.MessageID && seen.checkAndAdd(mail.MessageID)) return;
    const messageIdHeader = mail.Headers?.find((h) => h.Name.toLowerCase() === 'message-id')?.Value ?? null;
    const subject = (mail.Subject ?? '').trim();
    threads.set(address, { subject, messageId: messageIdHeader });

    let text = (mail.StrippedTextReply || mail.TextBody || '').trim();
    if (subject && !/^re:/i.test(subject)) text = `Subject: ${subject}\n\n${text}`;
    const files: InboundFile[] = (mail.Attachments ?? []).map((a) => ({
      filename: a.Name,
      mimeType: a.ContentType,
      data: Buffer.from(a.Content, 'base64'),
    }));
    for (const f of files) text += `\n[file] ${f.filename} mime=${f.mimeType} size=${f.data.length}`;
    if (!text.trim() && files.length === 0) return;

    const platformId = `${CHANNEL_TYPE}:${address}`;
    const inbound: InboundMessage = {
      id: mail.MessageID ?? `email-${Date.now()}`,
      kind: 'chat',
      content: {
        text: text.trim(),
        sender: mail.FromFull?.Name || mail.FromName || address,
        senderId: `${CHANNEL_TYPE}:${address}`,
      },
      timestamp: new Date().toISOString(),
      isMention: true,
      isGroup: false,
      ...(files.length ? { files } : {}),
    };
    cfg.onMetadata(platformId, mail.FromFull?.Name || address, false);
    await cfg.onInbound(platformId, null, inbound);
  }

  return {
    name: 'email',
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    async setup(config) {
      cfg = config;
      registerRawWebhookHandler('email', async (req) => {
        const url = new URL(req.url);
        if (req.method !== 'POST' || !tokenOk(url.searchParams.get('token')))
          return new Response('Not found', { status: 404 });
        let mail: PostmarkInbound;
        try {
          mail = (await req.json()) as PostmarkInbound;
        } catch {
          return new Response('Bad Request', { status: 400 });
        }
        void handleInbound(mail).catch((err) => log.error('[email] inbound failed', { err }));
        return new Response('OK');
      });
      log.info('[email] inbound webhook ready at /webhook/email');
    },

    async teardown() {
      cfg = null;
    },

    isConnected: () => cfg !== null,

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage) {
      const to = platformId.slice(CHANNEL_TYPE.length + 1);
      const op = parseOutbound(message);
      const text = op.op === 'text' || op.op === 'edit' ? op.text : '';
      const files = (message.files ?? []) as OutboundFile[];
      if (!text && files.length === 0) return undefined;
      const thread = threads.get(to);
      const subject = thread?.subject
        ? /^re:/i.test(thread.subject)
          ? thread.subject
          : `Re: ${thread.subject}`
        : 'Message from your assistant';
      const headers = thread?.messageId
        ? [
            { Name: 'In-Reply-To', Value: thread.messageId },
            { Name: 'References', Value: thread.messageId },
          ]
        : [];
      // Very long replies go out as numbered parts within the size limit.
      const parts = text ? splitText(text, MAX_EMAIL_TEXT) : [''];
      let firstId: string | undefined;
      for (let n = 0; n < parts.length; n++) {
        const partText = parts[n];
        const partSubject = parts.length > 1 ? `${subject} (part ${n + 1} of ${parts.length})` : subject;
        const partFiles = n === 0 ? files : [];
        const payload = JSON.stringify({
          From: opts.from,
          To: to,
          Subject: partSubject,
          TextBody: toPlain(partText),
          HtmlBody: emailHtml(partText),
          Headers: headers,
          MessageStream: 'outbound',
          Attachments: partFiles.map((f) => ({
            Name: f.filename,
            Content: f.data.toString('base64'),
            ContentType: 'application/octet-stream',
          })),
        });
        let res: Response;
        let body: { ErrorCode?: number; Message?: string; MessageID?: string } = {};
        for (let attempt = 0; ; attempt++) {
          res = await fetch(`${POSTMARK}/email`, {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'X-Postmark-Server-Token': opts.token,
            },
            body: payload,
          });
          body = (await res.json().catch(() => ({}))) as typeof body;
          if (res.status === 429 && attempt < 3) {
            const wait = Math.min(Number(res.headers.get('retry-after')) || 2 ** attempt, 30);
            log.warn('[email] rate limited, retrying', { wait });
            await new Promise((r) => setTimeout(r, wait * 1000));
            continue;
          }
          break;
        }
        if (!res.ok || (body.ErrorCode ?? 0) !== 0)
          throw new EmailSendError(body.ErrorCode ?? res.status, body.Message ?? `HTTP ${res.status}`);
        firstId ??= body.MessageID;
      }
      return firstId;
    },
  };
}

function createAdapter(): ChannelAdapter | null {
  const env = readEnvFile(['POSTMARK_SERVER_TOKEN', 'EMAIL_FROM', 'EMAIL_INBOUND_TOKEN']);
  if (!env.POSTMARK_SERVER_TOKEN || !env.EMAIL_FROM || !env.EMAIL_INBOUND_TOKEN) return null;
  return createEmailAdapter({
    token: env.POSTMARK_SERVER_TOKEN,
    from: env.EMAIL_FROM,
    inboundToken: env.EMAIL_INBOUND_TOKEN,
  });
}

registerChannelAdapter(CHANNEL_TYPE, { factory: createAdapter });
