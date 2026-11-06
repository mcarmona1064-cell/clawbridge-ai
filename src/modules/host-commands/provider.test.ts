import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { killMock, runningMock } = vi.hoisted(() => ({ killMock: vi.fn(), runningMock: vi.fn(() => false) }));

vi.mock('../../container-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../container-runner.js')>();
  return { ...actual, isContainerRunning: runningMock, killContainer: killMock };
});

import {
  closeDb,
  createAgentGroup,
  createSession,
  getAgentGroup,
  getSession,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import type { AgentGroup, MessagingGroup, Session } from '../../types.js';
import { handleHostCommand, type HostCommandContext } from './index.js';

const now = () => new Date().toISOString();

function ctx(args: string): HostCommandContext {
  return {
    command: '/provider',
    args,
    event: {} as HostCommandContext['event'],
    session: getSession('s-1') as Session,
    userId: 'telegram:owner',
    mg: {} as MessagingGroup,
    agentGroup: getAgentGroup('ag-1') as AgentGroup,
    deliveryAddr: { channelType: null, platformId: null, threadId: null },
  };
}

async function run(args: string): Promise<string> {
  let out = '';
  await handleHostCommand(ctx(args), (t) => {
    out += t;
  });
  return out;
}

beforeEach(() => {
  runMigrations(initTestDb());
  createAgentGroup({
    id: 'ag-1',
    name: 'Ops',
    folder: 'provider-test-nonexistent',
    agent_provider: null,
    created_at: now(),
  });
  createSession({
    id: 's-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  } as Session);
});

afterEach(() => {
  closeDb();
  killMock.mockReset();
  runningMock.mockReset();
  runningMock.mockReturnValue(false);
});

describe('/provider', () => {
  it('shows the effective provider and its source', async () => {
    expect(await run('')).toContain('Provider: codex (install default)');
  });

  it('switches the agent group and clears the session override', async () => {
    await run('claude session');
    expect(getSession('s-1')!.agent_provider).toBe('claude');

    const out = await run('claude');
    expect(out).toContain('now uses claude');
    expect(getAgentGroup('ag-1')!.agent_provider).toBe('claude');
    expect(getSession('s-1')!.agent_provider).toBeNull();
    expect(await run('')).toContain('Provider: claude (agent group setting)');
  });

  it('stops a running container so the next message respawns on the new provider', async () => {
    runningMock.mockReturnValue(true);
    expect(await run('claude')).toContain('will restart on your next message');
    expect(killMock).toHaveBeenCalledWith('s-1', 'provider switched via /provider');
  });

  it('rejects unknown providers and resets with /provider default', async () => {
    expect(await run('gemini')).toContain('Unknown provider "gemini"');
    await run('claude');
    await run('default');
    expect(getAgentGroup('ag-1')!.agent_provider).toBeNull();
  });
});
