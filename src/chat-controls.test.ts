import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stops: unknown[] = [];
vi.mock('./log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./stop-session.js', () => ({
  stopChatSession: async (...args: unknown[]) => {
    stops.push(args);
    return true;
  },
}));

import { handleChatControl, isChatControl, mutedUntil } from './chat-controls.js';
import { closeDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { grantRole } from './modules/permissions/db/user-roles.js';
import { upsertUser } from './modules/permissions/db/users.js';

const base = {
  channelType: 'telegram',
  platformId: 'telegram:-100',
  threadId: null,
  senderId: 'telegram:1',
  isGroup: false,
};

describe('chat controls', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    stops.length = 0;
  });
  afterEach(() => {
    closeDb();
    vi.useRealTimers();
  });

  it('recognises only bang commands', () => {
    expect(isChatControl('!stop')).toBe(true);
    expect(isChatControl('  !Mute 2')).toBe(true);
    expect(isChatControl('stop')).toBe(false);
    expect(isChatControl('please !stop')).toBe(false);
  });

  it('!stop stops the session for this chat, from anyone', async () => {
    expect(await handleChatControl({ ...base, isGroup: true, senderId: 'telegram:999', text: '!stop' })).toMatch(
      /Stopped/,
    );
    expect(stops).toEqual([['telegram', 'telegram:-100', null, 'telegram:999']]);
  });

  it('!mute silences the chat until it expires or !unmute', async () => {
    expect(await handleChatControl({ ...base, text: '!mute 2' })).toMatch(/next 2 hours/);
    expect(mutedUntil('telegram', 'telegram:-100')).not.toBeNull();
    expect(mutedUntil('telegram', 'telegram:other')).toBeNull();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3 * 3_600_000);
    expect(mutedUntil('telegram', 'telegram:-100')).toBeNull();
    vi.useRealTimers();

    await handleChatControl({ ...base, text: '!mute' });
    expect(await handleChatControl({ ...base, text: '!unmute' })).toMatch(/back/);
    expect(mutedUntil('telegram', 'telegram:-100')).toBeNull();
    expect(await handleChatControl({ ...base, text: '!mute forever' })).toMatch(/Use !mute/);
  });

  it('only admins can mute a group', async () => {
    expect(await handleChatControl({ ...base, isGroup: true, text: '!mute' })).toMatch(/Only an admin/);
    upsertUser({ id: 'telegram:1', kind: 'telegram', display_name: 'Ana', created_at: new Date().toISOString() });
    grantRole({
      user_id: 'telegram:1',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: new Date().toISOString(),
    });
    expect(await handleChatControl({ ...base, isGroup: true, text: '!mute 1' })).toMatch(/quiet/);
  });
});
