/**
 * Integrations the agent can call through the host.
 *
 * Credentials live only in ~/.clawbridge/.env on the host. An integration
 * is available when its credentials are set. Each one says how to
 * authenticate and which requests change data ("writes"); writes always go
 * through an approval card first.
 *
 * Add your own REST APIs with CUSTOM_INTEGRATIONS in .env:
 *   CUSTOM_INTEGRATIONS=[{"name":"crm","baseUrl":"https://api.example.com","header":"Authorization","prefix":"Bearer ","env":"CRM_TOKEN"}]
 */
import { readEnvFile } from '../../env.js';
import type { Risk } from '../../policies.js';

export type AuthSpec =
  | { type: 'bearer'; env: string }
  | { type: 'header'; header: string; env: string; prefix?: string }
  | { type: 'basic'; userEnv: string; passEnv: string }
  | { type: 'google' };

export interface IntegrationDef {
  name: string;
  label: string;
  /** Base URL; `{ENV_NAME}` placeholders are filled from .env. */
  baseUrl: string;
  auth: AuthSpec;
  /** Extra env keys that must be set (besides the credential). */
  requires?: string[];
  headers?: Record<string, string>;
  risk: Risk;
  /** Writes here are never "always allowed" (money, orders). */
  alwaysAsk?: boolean;
  /** Override for which requests change data. Default: anything but GET/HEAD. */
  isWrite?: (method: string, path: string, body: unknown) => boolean;
  description: string;
}

const graphqlWrite = (method: string, _path: string, body: unknown) => {
  if (method === 'GET' || method === 'HEAD') return false;
  const q = typeof body === 'object' && body ? String((body as { query?: unknown }).query ?? '') : String(body ?? '');
  return /^\s*mutation\b/i.test(q);
};

const google = (name: string, label: string, baseUrl: string, description: string): IntegrationDef => ({
  name,
  label,
  baseUrl,
  auth: { type: 'google' },
  risk: 'medium',
  description,
});

export const BUILT_IN: IntegrationDef[] = [
  {
    name: 'github',
    label: 'GitHub',
    baseUrl: 'https://api.github.com',
    auth: { type: 'bearer', env: 'GITHUB_TOKEN' },
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    risk: 'medium',
    description: 'GitHub REST API: repos, issues, pull requests, actions.',
  },
  {
    name: 'linear',
    label: 'Linear',
    baseUrl: 'https://api.linear.app',
    auth: { type: 'header', header: 'Authorization', env: 'LINEAR_API_KEY' },
    risk: 'medium',
    isWrite: graphqlWrite,
    description: 'Linear GraphQL API: POST /graphql with {"query": …}. Queries are reads; mutations need approval.',
  },
  {
    name: 'jira',
    label: 'Jira',
    baseUrl: '{JIRA_BASE_URL}',
    auth: { type: 'basic', userEnv: 'JIRA_EMAIL', passEnv: 'JIRA_API_TOKEN' },
    requires: ['JIRA_BASE_URL'],
    risk: 'medium',
    description: 'Jira Cloud REST API v3, e.g. GET /rest/api/3/search/jql?jql=…',
  },
  {
    name: 'notion',
    label: 'Notion',
    baseUrl: 'https://api.notion.com',
    auth: { type: 'bearer', env: 'NOTION_TOKEN' },
    headers: { 'Notion-Version': '2022-06-28' },
    risk: 'medium',
    isWrite: (m, p) => !(m === 'GET' || m === 'HEAD' || (m === 'POST' && /\/(search|query)$/.test(p))),
    description: 'Notion API v1: pages, databases (POST …/query and /search are reads).',
  },
  {
    name: 'hubspot',
    label: 'HubSpot',
    baseUrl: 'https://api.hubapi.com',
    auth: { type: 'bearer', env: 'HUBSPOT_TOKEN' },
    risk: 'medium',
    isWrite: (m, p) => !(m === 'GET' || m === 'HEAD' || (m === 'POST' && /\/search$/.test(p))),
    description: 'HubSpot CRM API v3: contacts, companies, deals (POST …/search is a read).',
  },
  {
    name: 'stripe',
    label: 'Stripe',
    baseUrl: 'https://api.stripe.com',
    auth: { type: 'bearer', env: 'STRIPE_SECRET_KEY' },
    risk: 'high',
    alwaysAsk: true,
    description:
      'Stripe API v1 (form-encoded bodies). Anything that charges, refunds or changes data always needs approval.',
  },
  {
    name: 'shopify',
    label: 'Shopify',
    baseUrl: 'https://{SHOPIFY_STORE_DOMAIN}/admin/api/2025-07',
    auth: { type: 'header', header: 'X-Shopify-Access-Token', env: 'SHOPIFY_ACCESS_TOKEN' },
    requires: ['SHOPIFY_STORE_DOMAIN'],
    risk: 'high',
    alwaysAsk: true,
    description:
      'Shopify Admin REST API (e.g. GET /orders.json). Orders, refunds and product changes always need approval.',
  },
  google(
    'gmail',
    'Gmail',
    'https://gmail.googleapis.com',
    'Gmail API v1, e.g. GET /gmail/v1/users/me/messages?q=…; sending and drafts need approval.',
  ),
  google(
    'gcal',
    'Google Calendar',
    'https://www.googleapis.com/calendar/v3',
    'Calendar API v3, e.g. GET /calendars/primary/events.',
  ),
  google('gdrive', 'Google Drive', 'https://www.googleapis.com/drive/v3', 'Drive API v3, e.g. GET /files?q=…'),
  google(
    'gsheets',
    'Google Sheets',
    'https://sheets.googleapis.com/v4',
    'Sheets API v4, e.g. GET /spreadsheets/{id}/values/{range}.',
  ),
];

