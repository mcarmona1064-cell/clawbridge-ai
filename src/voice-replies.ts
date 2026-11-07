/**
 * Voice replies (opt-in per conversation with /voice on).
 *
 * When the person's last message was a voice note and voice replies are on,
 * the reply also goes out as a short voice note (OGG/Opus, which WhatsApp and
 * Telegram play as a voice message), alongside the text. Speech is made on
 * the host with a text-to-speech provider whose key stays on the host:
 *
 *   TTS_PROVIDER=openai, OPENAI_API_KEY=…   (model TTS_MODEL, voice TTS_VOICE)
 *
 * Without a provider, /voice explains how to set one up and replies stay text.
 */
import { getDb, hasTable } from './db/connection.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const MAX_CHARS = 1_500;

function ready(): boolean {
  try {
    const db = getDb();
    if (!hasTable(db, 'session_prefs')) return false;
    return (db.prepare('PRAGMA table_info(session_prefs)').all() as Array<{ name: string }>).some(
      (c) => c.name === 'voice_replies',
    );
  } catch {
    return false;
  }
}

export function voiceRepliesOn(sessionId: string): boolean {
  if (!ready()) return false;
  const row = getDb().prepare('SELECT voice_replies FROM session_prefs WHERE session_id = ?').get(sessionId) as
    | { voice_replies: number }
    | undefined;
  return row?.voice_replies === 1;
}

export function setVoiceReplies(sessionId: string, on: boolean): void {
  if (!ready()) return;
  getDb()
    .prepare(
      `INSERT INTO session_prefs (session_id, voice_replies, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET voice_replies = excluded.voice_replies, updated_at = excluded.updated_at`,
    )
    .run(sessionId, on ? 1 : 0, new Date().toISOString());
}

export function ttsConfig(): { provider: 'openai'; key: string; model: string; voice: string } | null {
  const env = readEnvFile(['TTS_PROVIDER', 'OPENAI_API_KEY', 'TTS_MODEL', 'TTS_VOICE']);
  if (env.TTS_PROVIDER === 'openai' && env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
      key: env.OPENAI_API_KEY,
      model: env.TTS_MODEL || 'gpt-4o-mini-tts',
      voice: env.TTS_VOICE || 'alloy',
    };
  }
  return null;
}

/** Text worth speaking: no code, links shortened, Markdown stripped, capped. */
export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[*_~#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHARS);
}

export async function synthesize(text: string, fetchImpl: FetchLike = fetch): Promise<Buffer | null> {
  const cfg = ttsConfig();
  if (!cfg) return null;
  const input = speakable(text);
  if (!input) return null;
  const res = await fetchImpl('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, voice: cfg.voice, input, response_format: 'opus' }),
  });
  if (!res.ok) {
    log.warn('Text-to-speech failed', { status: res.status });
    return null;
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Was the person's last message a voice note? (Adapters prefix transcripts with "[voice]".) */
export function lastWasVoice(latestInboundContent: string | null | undefined): boolean {
  if (!latestInboundContent) return false;
  try {
    const text = (JSON.parse(latestInboundContent) as { text?: string }).text ?? '';
    return /(^|\n)\[voice\] /.test(text);
  } catch {
    return false;
  }
}
