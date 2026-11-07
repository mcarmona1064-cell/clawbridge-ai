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
import { proxiedCredentialEnv } from '../credential-proxy.js';
import { readEnvFile } from '../env.js';

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

registerProviderContainerConfig('codex', ({ agentGroupId, sessionDir }) => {
  const codexDir = providerStateDir(agentGroupId, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });
  syncCodexOAuthAuth(codexDir);

  // No credential env — Codex reads its own OAuth token from ~/.codex/,
  // which container-runner bind-mounts from codexDir. Explicitly do NOT
  // forward OPENAI_API_KEY. With EGRESS_PROXY=on, only the proxy env is added.
  const proxied = proxiedCredentialEnv(path.basename(sessionDir), null);
  // CODEX_AUTH_READONLY=on mounts auth.json read-only over the writable
  // state dir, so code in the container can't overwrite or plant credentials.
  // Codex can then no longer save refreshed tokens itself; the host copy is
  // re-synced on every spawn, so keep `codex` signed in on the host.
  const authFile = path.join(codexDir, 'auth.json');
  const readonlyAuth =
    readEnvFile(['CODEX_AUTH_READONLY']).CODEX_AUTH_READONLY === 'on' && fs.existsSync(authFile)
      ? [{ hostPath: authFile, containerPath: '/home/node/.codex/auth.json', readonly: true }]
      : [];
  return {
    ...(proxied && Object.keys(proxied).length > 0 ? { env: proxied } : {}),
    ...(readonlyAuth.length ? { mounts: readonlyAuth } : {}),
  };
});
