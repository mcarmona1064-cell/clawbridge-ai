/** Digest scorecard (posted vs. engaged), per conversation. */
import type Database from 'better-sqlite3';

import { ensureDigestStatsTable } from '../../digest-stats.js';
import type { Migration } from './index.js';

export const migration026: Migration = {
  version: 26,
  name: 'digest-stats',
  up(db: Database.Database) {
    ensureDigestStatsTable(db);
  },
};
