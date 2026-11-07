/**
 * Discord channel adapter — a bot on the Discord Gateway (no public URL needed).
 * Reads DISCORD_BOT_TOKEN from ~/.clawbridge/.env.
 *
 * Requires Message Content Intent enabled in the Discord Developer Portal
 * (Application → Bot → Privileged Gateway Intents → Message Content Intent).
 *
 * Behaviour:
 *   - DMs: every message reaches the agent.
 *   - Servers: a message that @mentions the bot starts a thread under that
 *     message; follow-ups inside a thread the bot started reach the agent
 *     without another mention. One thread = one conversation.
 *   - Inbound messages carry `senderId: discord:<user id>` and the member's
 *     display name, so access policies, approvals and per-person memory work.
 *   - Question and approval cards use buttons (up to 25); a click updates the
 *     card to show who chose what.
 *   - Outbound supports text (split at 2000), edits, reactions, files and
 *     the typing indicator. Errors throw so delivery can retry.
 */
import type { Message as DjsMessage } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits, Partials } from 'discord.js';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { namespacedPlatformId } from '../platform-id.js';
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
  selectedLabelFor,
} from './render.js';
import { isAudioLike, transcribeAudio } from '../transcription.js';

const CHANNEL_TYPE = 'discord';
const MAX_LEN = 2000;
const INBOUND_FILE_SIZE_CAP = 50 * 1024 * 1024; // 50 MB — matches Telegram / WhatsApp

/** Kept for callers of the old helper. */
export function splitText(text: string): string[] {
  return renderChunks(text, 'discord', MAX_LEN);
}

/** Button rows for a question card: up to 5 rows of 5. */
export function discordButtonRows(questionId: string, options: NormalizedOption[]): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const capped = options.slice(0, 25);
  for (let i = 0; i < capped.length; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    capped.slice(i, i + 5).forEach((o, j) => {
      const idx = i + j;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(choiceId(questionId, idx))
          .setLabel(fitLabel(o.label, 80))
          .setStyle(
            o.value === 'approve'
              ? ButtonStyle.Success
              : o.value === 'reject'
                ? ButtonStyle.Danger
                : ButtonStyle.Secondary,
          ),
      );
    });
    rows.push(row.toJSON() as unknown as Record<string, unknown>);
  }
  return rows;
}

/** Minimal surface of the discord.js client the adapter uses (lets tests pass a fake). */
export type DiscordClientLike = Pick<Client, 'on' | 'login' | 'destroy' | 'channels' | 'users'> & {
  user: { id: string; tag?: string } | null;
};

function strip(platformOrThread: string): string {
  return platformOrThread.startsWith(`${CHANNEL_TYPE}:`)
    ? platformOrThread.slice(CHANNEL_TYPE.length + 1)
    : platformOrThread;
}

interface Sendable {
  id: string;
  send(payload: unknown): Promise<{ id: string }>;
  sendTyping?(): Promise<unknown>;
  messages?: { fetch(id: string): Promise<DjsMessage> };
  isThread?(): boolean;
}

