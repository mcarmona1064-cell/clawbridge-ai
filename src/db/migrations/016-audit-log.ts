/**
 * Append-only audit log.
 *
 * One row per security-relevant event: approvals requested and decided,
 * host_exec runs, provider switches, role changes, account links, memory
 * writes and outbound posts. Triggers refuse UPDATE and DELETE, and every
 * row carries the hash of the previous row, so a gap or edit made around
 * the triggers (e.g. by editing the file directly) shows up in
 * `clawbridge-ai audit verify`.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'audit-log',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        at             TEXT NOT NULL,
        action         TEXT NOT NULL,
        actor          TEXT,
        target         TEXT,
        agent_group_id TEXT,
        channel_type   TEXT,
        detail_json    TEXT NOT NULL DEFAULT '{}',
        prev_hash      TEXT NOT NULL,
        hash           TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at);
      CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, at);

      CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    `);
  },
};
