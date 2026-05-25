import type { Migration } from './index.js';

export const moduleEphemeralTasks: Migration = {
  version: 18,
  name: 'module-ephemeral-tasks',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ephemeral_tasks (
        id                  TEXT PRIMARY KEY,
        caller_group_id     TEXT NOT NULL,
        caller_session_id   TEXT NOT NULL,
        task_agent_group_id TEXT NOT NULL,
        task_agent_folder   TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'running',
        result              TEXT,
        created_at          TEXT NOT NULL,
        expires_at          TEXT NOT NULL
      )
    `);
  },
};
