import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renders = new Map<
  string,
  { title: string; options: Array<{ label: string; selectedLabel: string; value: string }> }
>();
vi.mock('../db/sessions.js', () => ({ getAskQuestionRender: (id: string) => renders.get(id) }));
vi.mock('../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { interceptNumberedReply, prepareOutbound } from './channel-layer.js';

const approval = {
  kind: 'chat-sdk',
  content: {
    type: 'ask_question',
    questionId: 'appr-1',
    title: 'Save to team memory?',
    question: 'Payroll runs on the 25th.',
    options: [
      { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
      { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
    ],
  },
};

describe('channel layer', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    renders.set('appr-1', { title: 'Save to team memory?', options: approval.content.options });
  });
  afterEach(() => {
    closeDb();
    renders.clear();
    vi.useRealTimers();
  });

  it('turns a card into a numbered list on a channel without buttons, and answers it from a reply', () => {
    const out = prepareOutbound({ channelType: 'imessage' }, 'imessage:+1555', null, approval);
    expect((out?.content as { text: string }).text).toContain('1. Approve\n2. Reject');

    // Unrelated chatter is not swallowed.
    expect(interceptNumberedReply('imessage', 'imessage:+1555', null, 'what is payroll?')).toBeNull();
    // Another chat can't answer this chat's card.
    expect(interceptNumberedReply('imessage', 'imessage:+1999', null, '1')).toBeNull();

    expect(interceptNumberedReply('imessage', 'imessage:+1555', null, '2')).toEqual({
      questionId: 'appr-1',
      value: 'reject',
    });
    // One answer per card.
    expect(interceptNumberedReply('imessage', 'imessage:+1555', null, '1')).toBeNull();
  });

  it('leaves cards alone on channels with buttons', () => {
    const out = prepareOutbound({ channelType: 'telegram' }, 'telegram:1', null, approval);
    expect(out).toBe(approval);
    expect(interceptNumberedReply('telegram', 'telegram:1', null, '1')).toBeNull();
  });

  it('stops accepting numbered answers once the card expires', () => {
    prepareOutbound({ channelType: 'signal' }, 'signal:+1', null, approval);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    expect(interceptNumberedReply('signal', 'signal:+1', null, '1')).toBeNull();
  });

  it('ignores replies to a card that was already answered by a button elsewhere', () => {
    prepareOutbound({ channelType: 'signal' }, 'signal:+1', null, approval);
    renders.delete('appr-1');
    expect(interceptNumberedReply('signal', 'signal:+1', null, '1')).toBeNull();
  });

  it('sends edits as new messages where the channel cannot edit, and drops unsupported reactions', () => {
    const edit = { kind: 'chat', content: { operation: 'edit', messageId: 'm1', text: 'Done: 3 rows' } };
    expect(prepareOutbound({ channelType: 'whatsapp' }, 'whatsapp:1', null, edit)?.content).toEqual({
      text: 'Done: 3 rows',
    });
    expect(prepareOutbound({ channelType: 'telegram' }, 'telegram:1', null, edit)).toBe(edit);
    const reaction = { kind: 'chat', content: { operation: 'reaction', messageId: 'm1', emoji: 'eyes' } };
    expect(prepareOutbound({ channelType: 'imessage' }, 'imessage:1', null, reaction)).toBeNull();
  });

  it('uses WhatsApp lists up to ten options and numbered replies beyond that', () => {
    const many = (n: number) => ({
      kind: 'chat-sdk',
      content: { ...approval.content, options: Array.from({ length: n }, (_, i) => `Option ${i + 1}`) },
    });
    expect(prepareOutbound({ channelType: 'whatsapp' }, 'whatsapp:1', null, many(8))?.content).toMatchObject({
      type: 'ask_question',
    });
    expect(
      (prepareOutbound({ channelType: 'whatsapp' }, 'whatsapp:1', null, many(12))?.content as { text: string }).text,
    ).toContain('12. Option 12');
  });
});
