/**
 * Usage ledger and budgets.
 *
 * Each agent turn reports the tokens it used (and the provider's own USD
 * estimate). The host records it per agent, conversation and person, and
 * enforces an optional monthly budget per agent:
 *   - alerts to the admins at 50, 75, 90 and 100 % (once each per month)
 *   - at 100 %, new messages wait in the queue instead of waking the agent,
 *     and the chat is told once; raising the budget lets them through.
 *
 * Budgets count tokens (what subscriptions actually limit) and/or the USD
 * estimate (what API keys are billed). Subscriptions are not billed per
 * token, so USD figures there are "API-equivalent" estimates.
 */
import { audit } from './audit.js';
import { getDb, hasTable } from './db/connection.js';
import { log } from './log.js';

export const ALERT_THRESHOLDS = [50, 75, 90, 100] as const;

export interface UsageRecord {
  agentGroupId: string;
  sessionId?: string | null;
  channelType?: string | null;
  platformId?: string | null;
  userId?: string | null;
  provider: string;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number | null;
}

function ready(): boolean {
  try {
    return hasTable(getDb(), 'usage_ledger');
  } catch {
    return false;
  }
}

export function monthStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export function recordUsage(r: UsageRecord): void {
  if (!ready()) return;
  getDb()
    .prepare(
      `INSERT INTO usage_ledger (at, agent_group_id, session_id, channel_type, platform_id, user_id, provider, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      r.agentGroupId,
      r.sessionId ?? null,
      r.channelType ?? null,
      r.platformId ?? null,
      r.userId ?? null,
      r.provider,
      r.model ?? null,
      Math.max(0, Math.round(r.inputTokens)),
      Math.max(0, Math.round(r.outputTokens)),
      Math.max(0, Math.round(r.cacheReadTokens)),
      Math.max(0, Math.round(r.cacheWriteTokens)),
      typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) ? r.costUsd : null,
    );
}

export interface UsageTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Tokens that count against a budget: new input + output + cache writes (cache reads are ~10x cheaper). */
  billableTokens: number;
  costUsd: number;
}

function totals(where: string, params: unknown[]): UsageTotals {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS turns, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o,
              COALESCE(SUM(cache_read_tokens),0) AS cr, COALESCE(SUM(cache_write_tokens),0) AS cw, COALESCE(SUM(cost_usd),0) AS usd
       FROM usage_ledger WHERE ${where}`,
    )
    .get(...params) as { turns: number; i: number; o: number; cr: number; cw: number; usd: number };
  return {
    turns: row.turns,
    inputTokens: row.i,
    outputTokens: row.o,
    cacheReadTokens: row.cr,
    cacheWriteTokens: row.cw,
    billableTokens: row.i + row.o + row.cw,
    costUsd: row.usd,
  };
}

export function agentUsageThisMonth(agentGroupId: string, now = new Date()): UsageTotals {
  if (!ready()) return totals('0', []);
  return totals('agent_group_id = ? AND at >= ?', [agentGroupId, monthStart(now)]);
}

export function usageBreakdown(
  agentGroupId: string,
  by: 'user_id' | 'platform_id' | 'provider',
  now = new Date(),
): Array<{ key: string; billableTokens: number; costUsd: number; turns: number }> {
  if (!ready()) return [];
  return (
    getDb()
      .prepare(
        `SELECT COALESCE(${by}, 'unknown') AS key, COUNT(*) AS turns,
                COALESCE(SUM(input_tokens + output_tokens + cache_write_tokens),0) AS billable, COALESCE(SUM(cost_usd),0) AS usd
         FROM usage_ledger WHERE agent_group_id = ? AND at >= ? GROUP BY key ORDER BY billable DESC LIMIT 10`,
      )
      .all(agentGroupId, monthStart(now)) as Array<{ key: string; turns: number; billable: number; usd: number }>
  ).map((r) => ({ key: r.key, billableTokens: r.billable, costUsd: r.usd, turns: r.turns }));
}

// ── Budgets ──

export interface Budget {
  monthlyTokens: number | null;
  monthlyUsd: number | null;
}

export function getBudget(agentGroupId: string): Budget | null {
  if (!ready()) return null;
  const row = getDb()
    .prepare('SELECT monthly_tokens, monthly_usd FROM budgets WHERE agent_group_id = ?')
    .get(agentGroupId) as { monthly_tokens: number | null; monthly_usd: number | null } | undefined;
  if (!row || (row.monthly_tokens === null && row.monthly_usd === null)) return null;
  return { monthlyTokens: row.monthly_tokens, monthlyUsd: row.monthly_usd };
}

