/**
 * Claim-receipt gate.
 *
 * Before a reply goes out, check whether it claims an action the host can
 * verify ("I've scheduled…", "I saved that to team memory", "I posted it in
 * #sales") and whether a matching action was actually recorded for this
 * session in the last few minutes. If not, the reply is sent with a short,
 * honest note instead of a false claim, and the mismatch is audited.
 *
 * Only actions that pass through the host can be checked here. Work done
 * entirely inside the agent's sandbox (reading files, browsing) is not
 * claimed-checked.
 */
import { audit } from './audit.js';

export type ClaimKind = 'schedule' | 'team_memory' | 'cross_post';

const WINDOW_MS = 10 * 60 * 1000;

/** What each kind of claim needs to have happened. */
const RECEIPTS: Record<ClaimKind, string[]> = {
  schedule: ['schedule_task', 'update_task'],
  team_memory: ['propose_team_memory'],
  cross_post: ['cross_post'],
};

const CLAIMS: Array<{ kind: ClaimKind; re: RegExp }> = [
  {
    kind: 'schedule',
    re: /\b(i(?:'ve| have)? (?:just )?(?:scheduled|set up (?:a |the )?(?:reminder|schedule|job)|set (?:a |the )?reminder)|i(?:'ll| will) remind you)\b/i,
  },
  {
    kind: 'team_memory',
    re: /\bi(?:'ve| have)? (?:saved|added|stored|recorded) (?:it|this|that|these)? ?(?:to|in|into) (?:the )?(?:team|shared|team's) memory\b/i,
  },
  {
    kind: 'cross_post',
    re: /\bi(?:'ve| have)? (?:just )?(?:posted|sent|shared|forwarded) (?:it|this|that|the \w+|a message)? ?(?:to|in|into) (?:#[\w-]+|the [\w-]+ (?:channel|group|chat))/i,
  },
];

const NOTES: Record<ClaimKind, string> = {
  schedule:
    "⚠️ Correction: I haven't actually scheduled this yet — no scheduled job was created. Ask me again and I'll set it up.",
  team_memory:
    "⚠️ Correction: nothing was saved to team memory yet. Team facts need an admin's approval; I can propose it if you'd like.",
  cross_post: "⚠️ Correction: I haven't actually posted it to another chat — no message was sent there.",
};

const recent = new Map<string, Array<{ action: string; at: number }>>();

/** Record a host-mediated action a session performed (called from delivery). */
export function recordSessionAction(sessionId: string, action: string, now = Date.now()): void {
  const list = (recent.get(sessionId) ?? []).filter((a) => now - a.at < WINDOW_MS);
  list.push({ action, at: now });
  recent.set(sessionId, list);
}

/** Undo the most recent record of `action` (the host refused it after all). */
export function retractSessionAction(sessionId: string, action: string): void {
  const list = recent.get(sessionId);
  if (!list) return;
  const idx = list.map((a) => a.action).lastIndexOf(action);
  if (idx >= 0) list.splice(idx, 1);
}

/** Claims in `text` (outside code) that have no matching recorded action. */
export function unverifiedClaims(sessionId: string, text: string, now = Date.now()): ClaimKind[] {
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const actions = (recent.get(sessionId) ?? []).filter((a) => now - a.at < WINDOW_MS).map((a) => a.action);
  const out: ClaimKind[] = [];
  for (const { kind, re } of CLAIMS) {
    if (!re.test(prose)) continue;
    if (RECEIPTS[kind].some((r) => actions.includes(r))) continue;
    out.push(kind);
  }
  return out;
}

/**
 * Return the reply text to send: unchanged when every claim has a receipt,
 * otherwise with a correction note appended.
 */
export function gateClaims(
  sessionId: string,
  agentGroupId: string,
  text: string,
  now = Date.now(),
): { text: string; flagged: ClaimKind[] } {
  const flagged = unverifiedClaims(sessionId, text, now);
  if (flagged.length === 0) return { text, flagged };
  audit('claim.unverified', { target: sessionId, agentGroupId, detail: { kinds: flagged } });
  return { text: `${text}\n\n${flagged.map((k) => NOTES[k]).join('\n')}`, flagged };
}

/** For tests. */
export function resetClaimGate(): void {
  recent.clear();
}
