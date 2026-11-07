/**
 * Plain-language agent errors.
 *
 * The person in the chat gets a short, human message with what to do.
 * The admin gets the technical detail and the fix, at most once per agent
 * and kind of problem every 30 minutes. Raw stack traces and provider
 * error bodies never reach the chat.
 */
import { log } from './log.js';

export type ErrorKind = 'sign-in' | 'limit' | 'network' | 'too-long' | 'other';

export function classifyAgentError(detail: string): ErrorKind {
  const d = detail.toLowerCase();
  if (
    /\b401\b|authenticat|invalid (x-api-key|api key)|oauth|not logged in|please run .*login|token (has )?(expired|revoked)|unauthori[sz]ed/.test(
      d,
    )
  ) {
    return 'sign-in';
  }
  if (/\b429\b|\b529\b|rate.?limit|usage limit|quota|overloaded|too many requests|credit balance/.test(d))
    return 'limit';
  if (/prompt is too long|context (length|window)|maximum context|too many tokens|max_tokens/.test(d))
    return 'too-long';
  if (/econnrefused|enotfound|etimedout|econnreset|fetch failed|network|socket hang up|getaddrinfo/.test(d))
    return 'network';
  return 'other';
}

const USER_TEXT: Record<ErrorKind, string> = {
  'sign-in': "I can't reach my AI provider right now because of a sign-in problem. I've let the admin know.",
  limit: "I've hit my usage limit for the moment. Please try again in a few minutes.",
  network: "I couldn't connect just now. Please try again in a moment.",
  'too-long':
    'This conversation got too long for me to hold at once. Send /clear to start fresh — I keep what I have learned.',
  other: "Something went wrong on my side and I couldn't finish. I've let the admin know — please try again.",
};

const ADMIN_FIX: Record<ErrorKind, string> = {
  'sign-in':
    'Claude: run `claude setup-token` and update CLAUDE_CODE_OAUTH_TOKEN in ~/.clawbridge/.env. Codex: run `codex login --device-auth`. Then `clawbridge-ai doctor`.',
  limit: 'The provider is rate limiting or the plan limit is reached. Wait, or switch provider with /provider.',
  network: 'Check the host internet connection and Docker networking (and the egress proxy if EGRESS_PROXY=on).',
  'too-long': 'The session context is full. /clear in that chat starts a new session; memory is kept.',
  other: 'See the container log for this session (clawbridge-ai doctor, then logs/).',
};

export function friendlyErrorText(kind: ErrorKind): string {
  return USER_TEXT[kind];
}

const lastAlert = new Map<string, number>();
const ALERT_EVERY_MS = 30 * 60 * 1000;

/** Should we alert the admin about this agent group + kind now? */
export function shouldAlert(agentGroupId: string, kind: ErrorKind, now = Date.now()): boolean {
  const key = `${agentGroupId}:${kind}`;
  const last = lastAlert.get(key) ?? 0;
  if (now - last < ALERT_EVERY_MS) return false;
  lastAlert.set(key, now);
  return true;
}

export function adminAlertText(agentName: string, kind: ErrorKind, detail: string): string {
  return [
    `⚠️ **${agentName} hit an error** (${kind})`,
    '',
    detail.replace(/\s+/g, ' ').slice(0, 500),
    '',
    `Fix: ${ADMIN_FIX[kind]}`,
  ].join('\n');
}

/**
 * Rewrite an outbound payload that carries `agentError`. Returns the payload
 * to deliver and, when due, an admin alert to send.
 */
export function rewriteAgentError(
  content: Record<string, unknown>,
  agentGroupId: string,
  agentName: string,
): { content: Record<string, unknown>; alert: string | null } {
  const detail = String(content.agentError ?? '');
  const kind = classifyAgentError(detail);
  log.warn('Agent error shown to user as a friendly message', { agentGroupId, kind });
  const { agentError: _drop, ...rest } = content;
  void _drop;
  return {
    content: { ...rest, text: friendlyErrorText(kind) },
    alert: shouldAlert(agentGroupId, kind) ? adminAlertText(agentName, kind, detail) : null,
  };
}
