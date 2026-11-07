import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { alerts } = vi.hoisted(() => ({ alerts: [] as string[] }));
vi.mock('./log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./shared/admin-alert.js', () => ({ sendAdminAlert: async (t: string) => void alerts.push(t) }));

import Database from 'better-sqlite3';

import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { grantRole } from './modules/permissions/db/user-roles.js';
import { upsertUser } from './modules/permissions/db/users.js';
import { budgetCommand, handleRecordUsage, usageCommand } from './modules/usage/index.js';
import { budgetPercent, overBudget, parseBudget, recordUsage } from './usage.js';
import type { Session } from './types.js';

const session = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;

function inDbWithSender(senderId: string): Database.Database {
  const db = new Database(':memory:');
  db.exec(
    `CREATE TABLE messages_in (id TEXT, seq INTEGER, kind TEXT, content TEXT, timestamp TEXT, status TEXT, trigger INTEGER)`,
  );
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, content, timestamp, status, trigger) VALUES ('m1', 1, 'chat', ?, '2026-11-06', 'completed', 1)`,
  ).run(JSON.stringify({ text: 'hi', senderId }));
  return db;
}

describe('usage ledger and budgets', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    alerts.length = 0;
    createAgentGroup({
      id: 'ag-1',
      name: 'Ava',
      folder: 'ava',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    upsertUser({ id: 'slack:U1', kind: 'slack', display_name: 'Ana', created_at: new Date().toISOString() });
    grantRole({
      user_id: 'slack:U1',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: new Date().toISOString(),
    });
  });
  afterEach(() => closeDb());

  it('records each turn against the person who asked, and reports it with /usage', async () => {
    await handleRecordUsage(
      {
        action: 'record_usage',
        provider: 'claude',
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadTokens: 50_000,
        cacheWriteTokens: 500,
        costUsd: 0.04,
      },
      session,
      inDbWithSender('slack:U1'),
    );
    expect(usageCommand('ag-1', 'slack:U9')).not.toContain('By person');
    const text = usageCommand('ag-1', 'slack:U1');
    expect(text).toContain('1 replies · 2.0k tokens (plus 50k cached) · about $0.04');
    expect(text).toContain('slack:U1: 2.0k');
    expect(text).toContain('No budget set');
  });

  it('parses budgets in tokens or dollars', () => {
    expect(parseBudget('5M')).toEqual({ monthlyTokens: 5_000_000, monthlyUsd: null });
    expect(parseBudget('500k tokens')).toEqual({ monthlyTokens: 500_000, monthlyUsd: null });
    expect(parseBudget('$50')).toEqual({ monthlyTokens: null, monthlyUsd: 50 });
    expect(parseBudget('off')).toBe('off');
    expect(parseBudget('lots')).toBeNull();
  });

  it('alerts at 50/75/90/100% once each, then holds the agent at the cap', async () => {
    expect(budgetCommand('ag-1', 'slack:U9', '10k')).toMatch(/Only an admin/);
    expect(budgetCommand('ag-1', 'slack:U1', '10k')).toMatch(/10k tokens/);
    const turn = (tokens: number) =>
      handleRecordUsage(
        {
          action: 'record_usage',
          provider: 'codex',
          inputTokens: tokens,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        session,
        inDbWithSender('slack:U1'),
      );
    await turn(5_500);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('used 50%');
    await turn(100);
    expect(alerts).toHaveLength(1);
    expect(overBudget('ag-1')).toBe(false);
    await turn(5_000);
    expect(alerts.at(-1)).toContain('reached its monthly budget');
    expect(overBudget('ag-1')).toBe(true);

    // Raising the budget clears the hold.
    budgetCommand('ag-1', 'slack:U1', '1M');
    expect(overBudget('ag-1')).toBe(false);
    expect(Math.round(budgetPercent('ag-1')!)).toBe(1);
  });

  it('counts the USD estimate against a dollar budget', () => {
    budgetCommand('ag-1', 'slack:U1', '$1');
    recordUsage({
      agentGroupId: 'ag-1',
      provider: 'claude',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 1.2,
    });
    expect(overBudget('ag-1')).toBe(true);
  });
});
