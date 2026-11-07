/**
 * Signed share links for deliverables (reports, pages, spreadsheets, PDFs).
 *
 * The agent calls `share_file` on a file in its workspace. The host copies
 * it out of the session and returns a link that is signed (HMAC) and
 * expires (default 7 days, at most 30):
 *
 *   <PUBLIC_BASE_URL>/webhook/files?id=<id>&exp=<unix>&sig=<hmac>
 *
 * PUBLIC_BASE_URL is your tunnel or domain (default http://localhost:3000).
 * HTML is served sandboxed (no access to anything else on the host) with
 * nosniff. Links can't be guessed, and they stop working when they expire.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { audit } from '../../audit.js';
import { DATA_DIR } from '../../config.js';
import { getActiveSessions } from '../../db/sessions.js';
import { readEnvFile, setEnvValues } from '../../env.js';
import { log } from '../../log.js';
import { sessionDir } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { registerRawWebhookHandler } from '../../webhook-server.js';

const DEFAULT_HOURS = 24 * 7;
const MAX_HOURS = 24 * 30;
const MAX_BYTES = 50 * 1024 * 1024;
const POLL_MS = 300;

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  csv: 'text/csv; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function sharedDir(): string {
  return path.join(DATA_DIR, 'shared');
}

let secretCache: string | null = null;
export function shareSecret(): string {
  if (secretCache) return secretCache;
  let s = readEnvFile(['SHARE_LINK_SECRET']).SHARE_LINK_SECRET;
  if (!s) {
    s = crypto.randomBytes(32).toString('base64url');
    try {
      setEnvValues({ SHARE_LINK_SECRET: s });
    } catch (err) {
      log.warn('Could not save SHARE_LINK_SECRET; links will stop working after a restart', { err });
    }
  }
  secretCache = s;
  return s;
}

export function sign(id: string, exp: number, secret = shareSecret()): string {
  return crypto.createHmac('sha256', secret).update(`${id}.${exp}`).digest('base64url');
}

export function verify(id: string, exp: number, sig: string, now = Date.now(), secret = shareSecret()): boolean {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(id) || !Number.isFinite(exp) || exp * 1000 < now) return false;
  const expected = Buffer.from(sign(id, exp, secret));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

export function baseUrl(): string {
  const configured = readEnvFile(['PUBLIC_BASE_URL']).PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, '');
  return `http://localhost:${parseInt(process.env.WEBHOOK_PORT || '3000', 10)}`;
}

/** Resolve a workspace path inside the session directory; null if it escapes or doesn't exist. */
export function resolveWorkspacePath(sessionRoot: string, requested: string): string | null {
  const rel = requested.replace(/^\/workspace\/?/, '');
  const full = path.resolve(sessionRoot, rel);
  const root = path.resolve(sessionRoot);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  try {
    const real = fs.realpathSync(full);
    if (!real.startsWith(fs.realpathSync(root) + path.sep)) return null;
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

export function createShareLink(
  session: Session,
  sessionRoot: string,
  requested: string,
  hours = DEFAULT_HOURS,
): { url: string; expiresAt: string } | { error: string } {
  const file = resolveWorkspacePath(sessionRoot, requested);
  if (!file) return { error: `No file at ${requested} in your workspace.` };
  const size = fs.statSync(file).size;
  if (size > MAX_BYTES) return { error: 'That file is over 50 MB; send a smaller one or a summary.' };
  const id = crypto.randomBytes(18).toString('base64url');
  const dir = path.join(sharedDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  const name = path.basename(file).replace(/[^\w.-]/g, '_');
  fs.copyFileSync(file, path.join(dir, name));
  const exp = Math.floor(Date.now() / 1000) + Math.round(Math.min(Math.max(hours, 1), MAX_HOURS) * 3600);
  fs.writeFileSync(path.join(dir, '.meta.json'), JSON.stringify({ name, exp, sessionId: session.id }));
  audit('file.shared', { target: id, agentGroupId: session.agent_group_id, detail: { name, size, exp } });
  return {
    url: `${baseUrl()}/webhook/files?id=${id}&exp=${exp}&sig=${sign(id, exp)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export async function serveShared(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get('id') ?? '';
  const exp = Number(url.searchParams.get('exp'));
  const sig = url.searchParams.get('sig') ?? '';
  if (req.method !== 'GET' || !verify(id, exp, sig))
    return new Response('This link is invalid or has expired.', { status: 404 });
  let meta: { name: string };
  try {
    meta = JSON.parse(fs.readFileSync(path.join(sharedDir(), id, '.meta.json'), 'utf8')) as { name: string };
  } catch {
    return new Response('This link is invalid or has expired.', { status: 404 });
  }
  const ext = meta.name.split('.').pop()?.toLowerCase() ?? '';
  const type = TYPES[ext] ?? 'application/octet-stream';
  const body = fs.readFileSync(path.join(sharedDir(), id, meta.name));
  const headers: Record<string, string> = {
    'content-type': type,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'private, max-age=300',
  };
  // Pages run sandboxed: they can show charts, but can't reach cookies, storage or the rest of the host.
  if (type.startsWith('text/html') || ext === 'svg') headers['content-security-policy'] = 'sandbox allow-scripts';
  if (!TYPES[ext] || ['xlsx', 'docx', 'pptx'].includes(ext))
    headers['content-disposition'] = `attachment; filename="${meta.name}"`;
  return new Response(new Uint8Array(body), { headers });
}

/** Delete expired shares (called from the watcher about once an hour). */
export function pruneExpired(now = Date.now()): number {
  let n = 0;
  if (!fs.existsSync(sharedDir())) return 0;
  for (const id of fs.readdirSync(sharedDir())) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(sharedDir(), id, '.meta.json'), 'utf8')) as { exp: number };
      if (meta.exp * 1000 < now) {
        fs.rmSync(path.join(sharedDir(), id), { recursive: true, force: true });
        n++;
      }
    } catch {
      /* not a share folder */
    }
  }
  return n;
}

// ── File IPC with the container's share_file tool ──

let polling = false;
let lastPrune = 0;

async function pollOnce(): Promise<void> {
  for (const session of getActiveSessions()) {
    const root = sessionDir(session.agent_group_id, session.id);
    const reqDir = path.join(root, 'share', 'requests');
    if (!fs.existsSync(reqDir)) continue;
    for (const f of fs.readdirSync(reqDir).filter((x) => x.endsWith('.json'))) {
      const reqPath = path.join(reqDir, f);
      let req: { id: string; path: string; hours?: number };
      try {
        req = JSON.parse(fs.readFileSync(reqPath, 'utf8')) as typeof req;
        fs.unlinkSync(reqPath);
      } catch {
        continue;
      }
      const result = createShareLink(session, root, req.path, req.hours);
      const resDir = path.join(root, 'share', 'responses');
      fs.mkdirSync(resDir, { recursive: true });
      fs.writeFileSync(path.join(resDir, `${req.id}.json.tmp`), JSON.stringify(result));
      fs.renameSync(path.join(resDir, `${req.id}.json.tmp`), path.join(resDir, `${req.id}.json`));
    }
  }
  if (Date.now() - lastPrune > 60 * 60 * 1000) {
    lastPrune = Date.now();
    pruneExpired();
  }
}

export function startShareService(): void {
  registerRawWebhookHandler('files', serveShared);
  if (polling) return;
  polling = true;
  void (async () => {
    while (polling) {
      try {
        await pollOnce();
      } catch (err) {
        log.warn('Share watcher error', { err });
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  })();
}
