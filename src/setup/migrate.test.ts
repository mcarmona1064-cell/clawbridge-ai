import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadMigrateWithHome(home: string) {
  vi.resetModules();
  vi.doMock('os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('os')>();
    return {
      ...actual,
      default: { ...actual, homedir: () => home },
      homedir: () => home,
    };
  });
  return import('./migrate.js');
}

describe('clawbridge-ai migration detection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('never offers ~/.clawbridge to the OpenClaw/NanoClaw importer', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-legacy-home-'));
    fs.mkdirSync(path.join(home, '.clawbridge'), { recursive: true });
    fs.writeFileSync(path.join(home, '.clawbridge', '.env'), 'AGENT_PROVIDER=claude\nTELEGRAM_BOT_TOKEN=x\n');

    const { detectInstall } = await loadMigrateWithHome(home);

    await expect(detectInstall()).resolves.toBeNull();
  });

  it('honors the requested migration source type when multiple installs exist', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-multi-home-'));
    fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true });
    fs.mkdirSync(path.join(home, '.nanoclaw'), { recursive: true });

    const { detectInstall } = await loadMigrateWithHome(home);

    await expect(detectInstall('nanoclaw')).resolves.toEqual({ type: 'nanoclaw', path: path.join(home, '.nanoclaw') });
    await expect(detectInstall('openclaw')).resolves.toEqual({ type: 'openclaw', path: path.join(home, '.openclaw') });
  });

  it('points older ClawBridge installs at clawbridge-ai migrate', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-manual-home-'));
    const dir = path.join(home, 'something');
    fs.mkdirSync(dir, { recursive: true });

    const { resolveManualPath } = await loadMigrateWithHome(home);

    expect(resolveManualPath(dir)).toEqual({ error: expect.stringContaining('clawbridge-ai migrate') });
  });
});
