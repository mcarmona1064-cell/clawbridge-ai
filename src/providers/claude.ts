/**
 * Host-side container config for the Claude provider (Claude Agent SDK +
 * Claude Code CLI inside the container).
 *
 * - Seeds `settings.json` in the per-group `.claude-shared/` state dir
 *   (mounted at /home/node/.claude by container-runner).
 * - Passes the Claude credential from ~/.clawbridge/.env: an Anthropic API
 *   key. (Anthropic does not allow products built on the Agent SDK to use
 *   claude.ai login; a legacy subscription token is only a fallback, and
 *   doctor flags it.) Exactly one credential is forwarded.
 */
import fs from 'fs';
import path from 'path';

import { resolveClaudeCredential } from '../claude-cli.js';
import { log } from '../log.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';
import { providerStateDir } from './state-dir.js';

const DEFAULT_SETTINGS_JSON =
  JSON.stringify(
    {
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    },
    null,
    2,
  ) + '\n';

registerProviderContainerConfig('claude', ({ agentGroupId, hostEnv }) => {
  const claudeDir = providerStateDir(agentGroupId, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsFile = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, DEFAULT_SETTINGS_JSON);
  }

  const credential = resolveClaudeCredential(hostEnv);
  if (!credential) {
    log.warn('Claude provider selected but no ANTHROPIC_API_KEY in ~/.clawbridge/.env', {
      agentGroupId,
    });
    return {};
  }
  return { env: { [credential.key]: credential.value } };
});
