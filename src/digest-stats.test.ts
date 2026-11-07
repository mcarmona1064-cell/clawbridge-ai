import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { digestScore, isDigestTurn, recordDigestPosted, recordHumanActivity } from './digest-stats.js';

describe('digest scorecard', () => {
  beforeEach(() => runMigrations(initTestDb()));
  afterEach(() => closeDb());

  it('counts a digest as engaged once when someone writes within two hours', () => {
    const t0 = new Date('2026-11-06T09:00:00Z');
    recordDigestPosted('s1', t0);
    recordHumanActivity('s1', t0.getTime() + 30 * 60_000);
    recordHumanActivity('s1', t0.getTime() + 40 * 60_000);
    recordDigestPosted('s1', new Date('2026-11-07T09:00:00Z'));
    recordHumanActivity('s1', Date.parse('2026-11-07T12:30:00Z')); // too late
    expect(digestScore('s1')).toEqual({ posted: 2, engaged: 1 });
  });

  it('recognises a digest turn from the task that started it', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE messages_in (seq INTEGER, kind TEXT, content TEXT)');
    db.prepare("INSERT INTO messages_in VALUES (1, 'task', ?)").run(JSON.stringify({ prompt: 'DIGEST' }));
    expect(isDigestTurn(db, 'DIGEST')).toBe(true);
    db.prepare("INSERT INTO messages_in VALUES (2, 'chat', '{}')").run();
    expect(isDigestTurn(db, 'DIGEST')).toBe(false);
  });
});
