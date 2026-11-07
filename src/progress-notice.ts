/**
 * One short progress note on long jobs.
 *
 * If the agent has been working for 90 seconds without posting anything,
 * the chat gets a single "still working" message, so nobody wonders
 * whether it stalled. Slack shows its own status line and stop button, so
 * it is skipped there. Any reply cancels the note. PROGRESS_NOTICE=off
 * turns it off.
 */
import { getDeliveryAdapter } from './delivery.js';
import { log } from './log.js';

export const PROGRESS_AFTER_MS = 90_000;
const SKIP_CHANNELS = new Set(['slack', 'agent', 'cli']);

const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function startProgressWatch(
  sessionId: string,
  channelType: string | null,
  platformId: string | null,
  threadId: string | null,
  afterMs = PROGRESS_AFTER_MS,
): void {
  if (process.env.PROGRESS_NOTICE === 'off' || !channelType || !platformId || SKIP_CHANNELS.has(channelType)) return;
  if (timers.has(sessionId)) return; // already watching this turn
  const t = setTimeout(() => {
    timers.delete(sessionId);
    const adapter = getDeliveryAdapter();
    if (!adapter) return;
    void adapter
      .deliver(
        channelType,
        platformId,
        threadId,
        'chat',
        JSON.stringify({ text: "Still working on this — I'll post the answer here. (Send !stop to cancel.)" }),
      )
      .catch((err) => log.debug('Progress note failed', { err }));
  }, afterMs);
  t.unref?.();
  timers.set(sessionId, t);
}

/** A reply went out (or the turn ended): no progress note needed. */
export function clearProgressWatch(sessionId: string): void {
  const t = timers.get(sessionId);
  if (t) clearTimeout(t);
  timers.delete(sessionId);
}
