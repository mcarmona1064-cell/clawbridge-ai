/**
 * query_data — read-only SQL over files in the workspace (CSV, Parquet,
 * JSON, Excel) with DuckDB, e.g.
 *   SELECT region, sum(amount) FROM '/workspace/inbound/sales.csv' GROUP BY 1
 *
 * Read-only by construction: one SELECT-style statement, no network, file
 * access limited to /workspace, settings locked. Every answer shows the SQL
 * and the row count, so people can check the numbers.
 */
import { execFile } from 'child_process';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const MAX_ROWS = 200;
const TIMEOUT_MS = 30_000;

const READ_START = /^\s*(select|with|from|describe|summarize|show|pivot|unpivot|explain|values)\b/i;
const FORBIDDEN =
  /\b(copy|attach|detach|install|load|export|import|create|insert|update|delete|drop|alter|set|reset|pragma|call|checkpoint|vacuum|use|grant|truncate|begin|commit|rollback)\b/i;

/** Why a statement is refused, or null if it is a single read. */
export function refuseSql(sql: string): string | null {
  const s = sql.trim().replace(/;+\s*$/, '');
  if (!s) return 'Empty query.';
  if (s.includes(';')) return 'One statement at a time.';
  if (!READ_START.test(s)) return 'Only reads (SELECT, WITH, DESCRIBE, SUMMARIZE …) are allowed.';
  // Ignore string literals and identifiers when looking for write keywords.
  const bare = s.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  const hit = FORBIDDEN.exec(bare);
  if (hit) return `"${hit[1].toUpperCase()}" is not allowed in read-only queries.`;
  if (/\b(https?|s3|gcs|az|hf):\/\//i.test(s)) return 'Only files in /workspace can be queried.';
  return null;
}

/** The DuckDB script: lock everything down first, then run the query. */
export function buildScript(sql: string, limit = MAX_ROWS): string {
  const s = sql.trim().replace(/;+\s*$/, '');
  const wrappable = /^\s*(select|with|from|values|pivot|unpivot)\b/i.test(s);
  return [
    "SET allowed_directories = ['/workspace']",
    'SET enable_external_access = false',
    'SET autoinstall_known_extensions = false',
    'SET autoload_known_extensions = false',
    'SET lock_configuration = true',
    wrappable ? `SELECT count(*) AS __rows FROM (${s})` : null,
    wrappable ? `SELECT * FROM (${s}) LIMIT ${limit}` : s,
  ]
    .filter(Boolean)
    .join(';\n');
}

/** Render rows as a Markdown table. */
export function toTable(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '(no rows)';
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) =>
    String(v ?? '')
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ')
      .slice(0, 80);
  return [
    `| ${cols.join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${cols.map((c) => cell(r[c])).join(' | ')} |`),
  ].join('\n');
}

/** DuckDB's -json mode prints one JSON array per statement that returns rows. */
export function parseJsonArrays(stdout: string): Array<Array<Record<string, unknown>>> {
  const out: Array<Array<Record<string, unknown>>> = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  for (let i = 0; i < stdout.length; i++) {
    const c = stdout[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(JSON.parse(stdout.slice(start, i + 1)) as Array<Record<string, unknown>>);
        start = -1;
      }
    }
  }
  return out;
}

function runDuckdb(script: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'duckdb',
      ['-json', ':memory:', '-c', script],
      { timeout: TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024, cwd: '/workspace' },
      (err, stdout, stderr) => {
        if (err && !stdout) reject(new Error(stderr || err.message));
        else resolve({ stdout, stderr });
      },
    );
  });
}

export const queryData: McpToolDefinition = {
  tool: {
    name: 'query_data',
    description:
      "Run one read-only SQL query (DuckDB) over files in /workspace — CSV, Parquet, JSON or Excel — e.g. SELECT region, sum(amount) FROM '/workspace/inbound/sales.csv' GROUP BY 1. Returns the SQL, the row count and up to 200 rows. Always show people the SQL and row count with the answer.",
    inputSchema: {
      type: 'object' as const,
      properties: { sql: { type: 'string', description: 'One read-only SQL statement.' } },
      required: ['sql'],
    },
  },
  async handler(args) {
    const sql = String(args.sql ?? '');
    const refusal = refuseSql(sql);
    if (refusal) return { content: [{ type: 'text' as const, text: refusal }], isError: true };
    try {
      const { stdout } = await runDuckdb(buildScript(sql));
      const arrays = parseJsonArrays(stdout);
      const wrappable = /^\s*(select|with|from|values|pivot|unpivot)\b/i.test(sql);
      const total = wrappable ? Number(arrays[0]?.[0]?.__rows ?? 0) : (arrays.at(-1)?.length ?? 0);
      const rows = arrays.at(-1) ?? [];
      const shown = rows.length < total ? ` (showing the first ${rows.length})` : '';
      return {
        content: [
          {
            type: 'text' as const,
            text: `SQL:\n\`\`\`sql\n${sql.trim()}\n\`\`\`\nRows: ${total}${shown}\n\n${toTable(rows)}`,
          },
        ],
      };
    } catch (err) {
      const msg = (err as Error).message;
      return {
        content: [
          {
            type: 'text' as const,
            text: /ENOENT/.test(msg)
              ? 'DuckDB is not installed in this image (INSTALL_DUCKDB=false).'
              : `Query failed: ${msg.slice(0, 1000)}`,
          },
        ],
        isError: true,
      };
    }
  },
};

registerTools([queryData]);
