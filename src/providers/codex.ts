/**
 * Host-side container config for the Codex provider.
 *
 * Registers a ProviderContainerContribution that:
 * - Syncs the host's Codex OAuth `auth.json` into the per-group
 *   `.codex-shared/` state dir (mounted at /home/node/.codex by
 *   container-runner).
 * - Forwards no API keys, so Codex uses subscription OAuth rather than
 *   API-key billing.
 *
 * No extra env vars are forwarded — credentials are injected by the Codex
 * CLI's own OAuth credential store (populated via `codex login --device-auth`).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { registerProviderContainerConfig } from './provider-container-registry.js';
import { providerStateDir } from './state-dir.js';

function syncCodexOAuthAuth(codexDir: string): void {
  const hostAuth = path.join(os.homedir(), '.codex', 'auth.json');
  const groupAuth = path.join(codexDir, 'auth.json');
  if (!fs.existsSync(hostAuth)) return;

  try {
    const hostContent = fs.readFileSync(hostAuth);
    const current = fs.existsSync(groupAuth) ? fs.readFileSync(groupAuth) : undefined;
    if (!current || !current.equals(hostContent)) {
      fs.copyFileSync(hostAuth, groupAuth);
      try {
        fs.chmodSync(groupAuth, 0o600);
      } catch {
        /* best effort only */
      }
    }
  } catch {
    // Spawn should still proceed; doctor reports missing/broken Codex auth.
  }
}

registerProviderContainerConfig('codex', ({ agentGroupId }) => {
  const codexDir = providerStateDir(agentGroupId, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });
  syncCodexOAuthAuth(codexDir);

  // No env passthrough — Codex reads its own OAuth token from ~/.codex/,
  // which container-runner bind-mounts from codexDir. Explicitly do NOT
  // forward OPENAI_API_KEY.
  return {};
});
