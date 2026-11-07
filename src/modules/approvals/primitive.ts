/**
 * Approvals primitive — the public API that other modules call.
 *
 * Two surfaces:
 *   - `requestApproval()` — queue an approval request, deliver the card to
 *     the right admin DM, record the pending_approvals row. Used by any
 *     module that needs admin confirmation before doing something sensitive.
 *   - `registerApprovalHandler(action, handler)` — called at module import
 *     time. When the admin approves a pending row with matching `action`,
 *     the response handler dispatches into the registered callback. Optional
 *     modules (self-mod, future module gates) register here.
 *
 * Approver picking lives here too — it used to sit in src/access.ts and got
 * folded in with the PR #7 re-tier. The picks functions walk user_roles
 * (owner, global admin, scoped admin) and resolve to a reachable DM via the
 * permissions module's user-dm helper.
 *
 * Tier: default module. Permissions is an optional module, so importing from
 * it here is technically a tier inversion — but the host bundles both with
 * main, and the alternative (a third "permissions-primitive" default module
 * exposing just user-roles/user-dms) is more churn than it's worth. Revisit
 * if either module becomes genuinely optional (see REFACTOR_PLAN open q #3).
 */
import { cardTtlMs, normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { identityIds, notifyUserIdFor } from '../../db/user-links.js';
import { ALWAYS_ALLOW_VALUE, RISK_LABEL, type Risk } from '../../policies.js';
import { createPendingApproval, getSession } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { MessagingGroup, Session } from '../../types.js';
import {
  getAdminsOfAgentGroup,
  getApproversOfAgentGroup,
  getGlobalAdmins,
  getOwners,
} from '../permissions/db/user-roles.js';
import { ensureUserDm } from '../permissions/user-dm.js';

/** Two-button approval UI — the only options the primitive supports today. */
const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
];

// ── Approval handler registry ──
// Modules that want to be called back when an admin approves a pending row
// register here at import time, keyed by the `action` string they used in
// their `requestApproval()` calls.

export interface ApprovalHandlerContext {
  session: Session;
  payload: Record<string, unknown>;
  /** User ID of the admin who approved. Empty string if unknown. */
  userId: string;
  /** Send a system chat message to the requesting agent's session. */
  notify: (text: string) => void;
}

export type ApprovalHandler = (ctx: ApprovalHandlerContext) => Promise<void>;

const approvalHandlers = new Map<string, ApprovalHandler>();
const approvalRejectionHandlers = new Map<string, ApprovalHandler>();

export function registerApprovalHandler(action: string, handler: ApprovalHandler): void {
  if (approvalHandlers.has(action)) {
    log.warn('Approval handler re-registered (overwriting)', { action });
  }
  approvalHandlers.set(action, handler);
}

export function registerApprovalRejectionHandler(action: string, handler: ApprovalHandler): void {
  if (approvalRejectionHandlers.has(action)) {
    log.warn('Approval rejection handler re-registered (overwriting)', { action });
  }
  approvalRejectionHandlers.set(action, handler);
}

export function getApprovalHandler(action: string): ApprovalHandler | undefined {
  return approvalHandlers.get(action);
}

export function getApprovalRejectionHandler(action: string): ApprovalHandler | undefined {
  return approvalRejectionHandlers.get(action);
}

// ── Approver picking ──

/**
 * Ordered list of user IDs eligible to approve an action for the given agent
 * group. Preference: admins @ that group → global admins → owners.
 */
export function pickApprover(agentGroupId: string | null): string[] {
  const approvers: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      approvers.push(id);
    }
  };

  if (agentGroupId) {
    for (const r of getAdminsOfAgentGroup(agentGroupId)) add(r.user_id);
  }
  for (const r of getGlobalAdmins()) add(r.user_id);
  for (const r of getOwners()) add(r.user_id);
  // Approvers come last: admins of the agent are asked first.
  if (agentGroupId) for (const r of getApproversOfAgentGroup(agentGroupId)) add(r.user_id);

  return approvers;
}

/**
 * Walk the approver list and return the first (approverId, messagingGroup)
 * pair we can actually deliver to. Returns null if nobody is reachable.
 *
 * Tie-break: prefer approvers reachable on the same channel kind as the
 * origin; else first in list. Resolution uses ensureUserDm, which may
 * trigger a platform openDM call on cache miss.
 */
