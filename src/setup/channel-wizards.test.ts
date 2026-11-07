import { describe, expect, it } from 'vitest';

import {
  checkDiscordToken,
  checkSlackAppToken,
  checkSlackBotToken,
  checkTelegramToken,
  checkWhatsApp,
  discordInviteUrl,
  DISCORD_PERMISSIONS,
  loadSlackManifest,
  newVerifyToken,
  slackManifestUrl,
} from './channel-wizards.js';

const reply =
  (body: unknown, status = 200) =>
  async () =>
    new Response(JSON.stringify(body), { status });

describe('channel setup checks', () => {
  it('Slack: accepts a working bot token and explains a bad one', async () => {
    expect(await checkSlackBotToken('xoxb-1', reply({ ok: true, user: 'cb', team: 'Acme' }))).toEqual({
      ok: true,
      detail: '@cb in Acme',
    });
    const bad = await checkSlackBotToken('xoxb-1', reply({ ok: false, error: 'invalid_auth' }));
    expect(bad).toMatchObject({
      ok: false,
      problem: expect.stringContaining('invalid_auth'),
      fix: expect.stringContaining('Install'),
    });
    expect(await checkSlackBotToken('xoxp-user-token', reply({}))).toMatchObject({
      ok: false,
      fix: expect.stringContaining('xoxb-'),
    });
  });

  it('Slack: checks the app-level token by opening a Socket Mode connection', async () => {
    expect(await checkSlackAppToken('xapp-1', reply({ ok: true, url: 'wss://x' }))).toMatchObject({ ok: true });
    expect(await checkSlackAppToken('xapp-1', reply({ ok: false, error: 'not_allowed_token_type' }))).toMatchObject({
      ok: false,
      fix: expect.stringContaining('connections:write'),
    });
  });

  it('Slack: the create-app link carries the manifest, named after the agent', () => {
    const manifest = loadSlackManifest('Ava');
    const url = slackManifestUrl(manifest);
    expect(url.startsWith('https://api.slack.com/apps?new_app=1&manifest_json=')).toBe(true);
    const decoded = JSON.parse(decodeURIComponent(url.split('manifest_json=')[1]));
    expect(decoded.display_information.name).toBe('Ava');
    expect(decoded.settings.socket_mode_enabled).toBe(true);
  });

  it('WhatsApp: confirms the number and tells the owner which id is wrong', async () => {
    expect(
      await checkWhatsApp('1234567', 'tok', reply({ display_phone_number: '+1 555 0100', verified_name: 'Acme' })),
    ).toEqual({
      ok: true,
      detail: 'Acme (+1 555 0100)',
    });
    expect(
      await checkWhatsApp('1234567', 'tok', reply({ error: { code: 190, message: 'expired' } }, 401)),
    ).toMatchObject({
      ok: false,
      fix: expect.stringContaining('System User'),
    });
    expect(
      await checkWhatsApp('15550100', 'tok', reply({ error: { code: 100, message: 'Unsupported get request' } }, 400)),
    ).toMatchObject({
      ok: false,
      fix: expect.stringContaining('Phone number ID'),
    });
    expect(newVerifyToken()).toMatch(/^cb-[a-f0-9]{24}$/);
  });

  it('Discord: returns the application id for the invite link, with the permissions the bot uses', async () => {
    expect(await checkDiscordToken('t', reply({ id: '42', username: 'cb' }))).toEqual({
      ok: true,
      detail: '@cb',
      extra: { applicationId: '42' },
    });
    expect(await checkDiscordToken('t', reply({ message: '401: Unauthorized' }, 401))).toMatchObject({ ok: false });
    const url = new URL(discordInviteUrl('42'));
    expect(url.searchParams.get('client_id')).toBe('42');
    expect(url.searchParams.get('scope')).toBe('bot applications.commands');
    expect(BigInt(url.searchParams.get('permissions')!)).toBe(DISCORD_PERMISSIONS);
  });

  it('Telegram: checks the token with getMe', async () => {
    expect(await checkTelegramToken('1:abc', reply({ ok: true, result: { username: 'cb_bot' } }))).toEqual({
      ok: true,
      detail: '@cb_bot',
    });
    expect(await checkTelegramToken('1:abc', reply({ ok: false, description: 'Unauthorized' }, 401))).toMatchObject({
      ok: false,
    });
  });
});
