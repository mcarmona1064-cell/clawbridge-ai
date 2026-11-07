import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./audit.js', () => ({ audit: vi.fn() }));

import { gateClaims, recordSessionAction, resetClaimGate, unverifiedClaims } from './claim-gate.js';

describe('claim-receipt gate', () => {
  beforeEach(() => resetClaimGate());

  it('flags a scheduling claim with no scheduled job behind it', () => {
    const { text, flagged } = gateClaims('s1', 'ag', "Done! I've scheduled the report for every Monday at 9.");
    expect(flagged).toEqual(['schedule']);
    expect(text).toMatch(/Correction: I haven't actually scheduled this yet/);
  });

  it('lets the claim through once the action really happened', () => {
    recordSessionAction('s1', 'schedule_task');
    expect(gateClaims('s1', 'ag', "I'll remind you tomorrow at 8.").flagged).toEqual([]);
    // Another session's action is not a receipt.
    expect(unverifiedClaims('s2', "I'll remind you tomorrow at 8.")).toEqual(['schedule']);
  });

  it('expires receipts after ten minutes', () => {
    recordSessionAction('s1', 'schedule_task', 0);
    expect(unverifiedClaims('s1', "I've scheduled it.", 11 * 60 * 1000)).toEqual(['schedule']);
  });

  it('checks team-memory and cross-posting claims too', () => {
    expect(unverifiedClaims('s1', "I've saved that to team memory.")).toEqual(['team_memory']);
    expect(unverifiedClaims('s1', 'I posted it in #sales for the team.')).toEqual(['cross_post']);
    recordSessionAction('s1', 'propose_team_memory');
    expect(unverifiedClaims('s1', "I've saved that to team memory.")).toEqual([]);
  });

  it('ignores ordinary sentences and anything inside code', () => {
    expect(unverifiedClaims('s1', 'Do you want me to schedule it? You could also set a reminder.')).toEqual([]);
    expect(unverifiedClaims('s1', "Example:\n```\nI've scheduled the job\n```")).toEqual([]);
  });
});
