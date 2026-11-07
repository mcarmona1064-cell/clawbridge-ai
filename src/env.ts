import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { homedir } from 'os';
import { log } from './log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const candidates = [path.join(homedir(), '.clawbridge', '.env'), path.resolve(__dirname, '../../integrations/.env')];
  const envFile = candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    if (!fs.existsSync(envFile)) {
      log.warn('Warning: .env not found and no environment variables set. Run the setup wizard first.');
    } else {
      log.debug('.env file not found, using defaults', { err });
    }
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}

/** The .env file the host reads (~/.clawbridge/.env unless only the integrations copy exists). */
export function envFilePath(): string {
  const candidates = [path.join(homedir(), '.clawbridge', '.env'), path.resolve(__dirname, '../../integrations/.env')];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

/**
 * Set KEY=VALUE lines in the .env file, replacing existing keys and
 * appending new ones. The file stays readable only by its owner.
 */
export function setEnvValues(values: Record<string, string>, file = envFilePath()): void {
  for (const k of Object.keys(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`invalid env key: ${k}`);
    if (/[\r\n]/.test(values[k])) throw new Error(`invalid value for ${k}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    content = re.test(content)
      ? content.replace(re, () => line)
      : `${content}${content && !content.endsWith('\n') ? '\n' : ''}${line}\n`;
  }
  fs.writeFileSync(file, content, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}
