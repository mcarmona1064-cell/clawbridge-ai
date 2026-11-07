/** Why the agent answered or stayed quiet, per message (kept 7 days). */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration020: Migration = {
  version: 20,
  name: 'engage-log',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS engage_log (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        at             TEXT NOT NULL,
        channel_type   TEXT NOT NULL,
        platform_id    TEXT NOT NULL,
        thread_id      TEXT,
        agent_group_id TEXT NOT NULL,
        user_id        TEXT,
        engaged        INTEGER NOT NULL,
        reason         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_engage_log_chat ON engage_log(channel_type, platform_id, at);
    `);
  },
};
