/**
 * Browser hand-off: watch the agent's browser and take over.
 *
 * When the agent hits something only a person should do (signing in,
 * typing a password, solving a check, confirming a payment page), it calls
 * `browser_handoff`. The host posts a private link in the chat. The page
 * shows the agent's browser live and lets the person click, type and press
 * keys, then hand control back with "Done".
 *
 * What the person types goes straight into the browser. It is never shown
 * to the agent, written to its history or memory, or recorded in the audit
 * log (only the number of actions is). Links are signed, work for one
 * hand-off, and expire after at most 15 minutes.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { audit } from '../../audit.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getActiveSessions } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { sessionDir } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { registerRawWebhookHandler } from '../../webhook-server.js';
import { baseUrl, shareSecret } from '../share/index.js';

const MAX_MINUTES = 15;
const POLL_MS = 400;

interface Live {
  id: string;
  dir: string;
  exp: number;
  sessionId: string;
  agentGroupId: string;
  actions: number;
  done: boolean;
}

const lives = new Map<string, Live>();

function sig(id: string, exp: number): string {
  return crypto.createHmac('sha256', shareSecret()).update(`live.${id}.${exp}`).digest('base64url');
}

function valid(url: URL): Live | null {
  const id = url.searchParams.get('id') ?? '';
  const exp = Number(url.searchParams.get('exp'));
  const given = Buffer.from(url.searchParams.get('sig') ?? '');
  const live = lives.get(id);
  if (!live || live.done || live.exp !== exp || exp * 1000 < Date.now()) return null;
  const expected = Buffer.from(sig(id, exp));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? live : null;
}

export function handoffDir(sessionRoot: string): string {
  return path.join(sessionRoot, 'browser', 'handoff');
}

/** Start a hand-off for a request the container wrote. Returns the link. */
export function startHandoff(
  session: Session,
  sessionRoot: string,
  minutes: number,
): { id: string; url: string; exp: number } {
  const id = crypto.randomBytes(18).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + Math.round(Math.min(Math.max(minutes, 1), MAX_MINUTES) * 60);
  const dir = handoffDir(sessionRoot);
  fs.mkdirSync(path.join(dir, 'actions'), { recursive: true });
  lives.set(id, { id, dir, exp, sessionId: session.id, agentGroupId: session.agent_group_id, actions: 0, done: false });
  audit('browser.handoff', {
    target: session.id,
    agentGroupId: session.agent_group_id,
    detail: { event: 'started', exp },
  });
  return { id, exp, url: `${baseUrl()}/webhook/live?id=${id}&exp=${exp}&sig=${sig(id, exp)}` };
}

type Action =
  | { type: 'click'; fx: number; fy: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'done' };

const KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowDown', 'ArrowUp', 'Space']);

export function parseAction(body: unknown): Action | null {
  const a = body as Record<string, unknown>;
  if (
    a?.type === 'click' &&
    typeof a.fx === 'number' &&
    typeof a.fy === 'number' &&
    a.fx >= 0 &&
    a.fx <= 1 &&
    a.fy >= 0 &&
    a.fy <= 1
  ) {
    return { type: 'click', fx: a.fx, fy: a.fy };
  }
  if (a?.type === 'type' && typeof a.text === 'string' && a.text.length > 0 && a.text.length <= 2000)
    return { type: 'type', text: a.text };
  if (a?.type === 'key' && typeof a.key === 'string' && KEYS.has(a.key)) return { type: 'key', key: a.key };
  if (a?.type === 'done') return { type: 'done' };
  return null;
}

