/**
 * `clawbridge-ai whatsapp-template` — create the message template WhatsApp
 * needs for messages sent more than 24 hours after the person last wrote
 * (scheduled results, digests, reminders).
 *
 * Submits a UTILITY template with one body variable to Meta for review and
 * saves its name as WHATSAPP_TEMPLATE_NAME. Meta usually approves utility
 * templates within minutes; run the command again to see the status.
 *
 * Needs WHATSAPP_ACCESS_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID (WhatsApp →
 * API Setup → "WhatsApp Business Account ID").
 */
import { readEnvFile, setEnvValues } from './env.js';
import { GRAPH_VERSION } from './channels/whatsapp.js';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const TEMPLATE_NAME = 'clawbridge_update';

export function templateDefinition(lang = 'en_US'): Record<string, unknown> {
  return {
    name: TEMPLATE_NAME,
    language: lang,
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'Update from your assistant: {{1}}',
        example: { body_text: [['Your weekly sales summary is ready.']] },
      },
    ],
  };
}

export async function ensureTemplate(
  env: Record<string, string>,
  fetchImpl: FetchLike = fetch,
): Promise<{ status: string; created: boolean } | { error: string }> {
  const waba = env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  const token = env.WHATSAPP_ACCESS_TOKEN;
  if (!waba || !token) {
    return { error: 'Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID (WhatsApp → API Setup) first.' };
  }
  const base = `https://graph.facebook.com/${env.WHATSAPP_GRAPH_VERSION || GRAPH_VERSION}/${encodeURIComponent(waba)}/message_templates`;
  const auth = { Authorization: `Bearer ${token}` };
  const existing = await fetchImpl(`${base}?name=${TEMPLATE_NAME}`, { headers: auth });
  const found = (await existing.json().catch(() => ({}))) as {
    data?: Array<{ name: string; status: string }>;
    error?: { message: string };
  };
  if (!existing.ok) return { error: `Meta refused: ${found.error?.message ?? existing.status}` };
  const match = found.data?.find((t) => t.name === TEMPLATE_NAME);
  if (match) return { status: match.status, created: false };
  const res = await fetchImpl(base, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(templateDefinition(env.WHATSAPP_TEMPLATE_LANG || 'en_US')),
  });
  const body = (await res.json().catch(() => ({}))) as { status?: string; error?: { message: string } };
  if (!res.ok) return { error: `Meta refused the template: ${body.error?.message ?? res.status}` };
  return { status: body.status ?? 'PENDING', created: true };
}

export async function runWhatsAppTemplateCli(): Promise<number> {
  const env = readEnvFile([
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_BUSINESS_ACCOUNT_ID',
    'WHATSAPP_GRAPH_VERSION',
    'WHATSAPP_TEMPLATE_LANG',
  ]);
  const result = await ensureTemplate(env);
  if ('error' in result) {
    console.error(result.error);
    return 1;
  }
  setEnvValues({
    WHATSAPP_TEMPLATE_NAME: TEMPLATE_NAME,
    WHATSAPP_TEMPLATE_LANG: env.WHATSAPP_TEMPLATE_LANG || 'en_US',
  });
  console.log(
    result.created
      ? `Submitted template "${TEMPLATE_NAME}" to Meta (status ${result.status}). It is saved as WHATSAPP_TEMPLATE_NAME; late messages use it once Meta approves.`
      : `Template "${TEMPLATE_NAME}" exists (status ${result.status}). Saved as WHATSAPP_TEMPLATE_NAME.`,
  );
  return 0;
}
