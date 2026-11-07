import { describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { ensureLockdown, lockdownNetworkArgs, lockdownProxyBase, relayScript } from './egress-lockdown.js';

function fakeDocker(state: { networks: string[]; relayRunning: boolean; fail?: boolean }) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (state.fail) throw new Error('Cannot connect to the Docker daemon');
    if (args[0] === 'network' && args[1] === 'ls') return state.networks.join('\n');
    if (args[0] === 'ps') return state.relayRunning ? 'clawbridge-egress-relay\n' : '';
    return '';
  };
  return { run, calls };
}

describe('egress lockdown', () => {
  it('creates an internal network and a relay that holds no secrets', () => {
    const d = fakeDocker({ networks: ['bridge', 'host'], relayRunning: false });
    expect(ensureLockdown('clawbridge-agent:latest', 3011, d.run)).toBe(true);
    expect(d.calls).toContainEqual(['network', 'create', '--internal', 'clawbridge-egress']);
    const run = d.calls.find((c) => c[0] === 'run')!;
    expect(run).toEqual(
      expect.arrayContaining(['--cap-drop', 'ALL', '--entrypoint', 'node', 'clawbridge-agent:latest']),
    );
    expect(run.join(' ')).not.toMatch(/-e [A-Z_]+=|TOKEN|KEY/);
    expect(d.calls).toContainEqual([
      'network',
      'connect',
      '--alias',
      'egress',
      'clawbridge-egress',
      'clawbridge-egress-relay',
    ]);
  });

  it('is idempotent once set up', () => {
    const d = fakeDocker({ networks: ['clawbridge-egress'], relayRunning: true });
    expect(ensureLockdown('img', 3011, d.run)).toBe(true);
    expect(d.calls.map((c) => c[0])).toEqual(['network', 'ps']);
  });

  it('falls back instead of failing when Docker refuses', () => {
    expect(ensureLockdown('img', 3011, fakeDocker({ networks: [], relayRunning: false, fail: true }).run)).toBe(false);
  });

  it('points containers at the relay and only forwards to the host proxy', () => {
    expect(lockdownNetworkArgs()).toEqual(['--network', 'clawbridge-egress']);
    expect(lockdownProxyBase(3011)).toBe('http://egress:3011');
    expect(relayScript(3011)).toContain("net.connect(3011,'host.docker.internal')");
  });
});
