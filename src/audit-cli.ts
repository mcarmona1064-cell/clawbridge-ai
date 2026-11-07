/**
 * `clawbridge-ai audit export [--format jsonl|csv] [--since <ISO date>] [--action <name or prefix*>]`
 * `clawbridge-ai audit verify`
 */
import path from 'path';

import { exportAudit, verifyAuditChain } from './audit.js';
import { DATA_DIR } from './config.js';
import { initDb } from './db/connection.js';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

export function runAuditCli(args: string[]): number {
  initDb(path.join(DATA_DIR, 'v2.db'));
  const sub = args[0];
  if (sub === 'verify') {
    const result = verifyAuditChain();
    if (result.ok) {
      console.log(`Audit log intact: ${result.rows} rows, hash chain verified.`);
      return 0;
    }
    console.error(`Audit log broken at row ${result.brokenAt}: ${result.reason}.`);
    return 1;
  }
  if (sub === 'export') {
    const format = (flag(args, 'format') ?? 'jsonl') as 'jsonl' | 'csv';
    if (format !== 'jsonl' && format !== 'csv') {
      console.error('--format must be jsonl or csv');
      return 2;
    }
    const out = exportAudit(format, { since: flag(args, 'since'), action: flag(args, 'action') });
    if (out) process.stdout.write(out + '\n');
    return 0;
  }
  console.log('Usage: clawbridge-ai audit export [--format jsonl|csv] [--since <ISO date>] [--action <name|prefix*>]');
  console.log('       clawbridge-ai audit verify');
  return sub ? 2 : 0;
}
