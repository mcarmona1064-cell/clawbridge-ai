/**
 * share_file — turn a file in the workspace (an HTML report, PDF, chart,
 * spreadsheet) into a signed link that expires, to send in chat. The host
 * copies the file out of the sandbox; nothing else in the workspace is exposed.
 */
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const REQUESTS = '/workspace/share/requests';
const RESPONSES = '/workspace/share/responses';

export const shareFile: McpToolDefinition = {
  tool: {
    name: 'share_file',
    description:
      'Make a signed, expiring link to a file you created in /workspace (HTML report, PDF, image, CSV, spreadsheet) so people can open it in a browser. Default 7 days, max 30. Small files can also be attached to a message directly.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path of the file, e.g. /workspace/outbox/report.html' },
        hours: { type: 'number', description: 'How long the link works, in hours (default 168).' },
      },
      required: ['path'],
    },
  },
  async handler(args) {
    const p = String(args.path ?? '');
    if (!p) return { content: [{ type: 'text' as const, text: 'path is required' }], isError: true };
    const id = `share-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.mkdirSync(REQUESTS, { recursive: true });
    const file = path.join(REQUESTS, `${id}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ id, path: p, hours: args.hours }));
    fs.renameSync(`${file}.tmp`, file);
    const res = path.join(RESPONSES, `${id}.json`);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(res)) {
        const out = JSON.parse(fs.readFileSync(res, 'utf8')) as { url?: string; expiresAt?: string; error?: string };
        fs.unlinkSync(res);
        if (out.error) return { content: [{ type: 'text' as const, text: out.error }], isError: true };
        return { content: [{ type: 'text' as const, text: `${out.url}\n(works until ${out.expiresAt})` }] };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return { content: [{ type: 'text' as const, text: 'The host did not answer in time.' }], isError: true };
  },
};

registerTools([shareFile]);
