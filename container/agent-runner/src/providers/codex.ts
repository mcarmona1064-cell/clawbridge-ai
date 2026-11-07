/**
 * OpenAI Codex CLI provider (@openai/codex >= 0.124.0).
 *
 * Drives one `codex exec --json` subprocess per turn. The JSONL event stream
 * is mapped onto ProviderEvent. Multi-turn continuity comes from
 * `codex exec resume --json <thread_id>`.
 *
 * Auth model: subscription OAuth only — `codex login --device-auth`.
 * OPENAI_API_KEY / CODEX_API_KEY are stripped from env so a stray key cannot
 * silently flip the CLI into API-billing mode.
 */

import { spawn, type ChildProcess } from 'child_process';

import { MemoryContextTracker } from './memory-context.js';
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
  TurnUsage,
} from './types.js';

function log(msg: string): void {
  console.error(`[codex-provider] ${msg}`);
}

const STALE_SESSION_RE = /session.*not found|no recorded session|missing transcript|unknown.*thread|invalid.*session/i;

function stripApiKeyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  delete out['OPENAI_API_KEY'];
  delete out['CODEX_API_KEY'];
  delete out['OPENAI_BASE_URL'];
  return out;
}

function tomlStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : `"${k.replace(/"/g, '\\"')}"`;
}

/**
 * Render MCP server configs as `-c mcp_servers.NAME.field=value` args.
 * One `-c` per dotted key, which the Codex CLI parses as TOML overrides.
 */
function mcpServerArgs(servers: Record<string, McpServerConfig>): string[] {
  const out: string[] = [];
  for (const [rawName, cfg] of Object.entries(servers)) {
    const name = tomlKey(rawName);
    out.push('-c', `mcp_servers.${name}.command=${tomlStr(cfg.command)}`);
    if (cfg.args.length > 0) {
      const arr = `[${cfg.args.map(tomlStr).join(', ')}]`;
      out.push('-c', `mcp_servers.${name}.args=${arr}`);
    }
    for (const [k, v] of Object.entries(cfg.env)) {
      out.push('-c', `mcp_servers.${name}.env.${tomlKey(k)}=${tomlStr(v)}`);
    }
  }
  return out;
}

export function buildInitialArgs(
  cwd: string,
  mcpServers: Record<string, McpServerConfig>,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [
    'exec',
    '--json',
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    '-C',
    cwd,
    ...modelArgs(env),
    ...mcpServerArgs(mcpServers),
  ];
}

/** Model and reasoning effort from the host's preset (fast / balanced / best). */
export function modelArgs(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  if (env.CLAWBRIDGE_MODEL && /^[\w.:-]+$/.test(env.CLAWBRIDGE_MODEL)) out.push('-m', env.CLAWBRIDGE_MODEL);
  if (env.CLAWBRIDGE_EFFORT && /^(minimal|low|medium|high|xhigh)$/.test(env.CLAWBRIDGE_EFFORT)) {
    out.push('-c', `model_reasoning_effort="${env.CLAWBRIDGE_EFFORT}"`);
  }
  return out;
}

/**
 * Resume a thread with the SAME sandbox, working directory and MCP servers as
 * a new one. `--sandbox` and `-C` are `exec`-level options that are not
 * global (checked in codex-rs/exec/src/cli.rs for 0.124 and 0.167), so they
 * must come before the `resume` subcommand; `-c` overrides are collected from
 * every scope and `--json` is global. Without them a resumed turn ran without
 * the clawbridge MCP tools and with the default sandbox.
 */
export function buildResumeArgs(threadId: string, cwd: string, mcpServers: Record<string, McpServerConfig>): string[] {
  return [...buildInitialArgs(cwd, mcpServers), 'resume', threadId];
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  item?: { type?: string; text?: string };
}

