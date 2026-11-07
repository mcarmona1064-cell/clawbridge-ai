/**
 * Cross-channel identity commands.
 *
 *   /link            (in a DM) issue a one-time 6-digit code, valid 10 minutes
 *   /link <code>     (in a DM, from the other account) ask the first account
 *                    to confirm; the accounts are linked only after it approves
 *   /unlink          remove this account's link
 *   /unlink <id>     (from the primary account) remove one linked account
 *   /accounts        list the accounts linked to you
 *   /notify-here     (in a DM) send your approvals and alerts to this chat
 *
 * Linking is two-sided on purpose: a code seen by someone else (a shared
 * screen, a group chat) is useless without the owner's click on the
 * confirmation card, and only the owner (or their already-linked accounts)
 * can click it. Linked accounts share roles, approvals, per-person memory
 * and usage; conversation memory stays with each conversation.
 */
import crypto from 'crypto';

import { getDb, hasTable } from '../../db/connection.js';
import { registerAskQuestionRender } from '../../db/sessions.js';
import {
  createUserLink,
  identityIds,
  linkedAliases,
  primaryUserId,
  removeUserLink,
  setNotifyUserId,
} from '../../db/user-links.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { cardTtlMs } from '../../channels/ask-question.js';
import { clickerIdFor } from '../approvals/response-handler.js';
import { getUser, upsertUser } from '../permissions/db/users.js';
import { ensureUserDm } from '../permissions/user-dm.js';

export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
export const LINK_CARD_PREFIX = 'link-';
export const IDENTITY_COMMANDS = ['/link', '/unlink', '/accounts', '/notify-here'] as const;

export const LINK_CARD_OPTIONS = [
  { label: 'Approve', selectedLabel: '✅ Linked', value: 'approve' },
  { label: 'Reject', selectedLabel: '❌ Not linked', value: 'reject' },
];

interface LinkCodeRow {
  code: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  redeemed_by: string | null;
  redeemed_channel_type: string | null;
  redeemed_platform_id: string | null;
  status: 'open' | 'redeemed' | 'linked' | 'rejected' | 'expired';
}

export interface IdentityCommandInput {
  channelType: string;
  platformId: string;
  threadId: string | null;
  text: string;
  senderId: string | null;
  senderName: string | null;
  isGroup: boolean;
}

const CHANNEL_LABELS: Record<string, string> = {
  slack: 'Slack',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  discord: 'Discord',
  teams: 'Teams',
  gchat: 'Google Chat',
  signal: 'Signal',
  imessage: 'iMessage',
  matrix: 'Matrix',
  email: 'email',
};

export function channelLabel(userId: string): string {
  const type = userId.split(':')[0];
  return CHANNEL_LABELS[type] ?? type;
}

function ready(): boolean {
  return hasTable(getDb(), 'link_codes') && hasTable(getDb(), 'user_links');
}

function getCode(code: string): LinkCodeRow | undefined {
  return getDb().prepare('SELECT * FROM link_codes WHERE code = ?').get(code) as LinkCodeRow | undefined;
}

function ensureUserRow(userId: string, displayName: string | null): void {
  if (getUser(userId)) return;
  upsertUser({
    id: userId,
    kind: userId.split(':')[0],
    display_name: displayName,
    created_at: new Date().toISOString(),
  });
}

/** Issue a fresh one-time code for `userId`, closing any older open code. */
export function issueLinkCode(userId: string): string {
  const db = getDb();
  db.prepare(`UPDATE link_codes SET status = 'expired' WHERE user_id = ? AND status = 'open'`).run(userId);
  let code = '';
  do {
    code = String(crypto.randomInt(100000, 1000000));
  } while (getCode(code));
  const now = Date.now();
  db.prepare(`INSERT INTO link_codes (code, user_id, created_at, expires_at, status) VALUES (?, ?, ?, ?, 'open')`).run(
    code,
    userId,
    new Date(now).toISOString(),
    new Date(now + LINK_CODE_TTL_MS).toISOString(),
  );
  return code;
}

/** Is this text one of the identity commands? */
export function isIdentityCommand(text: string): boolean {
  const cmd = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return (IDENTITY_COMMANDS as readonly string[]).includes(cmd);
}

/**
 * Handle an identity command. Returns the reply to send in the same chat,
 * or null when the text isn't an identity command.
 */
export async function handleIdentityCommand(input: IdentityCommandInput): Promise<string | null> {
  if (!isIdentityCommand(input.text)) return null;
  if (!ready()) return 'Account linking is not set up on this install yet. Restart ClawBridge to apply the update.';
  const [rawCmd, ...rest] = input.text.trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const arg = rest.join(' ').trim();
  const me = input.senderId;
  if (!me) return "I couldn't tell who you are on this channel, so I can't link accounts here.";

  switch (cmd) {
    case '/link':
      return arg ? redeem(input, me, arg) : issue(input, me);
    case '/unlink':
      return unlink(me, arg);
    case '/accounts':
      return accounts(me);
    case '/notify-here':
      if (input.isGroup) return 'Send /notify-here to me in a direct message, so approvals stay private.';
      ensureUserRow(me, input.senderName);
      setNotifyUserId(me, me);
      return `Done. Approvals and alerts for you will come here (${channelLabel(me)}).`;
    default:
      return null;
  }
}

function issue(input: IdentityCommandInput, me: string): string {
  if (input.isGroup) return 'Send /link to me in a direct message — link codes should stay private.';
  ensureUserRow(me, input.senderName);
  const code = issueLinkCode(me);
  return [
    `Your link code is **${code}**.`,
    'From your other account (Slack, WhatsApp, Telegram or Discord), send me:',
    `/link ${code}`,
    "It works once and expires in 10 minutes. I'll ask you here to confirm before anything is linked.",
  ].join('\n');
}

