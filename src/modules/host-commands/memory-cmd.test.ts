import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';
import { memoryCommand, type MemoryClient } from './memory-cmd.js';

function fakeClient(): MemoryClient & { banks: Map<string, Array<{ id: string; text: string; document_id: string }>> } {
  const banks = new Map<string, Array<{ id: string; text: string; document_id: string }>>([
    ['client-ag-1--mg-1', [{ id: 'u1', text: 'Ana prefers weekly summaries on Monday', document_id: 'doc-aaaa1111' }]],
    ['client-ag-1--team', [{ id: 'u2', text: 'Payroll runs on the 25th', document_id: 'doc-bbbb2222' }]],
  ]);
  return {
    banks,
    async listMemories(bank, opts) {
      let items = banks.get(bank) ?? [];
      if (opts.q) items = items.filter((m) => m.text.toLowerCase().includes(opts.q!.toLowerCase()));
      if (opts.documentId) items = items.filter((m) => m.document_id === opts.documentId);
      return { items };
    },
    async deleteDocument(bank, documentId) {
      banks.set(
        bank,
        (banks.get(bank) ?? []).filter((m) => m.document_id !== documentId),
      );
    },
  };
}

const up = async () => true;
const input = (args: string, userId = 'slack:U1', isGroup = false) => ({
  agentGroupId: 'ag-1',
  messagingGroupId: 'mg-1',
  isGroup,
  userId,
  args,
});

describe('/memory', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    upsertUser({ id: 'slack:ADMIN', kind: 'slack', display_name: 'Ana', created_at: new Date().toISOString() });
    grantRole({
      user_id: 'slack:ADMIN',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: new Date().toISOString(),
    });
  });
  afterEach(() => closeDb());

  it('shows this conversation and the team, with ids', async () => {
    const text = await memoryCommand(input(''), fakeClient(), up);
    expect(text).toMatch(/This conversation[\s\S]*weekly summaries[\s\S]*doc-aaaa/);
    expect(text).toMatch(/Team knowledge[\s\S]*Payroll/);
    expect(await memoryCommand(input('search payroll'), fakeClient(), up)).not.toContain('weekly');
  });

  it('forgets a conversation memory in a DM and verifies it is gone', async () => {
    const client = fakeClient();
    expect(await memoryCommand(input('forget doc-aaaa'), client, up)).toMatch(/it's gone/);
    expect(client.banks.get('client-ag-1--mg-1')).toEqual([]);
  });

  it('keeps team facts and group memories for admins to remove', async () => {
    const client = fakeClient();
    expect(await memoryCommand(input('forget doc-bbbb'), client, up)).toMatch(/No memory/);
    expect(await memoryCommand(input('forget doc-aaaa', 'slack:U1', true), client, up)).toMatch(/only admins/);
    expect(await memoryCommand(input('forget doc-bbbb', 'slack:ADMIN', true), client, up)).toMatch(/gone/);
  });

  it('says so when memory is down', async () => {
    expect(await memoryCommand(input(''), fakeClient(), async () => false)).toMatch(/isn't reachable/);
  });
});
