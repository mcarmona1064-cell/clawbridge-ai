import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb } from '../../db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
} from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';
import { replyModeCommand } from './reply-mode.js';

describe('/reply', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    const now = new Date().toISOString();
    createAgentGroup({ id: 'ag-1', name: 'Ava', folder: 'ava', agent_provider: null, created_at: now });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: 'telegram:-100',
      name: 'Team',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    } as never);
    upsertUser({ id: 'telegram:1', kind: 'telegram', display_name: 'Ana', created_at: now });
    grantRole({ user_id: 'telegram:1', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now });
  });
  afterEach(() => closeDb());

  const run = (args: string, userId = 'telegram:1', supportsThreads = false) =>
    replyModeCommand({ agentGroupId: 'ag-1', messagingGroupId: 'mg-1', isGroup: true, userId, args, supportsThreads });

  it('shows the current setting to anyone and lets admins change it', () => {
    expect(run('', 'telegram:2')).toMatch(/when someone mentions me/);
    expect(run('all', 'telegram:2')).toMatch(/Only an admin/);
    expect(run('all')).toMatch(/every message/);
    expect(getMessagingGroupAgentByPair('mg-1', 'ag-1')).toMatchObject({ engage_mode: 'pattern', engage_pattern: '.' });
    expect(run('')).toMatch(/I answer every message/);
  });

  it('uses plain mentions on channels without threads, sticky threads where they exist', () => {
    run('mentions');
    expect(getMessagingGroupAgentByPair('mg-1', 'ag-1')?.engage_mode).toBe('mention');
    run('mentions', 'telegram:1', true);
    expect(getMessagingGroupAgentByPair('mg-1', 'ag-1')?.engage_mode).toBe('mention-sticky');
  });
});
