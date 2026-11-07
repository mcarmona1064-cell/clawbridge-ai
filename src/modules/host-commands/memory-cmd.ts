/**
 * /memory — see and remove what the agent remembers here.
 *
 *   /memory                  recent memories for this conversation and the team
 *   /memory search <words>   find memories
 *   /memory forget <id>      delete one (and check it is gone)
 *
 * Anyone can look at this conversation's memories. Forgetting is for
 * admins in groups and for the person themselves in a DM; team facts can
 * only be forgotten by admins.
 */
import { audit } from '../../audit.js';
import { bankId, getHindsightClient, isHindsightAvailable, scopeTags } from '../../memory/hindsight.js';
import { memoryScopeForSession, teamScopeForAgentGroup } from '../../memory/scope.js';
import { hasAdminPrivilege } from '../permissions/db/user-roles.js';

interface MemoryItem {
  id: string;
  text?: string;
  date?: string;
  document_id?: string | null;
}

export interface MemoryClient {
  listMemories(
    bank: string,
    options: { limit?: number; q?: string; tags?: string[]; tagsMatch?: 'all_strict'; documentId?: string },
  ): Promise<{ items: MemoryItem[] }>;
  deleteDocument(bank: string, documentId: string): Promise<unknown>;
}

export interface MemoryCommandInput {
  agentGroupId: string;
  messagingGroupId: string | null;
  isGroup: boolean;
  userId: string | null;
  args: string;
}

const shortId = (id: string) => id.slice(0, 8);

function scopes(input: MemoryCommandInput): Array<{ scope: string; label: string; team: boolean }> {
  return [
    {
      scope: memoryScopeForSession({ agent_group_id: input.agentGroupId, messaging_group_id: input.messagingGroupId }),
      label: 'This conversation',
      team: false,
    },
    { scope: teamScopeForAgentGroup(input.agentGroupId), label: 'Team knowledge', team: true },
  ];
}

export async function memoryCommand(
  input: MemoryCommandInput,
  client: MemoryClient = getHindsightClient() as unknown as MemoryClient,
  available: () => Promise<boolean> = isHindsightAvailable,
): Promise<string> {
  if (!(await available())) return "My long-term memory isn't reachable right now. Try again later.";
  const [sub, ...rest] = input.args.trim().split(/\s+/).filter(Boolean);
  const arg = rest.join(' ');

  if (!sub || sub === 'search') {
    if (sub === 'search' && !arg) return 'Usage: /memory search <words>';
    const lines: string[] = [];
    for (const s of scopes(input)) {
      const res = await client.listMemories(bankId(s.scope), {
        limit: 6,
        tags: scopeTags(s.scope),
        tagsMatch: 'all_strict',
        ...(arg ? { q: arg } : {}),
      });
      if (res.items.length === 0) continue;
      lines.push(`**${s.label}**`);
      for (const m of res.items)
        lines.push(`• ${(m.text ?? '').replace(/\s+/g, ' ').slice(0, 160)}  _(${shortId(m.document_id ?? m.id)})_`);
      lines.push('');
    }
    if (lines.length === 0) return arg ? `Nothing in memory matches "${arg}".` : "I don't remember anything here yet.";
    lines.push('/memory forget <id> removes one.');
    return lines.join('\n').trim();
  }

  if (sub === 'forget') {
    if (!/^[\w-]{6,}$/.test(arg)) return 'Usage: /memory forget <id> — /memory shows the ids.';
    const isAdmin = !!input.userId && hasAdminPrivilege(input.userId, input.agentGroupId);
    for (const s of scopes(input)) {
      if (s.team && !isAdmin) continue;
      if (!s.team && input.isGroup && !isAdmin) continue;
      const res = await client.listMemories(bankId(s.scope), {
        limit: 50,
        tags: scopeTags(s.scope),
        tagsMatch: 'all_strict',
      });
      const hit = res.items.find((m) => (m.document_id ?? m.id).startsWith(arg));
      if (!hit) continue;
      const documentId = hit.document_id ?? hit.id;
      await client.deleteDocument(bankId(s.scope), documentId);
      const after = await client.listMemories(bankId(s.scope), { documentId, limit: 1 });
      audit('memory.forget', {
        actor: input.userId,
        agentGroupId: input.agentGroupId,
        detail: { scope: s.team ? 'team' : 'conversation', documentId, verified: after.items.length === 0 },
      });
      return after.items.length === 0
        ? `Forgotten: "${(hit.text ?? '').slice(0, 80)}". I checked, and it's gone.`
        : 'I asked my memory to forget that, but it is still there. An admin should check the memory server.';
    }
    return input.isGroup
      ? `No memory ${arg} that you can remove here. In a group, only admins can remove memories.`
      : `No memory ${arg} here. /memory shows the ids.`;
  }

  return 'Use /memory, /memory search <words> or /memory forget <id>.';
}
