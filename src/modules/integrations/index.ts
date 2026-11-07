/**
 * Integrations module — the host side of the container's
 * `integration_request` tool (file IPC, like host_exec):
 *
 *   /workspace/integrations/available.json   what this agent can call (no secrets)
 *   /workspace/integrations/requests/<id>.json
 *   /workspace/integrations/responses/<id>.json
 *
 * Reads run at once with the real credentials. Writes (sending, creating,
 * changing, paying) become an approval card showing exactly what would be
 * sent; on approval the host makes the call and tells the agent the
 * result. "Always allow" can cover one kind of write (e.g. creating GitHub
 * issues in one repo), except for integrations that always ask (Stripe,
 * Shopify). A deny rule (/permissions deny <integration>) blocks it all.
 */
import fs from 'fs';
import path from 'path';

import { audit } from '../../audit.js';
import { getActiveSessions, getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { policyDecision } from '../../policies.js';
import { sessionDir } from '../../session-manager.js';
import type { Session } from '../../types.js';
import {
  notifyAgent,
  registerApprovalHandler,
  registerApprovalRejectionHandler,
  requestApproval,
} from '../approvals/index.js';
import { executeIntegration, pathTemplate, type IntegrationRequest, type IntegrationResult } from './execute.js';
import { availableIntegrations, isWriteRequest, type ResolvedIntegration } from './registry.js';

const POLL_MS = 300;

function writeAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function availableList(
  integrations: ResolvedIntegration[],
): Array<{ name: string; label: string; description: string; writesNeedApproval: true }> {
  return integrations.map((i) => ({
    name: i.def.name,
    label: i.def.label,
    description: i.def.description,
    writesNeedApproval: true,
  }));
}

function respond(resPath: string, payload: Record<string, unknown>): void {
  writeAtomic(resPath, JSON.stringify(payload));
}

function resultPayload(r: IntegrationResult): Record<string, unknown> {
  return { status: 'done', httpStatus: r.status, contentType: r.contentType, body: r.body, truncated: r.truncated };
}

/** Subject used for allow/deny rules: "<integration> <METHOD> <path template>". */
export function ruleSubject(req: IntegrationRequest): string {
  return `${req.integration} ${req.method.toUpperCase()} ${pathTemplate(req.path)}`;
}

function bodyPreview(body: unknown): string {
  if (body === undefined) return '(no body)';
  const s = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  return s.length > 1500 ? `${s.slice(0, 1500)}\n…` : s;
}

export async function processIntegrationRequest(
  session: Session,
  req: IntegrationRequest,
  resPath: string,
  integrations: ResolvedIntegration[] = availableIntegrations(),
): Promise<void> {
  const target = integrations.find((i) => i.def.name === req.integration);
  if (!target) {
    respond(resPath, { status: 'error', error: `Unknown or unconfigured integration "${req.integration}".` });
    return;
  }
  const method = (req.method || 'GET').toUpperCase();
  const r: IntegrationRequest = { ...req, method };
  const subject = ruleSubject(r);
  if (policyDecision(session.agent_group_id, 'integration', subject) === 'deny') {
    respond(resPath, { status: 'denied', error: `${target.def.label} is turned off for this agent (/permissions).` });
    return;
  }

  const write = isWriteRequest(target.def, method, r.path, r.body);
  const allowedByRule =
    write && !target.def.alwaysAsk && policyDecision(session.agent_group_id, 'integration', subject) === 'allow';

  if (!write || allowedByRule) {
    try {
      const result = await executeIntegration(target, r);
      if (write) {
        audit('integration.write', {
          agentGroupId: session.agent_group_id,
          target: subject,
          detail: { httpStatus: result.status, approved: 'rule' },
        });
      }
      respond(resPath, resultPayload(result));
    } catch (err) {
      respond(resPath, { status: 'error', error: (err as Error).message });
    }
    return;
  }

  const template = pathTemplate(r.path);
  const ok = await requestApproval({
    session,
    agentName: session.agent_group_id,
    action: 'integration_write',
    payload: { ...r, sessionId: session.id },
    title: `${target.def.label}: ${method} ${r.path.split('?')[0]}`,
    question: [
      `The agent wants to make this change in **${target.def.label}**:`,
      '',
      `\`${method} ${r.path}\``,
      '```',
      bodyPreview(r.body),
      '```',
    ].join('\n'),
    risk: target.def.risk,
    ...(target.def.alwaysAsk
      ? {}
      : { alwaysAllow: { scope: subject, label: `Always allow ${method} ${template}`.slice(0, 60) } }),
  });
  respond(
    resPath,
    ok
      ? {
          status: 'pending_approval',
          note: 'Sent for approval. You will get the result as a message once someone decides.',
        }
      : { status: 'error', error: 'This change needs approval, but no owner or admin could be reached.' },
  );
}

registerApprovalHandler('integration_write', async ({ payload, notify }) => {
  const req = payload as unknown as IntegrationRequest;
  const target = availableIntegrations().find((i) => i.def.name === req.integration);
  if (!target) throw new Error(`${req.integration} is no longer configured`);
  const result = await executeIntegration(target, req);
  audit('integration.write', { target: ruleSubject(req), detail: { httpStatus: result.status, approved: 'card' } });
  notify(
    `Approved and sent: ${req.method} ${req.path} → HTTP ${result.status}\n${result.body.slice(0, 1500)}${result.truncated || result.body.length > 1500 ? '\n…' : ''}`,
  );
});

registerApprovalRejectionHandler('integration_write', async ({ payload }) => {
  const req = payload as unknown as IntegrationRequest & { sessionId?: string };
  const session = req.sessionId ? getSession(req.sessionId) : undefined;
  if (session) notifyAgent(session, `The change was declined, so nothing was sent: ${req.method} ${req.path}`);
});

// ── Watcher ──

let polling = false;
let lastList = '';

async function pollOnce(): Promise<void> {
  const integrations = availableIntegrations();
  const list = JSON.stringify(availableList(integrations));
  for (const session of getActiveSessions()) {
    const dir = path.join(sessionDir(session.agent_group_id, session.id), 'integrations');
    const listFile = path.join(dir, 'available.json');
    if (list !== lastList || !fs.existsSync(listFile)) writeAtomic(listFile, list);
    const reqDir = path.join(dir, 'requests');
    if (!fs.existsSync(reqDir)) continue;
    for (const f of fs.readdirSync(reqDir).filter((x) => x.endsWith('.json'))) {
      const reqPath = path.join(reqDir, f);
      let req: IntegrationRequest;
      try {
        req = JSON.parse(fs.readFileSync(reqPath, 'utf8')) as IntegrationRequest;
        fs.unlinkSync(reqPath);
      } catch {
        continue;
      }
      const resPath = path.join(dir, 'responses', `${req.id}.json`);
      await processIntegrationRequest(session, req, resPath, integrations).catch((err) =>
        respond(resPath, { status: 'error', error: (err as Error).message }),
      );
    }
  }
  lastList = list;
}

async function loop(): Promise<void> {
  while (polling) {
    try {
      await pollOnce();
    } catch (err) {
      log.warn('Integrations watcher error', { err });
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export function startIntegrationsWatcher(): void {
  if (polling) return;
  polling = true;
  void loop();
  log.info('Integrations watcher started', { available: availableIntegrations().map((i) => i.def.name) });
}

export function stopIntegrationsWatcher(): void {
  polling = false;
}
