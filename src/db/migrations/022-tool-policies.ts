/** Allow / deny rules per agent and action, e.g. "always allow `npm test` on the host". */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration022: Migration = {
  version: 22,
  name: 'tool-policies',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_policies (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_group_id TEXT NOT NULL,
        action         TEXT NOT NULL,
        scope          TEXT NOT NULL,
        decision       TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
        created_by     TEXT,
        created_at     TEXT NOT NULL,
        UNIQUE (agent_group_id, action, scope)
      );
    `);
  },
};
