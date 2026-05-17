/**
 * Host-side slash command handlers.
 *
 * Commands with category 'host' in shared/commands.ts are intercepted before
 * reaching the container. Each handler writes responses via the write callback.
 */
import fs2 from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { COMMAND_REGISTRY } from '../../shared/commands.js';
import { getPendingApproval, getPendingApprovalsByDeliveryChannel } from '../../db/sessions.js';
import { getDb, hasTable } from '../../db/connection.js';
import { isContainerRunning, killContainer } from '../../container-runner.js';
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
