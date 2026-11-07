/**
 * Host-side host_exec watcher.
 *
 * Pairs with container/agent-runner/src/mcp-tools/host-exec.ts. The container
 * tool drops a JSON request file under `<sessionDir>/exec/requests/`; this
 * module scans active sessions, runs the command via child_process.exec, and
 * writes the result back to `<sessionDir>/exec/responses/<id>.json`.
 *
 * Gating happens here too (defense in depth — the container tool also gates):
 * a session's agent group must have `allowHostExec: true` in container.json.
 * Anything else gets a permission-denied response and the request is removed.
 *
 * Approve by default: a command runs without approval only when it is a
 * single, simple, read-only command on the allowlist below, with no shell
 * operators and no path into a secrets location. Everything else (including
 * interpreters like `python -c …`, pipes, redirects and `cat ~/.clawbridge/.env`)
 * waits for an admin's approval. The requested cwd must be an existing
 * absolute directory outside secrets locations.
 */
import { exec } from 'child_process';
import fs from 'fs';
import { homedir } from 'os';
import path from 'path';

import { readContainerConfig } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getActiveSessions } from '../../db/sessions.js';
import { log } from '../../log.js';
import { sessionDir } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { requestApproval, registerApprovalHandler, registerApprovalRejectionHandler } from '../approvals/index.js';
import { audit } from '../../audit.js';
import { policyDecision } from '../../policies.js';

const POLL_INTERVAL_MS = 250;

interface ExecRequest {
  id: string;
  command: string;
  timeout: number;
  cwd?: string;
}

interface ExecResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

interface HostExecApprovalPayload {
  requestId: string;
  command: string;
  timeout: number;
  cwd?: string;
  responsePath: string;
}

/** Programs that may run without approval when used read-only. */
const AUTO_APPROVED_PROGRAMS = new Set([
  'pwd',
  'ls',
  'date',
  'whoami',
  'id',
  'hostname',
  'uname',
  'uptime',
  'df',
  'du',
  'which',
  'echo',
  'wc',
]);

/** Read-only git subcommands that may run without approval. */
const AUTO_APPROVED_GIT_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'remote']);

