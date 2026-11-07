/**
 * Host credential proxy and egress gate.
 *
 * Containers never see real API credentials. Each container gets a
 * per-session placeholder (`cbp_…`) in place of the key, and its API base
 * URL points here. The proxy checks the placeholder, swaps in the real
 * credential for that provider's API host only, and streams the response
 * back. A placeholder works only through this proxy, only for the host it
 * was issued for, and only while its container runs.
 *
 *   /anthropic/*  → https://api.anthropic.com/*   (Claude: API key or subscription token)
 *   /openai/*     → https://api.openai.com/*      (OpenAI API key, when one is configured)
 *
 * With EGRESS_PROXY=on, containers also send all other HTTPS traffic
 * through this server (HTTPS_PROXY, CONNECT). It refuses private and
 * link-local addresses (cloud metadata, the host's LAN) and, when
 * EGRESS_ALLOWLIST is set, any host not on it. Refusals are audited.
 *
 * Settings (~/.clawbridge/.env or the service environment):
 *   CREDENTIAL_PROXY=on          route provider credentials through the proxy
 *   EGRESS_PROXY=on              also gate all other outbound HTTPS
 *   EGRESS_ALLOWLIST=a.com,b.org optional: only these hosts (and subdomains)
 *   CREDENTIAL_PROXY_PORT=3011
 *   CREDENTIAL_PROXY_BIND=…      default 127.0.0.1 on macOS, 0.0.0.0 on Linux
 */
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import net from 'net';

import { audit } from './audit.js';
import { lockdownProxyBase } from './egress-lockdown.js';
import { log } from './log.js';

export interface Upstream {
  protocol: 'https:' | 'http:';
  host: string;
  port: number;
}

export interface RouteConfig {
  prefix: string;
  upstream: Upstream;
}

export type CredentialKind = 'anthropic-api-key' | 'anthropic-oauth' | 'openai-api-key' | 'egress';

interface Grant {
  sessionId: string;
  kind: CredentialKind;
  secret: string;
}

const ROUTE_FOR_KIND: Record<CredentialKind, string | null> = {
  'anthropic-api-key': '/anthropic',
  'anthropic-oauth': '/anthropic',
  'openai-api-key': '/openai',
  egress: null, // CONNECT only, carries no credential
};

export const DEFAULT_ROUTES: RouteConfig[] = [
  { prefix: '/anthropic', upstream: { protocol: 'https:', host: 'api.anthropic.com', port: 443 } },
  { prefix: '/openai', upstream: { protocol: 'https:', host: 'api.openai.com', port: 443 } },
];

function injectFor(kind: CredentialKind, headers: http.OutgoingHttpHeaders, secret: string): void {
  if (kind === 'anthropic-api-key') headers['x-api-key'] = secret;
  else headers['authorization'] = `Bearer ${secret}`;
}

/** Headers that must not be forwarded upstream. */
const HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'x-api-key',
  'authorization',
]);

/** Pull the placeholder out of x-api-key, Authorization: Bearer, or Proxy-Authorization: Basic. */
export function placeholderFrom(headers: http.IncomingHttpHeaders): string | null {
  const key = headers['x-api-key'];
  if (typeof key === 'string' && key.startsWith('cbp_')) return key;
  const auth = headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(cbp_[A-Za-z0-9_-]+)$/.exec(auth);
    if (m) return m[1];
  }
  const proxyAuth = headers['proxy-authorization'];
  if (typeof proxyAuth === 'string' && proxyAuth.startsWith('Basic ')) {
    const decoded = Buffer.from(proxyAuth.slice(6), 'base64').toString();
    const user = decoded.split(':')[0];
    if (user.startsWith('cbp_')) return user;
  }
  return null;
}

/** Private, loopback, link-local and metadata addresses a container must not reach through the proxy. */
export function isPrivateAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (net.isIPv6(h))
    return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h === '::';
  return false;
}

export function hostAllowed(host: string, allowlist: string[]): boolean {
  if (isPrivateAddress(host)) return false;
  if (allowlist.length === 0) return true;
  const h = host.toLowerCase();
  return allowlist.some((d) => h === d || h.endsWith(`.${d}`));
}

export class CredentialProxy {
  private readonly grants = new Map<string, Grant>();
  private server: http.Server | null = null;

