/**
 * Per-contact delivery state for channels with messaging rules.
 *
 * WhatsApp only allows free-form messages within 24 hours of the person's
 * last message (templates outside that window), and people must be able to
 * opt out with STOP. This table records both, per chat.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: 'contact-state',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS contact_state (
        channel_type    TEXT NOT NULL,
        platform_id     TEXT NOT NULL,
        last_inbound_at TEXT,
        opted_out_at    TEXT,
        PRIMARY KEY (channel_type, platform_id)
      );
    `);
  },
};