export async function handleLive(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const live = valid(url);
  if (!live) return new Response('This hand-off link has ended or is invalid.', { status: 404 });

  if (req.method === 'GET' && url.searchParams.get('frame') === '1') {
    const frame = path.join(live.dir, 'live.png');
    if (!fs.existsSync(frame)) return new Response(null, { status: 204 });
    return new Response(new Uint8Array(fs.readFileSync(frame)), {
      headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
    });
  }

  if (req.method === 'POST') {
    let action: Action | null = null;
    try {
      action = parseAction(await req.json());
    } catch {
      action = null;
    }
    if (!action) return new Response('Bad action', { status: 400 });
    const file = path.join(live.dir, 'actions', `${Date.now()}-${live.actions}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(action));
    fs.renameSync(`${file}.tmp`, file);
    live.actions++;
    if (action.type === 'done') {
      live.done = true;
      audit('browser.handoff', {
        target: live.sessionId,
        agentGroupId: live.agentGroupId,
        detail: { event: 'done', actions: live.actions },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  }

  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  return new Response(livePage(url.search), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'content-security-policy':
        "default-src 'self'; img-src 'self' blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    },
  });
}

export function livePage(search: string): string {
  const q = JSON.stringify(search);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Take over the browser</title>
<style>
:root{--bg:#f7f7f5;--fg:#1f2328;--muted:#6b7280;--line:#d1d5db;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#111315;--fg:#e8e8e6;--muted:#9ca3af;--line:#374151;--accent:#60a5fa}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px}
img{width:100%;border:1px solid var(--line);border-radius:8px;cursor:crosshair;background:#fff}
.row{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
input{flex:1;min-width:200px;padding:8px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit}
button{padding:8px 12px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.muted{color:var(--muted)}
</style></head><body><main>
<h1 style="font-size:18px;margin:0 0 4px">You're in control of the browser</h1>
<p class="muted">Click the picture to click in the browser. What you type here goes straight into the page; the assistant never sees it.</p>
<img id="f" alt="The assistant's browser">
<div class="row"><input id="t" type="password" placeholder="Type here, then Send" autocomplete="off">
<button id="send">Send</button><button id="show">Show</button></div>
<div class="row"><button data-k="Enter">Enter</button><button data-k="Tab">Tab</button><button data-k="Backspace">Backspace</button><button data-k="Escape">Esc</button>
<button id="done" class="primary">Done — hand back</button></div>
<p id="s" class="muted"></p>
<script>
const q=${q};const f=document.getElementById('f');const s=document.getElementById('s');let live=true;
function act(a){return fetch(location.pathname+q,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(a)}).then(r=>{if(!r.ok){live=false;s.textContent='This hand-off has ended.';}})}
function tick(){if(!live)return;fetch(location.pathname+q+'&frame=1',{cache:'no-store'}).then(r=>r.status===200?r.blob():null).then(b=>{if(b){const u=URL.createObjectURL(b);f.onload=()=>URL.revokeObjectURL(u);f.src=u;}}).finally(()=>setTimeout(tick,1000))}
f.addEventListener('click',e=>{const r=f.getBoundingClientRect();act({type:'click',fx:(e.clientX-r.left)/r.width,fy:(e.clientY-r.top)/r.height})});
document.getElementById('send').onclick=()=>{const t=document.getElementById('t');if(t.value){act({type:'type',text:t.value});t.value='';}};
document.getElementById('show').onclick=()=>{const t=document.getElementById('t');t.type=t.type==='password'?'text':'password'};
document.querySelectorAll('[data-k]').forEach(b=>b.onclick=()=>act({type:'key',key:b.dataset.k}));
document.getElementById('done').onclick=()=>act({type:'done'}).then(()=>{live=false;s.textContent='Handed back. You can close this page.'});
tick();
</script></main></body></html>`;
}

// ── Watch for hand-off requests from containers ──

let polling = false;

async function announce(session: Session, url: string, reason: string, minutes: number): Promise<void> {
  const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  const adapter = getDeliveryAdapter();
  if (!mg || !adapter) return;
  const text = `🖐️ **I need you in the browser:** ${reason}\nOpen this private link to take over (works for ${minutes} min): ${url}\nWhat you type there never reaches me.`;
  await adapter.deliver(mg.channel_type, mg.platform_id, session.thread_id ?? null, 'chat', JSON.stringify({ text }));
}

export async function pollHandoffs(): Promise<void> {
  for (const session of getActiveSessions()) {
    const dir = handoffDir(sessionDir(session.agent_group_id, session.id));
    const reqFile = path.join(dir, 'request.json');
    if (!fs.existsSync(reqFile)) continue;
    let req: { reason?: string; minutes?: number };
    try {
      req = JSON.parse(fs.readFileSync(reqFile, 'utf8')) as typeof req;
      fs.unlinkSync(reqFile);
    } catch {
      continue;
    }
    const minutes = Math.min(Math.max(Number(req.minutes) || 10, 1), MAX_MINUTES);
    const started = startHandoff(session, sessionDir(session.agent_group_id, session.id), minutes);
    fs.writeFileSync(path.join(dir, 'started.json'), JSON.stringify({ id: started.id, exp: started.exp }));
    await announce(session, started.url, String(req.reason ?? 'this step needs a person').slice(0, 300), minutes).catch(
      (err) => log.warn('Could not post the browser hand-off link', { err }),
    );
  }
  for (const [id, live] of lives) if (live.done || live.exp * 1000 < Date.now()) lives.delete(id);
}

export function startHandoffService(): void {
  registerRawWebhookHandler('live', handleLive);
  if (polling) return;
  polling = true;
  void (async () => {
    while (polling) {
      try {
        await pollHandoffs();
      } catch (err) {
        log.warn('Hand-off watcher error', { err });
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  })();
}
