import { getDb } from './connection.js';

export interface DroppedA2aRow {
  id: string;
  source_group_id: string;
  target_group_id: string;
  msg_content: string;
  error: string | null;
  retry_count: number;
  next_retry_at: string;
  created_at: string;
  status: 'pending' | 'delivered' | 'failed';
}

export function insertDroppedA2a(row: Omit<DroppedA2aRow, 'retry_count' | 'status'>): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO dropped_a2a_messages
       (id, source_group_id, target_group_id, msg_content, error, retry_count, next_retry_at, created_at, status)
       VALUES (@id, @source_group_id, @target_group_id, @msg_content, @error, 0, @next_retry_at, @created_at, 'pending')`,
    )
    .run(row);
}

export function getPendingDroppedA2a(): DroppedA2aRow[] {
  const now = new Date().toISOString();
  return getDb()
    .prepare(
      `SELECT * FROM dropped_a2a_messages
       WHERE status = 'pending' AND next_retry_at <= ?
       ORDER BY next_retry_at ASC LIMIT 20`,
    )
    .all(now) as DroppedA2aRow[];
}

export function updateDroppedA2aRetry(id: string, retryCount: number, nextRetryAt: string): void {
  getDb()
    .prepare('UPDATE dropped_a2a_messages SET retry_count = ?, next_retry_at = ? WHERE id = ?')
    .run(retryCount, nextRetryAt, id);
}

export function markDroppedA2aDelivered(id: string): void {
  getDb().prepare("UPDATE dropped_a2a_messages SET status = 'delivered' WHERE id = ?").run(id);
}

export function markDroppedA2aFailed(id: string): void {
  getDb().prepare("UPDATE dropped_a2a_messages SET status = 'failed' WHERE id = ?").run(id);
}
