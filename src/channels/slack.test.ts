import crypto from 'crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, factories, fetchMock, renderMock } = vi.hoisted(() => ({
  handlers: new Map<string, (req: Request) => Promise<Response>>(),
  factories: new Map<string, { factory: () => unknown }>(),
  fetchMock: vi.fn(),
  renderMock: vi.fn(),
}));

vi.mock('../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../env.js', () => ({
  readEnvFile: () => ({ SLACK_BOT_TOKEN: 'xoxb-test', SLACK_SIGNING_SECRET: 'secret' }),
}));
vi.mock('../webhook-server.js', () => ({
  registerRawWebhookHandler: (name: string, h: (req: Request) => Promise<Response>) => handlers.set(name, h),
}));
vi.mock('./channel-registry.js', () => ({
  registerChannelAdapter: (type: string, reg: { factory: () => unknown }) => factories.set(type, reg),
}));
vi.mock('../db/sessions.js', () => ({ getAskQuestionRender: renderMock }));
vi.mock('../transcription.js', () => ({ isAudioLike: () => false, transcribeAudio: vi.fn() }));

vi.stubGlobal('fetch', fetchMock);

import type { ChannelAdapter, ChannelSetup } from './adapter.js';
import { markdownMessage, questionMessage, SeenSet, slackApiCall, SlackApiError, splitSlackText } from './slack.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function signed(body: string): Request {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v0=' + crypto.createHmac('sha256', 'secret').update(`v0:${ts}:${body}`).digest('hex');
  return new Request('http://localhost/webhook/slack', {
    method: 'POST',
    body,
    headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig },
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('slackApiCall', () => {
  it('throws on ok:false so delivery can retry instead of marking it delivered', async () => {
    const f = vi.fn(async () => jsonResponse({ ok: false, error: 'channel_not_found' }));
    await expect(slackApiCall('t', 'chat.postMessage', {}, { fetchImpl: f })).rejects.toMatchObject({
      slackError: 'channel_not_found',
    });
  });

  it('honours 429 Retry-After and then succeeds', async () => {
    const sleep = vi.fn(async () => {});
    const f = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: 'ratelimited' }, 429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, ts: '1.2' }));
    await expect(slackApiCall('t', 'chat.postMessage', {}, { fetchImpl: f, sleep })).resolves.toMatchObject({
      ts: '1.2',
    });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('throws on HTTP errors', async () => {
    const f = vi.fn(async () => new Response('bad gateway', { status: 502 }));
    await expect(slackApiCall('t', 'auth.test', {}, { fetchImpl: f })).rejects.toBeInstanceOf(SlackApiError);
  });
});

describe('message shaping', () => {
  it('splits long text on paragraph breaks within the limit', () => {
    const chunks = splitSlackText(`${'a'.repeat(60)}\n\n${'b'.repeat(60)}`, 80);
    expect(chunks).toEqual(['a'.repeat(60), 'b'.repeat(60)]);
    expect(splitSlackText('short', 80)).toEqual(['short']);
  });

  it('sends markdown blocks with a bounded plain-text fallback', () => {
    const msg = markdownMessage('x'.repeat(5000));
    expect(msg.text.length).toBeLessThanOrEqual(3000);
    expect(msg.blocks).toEqual([{ type: 'markdown', text: 'x'.repeat(5000) }]);
  });

  it('renders approvals as buttons keyed by option index', () => {
    const msg = questionMessage('q-1', 'Save to team memory?', 'Payroll runs on the 25th.', [
      { label: 'Approve', value: 'approve' },
      { label: 'Reject', value: 'reject' },
    ] as never);
    const actions = msg.blocks[2] as { elements: Array<{ action_id: string; value: string; style?: string }> };
    expect(actions.elements.map((e) => [e.action_id, e.value, e.style])).toEqual([
      ['ncq:q-1:0', '0', 'primary'],
      ['ncq:q-1:1', '1', 'danger'],
    ]);
  });

  it('SeenSet dedupes and stays bounded', () => {
    const s = new SeenSet(2);
    expect(s.checkAndAdd('a')).toBe(false);
    expect(s.checkAndAdd('a')).toBe(true);
    s.checkAndAdd('b');
    s.checkAndAdd('c');
    expect(s.checkAndAdd('a')).toBe(false); // evicted
  });
});

