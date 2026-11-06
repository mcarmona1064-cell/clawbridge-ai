/**
 * Host-side slash command handlers.
 *
 * Commands with category 'host' in shared/commands.ts are intercepted before
 * reaching the container. Each handler writes responses via the write callback.
 */
import fs2 from 'fs';
import path from 'path';

import { GROUPS_DIR, SUPPORTED_AGENT_PROVIDERS } from '../../config.js';
import { readContainerConfig } from '../../container-config.js';
import { getAllAgentGroups, getAgentGroup, updateAgentGroup } from '../../db/agent-groups.js';
import { getAllAgentHealth } from '../../db/agent-health.js';
import { COMMAND_REGISTRY } from '../../shared/commands.js';
import { getPendingApproval, getPendingApprovalsByDeliveryChannel, updateSession } from '../../db/sessions.js';
import { getDb, hasTable } from '../../db/connection.js';
import { isContainerRunning, killContainer, resolveProviderName } from '../../container-runner.js';
import { notifyAgent } from '../approvals/index.js';
import { dispatchResponse } from '../../response-registry.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { Session, MessagingGroup, AgentGroup } from '../../types.js';

export interface HostCommandContext {
  command: string;
  args: string;
  event: InboundEvent;
  session: Session;
  userId: string | null;
  mg: MessagingGroup;
  agentGroup: AgentGroup;
  deliveryAddr: {
    channelType: string | null;
    platformId: string | null;
    threadId: string | null;
  };
}

export type WriteResponse = (text: string) => void;

export async function handleHostCommand(ctx: HostCommandContext, write: WriteResponse): Promise<void> {
  try {
    switch (ctx.command) {
      case '/approve':
        return await handleApprove(ctx, write);
      case '/deny':
        return await handleDeny(ctx, write);
      case '/stop':
        return handleStop(ctx, write);
      case '/status':
        return handleStatus(ctx, write);
      case '/whoami':
        return handleWhoami(ctx, write);
      case '/commands':
        return handleCommands(ctx, write);
      case '/goal':
        return await handleGoal(ctx, write);
      case '/update':
        return await handleUpdate(ctx, write);
      case '/agents':
        return handleAgents(ctx, write);
      case '/health':
        return handleHealth(ctx, write);
      case '/provider':
        return handleProvider(ctx, write);
      default:
        write('Unknown host command: ' + ctx.command);
    }
  } catch (err) {
    write('Command failed: ' + ((err as Error).message || String(err)));
  }
}

async function handleApprove(ctx: HostCommandContext, write: WriteResponse): Promise<void> {
  const approvalId = ctx.args.trim() || null;
  let approval;
  if (approvalId) {
    approval = getPendingApproval(approvalId);
    if (!approval) {
      write('No pending approval found with ID: ' + approvalId);
      return;
    }
  } else {
    const all = getPendingApprovalsByDeliveryChannel(ctx.event.channelType, ctx.event.platformId);
    approval = all[0];
    if (!approval) {
      write('No pending approvals found for this channel.');
      return;
    }
  }
  await dispatchResponse({
    questionId: approval.approval_id,
    value: 'approve',
    userId: ctx.userId,
    channelType: ctx.event.channelType,
    platformId: ctx.event.platformId,
    threadId: ctx.event.threadId,
  });
  write('Approved: ' + approval.title);
}

async function handleDeny(ctx: HostCommandContext, write: WriteResponse): Promise<void> {
  const approvalId = ctx.args.trim() || null;
  let approval;
  if (approvalId) {
    approval = getPendingApproval(approvalId);
    if (!approval) {
      write('No pending approval found with ID: ' + approvalId);
      return;
    }
  } else {
    const all = getPendingApprovalsByDeliveryChannel(ctx.event.channelType, ctx.event.platformId);
    approval = all[0];
    if (!approval) {
      write('No pending approvals found for this channel.');
      return;
    }
  }
  await dispatchResponse({
    questionId: approval.approval_id,
    value: 'reject',
    userId: ctx.userId,
    channelType: ctx.event.channelType,
    platformId: ctx.event.platformId,
    threadId: ctx.event.threadId,
  });
  write('Denied: ' + approval.title);
}

function handleStop(ctx: HostCommandContext, write: WriteResponse): void {
  if (isContainerRunning(ctx.session.id)) {
    killContainer(ctx.session.id, 'stopped by admin via /stop command');
    write('Agent session stopped.');
  } else {
    write('No running agent session to stop.');
  }
}