export async function pickApprovalDelivery(
  approvers: string[],
  originChannelType: string,
): Promise<{ userId: string; messagingGroup: MessagingGroup } | null> {
  // Each approver may have several linked accounts and a chosen channel
  // for approvals (/notify-here). Try, in order: every approver's chosen
  // channel; then accounts on the origin's channel kind; then the rest.
  const accountsOf = (approver: string): string[] => {
    const ids = identityIds(approver);
    const preferred = notifyUserIdFor(approver);
    return preferred ? [preferred, ...ids.filter((id) => id !== preferred)] : ids;
  };
  const tried = new Set<string>();
  const attempt = async (userId: string) => {
    if (tried.has(userId)) return null;
    tried.add(userId);
    const mg = await ensureUserDm(userId);
    return mg ? { userId, messagingGroup: mg } : null;
  };

  for (const approver of approvers) {
    const preferred = notifyUserIdFor(approver);
    if (preferred) {
      const hit = await attempt(preferred);
      if (hit) return hit;
    }
  }
  if (originChannelType) {
    for (const approver of approvers) {
      for (const userId of accountsOf(approver)) {
        if (channelTypeOf(userId) !== originChannelType) continue;
        const hit = await attempt(userId);
        if (hit) return hit;
      }
    }
  }
  for (const approver of approvers) {
    for (const userId of accountsOf(approver)) {
      const hit = await attempt(userId);
      if (hit) return hit;
    }
  }
  return null;
}

function channelTypeOf(userId: string): string {
  const idx = userId.indexOf(':');
  return idx < 0 ? '' : userId.slice(0, idx);
}

// ── Request API ──

/** Send a system chat to the agent's session. Used by callers and by the response handler. */
export function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after notification', { err }));
  }
}

export interface RequestApprovalOptions {
  session: Session;
  agentName: string;
  /** Free-form action identifier. Must match the key the consumer registered via registerApprovalHandler. */
  action: string;
  /** JSON-serializable opaque payload. Carried on the pending_approvals row, handed to the handler on approve. */
  payload: Record<string, unknown>;
  /** Card title shown to the admin. */
  title: string;
  /** Card body shown to the admin. */
  question: string;
  /** Shown as a badge on the card so the admin can judge at a glance. */
  risk?: Risk;
  /**
   * Offer "Always allow …" on the card. Clicking it approves this request
   * and saves an allow rule for `scope` of `action` (reviewable and
   * revocable with /permissions). Omit for anything that must always ask.
   */
  alwaysAllow?: { scope: string; label: string };
}

/** Options for one approval card: Approve, [Always allow …], Reject. */
export function approvalOptions(alwaysAllow?: { label: string }): RawOption[] {
  if (!alwaysAllow) return APPROVAL_OPTIONS;
  return [
    APPROVAL_OPTIONS[0],
    { label: alwaysAllow.label, selectedLabel: '✅ Approved, always allowed', value: ALWAYS_ALLOW_VALUE },
    APPROVAL_OPTIONS[1],
  ];
}

/** How long an approval card stays actionable. APPROVAL_TTL_HOURS overrides. */
export const approvalTtlMs = cardTtlMs;

/**
 * Queue an approval request. Picks an approver, delivers the card to their
 * DM, and records the pending_approvals row. Fire-and-forget from the
 * caller's perspective — the admin's response kicks off the registered
 * approval handler for this action via the response dispatcher.
 */
export async function requestApproval(opts: RequestApprovalOptions): Promise<boolean> {
  const { session, action, agentName } = opts;
  const options = approvalOptions(opts.alwaysAllow);
  const title = opts.risk ? `${RISK_LABEL[opts.risk]} · ${opts.title}` : opts.title;
  const question = opts.question;
  // The rule to save if the admin picks "Always allow" travels with the request.
  const payload = opts.alwaysAllow
    ? { ...opts.payload, __alwaysAllow: { action, scope: opts.alwaysAllow.scope } }
    : opts.payload;

  const approvers = pickApprover(session.agent_group_id);
  if (approvers.length === 0) {
    notifyAgent(session, `${action} failed: no owner or admin configured to approve.`);
    return false;
  }

  const originChannelType = session.messaging_group_id
    ? (getMessagingGroup(session.messaging_group_id)?.channel_type ?? '')
    : '';

  const target = await pickApprovalDelivery(approvers, originChannelType);
  if (!target) {
    notifyAgent(session, `${action} failed: no DM channel found for any eligible approver.`);
    return false;
  }

  const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedOptions = normalizeOptions(options);
  const createdAt = new Date();
  createPendingApproval({
    approval_id: approvalId,
    session_id: session.id,
    request_id: approvalId,
    action,
    payload: JSON.stringify(payload),
    created_at: createdAt.toISOString(),
    agent_group_id: session.agent_group_id,
    expires_at: new Date(createdAt.getTime() + approvalTtlMs()).toISOString(),
    title,
    options_json: JSON.stringify(normalizedOptions),
    channel_type: target.messagingGroup.channel_type,
    platform_id: target.messagingGroup.platform_id,
  });

  const adapter = getDeliveryAdapter();
  if (adapter) {
    try {
      await adapter.deliver(
        target.messagingGroup.channel_type,
        target.messagingGroup.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: approvalId,
          title,
          question,
          options,
        }),
      );
    } catch (err) {
      log.error('Failed to deliver approval card', { action, approvalId, err });
      notifyAgent(session, `${action} failed: could not deliver approval request to ${target.userId}.`);
      return false;
    }
  }

  log.info('Approval requested', { action, approvalId, agentName, approver: target.userId });
  return true;
}