describe('Slack adapter (end to end with a fake Slack)', () => {
  let adapter: ChannelAdapter;
  let setup: {
    onInbound: ReturnType<typeof vi.fn>;
    onAction: ReturnType<typeof vi.fn>;
    onMetadata: ReturnType<typeof vi.fn>;
  };
  const posted: Array<{ method: string; body: Record<string, unknown> }> = [];

  beforeEach(async () => {
    posted.length = 0;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = url.replace('https://slack.com/api/', '');
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      posted.push({ method, body });
      if (method === 'auth.test') return jsonResponse({ ok: true, user_id: 'UBOT', user: 'bot', team: 'T' });
      if (method === 'users.info') return jsonResponse({ ok: true, user: { profile: { display_name: 'Ana' } } });
      if (method === 'conversations.open') return jsonResponse({ ok: true, channel: { id: 'D42' } });
      return jsonResponse({ ok: true, ts: '200.1' });
    });
    await import('./slack.js');
    adapter = factories.get('slack')!.factory() as ChannelAdapter;
    setup = { onInbound: vi.fn(), onAction: vi.fn(), onMetadata: vi.fn() };
    await adapter.setup(setup as unknown as ChannelSetup);
  });

  const mentionEvent = (eventId: string, type = 'app_mention') =>
    JSON.stringify({
      type: 'event_callback',
      event_id: eventId,
      event: { type, user: 'U1', channel: 'C1', ts: '100.5', text: '<@UBOT> what is the plan?' },
    });

  it('stamps the sender and threads a top-level channel mention under the message', async () => {
    const res = await handlers.get('slack')!(signed(mentionEvent('Ev1')));
    expect(res.status).toBe(200);
    await flush();
    await flush();
    expect(setup.onInbound).toHaveBeenCalledTimes(1);
    const [platformId, threadId, inbound] = setup.onInbound.mock.calls[0];
    expect(platformId).toBe('slack:C1');
    expect(threadId).toBe('100.5');
    expect(inbound.content).toMatchObject({ senderId: 'slack:U1', sender: 'Ana' });
    expect(inbound.isMention).toBe(true);
  });

  it('drops Slack retries and the duplicate message event for the same post', async () => {
    await handlers.get('slack')!(signed(mentionEvent('Ev1')));
    await handlers.get('slack')!(signed(mentionEvent('Ev1'))); // retry, same event_id
    await handlers.get('slack')!(signed(mentionEvent('Ev2', 'message'))); // message.channels twin
    await flush();
    await flush();
    expect(setup.onInbound).toHaveBeenCalledTimes(1);
  });

  it('rejects unsigned requests', async () => {
    const res = await handlers.get('slack')!(
      new Request('http://localhost/webhook/slack', { method: 'POST', body: '{}' }),
    );
    expect(res.status).toBe(401);
  });

  it('routes a button click with the raw Slack user id and the resolved option', async () => {
    renderMock.mockReturnValue({ title: 't', options: [{ label: 'Approve', value: 'approve' }] });
    const payload = {
      type: 'block_actions',
      user: { id: 'U9' },
      container: { channel_id: 'D1', message_ts: '300.1' },
      actions: [{ action_id: 'ncq:appr-1:0', value: '0' }],
    };
    await handlers.get('slack')!(signed(`payload=${encodeURIComponent(JSON.stringify(payload))}`));
    await flush();
    expect(setup.onAction).toHaveBeenCalledWith('appr-1', 'approve', 'U9');
    expect(posted.some((p) => p.method === 'chat.update' && p.body.ts === '300.1')).toBe(true);
  });

  it('delivers edits, reactions and DMs through the right Slack methods', async () => {
    await adapter.deliver('slack:C1', '100.5', {
      kind: 'chat',
      content: { operation: 'edit', messageId: '9.9', text: 'v2' },
    });
    await adapter.deliver('slack:C1', null, {
      kind: 'chat',
      content: { operation: 'reaction', messageId: '9.9', emoji: ':eyes:' },
    });
    expect(posted.find((p) => p.method === 'chat.update')?.body).toMatchObject({ channel: 'C1', ts: '9.9' });
    expect(posted.find((p) => p.method === 'reactions.add')?.body).toMatchObject({ name: 'eyes' });
    await expect(adapter.openDM!('slack:U1')).resolves.toBe('slack:D42');
  });

  it('throws when Slack rejects a post, so the message is not marked delivered', async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ ok: false, error: 'not_in_channel' }));
    await expect(adapter.deliver('slack:C1', null, { kind: 'chat', content: { text: 'hi' } })).rejects.toBeInstanceOf(
      SlackApiError,
    );
  });
});