function handleStatus(ctx: HostCommandContext, write: WriteResponse): void {
  const s = ctx.session;
  const running = isContainerRunning(s.id);
  const lastActive = s.last_active ? new Date(s.last_active).toLocaleString() : 'never';
  write(
    'Session status\n' +
      'Agent: ' +
      s.agent_group_id +
      '\n' +
      'Session: ' +
      s.id +
      '\n' +
      'Container: ' +
      (running ? 'running' : s.container_status) +
      '\n' +
      'Provider: ' +
      resolveProviderName(
        s.agent_provider,
        ctx.agentGroup.agent_provider,
        readContainerConfig(ctx.agentGroup.folder).provider,
      ) +
      '\n' +
      'Last active: ' +
      lastActive,
  );
}

function handleWhoami(ctx: HostCommandContext, write: WriteResponse): void {
  const { userId } = ctx;
  if (!userId) {
    write('User: unknown (no user ID resolved for this channel)');
    return;
  }
  try {
    if (!hasTable(getDb(), 'user_roles')) {
      write('User ID: ' + userId + '\nRoles: all (permissions module not installed)');
      return;
    }
    const roles = getDb()
      .prepare('SELECT role, agent_group_id FROM user_roles WHERE user_id = ?')
      .all(userId) as Array<{ role: string; agent_group_id: string | null }>;
    const roleDesc =
      roles.length === 0
        ? 'none'
        : roles.map((r) => r.role + (r.agent_group_id ? ' (scoped)' : ' (global)')).join(', ');
    write('User ID: ' + userId + '\nRoles: ' + roleDesc);
  } catch (err) {
    write('User ID: ' + userId + '\nRoles: error (' + ((err as Error).message || 'unknown') + ')');
  }
}

function handleCommands(ctx: HostCommandContext, write: WriteResponse): void {
  const pageSize = 15;
  const page = Math.max(1, parseInt(ctx.args.trim(), 10) || 1);
  const visible = COMMAND_REGISTRY.filter((d) => d.category !== 'filtered');
  const totalPages = Math.ceil(visible.length / pageSize);
  const pageIdx = Math.min(page, totalPages);
  const slice = visible.slice((pageIdx - 1) * pageSize, pageIdx * pageSize);
  const lines: string[] = ['Commands (page ' + pageIdx + '/' + totalPages + ')', ''];
  for (const def of slice) {
    const tag = def.category === 'admin' || (def.category === 'host' && def.adminOnly !== false) ? ' [admin]' : '';
    const desc = def.description ? ' — ' + def.description : '';
    lines.push(def.command + tag + desc);
  }
  if (pageIdx < totalPages) lines.push('', 'Use /commands ' + (pageIdx + 1) + ' for more.');
  write(lines.join('\n'));
}

async function handleGoal(ctx: HostCommandContext, write: WriteResponse): Promise<void> {
  const goalText = ctx.args.trim();
  const goalFile = path.join(GROUPS_DIR, ctx.agentGroup.folder, 'current-goal.txt');
  if (!goalText || goalText.toLowerCase() === 'clear') {
    try {
      fs2.unlinkSync(goalFile);
    } catch {
      /* already absent */
    }
    notifyAgent(ctx.session, 'The active goal has been cleared. Continue with normal operation.');
    write('Goal cleared.');
    return;
  }
  fs2.mkdirSync(path.dirname(goalFile), { recursive: true });
  fs2.writeFileSync(goalFile, goalText);
  notifyAgent(
    ctx.session,
    'New goal set: "' +
      goalText +
      '"\n\nFocus on this goal across all turns until it is achieved or cleared with /goal clear.',
  );
  write('Goal set: ' + goalText);
}

