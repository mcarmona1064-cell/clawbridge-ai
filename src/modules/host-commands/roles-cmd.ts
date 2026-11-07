/**
 * /roles — who can do what with this agent.
 *
 *   /roles                                  list (anyone)
 *   /roles grant <person> admin|approver|auditor
 *   /roles revoke <person> admin|approver|auditor
 *
 * Owners can grant any role; admins can grant approver and auditor. Roles
 * apply to this agent. A person is a mention (<@U123>) or an id like
 * slack:U123 or telegram:42; linked accounts share their roles.
 */
import { getDb, hasTable } from '../../db/connection.js';
import { primaryUserId } from '../../db/user-links.js';
import type { UserRoleKind } from '../../types.js';
import { grantRole, hasAdminPrivilege, isOwner, revokeRole } from '../permissions/db/user-roles.js';
import { getUser, upsertUser } from '../permissions/db/users.js';

const GRANTABLE: UserRoleKind[] = ['admin', 'approver', 'auditor'];

const ROLE_TEXT: Record<UserRoleKind, string> = {
  owner: 'Owner — everything',
  admin: 'Admin — manage this agent',
  approver: 'Approver — answer approval cards',
  auditor: 'Auditor — see usage and the audit trail',
};

/** Turn "<@U123>", "<@!123>" or "slack:U123" into a user id on this channel. */
export function parsePerson(raw: string | undefined, channelType: string): string | null {
  if (!raw) return null;
  const mention = /^<@!?([\w.-]+)>$/.exec(raw);
  if (mention) return `${channelType}:${mention[1]}`;
  if (/^[a-z]+:[\w.+@-]+$/i.test(raw)) return raw;
  return null;
}

export function rolesCommand(opts: {
  agentGroupId: string;
  channelType: string;
  userId: string | null;
  args: string;
}): string {
  const [sub, who, roleRaw] = opts.args.trim().split(/\s+/).filter(Boolean);
  if (!sub) return listRoles(opts.agentGroupId);

  if (!opts.userId || !hasAdminPrivilege(opts.userId, opts.agentGroupId)) return 'Only an admin can change roles.';
  if (sub !== 'grant' && sub !== 'revoke')
    return 'Use /roles, /roles grant <person> <role> or /roles revoke <person> <role>.';
  const person = parsePerson(who, opts.channelType);
  const role = roleRaw?.toLowerCase() as UserRoleKind | undefined;
  if (!person || !role || !GRANTABLE.includes(role)) {
    return 'Use /roles grant <person> admin|approver|auditor, where <person> is a mention or an id like slack:U123.';
  }
  if (role === 'admin' && !isOwner(opts.userId)) return 'Only the owner can make someone an admin.';
  const target = primaryUserId(person);

  if (sub === 'grant') {
    if (!getUser(target)) {
      upsertUser({ id: target, kind: target.split(':')[0], display_name: null, created_at: new Date().toISOString() });
    }
    try {
      grantRole({
        user_id: target,
        role,
        agent_group_id: opts.agentGroupId,
        granted_by: opts.userId,
        granted_at: new Date().toISOString(),
      });
    } catch {
      return `${target} already has that role.`;
    }
    return `${target} is now ${ROLE_TEXT[role].split(' — ')[0].toLowerCase()} for this agent.`;
  }
  revokeRole(target, role, opts.agentGroupId);
  return `Removed ${role} from ${target}.`;
}

function listRoles(agentGroupId: string): string {
  if (!hasTable(getDb(), 'user_roles')) return 'Roles are not set up on this install.';
  const rows = getDb()
    .prepare(
      `SELECT r.user_id, r.role, r.agent_group_id, u.display_name FROM user_roles r LEFT JOIN users u ON u.id = r.user_id
       WHERE r.agent_group_id IS NULL OR r.agent_group_id = ? ORDER BY r.role, r.granted_at`,
    )
    .all(agentGroupId) as Array<{
    user_id: string;
    role: UserRoleKind;
    agent_group_id: string | null;
    display_name: string | null;
  }>;
  if (rows.length === 0) return 'No roles yet. The first person to message me becomes the owner.';
  const lines = ['**Who can do what**'];
  for (const r of rows) {
    const name = r.display_name ? `${r.display_name} (${r.user_id})` : r.user_id;
    lines.push(`• ${name}: ${ROLE_TEXT[r.role] ?? r.role}${r.agent_group_id ? '' : ' (all agents)'}`);
  }
  lines.push('', 'Everyone else can talk to me where I am set up. Admins: /roles grant <person> approver');
  return lines.join('\n');
}
