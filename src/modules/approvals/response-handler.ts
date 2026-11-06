/**
 * Handle an admin's response to an approval card.
 *
 * Two categories of pending_approvals rows exist:
 *   1. Module-initiated actions — the module called `requestApproval()` with
 *      some free-form `action` string and registered a handler via
 *      `registerApprovalHandler(action, handler)`. On approve, we look up the
 *      handler and call it; on reject, we notify the agent and move on.

 *
 * The response handler is registered via core's `registerResponseHandler`;
 * core iterates handlers and the first one to return `true` claims the response.
 */
import { wakeContainer } from '../../container-runner.js';
import {
  getExpiredPendingApprovals,
  getPendingApproval,
  getSession,
  recordApprovalDecision,
} from '../../db/sessions.js';
import type { ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval } from '../../types.js';
import { hasAdminPrivilege } from '../permissions/db/user-roles.js';
import { getApprovalHandler, getApprovalRejectionHandler } from './primitive.js';

/**
 * Namespaced id of whoever responded. Card clicks arrive with the raw
 * platform id ("U123"); host commands pass an already-namespaced id
 * ("slack:U123").
 */
export function clickerIdFor(payload: Pick<ResponsePayload, 'userId' | 'channelType'>): string | null {
  const raw = payload.userId?.trim();
  if (!raw) return null;
  return raw.includes(':') ? raw : `${payload.channelType}:${raw}`;
}

export async function handleApprovalsResponse(payload: ResponsePayload): Promise<boolean> {
  const approval = getPendingApproval(payload.questionId);
  if (!approval) return false;

  // A card can be clicked again, forwarded, or answered after a restart:
  // only a still-pending approval can be decided.
  if (approval.status !== 'pending') {
    log.info('Approval response ignored — already decided', {
      approvalId: approval.approval_id,
      status: approval.status,
    });
    return true;
  }

  const session = approval.session_id ? getSession(approval.session_id) : undefined;
  const agentGroupId = approval.agent_group_id ?? session?.agent_group_id ?? null;

  // Only an owner or admin of this agent group may decide. Anyone else's
  // click (a forwarded card, a bystander in a shared channel) is claimed
  // and ignored.
  const clickerId = clickerIdFor(payload);
  if (!clickerId || !agentGroupId || !hasAdminPrivilege(clickerId, agentGroupId)) {
    log.warn('Approval click rejected — unauthorized clicker', {
      approvalId: approval.approval_id,
      action: approval.action,
      clickerId,
    });
    return true;
  }

  if (approval.expires_at && Date.parse(approval.expires_at) <= Date.now()) {
    await expireApproval(approval);
    return true;
  }

  await handleRegisteredApproval(approval, payload.value, clickerId);
  return true;
}

function notifierFor(session: { agent_group_id: string; id: string }) {
  return (text: string): void => {
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
    });
  };
}

/** Mark an approval expired and tell the requesting agent. */
export async function expireApproval(approval: PendingApproval): Promise<void> {
  recordApprovalDecision(approval.approval_id, 'expired', null);
  log.info('Approval expired', { approvalId: approval.approval_id, action: approval.action });
  const session = approval.session_id ? getSession(approval.session_id) : undefined;
  if (!session) return;
  notifierFor(session)(`Your ${approval.action} request expired without a decision. Ask again if it is still needed.`);
  await wakeContainer(session);
}

/** Expire every pending approval past its deadline. Called by the host sweep. */
export async function expireStaleApprovals(now: Date = new Date()): Promise<number> {
  const stale = getExpiredPendingApprovals(now.toISOString());
  for (const approval of stale) {
    try {
      await expireApproval(approval);
    } catch (err) {
      log.warn('Failed to expire approval', { approvalId: approval.approval_id, err });
    }
  }
  return stale.length;
}

async function handleRegisteredApproval(
  approval: PendingApproval,
  selectedOption: string,
  userId: string,
): Promise<void> {
  const session = approval.session_id ? getSession(approval.session_id) : undefined;
  if (!session) {
    recordApprovalDecision(approval.approval_id, 'expired', null);
    return;
  }

  const notify = notifierFor(session);

  if (selectedOption !== 'approve') {
    const rejectionHandler = getApprovalRejectionHandler(approval.action);
    if (rejectionHandler) {
      const payload = JSON.parse(approval.payload);
      try {
        await rejectionHandler({ session, payload, userId, notify });
      } catch (err) {
        log.error('Approval rejection handler threw', {
          approvalId: approval.approval_id,
          action: approval.action,
          err,
        });
        notify(
          `Your ${approval.action} request was rejected, but applying the rejection failed: ${err instanceof Error ? err.message : String(err)}.`,
        );
      }
    } else {
      notify(`Your ${approval.action} request was rejected by admin.`);
    }
    log.info('Approval rejected', { approvalId: approval.approval_id, action: approval.action, userId });
    recordApprovalDecision(approval.approval_id, 'rejected', userId);
    await wakeContainer(session);
    return;
  }

  // Approved — dispatch to the module that registered for this action.
  const handler = getApprovalHandler(approval.action);
  if (!handler) {
    log.warn('No approval handler registered — row dropped', {
      approvalId: approval.approval_id,
      action: approval.action,
    });
    notify(`Your ${approval.action} was approved, but no handler is installed to apply it.`);
    recordApprovalDecision(approval.approval_id, 'approved', userId);
    await wakeContainer(session);
    return;
  }

  const payload = JSON.parse(approval.payload);
  try {
    await handler({ session, payload, userId, notify });
    log.info('Approval handled', { approvalId: approval.approval_id, action: approval.action, userId });
  } catch (err) {
    log.error('Approval handler threw', { approvalId: approval.approval_id, action: approval.action, err });
    notify(
      `Your ${approval.action} was approved, but applying it failed: ${err instanceof Error ? err.message : String(err)}.`,
    );
  }

  recordApprovalDecision(approval.approval_id, 'approved', userId);
  await wakeContainer(session);
}
