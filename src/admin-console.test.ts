import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (r: Request) => Promise<Response>>() }));
vi.mock('./log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./webhook-server.js', () => ({
  registerRawWebhookHandler: (n: string, h: (r: Request) => Promise<Response>) => handlers.set(n, h),
}));
vi.mock('./env.js', () => ({
  readEnvFile: () => ({ ADMIN_CONSOLE_TOKEN: 'secret-token-123' }),
  setEnvValues: vi.fn(),
  envFilePath: () => '/x',
}));
vi.mock('./channels/channel-registry.js', () => ({
  getActiveAdapters: () => [{ channelType: 'slack', isConnected: () => true }],
}));
vi.mock('./home-summary.js', () => ({
  buildHomeSummary: () => ({
    agents: [{ id: 'ag', name: 'Ava <script>', provider: 'claude', working: false, conversations: 2 }],
    pendingApprovals: [],
    scheduledJobs: 0,
    linkedAccounts: [],
  }),
}));

import { audit } from './audit.js';
import { startAdminConsole, tokenMatches } from './admin-console.js';
import { closeDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';

describe('admin console', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    startAdminConsole();
  });
  afterEach(() => closeDb());

  const get = (q: string) => handlers.get('admin')!(new Request(`http://localhost/webhook/admin${q}`));

  it('answers 404 without the right token', async () => {
    expect((await get('')).status).toBe(404);
    expect((await get('?token=wrong')).status).toBe(404);
    expect(tokenMatches('abc', 'abd')).toBe(false);
  });

  it('shows channels, agents and the audit log, escaped, with a strict CSP', async () => {
    audit('role.granted', { actor: 'slack:U1', target: 'slack:U2' });
    const res = await get('?token=secret-token-123');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain('connected');
    expect(html).toContain('Ava &lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('role.granted');
    const json = (await (await get('?token=secret-token-123&format=json')).json()) as { channels: unknown };
    expect(json.channels).toEqual([{ type: 'slack', connected: true }]);
  });
});