const GOOGLE_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];

export function envKeysFor(def: IntegrationDef): string[] {
  const keys = [...(def.requires ?? [])];
  const a = def.auth;
  if (a.type === 'bearer' || a.type === 'header') keys.push(a.env);
  else if (a.type === 'basic') keys.push(a.userEnv, a.passEnv);
  else keys.push(...GOOGLE_KEYS);
  return keys;
}

function customIntegrations(raw: string | undefined): IntegrationDef[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as Array<{
      name: string;
      baseUrl: string;
      header?: string;
      prefix?: string;
      env: string;
      label?: string;
      description?: string;
    }>;
    return list
      .filter(
        (c) =>
          /^[a-z][a-z0-9-]{1,30}$/.test(c.name) && /^https:\/\//.test(c.baseUrl) && /^[A-Z][A-Z0-9_]*$/.test(c.env),
      )
      .map((c) => ({
        name: c.name,
        label: c.label ?? c.name,
        baseUrl: c.baseUrl,
        auth: { type: 'header', header: c.header ?? 'Authorization', prefix: c.prefix ?? 'Bearer ', env: c.env },
        risk: 'medium',
        description: c.description ?? `Custom REST API at ${c.baseUrl}`,
      }));
  } catch {
    return [];
  }
}

export interface ResolvedIntegration {
  def: IntegrationDef;
  baseUrl: string;
  env: Record<string, string>;
}

/** Integrations whose credentials are configured. */
export function availableIntegrations(env: Record<string, string> = loadIntegrationEnv()): ResolvedIntegration[] {
  const defs = [...BUILT_IN, ...customIntegrations(env.CUSTOM_INTEGRATIONS)];
  const out: ResolvedIntegration[] = [];
  for (const def of defs) {
    if (!envKeysFor(def).every((k) => env[k])) continue;
    const baseUrl = def.baseUrl.replace(/\{([A-Z0-9_]+)\}/g, (_m, k: string) => env[k] ?? '');
    if (!/^https:\/\//.test(baseUrl)) continue;
    out.push({ def, baseUrl: baseUrl.replace(/\/$/, ''), env });
  }
  return out;
}

export function loadIntegrationEnv(): Record<string, string> {
  const keys = new Set<string>(['CUSTOM_INTEGRATIONS', ...GOOGLE_KEYS]);
  for (const def of BUILT_IN) envKeysFor(def).forEach((k) => keys.add(k));
  const base = readEnvFile([...keys]);
  const custom = customIntegrations(base.CUSTOM_INTEGRATIONS);
  if (custom.length) Object.assign(base, readEnvFile(custom.flatMap(envKeysFor)));
  return base;
}

export function isWriteRequest(def: IntegrationDef, method: string, path: string, body: unknown): boolean {
  const m = method.toUpperCase();
  if (def.isWrite) return def.isWrite(m, path, body);
  return !(m === 'GET' || m === 'HEAD');
}
