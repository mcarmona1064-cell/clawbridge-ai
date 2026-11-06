import { describe, expect, it } from 'vitest';

import { resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('defaults to codex when nothing is set', () => {
    expect(resolveProviderName(null, null, undefined)).toBe('codex');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName(null, null, 'Codex')).toBe('codex');
  });

  it('treats empty string as unset (falls through to default)', () => {
    expect(resolveProviderName('', null, undefined)).toBe('codex');
  });
});

describe('containerHardeningArgs', () => {
  it('drops capabilities, blocks privilege escalation and limits resources by default', async () => {
    const { containerHardeningArgs } = await import('./container-runner.js');
    expect(containerHardeningArgs({})).toEqual([
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '1024',
      '--memory',
      '4g',
    ]);
  });

  it('honours overrides and can be switched off', async () => {
    const { containerHardeningArgs } = await import('./container-runner.js');
    expect(containerHardeningArgs({ CONTAINER_MEMORY: '8g', CONTAINER_CPUS: '2' })).toEqual(
      expect.arrayContaining(['--memory', '8g', '--cpus', '2']),
    );
    expect(containerHardeningArgs({ CONTAINER_HARDENING: 'off' })).toEqual([]);
  });
});
