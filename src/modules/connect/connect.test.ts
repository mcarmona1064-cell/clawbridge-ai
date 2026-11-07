import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { saved, started } = vi.hoisted(() => ({ saved: [] as Array<Record<string, string>>, started: [] as string[] }));
vi.mock('../../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../env.js', () => ({ setEnvValues: (v: Record<string, string>) => void saved.push(v) }));
vi.mock('../../channels/channel-registry.js', () => ({
  startChannelAdapter: async (name: string) => {
    started.push(name);
    return true;
  },
}));

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';
import { handleConnect, isConnectMessage, resetConnectFlows } from './index.js';

const OWNER = 'telegram:1';
const say = (text: string, senderId = OWNER, isGroup = false) =>
  handleConnect({ channelType: 'telegram', platformId: 'telegram:1', text, senderId, isGroup, agentName: 'Ava' });

describe('/connect from chat', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    saved.length = 0;
    started.length = 0;
    resetConnectFlows();
    upsertUser({ id: OWNER, kind: 'telegram', display_name: 'Ana', created_at: new Date().toISOString() });
    grantRole({
      user_id: OWNER,
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: new Date().toISOString(),
    });
  });
  afterEach(() => {
    closeDb();
    vi.unstubAllGlobals();
  });

  it('is for owners and admins, in a DM', async () => {
    expect(await say('/connect slack', 'telegram:2')).toMatch(/Only the owner/);
    expect(await say('/connect slack', OWNER, true)).toMatch(/direct message/);
    expect(await say('/connect fax')).toMatch(/Which one\?/);
  });

  it('walks through Slack, checks both tokens, saves them and starts the channel', async () => {
    vi.stubGlobal(
      'fetch',
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('auth.test') ? { ok: true, user: 'ava', team: 'Acme' } : { ok: true, url: 'wss://x' },
          ),
        ),
    );
    const intro = await say('/connect slack');
    expect(intro).toContain('https://api.slack.com/apps?new_app=1&manifest_json=');
    // Every message in the flow is intercepted, so tokens never reach the agent.
    expect(
      isConnectMessage({ channelType: 'telegram', platformId: 'telegram:1', text: 'xoxb-123', senderId: OWNER }),
    ).toBe(true);
    expect(
      isConnectMessage({ channelType: 'telegram', platformId: 'telegram:1', text: 'xoxb-123', senderId: 'telegram:9' }),
    ).toBe(false);
    expect(await say('not-a-token')).toMatch(/starts with xoxb-/);
    expect(await say('xoxb-123')).toMatch(/xapp-/);
    const done = await say('xapp-456');
    expect(done).toMatch(/Slack is connected \(@ava in Acme\)/);
    expect(done).toMatch(/delete the messages/);
    expect(saved).toEqual([{ SLACK_BOT_TOKEN: 'xoxb-123', SLACK_APP_TOKEN: 'xapp-456' }]);
    expect(started).toEqual(['slack']);
    expect(
      isConnectMessage({ channelType: 'telegram', platformId: 'telegram:1', text: 'thanks', senderId: OWNER }),
    ).toBe(false);
  });

  it('saves nothing when the platform rejects the credentials, and explains the fix', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ error: { code: 190, message: 'expired' } }), { status: 401 }),
    );
    await say('/connect whatsapp');
    await say('1234567890');
    await say('EAAG-token');
    const reply = await say('0123456789abcdef0123456789abcdef');
    expect(reply).toMatch(/Meta didn't accept/);
    expect(reply).toMatch(/System User/);
    expect(saved).toEqual([]);
  });

  it('adds a webhook verify token for WhatsApp and tells the owner the last step', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ display_phone_number: '+1 555 0100', verified_name: 'Acme' })),
    );
    await say('/connect whatsapp');
    await say('1234567890');
    await say('EAAG-token');
    const reply = await say('0123456789abcdef0123456789abcdef');
    expect(saved[0]).toMatchObject({
      WHATSAPP_PHONE_NUMBER_ID: '1234567890',
      WHATSAPP_APP_SECRET: '0123456789abcdef0123456789abcdef',
    });
    expect(saved[0].WHATSAPP_WEBHOOK_VERIFY_TOKEN).toMatch(/^cb-/);
    expect(reply).toContain(`Verify token: ${saved[0].WHATSAPP_WEBHOOK_VERIFY_TOKEN}`);
  });

  it('"cancel" stops without saving', async () => {
    await say('/connect discord');
    expect(await say('cancel')).toMatch(/Nothing was saved/);
    expect(saved).toEqual([]);
  });
});

describe('setEnvValues', () => {
  it('replaces existing keys, appends new ones and keeps the file private', async () => {
    const { setEnvValues } = await vi.importActual<typeof import('../../env.js')>('../../env.js');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-env-')), '.env');
    fs.writeFileSync(file, '# comment\nSLACK_BOT_TOKEN=old\nOTHER=1');
    setEnvValues({ SLACK_BOT_TOKEN: 'xoxb-new', SLACK_APP_TOKEN: 'xapp-1' }, file);
    expect(fs.readFileSync(file, 'utf8')).toBe(
      '# comment\nSLACK_BOT_TOKEN=xoxb-new\nOTHER=1\nSLACK_APP_TOKEN=xapp-1\n',
    );
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(() => setEnvValues({ BAD: 'a\nINJECTED=1' }, file)).toThrow();
  });
});