async function handleUpdate(ctx: HostCommandContext, write: WriteResponse): Promise<void> {
  try {
    const pkg = JSON.parse(fs2.readFileSync(new URL('../../../package.json', import.meta.url), 'utf-8')) as {
      version: string;
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch('https://registry.npmjs.org/clawbridge-codex/latest', {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      write('Could not reach npm registry. Check your network connection.');
      return;
    }
    const data = (await res.json()) as { version: string };
    if (data.version === pkg.version) {
      write('ClawBridge is up to date (v' + pkg.version + ').');
    } else {
      write(
        'Update available: v' +
          pkg.version +
          ' → v' +
          data.version +
          '\n\nRun on your host terminal:\n  clawbridge upgrade',
      );
    }
  } catch (err) {
    write('Update check failed: ' + ((err as Error).message || String(err)));
  }
}

function handleAgents(_ctx: HostCommandContext, write: WriteResponse): void {
  const groups = getAllAgentGroups();
  if (groups.length === 0) {
    write('No agent groups found.');
    return;
  }
  const lines: string[] = [`Agent Groups (${groups.length})`, ''];
  for (const g of groups) {
    const desc = g.description ? `  ${g.description}` : '';
    lines.push(`${g.name}${desc}`);
  }
  write(lines.join('\n'));
}

function handleHealth(_ctx: HostCommandContext, write: WriteResponse): void {
  const groups = getAllAgentGroups();
  if (groups.length === 0) {
    write('No agent groups found.');
    return;
  }

  let healthRows: ReturnType<typeof getAllAgentHealth>;
  try {
    healthRows = getAllAgentHealth();
  } catch {
    write('Health data not available (run a version upgrade to enable health monitoring).');
    return;
  }

  const healthMap = new Map(healthRows.map((r) => [r.agent_group_id, r]));
  const lines: string[] = ['Agent Health', ''];

  for (const g of groups) {
    const h = healthMap.get(g.id);
    if (!h || h.consecutive_errors === 0) {
      const lastOk = h?.last_ok_at ? `last ok: ${timeSince(h.last_ok_at)}` : 'no data yet';
      lines.push(`${g.name}  ✅  ${lastOk}`);
    } else if (h.consecutive_errors < 3) {
      lines.push(
        `${g.name}  ⚠️  ${h.consecutive_errors} error${h.consecutive_errors === 1 ? '' : 's'} — last: "${h.last_error ?? 'unknown'}"`,
      );
    } else {
      lines.push(`${g.name}  ❌  ${h.consecutive_errors} errors — last: "${h.last_error ?? 'unknown'}"`);
    }
  }

  write(lines.join('\n'));
}

/**
 * /provider                      → show the effective provider and where it comes from
 * /provider claude|codex         → switch this agent group (clears this session's override)
 * /provider claude|codex session → switch only this session
 * /provider default              → clear group + session overrides (back to container.json / install default)
 *
 * A running container is stopped so the next message respawns it on the new provider.
 */
function handleProvider(ctx: HostCommandContext, write: WriteResponse): void {
  const [rawTarget, rawScope] = ctx.args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const group = getAgentGroup(ctx.agentGroup.id) ?? ctx.agentGroup;
  const containerProvider = readContainerConfig(group.folder).provider;

  if (!rawTarget) {
    const effective = resolveProviderName(ctx.session.agent_provider, group.agent_provider, containerProvider);
    const source = ctx.session.agent_provider
      ? 'session override'
      : group.agent_provider
        ? 'agent group setting'
        : containerProvider
          ? 'container.json'
          : 'install default';
    write(
      `Provider: ${effective} (${source})\n` +
        `Available: ${SUPPORTED_AGENT_PROVIDERS.join(', ')}\n` +
        'Switch with /provider <name> [session] or reset with /provider default',
    );
    return;
  }

  let note: string;
  if (rawTarget === 'default' || rawTarget === 'reset') {
    updateAgentGroup(group.id, { agent_provider: null });
    updateSession(ctx.session.id, { agent_provider: null });
    note = `Provider overrides cleared. Now using ${resolveProviderName(null, null, containerProvider)}.`;
  } else if (!(SUPPORTED_AGENT_PROVIDERS as readonly string[]).includes(rawTarget)) {
    write(`Unknown provider "${rawTarget}". Available: ${SUPPORTED_AGENT_PROVIDERS.join(', ')}`);
    return;
  } else if (rawScope === 'session') {
    updateSession(ctx.session.id, { agent_provider: rawTarget });
    note = `This session now uses ${rawTarget}.`;
  } else if (rawScope) {
    write('Usage: /provider claude|codex [session] or /provider default');
    return;
  } else {
    updateAgentGroup(group.id, { agent_provider: rawTarget });
    updateSession(ctx.session.id, { agent_provider: null });
    note = `Agent group "${group.name}" now uses ${rawTarget}.`;
  }

  if (isContainerRunning(ctx.session.id)) {
    killContainer(ctx.session.id, 'provider switched via /provider');
    note += ' The running agent was stopped and will restart on your next message.';
  }
  write(note);
}

function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}
