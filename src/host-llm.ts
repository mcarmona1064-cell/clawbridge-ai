/**
 * Host-side one-shot LLM calls (memory extraction, reflection, cross-client
 * reports, error diagnosis) routed through whichever provider CLI the
 * install uses. Both paths use the CLI's own login — `codex login` OAuth or
 * the Claude token from `claude setup-token` — never raw API calls from here.
 *
 * Provider: HOST_LLM_PROVIDER in ~/.clawbridge/.env (claude|codex), falling
 * back to the install default (DEFAULT_AGENT_PROVIDER).
 */
import { runClaudePrompt } from './claude-cli.js';
import { runCodexPrompt } from './codex-cli.js';
import { AGENT_PROVIDER, normalizeProvider, type AgentProviderName } from './config.js';
import { readEnvFile } from './env.js';

export interface HostPromptOptions {
  sandbox?: 'read-only' | 'workspace-write';
  timeout?: number;
  cwd?: string;
  maxBuffer?: number;
}

export function resolveHostLlmProvider(): AgentProviderName {
  const configured = process.env.HOST_LLM_PROVIDER || readEnvFile(['HOST_LLM_PROVIDER']).HOST_LLM_PROVIDER;
  return configured ? normalizeProvider(configured) : normalizeProvider(AGENT_PROVIDER);
}

export function hostLlmLabel(provider: AgentProviderName = resolveHostLlmProvider()): string {
  return provider === 'claude' ? 'Claude Code CLI' : 'Codex CLI';
}

export function hostLlmLoginHint(provider: AgentProviderName = resolveHostLlmProvider()): string {
  return provider === 'claude' ? 'claude setup-token' : 'codex login --device-auth';
}

export async function runHostPrompt(prompt: string, opts: HostPromptOptions = {}): Promise<string> {
  const provider = resolveHostLlmProvider();
  if (provider === 'claude') {
    const model = process.env.HOST_LLM_MODEL || readEnvFile(['HOST_LLM_MODEL']).HOST_LLM_MODEL || undefined;
    return runClaudePrompt(prompt, { ...opts, model });
  }
  return runCodexPrompt(prompt, opts);
}
