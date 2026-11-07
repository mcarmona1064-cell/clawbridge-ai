/**
 * Audience-aware egress guard.
 *
 * When an agent working in a private chat (a DM) tries to post into a group
 * or channel, the post is held and an approval card asks first, showing a
 * preview and where it would go. Approving delivers it; "Always allow
 * posting there" saves a rule for that destination. Group-to-group and
 * DM-to-DM sends are not held (the audience does not widen).
 */
import { recordSessionAction } from './claim-gate.js';
import { getDeliveryAdapter } from './delivery.js';
import { log } from './log.js';
import {
  notifyAgent,
  registerApprovalHandler,
  registerApprovalRejectionHandler,
  requestApproval,
} from './modules/approvals/index.js';
import { policyDecision } from './policies.js';
import type { MessagingGroup, Session } from './types.js';

export function widensAudience(origin: MessagingGroup | undefined, target: MessagingGroup): boolean {
  return !!origin && origin.is_group === 0 && target.is_group === 1;
}

function preview(content: string): string {
  try {
    const c = JSON.parse(content) as { text?: string; markdown?: string; type?: string; title?: string };
    const text = c.markdown || c.text || (c.type === 'ask_question' ? `[question card] ${c.title ?? ''}` : '');
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  } catch {
    return '';
  }
}

/** Returns true when the message was held for approval instead of sent. */
export async function holdCrossPost(
  session: Session,
  origin: MessagingGroup | undefined,
  target: MessagingGroup,
  msg: {
    id: string;
    kind: string;
    channel_type: string | null;
    platform_id: string | null;
    thread_id: string | null;
    content: string;
  },
): Promise<boolean> {
  if (!widensAudience(origin, target)) return false;
  if (policyDecision(session.agent_group_id, 'cross_post', target.platform_id) === 'allow') return false;
  const where = target.name ?? `${target.channel_type} ${target.platform_id}`;
  const ok = await requestApproval({
    session,
    agentName: session.agent_group_id,
    action: 'cross_post',
    payload: {
      channelType: msg.channel_type,
      platformId: msg.platform_id,
      threadId: msg.thread_id,
      kind: msg.kind,
      content: msg.content,
    },
    title: `Post in ${where}?`,
    question: [
      `The agent wants to post this in **${where}** (a group), from a private conversation:`,
      '',
      ...preview(msg.content)
        .split('\n')
        .map((l) => `> ${l}`),
    ].join('\n'),
    risk: 'medium',
    alwaysAllow: { scope: target.platform_id, label: 'Always allow posting there' },
  });
  if (!ok)
    log.warn('Cross-post held but no approver reachable; not sent', {
      sessionId: session.id,
      target: target.platform_id,
    });
  return true;
}

registerApprovalHandler('cross_post', async ({ session, payload, notify }) => {
  const adapter = getDeliveryAdapter();
  if (!adapter) throw new Error('no delivery adapter');
  await adapter.deliver(
    String(payload.channelType),
    String(payload.platformId),
    (payload.threadId as string | null) ?? null,
    String(payload.kind ?? 'chat'),
    String(payload.content),
  );
  recordSessionAction(session.id, 'cross_post');
  notify('Your post was approved and sent.');
});

registerApprovalRejectionHandler('cross_post', async ({ session }) => {
  notifyAgent(session, 'The person declined posting that message in the group, so it was not sent.');
});
