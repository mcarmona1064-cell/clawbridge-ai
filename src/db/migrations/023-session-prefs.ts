/** Per-conversation preferences (model preset). */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration023: Migration = {
  version: 23,
  name: 'session-prefs',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_prefs (
        session_id   TEXT PRIMARY KEY,
        model_preset TEXT,
        updated_at   TEXT NOT NULL
      );
    `);
  },
};
