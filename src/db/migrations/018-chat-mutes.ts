/** Per-chat mute: `!mute` keeps the agent quiet in one chat until a time or `!unmute`. */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration018: Migration = {
  version: 18,
  name: 'chat-mutes',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_mutes (
        channel_type TEXT NOT NULL,
        platform_id  TEXT NOT NULL,
        until        TEXT NOT NULL,
        muted_by     TEXT,
        PRIMARY KEY (channel_type, platform_id)
      );
    `);
  },
};
