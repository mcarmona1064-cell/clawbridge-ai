/**
 * One summary of "how is my assistant doing", used by the Slack App Home
 * tab and the /status card on every channel.
 */
import { readContainerConfig } from './container-config.js';
import { isContainerRunning, resolveProviderName } from './container-runner.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { identityIds } from './db/user-links.js';

export interface AgentSummary {
  id: string;
  name: string;
  provider: string;
  working: boolean;
  conversations: number;
}

export interface HomeSummary {
  agents: AgentSummary[];
  pendingApprovals: Array<{ id: string; title: string; createdAt: string }>;
  scheduledJobs: number;
  linkedAccounts: string[];
}

function scheduledJobsFor(agentGroupId: string): number {
  try {
    return countTasks(agentGroupId);
  } catch {
    return 0;
  }
}

let countTasks: (agentGroupId: string) => number = () => 0;
/** Wired by host-commands at import (avoids a cycle with the scheduling module). */
export function setTaskCounter(fn: (agentGroupId: string) => number): void {
  countTasks = fn;
}

export function buildHomeSummary(userId: string | null): HomeSummary {
  const agents = getAllAgentGroups().map((g) => {
    const sessions = getSessionsByAgentGroup(g.id);
    return {
      id: g.id,
      name: g.name,
      provider: resolveProviderName(null, g.agent_provider, readContainerConfig(g.folder).provider),
      working: sessions.some((s) => isContainerRunning(s.id)),
      conversations: sessions.length,
    };
  });

  let pendingApprovals: HomeSummary['pendingApprovals'] = [];
  if (hasTable(getDb(), 'pending_approvals')) {
    pendingApprovals = (
      getDb()
        .prepare(
          `SELECT approval_id, title, created_at FROM pending_approvals WHERE status = 'pending'
           ORDER BY created_at DESC LIMIT 10`,
        )
        .all() as Array<{ approval_id: string; title: string; created_at: string }>
    ).map((r) => ({ id: r.approval_id, title: r.title, createdAt: r.created_at }));
  }

  return {
    agents,
    pendingApprovals,
    scheduledJobs: agents.reduce((n, a) => n + scheduledJobsFor(a.id), 0),
    linkedAccounts: userId ? identityIds(userId) : [],
  };
}

/** Markdown card for /status on any channel. */
export function homeSummaryMarkdown(s: HomeSummary): string {
  const lines = ['**Your assistant**'];
  for (const a of s.agents) {
    lines.push(
      `• ${a.name}: ${a.working ? 'working now' : 'ready'} · ${a.provider} · ${a.conversations} conversation${a.conversations === 1 ? '' : 's'}`,
    );
  }
  lines.push(
    '',
    s.pendingApprovals.length
      ? `**Waiting for approval (${s.pendingApprovals.length})**\n${s.pendingApprovals.map((p) => `• ${p.title}`).join('\n')}`
      : 'Nothing is waiting for approval.',
    `Scheduled jobs: ${s.scheduledJobs} (see /tasks)`,
  );
  if (s.linkedAccounts.length > 1) lines.push(`Your linked accounts: ${s.linkedAccounts.join(', ')}`);
  return lines.join('\n');
}

/** Slack Block Kit view for the App Home tab. */
export function slackHomeView(s: HomeSummary): Record<string, unknown> {
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Your assistant' } },
    ...s.agents.map((a) => ({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${a.name}* — ${a.working ? ':large_green_circle: working now' : ':white_circle: ready'}\nAI: ${a.provider} · ${a.conversations} conversation${a.conversations === 1 ? '' : 's'}`,
      },
    })),
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: s.pendingApprovals.length
          ? `*Waiting for approval (${s.pendingApprovals.length})*\n${s.pendingApprovals.map((p) => `• ${p.title}`).join('\n')}`
          : 'Nothing is waiting for approval.',
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Scheduled jobs:* ${s.scheduledJobs} — type /tasks in a DM to see them` },
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'DM me or @mention me in a channel. `!stop` stops me, `!mute` quiets me, `/help` shows everything.',
        },
      ],
    },
  ];
  if (s.linkedAccounts.length > 1) {
    blocks.splice(-2, 0, {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Linked accounts:* ${s.linkedAccounts.join(', ')}` },
    });
  }
  return { type: 'home', blocks };
}
