import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  isContainerRunning: (id: string) => id === 'sess-busy',
  resolveProviderName: (_s: unknown, g: string | null) => g ?? 'claude',
}));
vi.mock('./container-config.js', () => ({ readContainerConfig: () => ({ provider: undefined }) }));

import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, getDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { createUserLink } from './db/user-links.js';
import { buildHomeSummary, homeSummaryMarkdown, setTaskCounter, slackHomeView } from './home-summary.js';

describe('home summary', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    createAgentGroup({
      id: 'ag-1',
      name: 'Ava',
      folder: 'ava',
      agent_provider: 'codex',
      created_at: new Date().toISOString(),
    });
    getDb()
      .prepare(
        `INSERT INTO pending_approvals (approval_id, request_id, action, payload, created_at, status, title, options_json)
         VALUES ('appr-1', 'appr-1', 'team_memory', '{}', '2026-11-06T10:00:00Z', 'pending', 'Save to team memory?', '[]')`,
      )
      .run();
    setTaskCounter(() => 2);
  });
  afterEach(() => closeDb());

  it('summarises agents, approvals, jobs and linked accounts', () => {
    createUserLink('whatsapp:1555', 'slack:U1', 'slack:U1');
    const s = buildHomeSummary('whatsapp:1555');
    expect(s.agents).toEqual([{ id: 'ag-1', name: 'Ava', provider: 'codex', working: false, conversations: 0 }]);
    expect(s.pendingApprovals.map((p) => p.title)).toEqual(['Save to team memory?']);
    expect(s.scheduledJobs).toBe(2);
    expect(s.linkedAccounts).toEqual(['slack:U1', 'whatsapp:1555']);

    const md = homeSummaryMarkdown(s);
    expect(md).toContain('• Ava: ready · codex');
    expect(md).toContain('Waiting for approval (1)');

    const view = slackHomeView(s) as { type: string; blocks: Array<{ type: string }> };
    expect(view.type).toBe('home');
    expect(view.blocks[0]).toMatchObject({ type: 'header' });
    expect(JSON.stringify(view)).toContain('Linked accounts');
  });
});
