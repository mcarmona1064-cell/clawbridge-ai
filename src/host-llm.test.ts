import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('./env.js', () => ({ readEnvFile: () => ({}) }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: execFileMock };
});

afterEach(() => {
  delete process.env.HOST_LLM_PROVIDER;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  execFileMock.mockReset();
  vi.resetModules();
});

describe('runHostPrompt', () => {
  it('uses the Codex CLI in read-only mode by default', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'codex answer', ''));
    const { runHostPrompt } = await import('./host-llm.js');

    await expect(runHostPrompt('hi')).resolves.toBe('codex answer');
    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe('codex');
    expect(args).toEqual(expect.arrayContaining(['exec', '--sandbox', 'read-only']));
  });

  it('uses `claude -p` when HOST_LLM_PROVIDER=claude and forwards only the API key', async () => {
    process.env.HOST_LLM_PROVIDER = 'claude';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api-test';
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'claude answer', ''));
    const { runHostPrompt, hostLlmLoginHint } = await import('./host-llm.js');

    await expect(runHostPrompt('hi', { sandbox: 'workspace-write' })).resolves.toBe('claude answer');
    const [cmd, args, opts] = execFileMock.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'text']);
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
    expect(args[args.length - 1]).toBe('hi');
    expect(opts.env.ANTHROPIC_API_KEY).toBe('sk-ant-api-test');
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(hostLlmLoginHint()).toContain('ANTHROPIC_API_KEY');
  });

  it('ignores an unknown HOST_LLM_PROVIDER and falls back to codex', async () => {
    process.env.HOST_LLM_PROVIDER = 'gemini';
    const { resolveHostLlmProvider } = await import('./host-llm.js');
    expect(resolveHostLlmProvider()).toBe('codex');
  });
});

describe('resolveClaudeCredential', () => {
  it('prefers an Anthropic API key over a legacy subscription token, .env over process env', async () => {
    const { resolveClaudeCredential } = await import('./claude-cli.js');
    expect(
      resolveClaudeCredential({ CLAUDE_CODE_OAUTH_TOKEN: 'env-token' }, { ANTHROPIC_API_KEY: 'file-key' }),
    ).toEqual({ kind: 'api-key', key: 'ANTHROPIC_API_KEY', value: 'file-key' });
    expect(resolveClaudeCredential({}, { CLAUDE_CODE_OAUTH_TOKEN: 'file-token' })).toEqual({
      kind: 'oauth',
      key: 'CLAUDE_CODE_OAUTH_TOKEN',
      value: 'file-token',
    });
    expect(resolveClaudeCredential({}, {})).toBeNull();
  });
});

describe('normalizeProvider', () => {
  it('accepts claude/codex case-insensitively and defaults everything else to codex', async () => {
    const { normalizeProvider } = await import('./config.js');
    expect(normalizeProvider('Claude')).toBe('claude');
    expect(normalizeProvider(' codex ')).toBe('codex');
    expect(normalizeProvider('claude          # comment')).toBe('codex');
    expect(normalizeProvider(undefined)).toBe('codex');
  });
});
