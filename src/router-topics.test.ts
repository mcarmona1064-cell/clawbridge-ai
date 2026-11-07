import { describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { parentPlatformId } from './router.js';

describe('sub-conversations', () => {
  it('maps a Telegram forum topic to its group', () => {
    expect(parentPlatformId('telegram', 'telegram:-1001234:5')).toBe('telegram:-1001234');
    expect(parentPlatformId('telegram', 'telegram:-1001234')).toBeNull();
    expect(parentPlatformId('slack', 'slack:C1:5')).toBeNull();
  });
});
