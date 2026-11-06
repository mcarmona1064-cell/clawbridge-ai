import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestApprovalMock, notifyAgentMock, retainMock, mgMock } = vi.hoisted(() => ({
  requestApprovalMock: vi.fn(async (_opts: unknown) => true),
  notifyAgentMock: vi.fn(),
  retainMock: vi.fn(async () => undefined),
  mgMock: vi.fn(),
}));

vi.mock('../../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../delivery.js', () => ({ registerDeliveryAction: vi.fn() }));
vi.mock('../approvals/index.js', () => ({
  requestApproval: requestApprovalMock,
  notifyAgent: notifyAgentMock,
  registerApprovalHandler: vi.fn(),
  registerApprovalRejectionHandler: vi.fn(),
}));
vi.mock('../../memory/hindsight.js', () => ({ hindsightRetain: retainMock }));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => (id === 'ag-1' ? { id: 'ag-1', name: 'Ops', folder: 'ops' } : undefined),
}));
vi.mock('../../db/messaging-groups.js', () => ({ getMessagingGroup: mgMock }));

import type { Session } from '../../types.js';
import {
  applyTeamMemory,
  handleProposeTeamMemory,
  MAX_TEAM_FACT_CHARS,
  rejectTeamMemory,
  saveTeamFact,
  validateTeamFact,
} from './index.js';

const dmSession = { id: 's-dm', agent_group_id: 'ag-1', messaging_group_id: 'mg-dm' } as Session;
const channelSession = { id: 's-ch', agent_group_id: 'ag-1', messaging_group_id: 'mg-general' } as Session;

beforeEach(() => {
  requestApprovalMock.mockClear();
  notifyAgentMock.mockClear();
  retainMock.mockClear();
  mgMock.mockImplementation((id: string) =>
    id === 'mg-dm' ? { id, is_group: 0, name: null } : { id, is_group: 1, name: '#general' },
  );
});

describe('validateTeamFact', () => {
  it('normalises whitespace and rejects empty or oversized facts', () => {
    expect(validateTeamFact('  Invoices go out\n on the 3rd. ')).toEqual({
      ok: true,
      fact: 'Invoices go out on the 3rd.',
      source: '',
    });
    expect(validateTeamFact('   ').ok).toBe(false);
    expect(validateTeamFact('x'.repeat(MAX_TEAM_FACT_CHARS + 1)).ok).toBe(false);
  });
});

describe('propose_team_memory', () => {
  it('queues an approval and writes nothing until it is approved', async () => {
    await handleProposeTeamMemory({ fact: 'EMEA is now called International.', source: 'Ana' }, channelSession);
    expect(retainMock).not.toHaveBeenCalled();
    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
    const req = requestApprovalMock.mock.calls[0][0] as {
      action: string;
      payload: Record<string, unknown>;
      question: string;
    };
    expect(req.action).toBe('propose_team_memory');
    expect(req.payload).toMatchObject({ fact: 'EMEA is now called International.', origin: 'group' });
    expect(req.question).toContain('a group chat (#general)');
  });

  it('labels a proposal from a DM so the admin knows it came from a private chat', async () => {
    await handleProposeTeamMemory({ fact: 'Payroll runs on the 25th.' }, dmSession);
    const req = requestApprovalMock.mock.calls[0][0] as {
      payload: Record<string, unknown>;
      question: string;
    };
    expect(req.payload.origin).toBe('dm');
    expect(req.question).toContain('a private DM');
  });

  it('rejects an invalid proposal without asking anyone', async () => {
    await handleProposeTeamMemory({ fact: '' }, channelSession);
    expect(requestApprovalMock).not.toHaveBeenCalled();
    expect(notifyAgentMock).toHaveBeenCalledWith(channelSession, expect.stringContaining('failed'));
  });
});

describe('approval outcome', () => {
  const payload = {
    fact: 'Payroll runs on the 25th.',
    source: 'Ana',
    origin: 'dm',
    messagingGroupId: 'mg-dm',
    proposedBy: 'agent:ag-1',
  };

  it('on approve, writes the fact to the team bank with provenance and the approver', async () => {
    const notify = vi.fn();
    await applyTeamMemory({ session: dmSession, payload, userId: 'slack:U1', notify });
    expect(retainMock).toHaveBeenCalledTimes(1);
    const [bank, content, opts] = retainMock.mock.calls[0] as unknown as [
      string,
      string,
      { extraTags: string[]; async: boolean },
    ];
    expect(bank).toBe('ag-1--team');
    expect(content).toMatch(/^Payroll runs on the 25th\. \(as of \d{4}-\d{2}-\d{2}, source: Ana\)$/);
    expect(opts.extraTags).toEqual([
      'origin:dm',
      'conversation:mg-dm',
      'proposed_by:agent:ag-1',
      'approved_by:slack:U1',
    ]);
    expect(opts.async).toBe(false);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Saved to team memory'));
  });

  it('on reject, writes nothing', async () => {
    const notify = vi.fn();
    await rejectTeamMemory({ session: dmSession, payload, userId: 'slack:U1', notify });
    expect(retainMock).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('not saved'));
  });

  it('saveTeamFact stamps admin provenance for /teamfact', async () => {
    await saveTeamFact({
      agentGroupId: 'ag-1',
      fact: 'Standup is at 9:30.',
      origin: 'admin',
      messagingGroupId: 'mg-general',
      proposedBy: 'slack:U1',
      approvedBy: 'slack:U1',
      now: new Date('2026-11-06T12:00:00Z'),
    });
    const [, content, opts] = retainMock.mock.calls[0] as unknown as [string, string, { extraTags: string[] }];
    expect(content).toBe('Standup is at 9:30. (as of 2026-11-06)');
    expect(opts.extraTags[0]).toBe('origin:admin');
  });
});
