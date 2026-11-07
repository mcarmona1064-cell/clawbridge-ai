import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { canApprove, canAudit, grantRole, hasAdminPrivilege } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';
import { parsePerson, rolesCommand } from './roles-cmd.js';

const run = (userId: string, args: string) =>
  rolesCommand({ agentGroupId: 'ag-1', channelType: 'slack', userId, args });

describe('/roles', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    const now = new Date().toISOString();
    createAgentGroup({ id: 'ag-1', name: 'Ava', folder: 'ava', agent_provider: null, created_at: now });
    createAgentGroup({ id: 'ag-2', name: 'Bo', folder: 'bo', agent_provider: null, created_at: now });
    upsertUser({ id: 'slack:OWNER', kind: 'slack', display_name: 'Ana', created_at: now });
    grantRole({ user_id: 'slack:OWNER', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now });
  });
  afterEach(() => closeDb());

  it('reads mentions and ids', () => {
    expect(parsePerson('<@U123>', 'slack')).toBe('slack:U123');
    expect(parsePerson('<@!42>', 'discord')).toBe('discord:42');
    expect(parsePerson('telegram:7', 'slack')).toBe('telegram:7');
    expect(parsePerson('bob', 'slack')).toBeNull();
  });

  it('an approver can answer cards but not manage; an auditor can read but not approve', () => {
    expect(run('slack:OWNER', 'grant <@UAPP> approver')).toMatch(/now approver/);
    expect(run('slack:OWNER', 'grant slack:UAUD auditor')).toMatch(/now auditor/);
    expect(canApprove('slack:UAPP', 'ag-1')).toBe(true);
    expect(hasAdminPrivilege('slack:UAPP', 'ag-1')).toBe(false);
    expect(canApprove('slack:UAPP', 'ag-2')).toBe(false);
    expect(canAudit('slack:UAUD', 'ag-1')).toBe(true);
    expect(canApprove('slack:UAUD', 'ag-1')).toBe(false);
    expect(run('slack:UAPP', 'grant slack:X approver')).toMatch(/Only an admin/);
    expect(run('slack:OWNER', '')).toMatch(/Approver — answer approval cards/);
  });

  it('only the owner makes admins; admins can add approvers', () => {
    expect(run('slack:OWNER', 'grant slack:UADM admin')).toMatch(/now admin/);
    expect(run('slack:UADM', 'grant slack:U2 admin')).toMatch(/Only the owner/);
    expect(run('slack:UADM', 'grant slack:U2 approver')).toMatch(/now approver/);
    expect(run('slack:UADM', 'revoke slack:U2 approver')).toMatch(/Removed/);
    expect(canApprove('slack:U2', 'ag-1')).toBe(false);
  });
});
