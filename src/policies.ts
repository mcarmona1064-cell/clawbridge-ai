/**
 * Tool policies: allow, ask or deny, per agent and action.
 *
 * Every sensitive action starts as "ask" (an approval card). An admin can
 * turn a specific, low-risk shape of it into "always allow" from the card
 * itself, or deny an action outright, and review or revoke every rule with
 * /permissions. Some things are never auto-allowed whatever the rules say:
 * see `neverAutoAllow` callers (spending money, deleting, secrets, chained
 * shell commands).
 *
 * Scopes:
 *   '*'            the whole action (used for deny)
 *   'git pull'     host_exec commands that start with these words
 */
import { audit } from './audit.js';
import { getDb, hasTable } from './db/connection.js';

export type Decision = 'allow' | 'deny';
export type Risk = 'low' | 'medium' | 'high';

export interface PolicyRow {
  id: number;
  agent_group_id: string;
  action: string;
  scope: string;
  decision: Decision;
  created_by: string | null;
  created_at: string;
}

function ready(): boolean {
  try {
    return hasTable(getDb(), 'tool_policies');
  } catch {
    return false;
  }
}

export function setPolicy(
  agentGroupId: string,
  action: string,
  scope: string,
  decision: Decision,
  by: string | null,
): void {
  if (!ready()) return;
  getDb()
    .prepare(
      `INSERT INTO tool_policies (agent_group_id, action, scope, decision, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_group_id, action, scope) DO UPDATE SET decision = excluded.decision, created_by = excluded.created_by,
         created_at = excluded.created_at`,
    )
    .run(agentGroupId, action, scope, decision, by, new Date().toISOString());
  audit('policy.changed', { actor: by, agentGroupId, detail: { action, scope, decision } });
}

export function removePolicy(agentGroupId: string, id: number, by: string | null): boolean {
  if (!ready()) return false;
  const row = getDb()
    .prepare('SELECT * FROM tool_policies WHERE id = ? AND agent_group_id = ?')
    .get(id, agentGroupId) as PolicyRow | undefined;
  if (!row) return false;
  getDb().prepare('DELETE FROM tool_policies WHERE id = ?').run(id);
  audit('policy.changed', {
    actor: by,
    agentGroupId,
    detail: { action: row.action, scope: row.scope, decision: 'removed' },
  });
  return true;
}

export function listPolicies(agentGroupId: string): PolicyRow[] {
  if (!ready()) return [];
  return getDb()
    .prepare('SELECT * FROM tool_policies WHERE agent_group_id = ? ORDER BY action, scope')
    .all(agentGroupId) as PolicyRow[];
}

/** Does `subject` (e.g. a command line) fall under `scope`? Word-prefix match; '*' matches all. */
export function scopeMatches(scope: string, subject: string): boolean {
  if (scope === '*') return true;
  const want = scope.trim().split(/\s+/);
  const have = subject.trim().split(/\s+/);
  return want.length <= have.length && want.every((w, i) => w === have[i]);
}

/**
 * The rule that applies, if any: a deny anywhere wins; otherwise an allow
 * whose scope covers the subject. Null means "ask".
 */
export function policyDecision(agentGroupId: string, action: string, subject: string): Decision | null {
  const rules = listPolicies(agentGroupId).filter((r) => r.action === action && scopeMatches(r.scope, subject));
  if (rules.some((r) => r.decision === 'deny')) return 'deny';
  return rules.some((r) => r.decision === 'allow') ? 'allow' : null;
}

export const RISK_LABEL: Record<Risk, string> = {
  low: '🟢 Low risk',
  medium: '🟡 Medium risk',
  high: '🔴 High risk',
};

/** Value of the "always allow" option on approval cards. */
export const ALWAYS_ALLOW_VALUE = 'approve_always';
