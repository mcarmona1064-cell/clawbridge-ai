import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({ wakeContainer: vi.fn(async () => undefined) }));
vi.mock('../../session-manager.js', () => ({ writeSessionMessage: vi.fn() }));

import {
  closeDb,
  createAgentGroup,
  createPendingApproval,
  createSession,
  getPendingApproval,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { createUser } from '../permissions/db/users.js';
import type { Session } from '../../types.js';
import { registerApprovalHandler } from './primitive.js';
import { clickerIdFor, expireStaleApprovals, handleApprovalsResponse } from './response-handler.js';

const handler = vi.fn(async () => undefined);
registerApprovalHandler('test_action', handler);

const now = () => new Date().toISOString();

function addApproval(id: string, expiresAt: string | null = new Date(Date.now() + 60_000).toISOString()) {
  createPendingApproval({
    approval_id: id,
    session_id: 's-1',
    request_id: id,
    action: 'test_action',
    payload: JSON.stringify({ x: 1 }),
    created_at: now(),
    agent_group_id: 'ag-1',
    expires_at: expiresAt,
    title: 'Test',
    options_json: '[]',
  });
}

const click = (id: string, userId: string, value = 'approve') =>
  handleApprovalsResponse({ questionId: id, value, userId, channelType: 'slack', platformId: '', threadId: null });

beforeEach(() => {
  runMigrations(initTestDb());
  handler.mockClear();
  createAgentGroup({ id: 'ag-1', name: 'Ops', folder: 'ops', agent_provider: null, created_at: now() });
  createSession({
    id: 's-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  } as Session);
  for (const id of ['slack:UADMIN', 'slack:UBYSTANDER']) {
    createUser({ id, kind: 'slack', display_name: id, created_at: now() });
  }
  grantRole({ user_id: 'slack:UADMIN', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });
});

afterEach(() => closeDb());

describe('approval responses', () => {
  it('namespaces raw click ids and keeps already-namespaced ones', () => {
    expect(clickerIdFor({ userId: 'U1', channelType: 'slack' })).toBe('slack:U1');
    expect(clickerIdFor({ userId: 'slack:U1', channelType: 'slack' })).toBe('slack:U1');
    expect(clickerIdFor({ userId: '', channelType: 'slack' })).toBeNull();
  });

  it('ignores a click from someone who is not an owner or admin of the agent group', async () => {
    addApproval('a-1');
    await expect(click('a-1', 'UBYSTANDER')).resolves.toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(getPendingApproval('a-1')?.status).toBe('pending');
  });

  it('applies an admin approval and keeps the row as a record of who decided', async () => {
    addApproval('a-2');
    await click('a-2', 'UADMIN');
    expect(handler).toHaveBeenCalledTimes(1);
    const row = getPendingApproval('a-2');
    expect(row).toMatchObject({ status: 'approved', decided_by: 'slack:UADMIN' });
    expect(row?.decided_at).toBeTruthy();
  });

  it('cannot be decided twice', async () => {
    addApproval('a-3');
    await click('a-3', 'UADMIN', 'reject');
    await click('a-3', 'UADMIN', 'approve');
    expect(handler).not.toHaveBeenCalled();
    expect(getPendingApproval('a-3')?.status).toBe('rejected');
  });

  it('refuses an expired approval and the sweep expires stale ones', async () => {
    addApproval('a-4', new Date(Date.now() - 1000).toISOString());
    await click('a-4', 'UADMIN');
    expect(handler).not.toHaveBeenCalled();
    expect(getPendingApproval('a-4')?.status).toBe('expired');

    addApproval('a-5', new Date(Date.now() - 1000).toISOString());
    addApproval('a-6');
    await expect(expireStaleApprovals()).resolves.toBe(1);
    expect(getPendingApproval('a-5')?.status).toBe('expired');
    expect(getPendingApproval('a-6')?.status).toBe('pending');
  });
});
