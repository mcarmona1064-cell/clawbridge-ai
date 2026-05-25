import type { Migration } from './index.js';

export const moduleAgentRegistry: Migration = {
  version: 14,
  name: 'module-agent-registry',
  up(db) {
    const cols = db.prepare('PRAGMA table_info(agent_groups)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'description')) {
      db.exec('ALTER TABLE agent_groups ADD COLUMN description TEXT DEFAULT NULL');
    }
  },
};
