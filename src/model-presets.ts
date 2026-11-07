/**
 * Model presets: fast, balanced, best.
 *
 * People pick how much thinking (and cost) a conversation gets, in words
 * rather than model ids: `!fast`, `!deep`, or `/model fast|balanced|best`.
 * Each provider maps a preset to a model, overridable in .env:
 *
 *   Claude: CLAUDE_MODEL_FAST / _BALANCED / _BEST
 *   Codex:  CODEX_MODEL_FAST / _BALANCED / _BEST   (plus reasoning effort)
 *
 * DEFAULT_MODEL_PRESET sets the install default (balanced).
 */
import { getDb, hasTable } from './db/connection.js';
import { readEnvFile } from './env.js';

export type Preset = 'fast' | 'balanced' | 'best';
export const PRESETS: Preset[] = ['fast', 'balanced', 'best'];

const DEFAULTS: Record<string, Record<Preset, { model?: string; effort?: string }>> = {
  claude: {
    fast: { model: 'claude-haiku-5-5' },
    balanced: { model: 'claude-sonnet-5-5' },
    best: { model: 'claude-opus-5-5' },
  },
  codex: {
    fast: { model: 'gpt-5.4-mini', effort: 'low' },
    balanced: { effort: 'medium' },
    best: { effort: 'high' },
  },
};

export const PRESET_TEXT: Record<Preset, string> = {
  fast: 'Fast — quick answers, lowest cost',
  balanced: 'Balanced — the everyday default',
  best: 'Best — deepest thinking, highest cost',
};

export function parsePreset(raw: string | undefined): Preset | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'fast' || v === 'quick' || v === 'cheap') return 'fast';
  if (v === 'balanced' || v === 'normal' || v === 'default') return 'balanced';
  if (v === 'best' || v === 'deep' || v === 'smart') return 'best';
  return null;
}

export function defaultPreset(env: Record<string, string | undefined> = process.env): Preset {
  return (
    parsePreset(env.DEFAULT_MODEL_PRESET ?? readEnvFile(['DEFAULT_MODEL_PRESET']).DEFAULT_MODEL_PRESET) ?? 'balanced'
  );
}

/** Model id and effort for a provider and preset (env overrides first). */
export function resolvePreset(
  provider: string,
  preset: Preset,
  env: Record<string, string | undefined> = readEnvFile([
    'CLAUDE_MODEL_FAST',
    'CLAUDE_MODEL_BALANCED',
    'CLAUDE_MODEL_BEST',
    'CODEX_MODEL_FAST',
    'CODEX_MODEL_BALANCED',
    'CODEX_MODEL_BEST',
  ]),
): { model?: string; effort?: string } {
  const base = DEFAULTS[provider]?.[preset] ?? {};
  const override = env[`${provider.toUpperCase()}_MODEL_${preset.toUpperCase()}`];
  return { ...base, ...(override ? { model: override } : {}) };
}

function ready(): boolean {
  try {
    return hasTable(getDb(), 'session_prefs');
  } catch {
    return false;
  }
}

export function getSessionPreset(sessionId: string): Preset | null {
  if (!ready()) return null;
  const row = getDb().prepare('SELECT model_preset FROM session_prefs WHERE session_id = ?').get(sessionId) as
    | { model_preset: string | null }
    | undefined;
  return parsePreset(row?.model_preset ?? undefined);
}

export function setSessionPreset(sessionId: string, preset: Preset | null): void {
  if (!ready()) return;
  getDb()
    .prepare(
      `INSERT INTO session_prefs (session_id, model_preset, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET model_preset = excluded.model_preset, updated_at = excluded.updated_at`,
    )
    .run(sessionId, preset, new Date().toISOString());
}

/** Container env for a session's model choice. */
export function modelEnv(sessionId: string, provider: string): Record<string, string> {
  const preset = getSessionPreset(sessionId) ?? defaultPreset();
  const { model, effort } = resolvePreset(provider, preset);
  return {
    CLAWBRIDGE_MODEL_PRESET: preset,
    ...(model ? { CLAWBRIDGE_MODEL: model } : {}),
    ...(effort ? { CLAWBRIDGE_EFFORT: effort } : {}),
  };
}
