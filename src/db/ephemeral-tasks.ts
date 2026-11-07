import { getDb } from './connection.js';

export interface EphemeralTask {
  id: string;
  caller_group_id: string;
  caller_session_id: string;
  task_agent_group_id: string;
  task_agent_folder: string;
  status: 'running' | 'replied' | 'cleaned_up' | 'expired';
  result: string | null;
  created_at: string;
  expires_at: string;
}

export function createEphemeralTask(task: Omit<EphemeralTask, 'status' | 'result'>): void {
  getDb()
    .prepare(
      `INSERT INTO ephemeral_tasks
       (id, caller_group_id, caller_session_id, task_agent_group_id, task_agent_folder,
        status, result, created_at, expires_at)
       VALUES (@id, @caller_group_id, @caller_session_id, @task_agent_group_id, @task_agent_folder,
        'running', NULL, @created_at, @expires_at)`,
    )
    .run(task);
}

export function getEphemeralTaskByAgentGroup(taskAgentGroupId: string): EphemeralTask | undefined {
  return getDb()
    .prepare("SELECT * FROM ephemeral_tasks WHERE task_agent_group_id = ? AND status = 'running'")
    .get(taskAgentGroupId) as EphemeralTask | undefined;
}

export function markEphemeralTaskReplied(id: string, result: string): void {
  getDb().prepare("UPDATE ephemeral_tasks SET status = 'replied', result = ? WHERE id = ?").run(result, id);
}

export function markEphemeralTaskCleaned(id: string): void {
  getDb().prepare("UPDATE ephemeral_tasks SET status = 'cleaned_up' WHERE id = ?").run(id);
}

export function getTasksToCleanup(): EphemeralTask[] {
  const now = new Date().toISOString();
  return getDb()
    .prepare(
      `SELECT * FROM ephemeral_tasks
       WHERE status = 'replied' OR (status = 'running' AND expires_at < ?)
       ORDER BY created_at ASC`,
    )
    .all(now) as EphemeralTask[];
}