  constructor(
    private readonly opts: {
      routes?: RouteConfig[];
      egress?: boolean;
      allowlist?: string[];
    } = {},
  ) {}

  private get routes(): RouteConfig[] {
    return this.opts.routes ?? DEFAULT_ROUTES;
  }

  /** Issue a placeholder for one session's credential. */
  issue(sessionId: string, kind: CredentialKind, secret: string): string {
    const token = `cbp_${crypto.randomBytes(24).toString('base64url')}`;
    this.grants.set(token, { sessionId, kind, secret });
    return token;
  }

  /** Revoke every placeholder issued to a session (called when its container exits). */
  revokeSession(sessionId: string): void {
    for (const [token, g] of this.grants) if (g.sessionId === sessionId) this.grants.delete(token);
  }

  get grantCount(): number {
    return this.grants.size;
  }

  async listen(port: number, host: string): Promise<number> {
    const server = http.createServer((req, res) => this.handleRequest(req, res));
    server.on('connect', (req, socket: net.Socket, head) => this.handleConnect(req, socket, head));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
    this.server = server;
    const addr = server.address();
    return typeof addr === 'object' && addr ? addr.port : port;
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  private deny(res: http.ServerResponse, status: number, reason: string, detail: Record<string, unknown>): void {
    audit('egress.blocked', { detail: { reason, ...detail } });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'credential_proxy', message: reason } }));
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '/';
    const route = this.routes.find((r) => url === r.prefix || url.startsWith(`${r.prefix}/`));
    if (!route) return this.deny(res, 404, 'no such route', { path: url.split('?')[0] });

    const token = placeholderFrom(req.headers);
    const grant = token ? this.grants.get(token) : undefined;
    // Claude Code probes connectivity with an unauthenticated HEAD /api/hello; let it through bare.
    const probe =
      (req.method === 'HEAD' || req.method === 'GET') && url.slice(route.prefix.length).split('?')[0] === '/api/hello';
    if (!grant && !probe) return this.deny(res, 401, 'unknown or revoked placeholder', { route: route.prefix });
    if (!grant) return this.forward(req, res, route, url, null);
    if (ROUTE_FOR_KIND[grant.kind] !== route.prefix) {
      return this.deny(res, 403, 'placeholder not valid for this API', {
        route: route.prefix,
        session: grant.sessionId,
      });
    }

    this.forward(req, res, route, url, grant);
  }

  private forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: RouteConfig,
    url: string,
    grant: Grant | null,
  ): void {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k) && v !== undefined) headers[k] = v;
    headers['host'] = route.upstream.host;
    if (grant) injectFor(grant.kind, headers, grant.secret);

    const client = route.upstream.protocol === 'https:' ? https : http;
    const upstreamReq = client.request(
      {
        protocol: route.upstream.protocol,
        host: route.upstream.host,
        port: route.upstream.port,
        method: req.method,
        path: url.slice(route.prefix.length) || '/',
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.on('error', (err) => {
      log.warn('Credential proxy upstream error', { host: route.upstream.host, err: err.message });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'credential_proxy', message: 'upstream unreachable' } }));
    });
    req.pipe(upstreamReq);
  }

  private handleConnect(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const refuse = (code: number, reason: string, target: string) => {
      audit('egress.blocked', { detail: { reason, target } });
      socket.end(`HTTP/1.1 ${code} ${reason}\r\n\r\n`);
    };
    const target = req.url ?? '';
    const [host, portStr] = target.split(/:(?=\d+$)/);
    const port = Number(portStr) || 443;
    if (!this.opts.egress) return refuse(403, 'egress proxy disabled', target);
    const token = placeholderFrom(req.headers);
    if (!token || !this.grants.has(token)) return refuse(407, 'proxy authentication required', target);
    if (!hostAllowed(host, this.opts.allowlist ?? [])) return refuse(403, 'destination not allowed', target);

    const upstream = net.connect(port, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    socket.on('error', () => upstream.destroy());
  }
}

// ── Process-wide instance ──

let instance: CredentialProxy | null = null;
let boundPort: number | null = null;
let egressEnabled = false;
let lockdownActive = false;

