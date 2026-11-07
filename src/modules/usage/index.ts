/**
 * Usage module: records each turn's usage (the container's `record_usage`
 * system action), sends budget alerts, and answers /usage and /budget.
 */
import type Database from 'better-sqlite3';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getLatestInboundChatContent } from '../../db/session-db.js';
import { primaryUserId } from '../../db/user-links.js';
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { sendAdminAlert } from '../../shared/admin-alert.js';
import type { Session } from '../../types.js';
import {
  agentUsageThisMonth,
  dueBudgetAlerts,
  formatTokens,
  getBudget,
  parseBudget,
  recordUsage,
  setBudget,
  usageText,
} from '../../usage.js';
import { hasAdminPrivilege } from '../permissions/db/user-roles.js';

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export async function handleRecordUsage(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  let userId: string | null = null;
  try {
    const latest = getLatestInboundChatContent(inDb);
    const sender = latest ? (JSON.parse(latest) as { senderId?: string }).senderId : undefined;
    if (sender && sender !== 'system') userId = primaryUserId(sender);
  } catch {
    /* no sender on record */
  }
  recordUsage({
    agentGroupId: session.agent_group_id,
    sessionId: session.id,
    channelType: (content.channelType as string) ?? null,
    platformId: (content.platformId as string) ?? null,
    userId,
    provider: String(content.provider ?? 'unknown'),
    model: (content.model as string) ?? null,
    inputTokens: num(content.inputTokens),
    outputTokens: num(content.outputTokens),
    cacheReadTokens: num(content.cacheReadTokens),
    cacheWriteTokens: num(content.cacheWriteTokens),
    costUsd: typeof content.costUsd === 'number' ? content.costUsd : null,
  });

  const due = dueBudgetAlerts(session.agent_group_id);
  if (due.length > 0) {
    const top = Math.max(...due);
    const name = getAgentGroup(session.agent_group_id)?.name ?? 'Your agent';
    const used = agentUsageThisMonth(session.agent_group_id);
    const spend = `${formatTokens(used.billableTokens)} tokens, about $${used.costUsd.toFixed(2)}`;
    const text =
      top >= 100
        ? `⛔ **${name} reached its monthly budget** (${spend}). New messages are held until you raise it with /budget.`
        : `⚠️ **${name} has used ${top}% of its monthly budget** (${spend}).`;
    void sendAdminAlert(text).catch((err) => log.warn('Budget alert failed', { err }));
  }
}

registerDeliveryAction('record_usage', handleRecordUsage);

export function usageCommand(agentGroupId: string): string {
  return usageText(agentGroupId, getAgentGroup(agentGroupId)?.name ?? 'Your agent');
}

function describeBudget(b: { monthlyTokens: number | null; monthlyUsd: number | null }): string {
  return [b.monthlyTokens ? `${formatTokens(b.monthlyTokens)} tokens` : null, b.monthlyUsd ? `$${b.monthlyUsd}` : null]
    .filter(Boolean)
    .join(' / ');
}

export function budgetCommand(agentGroupId: string, userId: string | null, args: string): string {
  if (!args.trim()) {
    const b = getBudget(agentGroupId);
    return b
      ? `Monthly budget: ${describeBudget(b)}. /usage shows how much is used.`
      : 'No monthly budget. Admins: /budget 5M (tokens) or /budget $50. /budget off removes it.';
  }
  if (!userId || !hasAdminPrivilege(userId, agentGroupId)) return 'Only an admin can change the budget.';
  const parsed = parseBudget(args);
  if (!parsed) return 'Use /budget 5M, /budget 500k, /budget $50 or /budget off.';
  if (parsed === 'off') {
    setBudget(agentGroupId, { monthlyTokens: null, monthlyUsd: null }, userId);
    return 'Budget removed. Held messages are answered with the next message in each chat.';
  }
  setBudget(agentGroupId, parsed, userId);
  return `Monthly budget set to ${describeBudget(parsed)}. I'll alert admins at 50, 75, 90 and 100%.`;
}
