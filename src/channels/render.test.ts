import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/sessions.js', () => ({
  getAskQuestionRender: (id: string) =>
    id === 'q1'
      ? {
          title: 't',
          options: [
            { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
            { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
          ],
        }
      : undefined,
}));

import { capabilitiesFor, planChoices } from './capabilities.js';
import {
  choiceId,
  matchNumberedReply,
  numberedChoicesText,
  parseChoiceId,
  parseOutbound,
  renderChunks,
  resolveChoiceValue,
  splitText,
  toPlain,
  toTelegramHtml,
  toWhatsApp,
} from './render.js';

const opts = [
  { label: 'Approve', selectedLabel: 'Approve', value: 'approve' },
  { label: 'Reject', selectedLabel: 'Reject', value: 'reject' },
];

describe('capabilities', () => {
  it('chooses buttons, then lists, then numbered replies by what the channel supports', () => {
    expect(planChoices(capabilitiesFor('slack'), 2)).toBe('buttons');
    expect(planChoices(capabilitiesFor('whatsapp'), 3)).toBe('buttons');
    expect(planChoices(capabilitiesFor('whatsapp'), 7)).toBe('list');
    expect(planChoices(capabilitiesFor('whatsapp'), 12)).toBe('numbered');
    expect(planChoices(capabilitiesFor('imessage'), 2)).toBe('numbered');
  });

  it('merges adapter-declared capabilities over the defaults', () => {
    const caps = capabilitiesFor('telegram', { edit: false, choices: { buttons: 2 } as never });
    expect(caps.edit).toBe(false);
    expect(caps.choices.buttons).toBe(2);
    expect(caps.choices.labelMax).toBe(64);
  });
});

describe('outbound parsing', () => {
  it('recognises text, edits, reactions and question cards', () => {
    expect(parseOutbound({ kind: 'chat', content: { text: 'hi' } })).toEqual({ op: 'text', text: 'hi' });
    expect(parseOutbound({ kind: 'chat', content: { operation: 'edit', messageId: 5, text: 'v2' } })).toEqual({
      op: 'edit',
      messageId: '5',
      text: 'v2',
    });
    expect(
      parseOutbound({ kind: 'chat', content: { operation: 'reaction', messageId: '5', emoji: ':eyes:' } }),
    ).toEqual({ op: 'reaction', messageId: '5', emoji: 'eyes' });
    const q = parseOutbound({
      kind: 'chat-sdk',
      content: { type: 'ask_question', questionId: 'q1', title: 'T', question: 'Q?', options: ['A', 'B'] },
    });
    expect(q).toMatchObject({ op: 'question', questionId: 'q1', title: 'T' });
    expect(parseOutbound({ kind: 'chat', content: {} })).toEqual({ op: 'none' });
  });
});

describe('choice ids', () => {
  it('round-trips and resolves the option value', () => {
    expect(parseChoiceId(choiceId('msg-1-abc', 1))).toEqual({ questionId: 'msg-1-abc', idx: 1 });
    expect(parseChoiceId('other')).toBeNull();
    expect(resolveChoiceValue('q1', 0)).toBe('approve');
    expect(resolveChoiceValue('unknown', '3')).toBe('3');
  });

  it('matches numbered and label replies', () => {
    expect(matchNumberedReply('2', opts)).toBe(1);
    expect(matchNumberedReply(' #1. ', opts)).toBe(0);
    expect(matchNumberedReply('approve', opts)).toBe(0);
    expect(matchNumberedReply('3', opts)).toBeNull();
    expect(matchNumberedReply('approve it please', opts)).toBeNull();
    expect(numberedChoicesText('Save?', 'Payroll is on the 25th.', opts)).toContain('1. Approve\n2. Reject');
  });
});

describe('splitting', () => {
  it('prefers paragraph breaks and respects the limit', () => {
    const chunks = splitText(`${'a'.repeat(60)}\n\n${'b'.repeat(60)}`, 80);
    expect(chunks).toEqual(['a'.repeat(60), 'b'.repeat(60)]);
  });

  it('closes and reopens a code fence cut between chunks', () => {
    const code = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const chunks = splitText(`intro\n\n\`\`\`ts\n${code}\n\`\`\``, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(120);
      expect((c.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(chunks[1].startsWith('```ts')).toBe(true);
  });

  it('keeps rendered chunks within the limit even when escaping grows them', () => {
    const md = '<b>&</b> '.repeat(800);
    const chunks = renderChunks(md, 'telegram-html', 4096);
    expect(chunks.every((c) => c.length <= 4096)).toBe(true);
    expect(chunks.join('')).toContain('&lt;b&gt;&amp;');
  });
});

describe('dialects', () => {
  const md = '# Plan\n**Bold** and *it* and ~~old~~ with `x<y` and [docs](https://ex.com/a?b=1)\n- one\n> quote';

  it('renders Telegram HTML and escapes everything else', () => {
    const html = toTelegramHtml(md);
    expect(html).toContain('<b>Plan</b>');
    expect(html).toContain('<b>Bold</b> and <i>it</i> and <s>old</s>');
    expect(html).toContain('<code>x&lt;y</code>');
    expect(html).toContain('<a href="https://ex.com/a?b=1">docs</a>');
    expect(html).toContain('• one');
    expect(html).toContain('<blockquote>quote</blockquote>');
    expect(toTelegramHtml('```js\nif (a < b) {}\n```')).toBe(
      '<pre><code class="language-js">if (a &lt; b) {}</code></pre>',
    );
    expect(toTelegramHtml('snake_case_name stays')).toBe('snake_case_name stays');
  });

  it('renders WhatsApp formatting', () => {
    const wa = toWhatsApp(md);
    expect(wa).toContain('*Plan*');
    expect(wa).toContain('*Bold* and _it_ and ~old~');
    expect(wa).toContain('`x<y`');
    expect(wa).toContain('docs (https://ex.com/a?b=1)');
    expect(wa).toContain('• one');
  });

  it('strips formatting for plain channels', () => {
    expect(toPlain('**a** *b* [c](https://c.io)')).toBe('a b c (https://c.io)');
  });
});
