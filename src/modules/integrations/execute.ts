/**
 * Run one integration request on the host, with the real credentials.
 */
import type { ResolvedIntegration } from './registry.js';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface IntegrationRequest {
  id: string;
  integration: string;
  method: string;
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
}

export interface IntegrationResult {
  status: number;
  contentType: string | null;
  body: string;
  truncated: boolean;
}

const MAX_BODY = 60_000;

/** Validate the path and build the full URL; refuses anything that would leave the API host. */
export function buildUrl(baseUrl: string, path: string, query?: IntegrationRequest['query']): URL {
  if (!path.startsWith('/') || path.startsWith('//') || /(^|\/)\.\.(\/|$)/.test(path) || /[\r\n\\]/.test(path)) {
    throw new Error('path must be an absolute API path like /repos/owner/name');
  }
  const base = new URL(baseUrl);
  const url = new URL(base.toString().replace(/\/$/, '') + path);
  if (url.origin !== base.origin) throw new Error('path must stay on the integration host');
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
  return url;
}

/** Path with ids replaced by *, for "always allow" rules: /repos/a/b/issues/123/comments → /repos/a/b/issues/*\/comments. */
export function pathTemplate(path: string): string {
  return path
    .split('?')[0]
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f]{16,}$/i.test(seg) || /^[A-Za-z0-9_-]{20,}$/.test(seg) ? '*' : seg))
    .join('/');
}

// ── Google OAuth (refresh token → short-lived access token) ──

let googleToken: { value: string; expiresAt: number } | null = null;

export async function googleAccessToken(env: Record<string, string>, fetchImpl: FetchLike = fetch): Promise<string> {
  if (googleToken && googleToken.expiresAt - 60_000 > Date.now()) return googleToken.value;
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
    }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !body.access_token)
    throw new Error(`Google sign-in failed (${body.error ?? res.status}); refresh GOOGLE_REFRESH_TOKEN`);
  googleToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return googleToken.value;
}

export function resetGoogleToken(): void {
  googleToken = null;
}

async function authHeaders(r: ResolvedIntegration, fetchImpl: FetchLike): Promise<Record<string, string>> {
  const a = r.def.auth;
  switch (a.type) {
    case 'bearer':
      return { Authorization: `Bearer ${r.env[a.env]}` };
    case 'header':
      return { [a.header]: `${a.prefix ?? ''}${r.env[a.env]}` };
    case 'basic':
      return { Authorization: `Basic ${Buffer.from(`${r.env[a.userEnv]}:${r.env[a.passEnv]}`).toString('base64')}` };
    case 'google':
      return { Authorization: `Bearer ${await googleAccessToken(r.env, fetchImpl)}` };
  }
}

/** Every secret value the response must never echo back. */
function secretsOf(r: ResolvedIntegration): string[] {
  return Object.entries(r.env)
    .filter(([k, v]) => v && v.length >= 8 && /TOKEN|SECRET|KEY|PASSWORD/.test(k))
    .map(([, v]) => v);
}

function formEncode(obj: unknown, prefix = ''): string[] {
  if (obj === null || obj === undefined) return [];
  if (typeof obj !== 'object') return [`${encodeURIComponent(prefix)}=${encodeURIComponent(String(obj))}`];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    formEncode(v, prefix ? `${prefix}[${k}]` : k),
  );
}

export async function executeIntegration(
  r: ResolvedIntegration,
  req: IntegrationRequest,
  fetchImpl: FetchLike = fetch,
): Promise<IntegrationResult> {
  const url = buildUrl(r.baseUrl, req.path, req.query);
  const method = req.method.toUpperCase();
  const headers: Record<string, string> = { ...(r.def.headers ?? {}), ...(await authHeaders(r, fetchImpl)) };
  let body: string | undefined;
  if (req.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    if (r.def.name === 'stripe') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = formEncode(req.body).join('&');
    } else {
      headers['Content-Type'] = 'application/json';
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }
  }
  const res = await fetchImpl(url.toString(), { method, headers, body });
  let text = await res.text();
  for (const s of secretsOf(r)) text = text.split(s).join('[redacted]');
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    body: text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text,
    truncated: text.length > MAX_BODY,
  };
}