/** Shell syntax that chains, substitutes, redirects or backgrounds commands. */
const SHELL_OPERATORS = /[;&|`<>\n\r]|\$\(|\$\{/;

/** Paths an agent must never touch without a human looking first. */
const SECRET_PATH_PATTERNS: RegExp[] = [
  /(^|[\s/=~])\.clawbridge(\/|\s|$)/,
  /(^|[\s/=])\.env(\.|\s|$)/,
  /(^|[\s/=~])\.ssh(\/|\s|$)/,
  /(^|[\s/=~])\.codex(\/|\s|$)/,
  /(^|[\s/=~])\.claude(\/|\s|$)/,
  /(^|[\s/=~])\.aws(\/|\s|$)/,
  /(^|[\s/=~])\.config\/clawbridge(\/|\s|$)/,
  /\bid_(?:rsa|ed25519|ecdsa)\b/,
];

export function touchesSecretPath(text: string): boolean {
  return SECRET_PATH_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * True unless the command is a single, simple, read-only command on the
 * allowlist. Approval is the default; this is the only way to skip it.
 */
export function needsHostExecApproval(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || SHELL_OPERATORS.test(trimmed) || touchesSecretPath(trimmed)) return true;
  const [program, sub, ...rest] = trimmed.split(/\s+/);
  if (program === 'git') {
    if (!sub || !AUTO_APPROVED_GIT_SUBCOMMANDS.has(sub)) return true;
    // `git branch -D x`, `git remote add …` etc. change state.
    if (sub === 'branch' && rest.some((a) => /^-[a-zA-Z]*[dDmMcC]/.test(a) || !a.startsWith('-'))) return true;
    if (sub === 'remote' && rest.some((a) => !a.startsWith('-'))) return true;
    return false;
  }
  return !AUTO_APPROVED_PROGRAMS.has(program);
}

/** Programs that are never auto-allowed, whatever a saved rule says. */
const NEVER_AUTO_ALLOW = new Set([
  'rm',
  'rmdir',
  'mv',
  'dd',
  'mkfs',
  'sudo',
  'su',
  'doas',
  'kill',
  'pkill',
  'killall',
  'shutdown',
  'reboot',
  'launchctl',
  'systemctl',
  'service',
  'chmod',
  'chown',
  'curl',
  'wget',
  'ssh',
  'scp',
  'rsync',
  'nc',
  'ncat',
  'eval',
  'exec',
  'sh',
  'bash',
  'zsh',
  'python',
  'python3',
  'node',
  'osascript',
  'security',
  'crontab',
]);
const NEVER_AUTO_ALLOW_GIT = new Set([
  'push',
  'reset',
  'clean',
  'rebase',
  'checkout',
  'restore',
  'rm',
  'filter-branch',
  'gc',
]);

/**
 * The rule scope an admin may "always allow" for this command (its first
 * two words, e.g. "npm test"), or null when the command must always ask:
 * chained or redirected shell, secret paths, or a risky program.
 */
export function alwaysAllowScope(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed || SHELL_OPERATORS.test(trimmed) || touchesSecretPath(trimmed)) return null;
  const [program, sub] = trimmed.split(/\s+/);
  if (NEVER_AUTO_ALLOW.has(program)) return null;
  if (program === 'git' && (!sub || NEVER_AUTO_ALLOW_GIT.has(sub))) return null;
  if (/^-/.test(sub ?? '')) return program;
  return sub ? `${program} ${sub}` : program;
}

export function hostExecRisk(command: string): 'medium' | 'high' {
  return alwaysAllowScope(command) === null ? 'high' : 'medium';
}

/** @deprecated use needsHostExecApproval — kept for callers of the old name. */
export const isDangerousHostExecCommand = needsHostExecApproval;

/** Validate the requested working directory. Returns an error string, or null if usable. */
export function invalidHostExecCwd(cwd: string | undefined): string | null {
  if (cwd === undefined || cwd === '') return null;
  if (!path.isAbsolute(cwd)) return `cwd must be an absolute path (got "${cwd}")`;
  if (touchesSecretPath(cwd)) return 'cwd points into a secrets location';
  try {
    if (!fs.statSync(cwd).isDirectory()) return `cwd is not a directory: ${cwd}`;
  } catch {
    return `cwd does not exist: ${cwd}`;
  }
  return null;
}

function deniedResponse(error: string): ExecResponse {
  return { exitCode: 126, stdout: '', stderr: '', error };
}

const inflight = new Set<string>();

function writeAtomic(filepath: string, data: string): void {
  const tmp = `${filepath}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filepath);
}