export class CodexProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private mcpServers: Record<string, McpServerConfig>;

  constructor(options: ProviderOptions = {}) {
    this.mcpServers = options.mcpServers ?? {};
    // Codex has no concept of assistantName / additionalDirectories at the
    // CLI level — they're embedded in the prompt by the agent-runner.
    void options.assistantName;
    void options.additionalDirectories;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const mcpServers = this.mcpServers;
    const cwd = input.cwd;

    // Instructions go only into a NEW thread; a resumed thread already has
    // them, and re-sending them on every resume bloats each turn.
    const instructions = input.continuation ? undefined : input.systemContext?.instructions?.trim();
    // Hindsight recall (written by the host per inbound message) rides in the
    // user turn; follow-ups carry it only when the recall changed.
    const memory = new MemoryContextTracker();
    const firstMessage = memory.decorate(input.prompt);
    const initialPrompt = instructions ? `${instructions}\n\n---\n\n${firstMessage}` : firstMessage;

    const state: {
      threadId: string | undefined;
      aborted: boolean;
      ended: boolean;
      current: ChildProcess | undefined;
      pushQueue: string[];
      wake: (() => void) | undefined;
    } = {
      threadId: input.continuation,
      aborted: false,
      ended: false,
      current: undefined,
      pushQueue: [],
      wake: undefined,
    };

    async function* runTurns(): AsyncGenerator<ProviderEvent> {
      let pending: string | undefined = initialPrompt;
      while (!state.aborted) {
        if (pending === undefined) {
          if (state.pushQueue.length > 0) {
            pending = state.pushQueue.shift();
          } else {
            // Idle — let poll-loop re-enter on next inbound message.
            return;
          }
        }
        const prompt = pending!;
        pending = undefined;

        const baseArgs = state.threadId
          ? buildResumeArgs(state.threadId, cwd, mcpServers)
          : buildInitialArgs(cwd, mcpServers);
        const args = [...baseArgs, '--', prompt];

        log(`Spawning: codex ${args.slice(0, baseArgs.length).join(' ')} -- <prompt>`);
        const proc = spawn('codex', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: stripApiKeyEnv(process.env),
          cwd,
        });
        state.current = proc;

        let collectedText = '';
        let turnDone = false;
        let providerErrorMsg: string | undefined;

        for await (const line of lineIterator(proc, () => state.aborted)) {
          if (!line.trim()) continue;

          let evt: CodexEvent;
          try {
            evt = JSON.parse(line) as CodexEvent;
          } catch {
            continue;
          }

          yield { type: 'activity' };

          switch (evt.type) {
            case 'thread.started': {
              if (typeof evt.thread_id === 'string' && evt.thread_id !== state.threadId) {
                state.threadId = evt.thread_id;
                log(`Thread: ${state.threadId}`);
                yield { type: 'init', continuation: state.threadId };
              }
              break;
            }
            case 'item.completed': {
              if (evt.item?.type === 'agent_message' && typeof evt.item.text === 'string') {
                collectedText = evt.item.text;
              }
              break;
            }
            case 'turn.completed': {
              turnDone = true;
              yield { type: 'result', text: collectedText || null, usage: codexUsage(evt) };
              break;
            }
            case 'error':
            case 'turn.error':
            case 'thread.error': {
              providerErrorMsg = evt.message ?? 'Codex error';
              break;
            }
            default:
              break;
          }
        }

        const exitCode: number | null = await new Promise((resolve) => {
          if (proc.exitCode !== null) resolve(proc.exitCode);
          else proc.once('exit', (code) => resolve(code));
        });
        state.current = undefined;

        if (state.aborted) return;

        if (!turnDone) {
          const msg =
            providerErrorMsg ??
            (exitCode !== 0 ? `codex exec exited ${exitCode}` : 'codex exec ended without turn.completed');
          const retryable = exitCode !== 1 && !STALE_SESSION_RE.test(msg);
          yield { type: 'error', message: msg, retryable };
          // After an error we still loop — next push() / next turn may succeed,
          // or the poll-loop will drop the continuation if isSessionInvalid().
        }
      }
    }

    return {
      push: (msg) => {
        if (state.aborted || state.ended) return;
        state.pushQueue.push(memory.decorate(msg));
        state.wake?.();
      },
      end: () => {
        state.ended = true;
        state.wake?.();
      },
      events: runTurns(),
      abort: () => {
        state.aborted = true;
        state.ended = true;
        state.wake?.();
        try {
          state.current?.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      },
    };
  }
}

async function* lineIterator(proc: ChildProcess, isAborted: () => boolean): AsyncGenerator<string> {
  let buffer = '';
  const queue: string[] = [];
  let resolve: (() => void) | null = null;
  let done = false;

  proc.stdout!.setEncoding('utf8');
  proc.stdout!.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) queue.push(line);
    resolve?.();
  });

  proc.stderr!.setEncoding('utf8');
  proc.stderr!.on('data', (chunk: string) => {
    for (const line of chunk.trim().split('\n')) {
      if (line) log(`stderr: ${line}`);
    }
  });

  proc.on('close', () => {
    if (buffer.trim()) queue.push(buffer);
    done = true;
    resolve?.();
  });

  proc.on('error', (err) => {
    log(`process error: ${err.message}`);
    done = true;
    resolve?.();
  });

  while (true) {
    while (queue.length > 0) {
      yield queue.shift()!;
    }
    if (done || isAborted()) return;
    await new Promise<void>((r) => {
      resolve = r;
    });
    resolve = null;
  }
}

registerProvider('codex', (opts) => new CodexProvider(opts));

/** Token usage from a Codex `turn.completed` event. */
export function codexUsage(evt: unknown): TurnUsage | undefined {
  const u = (evt as { usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } }).usage;
  if (!u) return undefined;
  const cached = u.cached_input_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (u.input_tokens ?? 0) - cached),
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}
