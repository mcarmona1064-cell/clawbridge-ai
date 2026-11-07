/**
 * Runs every eval case on both providers, three times each (pass^3), with a
 * fresh database per run, and writes evals/report.json.
 *
 *   pnpm run eval
 */
import fs from 'fs';
import path from 'path';

import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/env.js', () => ({ readEnvFile: () => ({}), setEnvValues: vi.fn(), envFilePath: () => '/dev/null' }));
vi.mock('../src/delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: async () => 'x' }),
  registerDeliveryAction: vi.fn(),
}));
vi.mock('../src/container-runner.js', () => ({
  wakeContainer: vi.fn(),
  isContainerRunning: () => false,
  killContainer: vi.fn(),
  resolveProviderName: () => 'claude',
}));
vi.mock('../src/stop-session.js', () => ({ stopChatSession: async () => true }));
vi.mock('../src/webhook-server.js', () => ({ registerRawWebhookHandler: vi.fn() }));

import { resetClaimGate } from '../src/claim-gate.js';
import { closeDb, initTestDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { CASES as BASE_CASES, type Provider } from './cases.js';
import { M4_CASES } from './cases-m4.js';

const CASES = [...BASE_CASES, ...M4_CASES];

const PROVIDERS: Provider[] = ['claude', 'codex'];
const RUNS = 3;

const results: Array<{ id: string; area: string; provider: Provider; passes: number; error?: string }> = [];

describe.each(PROVIDERS)('%s', (provider) => {
  it.each(CASES.map((c) => [c.id, c] as const))('%s', async (_id, c) => {
    let passes = 0;
    let error: string | undefined;
    for (let i = 0; i < RUNS; i++) {
      runMigrations(initTestDb());
      resetClaimGate();
      try {
        await c.run(provider);
        passes++;
      } catch (err) {
        error = (err as Error).message;
      } finally {
        closeDb();
      }
    }
    results.push({ id: c.id, area: c.area, provider, passes, ...(error ? { error } : {}) });
    expect(error ? `${c.user} → expected: ${c.expect}. Failed: ${error}` : 'ok').toBe('ok');
    expect(passes).toBe(RUNS);
  });
});

afterAll(() => {
  const passed = results.filter((r) => r.passes === RUNS).length;
  const report = {
    at: new Date().toISOString(),
    cases: CASES.length,
    providers: PROVIDERS,
    runsPerCase: RUNS,
    passHat3: `${passed}/${results.length}`,
    byArea: Object.fromEntries(
      [...new Set(results.map((r) => r.area))].map((a) => {
        const rs = results.filter((r) => r.area === a);
        return [a, `${rs.filter((r) => r.passes === RUNS).length}/${rs.length}`];
      }),
    ),
    failures: results.filter((r) => r.passes !== RUNS),
  };
  fs.writeFileSync(path.join(__dirname, 'report.json'), JSON.stringify(report, null, 2) + '\n');
});