describe('Slack agent sessions', () => {
  const posted: Array<{ method: string; body: Record<string, unknown> }> = [];
  it('shows working while the agent runs, clears it on reply, and maps the stop button to onStop', async () => {
    posted.length = 0;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = url.replace('https://slack.com/api/', '');
      posted.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (method === 'auth.test') return jsonResponse({ ok: true, user_id: 'UBOT' });
      if (method === 'users.info') return jsonResponse({ ok: true, user: { profile: { display_name: 'Ana' } } });
      return jsonResponse({ ok: true, ts: '9.9' });
    });
    const adapter = factories.get('slack')!.factory() as ChannelAdapter;
    const onStop = vi.fn();
    await adapter.setup({
      onInbound: vi.fn(),
      onAction: vi.fn(),
      onMetadata: vi.fn(),
      onStop,
    } as unknown as ChannelSetup);

    // A DM arrives; its ts is the session's root under agent_view.
    await handlers.get('slack')!(
      signed(
        JSON.stringify({
          type: 'event_callback',
          event_id: 'EvS1',
          event: { type: 'message', channel_type: 'im', channel: 'D7', user: 'U1', ts: '50.1', text: 'hi' },
        }),
      ),
    );
    await flush();
    await flush();

    await adapter.setTyping!('slack:D7', null);
    await adapter.setTyping!('slack:D7', null); // heartbeat: no second call
    const statuses = () => posted.filter((p) => p.method === 'agents.sessions.setStatus').map((p) => p.body);
    expect(statuses()).toEqual([{ channel_id: 'D7', thread_ts: '50.1', status: 'processing' }]);

    await adapter.deliver('slack:D7', null, { kind: 'chat', content: { text: 'Done.' } });
    expect(statuses().at(-1)).toMatchObject({ status: 'active' });

    await handlers.get('slack')!(
      signed(
        JSON.stringify({
          type: 'event_callback',
          event_id: 'EvS2',
          event: {
            type: 'agent_session_stopped',
            channel: 'D7',
            thread_ts: '50.1',
            user: 'U1',
            streaming_message_ts: [],
          },
        }),
      ),
    );
    await flush();
    await flush();
    expect(onStop).toHaveBeenCalledWith('slack:D7', null, 'U1');
  });

  it('turns the status line off when the workspace has no agent sessions', async () => {
    posted.length = 0;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = url.replace('https://slack.com/api/', '');
      posted.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (method === 'agents.sessions.setStatus') return jsonResponse({ ok: false, error: 'feature_disabled' });
      return jsonResponse({ ok: true, ts: '1.1', user_id: 'UBOT' });
    });
    const adapter = factories.get('slack')!.factory() as ChannelAdapter;
    await adapter.setup({ onInbound: vi.fn(), onAction: vi.fn(), onMetadata: vi.fn() } as unknown as ChannelSetup);
    await adapter.setTyping!('slack:C1', '100.1');
    await adapter.setTyping!('slack:C2', '200.1');
    expect(posted.filter((p) => p.method === 'agents.sessions.setStatus')).toHaveLength(1);
  });
});

describe('Slack app manifest', () => {
  it('requests exactly the scopes the adapter uses, plus its events and interactivity', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { SLACK_BOT_SCOPES } = await import('./slack.js');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'setup/channels/slack-app-manifest.json'), 'utf8'),
    ) as {
      oauth_config: { scopes: { bot: string[] } };
      settings: { event_subscriptions: { bot_events: string[] }; interactivity: { is_enabled: boolean } };
    };
    expect([...manifest.oauth_config.scopes.bot].sort()).toEqual([...SLACK_BOT_SCOPES].sort());
    expect(manifest.settings.event_subscriptions.bot_events).toContain('app_mention');
    expect(manifest.settings.interactivity.is_enabled).toBe(true);
  });
});
