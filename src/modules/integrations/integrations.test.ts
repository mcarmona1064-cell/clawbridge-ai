import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { approvals } = vi.hoisted(() => ({ approvals: [] as Array<Record<string, unknown>> }));
vi.mock('../../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../approvals/index.js', () => ({
  requestApproval: async (o: Record<string, unknown>) => {
    approvals.push(o);
    return true;
  },
  registerApprovalHandler: vi.fn(),
  registerApprovalRejectionHandler: vi.fn(),
  notifyAgent: vi.fn(),
}));

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { setPolicy } from '../../policies.js';
import type { Session } from '../../types.js';
import { buildUrl, executeIntegration, googleAccessToken, pathTemplate, resetGoogleToken } from './execute.js';
import { processIntegrationRequest, ruleSubject } from './index.js';
import { availableIntegrations, isWriteRequest } from './registry.js';

const env = {
  GITHUB_TOKEN: 'ghp_REALSECRETTOKEN123',
  STRIPE_SECRET_KEY: 'sk_live_REALSTRIPEKEY',
  LINEAR_API_KEY: 'lin_api_REALKEY12345',
  SHOPIFY_ACCESS_TOKEN: 'shpat_REAL123456',
};
const calls: Array<{ url: string; init: RequestInit }> = [];
const session = { id: 's1', agent_group_id: 'ag-1' } as Session;
let tmp = '';

function readResponse(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('integrations', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    approvals.length = 0;
    calls.length = 0;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-int-'));
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, echo: 'token ghp_REALSECRETTOKEN123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  });
  afterEach(() => {
    closeDb();
    vi.unstubAllGlobals();
    resetGoogleToken();
  });

  it('offers only integrations whose credentials are set, filling base URLs from env', () => {
    const names = availableIntegrations({ ...env, SHOPIFY_STORE_DOMAIN: 'acme.myshopify.com' }).map((i) => i.def.name);
    expect(names).toEqual(expect.arrayContaining(['github', 'stripe', 'linear', 'shopify']));
    expect(names).not.toContain('notion');
    expect(availableIntegrations(env).map((i) => i.def.name)).not.toContain('shopify'); // store domain missing
    const custom = availableIntegrations({
      CUSTOM_INTEGRATIONS: JSON.stringify([{ name: 'crm', baseUrl: 'https://api.crm.test', env: 'CRM_TOKEN' }]),
      CRM_TOKEN: 'x',
    });
    expect(custom.map((i) => i.def.name)).toEqual(['crm']);
  });

  it('refuses paths that would leave the API host', () => {
    expect(() => buildUrl('https://api.github.com', '//evil.test/x')).toThrow();
    expect(() => buildUrl('https://api.github.com', '/repos/../../x')).toThrow();
    expect(() => buildUrl('https://api.github.com', 'repos')).toThrow();
    expect(buildUrl('https://api.github.com', '/repos/a/b', { state: 'open' }).toString()).toBe(
      'https://api.github.com/repos/a/b?state=open',
    );
  });

  it('classifies reads and writes per integration', () => {
    const [gh] = availableIntegrations(env).filter((i) => i.def.name === 'github');
    const [lin] = availableIntegrations(env).filter((i) => i.def.name === 'linear');
    expect(isWriteRequest(gh.def, 'GET', '/repos/a/b/issues', undefined)).toBe(false);
    expect(isWriteRequest(gh.def, 'POST', '/repos/a/b/issues', {})).toBe(true);
    expect(isWriteRequest(lin.def, 'POST', '/graphql', { query: '{ issues { nodes { id } } }' })).toBe(false);
    expect(
      isWriteRequest(lin.def, 'POST', '/graphql', { query: 'mutation { issueCreate(input: {}) { success } }' }),
    ).toBe(true);
    expect(pathTemplate('/repos/acme/web/issues/123/comments')).toBe('/repos/acme/web/issues/*/comments');
  });

  it('runs reads at once with the real credential and never echoes it back', async () => {
    const res = path.join(tmp, 'r1.json');
    await processIntegrationRequest(
      session,
      { id: 'r1', integration: 'github', method: 'GET', path: '/repos/acme/web/issues' },
      res,
      availableIntegrations(env),
    );
    expect(calls[0].url).toBe('https://api.github.com/repos/acme/web/issues');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer ghp_REALSECRETTOKEN123');
    const out = readResponse(res);
    expect(out).toMatchObject({ status: 'done', httpStatus: 200 });
    expect(String(out.body)).not.toContain('ghp_REALSECRETTOKEN123');
    expect(String(out.body)).toContain('[redacted]');
  });

  it('holds writes for approval with a preview, risk and an "always allow" for that kind of change', async () => {
    const res = path.join(tmp, 'w1.json');
    const req = {
      id: 'w1',
      integration: 'github',
      method: 'POST',
      path: '/repos/acme/web/issues',
      body: { title: 'Bug' },
    };
    await processIntegrationRequest(session, req, res, availableIntegrations(env));
    expect(calls).toHaveLength(0);
    expect(readResponse(res)).toMatchObject({ status: 'pending_approval' });
    expect(approvals[0]).toMatchObject({
      action: 'integration_write',
      risk: 'medium',
      alwaysAllow: { scope: 'github POST /repos/acme/web/issues' },
    });
    expect(String(approvals[0].question)).toContain('"title": "Bug"');

    // Once always-allowed, the same kind of write runs directly.
    setPolicy('ag-1', 'integration', ruleSubject(req), 'allow', 'slack:U1');
    await processIntegrationRequest(
      session,
      { ...req, id: 'w2' },
      path.join(tmp, 'w2.json'),
      availableIntegrations(env),
    );
    expect(calls).toHaveLength(1);
  });

  it('never auto-allows money: Stripe writes always ask, and a deny rule blocks everything', async () => {
    const req = {
      id: 's1',
      integration: 'stripe',
      method: 'POST',
      path: '/v1/refunds',
      body: { charge: 'ch_1', amount: 500 },
    };
    setPolicy('ag-1', 'integration', ruleSubject(req), 'allow', 'slack:U1');
    await processIntegrationRequest(session, req, path.join(tmp, 's1.json'), availableIntegrations(env));
    expect(calls).toHaveLength(0);
    expect(approvals[0]).toMatchObject({ risk: 'high' });
    expect(approvals[0].alwaysAllow).toBeUndefined();

    setPolicy('ag-1', 'integration', 'github', 'deny', 'slack:U1');
    const res = path.join(tmp, 'd.json');
    await processIntegrationRequest(
      session,
      { id: 'd', integration: 'github', method: 'GET', path: '/user' },
      res,
      availableIntegrations(env),
    );
    expect(readResponse(res)).toMatchObject({ status: 'denied' });
  });

  it('sends Stripe bodies form-encoded', async () => {
    const [stripe] = availableIntegrations(env).filter((i) => i.def.name === 'stripe');
    await executeIntegration(stripe, {
      id: 'x',
      integration: 'stripe',
      method: 'POST',
      path: '/v1/customers',
      body: { email: 'a@b.co', metadata: { plan: 'pro' } },
    });
    expect(calls[0].init.body).toBe('email=a%40b.co&metadata%5Bplan%5D=pro');
  });

  it('refreshes a Google access token and reuses it until it expires', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push({ url, init: {} });
      return new Response(JSON.stringify({ access_token: 'ya29.short', expires_in: 3600 }));
    });
    const g = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REFRESH_TOKEN: 'rt' };
    expect(await googleAccessToken(g)).toBe('ya29.short');
    expect(await googleAccessToken(g)).toBe('ya29.short');
    expect(calls.filter((c) => c.url.includes('oauth2.googleapis.com'))).toHaveLength(1);
  });
});

