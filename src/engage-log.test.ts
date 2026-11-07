import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { engageReason, recordEngageDecision, whyText } from './engage-log.js';

describe('reply decisions', () => {
  beforeEach(() => runMigrations(initTestDb()));
  afterEach(() => closeDb());

  it('names the reason in plain words', () => {
    const base = {
      engages: true,
      accessOk: true,
      scopeOk: true,
      isMention: false,
      isDm: false,
      engageMode: 'mention',
      pattern: null,
    };
    expect(engageReason({ ...base, engages: false })).toBe('not mentioned');
    expect(engageReason({ ...base, accessOk: false })).toBe('not allowed to use this agent');
    expect(engageReason({ ...base, isDm: true })).toBe('direct message');
    expect(engageReason({ ...base, isMention: true })).toBe('mentioned');
    expect(engageReason({ ...base, engageMode: 'pattern', pattern: '.' })).toBe('answers everything here');
    expect(engageReason({ ...base, engageMode: 'mention-sticky' })).toBe('thread it joined');
  });

  it('/why lists recent decisions for this chat only', () => {
    const row = {
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
      agentGroupId: 'ag-1',
      userId: 'slack:U1',
    };
    recordEngageDecision({ ...row, engaged: false, reason: 'not mentioned' });
    recordEngageDecision({ ...row, engaged: true, reason: 'mentioned' });
    recordEngageDecision({ ...row, platformId: 'slack:C2', engaged: true, reason: 'mentioned' });
    const text = whyText('slack', 'slack:C1');
    expect(text.match(/•/g)).toHaveLength(2);
    expect(text).toMatch(/answered \(mentioned\)[\s\S]*stayed quiet \(not mentioned\)/);
    expect(whyText('slack', 'slack:C9')).toMatch(/No decisions/);
  });
});
