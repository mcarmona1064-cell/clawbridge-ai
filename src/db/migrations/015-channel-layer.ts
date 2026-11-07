/**
 * Channel layer: numbered-reply prompts, cross-channel identity links and
 * per-user notification preferences, plus expiry for question cards.
 *
 * - numbered_prompts: question/approval cards rendered as a numbered list on
 *   channels without buttons. A reply of "2" in that chat answers the card.
 * - user_links: an alias account (e.g. whatsapp:+1555…) that belongs to the
 *   same person as a primary account (e.g. slack:U123). Roles, approvals,
 *   per-person memory and usage resolve through the primary id.
 * - link_codes: one-time codes for linking, confirmed by the primary account.
 * - user_prefs: where a person wants approvals and alerts delivered.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration015: Migration = {
  version: 15,
  name: 'channel-layer',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS numbered_prompts (
        question_id  TEXT PRIMARY KEY,
        channel_type TEXT NOT NULL,
        platform_id  TEXT NOT NULL,
        thread_id    TEXT,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_numbered_prompts_chat
        ON numbered_prompts(channel_type, platform_id, created_at);

      CREATE TABLE IF NOT EXISTS user_links (
        alias_id    TEXT PRIMARY KEY,
        primary_id  TEXT NOT NULL,
        linked_at   TEXT NOT NULL,
        approved_by TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_links_primary ON user_links(primary_id);

      CREATE TABLE IF NOT EXISTS link_codes (
        code        TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        redeemed_by TEXT,
        redeemed_channel_type TEXT,
        redeemed_platform_id  TEXT,
        status      TEXT NOT NULL DEFAULT 'open'
      );

      CREATE TABLE IF NOT EXISTS user_prefs (
        user_id        TEXT PRIMARY KEY,
        notify_user_id TEXT,
        updated_at     TEXT NOT NULL
      );
    `);
    const cols = db.prepare(`PRAGMA table_info(pending_questions)`).all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some((c) => c.name === 'expires_at')) {
      db.exec(`ALTER TABLE pending_questions ADD COLUMN expires_at TEXT`);
    }
  },
};
