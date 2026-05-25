import type { Migration } from './index.js';

export const moduleFanOut: Migration = {
  version: 17,
  name: 'module-fan-out',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fan_out_tasks (
        id                      TEXT PRIMARY KEY,
        orchestrator_group_id   TEXT NOT NULL,
        orchestrator_session_id TEXT NOT NULL,
        target_group_ids        TEXT NOT NULL,
        replies                 TEXT NOT NULL DEFAULT '{}',
        collect_prompt          TEXT,
        expected_schema         TEXT,
        created_at              TEXT NOT NULL,
        expires_at              TEXT NOT NULL,
        status                  TEXT NOT NULL DEFAULT 'waiting'
      )
    `);
  },
};
