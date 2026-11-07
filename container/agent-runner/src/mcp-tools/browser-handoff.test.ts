import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'bun:test';

import { clickScript, runHandoff, typeScript } from './browser-handoff.js';

describe('browser hand-off (container side)', () => {
  it('streams screenshots, applies actions in order, and never returns what was typed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-handoff-'));
    const calls: string[][] = [];
    let step = 0;
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'screenshot') {
        fs.writeFileSync(args[1], 'png');
        step++;
        // The person acts after the first frame.
        if (step === 1) {
          fs.writeFileSync(path.join(dir, 'actions', '1-0.json'), JSON.stringify({ type: 'click', fx: 0.5, fy: 0.25 }));
          fs.writeFileSync(path.join(dir, 'actions', '1-1.json'), JSON.stringify({ type: 'type', text: 'hunter2' }));
          fs.writeFileSync(path.join(dir, 'actions', '1-2.json'), JSON.stringify({ type: 'key', key: 'Enter' }));
        }
        if (step === 2) fs.writeFileSync(path.join(dir, 'actions', '2-0.json'), JSON.stringify({ type: 'done' }));
      }
      return '';
    };
    const result = await runHandoff({ reason: 'Sign in to the bank', minutes: 1, run, dir, tickMs: 1 });
    expect(result).toEqual({ finished: 'done', actions: 3 });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8'))).toEqual({
      reason: 'Sign in to the bank',
      minutes: 1,
    });
    const ops = calls.filter((c) => c[0] !== 'screenshot');
    expect(ops[0][1]).toContain('0.5 * innerWidth');
    expect(ops[1][1]).toContain('"hunter2"');
    expect(ops[2]).toEqual(['press', 'Enter']);
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(fs.existsSync(path.join(dir, 'live.png'))).toBe(false);
  });

  it('times out cleanly', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-handoff-'));
    let t = 0;
    const result = await runHandoff({
      reason: 'x',
      minutes: 1,
      run: async () => '',
      dir,
      tickMs: 1,
      now: () => (t += 60_000),
    });
    expect(result.finished).toBe('timeout');
  });

  it('escapes typed text safely into the page script', () => {
    expect(typeScript('a"); alert(1); ("')).toContain(JSON.stringify('a"); alert(1); ("'));
    expect(clickScript(0, 1)).toContain('1 * innerHeight');
  });
});
