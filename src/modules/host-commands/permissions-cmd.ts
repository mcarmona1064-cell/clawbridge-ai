/**
 * /permissions — see and change what the agent may do without asking.
 *
 *   /permissions                     list rules (anyone)
 *   /permissions revoke <id>         remove a rule (admins)
 *   /permissions deny <action>       never allow an action, e.g. host_exec (admins)
 *   /permissions ask <action>        back to asking every time (admins)
 */
import { listPolicies, removePolicy, setPolicy } from '../../policies.js';
import { hasAdminPrivilege } from '../permissions/db/user-roles.js';

const ACTION_LABELS: Record<string, string> = {
  host_exec: 'run commands on the host computer',
};

const label = (action: string) => ACTION_LABELS[action] ?? action;

export function permissionsCommand(agentGroupId: string, userId: string | null, args: string): string {
  const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (!sub) {
    const rules = listPolicies(agentGroupId);
    const lines = ['**What I may do without asking**'];
    if (rules.length === 0) {
      lines.push('Nothing beyond the safe defaults. Anything sensitive gets an approval card first.');
    } else {
      for (const r of rules) {
        lines.push(
          r.decision === 'deny'
            ? `• #${r.id} Never: ${label(r.action)}${r.scope === '*' ? '' : ` (\`${r.scope}\`)`}`
            : `• #${r.id} Always allowed: ${label(r.action)} — \`${r.scope}\``,
        );
      }
    }
    lines.push(
      '',
      'Always asks, whatever the rules: deleting, sudo, network downloads, chained shell commands and anything touching secrets.',
    );
    lines.push('Admins: /permissions revoke <#>, /permissions deny host_exec, /permissions ask host_exec');
    return lines.join('\n');
  }

  if (!userId || !hasAdminPrivilege(userId, agentGroupId)) return 'Only an admin can change permissions.';
  if (sub === 'revoke') {
    const id = Number((rest[0] ?? '').replace(/^#/, ''));
    if (!Number.isInteger(id) || id <= 0) return 'Usage: /permissions revoke <#>';
    return removePolicy(agentGroupId, id, userId) ? `Removed rule #${id}.` : `No rule #${id}. /permissions lists them.`;
  }
  const action = rest[0];
  if ((sub === 'deny' || sub === 'ask') && action) {
    if (sub === 'deny') {
      setPolicy(agentGroupId, action, '*', 'deny', userId);
      return `Okay — I will never ${label(action)}. /permissions ask ${action} undoes it.`;
    }
    for (const r of listPolicies(agentGroupId).filter((x) => x.action === action))
      removePolicy(agentGroupId, r.id, userId);
    return `Okay — I will ask every time before I ${label(action)}.`;
  }
  return 'Use /permissions, /permissions revoke <#>, /permissions deny <action> or /permissions ask <action>.';
}
