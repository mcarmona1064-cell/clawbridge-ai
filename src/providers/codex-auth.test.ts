import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { tmp, env } = vi.hoisted(() => ({ tmp: { dir: '' }, env: {} as Record<string, string> }));
vi.mock('../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../env.js', () => ({ readEnvFile: () => ({ ...env }) }));
vi.mock('./state-dir.js', () => ({ providerStateDir: () => tmp.dir }));

import './codex.js';
import { getProviderContainerConfig } from './provider-container-registry.js';

describe('codex credentials in containers', () => {
  beforeEach(() => {
    tmp.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-codex-'));
    fs.writeFileSync(path.join(tmp.dir, 'auth.json'), '{}');
  });
  afterEach(() => {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
    delete env.CODEX_AUTH_READONLY;
  });

  const contribution = () =>
    getProviderContainerConfig('codex')!({ agentGroupId: 'ag', sessionDir: '/x/sess-1', hostEnv: {} });

  it('leaves auth.json writable by default (Codex refreshes it)', () => {
    expect(contribution().mounts).toBeUndefined();
  });

  it('mounts auth.json read-only with CODEX_AUTH_READONLY=on', () => {
    env.CODEX_AUTH_READONLY = 'on';
    expect(contribution().mounts).toEqual([
      { hostPath: path.join(tmp.dir, 'auth.json'), containerPath: '/home/node/.codex/auth.json', readonly: true },
    ]);
  });
});
