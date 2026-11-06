/**
 * Memory-scope leak tests.
 *
 * A fake Hindsight server stores memories per bank and applies the real
 * tag-matching rules, so these tests prove that what is retained in one
 * conversation (e.g. a DM) cannot be recalled from another (a channel,
 * another DM, another agent group, or an internal run).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }));

type Stored = { bank: string; content: string; tags: string[] };
const store: Stored[] = [];
const recallCalls: Array<{ bank: string; tags: string[]; tagsMatch: string }> = [];

function matches(memTags: string[], want: string[], mode: string): boolean {
  if (memTags.length === 0) return mode === 'any' || mode === 'all';
  if (mode === 'all_strict' || mode === 'all') return want.every((t) => memTags.includes(t));
  return want.some((t) => memTags.includes(t));
}

vi.mock('@vectorize-io/hindsight-client', () => ({
  HindsightClient: class {
    async retain(bank: string, content: string, opts: { tags?: string[] }) {
      store.push({ bank, content, tags: opts.tags ?? [] });
    }
    async recall(bank: string, _q: string, opts: { tags: string[]; tagsMatch: string }) {
      recallCalls.push({ bank, tags: opts.tags, tagsMatch: opts.tagsMatch });
      const hits = store.filter((m) => m.bank === bank && matches(m.tags, opts.tags, opts.tagsMatch));
      return { results: hits.map((_h, i) => ({ id: String(i) })), text: hits.map((h) => h.content).join('\n') };
    }
  },
  HindsightError: class HindsightError extends Error {
    statusCode?: number;
  },
  recallResponseToPromptString: (r: { text?: string }) => r?.text ?? '',
}));

vi.stubGlobal(
  'fetch',
  vi.fn(async () => ({ ok: true }) as Response),
);

import { hindsightRecall, hindsightRetain, recallFromScopes, retainTurn } from './hindsight.js';
import {
  memoryScopeForSession,
  memoryScopesForSessions,
  originForSession,
  provenanceTags,
  readableScopesForSession,
  teamScopeForAgentGroup,
} from './scope.js';

const dmAlice = { agent_group_id: 'ag-1', messaging_group_id: 'mg-dm-alice' };
const dmBob = { agent_group_id: 'ag-1', messaging_group_id: 'mg-dm-bob' };
const general = { agent_group_id: 'ag-1', messaging_group_id: 'mg-general' };
const otherGroup = { agent_group_id: 'ag-2', messaging_group_id: 'mg-dm-alice' };
const internal = { agent_group_id: 'ag-1', messaging_group_id: null };

const SECRET = 'my salary is 120k, keep this between us please';

beforeEach(() => {
  store.length = 0;
  recallCalls.length = 0;
});

describe('memoryScopeForSession', () => {
  it('gives every conversation and agent group its own scope', () => {
    const scopes = [dmAlice, dmBob, general, otherGroup, internal].map(memoryScopeForSession);
    expect(new Set(scopes).size).toBe(5);
    expect(memoryScopeForSession(internal)).toBe('ag-1--internal');
  });

  it('is stable for the same conversation and dedupes in bulk', () => {
    expect(memoryScopeForSession({ ...general })).toBe(memoryScopeForSession(general));
    expect(memoryScopesForSessions([general, general, dmBob])).toHaveLength(2);
  });
});

describe('scoped recall (leak canary)', () => {
  async function retainIn(session: typeof dmAlice | typeof internal, text: string) {
    await retainTurn(memoryScopeForSession(session), text, 'Understood, I will remember that.', {
      sessionId: 's-1',
    });
  }

  it('recalls a DM fact inside the same DM', async () => {
    await retainIn(dmAlice, SECRET);
    expect(await hindsightRecall(memoryScopeForSession(dmAlice), 'salary')).toContain('120k');
  });

  it('never recalls a DM fact in a channel, another DM, another agent group, or an internal run', async () => {
    await retainIn(dmAlice, SECRET);
    for (const elsewhere of [general, dmBob, otherGroup, internal]) {
      expect(await hindsightRecall(memoryScopeForSession(elsewhere), 'salary')).toBe('');
    }
  });

  it('never recalls a channel fact in a DM', async () => {
    await retainIn(general, 'the launch moved to Friday because QA found a blocker');
    expect(await hindsightRecall(memoryScopeForSession(dmAlice), 'launch')).toBe('');
  });

  it('filters reads by the scope tag with all_strict, so untagged memories never match', async () => {
    const scope = memoryScopeForSession(general);
    store.push({ bank: `client-${scope.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`, content: 'untagged', tags: [] });
    expect(await hindsightRecall(scope, 'anything')).toBe('');
    expect(recallCalls.at(-1)).toMatchObject({ tags: [`client:${scope}`], tagsMatch: 'all_strict' });
  });
});

describe('team memory scoping', () => {
  async function approveTeamFact(agentGroupId: string, fact: string) {
    await hindsightRetain(teamScopeForAgentGroup(agentGroupId), fact, {
      extraTags: provenanceTags({ origin: 'group', messagingGroupId: 'mg-general', approvedBy: 'slack:U1' }),
    });
  }

  it('reads the team bank from every conversation of the same agent group, never another group', async () => {
    await approveTeamFact('ag-1', 'invoices go out on the 3rd of each month');
    for (const session of [dmAlice, dmBob, general, internal]) {
      expect(await recallFromScopes(readableScopesForSession(session), 'invoices')).toContain('Team knowledge');
    }
    expect(await recallFromScopes(readableScopesForSession(otherGroup), 'invoices')).toBe('');
  });

  it('keeps conversation memories out of the team bank: a DM turn is never shared without approval', async () => {
    await retainTurn(memoryScopeForSession(dmAlice), SECRET, 'Understood, I will remember that.', { sessionId: 's-1' });
    const fromChannel = await recallFromScopes(readableScopesForSession(general), 'salary');
    expect(fromChannel).toBe('');
    const fromOwnDm = await recallFromScopes(readableScopesForSession(dmAlice), 'salary');
    expect(fromOwnDm).toContain('### This conversation');
    expect(fromOwnDm).not.toContain('Team knowledge');
  });

  it('labels each bank in the merged memory context', async () => {
    await approveTeamFact('ag-1', 'the launch checklist lives in Notion');
    await retainTurn(
      memoryScopeForSession(general),
      'remember the launch is on Friday this week',
      'Noted: launch Friday.',
      {
        sessionId: 's-2',
      },
    );
    const ctx = await recallFromScopes(readableScopesForSession(general), 'launch');
    expect(ctx.indexOf('Team knowledge')).toBeLessThan(ctx.indexOf('This conversation'));
  });

  it('derives origin from the messaging group, defaulting to the most private', () => {
    expect(originForSession(general, { is_group: 1 })).toBe('group');
    expect(originForSession(dmAlice, { is_group: 0 })).toBe('dm');
    expect(originForSession(dmAlice, undefined)).toBe('dm');
    expect(originForSession(internal, undefined)).toBe('internal');
  });
});
