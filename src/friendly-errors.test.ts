import { describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { classifyAgentError, rewriteAgentError, shouldAlert } from './friendly-errors.js';

describe('friendly agent errors', () => {
  it('classifies the common provider failures', () => {
    expect(classifyAgentError('API Error: 401 {"type":"authentication_error"}')).toBe('sign-in');
    expect(classifyAgentError('Codex: not logged in, please run codex login')).toBe('sign-in');
    expect(classifyAgentError('429 Too Many Requests')).toBe('limit');
    expect(classifyAgentError("You've reached your usage limit")).toBe('limit');
    expect(classifyAgentError('prompt is too long: 210000 tokens > 200000 maximum')).toBe('too-long');
    expect(classifyAgentError('fetch failed: getaddrinfo ENOTFOUND api.anthropic.com')).toBe('network');
    expect(classifyAgentError('TypeError: cannot read properties of undefined')).toBe('other');
  });

  it('shows the person a plain message and keeps the details for the admin', () => {
    const { content, alert } = rewriteAgentError(
      {
        text: 'Error: API Error: 401 invalid x-api-key at Object.<anonymous> (/app/x.js:1:2)',
        agentError: 'API Error: 401 invalid x-api-key',
      },
      'ag-x',
      'Ava',
    );
    expect(content).toEqual({ text: expect.stringContaining('sign-in problem') });
    expect(JSON.stringify(content)).not.toContain('x-api-key');
    expect(alert).toContain('Ava hit an error');
    expect(alert).toContain('claude setup-token');
  });

  it('alerts the admin at most once per agent and kind every 30 minutes', () => {
    const t = 1_000_000_000;
    expect(shouldAlert('ag-1', 'limit', t)).toBe(true);
    expect(shouldAlert('ag-1', 'limit', t + 60_000)).toBe(false);
    expect(shouldAlert('ag-1', 'network', t + 60_000)).toBe(true);
    expect(shouldAlert('ag-1', 'limit', t + 31 * 60_000)).toBe(true);
  });
});
