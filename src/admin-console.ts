/**
 * Local admin console — one read-only page with how the install is doing:
 * channels, agents, approvals waiting, recent reply decisions and the audit
 * log.
 *
 *   http://localhost:3000/webhook/admin?token=<ADMIN_CONSOLE_TOKEN>
 *
 * `clawbridge-ai console` prints the link. The token is required on every
 * request (compared in constant time) because the webhook port may be
 * reachable through a tunnel. The page never shows message text or secrets.
 */
import crypto from 'crypto';

import { readAudit } from './audit.js';
import { getActiveAdapters } from './channels/channel-registry.js';
import { getDb, hasTable } from './db/connection.js';
import { envFilePath, readEnvFile, setEnvValues } from './env.js';
import { buildHomeSummary } from './home-summary.js';
import { log } from './log.js';
import { registerRawWebhookHandler } from './webhook-server.js';

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

export function tokenMatches(expected: string, given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Read the console token, creating one on first use. */
export function ensureConsoleToken(): string {
  const existing = readEnvFile(['ADMIN_CONSOLE_TOKEN']).ADMIN_CONSOLE_TOKEN;
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString('base64url');
  try {
    setEnvValues({ ADMIN_CONSOLE_TOKEN: token });
  } catch (err) {
    log.warn('Could not save the admin console token', { file: envFilePath(), err });
  }
  return token;
}

export interface ConsoleData {
  channels: Array<{ type: string; connected: boolean }>;
  summary: ReturnType<typeof buildHomeSummary>;
  decisions: Array<{ at: string; channel_type: string; engaged: number; reason: string }>;
  audit: Array<{ at: string; action: string; actor: string | null; target: string | null }>;
}

export function consoleData(): ConsoleData {
  const decisions = hasTable(getDb(), 'engage_log')
    ? (getDb()
        .prepare('SELECT at, channel_type, engaged, reason FROM engage_log ORDER BY id DESC LIMIT 25')
        .all() as ConsoleData['decisions'])
    : [];
  return {
    channels: getActiveAdapters().map((a) => ({ type: a.channelType, connected: a.isConnected() })),
    summary: buildHomeSummary(null),
    decisions,
    audit: readAudit()
      .slice(-50)
      .reverse()
      .map((r) => ({ at: r.at, action: r.action, actor: r.actor, target: r.target })),
  };
}

export function renderConsole(d: ConsoleData): string {
  const row = (cells: unknown[]) => `<tr>${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`;
  const table = (head: string[], rows: string[]) =>
    rows.length
      ? `<table><thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
      : '<p class="muted">Nothing yet.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClawBridge AI console</title>
<style>
:root{--bg:#f7f7f5;--fg:#1f2328;--muted:#6b7280;--card:#fff;--line:#e5e7eb;--ok:#15803d;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#111315;--fg:#e8e8e6;--muted:#9ca3af;--card:#1a1d20;--line:#2b2f33;--ok:#4ade80;--bad:#f87171}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600}.muted{color:var(--muted)}.ok{color:var(--ok)}.bad{color:var(--bad)}
.wrap{overflow-x:auto}
</style></head><body><main>
<h1>ClawBridge AI</h1><p class="muted">Read-only view of this install. Refresh to update.</p>
<h2>Channels</h2><div class="card wrap">${table(
    ['Channel', 'Status'],
    d.channels.map(
      (c) =>
        `<tr><td>${escapeHtml(c.type)}</td><td class="${c.connected ? 'ok' : 'bad'}">${c.connected ? 'connected' : 'not connected'}</td></tr>`,
    ),
  )}</div>
<h2>Agents</h2><div class="card wrap">${table(
    ['Agent', 'Status', 'AI', 'Conversations'],
    d.summary.agents.map((a) => row([a.name, a.working ? 'working now' : 'ready', a.provider, a.conversations])),
  )}</div>
<h2>Waiting for approval</h2><div class="card wrap">${table(
    ['Request', 'Since'],
    d.summary.pendingApprovals.map((p) => row([p.title, p.createdAt])),
  )}</div>
<p class="muted">Scheduled jobs: ${escapeHtml(d.summary.scheduledJobs)}</p>
<h2>Recent reply decisions</h2><div class="card wrap">${table(
    ['When', 'Channel', 'Result', 'Why'],
    d.decisions.map((x) => row([x.at, x.channel_type, x.engaged ? 'answered' : 'stayed quiet', x.reason])),
  )}</div>
<h2>Audit log (latest 50)</h2><div class="card wrap">${table(
    ['When', 'What', 'Who', 'On'],
    d.audit.map((a) => row([a.at, a.action, a.actor ?? '', a.target ?? ''])),
  )}</div>
<p class="muted">Full export: <code>clawbridge-ai audit export --format csv</code></p>
</main></body></html>`;
}

export function startAdminConsole(): void {
  const token = ensureConsoleToken();
  registerRawWebhookHandler('admin', async (req) => {
    const url = new URL(req.url);
    if (req.method !== 'GET' || !tokenMatches(token, url.searchParams.get('token'))) {
      return new Response('Not found', { status: 404 });
    }
    const data = consoleData();
    if (url.searchParams.get('format') === 'json') {
      return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(renderConsole(data), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      },
    });
  });
}

/** `clawbridge-ai console`: print the link. */
export function consoleUrl(): string {
  const port = parseInt(process.env.WEBHOOK_PORT || '3000', 10);
  return `http://localhost:${port}/webhook/admin?token=${ensureConsoleToken()}`;
}
