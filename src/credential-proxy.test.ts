import http from 'http';
import net from 'net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  CredentialProxy,
  hostAllowed,
  isPrivateAddress,
  placeholderFrom,
  proxiedCredentialEnv,
  revokeSessionCredentials,
  startCredentialProxy,
  stopCredentialProxy,
} from './credential-proxy.js';

let upstream: http.Server;
let upstreamPort = 0;
let seen: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string }> = [];

beforeEach(async () => {
  seen = [];
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ path: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ok\n\n');
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  upstreamPort = (upstream.address() as net.AddressInfo).port;
});
afterEach(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
  await stopCredentialProxy();
});

function proxyWithLocalUpstream(egress = false, allowlist: string[] = []) {
  return new CredentialProxy({
    egress,
    allowlist,
    routes: [
      { prefix: '/anthropic', upstream: { protocol: 'http:', host: '127.0.0.1', port: upstreamPort } },
      { prefix: '/openai', upstream: { protocol: 'http:', host: '127.0.0.1', port: upstreamPort } },
    ],
  });
}

async function post(port: number, path: string, headers: Record<string, string>) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{"model":"x"}',
  });
  return { status: res.status, text: await res.text() };
}

describe('credential proxy', () => {
  it('swaps a placeholder for the real API key and streams the response', async () => {
    const proxy = proxyWithLocalUpstream();
    const port = await proxy.listen(0, '127.0.0.1');
    const token = proxy.issue('sess-1', 'anthropic-api-key', 'sk-ant-REAL');
    const res = await post(port, '/anthropic/v1/messages', { 'x-api-key': token, 'anthropic-version': '2023-06-01' });
    expect(res).toEqual({ status: 200, text: 'data: ok\n\n' });
    expect(seen[0].path).toBe('/v1/messages');
    expect(seen[0].headers['x-api-key']).toBe('sk-ant-REAL');
    expect(seen[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(seen[0].body).toBe('{"model":"x"}');
    await proxy.close();
  });

  it('sends a subscription token as a bearer header', async () => {
    const proxy = proxyWithLocalUpstream();
    const port = await proxy.listen(0, '127.0.0.1');
    const token = proxy.issue('sess-1', 'anthropic-oauth', 'sk-ant-oat-REAL');
    await post(port, '/anthropic/v1/messages', { authorization: `Bearer ${token}` });
    expect(seen[0].headers['authorization']).toBe('Bearer sk-ant-oat-REAL');
    expect(seen[0].headers['x-api-key']).toBeUndefined();
    await proxy.close();
  });

  it('refuses unknown, revoked and wrong-API placeholders without touching the upstream', async () => {
    const proxy = proxyWithLocalUpstream();
    const port = await proxy.listen(0, '127.0.0.1');
    expect((await post(port, '/anthropic/v1/messages', { 'x-api-key': 'cbp_made_up' })).status).toBe(401);
    expect((await post(port, '/anthropic/v1/messages', { 'x-api-key': 'sk-ant-real-key-from-elsewhere' })).status).toBe(
      401,
    );
    const token = proxy.issue('sess-2', 'anthropic-api-key', 'sk-ant-REAL');
    expect((await post(port, '/openai/v1/chat', { authorization: `Bearer ${token}` })).status).toBe(403);
    proxy.revokeSession('sess-2');
    expect((await post(port, '/anthropic/v1/messages', { 'x-api-key': token })).status).toBe(401);
    expect((await post(port, '/elsewhere', { 'x-api-key': token })).status).toBe(404);
    expect(seen).toHaveLength(0);
    await proxy.close();
  });

  it('gates CONNECT tunnels: auth required, private addresses and unlisted hosts refused', async () => {
    const proxy = proxyWithLocalUpstream(true, ['github.com']);
    const port = await proxy.listen(0, '127.0.0.1');
    const token = proxy.issue('sess-3', 'egress', '');
    const connect = (target: string, auth?: string) =>
      new Promise<string>((resolve) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write(
            `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: Basic ${Buffer.from(`${auth}:x`).toString('base64')}\r\n` : ''}\r\n`,
          );
        });
        sock.once('data', (d) => {
          resolve(d.toString().split('\r\n')[0]);
          sock.destroy();
        });
      });
    expect(await connect('github.com:443')).toMatch(/^HTTP\/1.1 407/);
    expect(await connect('169.254.169.254:80', token)).toMatch(/^HTTP\/1.1 403/);
    expect(await connect('example.com:443', token)).toMatch(/^HTTP\/1.1 403/);
    await proxy.close();
  });

  it('reads placeholders from every header style', () => {
    expect(placeholderFrom({ 'x-api-key': 'cbp_a' })).toBe('cbp_a');
    expect(placeholderFrom({ authorization: 'Bearer cbp_b' })).toBe('cbp_b');
    expect(placeholderFrom({ 'proxy-authorization': `Basic ${Buffer.from('cbp_c:x').toString('base64')}` })).toBe(
      'cbp_c',
    );
    expect(placeholderFrom({ authorization: 'Bearer sk-real' })).toBeNull();
  });

  it('classifies private addresses and allowlists', () => {
    for (const h of [
      '10.0.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.20.1.1',
      '192.168.1.5',
      'localhost',
      'host.docker.internal',
      '[::1]',
    ]) {
      expect(isPrivateAddress(h)).toBe(true);
    }
    expect(isPrivateAddress('140.82.112.3')).toBe(false);
    expect(hostAllowed('api.github.com', ['github.com'])).toBe(true);
    expect(hostAllowed('evilgithub.com', ['github.com'])).toBe(false);
    expect(hostAllowed('example.com', [])).toBe(true);
  });

  it('gives containers placeholders and base URLs, never the real credential', async () => {
    await startCredentialProxy({
      CREDENTIAL_PROXY: 'on',
      EGRESS_PROXY: 'on',
      CREDENTIAL_PROXY_PORT: '0',
      CREDENTIAL_PROXY_BIND: '127.0.0.1',
    });
    const env = proxiedCredentialEnv('sess-9', { key: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'sk-ant-oat-REAL' })!;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toMatch(/^cbp_/);
    expect(JSON.stringify(env)).not.toContain('sk-ant-oat-REAL');
    expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/host\.docker\.internal:\d+\/anthropic$/);
    expect(env.HTTPS_PROXY).toMatch(/^http:\/\/cbp_[^:]+:x@host\.docker\.internal:\d+$/);
    expect(env.NO_PROXY).toContain('host.docker.internal');
    revokeSessionCredentials('sess-9');
  });

  it('is off unless turned on', async () => {
    expect(await startCredentialProxy({})).toBeNull();
    expect(proxiedCredentialEnv('s', { key: 'ANTHROPIC_API_KEY', value: 'k' })).toBeNull();
  });
});