/** Containers are on the locked-down network; the proxy is reached through the relay. */
export function setLockdownActive(on: boolean): void {
  lockdownActive = on;
}

export function isLockdownActive(): boolean {
  return lockdownActive;
}

export function credentialProxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CREDENTIAL_PROXY === 'on' || env.EGRESS_PROXY === 'on' || env.EGRESS_LOCKDOWN === 'on';
}

/** Lockdown needs the egress proxy: it is the containers' only way out. */
export function egressProxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EGRESS_PROXY === 'on' || env.EGRESS_LOCKDOWN === 'on';
}

export async function startCredentialProxy(env: NodeJS.ProcessEnv = process.env): Promise<CredentialProxy | null> {
  if (!credentialProxyEnabled(env) || instance) return instance;
  const allowlist = (env.EGRESS_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const proxy = new CredentialProxy({ egress: egressProxyEnabled(env), allowlist });
  const port =
    env.CREDENTIAL_PROXY_PORT !== undefined && env.CREDENTIAL_PROXY_PORT !== ''
      ? Number(env.CREDENTIAL_PROXY_PORT)
      : 3011;
  const bind = env.CREDENTIAL_PROXY_BIND || (process.platform === 'darwin' ? '127.0.0.1' : '0.0.0.0');
  boundPort = await proxy.listen(port, bind);
  instance = proxy;
  egressEnabled = egressProxyEnabled(env);
  log.info('Credential proxy listening', { bind, port: boundPort, egress: egressProxyEnabled(env) });
  return proxy;
}

export function getCredentialProxy(): CredentialProxy | null {
  return instance;
}

/** Base URL containers use to reach the proxy. */
export function proxyBaseUrl(): string | null {
  if (!boundPort) return null;
  return lockdownActive ? lockdownProxyBase(boundPort) : `http://host.docker.internal:${boundPort}`;
}

export function proxyPort(): number | null {
  return boundPort;
}

/** Settings come from ~/.clawbridge/.env, overridden by the service environment. */
export const PROXY_ENV_KEYS = [
  'CREDENTIAL_PROXY',
  'EGRESS_PROXY',
  'EGRESS_ALLOWLIST',
  'CREDENTIAL_PROXY_PORT',
  'CREDENTIAL_PROXY_BIND',
  'EGRESS_LOCKDOWN',
] as const;

/**
 * Container env for a session when the proxy is running: the placeholder
 * in place of the credential, the API base URL pointing here, and (with
 * EGRESS_PROXY=on) HTTPS_PROXY for everything else. Returns null when the
 * proxy is off, so callers fall back to passing the credential directly.
 */
export function proxiedCredentialEnv(
  sessionId: string,
  credential: { key: string; value: string } | null,
): Record<string, string> | null {
  const proxy = instance;
  const base = proxyBaseUrl();
  if (!proxy || !base) return null;
  const env: Record<string, string> = {};
  if (credential) {
    const kind: CredentialKind =
      credential.key === 'CLAUDE_CODE_OAUTH_TOKEN'
        ? 'anthropic-oauth'
        : credential.key === 'ANTHROPIC_API_KEY'
          ? 'anthropic-api-key'
          : 'openai-api-key';
    env[credential.key] = proxy.issue(sessionId, kind, credential.value);
    env[kind === 'openai-api-key' ? 'OPENAI_BASE_URL' : 'ANTHROPIC_BASE_URL'] =
      `${base}${kind === 'openai-api-key' ? '/openai/v1' : '/anthropic'}`;
  }
  if (egressEnabled) {
    const egressToken = proxy.issue(sessionId, 'egress', '');
    const proxyUrl = base.replace('http://', `http://${egressToken}:x@`);
    env.HTTPS_PROXY = proxyUrl;
    env.https_proxy = proxyUrl;
    env.HTTP_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.NO_PROXY = 'egress,host.docker.internal,localhost,127.0.0.1';
    env.no_proxy = env.NO_PROXY;
  }
  return env;
}

/** Revoke a session's placeholders when its container exits. */
export function revokeSessionCredentials(sessionId: string): void {
  instance?.revokeSession(sessionId);
}

export async function stopCredentialProxy(): Promise<void> {
  await instance?.close();
  instance = null;
  boundPort = null;
  egressEnabled = false;
}
