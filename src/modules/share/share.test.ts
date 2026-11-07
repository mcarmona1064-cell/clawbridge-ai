import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { tmp } = vi.hoisted(() => ({ tmp: { data: '', session: '' } }));
vi.mock('../../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../env.js', () => ({
  readEnvFile: () => ({ SHARE_LINK_SECRET: 'test-secret', PUBLIC_BASE_URL: 'https://cb.example.com' }),
  setEnvValues: vi.fn(),
}));
vi.mock('../../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  get DATA_DIR() {
    return tmp.data;
  },
}));
vi.mock('../../webhook-server.js', () => ({ registerRawWebhookHandler: vi.fn() }));

import type { Session } from '../../types.js';
import { createShareLink, pruneExpired, resolveWorkspacePath, serveShared, verify } from './index.js';

const session = { id: 's1', agent_group_id: 'ag-1' } as Session;

describe('share links', () => {
  beforeEach(() => {
    tmp.data = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-data-'));
    tmp.session = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-sess-'));
    fs.mkdirSync(path.join(tmp.session, 'outbox'), { recursive: true });
    fs.writeFileSync(path.join(tmp.session, 'outbox', 'report.html'), '<h1>Q3</h1>');
  });
  afterEach(() => {
    fs.rmSync(tmp.data, { recursive: true, force: true });
    fs.rmSync(tmp.session, { recursive: true, force: true });
  });

  it('only shares files inside the workspace', () => {
    expect(resolveWorkspacePath(tmp.session, '/workspace/outbox/report.html')).toMatch(/report\.html$/);
    expect(resolveWorkspacePath(tmp.session, '/workspace/../../etc/passwd')).toBeNull();
    fs.symlinkSync('/etc/hosts', path.join(tmp.session, 'outbox', 'sneaky.txt'));
    expect(resolveWorkspacePath(tmp.session, 'outbox/sneaky.txt')).toBeNull();
  });

  it('creates a signed link on the public address and serves it sandboxed', async () => {
    const out = createShareLink(session, tmp.session, '/workspace/outbox/report.html');
    if ('error' in out) throw new Error(out.error);
    expect(out.url.startsWith('https://cb.example.com/webhook/files?id=')).toBe(true);
    const res = await serveShared(new Request(out.url));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('<h1>Q3</h1>');
  });

  it('refuses tampered or expired links, and prunes old files', async () => {
    const out = createShareLink(session, tmp.session, 'outbox/report.html', 1);
    if ('error' in out) throw new Error(out.error);
    const u = new URL(out.url);
    u.searchParams.set('exp', String(Number(u.searchParams.get('exp')) + 9999));
    expect((await serveShared(new Request(u.toString()))).status).toBe(404);
    const id = new URL(out.url).searchParams.get('id')!;
    const exp = Number(new URL(out.url).searchParams.get('exp'));
    expect(verify(id, exp, new URL(out.url).searchParams.get('sig')!, (exp + 1) * 1000)).toBe(false);
    expect(pruneExpired((exp + 1) * 1000)).toBe(1);
  });
});
