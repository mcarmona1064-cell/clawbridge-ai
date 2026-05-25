import { getDb } from './connection.js';

export interface AgentHealthRow {
  agent_group_id: string;
  consecutive_errors: number;
  last_error: string | null;
  last_ok_at: string | null;
  updated_at: string;
}

export function getAllAgentHealth(): AgentHealthRow[] {
  return getDb().prepare('SELECT * FROM agent_health ORDER BY agent_group_id').all() as AgentHealthRow[];
}

export function recordAgentSuccess(agentGroupId: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO agent_health (agent_group_id, consecutive_errors, last_error, last_ok_at, updated_at)
       VALUES (?, 0, NULL, ?, ?)
       ON CONFLICT(agent_group_id) DO UPDATE SET
         consecutive_errors = 0,
         last_ok_at         = excluded.last_ok_at,
         updated_at         = excluded.updated_at`,
    )
    .run(agentGroupId, now, now);
}

export function recordAgentError(agentGroupId: string, error: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO agent_health (agent_group_id, consecutive_errors, last_error, last_ok_at, updated_at)
       VALUES (?, 1, ?, NULL, ?)
       ON CONFLICT(agent_group_id) DO UPDATE SET
         consecutive_errors = consecutive_errors + 1,
         last_error         = excluded.last_error,
         updated_at         = excluded.updated_at`,
    )
    .run(agentGroupId, error, now);
}

export function deleteAgentHealth(agentGroupId: string): void {
  getDb().prepare('DELETE FROM agent_health WHERE agent_group_id = ?').run(agentGroupId);
}
