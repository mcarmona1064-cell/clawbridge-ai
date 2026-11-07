import { describe, expect, it } from 'bun:test';

import { claudeUsage } from './claude.js';
import { codexUsage } from './codex.js';

describe('turn usage', () => {
  it('reads Claude SDK result usage and cost', () => {
    expect(
      claudeUsage({
        type: 'result',
        usage: {
          input_tokens: 120,
          output_tokens: 80,
          cache_read_input_tokens: 9000,
          cache_creation_input_tokens: 400,
        },
        total_cost_usd: 0.0123,
        modelUsage: { 'claude-sonnet-5-5': {} },
      }),
    ).toEqual({
      model: 'claude-sonnet-5-5',
      inputTokens: 120,
      outputTokens: 80,
      cacheReadTokens: 9000,
      cacheWriteTokens: 400,
      costUsd: 0.0123,
    });
    expect(claudeUsage({ type: 'result' })).toBeUndefined();
  });

  it('reads Codex turn.completed usage, separating cached input', () => {
    expect(
      codexUsage({
        type: 'turn.completed',
        usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 300 },
      }),
    ).toEqual({
      inputTokens: 1000,
      outputTokens: 300,
      cacheReadTokens: 4000,
      cacheWriteTokens: 0,
    });
  });
});
