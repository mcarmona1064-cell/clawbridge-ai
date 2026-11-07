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
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import * as p from '@clack/prompts';
import k from 'kleur';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type CheckResult =
  | { ok: true; detail: string; extra?: Record<string, string> }
  | { ok: false; problem: string; fix: string };

// ── Slack ──

/** Link that opens "Create an app" with our manifest already filled in. */
export function slackManifestUrl(manifest: unknown): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

export function loadSlackManifest(appName: string): Record<string, unknown> {
  const file = path.resolve(fileURLToPath(new URL(import.meta.url)), '../../../setup/channels/slack-app-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    display_information: { name: string };
    features: { bot_user: { display_name: string } };
  };
  manifest.display_information.name = appName.slice(0, 35);
  manifest.features.bot_user.display_name = appName.slice(0, 80);
  return manifest as unknown as Record<string, unknown>;
}

export async function checkSlackBotToken(token: string, fetchImpl: FetchLike = fetch): Promise<CheckResult> {
  if (!token.startsWith('xoxb-')) {
    return {
      ok: false,
      problem: "That isn't a bot token.",
      fix: 'Copy the "Bot User OAuth Token" that starts with xoxb- (OAuth & Permissions page).',
    };
  }
  const res = await fetchImpl('https://slack.com/api/auth.test', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; team?: string; user?: string };
  if (!body.ok) {
    return {
      ok: false,
      problem: `Slack didn't accept the bot token (${body.error ?? `HTTP ${res.status}`}).`,
      fix: 'Install the app to your workspace first (Install App → Install to Workspace), then copy the new token.',
    };
  }
  return { ok: true, detail: `@${body.user} in ${body.team}` };
}

export async function checkSlackAppToken(token: string, fetchImpl: FetchLike = fetch): Promise<CheckResult> {
  if (!token.startsWith('xapp-')) {
    return {
      ok: false,
      problem: "That isn't an app-level token.",
      fix: 'Basic Information → App-Level Tokens → Generate, with the connections:write scope. It starts with xapp-.',
    };
  }
  const res = await fetchImpl('https://slack.com/api/apps.connections.open', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!body.ok) {
    return {
      ok: false,
      problem: `Slack didn't open a Socket Mode connection (${body.error ?? `HTTP ${res.status}`}).`,
      fix: 'Make sure Socket Mode is on (Settings → Socket Mode) and the token has connections:write.',
    };
  }
  return { ok: true, detail: 'Socket Mode ready — no public URL needed' };
}

// ── WhatsApp (Cloud API) ──

export async function checkWhatsApp(
  phoneNumberId: string,
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<CheckResult> {
  const res = await fetchImpl(
    `https://graph.facebook.com/v23.0/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const body = (await res.json().catch(() => ({}))) as {
    display_phone_number?: string;
    verified_name?: string;
    error?: { message?: string; code?: number };
  };
  if (!res.ok || !body.display_phone_number) {
    const msg = body.error?.message ?? `HTTP ${res.status}`;
    const fix =
      body.error?.code === 190
        ? 'The access token is invalid or expired. Create a permanent System User token (Business Settings → System Users → Generate token, with whatsapp_business_messaging).'
        : 'Check the Phone number ID (WhatsApp → API Setup, under "From"), not the phone number itself.';
    return { ok: false, problem: `Meta didn't accept these details (${msg}).`, fix };
  }
  return { ok: true, detail: `${body.verified_name ?? 'WhatsApp'} (${body.display_phone_number})` };
}

export function newVerifyToken(): string {
  return `cb-${crypto.randomBytes(12).toString('hex')}`;
}

// ── Discord ──

/** Permissions the bot needs: view, send, threads, embeds, files, history, reactions. */
export const DISCORD_PERMISSIONS =
  (1n << 10n) | // View Channels
  (1n << 11n) | // Send Messages
  (1n << 38n) | // Send Messages in Threads
  (1n << 35n) | // Create Public Threads
  (1n << 14n) | // Embed Links
  (1n << 15n) | // Attach Files
  (1n << 16n) | // Read Message History
  (1n << 6n); // Add Reactions

export function discordInviteUrl(applicationId: string): string {
  const params = new URLSearchParams({
    client_id: applicationId,
    scope: 'bot applications.commands',
    permissions: DISCORD_PERMISSIONS.toString(),
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export async function checkDiscordToken(token: string, fetchImpl: FetchLike = fetch): Promise<CheckResult> {
  const res = await fetchImpl('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bot ${token}` } });
  const body = (await res.json().catch(() => ({}))) as { id?: string; username?: string; message?: string };
  if (!res.ok || !body.id) {
    return {
      ok: false,
      problem: `Discord didn't accept the bot token (${body.message ?? `HTTP ${res.status}`}).`,
      fix: 'Bot page → Reset Token, then copy the new token (it is shown once).',
    };
  }
  return { ok: true, detail: `@${body.username}`, extra: { applicationId: body.id } };
}

// ── Telegram ──

export async function checkTelegramToken(token: string, fetchImpl: FetchLike = fetch): Promise<CheckResult> {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`);
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: { username?: string };
    description?: string;
  };
  if (!body.ok) {
    return {
      ok: false,
      problem: `Telegram didn't accept the token (${body.description ?? `HTTP ${res.status}`}).`,
      fix: 'In Telegram, message @BotFather, send /mybots → your bot → API Token, and copy it again.',
    };
  }
  return { ok: true, detail: `@${body.result?.username}` };
}

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
