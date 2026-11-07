/**
 * Guided setup for each first-class channel.
 *
 * Each wizard walks a non-technical owner through the platform's own
 * screens, checks every credential against the platform before saving it,
 * and returns the env lines to write. Nothing is saved that the platform
 * did not accept.
 *
 * The check functions are separate from the prompts so they can be tested
 * without a terminal.
 */
import * as p from '@clack/prompts';
import k from 'kleur';

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
} from '../channels/credential-checks.js';

export * from '../channels/credential-checks.js';

// ── Prompts ──

function cancelled(v: unknown): v is symbol {
  return p.isCancel(v);
}

async function secret(message: string, validate?: (v: string) => string | undefined): Promise<string | null> {
  const v = await p.password({ message, validate: (x) => (x?.trim() ? validate?.(x.trim()) : 'Required') });
  return cancelled(v) ? null : String(v).trim();
}

/** Ask, check, and re-ask until the platform accepts it or the owner skips. */
async function untilAccepted(
  label: string,
  ask: () => Promise<string[] | null>,
  check: (values: string[]) => Promise<CheckResult>,
): Promise<{ values: string[]; result: Extract<CheckResult, { ok: true }> } | null> {
  for (;;) {
    const values = await ask();
    if (!values) return null;
    const s = p.spinner();
    s.start(`Checking with ${label}…`);
    const result = await check(values).catch(
      (err: Error): CheckResult => ({
        ok: false,
        problem: `Couldn't reach ${label} (${err.message}).`,
        fix: 'Check your internet connection and try again.',
      }),
    );
    if (result.ok) {
      s.stop(k.green(`${label} connected: ${result.detail}`));
      return { values, result };
    }
    s.stop(k.red(result.problem));
    p.log.message(k.dim(`How to fix: ${result.fix}`));
    const again = await p.confirm({ message: 'Try again?', initialValue: true });
    if (cancelled(again) || !again) return null;
  }
}

export interface WizardOutput {
  env: Record<string, string>;
  /** What the owner should do next to see the first reply. */
  next: string[];
}

export async function runTelegramWizard(): Promise<WizardOutput | null> {
  p.note(
    [
      '1. In Telegram, open @BotFather and send /newbot',
      '2. Pick a name and a username ending in "bot"',
      '3. Copy the token it gives you',
    ].join('\n'),
    'Telegram',
  );
  const got = await untilAccepted(
    'Telegram',
    async () => {
      const t = await secret('Telegram bot token', (v) =>
        /^\d+:[\w-]{30,}$/.test(v) ? undefined : 'Looks like 123456789:ABC…',
      );
      return t ? [t] : null;
    },
    ([t]) => checkTelegramToken(t),
  );
  if (!got) return null;
  return {
    env: { TELEGRAM_BOT_TOKEN: got.values[0] },
    next: [`Telegram: open ${got.result.detail} and send "hi". The first person to message it becomes the owner.`],
  };
}

export async function runSlackWizard(appName: string): Promise<WizardOutput | null> {
  const url = slackManifestUrl(loadSlackManifest(appName));
  p.note(
    [
      '1. Open the link below. It creates the Slack app with everything set up for you.',
      '2. Pick your workspace → Create → Install to Workspace → Allow.',
      '3. OAuth & Permissions: copy the Bot User OAuth Token (xoxb-…).',
      '4. Basic Information → App-Level Tokens → Generate, add scope connections:write,',
      '   and copy that token (xapp-…).',
      '',
      k.cyan(url),
    ].join('\n'),
    'Slack',
  );
  const bot = await untilAccepted(
    'Slack',
    async () => {
      const t = await secret('Bot token (xoxb-…)');
      return t ? [t] : null;
    },
    ([t]) => checkSlackBotToken(t),
  );
  if (!bot) return null;
  const app = await untilAccepted(
    'Slack Socket Mode',
    async () => {
      const t = await secret('App-level token (xapp-…)');
      return t ? [t] : null;
    },
    ([t]) => checkSlackAppToken(t),
  );
  if (!app) return null;
  return {
    env: { SLACK_BOT_TOKEN: bot.values[0], SLACK_APP_TOKEN: app.values[0] },
    next: [
      `Slack: DM ${bot.result.detail.split(' in ')[0]} "hi", or invite it to a channel with /invite and @mention it.`,
    ],
  };
}

export async function runWhatsAppWizard(): Promise<WizardOutput | null> {
  p.note(
    [
      'This uses the official WhatsApp Business Cloud API (no risk to your number).',
      '',
      '1. developers.facebook.com → My Apps → Create app → "Connect with customers through WhatsApp".',
      '2. WhatsApp → API Setup: add your business number (or use the test number).',
      '   Copy the "Phone number ID" (not the phone number).',
      '3. Business Settings → System Users → add one, Generate token with',
      '   whatsapp_business_messaging + whatsapp_business_management, and copy it.',
      '4. App settings → Basic: copy the App secret (used to reject forged messages).',
    ].join('\n'),
    'WhatsApp',
  );
  const got = await untilAccepted(
    'WhatsApp',
    async () => {
      const id = await p.text({
        message: 'Phone number ID',
        validate: (v) =>
          /^\d{6,}$/.test(v?.trim() ?? '') ? undefined : 'Digits only — WhatsApp → API Setup → Phone number ID',
      });
      if (cancelled(id)) return null;
      const token = await secret('Access token');
      return token ? [String(id).trim(), token] : null;
    },
    ([id, token]) => checkWhatsApp(id, token),
  );
  if (!got) return null;
  const appSecret = await secret('App secret', (v) =>
    /^[a-f0-9]{32}$/i.test(v) ? undefined : 'The App secret is 32 hex characters (App settings → Basic → Show)',
  );
  if (!appSecret) return null;
  const verifyToken = newVerifyToken();
  return {
    env: {
      WHATSAPP_PHONE_NUMBER_ID: got.values[0],
      WHATSAPP_ACCESS_TOKEN: got.values[1],
      WHATSAPP_APP_SECRET: appSecret,
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: verifyToken,
    },
    next: [
      'WhatsApp: run `clawbridge-ai tunnel` (or use your own HTTPS address) and, in Meta → WhatsApp → Configuration:',
      '  Callback URL: <the URL it prints>/webhook/whatsapp',
      `  Verify token: ${verifyToken}`,
      '  Subscribe to: messages',
      `Then send "hi" to ${got.result.detail}.`,
    ],
  };
}

export async function runDiscordWizard(): Promise<WizardOutput | null> {
  p.note(
    [
      '1. discord.com/developers/applications → New Application → name it.',
      '2. Bot → Reset Token → copy it.',
      '3. Bot → Privileged Gateway Intents → turn on Message Content Intent → Save.',
    ].join('\n'),
    'Discord',
  );
  const got = await untilAccepted(
    'Discord',
    async () => {
      const t = await secret('Bot token');
      return t ? [t] : null;
    },
    ([t]) => checkDiscordToken(t),
  );
  if (!got) return null;
  const invite = discordInviteUrl(got.result.extra!.applicationId);
  return {
    env: { DISCORD_BOT_TOKEN: got.values[0] },
    next: [`Discord: add the bot to your server with this link, then @mention it in a channel:`, `  ${invite}`],
  };
}

export async function runChannelWizard(channel: string, appName: string): Promise<WizardOutput | null> {
  switch (channel) {
    case 'telegram':
      return runTelegramWizard();
    case 'slack':
      return runSlackWizard(appName);
    case 'whatsapp':
      return runWhatsAppWizard();
    case 'discord':
      return runDiscordWizard();
    default:
      return null;
  }
}
