/**
 * The host-side channel layer between delivery and each adapter.
 *
 * Adapters render what they natively support. This layer covers the gaps
 * using the channel's capabilities, so no feature is silently broken on a
 * channel that lacks it:
 *
 *   - Question/approval cards with more options than the channel's buttons
 *     or lists hold (or channels with neither) become a numbered list. The
 *     user's reply ("2") is intercepted before it reaches the agent and
 *     answered through the same response path as a button click, so
 *     authorization, expiry and records apply unchanged.
 *   - Edits on channels that can't edit are sent as a new message.
 *   - Reactions on channels without reactions are dropped (they are only
 *     acknowledgements).
 */
import { getDb, hasTable } from '../db/connection.js';
import { getAskQuestionRender } from '../db/sessions.js';
import { log } from '../log.js';
import type { ChannelAdapter, OutboundMessage } from './adapter.js';
import { cardTtlMs } from './ask-question.js';
import { capabilitiesFor, planChoices, type ChannelCapabilities } from './capabilities.js';
import { matchNumberedReply, numberedChoicesText, parseOutbound } from './render.js';

export function adapterCapabilities(
  adapter: Pick<ChannelAdapter, 'channelType' | 'capabilities'>,
): ChannelCapabilities {
  return capabilitiesFor(adapter.channelType, adapter.capabilities);
}

// ── Numbered prompts ──

function numberedTableReady(): boolean {
  return hasTable(getDb(), 'numbered_prompts');
}

export function recordNumberedPrompt(
  questionId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
): void {
  if (!numberedTableReady()) return;
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO numbered_prompts (question_id, channel_type, platform_id, thread_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(questionId, channelType, platformId, threadId, new Date().toISOString());
}

function latestNumberedPrompt(
  channelType: string,
  platformId: string,
  threadId: string | null,
): { question_id: string; created_at: string } | undefined {
  if (!numberedTableReady()) return undefined;
  return getDb()
    .prepare(
      `SELECT question_id, created_at FROM numbered_prompts
       WHERE channel_type = ? AND platform_id = ? AND (thread_id IS ? OR ? IS NULL)
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(channelType, platformId, threadId, threadId) as { question_id: string; created_at: string } | undefined;
}

export function clearNumberedPrompt(questionId: string): void {
  if (!numberedTableReady()) return;
  getDb().prepare('DELETE FROM numbered_prompts WHERE question_id = ?').run(questionId);
}

/** Answer handed to the response dispatcher (same shape as a button click). */
export interface NumberedAnswer {
  questionId: string;
  value: string;
}

/**
 * If `text` answers the latest open numbered card in this chat, return the
 * answer and close the prompt. Anything else (a normal message, a stale or
 * already-answered card) returns null and flows to the agent as usual.
 */
export function interceptNumberedReply(
  channelType: string,
  platformId: string,
  threadId: string | null,
  text: string,
): NumberedAnswer | null {
  if (!text || text.length > 40) return null;
  const prompt = latestNumberedPrompt(channelType, platformId, threadId);
  if (!prompt) return null;
  if (Date.parse(prompt.created_at) + cardTtlMs() <= Date.now()) {
    clearNumberedPrompt(prompt.question_id);
    return null;
  }
  const render = getAskQuestionRender(prompt.question_id);
  if (!render) {
    clearNumberedPrompt(prompt.question_id); // card already answered elsewhere
    return null;
  }
  const idx = matchNumberedReply(text, render.options);
  if (idx === null) return null;
  clearNumberedPrompt(prompt.question_id);
  return { questionId: prompt.question_id, value: render.options[idx].value };
}

// ── Outbound shaping ──

/**
 * Adapt one outbound message to the channel. Returns the message to hand to
 * the adapter, or null when there is nothing to send.
 */
export function prepareOutbound(
  adapter: Pick<ChannelAdapter, 'channelType' | 'capabilities'>,
  platformId: string,
  threadId: string | null,
  message: OutboundMessage,
): OutboundMessage | null {
  const caps = adapterCapabilities(adapter);
  const op = parseOutbound(message);

  if (op.op === 'question' && planChoices(caps, op.options.length) === 'numbered') {
    recordNumberedPrompt(op.questionId, adapter.channelType, platformId, threadId);
    return { ...message, content: { text: numberedChoicesText(op.title, op.question, op.options) } };
  }

  if (op.op === 'edit' && !caps.edit) {
    return op.text ? { ...message, content: { text: op.text } } : null;
  }

  if (op.op === 'reaction' && !caps.reactions) {
    log.debug('Reaction dropped — channel has no reactions', { channelType: adapter.channelType });
    return null;
  }

  return message;
}
