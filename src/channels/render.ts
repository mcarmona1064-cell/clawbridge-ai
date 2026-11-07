/**
 * One renderer for every channel.
 *
 * The agent writes standard Markdown. Adapters turn it into their own
 * dialect with the functions here, split it at the channel's limit without
 * breaking a code block, and render question/approval cards with the
 * shared `ncq:{questionId}:{idx}` choice ids so every click lands in the
 * same response path (authorization, expiry and records included).
 */
import { getAskQuestionRender } from '../db/sessions.js';
import type { OutboundMessage } from './adapter.js';
import { normalizeOptions, type NormalizedOption } from './ask-question.js';
import type { FormatDialect } from './capabilities.js';

// ── Outbound content ──

export type OutboundOp =
  | { op: 'text'; text: string }
  | { op: 'edit'; messageId: string; text: string }
  | { op: 'reaction'; messageId: string; emoji: string }
  | { op: 'question'; questionId: string; title: string; question: string; options: NormalizedOption[] }
  | { op: 'none' };

/** Normalize the agent's outbound payload into one operation. */
export function parseOutbound(message: OutboundMessage): OutboundOp {
  const raw = message.content;
  if (typeof raw === 'string') return raw ? { op: 'text', text: raw } : { op: 'none' };
  const c = (raw ?? {}) as Record<string, unknown>;
  const text = (c.markdown as string) || (c.text as string) || '';
  if (c.operation === 'edit' && c.messageId) return { op: 'edit', messageId: String(c.messageId), text };
  if (c.operation === 'reaction' && c.messageId && c.emoji) {
    return { op: 'reaction', messageId: String(c.messageId), emoji: String(c.emoji).replace(/^:|:$/g, '') };
  }
  if (c.type === 'ask_question' && c.questionId && Array.isArray(c.options) && c.title) {
    return {
      op: 'question',
      questionId: String(c.questionId),
      title: String(c.title),
      question: typeof c.question === 'string' ? c.question : '',
      options: normalizeOptions(c.options as never),
    };
  }
  return text ? { op: 'text', text } : { op: 'none' };
}

// ── Choice ids ──

/** Choice id carried by every button/list row: `ncq:{questionId}:{idx}`. */
export function choiceId(questionId: string, idx: number): string {
  return `ncq:${questionId}:${idx}`;
}

/** Parse a choice id; null if it is not one of ours. */
export function parseChoiceId(id: string): { questionId: string; idx: number } | null {
  const m = /^ncq:(.+):(\d+)$/.exec(id);
  return m ? { questionId: m[1], idx: Number(m[2]) } : null;
}

/** Resolve a clicked option index back to the option's real value. */
export function resolveChoiceValue(questionId: string, idxOrValue: string | number): string {
  const s = String(idxOrValue);
  const render = getAskQuestionRender(questionId);
  if (render && /^\d+$/.test(s)) {
    const opt = render.options[Number(s)];
    if (opt) return opt.value;
  }
  return s;
}

/** Label shown on the card once someone chose, e.g. "✅ Approved". */
export function selectedLabelFor(questionId: string, idx: number): string | null {
  const render = getAskQuestionRender(questionId);
  return render?.options[idx]?.selectedLabel ?? null;
}

/** Truncate a label to the channel's limit, with an ellipsis. */
export function fitLabel(label: string, max: number): string {
  if (max <= 0 || label.length <= max) return label;
  return `${label.slice(0, Math.max(1, max - 1))}…`;
}

/** Plain-text card for channels without buttons: the user replies with a number. */
export function numberedChoicesText(title: string, question: string, options: NormalizedOption[]): string {
  const lines = options.map((o, i) => `${i + 1}. ${o.label}`);
  return [`**${title}**`, question, '', ...lines, '', 'Reply with the number of your choice.']
    .filter((l, i, all) => !(l === '' && all[i - 1] === ''))
    .join('\n')
    .trim();
}

/**
 * Match a free-text reply against a numbered card: "2", "2.", "#2" or the
 * option's label ("approve"). Returns the option index or null.
 */