export function setBudget(agentGroupId: string, budget: Budget, by: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO budgets (agent_group_id, monthly_tokens, monthly_usd, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_group_id) DO UPDATE SET monthly_tokens = excluded.monthly_tokens, monthly_usd = excluded.monthly_usd,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .run(agentGroupId, budget.monthlyTokens, budget.monthlyUsd, by, new Date().toISOString());
  // A new budget starts its alerts afresh for this month.
  getDb().prepare('DELETE FROM budget_alerts WHERE agent_group_id = ? AND month = ?').run(agentGroupId, monthStart());
  audit('budget.changed', { actor: by, agentGroupId, detail: { ...budget } });
}

/** Percent of the budget used this month (the higher of tokens and USD), or null without a budget. */
export function budgetPercent(agentGroupId: string, now = new Date()): number | null {
  const budget = getBudget(agentGroupId);
  if (!budget) return null;
  const used = agentUsageThisMonth(agentGroupId, now);
  const parts: number[] = [];
  if (budget.monthlyTokens) parts.push((used.billableTokens / budget.monthlyTokens) * 100);
  if (budget.monthlyUsd) parts.push((used.costUsd / budget.monthlyUsd) * 100);
  return parts.length ? Math.max(...parts) : null;
}

export function overBudget(agentGroupId: string, now = new Date()): boolean {
  const pct = budgetPercent(agentGroupId, now);
  return pct !== null && pct >= 100;
}

/** Thresholds crossed this month that have not been alerted yet; marks them alerted. */
export function dueBudgetAlerts(agentGroupId: string, now = new Date()): number[] {
  const pct = budgetPercent(agentGroupId, now);
  if (pct === null) return [];
  const month = monthStart(now);
  const due: number[] = [];
  for (const t of ALERT_THRESHOLDS) {
    if (pct < t) continue;
    const res = getDb()
      .prepare('INSERT OR IGNORE INTO budget_alerts (agent_group_id, month, threshold) VALUES (?, ?, ?)')
      .run(agentGroupId, month, t);
    if (res.changes > 0) due.push(t);
  }
  return due;
}

// ── Formatting ──

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function usageText(agentGroupId: string, agentName: string, now = new Date()): string {
  const t = agentUsageThisMonth(agentGroupId, now);
  const budget = getBudget(agentGroupId);
  const pct = budgetPercent(agentGroupId, now);
  const lines = [
    `**${agentName} — usage this month**`,
    `${t.turns} replies · ${formatTokens(t.billableTokens)} tokens (plus ${formatTokens(t.cacheReadTokens)} cached) · about $${t.costUsd.toFixed(2)} at API prices`,
  ];
  if (budget) {
    const limits = [
      budget.monthlyTokens ? `${formatTokens(budget.monthlyTokens)} tokens` : null,
      budget.monthlyUsd ? `$${budget.monthlyUsd.toFixed(2)}` : null,
    ].filter(Boolean);
    lines.push(`Budget: ${limits.join(' / ')} a month — ${Math.min(999, Math.round(pct ?? 0))}% used`);
  } else {
    lines.push('No budget set. Admins: /budget 5M tokens or /budget $50');
  }
  const people = usageBreakdown(agentGroupId, 'user_id', now).filter((p) => p.key !== 'unknown');
  if (people.length)
    lines.push('', '**By person**', ...people.slice(0, 5).map((p) => `• ${p.key}: ${formatTokens(p.billableTokens)}`));
  return lines.join('\n');
}

/** Parse "/budget 5M", "/budget 500k tokens", "/budget $50", "/budget off". */
export function parseBudget(arg: string): Budget | 'off' | null {
  const a = arg.trim().toLowerCase();
  if (a === 'off' || a === 'none' || a === '0') return 'off';
  const usd = /^\$\s*(\d+(?:\.\d+)?)$|^(\d+(?:\.\d+)?)\s*(usd|dollars?)$/.exec(a);
  if (usd) return { monthlyTokens: null, monthlyUsd: Number(usd[1] ?? usd[2]) };
  const tok = /^(\d+(?:\.\d+)?)\s*([km])?\s*(tokens?)?$/.exec(a);
  if (tok) {
    const n = Number(tok[1]) * (tok[2] === 'm' ? 1_000_000 : tok[2] === 'k' ? 1_000 : 1);
    return n > 0 ? { monthlyTokens: Math.round(n), monthlyUsd: null } : null;
  }
  return null;
}

export function logUsageFailure(err: unknown): void {
  log.warn('Usage record failed', { err });
}
