import { afterEach, describe, expect, it, vi } from 'vitest';

const sent: unknown[][] = [];
vi.mock('./log.js', () => ({ log: { debug: vi.fn() } }));
vi.mock('./delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: async (...a: unknown[]) => void sent.push(a) }),
}));

import { clearProgressWatch, startProgressWatch } from './progress-notice.js';

describe('progress note on long jobs', () => {
  afterEach(() => {
    sent.length = 0;
    vi.useRealTimers();
  });

  it('posts one note after 90 s of silence', () => {
    vi.useFakeTimers();
    startProgressWatch('s1', 'telegram', 'telegram:1', null);
    startProgressWatch('s1', 'telegram', 'telegram:1', null);
    vi.advanceTimersByTime(89_000);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(2_000);
    expect(sent).toHaveLength(1);
    expect(String(sent[0][4])).toMatch(/Still working/);
  });

  it('is cancelled by a reply, and skipped on Slack (which has a status line)', () => {
    vi.useFakeTimers();
    startProgressWatch('s2', 'whatsapp', 'whatsapp:1', null);
    clearProgressWatch('s2');
    startProgressWatch('s3', 'slack', 'slack:C1', '1.1');
    vi.advanceTimersByTime(120_000);
    expect(sent).toHaveLength(0);
  });
});