export function createDiscordAdapter(token: string, client: DiscordClientLike): ChannelAdapter {
  let cfg: ChannelSetup | null = null;
  let connected = false;

  function displayName(msg: DjsMessage): string {
    return msg.member?.displayName || msg.author.globalName || msg.author.username;
  }

  client.on(Events.MessageCreate, async (msg: DjsMessage) => {
    try {
      if (!cfg || msg.author.bot || !client.user) return;
      const botId = client.user.id;
      const inThread = typeof msg.channel.isThread === 'function' && msg.channel.isThread();
      const mentioned = msg.mentions.users.has(botId);

      // Where the conversation lives. Top-level server message: the channel,
      // with the message as the thread root. Inside a thread: its parent
      // channel, with the thread as the conversation.
      let platformId: string;
      let threadId: string | null = null;
      let isMention: boolean;
      if (!msg.guild) {
        platformId = namespacedPlatformId(CHANNEL_TYPE, msg.channelId);
        isMention = true;
      } else if (inThread) {
        const thread = msg.channel as unknown as { id: string; parentId: string | null; ownerId: string | null };
        platformId = namespacedPlatformId(CHANNEL_TYPE, thread.parentId ?? thread.id);
        threadId = thread.id;
        isMention = mentioned || thread.ownerId === botId;
      } else {
        platformId = namespacedPlatformId(CHANNEL_TYPE, msg.channelId);
        threadId = msg.id;
        isMention = mentioned;
      }
      if (msg.guild && !isMention) return;

      let text = msg.cleanContent || msg.content;
      if (mentioned && client.user)
        text = text.replace(new RegExp(`@${client.user.tag?.split('#')[0] ?? ''}\\s*`, 'i'), '');
      const files: InboundFile[] = [];

      // Discord delivers attachments as signed CDN links (no auth header).
      for (const attachment of msg.attachments.values()) {
        const filename = attachment.name || 'attachment';
        const mimeType = attachment.contentType ?? 'application/octet-stream';
        const size = attachment.size ?? 0;
        if (size > INBOUND_FILE_SIZE_CAP) {
          const mb = Math.round(size / 1024 / 1024);
          text = (text ? text + '\n' : '') + `[file] ${filename} (${mb}MB — exceeds inbound limit, not downloaded)`;
          continue;
        }
        try {
          const res = await fetch(attachment.url);
          if (!res.ok) {
            text = (text ? text + '\n' : '') + `[file] ${filename} mime=${mimeType} (download failed)`;
            continue;
          }
          const buf = Buffer.from(await res.arrayBuffer());
          const transcript = isAudioLike(mimeType) ? await transcribeAudio(buf, filename, mimeType) : null;
          text =
            (text ? text + '\n' : '') +
            (transcript ? `[voice] ${transcript}` : `[file] ${filename} mime=${mimeType} size=${size || buf.length}`);
          files.push({ filename, mimeType, data: buf });
        } catch (err) {
          log.warn('[discord] attachment download failed', { filename, err: (err as Error).message });
          text = (text ? text + '\n' : '') + `[file] ${filename} mime=${mimeType} (download failed)`;
        }
      }

      if (!text.trim() && files.length === 0) return;

      const inbound: InboundMessage = {
        id: msg.id,
        kind: 'chat',
        content: { text, sender: displayName(msg), senderId: `${CHANNEL_TYPE}:${msg.author.id}` },
        timestamp: new Date(msg.createdTimestamp).toISOString(),
        isMention: true,
        isGroup: !!msg.guild,
        ...(files.length > 0 ? { files } : {}),
      };

      const channelName = msg.guild
        ? `#${(msg.channel as unknown as { name?: string }).name ?? msg.channelId}`
        : `DM:${msg.author.username}`;
      cfg.onMetadata(platformId, channelName, !!msg.guild);
      await cfg.onInbound(platformId, threadId, inbound);
    } catch (err) {
      log.error('[discord] MessageCreate handler threw', { err: (err as Error).message });
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (!cfg || !interaction.isButton()) return;
      const parsed = parseChoiceId(interaction.customId);
      if (!parsed) return;
      const value = resolveChoiceValue(parsed.questionId, parsed.idx);
      const chosen = selectedLabelFor(parsed.questionId, parsed.idx) ?? value;
      const who = interaction.user.globalName || interaction.user.username;
      await interaction
        .update({
          content: `${interaction.message.content}\n\n**${chosen}** · ${who}`.slice(0, MAX_LEN),
          components: [],
        })
        .catch((err: Error) => log.debug('[discord] could not update card after click', { err: err.message }));
      cfg.onAction(parsed.questionId, value, interaction.user.id);
    } catch (err) {
      log.error('[discord] InteractionCreate handler threw', { err: (err as Error).message });
    }
  });

  client.on(Events.Error, (err) => log.error('[discord] client error', { err }));

  async function fetchSendable(id: string): Promise<Sendable | null> {
    const channel = await client.channels.fetch(id).catch(() => null);
    if (!channel || !('send' in channel) || typeof channel.send !== 'function') return null;
    return channel as unknown as Sendable;
  }

  /**
   * Resolve where a reply goes: an existing thread, or a new thread started
   * from the root message of a top-level mention (Discord gives a thread
   * started from a message the message's id).
   */
  async function target(platformId: string, threadId: string | null): Promise<Sendable> {
    const channelId = strip(platformId);
    if (threadId) {
      const existing = await fetchSendable(threadId);
      if (existing) return existing;
      const parent = await fetchSendable(channelId);
      const root = parent?.messages ? await parent.messages.fetch(threadId).catch(() => null) : null;
      if (root && typeof root.startThread === 'function') {
        const name = fitLabel(
          (root.cleanContent || 'Conversation').replace(/<@!?\d+>/g, '').trim() || 'Conversation',
          90,
        );
        const thread = await root.startThread({ name, autoArchiveDuration: 1440 });
        return thread as unknown as Sendable;
      }
      if (parent) return parent;
    }
    const channel = await fetchSendable(channelId);
    if (!channel) throw new Error(`[discord] channel ${channelId} not found`);
    return channel;
  }

  return {
    name: 'discord',
    channelType: CHANNEL_TYPE,
    supportsThreads: true,

    async setup(config: ChannelSetup) {
      cfg = config;
      await client.login(token);
      connected = true;
      log.info('[discord] Bot connected', { tag: client.user?.tag });
    },

    async teardown() {
      connected = false;
      await client.destroy();
    },

    isConnected: () => connected,

    async deliver(platformId: string, threadId: string | null, message: OutboundMessage) {
      const op = parseOutbound(message);
      const where = await target(platformId, threadId);

      if (op.op === 'edit' || op.op === 'reaction') {
        const msg = where.messages ? await where.messages.fetch(op.messageId) : null;
        if (!msg) throw new Error(`[discord] message ${op.messageId} not found`);
        if (op.op === 'edit') {
          await msg.edit(renderChunks(op.text, 'discord', MAX_LEN)[0] ?? '');
          return op.messageId;
        }
        const emoji = emojiFor(op.emoji);
        if (emoji) await msg.react(emoji);
        return undefined;
      }

      let firstId: string | undefined;
      if (op.op === 'question') {
        const body = `**${op.title}**${op.question ? `\n${op.question}` : ''}`;
        const sent = await where.send({
          content: renderChunks(body, 'discord', MAX_LEN)[0],
          components: discordButtonRows(op.questionId, op.options),
        });
        firstId = sent.id;
      } else if (op.op === 'text') {
        for (const chunk of renderChunks(op.text, 'discord', MAX_LEN)) {
          const sent = await where.send(chunk);
          firstId ??= sent.id;
        }
      }
      const files = (message.files ?? []) as OutboundFile[];
      if (files.length > 0) {
        // Discord allows 10 attachments per message.
        for (let i = 0; i < files.length; i += 10) {
          const sent = await where.send({
            files: files.slice(i, i + 10).map((f) => ({ attachment: f.data, name: f.filename })),
          });
          firstId ??= sent.id;
        }
      }
      return firstId;
    },

    async setTyping(platformId: string, threadId: string | null) {
      try {
        const where = threadId
          ? ((await fetchSendable(threadId)) ?? (await fetchSendable(strip(platformId))))
          : await fetchSendable(strip(platformId));
        await where?.sendTyping?.();
      } catch (err) {
        log.debug('[discord] typing failed', { err: (err as Error).message });
      }
    },

    async openDM(userHandle: string): Promise<string> {
      const user = await client.users.fetch(strip(userHandle));
      const dm = await user.createDM();
      return namespacedPlatformId(CHANNEL_TYPE, dm.id);
    },
  };
}

function createAdapter(): ChannelAdapter | null {
  const env = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token = env['DISCORD_BOT_TOKEN'];
  if (!token) return null;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });
  return createDiscordAdapter(token, client as unknown as DiscordClientLike);
}

registerChannelAdapter(CHANNEL_TYPE, { factory: createAdapter });
