import { describe, expect, it } from 'bun:test';

import { MemoryContextTracker, withMemoryContext } from './memory-context.js';

describe('memory context in the user turn', () => {
  it('prefixes a message with memory, or leaves it alone when there is none', () => {
    expect(withMemoryContext('hi', '')).toBe('hi');
    expect(withMemoryContext('hi', '## Memory Context\nA')).toBe('## Memory Context\nA\n\n---\n\nhi');
  });

  it('injects memory only when the recall changed since the last injection', () => {
    let current = '## Memory Context\nA';
    const tracker = new MemoryContextTracker(() => current);
    expect(tracker.decorate('one')).toContain('A');
    expect(tracker.decorate('two')).toBe('two'); // unchanged recall: no repeat
    current = '## Memory Context\nB';
    expect(tracker.decorate('three')).toContain('B');
    current = '';
    expect(tracker.decorate('four')).toBe('four');
  });
});
