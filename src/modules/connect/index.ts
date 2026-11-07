/**
 * /connect <channel> — add a channel from chat, no terminal needed.
 *
 * An owner or global admin sends `/connect whatsapp` (or slack, telegram,
 * discord) in a DM with the agent. The host walks them through the
 * platform's screens one step at a time, checks each credential with the
 * platform, saves it to ~/.clawbridge/.env and starts the channel on the
 * spot.
 *
 * Secrets typed during the flow are caught by the host before routing: they
 * never reach the agent, its memory or the session history. The flow lives
 * only in memory and expires after 15 minutes. The person is reminded to
 * delete the messages that held tokens, since the chat app keeps them.
 */
import {
  checkDiscordToken,
  checkSlackAppToken,
  checkSlackBotToken,
  checkTelegramToken,
  checkWhatsApp,
  discordInviteUrl,
  loadSlackManifest,
  newVerifyToken,
  slackManifestUrl,
  type CheckResult,
} from '../../channels/credential-checks.js';
import { startChannelAdapter } from '../../channels/channel-registry.js';
import { audit } from '../../audit.js';
import { setEnvValues } from '../../env.js';
import { log } from '../../log.js';
import { isGlobalAdmin, isOwner } from '../permissions/db/user-roles.js';

const FLOW_TTL_MS = 15 * 60 * 1000;

interface Step {
  key: string;
  ask: string;
  /** Quick format check before calling the platform. */
  format?: (v: string) => string | null;
}

interface ChannelSpec {
  label: string;
  intro: (appName: string) => string;
  steps: Step[];
  check: (v: Record<string, string>) => Promise<CheckResult>;
  /** Extra env values derived after a successful check. */
  extra?: (v: Record<string, string>, result: Extract<CheckResult, { ok: true }>) => Record<string, string>;
  done: (v: Record<string, string>, result: Extract<CheckResult, { ok: true }>) => string;
}

export const CHANNELS: Record<string, ChannelSpec> = {
  telegram: {
    label: 'Telegram',
    intro: () =>
      'In Telegram, open @BotFather, send /newbot, pick a name and a username ending in "bot". It gives you a token.',
    steps: [
      {
        key: 'TELEGRAM_BOT_TOKEN',
        ask: 'Paste the bot token here.',
        format: (v) => (/^\d+:[\w-]{30,}$/.test(v) ? null : 'A Telegram token looks like 123456789:ABC…'),
      },
    ],
    check: (v) => checkTelegramToken(v.TELEGRAM_BOT_TOKEN),
    done: (_v, r) => `Telegram is connected as ${r.detail}. Open it in Telegram and say hi.`,
  },
  slack: {
    label: 'Slack',
    intro: (appName) =>
      [
        'Open this link. It creates the Slack app with everything set up:',
        slackManifestUrl(loadSlackManifest(appName)),
        '',
        'Pick your workspace → Create → Install to Workspace → Allow. Then OAuth & Permissions → copy the Bot User OAuth Token (xoxb-…).',
      ].join('\n'),
    steps: [
      {
        key: 'SLACK_BOT_TOKEN',
        ask: 'Paste the bot token (xoxb-…).',
        format: (v) => (v.startsWith('xoxb-') ? null : 'The bot token starts with xoxb-'),
      },
      {
        key: 'SLACK_APP_TOKEN',
        ask: 'Now Basic Information → App-Level Tokens → Generate, with scope connections:write. Paste that token (xapp-…).',
        format: (v) => (v.startsWith('xapp-') ? null : 'The app-level token starts with xapp-'),
      },
    ],
    check: async (v) => {
      const bot = await checkSlackBotToken(v.SLACK_BOT_TOKEN);
      if (!bot.ok) return bot;
      const app = await checkSlackAppToken(v.SLACK_APP_TOKEN);
      return app.ok ? bot : app;
    },
    done: (_v, r) => `Slack is connected (${r.detail}). DM the bot, or invite it to a channel and @mention it.`,
  },
  whatsapp: {
    label: 'WhatsApp',
    intro: () =>
      [
        'This uses the official WhatsApp Business Cloud API.',
        '1. developers.facebook.com → Create app → "Connect with customers through WhatsApp".',
        '2. WhatsApp → API Setup: copy the Phone number ID (not the phone number).',
      ].join('\n'),
    steps: [
      {
        key: 'WHATSAPP_PHONE_NUMBER_ID',
        ask: 'Paste the Phone number ID.',
        format: (v) => (/^\d{6,}$/.test(v) ? null : 'The Phone number ID is digits only'),
      },
      {
        key: 'WHATSAPP_ACCESS_TOKEN',
        ask: 'Business Settings → System Users → Generate token (whatsapp_business_messaging, whatsapp_business_management). Paste it.',
      },
      {
        key: 'WHATSAPP_APP_SECRET',
        ask: 'App settings → Basic → App secret → Show. Paste it (it lets me reject forged messages).',
        format: (v) => (/^[a-f0-9]{32}$/i.test(v) ? null : 'The App secret is 32 letters and digits'),
      },
    ],
    check: (v) => checkWhatsApp(v.WHATSAPP_PHONE_NUMBER_ID, v.WHATSAPP_ACCESS_TOKEN),
    extra: () => ({ WHATSAPP_WEBHOOK_VERIFY_TOKEN: newVerifyToken() }),
    done: (v, r) =>
      [
        `WhatsApp is connected: ${r.detail}.`,
        'Last step, in Meta → WhatsApp → Configuration:',
        '• Callback URL: your public address + /webhook/whatsapp (run `clawbridge-ai tunnel` on the host if you have none)',
        `• Verify token: ${v.WHATSAPP_WEBHOOK_VERIFY_TOKEN}`,
        '• Subscribe to: messages',
        `Then message ${r.detail.replace(/^.*\(|\)$/g, '')} on WhatsApp.`,
      ].join('\n'),
  },
  discord: {
    label: 'Discord',
    intro: () =>
      'discord.com/developers/applications → New Application. Bot → turn on Message Content Intent → Save → Reset Token.',
    steps: [{ key: 'DISCORD_BOT_TOKEN', ask: 'Paste the bot token.' }],
    check: (v) => checkDiscordToken(v.DISCORD_BOT_TOKEN),
    done: (_v, r) =>
      `Discord is connected as ${r.detail}. Add it to your server with this link, then @mention it:\n${discordInviteUrl(r.extra!.applicationId)}`,
  },
};

