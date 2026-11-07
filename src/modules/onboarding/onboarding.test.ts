import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sent, facts, routed, tmp } = vi.hoisted(() => ({
  sent: [] as Array<Record<string, unknown>>,
  facts: [] as Array<Record<string, unknown>>,
  routed: [] as Array<Record<string, unknown>>,
  tmp: { dir: '' },
}));

vi.mock('../../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  get GROUPS_DIR() {
    return tmp.dir;
  },
}));
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({
    deliver: async (_c: string, _p: string, _t: unknown, _k: string, content: string) => {
      sent.push(JSON.parse(content));
      return 'm';
    },
  }),
}));
vi.mock('../team-memory/index.js', () => ({ saveTeamFact: async (f: Record<string, unknown>) => void facts.push(f) }));
vi.mock('../../router.js', () => ({ routeInbound: async (e: Record<string, unknown>) => void routed.push(e) }));

import { closeDb, initTestDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getAskQuestionRender } from '../../db/sessions.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';
import { handleOnboardingResponse, handleOnboardingTurn, maybeOfferOnboarding, starterTasks } from './index.js';

const OWNER = 'telegram:1';
const ctx = (text = '', userId = OWNER) => ({
  agentGroupId: 'ag-1',
  userId,
  isDm: true,
  channelType: 'telegram',
  platformId: 'telegram:1',
  threadId: null,
  text,
});
const click = (questionId: string, value: string, userId = '1') =>
  handleOnboardingResponse({ questionId, value, userId, channelType: 'telegram', platformId: '', threadId: null });

describe('onboarding conversation', () => {
  beforeEach(() => {
    tmp.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-onb-'));
    runMigrations(initTestDb());
    sent.length = 0;
    facts.length = 0;
    routed.length = 0;
    createAgentGroup({
      id: 'ag-1',
      name: 'Ava',
      folder: 'ava',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    upsertUser({ id: OWNER, kind: 'telegram', display_name: 'Ana', created_at: new Date().toISOString() });
    grantRole({
      user_id: OWNER,
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: new Date().toISOString(),
    });
  });
  afterEach(() => {
    closeDb();
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('offers setup once, only to an owner or admin in a DM', async () => {
    await maybeOfferOnboarding(ctx('', 'telegram:999'));
    expect(sent).toHaveLength(0);
    await maybeOfferOnboarding(ctx());
    await maybeOfferOnboarding(ctx());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'ask_question', questionId: 'onb-offer-ag-1' });
    expect(getAskQuestionRender('onb-offer-ag-1')?.options.map((o) => o.value)).toEqual(['start', 'later']);
  });

  it('asks four questions, saves the answers for the team, and offers starter tasks', async () => {
    await maybeOfferOnboarding(ctx());
    await click('onb-offer-ag-1', 'start');
    expect(String(sent.at(-1)?.text)).toMatch(/What does your business/);

    expect(await handleOnboardingTurn(ctx('We run a bakery with two shops'))).toBe(true);
    expect(await handleOnboardingTurn(ctx('skip'))).toBe(true);
    expect(await handleOnboardingTurn(ctx('Gmail, Google Sheets, Shopify'))).toBe(true);
    // Someone else's message mid-setup goes to the agent as usual.
    expect(await handleOnboardingTurn(ctx('hello?', 'telegram:2'))).toBe(false);
    expect(await handleOnboardingTurn(ctx('Weekly sales summaries'))).toBe(true);

    expect(facts.map((f) => f.fact)).toEqual([
      'What we do: We run a bakery with two shops',
      'Tools we use: Gmail, Google Sheets, Shopify',
      'Help wanted first: Weekly sales summaries',
    ]);
    expect(facts[0]).toMatchObject({ approvedBy: OWNER, source: 'onboarding' });
    const profile = fs.readFileSync(path.join(tmp.dir, 'ava', 'team-profile.md'), 'utf8');
    expect(profile).toContain('**What we do:** We run a bakery with two shops');
    expect(profile).not.toContain('Who is on the team');

    const card = sent.at(-1)!;
    expect(card).toMatchObject({ type: 'ask_question', questionId: 'onb-start-ag-1' });
    // After setup, messages go to the agent again.
    expect(await handleOnboardingTurn(ctx('thanks'))).toBe(false);

    await click('onb-start-ag-1', starterTasks({ goals: 'Weekly sales summaries' })[0]);
    expect(routed[0]).toMatchObject({ platformId: 'telegram:1', message: { kind: 'chat' } });
    expect(JSON.parse((routed[0].message as { content: string }).content).text).toBe(
      'Help me with this first: Weekly sales summaries',
    );
  });

  it('"stop setup" ends it and "Not now" declines without asking again', async () => {
    await maybeOfferOnboarding(ctx());
    await click('onb-offer-ag-1', 'later');
    expect(String(sent.at(-1)?.text)).toMatch(/onboard/);
    await maybeOfferOnboarding(ctx());
    expect(sent).toHaveLength(2);
    expect(await handleOnboardingTurn(ctx('We sell shoes'))).toBe(false);
  });

  it('ignores clicks on the offer from anyone else', async () => {
    await maybeOfferOnboarding(ctx());
    await click('onb-offer-ag-1', 'start', '666');
    expect(await handleOnboardingTurn(ctx('We sell shoes'))).toBe(false);
  });
});
