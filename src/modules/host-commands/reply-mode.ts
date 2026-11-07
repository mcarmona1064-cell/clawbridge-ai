/**
 * /reply — choose, per chat, when the agent answers:
 *   /reply mentions   only when mentioned (or in a thread it already joined)
 *   /reply all        every message in this chat
 *   /reply            show the current setting
 * Admins only. DMs always get every message.
 */
import { audit } from '../../audit.js';
import { getMessagingGroupAgentByPair, updateMessagingGroupAgent } from '../../db/messaging-groups.js';
import { hasAdminPrivilege } from '../permissions/db/user-roles.js';

export function replyModeCommand(opts: {
  agentGroupId: string;
  messagingGroupId: string;
  isGroup: boolean;
  userId: string | null;
  args: string;
  /** Threaded channels (Slack, Discord) keep following threads they joined; others need a mention each time. */
  supportsThreads: boolean;
}): string {
  const wiring = getMessagingGroupAgentByPair(opts.messagingGroupId, opts.agentGroupId);
  if (!wiring) return "I'm not set up for this chat.";
  const current = wiring.engage_mode === 'pattern' && (wiring.engage_pattern ?? '.') === '.' ? 'all' : 'mentions';
  const want = opts.args.trim().toLowerCase();
  if (!want) {
    return current === 'all'
      ? 'I answer every message here. Admins can change it with /reply mentions.'
      : 'I answer here when someone mentions me (and keep following threads I joined). Admins can change it with /reply all.';
  }
  if (!opts.isGroup) return 'In a direct message I always answer. /reply is for groups and channels.';
  if (!opts.userId || !hasAdminPrivilege(opts.userId, opts.agentGroupId))
    return 'Only an admin can change when I answer.';
  if (want !== 'all' && want !== 'mentions') return 'Use /reply mentions or /reply all.';
  if (want === 'all') updateMessagingGroupAgent(wiring.id, { engage_mode: 'pattern', engage_pattern: '.' });
  else
    updateMessagingGroupAgent(wiring.id, {
      engage_mode: opts.supportsThreads ? 'mention-sticky' : 'mention',
      engage_pattern: null,
    });
  audit('policy.changed', {
    actor: opts.userId,
    target: opts.messagingGroupId,
    agentGroupId: opts.agentGroupId,
    detail: { setting: 'reply', value: want },
  });
  return want === 'all'
    ? 'Okay — I will answer every message in this chat.'
    : opts.supportsThreads
      ? 'Okay — I will only answer here when someone mentions me, and in threads I joined.'
      : 'Okay — I will only answer here when someone mentions me or replies to me.';
}
