/** Optional cost footer on replies, per conversation. */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration025: Migration = {
  version: 25,
  name: 'cost-footer',
  up(db: Database.Database) {
    const cols = db.prepare('PRAGMA table_info(session_prefs)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'cost_footer')) {
      db.exec('ALTER TABLE session_prefs ADD COLUMN cost_footer INTEGER NOT NULL DEFAULT 0');
    }
  },
};
