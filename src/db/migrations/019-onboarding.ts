/** Onboarding conversation state, one row per agent group. */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration019: Migration = {
  version: 19,
  name: 'onboarding',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS onboarding (
        agent_group_id TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL,
        status         TEXT NOT NULL,
        step           INTEGER NOT NULL DEFAULT 0,
        answers_json   TEXT NOT NULL DEFAULT '{}',
        channel_type   TEXT NOT NULL,
        platform_id    TEXT NOT NULL,
        thread_id      TEXT,
        updated_at     TEXT NOT NULL
      );
    `);
  },
};