export function matchNumberedReply(text: string, options: NormalizedOption[]): number | null {
  const t = text.trim();
  const num = /^#?(\d{1,2})\.?$/.exec(t);
  if (num) {
    const idx = Number(num[1]) - 1;
    return idx >= 0 && idx < options.length ? idx : null;
  }
  const lower = t.toLowerCase();
  const byLabel = options.findIndex((o) => o.label.toLowerCase() === lower || o.value.toLowerCase() === lower);
  return byLabel >= 0 ? byLabel : null;
}

// ── Splitting ──

/**
 * Split text into chunks no longer than `limit`, preferring paragraph, line
 * and word breaks. A chunk that cuts through a fenced code block closes the
 * fence and the next chunk reopens it, so no chunk renders broken.
 */
export function splitText(text: string, limit: number): string[] {
  if (limit <= 0 || text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  let reopen = ''; // fence header to prepend to the next chunk
  while (remaining.length > 0) {
    const budget = limit - reopen.length - 4; // room for a closing ``` if needed
    if ((reopen + remaining).length <= limit) {
      chunks.push(reopen + remaining);
      break;
    }
    let cut = remaining.lastIndexOf('\n\n', budget);
    if (cut <= 0) cut = remaining.lastIndexOf('\n', budget);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', budget);
    if (cut <= 0) cut = budget;
    let chunk = reopen + remaining.slice(0, cut).trimEnd();
    remaining = remaining
      .slice(cut)
      .replace(/^\s*\n/, '')
      .trimStart();
    const open = openFence(chunk);
    if (open !== null) {
      chunk += '\n```';
      reopen = `${open}\n`;
    } else {
      reopen = '';
    }
    chunks.push(chunk);
  }
  return chunks.filter((c) => c.trim().length > 0);
}

/** If the text ends inside an open ``` fence, return that fence's header line. */
function openFence(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split('\n')) {
    const m = /^\s*(```[\w+-]*)\s*$/.exec(line);
    if (m) open = open === null ? m[1] : null;
  }
  return open;
}

// ── Markdown → dialects ──

interface Protected {
  text: string;
  restore: (s: string, wrap: (code: string, fenced: boolean, lang: string) => string) => string;
}

/** Pull code spans and fences out so inline rules never touch them. */
function protectCode(md: string): Protected {
  const stash: Array<{ code: string; fenced: boolean; lang: string }> = [];
  let text = md.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    stash.push({ code: code.replace(/\n$/, ''), fenced: true, lang });
    return `\uE000${stash.length - 1}\uE000`;
  });
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    stash.push({ code, fenced: false, lang: '' });
    return `\uE000${stash.length - 1}\uE000`;
  });
  return {
    text,
    restore: (s, wrap) =>
      s.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => {
        const e = stash[Number(i)];
        return wrap(e.code, e.fenced, e.lang);
      }),
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Markdown → Telegram Bot API HTML (parse_mode: 'HTML'). */
export function toTelegramHtml(md: string): string {
  const p = protectCode(md);
  let s = escapeHtml(p.text);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t: string, u: string) => {
    return `<a href="${u.replace(/"/g, '&quot;')}">${t}</a>`;
  });
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<b>$1</b>');
  s = s.replace(/__(?=\S)([\s\S]*?\S)__/g, '<b>$1</b>');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<s>$1</s>');
  s = s.replace(/^\s*[-*+]\s+/gm, '• ');
  s = s.replace(/(?:^&gt; ?.*(?:\n|$))+/gm, (block) => {
    const inner = block
      .replace(/\n$/, '')
      .split('\n')
      .map((l) => l.replace(/^&gt; ?/, ''))
      .join('\n');
    return `<blockquote>${inner}</blockquote>${block.endsWith('\n') ? '\n' : ''}`;
  });
  return p.restore(s, (code, fenced, lang) =>
    fenced
      ? `<pre><code${lang ? ` class="language-${lang}"` : ''}>${escapeHtml(code)}</code></pre>`
      : `<code>${escapeHtml(code)}</code>`,
  );
}

/** Markdown → WhatsApp formatting (*bold*, _italic_, ~strike~, ```mono```). */
export function toWhatsApp(md: string): string {
  const p = protectCode(md);
  let s = p.text;
  const BOLD = '\uE001';
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t: string, u: string) => (t === u ? u : `${t} (${u})`));
  s = s.replace(/^#{1,6}\s+(.+)$/gm, `${BOLD}$1${BOLD}`);
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, `${BOLD}$1${BOLD}`);
  s = s.replace(/__(?=\S)([\s\S]*?\S)__/g, `${BOLD}$1${BOLD}`);
  s = s.replace(/^(\s*)[-*+]\s+/gm, '$1• ');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1_$2_');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '~$1~');
  s = s.split(BOLD).join('*');
  return p.restore(s, (code, fenced) => (fenced ? `\`\`\`${code}\`\`\`` : `\`${code}\``));
}