async function redeem(input: IdentityCommandInput, me: string, code: string): Promise<string> {
  if (input.isGroup) return 'Send /link to me in a direct message — link codes should stay private.';
  if (!/^\d{6}$/.test(code)) return 'A link code is 6 digits. Send /link on your other account to get one.';
  const row = getCode(code);
  if (!row || row.status !== 'open' || Date.parse(row.expires_at) <= Date.now()) {
    return 'That code is not valid or has expired. Send /link on your other account to get a new one.';
  }
  if (primaryUserId(row.user_id) === primaryUserId(me)) return 'These accounts are already linked.';
  if (linkedAliases(me).length > 0) {
    return 'This account already has other accounts linked to it. Unlink them first (/accounts lists them).';
  }

  getDb()
    .prepare(
      `UPDATE link_codes SET status = 'redeemed', redeemed_by = ?, redeemed_channel_type = ?, redeemed_platform_id = ?
       WHERE code = ? AND status = 'open'`,
    )
    .run(me, input.channelType, input.platformId, code);
  ensureUserRow(me, input.senderName);

  const owner = row.user_id;
  const dm = await ensureUserDm(owner);
  const adapter = getDeliveryAdapter();
  if (!dm || !adapter) {
    return `I couldn't reach your ${channelLabel(owner)} account to confirm. Message me there once, then try again.`;
  }
  const who = input.senderName ? `${input.senderName} (${channelLabel(me)})` : `A ${channelLabel(me)} account`;
  await adapter.deliver(
    dm.channel_type,
    dm.platform_id,
    null,
    'chat-sdk',
    JSON.stringify({
      type: 'ask_question',
      questionId: `${LINK_CARD_PREFIX}${code}`,
      title: 'Link another account?',
      question: `${who} wants to link to your account. Approve only if this is you: linked accounts share your roles and approvals.`,
      options: LINK_CARD_OPTIONS,
    }),
  );
  return `I sent a confirmation to your ${channelLabel(owner)} account. Approve it there to finish linking.`;
}

function unlink(me: string, target: string): string {
  if (!target) {
    return removeUserLink(me)
      ? 'This account is no longer linked. It keeps only its own roles from now on.'
      : 'This account is not linked to another account.';
  }
  const primary = primaryUserId(me);
  if (!linkedAliases(primary).some((a) => a.alias_id === target)) {
    return `${target} is not one of your linked accounts. /accounts lists them.`;
  }
  removeUserLink(target);
  return `Unlinked ${target}.`;
}

function accounts(me: string): string {
  const ids = identityIds(me);
  if (ids.length === 1) return 'No other accounts are linked. Send /link in a DM to link one.';
  return [
    'Your linked accounts:',
    ...ids.map((id, i) => `• ${channelLabel(id)}: ${id}${i === 0 ? ' (primary)' : ''}`),
  ].join('\n');
}

// ── Confirmation card ──

/** Render for the link confirmation card (used to resolve clicks). */
export function linkCardRender(questionId: string): { title: string; options: typeof LINK_CARD_OPTIONS } | undefined {
  if (!questionId.startsWith(LINK_CARD_PREFIX) || !ready()) return undefined;
  const row = getCode(questionId.slice(LINK_CARD_PREFIX.length));
  return row && row.status === 'redeemed' ? { title: 'Link another account?', options: LINK_CARD_OPTIONS } : undefined;
}

async function tell(row: LinkCodeRow, text: string): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter || !row.redeemed_channel_type || !row.redeemed_platform_id) return;
  await adapter
    .deliver(row.redeemed_channel_type, row.redeemed_platform_id, null, 'chat', JSON.stringify({ text }))
    .catch((err) => log.warn('Identity: could not notify the linked account', { err }));
}

export async function handleLinkResponse(payload: ResponsePayload): Promise<boolean> {
  if (!payload.questionId.startsWith(LINK_CARD_PREFIX) || !ready()) return false;
  const row = getCode(payload.questionId.slice(LINK_CARD_PREFIX.length));
  if (!row || row.status !== 'redeemed' || !row.redeemed_by) return true;

  // Only the person who issued the code (from any of their accounts) can confirm.
  const clicker = clickerIdFor(payload);
  if (!clicker || primaryUserId(clicker) !== primaryUserId(row.user_id)) {
    log.warn('Link confirmation ignored — clicked by someone else', { clicker, owner: row.user_id });
    return true;
  }
  if (Date.parse(row.created_at) + LINK_CODE_TTL_MS + cardTtlMs() <= Date.now()) {
    getDb().prepare(`UPDATE link_codes SET status = 'expired' WHERE code = ?`).run(row.code);
    return true;
  }

  if (payload.value === 'approve') {
    createUserLink(row.redeemed_by, primaryUserId(row.user_id), clicker);
    getDb().prepare(`UPDATE link_codes SET status = 'linked' WHERE code = ?`).run(row.code);
    log.info('Accounts linked', { alias: row.redeemed_by, primary: primaryUserId(row.user_id), approvedBy: clicker });
    await tell(row, `Linked. This account now has the same access as your ${channelLabel(row.user_id)} account.`);
  } else {
    getDb().prepare(`UPDATE link_codes SET status = 'rejected' WHERE code = ?`).run(row.code);
    await tell(row, 'The link was declined, so nothing changed.');
  }
  return true;
}

registerResponseHandler(handleLinkResponse);
registerAskQuestionRender(linkCardRender);
