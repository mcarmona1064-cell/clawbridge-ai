import type { Migration } from './index.js';

export const moduleA2aRetry: Migration = {
  version: 16,
  name: 'module-a2a-retry',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dropped_a2a_messages (
        id              TEXT PRIMARY KEY,
        source_group_id TEXT NOT NULL,
        target_group_id TEXT NOT NULL,
        msg_content     TEXT NOT NULL,
        error           TEXT,
        retry_count     INTEGER NOT NULL DEFAULT 0,
        next_retry_at   TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending'
      )
    `);
  },
};