interface Flow {
  channel: string;
  step: number;
  values: Record<string, string>;
  startedAt: number;
}

const flows = new Map<string, Flow>();
const keyOf = (channelType: string, platformId: string, userId: string) => `${channelType}|${platformId}|${userId}`;

export interface ConnectInput {
  channelType: string;
  platformId: string;
  text: string;
  senderId: string | null;
  isGroup: boolean;
  agentName: string;
}

/** Is this message part of (or the start of) a /connect flow? */
export function isConnectMessage(
  input: Pick<ConnectInput, 'channelType' | 'platformId' | 'text' | 'senderId'>,
): boolean {
  if (/^\/connect\b/i.test(input.text.trim())) return true;
  if (!input.senderId) return false;
  const flow = flows.get(keyOf(input.channelType, input.platformId, input.senderId));
  return !!flow && Date.now() - flow.startedAt < FLOW_TTL_MS;
}

const DELETE_HINT = 'Tip: delete the messages that contained tokens from this chat — the app keeps them.';

/** Handle one message of a /connect flow. Returns the reply (never null for a connect message). */
export async function handleConnect(input: ConnectInput): Promise<string> {
  const me = input.senderId;
  const text = input.text.trim();
  const key = me ? keyOf(input.channelType, input.platformId, me) : '';

  if (/^\/connect\b/i.test(text)) {
    if (!me || !(isOwner(me) || isGlobalAdmin(me))) return 'Only the owner or an admin can connect channels.';
    if (input.isGroup) return 'Send /connect to me in a direct message — you will paste tokens, so keep it private.';
    const channel = text.split(/\s+/)[1]?.toLowerCase();
    const spec = channel ? CHANNELS[channel] : undefined;
    if (!spec) return `Which one? /connect ${Object.keys(CHANNELS).join(', /connect ')}`;
    flows.set(key, { channel: channel!, step: 0, values: {}, startedAt: Date.now() });
    return [
      `**Connect ${spec.label}**`,
      spec.intro(input.agentName),
      '',
      spec.steps[0].ask,
      '',
      '_Send "cancel" to stop._',
    ].join('\n');
  }

  const flow = flows.get(key);
  if (!flow) return 'That setup expired. Send /connect again.';
  if (/^cancel$/i.test(text)) {
    flows.delete(key);
    return `Stopped. Nothing was saved. ${DELETE_HINT}`;
  }
  const spec = CHANNELS[flow.channel];
  const step = spec.steps[flow.step];
  const problem = step.format?.(text);
  if (problem) return `${problem}. ${step.ask}`;
  flow.values[step.key] = text;
  flow.step++;
  if (flow.step < spec.steps.length) return spec.steps[flow.step].ask;

  flows.delete(key);
  let result: CheckResult;
  try {
    result = await spec.check(flow.values);
  } catch (err) {
    return `I couldn't reach ${spec.label} (${(err as Error).message}). Send /connect ${flow.channel} to try again.`;
  }
  if (!result.ok)
    return `${result.problem}\nHow to fix: ${result.fix}\nSend /connect ${flow.channel} to try again. ${DELETE_HINT}`;

  const values = { ...flow.values, ...(spec.extra?.(flow.values, result) ?? {}) };
  try {
    setEnvValues(values);
  } catch (err) {
    log.error('/connect could not save credentials', { channel: flow.channel, err });
    return "The credentials work, but I couldn't save them on the host. Run clawbridge-ai doctor there.";
  }
  audit('channel.connected', { actor: me, channelType: flow.channel, detail: { keys: Object.keys(values) } });
  const started = await startChannelAdapter(flow.channel).catch(() => false);
  return [spec.done(values, result), started ? '' : '(It starts on the next restart of ClawBridge.)', DELETE_HINT]
    .filter(Boolean)
    .join('\n\n');
}

/** For tests. */
export function resetConnectFlows(): void {
  flows.clear();
}
