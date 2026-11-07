/**
 * browser_handoff — let a person take over the agent's browser.
 *
 * Use it when a step needs a human: signing in, typing a password or a
 * one-time code, solving a check, confirming a payment. The host posts a
 * private link in the chat. While the person is there, this tool streams
 * screenshots of the browser and applies their clicks, typing and keys.
 * It returns when they press "Done" (or time runs out). Whatever they typed
 * is never returned to you.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const DIR = '/workspace/browser/handoff';

export type Runner = (args: string[]) => Promise<string>;

export const agentBrowser: Runner = (args) =>
  new Promise((resolve, reject) =>
    execFile('agent-browser', args, { timeout: 15_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout),
    ),
  );

type Action =
  | { type: 'click'; fx: number; fy: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'done' };

/** JavaScript that clicks the element under a point given as fractions of the viewport. */
export function clickScript(fx: number, fy: number): string {
  return `(() => { const el = document.elementFromPoint(${fx} * innerWidth, ${fy} * innerHeight); if (!el) return 'none'; el.focus && el.focus(); el.click(); return el.tagName; })()`;
}

/** JavaScript that appends text to the focused field (works for React-controlled inputs too). */
export function typeScript(text: string): string {
  return `(() => { const el = document.activeElement; if (!el || !('value' in el)) return 'no-field'; const t = ${JSON.stringify(text)};
    const proto = Object.getPrototypeOf(el); const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, el.value + t); else el.value += t;
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`;
}

export async function applyAction(run: Runner, a: Action): Promise<void> {
  if (a.type === 'click') await run(['eval', clickScript(a.fx, a.fy)]);
  else if (a.type === 'type') await run(['eval', typeScript(a.text)]);
  else if (a.type === 'key') await run(['press', a.key === 'Space' ? ' ' : a.key]);
}

export async function runHandoff(opts: {
  reason: string;
  minutes: number;
  run?: Runner;
  dir?: string;
  tickMs?: number;
  now?: () => number;
}): Promise<{ finished: 'done' | 'timeout'; actions: number }> {
  const run = opts.run ?? agentBrowser;
  const dir = opts.dir ?? DIR;
  const now = opts.now ?? Date.now;
  const tick = opts.tickMs ?? 1000;
  fs.mkdirSync(path.join(dir, 'actions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ reason: opts.reason, minutes: opts.minutes }));
  const deadline = now() + opts.minutes * 60_000 + 30_000;
  let actions = 0;
  while (now() < deadline) {
    await run(['screenshot', path.join(dir, 'live.png')]).catch(() => undefined);
    const files = fs.existsSync(path.join(dir, 'actions'))
      ? fs
          .readdirSync(path.join(dir, 'actions'))
          .filter((f) => f.endsWith('.json'))
          .sort()
      : [];
    for (const f of files) {
      const file = path.join(dir, 'actions', f);
      let a: Action;
      try {
        a = JSON.parse(fs.readFileSync(file, 'utf8')) as Action;
      } finally {
        fs.rmSync(file, { force: true });
      }
      if (a.type === 'done') {
        fs.rmSync(path.join(dir, 'live.png'), { force: true });
        return { finished: 'done', actions };
      }
      await applyAction(run, a).catch(() => undefined);
      actions++;
    }
    await new Promise((r) => setTimeout(r, tick));
  }
  fs.rmSync(path.join(dir, 'live.png'), { force: true });
  return { finished: 'timeout', actions };
}

export const browserHandoff: McpToolDefinition = {
  tool: {
    name: 'browser_handoff',
    description:
      'Hand the browser to a person for a step only they should do (sign in, password, one-time code, CAPTCHA, payment confirmation). Posts a private live link in the chat and waits until they press Done (max 15 minutes). You never see what they type. Afterwards, take a new snapshot to continue.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reason: { type: 'string', description: 'What you need them to do, in one sentence.' },
        minutes: { type: 'number', description: 'How long to wait (1–15, default 10).' },
      },
      required: ['reason'],
    },
  },
  async handler(args) {
    const minutes = Math.min(Math.max(Number(args.minutes) || 10, 1), 15);
    const result = await runHandoff({ reason: String(args.reason ?? ''), minutes });
    return {
      content: [
        {
          type: 'text' as const,
          text:
            result.finished === 'done'
              ? `The person finished in the browser (${result.actions} actions) and handed it back. Take a snapshot to see where things are.`
              : `Nobody finished the hand-off within ${minutes} minutes. Ask in the chat whether to try again.`,
        },
      ],
    };
  },
};

registerTools([browserHandoff]);
