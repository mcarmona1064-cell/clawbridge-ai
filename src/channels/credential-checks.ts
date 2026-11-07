/**
 * Credential checks for each channel: ask the platform whether a token
 * works, and explain the fix in plain words when it doesn't. Shared by the
 * setup wizard and /connect in chat.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

// ── Signal (signal-cli JSON-RPC daemon) ──

export async function checkSignalDaemon(address: string, account: string): Promise<CheckResult> {
  const [host, portStr] = address.split(':');
  const port = Number(portStr) || 7583;
  const net = await import('net');
  return new Promise((resolve) => {
    const sock = net.connect(port, host || '127.0.0.1');
    const done = (r: CheckResult) => {
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(
      () =>
        done({
          ok: false,
          problem: 'signal-cli did not answer.',
          fix: `Start it: signal-cli -a ${account} daemon --tcp ${host || '127.0.0.1'}:${port}`,
        }),
      5000,
    );
    sock.on('error', () => {
      clearTimeout(timer);
      done({
        ok: false,
        problem: `Nothing is listening on ${address}.`,
        fix: `Start the daemon: signal-cli -a ${account} daemon --tcp ${host || '127.0.0.1'}:${port}`,
      });
    });
    sock.on('connect', () =>
      sock.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'version', params: {}, id: 1 })}\n`),
    );
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (!buf.includes('\n')) return;
      clearTimeout(timer);
      try {
        const msg = JSON.parse(buf.split('\n')[0]) as { result?: { version?: string } };
        done({ ok: true, detail: `signal-cli ${msg.result?.version ?? ''} for ${account}`.trim() });
      } catch {
        done({
          ok: false,
          problem: 'Something answered, but not signal-cli.',
          fix: 'Check SIGNAL_RPC points at the signal-cli daemon.',
        });
      }
    });
  });
}

// ── iMessage (macOS) ──

export async function checkIMessage(dbPath: string): Promise<CheckResult> {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      problem: 'iMessage needs a Mac.',
      fix: 'Run ClawBridge on a Mac signed in to Messages to use iMessage.',
    };
  }
  try {
    fs.accessSync(dbPath, fs.constants.R_OK);
    const fd = fs.openSync(dbPath, 'r');
    fs.closeSync(fd);
  } catch {
    return {
      ok: false,
      problem: 'ClawBridge cannot read the Messages database.',
      fix: 'System Settings → Privacy & Security → Full Disk Access: turn it on for the app that runs ClawBridge (Terminal or node), then restart it.',
    };
  }
  return { ok: true, detail: 'Messages database readable' };
}

// ── Email (Postmark) ──

export async function checkPostmark(token: string, fetchImpl: FetchLike = fetch): Promise<CheckResult> {
  const res = await fetchImpl('https://api.postmarkapp.com/server', {
    headers: { Accept: 'application/json', 'X-Postmark-Server-Token': token },
  });
  const body = (await res.json().catch(() => ({}))) as { Name?: string; InboundAddress?: string; Message?: string };
  if (!res.ok || !body.Name) {
    return {
      ok: false,
      problem: `Postmark didn't accept the token (${body.Message ?? `HTTP ${res.status}`}).`,
      fix: 'Postmark → Servers → your server → API Tokens: copy the Server API token.',
    };
  }
  return {
    ok: true,
    detail: `${body.Name}${body.InboundAddress ? ` (inbound: ${body.InboundAddress})` : ''}`,
    extra: { inbound: body.InboundAddress ?? '' },
  };
}

export function newInboundToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}
