import { execFile } from 'child_process';

import { readEnvFile } from './env.js';

export type ClaudeCredential =
  | { kind: 'oauth'; key: 'CLAUDE_CODE_OAUTH_TOKEN'; value: string }
  | { kind: 'api-key'; key: 'ANTHROPIC_API_KEY'; value: string };

/**
 * Resolve the Claude credential from ~/.clawbridge/.env (then process.env).
 * An Anthropic API key wins: Anthropic does not allow products built on the
 * Agent SDK to use claude.ai login. A legacy subscription token is used only
 * when no API key exists (doctor flags that setup).
 */
export function resolveClaudeCredential(
  hostEnv: NodeJS.ProcessEnv = process.env,
  dotenv: Record<string, string> = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']),
): ClaudeCredential | null {
  const apiKey = dotenv.ANTHROPIC_API_KEY || hostEnv.ANTHROPIC_API_KEY;
  if (apiKey) return { kind: 'api-key', key: 'ANTHROPIC_API_KEY', value: apiKey };
  const oauth = dotenv.CLAUDE_CODE_OAUTH_TOKEN || hostEnv.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauth) return { kind: 'oauth', key: 'CLAUDE_CODE_OAUTH_TOKEN', value: oauth };
  return null;
}

export interface ClaudePromptOptions {
  /** read-only: tools that need permission are denied; workspace-write: file edits are auto-accepted. */
  sandbox?: 'read-only' | 'workspace-write';
  timeout?: number;
  cwd?: string;
  maxBuffer?: number;
  model?: string;
}

/**
 * Run a one-shot prompt through the host's Claude Code CLI (`claude -p`).
 * Mirrors `runCodexPrompt` so host-side callers can use either provider.
 */
export async function runClaudePrompt(
  prompt: string,
  {
    sandbox = 'read-only',
    timeout = 120_000,
    cwd = process.cwd(),
    maxBuffer = 1024 * 1024,
    model,
  }: ClaudePromptOptions = {},
): Promise<string> {
  const args = ['-p', '--output-format', 'text'];
  if (sandbox === 'workspace-write') args.push('--permission-mode', 'acceptEdits');
  if (model) args.push('--model', model);
  args.push(prompt);

  const env: NodeJS.ProcessEnv = { ...process.env };
  const credential = resolveClaudeCredential();
  if (credential) {
    // Forward exactly one credential (the API key when present).
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
    env[credential.key] = credential.value;
  }

  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile('claude', args, { timeout, cwd, maxBuffer, env }, (execErr, stdout, stderr) => {
      if (execErr) {
        const err = execErr as Error & { stderr?: string };
        err.stderr = String(stderr || '');
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });

  return result.stdout.trim() || result.stderr.trim();
}
