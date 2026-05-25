import { getDb } from './connection.js';

export interface FanOutTask {
  id: string;
  orchestrator_group_id: string;
  orchestrator_session_id: string;
  target_group_ids: string; // JSON array of agent_group_id strings
  replies: string; // JSON object: {agentGroupId: replyText}
  collect_prompt: string | null;
  expected_schema: string | null;
  created_at: string;
  expires_at: string;
  status: 'waiting' | 'collected' | 'expired';
}

export function createFanOutTask(task: Omit<FanOutTask, 'replies' | 'status'>): void {
  getDb()
    .prepare(
      `INSERT INTO fan_out_tasks
       (id, orchestrator_group_id, orchestrator_session_id, target_group_ids, replies,
        collect_prompt, expected_schema, created_at, expires_at, status)
       VALUES (@id, @orchestrator_group_id, @orchestrator_session_id, @target_group_ids, '{}',
        @collect_prompt, @expected_schema, @created_at, @expires_at, 'waiting')`,
    )
    .run(task);
}

export function getActiveFanOutTasksForOrchestrator(orchestratorGroupId: string): FanOutTask[] {
  return getDb()
    .prepare(
      `SELECT * FROM fan_out_tasks
       WHERE orchestrator_group_id = ? AND status = 'waiting'
       ORDER BY created_at DESC`,
    )
    .all(orchestratorGroupId) as FanOutTask[];
}

export interface ReplyResult {
  allReplied: boolean;
  replies: Record<string, string>;
}

export function recordFanOutReply(taskId: string, sourceGroupId: string, replyText: string): ReplyResult {
  const db = getDb();
  const task = db.prepare('SELECT * FROM fan_out_tasks WHERE id = ?').get(taskId) as FanOutTask | undefined;
  if (!task) return { allReplied: false, replies: {} };

  const replies = JSON.parse(task.replies) as Record<string, string>;
  replies[sourceGroupId] = replyText;

  const targetIds = JSON.parse(task.target_group_ids) as string[];
  const allReplied = targetIds.every((id) => id in replies);

  db.prepare('UPDATE fan_out_tasks SET replies = ? WHERE id = ?').run(JSON.stringify(replies), taskId);
  if (allReplied) {
    db.prepare("UPDATE fan_out_tasks SET status = 'collected' WHERE id = ?").run(taskId);
  }

  return { allReplied, replies };
}

export function expireOldFanOutTasks(): number {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare("UPDATE fan_out_tasks SET status = 'expired' WHERE status = 'waiting' AND expires_at < ?")
    .run(now);
  return result.changes;
}
