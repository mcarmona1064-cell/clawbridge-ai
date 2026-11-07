import { describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../container-runner.js', () => ({ wakeContainer: vi.fn() }));

import { runsPerDay, scheduleRefusal } from './actions.js';

describe('schedule rules', () => {
  it('counts runs in the next 24 hours', async () => {
    const from = new Date('2026-11-06T00:00:00Z');
    expect(await runsPerDay('0 9 * * *', from)).toBe(1);
    expect(await runsPerDay('*/15 * * * *', from)).toBe(96);
  });

  it('lets daily jobs and one-off reminders through', async () => {
    expect(await scheduleRefusal({ recurrence: '0 9 * * 1-5', script: null, fromTask: false })).toBeNull();
    expect(await scheduleRefusal({ recurrence: null, script: null, fromTask: true })).toBeNull();
  });

  it('asks frequent jobs for a condition script', async () => {
    expect(await scheduleRefusal({ recurrence: '*/10 * * * *', script: null, fromTask: false })).toMatch(
      /144 times a day.*condition script/,
    );
    expect(
      await scheduleRefusal({ recurrence: '*/10 * * * *', script: 'return { wakeAgent: false }', fromTask: false }),
    ).toBeNull();
  });

  it('stops scheduled jobs from creating recurring jobs, and rejects bad cron', async () => {
    expect(await scheduleRefusal({ recurrence: '0 9 * * *', script: null, fromTask: true })).toMatch(
      /cannot create another recurring job/,
    );
    expect(await scheduleRefusal({ recurrence: 'every tuesday', script: null, fromTask: false })).toMatch(
      /not a valid cron/,
    );
  });
});
