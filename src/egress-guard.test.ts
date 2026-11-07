import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { requested, delivered } = vi.hoisted(() => ({
  requested: [] as Array<Record<string, unknown>>,
  delivered: [] as unknown[][],
}));
vi.mock('./log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: async (...a: unknown[]) => void delivered.push(a) }),
}));
vi.mock('./modules/approvals/index.js', () => ({
  requestApproval: async (opts: Record<string, unknown>) => {
    requested.push(opts);
    return true;
  },
  registerApprovalHandler: vi.fn(),
  registerApprovalRejectionHandler: vi.fn(),
  notifyAgent: vi.fn(),
}));

import { closeDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { holdCrossPost, widensAudience } from './egress-guard.js';
import { setPolicy } from './policies.js';
import type { MessagingGroup, Session } from './types.js';

const dm = { id: 'mg-dm', is_group: 0, platform_id: 'slack:D1', channel_type: 'slack', name: null } as MessagingGroup;
const group = {
  id: 'mg-g',
  is_group: 1,
  platform_id: 'slack:C1',
  channel_type: 'slack',
  name: '#general',
} as MessagingGroup;
const otherGroup = { ...group, id: 'mg-g2', platform_id: 'slack:C2' } as MessagingGroup;
const session = { id: 's1', agent_group_id: 'ag-1' } as Session;
const msg = {
  id: 'm1',
  kind: 'chat',
  channel_type: 'slack',
  platform_id: 'slack:C1',
  thread_id: null,
  content: JSON.stringify({ text: 'Q3 salaries are…' }),
};

describe('audience guard', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    requested.length = 0;
  });
  afterEach(() => closeDb());

  it('only holds posts that widen the audience', () => {
    expect(widensAudience(dm, group)).toBe(true);
    expect(widensAudience(group, otherGroup)).toBe(false);
    expect(widensAudience(dm, dm)).toBe(false);
    expect(widensAudience(undefined, group)).toBe(false);
  });

  it('holds a DM-to-group post for approval, with a preview and an "always allow" for that destination', async () => {
    expect(await holdCrossPost(session, dm, group, msg)).toBe(true);
    expect(requested[0]).toMatchObject({
      action: 'cross_post',
      title: 'Post in #general?',
      risk: 'medium',
      alwaysAllow: { scope: 'slack:C1' },
    });
    expect(String(requested[0].question)).toContain('> Q3 salaries are…');
  });

  it('lets it through once that destination is always allowed, and never holds group-to-group', async () => {
    setPolicy('ag-1', 'cross_post', 'slack:C1', 'allow', 'slack:U1');
    expect(await holdCrossPost(session, dm, group, msg)).toBe(false);
    expect(await holdCrossPost(session, group, otherGroup, msg)).toBe(false);
    expect(requested).toHaveLength(0);
  });
});
