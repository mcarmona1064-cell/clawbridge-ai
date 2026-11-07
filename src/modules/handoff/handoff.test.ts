import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../env.js', () => ({
  readEnvFile: () => ({ SHARE_LINK_SECRET: 's', PUBLIC_BASE_URL: 'https://cb.example.com' }),
  setEnvValues: vi.fn(),
}));
vi.mock('../../webhook-server.js', () => ({ registerRawWebhookHandler: vi.fn() }));
vi.mock('../../audit.js', () => ({ audit: vi.fn() }));

import { audit } from '../../audit.js';
import type { Session } from '../../types.js';
import { handleLive, handoffDir, parseAction, startHandoff } from './index.js';

const session = { id: 's1', agent_group_id: 'ag-1' } as Session;

describe('browser hand-off (host side)', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-live-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('gives a signed link that serves the page and the live frame', async () => {
    const { url } = startHandoff(session, root, 5);
    expect(url.startsWith('https://cb.example.com/webhook/live?id=')).toBe(true);
    const page = await handleLive(new Request(url));
    expect(page.status).toBe(200);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(await page.text()).toContain("You're in control of the browser");
    expect((await handleLive(new Request(`${url}&frame=1`))).status).toBe(204);
    fs.writeFileSync(path.join(handoffDir(root), 'live.png'), 'png');
    expect((await handleLive(new Request(`${url}&frame=1`))).headers.get('content-type')).toBe('image/png');
  });

  it('passes actions to the container and records only how many there were', async () => {
    const { url } = startHandoff(session, root, 5);
    const post = (a: unknown) => handleLive(new Request(url, { method: 'POST', body: JSON.stringify(a) }));
    expect((await post({ type: 'type', text: 'hunter2' })).status).toBe(200);
    expect((await post({ type: 'click', fx: 2, fy: 0 })).status).toBe(400);
    expect((await post({ type: 'key', key: 'rm -rf' })).status).toBe(400);
    expect((await post({ type: 'done' })).status).toBe(200);
    const files = fs.readdirSync(path.join(handoffDir(root), 'actions'));
    expect(files).toHaveLength(2);
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain('hunter2');
    // Once handed back, the link stops working.
    expect((await handleLive(new Request(url))).status).toBe(404);
  });

  it('refuses tampered links', async () => {
    const { url } = startHandoff(session, root, 5);
    expect((await handleLive(new Request(url.replace(/sig=[^&]+/, 'sig=forged')))).status).toBe(404);
  });

  it('validates actions', () => {
    expect(parseAction({ type: 'click', fx: 0.2, fy: 0.9 })).toEqual({ type: 'click', fx: 0.2, fy: 0.9 });
    expect(parseAction({ type: 'type', text: '' })).toBeNull();
    expect(parseAction({ type: 'key', key: 'Enter' })).toEqual({ type: 'key', key: 'Enter' });
  });
});
