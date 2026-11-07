import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./env.js', () => ({ readEnvFile: () => ({}) }));

import { closeDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { modelEnv, parsePreset, resolvePreset, setSessionPreset } from './model-presets.js';

describe('model presets', () => {
  beforeEach(() => runMigrations(initTestDb()));
  afterEach(() => {
    closeDb();
    delete process.env.DEFAULT_MODEL_PRESET;
  });

  it('understands plain words', () => {
    expect(parsePreset('Deep')).toBe('best');
    expect(parsePreset('quick')).toBe('fast');
    expect(parsePreset('normal')).toBe('balanced');
    expect(parsePreset('turbo')).toBeNull();
  });

  it('maps presets to each provider, with .env overrides', () => {
    expect(resolvePreset('claude', 'fast', {})).toEqual({ model: 'claude-haiku-5-5' });
    expect(resolvePreset('claude', 'best', { CLAUDE_MODEL_BEST: 'claude-fable-5-1' })).toEqual({
      model: 'claude-fable-5-1',
    });
    expect(resolvePreset('codex', 'best', {})).toEqual({ effort: 'high' });
  });

  it('gives each conversation its own preset, defaulting to balanced', () => {
    expect(modelEnv('s1', 'claude')).toEqual({
      CLAWBRIDGE_MODEL_PRESET: 'balanced',
      CLAWBRIDGE_MODEL: 'claude-sonnet-5-5',
    });
    setSessionPreset('s1', 'fast');
    expect(modelEnv('s1', 'claude').CLAWBRIDGE_MODEL).toBe('claude-haiku-5-5');
    expect(modelEnv('s2', 'codex')).toEqual({ CLAWBRIDGE_MODEL_PRESET: 'balanced', CLAWBRIDGE_EFFORT: 'medium' });
    process.env.DEFAULT_MODEL_PRESET = 'best';
    expect(modelEnv('s3', 'codex').CLAWBRIDGE_EFFORT).toBe('high');
  });
});
