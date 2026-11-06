/**
 * Per-group, per-provider CLI state directory.
 *
 * Each provider CLI keeps its own session transcripts, settings and skill
 * symlinks under its home dot-dir. ClawBridge persists that per agent group
 * on the host and bind-mounts it at the path the CLI expects, so switching a
 * group between providers never mixes their state.
 */
import path from 'path';

import { DATA_DIR } from '../config.js';

interface ProviderStateLayout {
  /** Directory name under `data/v2-sessions/<agentGroupId>/`. */
  hostDirName: string;
  /** Where the provider CLI looks for its state inside the container. */
  containerPath: string;
}

const LAYOUTS: Record<string, ProviderStateLayout> = {
  claude: { hostDirName: '.claude-shared', containerPath: '/home/node/.claude' },
  codex: { hostDirName: '.codex-shared', containerPath: '/home/node/.codex' },
};

/** Providers with no CLI state of their own (e.g. `mock`) reuse the codex layout. */
const FALLBACK = LAYOUTS.codex;

export function providerStateLayout(provider: string): ProviderStateLayout {
  return LAYOUTS[provider.toLowerCase()] ?? FALLBACK;
}

/** Host path of the provider's state dir for one agent group. */
export function providerStateDir(agentGroupId: string, provider: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, providerStateLayout(provider).hostDirName);
}
