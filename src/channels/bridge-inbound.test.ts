/**
 * Chat SDK bridge, inbound half of the contract: Teams, Google Chat and
 * Webex (and any other bridge channel). Drives the bridge through a fake
 * Chat SDK runtime and checks sender identity, DM vs group, mentions,
 * attachments and button clicks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { chats } = vi.hoisted(() => ({ chats: [] as Array<Record<string, (...a: unknown[]) => unknown>> }));

vi.mock('../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../state-sqlite.js', () => ({
  SqliteStateAdapter: class {
    subscribe = vi.fn();
  },
}));
vi.mock('../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn(), registerRawWebhookHandler: vi.fn() }));
vi.mock('../db/sessions.js', () => ({
  getAskQuestionRender: (id: string) =>
    id === 'q-1'
      ? {
          title: 'Approve?',
          options: [
            { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
            { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
          ],
        }
      : undefined,
}));
vi.mock('chat', () => ({
  Chat: class {
    handlers: Record<string, (...a: unknown[]) => unknown> = {};
    constructor() {
      chats.push(this.handlers);
    }
    onSubscribedMessage(fn: (...a: unknown[]) => unknown) {
      this.handlers.subscribed = fn;
    }
    onNewMention(fn: (...a: unknown[]) => unknown) {
      this.handlers.mention = fn;
    }
    onDirectMessage(fn: (...a: unknown[]) => unknown) {
      this.handlers.dm = fn;
    }
    onNewMessage(_re: RegExp, fn: (...a: unknown[]) => unknown) {
      this.handlers.message = fn;
    }
    onAction(fn: (...a: unknown[]) => unknown) {
      this.handlers.action = fn;
    }
    async initialize() {}
    async shutdown() {}
  },
  Card: (x: unknown) => x,
  CardText: (x: unknown) => x,
  Actions: (x: unknown) => x,
  Button: (x: unknown) => x,
}));

import type { ChannelSetup } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';

function message(text: string, author: { userId: string; fullName: string }, extra: Record<string, unknown> = {}) {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    text,
    author,
    metadata: { dateSent: new Date('2026-11-06T10:00:00Z') },
    attachments: extra.attachments,
    raw: {},
    isMention: extra.isMention,
    toJSON() {
      return { id: this.id, text, author, attachments: [] };
    },
  };
}

describe.each([
  ['teams', '29:1abcUserAadId', 'Ana Lima'],
  ['gchat', 'users/1234567890', 'Ana Lima'],
  ['webex', 'Y2lzY29zcGFyazovL3VzL1BFT1BMRS9hbmE', 'Ana Lima'],
])('%s through the Chat SDK bridge (inbound)', (name, userId, fullName) => {
  let setup: {
    onInbound: ReturnType<typeof vi.fn>;
    onAction: ReturnType<typeof vi.fn>;
    onMetadata: ReturnType<typeof vi.fn>;
  };
  let handlers: Record<string, (...a: unknown[]) => unknown>;
  const editMessage = vi.fn(async () => undefined);

  beforeEach(async () => {
    chats.length = 0;
    editMessage.mockClear();
    const bridge = createChatSdkBridge({
      adapter: {
        name,
        channelIdFromThreadId: (t: string) => `${name}:${t.split('::')[0]}`,
        editMessage,
        postMessage: vi.fn(),
        addReaction: vi.fn(),
        startTyping: vi.fn(),
      } as never,
      supportsThreads: true,
    });
    setup = { onInbound: vi.fn(), onAction: vi.fn(), onMetadata: vi.fn() };
    await bridge.setup(setup as unknown as ChannelSetup);
    handlers = chats[0];
  });

  it('marks DMs as addressed, with the sender id and name', async () => {
    await handlers.dm({ id: 'dm1::t' }, message('what is the plan?', { userId, fullName }));
    const [platformId, threadId, inbound] = setup.onInbound.mock.calls[0];
    expect(platformId).toBe(`${name}:dm1`);
    expect(threadId).toBe('dm1::t');
    expect(inbound).toMatchObject({ isMention: true, isGroup: false });
    expect(inbound.content).toMatchObject({ senderId: userId, sender: fullName, text: 'what is the plan?' });
  });

  it('treats mentions as addressed and plain group chatter as not', async () => {
    await handlers.mention({ id: 'room::t1' }, message('@Ava summarise', { userId, fullName }));
    await handlers.message({ id: 'room::t2' }, message('lunch?', { userId, fullName }));
    expect(setup.onInbound.mock.calls.map((c) => [c[2].isMention, c[2].isGroup])).toEqual([
      [true, true],
      [false, true],
    ]);
  });

  it('keeps following a thread it joined, carrying the mention flag', async () => {
    await handlers.subscribed(
      { id: 'room::t1' },
      message('and the budget?', { userId, fullName }, { isMention: false }),
    );
    expect(setup.onInbound.mock.calls[0][2]).toMatchObject({ isMention: false, isGroup: true });
  });

  it('downloads attachments into the message', async () => {
    const att = {
      type: 'file',
      name: 'a.pdf',
      mimeType: 'application/pdf',
      size: 3,
      fetchData: async () => Buffer.from('pdf'),
    };
    await handlers.dm({ id: 'dm1::t' }, message('see attached', { userId, fullName }, { attachments: [att] }));
    expect(setup.onInbound.mock.calls[0][2].content.attachments[0]).toMatchObject({
      name: 'a.pdf',
      data: Buffer.from('pdf').toString('base64'),
    });
  });

  it('turns a card click into onAction with the option value, and updates the card', async () => {
    await handlers.action({
      actionId: 'ncq:q-1:1',
      value: '1',
      user: { userId },
      threadId: 'dm1::t',
      messageId: 'card1',
    });
    expect(setup.onAction).toHaveBeenCalledWith('q-1', 'reject', userId);
    expect(editMessage).toHaveBeenCalledWith('dm1::t', 'card1', { markdown: 'Approve?\n\n❌ Rejected' });
  });
});
