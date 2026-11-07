import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { delivered, dms } = vi.hoisted(() => ({
  delivered: [] as Array<{ channelType: string; platformId: string; content: Record<string, unknown> }>,
  dms: new Map<string, { channel_type: string; platform_id: string }>(),
}));

vi.mock('../../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({
    deliver: async (channelType: string, platformId: string, _t: string | null, _k: string, content: string) => {
      delivered.push({ channelType, platformId, content: JSON.parse(content) });
      return 'm1';
    },
  }),
}));
vi.mock('../permissions/user-dm.js', () => ({ ensureUserDm: async (userId: string) => dms.get(userId) ?? null }));

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getAskQuestionRender } from '../../db/sessions.js';
import { primaryUserId } from '../../db/user-links.js';
import { pickApprovalDelivery } from '../approvals/primitive.js';
import { grantRole, hasAdminPrivilege, isOwner } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';
import { handleIdentityCommand, handleLinkResponse, LINK_CODE_TTL_MS } from './index.js';

const SLACK = 'slack:U1';
const WA = 'whatsapp:15551';

const say = (senderId: string, text: string, isGroup = false) =>
  handleIdentityCommand({
    channelType: senderId.split(':')[0],
    platformId: senderId.startsWith('slack') ? 'slack:D1' : 'whatsapp:15551',
    threadId: null,
    text,
    senderId,
    senderName: senderId.startsWith('slack') ? 'Ana' : 'Ana (phone)',
    isGroup,
  });

const click = (questionId: string, value: string, userId: string, channelType = 'slack') =>
  handleLinkResponse({ questionId, value, userId, channelType, platformId: '', threadId: null });

async function linkFlow(): Promise<string> {
  const reply = (await say(SLACK, '/link'))!;
  const code = /\*\*(\d{6})\*\*/.exec(reply)![1];
  await say(WA, `/link ${code}`);
  return `link-${code}`;
}

describe('cross-channel identity', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    delivered.length = 0;
    dms.clear();
    dms.set(SLACK, { channel_type: 'slack', platform_id: 'slack:D1' });
    upsertUser({ id: SLACK, kind: 'slack', display_name: 'Ana', created_at: new Date().toISOString() });
    grantRole({
      user_id: SLACK,
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: new Date().toISOString(),
    });
  });
  afterEach(() => {
    closeDb();
    vi.useRealTimers();
  });

  it('refuses to issue or redeem codes in a group chat', async () => {
    expect(await say(SLACK, '/link', true)).toMatch(/direct message/);
    expect(await say(WA, '/link 123456', true)).toMatch(/direct message/);
  });

  it('links only after the first account approves, then shares its roles', async () => {
    const card = await linkFlow();
    // The confirmation card went to the Slack DM, not the WhatsApp chat.
    expect(delivered[0]).toMatchObject({ channelType: 'slack', content: { type: 'ask_question', questionId: card } });
    expect(getAskQuestionRender(card)?.options.map((o) => o.value)).toEqual(['approve', 'reject']);
    expect(isOwner(WA)).toBe(false);

    await click(card, 'approve', 'U1'); // raw Slack id, as a card click delivers it
    expect(primaryUserId(WA)).toBe(SLACK);
    expect(isOwner(WA)).toBe(true);
    expect(hasAdminPrivilege(WA, 'ag-1')).toBe(true);
    expect(delivered.at(-1)).toMatchObject({
      channelType: 'whatsapp',
      content: { text: expect.stringContaining('Linked') },
    });
    expect(await say(WA, '/accounts')).toContain('slack:U1 (primary)');
  });

  it("ignores a confirmation clicked by anyone but the code's owner", async () => {
    const card = await linkFlow();
    await click(card, 'approve', 'slack:U666');
    expect(primaryUserId(WA)).toBe(WA);
    // The owner can still decide afterwards.
    await click(card, 'reject', 'U1');
    expect(primaryUserId(WA)).toBe(WA);
    expect(delivered.at(-1)?.content.text).toMatch(/declined/);
  });

  it('accepts each code once and not after it expires', async () => {
    const reply = (await say(SLACK, '/link'))!;
    const code = /\*\*(\d{6})\*\*/.exec(reply)![1];
    expect(await say(WA, `/link ${code}`)).toMatch(/confirmation/);
    expect(await say('telegram:7', `/link ${code}`)).toMatch(/not valid/);

    const reply2 = (await say(SLACK, '/link'))!;
    const code2 = /\*\*(\d{6})\*\*/.exec(reply2)![1];
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + LINK_CODE_TTL_MS + 1000);
    expect(await say('telegram:7', `/link ${code2}`)).toMatch(/expired/);
  });

  it('unlinks, after which the alias loses the shared roles', async () => {
    const card = await linkFlow();
    await click(card, 'approve', 'U1');
    expect(await say(WA, '/unlink')).toMatch(/no longer linked/);
    expect(isOwner(WA)).toBe(false);
  });

  it('sends approvals to the channel a person chose with /notify-here', async () => {
    const card = await linkFlow();
    await click(card, 'approve', 'U1');
    dms.set(WA, { channel_type: 'whatsapp', platform_id: 'whatsapp:15551' });

    // Without a preference, a Slack-origin request goes to Slack.
    expect((await pickApprovalDelivery([SLACK], 'slack'))?.userId).toBe(SLACK);
    expect(await say(WA, '/notify-here')).toMatch(/come here/);
    expect((await pickApprovalDelivery([SLACK], 'slack'))?.userId).toBe(WA);
  });
});
