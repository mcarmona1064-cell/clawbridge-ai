import { describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { SlackSocketMode, type SocketLike } from './slack-socket.js';

class FakeSocket implements SocketLike {
  sent: string[] = [];
  private listeners = new Map<string, Array<(ev?: unknown) => void>>();
  closed = false;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.emit('close');
  }
  addEventListener(type: string, fn: (ev: { data: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn as (ev?: unknown) => void]);
  }
  emit(type: string, data?: unknown) {
    for (const fn of this.listeners.get(type) ?? [])
      fn(type === 'message' ? { data: JSON.stringify(data) } : undefined);
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const onEvents = vi.fn();
  const onInteractive = vi.fn();
  const fetchImpl = vi.fn(
    async () => new Response(JSON.stringify({ ok: true, url: `wss://slack.test/${sockets.length}` })),
  );
  const client = new SlackSocketMode(
    'xapp-1',
    { onEvents, onInteractive },
    (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      // Slack greets every new connection.
      queueMicrotask(() => s.emit('message', { type: 'hello' }));
      return s;
    },
    fetchImpl as never,
    async () => undefined,
  );
  return { client, sockets, onEvents, onInteractive, fetchImpl };
}

describe('Slack Socket Mode', () => {
  it('connects with the app token and acks every envelope before handling it', async () => {
    const { client, sockets, onEvents, onInteractive, fetchImpl } = setup();
    await client.start();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://slack.com/api/apps.connections.open',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer xapp-1' }) }),
    );
    expect(client.connected).toBe(true);

    sockets[0].emit('message', {
      envelope_id: 'e1',
      type: 'events_api',
      payload: { type: 'event_callback', event_id: 'Ev1' },
    });
    sockets[0].emit('message', { envelope_id: 'e2', type: 'interactive', payload: { type: 'block_actions' } });
    expect(sockets[0].sent).toEqual(['{"envelope_id":"e1"}', '{"envelope_id":"e2"}']);
    expect(onEvents).toHaveBeenCalledWith({ type: 'event_callback', event_id: 'Ev1' });
    expect(onInteractive).toHaveBeenCalledWith({ type: 'block_actions' });
  });

  it('reconnects when Slack asks it to, and stops for good on stop()', async () => {
    const { client, sockets } = setup();
    await client.start();
    sockets[0].emit('message', { type: 'disconnect', reason: 'refresh_requested' });
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await vi.waitFor(() => expect(client.connected).toBe(true));
    client.stop();
    expect(sockets[1].closed).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(sockets).toHaveLength(2);
  });

  it('fails start() on a bad app token', async () => {
    const client = new SlackSocketMode(
      'xapp-bad',
      { onEvents: vi.fn(), onInteractive: vi.fn() },
      () => {
        throw new Error('should not connect');
      },
      (async () => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }))) as never,
    );
    await expect(client.start()).rejects.toThrow(/invalid_auth/);
  });
});
