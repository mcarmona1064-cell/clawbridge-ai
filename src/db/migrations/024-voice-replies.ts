/** Opt-in voice replies per conversation. */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration024: Migration = {
  version: 24,
  name: 'voice-replies',
  up(db: Database.Database) {
    const cols = db.prepare('PRAGMA table_info(session_prefs)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'voice_replies')) {
      db.exec('ALTER TABLE session_prefs ADD COLUMN voice_replies INTEGER NOT NULL DEFAULT 0');
    }
  },
};