/** Markdown → Discord (CommonMark plus headings; no tables, so leave them as text). */
export function toDiscord(md: string): string {
  return md;
}

/** Markdown → plain text for channels with no formatting at all. */
export function toPlain(md: string): string {
  const p = protectCode(md);
  let s = p.text;
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t: string, u: string) => (t === u ? u : `${t} (${u})`));
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/\*\*([\s\S]*?)\*\*/g, '$1').replace(/__([\s\S]*?)__/g, '$1');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2');
  s = s.replace(/~~([\s\S]*?)~~/g, '$1');
  s = s.replace(/^\s*[-*+]\s+/gm, '• ');
  return p.restore(s, (code) => code);
}

/** Render Markdown for a dialect. */
export function renderMarkdown(md: string, dialect: FormatDialect): string {
  switch (dialect) {
    case 'telegram-html':
      return toTelegramHtml(md);
    case 'whatsapp':
      return toWhatsApp(md);
    case 'discord':
      return toDiscord(md);
    case 'plain':
      return toPlain(md);
    default:
      return md; // 'markdown' and 'slack' (markdown blocks take CommonMark)
  }
}

/**
 * Split Markdown at `limit` (measured after rendering) and render each
 * chunk, keeping the source Markdown alongside so a caller can fall back to
 * plain text for one chunk. Rendering can lengthen text (HTML escapes), so
 * chunks that come out too long are split again with a smaller budget.
 */
export function renderChunkPairs(
  md: string,
  dialect: FormatDialect,
  limit: number,
): Array<{ md: string; out: string }> {
  let budget = limit;
  for (let attempt = 0; attempt < 4; attempt++) {
    const pairs = splitText(md, budget).map((c) => ({ md: c, out: renderMarkdown(c, dialect) }));
    if (pairs.every((p) => p.out.length <= limit)) return pairs;
    budget = Math.floor(budget * 0.8);
  }
  return splitText(md, Math.floor(limit / 2)).map((c) => ({ md: c, out: renderMarkdown(c, dialect).slice(0, limit) }));
}

export function renderChunks(md: string, dialect: FormatDialect, limit: number): string[] {
  return renderChunkPairs(md, dialect, limit).map((p) => p.out);
}

// ── Dedupe ──

/** Bounded set of recently seen keys, for de-duplicating platform retries. */
export class SeenSet {
  private readonly keys = new Set<string>();
  constructor(private readonly cap = 2_000) {}
  /** Returns true if the key was already seen; records it otherwise. */
  checkAndAdd(key: string): boolean {
    if (this.keys.has(key)) return true;
    this.keys.add(key);
    if (this.keys.size > this.cap) {
      const oldest = this.keys.values().next().value;
      if (oldest !== undefined) this.keys.delete(oldest);
    }
    return false;
  }
}

// ── Emoji ──

const EMOJI: Record<string, string> = {
  eyes: '👀',
  white_check_mark: '✅',
  heavy_check_mark: '✔️',
  x: '❌',
  warning: '⚠️',
  thumbsup: '👍',
  '+1': '👍',
  thumbsdown: '👎',
  '-1': '👎',
  ok_hand: '👌',
  fire: '🔥',
  tada: '🎉',
  heart: '❤️',
  pray: '🙏',
  thinking_face: '🤔',
  hourglass: '⏳',
  hourglass_flowing_sand: '⏳',
  zap: '⚡',
  writing_hand: '✍️',
  memo: '📝',
  rocket: '🚀',
  '100': '💯',
};

/** Unicode emoji for a Slack-style name (`eyes`, `:tada:`), or the input if it already is one. */
export function emojiFor(nameOrEmoji: string): string | null {
  const name = nameOrEmoji.replace(/^:|:$/g, '');
  if (EMOJI[name]) return EMOJI[name];
  return /\p{Extended_Pictographic}/u.test(name) ? name : null;
}
