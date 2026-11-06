/**
 * Keep decided approvals as records instead of deleting them.
 *
 * `status` already exists (pending | approved | rejected | expired). This
 * adds who decided and when, so an approval card's outcome stays auditable
 * after the click.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const moduleApprovalsDecisions: Migration = {
  version: 14,
  name: 'approvals-decisions',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE pending_approvals ADD COLUMN decided_by TEXT`);
    db.exec(`ALTER TABLE pending_approvals ADD COLUMN decided_at TEXT`);
  },
};
