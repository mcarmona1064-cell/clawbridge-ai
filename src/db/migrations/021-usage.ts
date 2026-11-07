/** Usage ledger, budgets and budget alerts. */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration021: Migration = {
  version: 21,
  name: 'usage-ledger',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_ledger (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        at                 TEXT NOT NULL,
        agent_group_id     TEXT NOT NULL,
        session_id         TEXT,
        channel_type       TEXT,
        platform_id        TEXT,
        user_id            TEXT,
        provider           TEXT NOT NULL,
        model              TEXT,
        input_tokens       INTEGER NOT NULL DEFAULT 0,
        output_tokens      INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd           REAL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_agent_at ON usage_ledger(agent_group_id, at);
      CREATE INDEX IF NOT EXISTS idx_usage_user_at ON usage_ledger(user_id, at);

      CREATE TABLE IF NOT EXISTS budgets (
        agent_group_id TEXT PRIMARY KEY,
        monthly_tokens INTEGER,
        monthly_usd    REAL,
        updated_by     TEXT,
        updated_at     TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS budget_alerts (
        agent_group_id TEXT NOT NULL,
        month          TEXT NOT NULL,
        threshold      INTEGER NOT NULL,
        PRIMARY KEY (agent_group_id, month, threshold)
      );
    `);
  },
};
