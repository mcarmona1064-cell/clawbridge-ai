import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { env } = vi.hoisted(() => ({ env: {} as Record<string, string> }));
vi.mock('./log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./env.js', () => ({ readEnvFile: () => ({ ...env }) }));

import { closeDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { lastWasVoice, setVoiceReplies, speakable, synthesize, voiceRepliesOn } from './voice-replies.js';

describe('voice replies', () => {
  beforeEach(() => runMigrations(initTestDb()));
  afterEach(() => {
    closeDb();
    for (const k of Object.keys(env)) delete env[k];
  });

  it('is off until turned on, per conversation', () => {
    expect(voiceRepliesOn('s1')).toBe(false);
    setVoiceReplies('s1', true);
    expect(voiceRepliesOn('s1')).toBe(true);
    expect(voiceRepliesOn('s2')).toBe(false);
  });

  it('only answers voice notes with voice', () => {
    expect(lastWasVoice(JSON.stringify({ text: '[voice] what is on today?' }))).toBe(true);
    expect(lastWasVoice(JSON.stringify({ text: 'what is on today?' }))).toBe(false);
    expect(lastWasVoice(null)).toBe(false);
  });

  it('speaks prose, not code or URLs', () => {
    expect(speakable('**Done.** See [the report](https://x.test/r) and run `npm test`:\n```\nnpm test\n```')).toBe(
      'Done. See the report and run npm test: (code omitted)',
    );
  });

  it('uses the host TTS key, and does nothing without one', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([79, 103, 103, 83])));
    expect(await synthesize('hello', fetchImpl as never)).toBeNull();
    env.TTS_PROVIDER = 'openai';
    env.OPENAI_API_KEY = 'sk-test';
    const audio = await synthesize('hello', fetchImpl as never);
    expect(audio?.subarray(0, 4).toString()).toBe('OggS');
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ input: 'hello', response_format: 'opus' });
  });
});