function runCommand(req: ExecRequest): Promise<ExecResponse> {
  return new Promise((resolve) => {
    const cwd = req.cwd || homedir();
    exec(
      req.command,
      { cwd, timeout: req.timeout, maxBuffer: 10 * 1024 * 1024, shell: '/bin/bash' },
      (error, stdout, stderr) => {
        if (error) {
          // ChildProcess errors carry exit code on `code` and signal on `signal`.
          const e = error as unknown as NodeJS.ErrnoException & { code?: number | string; signal?: string };
          const exitCode = typeof e.code === 'number' ? e.code : 1;
          resolve({
            exitCode,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            error: e.signal ? `${error.message} (signal: ${e.signal})` : error.message,
          });
          return;
        }
        resolve({ exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

function payloadString(payload: Record<string, unknown>, key: keyof HostExecApprovalPayload): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function payloadNumber(payload: Record<string, unknown>, key: keyof HostExecApprovalPayload): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseApprovalPayload(payload: Record<string, unknown>): HostExecApprovalPayload {
  const requestId = payloadString(payload, 'requestId');
  const command = payloadString(payload, 'command');
  const responsePath = payloadString(payload, 'responsePath');
  const timeout = payloadNumber(payload, 'timeout');
  const cwd = payloadString(payload, 'cwd');
  if (!requestId || !command || !responsePath || !timeout) {
    throw new Error('host_exec approval payload is missing requestId, command, timeout, or responsePath');
  }
  return { requestId, command, responsePath, timeout, cwd };
}

async function writeHostExecApprovalResult(
  payload: Record<string, unknown>,
  response: ExecResponse,
): Promise<HostExecApprovalPayload> {
  const parsed = parseApprovalPayload(payload);
  fs.mkdirSync(path.dirname(parsed.responsePath), { recursive: true });
  writeAtomic(parsed.responsePath, JSON.stringify(response));
  return parsed;
}

export async function applyApprovedHostExec({
  payload,
  notify,
}: {
  payload: Record<string, unknown>;
  notify: (text: string) => void;
}): Promise<void> {
  const parsed = parseApprovalPayload(payload);
  log.info('host_exec: approved command running', {
    reqId: parsed.requestId,
    command: parsed.command,
    cwd: parsed.cwd,
  });
  const response = await runCommand({
    id: parsed.requestId,
    command: parsed.command,
    timeout: parsed.timeout,
    cwd: parsed.cwd,
  });
  audit('host_exec.run', {
    target: parsed.requestId,
    detail: { command: parsed.command, cwd: parsed.cwd, approved: true, exitCode: response.exitCode },
  });
  await writeHostExecApprovalResult(payload, response);
  notify(`host_exec command approved and executed: ${parsed.command}`);
  log.info('host_exec: approved command completed', { reqId: parsed.requestId, exitCode: response.exitCode });
}

export async function rejectHostExec({
  payload,
  notify,
}: {
  payload: Record<string, unknown>;
  notify: (text: string) => void;
}): Promise<void> {
  const parsed = await writeHostExecApprovalResult(
    payload,
    deniedResponse('host_exec command was rejected by admin approval.'),
  );
  notify(`host_exec command rejected: ${parsed.command}`);
  audit('host_exec.denied', { target: parsed.requestId, detail: { command: parsed.command, reason: 'rejected' } });
}

async function requestHostExecApproval(session: Session, req: ExecRequest, resPath: string): Promise<boolean> {
  return requestApproval({
    session,
    agentName: session.agent_group_id,
    action: 'host_exec',
    payload: {
      requestId: req.id,
      command: req.command,
      timeout: req.timeout,
      cwd: req.cwd,
      responsePath: resPath,
    },
    title: 'Approve host terminal command?',
    risk: hostExecRisk(req.command),
    ...(alwaysAllowScope(req.command)
      ? {
          alwaysAllow: {
            scope: alwaysAllowScope(req.command)!,
            label: `Always allow \`${alwaysAllowScope(req.command)}\``.slice(0, 60),
          },
        }
      : {}),
    question: [
      'A container agent wants to run this command on the HOST machine (outside its container).',
      'Only approve it if you understand exactly what it does.',
      '',
      `Agent group: ${session.agent_group_id}`,
      `Session: ${session.id}`,
      `Working directory: ${req.cwd || homedir()}`,
      `Timeout: ${req.timeout}ms`,
      '',
      'Command:',
      '```',
      req.command,
      '```',
    ].join('\n'),
  });
}

async function processRequest(
  session: Session,
  reqDir: string,
  resDir: string,
  filename: string,
  allowed: boolean,
): Promise<void> {
  const reqPath = path.join(reqDir, filename);
  const inflightKey = reqPath;
  if (inflight.has(inflightKey)) return;
  inflight.add(inflightKey);

  try {
    let req: ExecRequest;
    try {
      req = JSON.parse(fs.readFileSync(reqPath, 'utf-8')) as ExecRequest;
    } catch (err) {
      // Partially-written or malformed file — leave it; either the writer's
      // atomic rename will land on the next tick, or we'll surface it as an
      // error if it stays unparseable.
      log.debug('host_exec: request not yet parseable', { reqPath, err: (err as Error).message });
      return;
    }

    if (!req.id || !req.command) {
      log.warn('host_exec: invalid request, removing', { reqPath });
      try {
        fs.unlinkSync(reqPath);
      } catch {
        /* ignore */
      }
      return;
    }

    const resPath = path.join(resDir, `${req.id}.json`);
    fs.mkdirSync(resDir, { recursive: true });

    // Unlink the request file BEFORE executing. Otherwise, any command that
    // terminates this host process (e.g. `launchctl kickstart -k` on its own
    // service, `launchctl bootout` of the current service, `kill -- -$$`)
    // can trap us in a restart loop: launchd reboots us, we find the same
    // file, run it again, get killed again, forever — burning model credits
    // API tokens each cycle as the container agent fires on every reboot.
    // Trade-off: if the host crashes between unlink and writing the
    // response, the agent gets no reply for that one command. We accept
    // losing a single command over an infinite replay loop. See incident
    // 2026-05-13 (kickstart -k self-restart trap).
    try {
      fs.unlinkSync(reqPath);
    } catch {
      /* race: another sweep or the writer cleaned it up — fine */
    }

    let response: ExecResponse;
    if (!allowed) {
      response = deniedResponse(
        'host_exec is not enabled for this agent group (allowHostExec is false in container.json).',
      );
      log.warn('host_exec: rejected — allowHostExec is false', { reqId: req.id });
      audit('host_exec.denied', {
        target: req.id,
        agentGroupId: session.agent_group_id,
        detail: { command: req.command, reason: 'not_enabled' },
      });
      writeAtomic(resPath, JSON.stringify(response));
      return;
    }

    const cwdError = invalidHostExecCwd(req.cwd);
    if (cwdError) {
      log.warn('host_exec: rejected — bad cwd', { reqId: req.id, cwd: req.cwd, cwdError });
      writeAtomic(resPath, JSON.stringify(deniedResponse(`host_exec rejected: ${cwdError}.`)));
      return;
    }

    const rule = policyDecision(session.agent_group_id, 'host_exec', req.command);
    if (rule === 'deny') {
      log.warn('host_exec: rejected by a deny rule', { reqId: req.id });
      audit('host_exec.denied', {
        target: req.id,
        agentGroupId: session.agent_group_id,
        detail: { command: req.command, reason: 'deny_rule' },
      });
      writeAtomic(resPath, JSON.stringify(deniedResponse('host_exec is turned off for this agent (/permissions).')));
      return;
    }
    const allowedByRule = rule === 'allow' && alwaysAllowScope(req.command) !== null;

    if (!allowedByRule && needsHostExecApproval(req.command)) {
      log.info('host_exec: approval requested', {
        reqId: req.id,
        command: req.command,
        cwd: req.cwd,
        timeout: req.timeout,
      });
      const requested = await requestHostExecApproval(session, req, resPath);
      if (!requested) {
        response = deniedResponse('host_exec command required approval, but no approver channel was available.');
        writeAtomic(resPath, JSON.stringify(response));
      }
      return;
    }

    log.info('host_exec: running', { reqId: req.id, command: req.command, cwd: req.cwd, timeout: req.timeout });
    response = await runCommand(req);
    log.info('host_exec: completed', { reqId: req.id, exitCode: response.exitCode });
    audit('host_exec.run', {
      target: req.id,
      agentGroupId: session.agent_group_id,
      detail: {
        command: req.command,
        cwd: req.cwd ?? null,
        approved: allowedByRule ? 'rule' : false,
        exitCode: response.exitCode,
      },
    });
    writeAtomic(resPath, JSON.stringify(response));
  } finally {
    inflight.delete(inflightKey);
  }
}

let polling = false;

export async function pollOnce(): Promise<void> {
  const sessions = getActiveSessions();
  for (const session of sessions) {
    const dir = sessionDir(session.agent_group_id, session.id);
    const reqDir = path.join(dir, 'exec', 'requests');
    if (!fs.existsSync(reqDir)) continue;

    let files: string[];
    try {
      files = fs.readdirSync(reqDir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    const resDir = path.join(dir, 'exec', 'responses');
    const group = getAgentGroup(session.agent_group_id);
    const allowed = group ? readContainerConfig(group.folder).allowHostExec === true : false;

    for (const f of files) {
      // Fire-and-forget so a single slow command doesn't block other sessions.
      void processRequest(session, reqDir, resDir, f, allowed);
    }
  }
}

async function loop(): Promise<void> {
  while (polling) {
    try {
      await pollOnce();
    } catch (err) {
      log.error('host_exec poll error', { err: (err as Error).message });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

export function startHostExecWatcher(): void {
  if (polling) return;
  polling = true;
  void loop();
  log.info('host_exec watcher started');
}

export function stopHostExecWatcher(): void {
  polling = false;
}

registerApprovalHandler('host_exec', applyApprovedHostExec);
registerApprovalRejectionHandler('host_exec', rejectHostExec);
