import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { box } = vi.hoisted(() => ({ box: { db: null as Database.Database | null } }));
vi.mock('../../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../session-manager.js', () => ({
  openInboundDb: () => {
    // The command closes the handle it gets; hand out a proxy that keeps the test DB open.
    return new Proxy(box.db!, { get: (t, k) => (k === 'close' ? () => undefined : (t as never)[k as never]) });
  },
}));

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { Session } from '../../types.js';
import { digestCommand, parseTime } from './digest-cmd.js';

const session = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;
const run = (args: string) =>
  digestCommand({
    session,
    userId: 'slack:U1',
    isGroup: false,
    args,
    channelType: 'slack',
    platformId: 'slack:D1',
    threadId: null,
  });

describe('/digest', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    box.db = new Database(':memory:');
    box.db.exec(`CREATE TABLE messages_in (id TEXT PRIMARY KEY, seq INTEGER, timestamp TEXT, status TEXT, tries INTEGER,
      process_after TEXT, recurrence TEXT, kind TEXT, platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT, series_id TEXT, trigger INTEGER)`);
  });
  afterEach(() => {
    closeDb();
    box.db?.close();
  });

  it('reads times people actually type', () => {
    expect(parseTime('9:30')).toEqual({ hour: 9, minute: 30 });
    expect(parseTime('5pm')).toEqual({ hour: 17, minute: 0 });
    expect(parseTime('25:00')).toBeNull();
  });

  it('turns a weekday digest on, shows it, moves it, and turns it off', () => {
    expect(run('')).toMatch(/No daily digest/);
    expect(run('on 8:15')).toMatch(/weekdays at 08:15/);
    const rows = box
      .db!.prepare("SELECT recurrence, content FROM messages_in WHERE kind = 'task' AND status = 'pending'")
      .all() as Array<{
      recurrence: string;
      content: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].recurrence).toBe('15 8 * * 1-5');
    expect(JSON.parse(rows[0].content).prompt).toContain('NO_DIGEST');
    expect(run('')).toMatch(/on, weekdays at 08:15/);

    expect(run('on 17:00')).toMatch(/17:00/);
    expect(box.db!.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE status = 'pending'").get()).toEqual({ n: 1 });

    expect(run('off')).toMatch(/stopped/);
    expect(run('')).toMatch(/No daily digest/);
  });

  it('needs an admin to change it in a group', () => {
    expect(
      digestCommand({
        session,
        userId: 'slack:U9',
        isGroup: true,
        args: 'on',
        channelType: 'slack',
        platformId: 'slack:C1',
        threadId: null,
      }),
    ).toMatch(/Only an admin/);
  });
});
