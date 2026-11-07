import { describe, expect, it } from 'bun:test';

import { buildInitialArgs, buildResumeArgs } from './codex.js';

const servers = { clawbridge: { command: 'bun', args: ['run', '/app/src/mcp-tools/index.ts'], env: {} } };

describe('codex exec arguments', () => {
  it('starts a thread with the sandbox, cwd and MCP servers', () => {
    const args = buildInitialArgs('/workspace/agent', servers);
    expect(args.slice(0, 7)).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '-C',
      '/workspace/agent',
    ]);
    expect(args).toContain('mcp_servers.clawbridge.command="bun"');
  });

  it('resumes with the same exec options placed before the resume subcommand', () => {
    const args = buildResumeArgs('thread-123', '/workspace/agent', servers);
    const resumeAt = args.indexOf('resume');
    expect(args.slice(-2)).toEqual(['resume', 'thread-123']);
    expect(args.indexOf('--sandbox')).toBeLessThan(resumeAt);
    expect(args.indexOf('-C')).toBeLessThan(resumeAt);
    expect(args.some((a) => a.startsWith('mcp_servers.clawbridge.'))).toBe(true);
  });
});

describe('codex model preset args', () => {
  it('adds -m and reasoning effort from the host preset, and nothing when unset', async () => {
    const { buildInitialArgs, modelArgs } = await import('./codex.js');
    expect(modelArgs({ CLAWBRIDGE_MODEL: 'gpt-5.4-mini', CLAWBRIDGE_EFFORT: 'low' })).toEqual([
      '-m',
      'gpt-5.4-mini',
      '-c',
      'model_reasoning_effort="low"',
    ]);
    expect(modelArgs({ CLAWBRIDGE_MODEL: 'bad model; rm -rf /' })).toEqual([]);
    expect(buildInitialArgs('/w', {}, {})).not.toContain('-m');
  });
});
