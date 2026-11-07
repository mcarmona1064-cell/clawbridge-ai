/**
 * Integration tools — call connected business apps (GitHub, Linear, Jira,
 * Notion, HubSpot, Stripe, Shopify, Gmail, Google Calendar/Drive/Sheets,
 * custom REST APIs) through the host. The container never holds their
 * credentials: requests go to the host over file IPC, the host adds the
 * credentials, and anything that changes data waits for a person to approve.
 */
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const DIR = '/workspace/integrations';
const REQUESTS_DIR = path.join(DIR, 'requests');
const RESPONSES_DIR = path.join(DIR, 'responses');
const AVAILABLE = path.join(DIR, 'available.json');
const TIMEOUT_MS = 60_000;
const POLL_MS = 200;

function text(t: string, isError = false) {
  return { content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) };
}

function readAvailable(): Array<{ name: string; label: string; description: string }> {
  try {
    return JSON.parse(fs.readFileSync(AVAILABLE, 'utf8')) as Array<{
      name: string;
      label: string;
      description: string;
    }>;
  } catch {
    return [];
  }
}

export const listIntegrations: McpToolDefinition = {
  tool: {
    name: 'list_integrations',
    description:
      'List the business apps you can use through integration_request (e.g. GitHub, Gmail, HubSpot), with how to call each.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    const list = readAvailable();
    if (list.length === 0)
      return text(
        'No integrations are connected. An admin can add credentials on the host (see docs/integrations.md).',
      );
    return text(list.map((i) => `- ${i.name} (${i.label}): ${i.description}`).join('\n'));
  },
};

export const integrationRequest: McpToolDefinition = {
  tool: {
    name: 'integration_request',
    description:
      'Call a connected app\'s API through the host (credentials stay on the host). Reads return at once. Anything that sends, creates, changes or pays is shown to a person for approval first; you get "pending_approval" now and the result later as a message. Never claim a change happened until you have that result.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        integration: { type: 'string', description: 'Name from list_integrations, e.g. "github".' },
        method: { type: 'string', description: 'HTTP method: GET, POST, PATCH, PUT or DELETE. Default GET.' },
        path: { type: 'string', description: 'API path starting with "/", e.g. "/repos/acme/web/issues".' },
        query: { type: 'object', description: 'Query string parameters.' },
        body: { description: 'Request body (JSON object, or form fields for Stripe).' },
      },
      required: ['integration', 'path'],
    },
  },
  async handler(args) {
    const integration = String(args.integration ?? '').trim();
    const reqPath = String(args.path ?? '').trim();
    if (!integration || !reqPath.startsWith('/')) return text('integration and an absolute path are required.', true);
    const id = `int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.mkdirSync(REQUESTS_DIR, { recursive: true });
    fs.mkdirSync(RESPONSES_DIR, { recursive: true });
    const request = {
      id,
      integration,
      method: String(args.method ?? 'GET').toUpperCase(),
      path: reqPath,
      query: (args.query as Record<string, string>) ?? undefined,
      body: args.body,
    };
    const file = path.join(REQUESTS_DIR, `${id}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(request));
    fs.renameSync(`${file}.tmp`, file);

    const resPath = path.join(RESPONSES_DIR, `${id}.json`);
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (fs.existsSync(resPath)) {
        try {
          const res = JSON.parse(fs.readFileSync(resPath, 'utf8')) as {
            status: string;
            httpStatus?: number;
            body?: string;
            truncated?: boolean;
            error?: string;
            note?: string;
          };
          fs.unlinkSync(resPath);
          if (res.status === 'done') {
            return text(
              `HTTP ${res.httpStatus}\n${res.body ?? ''}${res.truncated ? '\n[truncated]' : ''}`,
              (res.httpStatus ?? 500) >= 400,
            );
          }
          if (res.status === 'pending_approval') return text(`pending_approval: ${res.note ?? ''}`);
          return text(res.error ?? res.status, true);
        } catch {
          /* partially written; keep polling */
        }
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return text('The host did not answer in time. The integrations service may not be running.', true);
  },
};

registerTools([listIntegrations, integrationRequest]);
