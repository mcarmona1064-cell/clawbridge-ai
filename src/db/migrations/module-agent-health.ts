import type { Migration } from './index.js';

export const moduleAgentHealth: Migration = {
  version: 15,
  name: 'module-agent-health',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_health (
        agent_group_id     TEXT PRIMARY KEY,
        consecutive_errors INTEGER NOT NULL DEFAULT 0,
        last_error         TEXT,
        last_ok_at         TEXT,
        updated_at         TEXT NOT NULL
      )
    `);
  },
};