describe('integration receipts', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    calls.length = 0;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-int-'));
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 42, html_url: 'https://github.com/acme/web/issues/42' }), {
        status: 201,
      });
    });
  });
  afterEach(() => {
    closeDb();
    vi.unstubAllGlobals();
  });

  it('returns evidence and does not repeat an identical allowed write', async () => {
    // A different body from earlier tests: identical writes are remembered for ten minutes.
    const req = {
      id: 'i1',
      integration: 'github',
      method: 'POST',
      path: '/repos/acme/web/issues',
      body: { title: 'Receipt test' },
    };
    setPolicy('ag-1', 'integration', ruleSubject(req), 'allow', 'slack:U1');
    await processIntegrationRequest(session, req, path.join(tmp, 'a.json'), availableIntegrations(env));
    await processIntegrationRequest(
      session,
      { ...req, id: 'i2' },
      path.join(tmp, 'b.json'),
      availableIntegrations(env),
    );
    expect(calls).toHaveLength(1);
    expect(readResponse(path.join(tmp, 'a.json'))).toMatchObject({ evidence: 'https://github.com/acme/web/issues/42' });
    expect(readResponse(path.join(tmp, 'b.json'))).toMatchObject({ note: expect.stringContaining('not repeated') });
  });

  it('sends Stripe a stable Idempotency-Key', async () => {
    const [stripe] = availableIntegrations(env).filter((i) => i.def.name === 'stripe');
    const req = { id: 'x', integration: 'stripe', method: 'POST', path: '/v1/refunds', body: { charge: 'ch_1' } };
    await executeIntegration(stripe, req);
    await executeIntegration(stripe, { ...req, id: 'y' });
    const keys = calls.map((c) => (c.init.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys[0]).toMatch(/^[0-9a-f]{40}$/);
    expect(keys[1]).toBe(keys[0]);
  });
});
