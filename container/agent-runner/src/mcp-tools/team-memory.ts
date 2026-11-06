/**
 * Team memory MCP tool: propose_team_memory.
 *
 * Conversation memories stay private to their own chat. To share a fact with
 * every conversation of this agent, propose it here; the host sends it to an
 * admin for approval and writes it to the team bank only if approved.
 * Fire-and-forget: the agent is notified of the outcome by a chat message.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const MAX_FACT_CHARS = 600;

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const proposeTeamMemory: McpToolDefinition = {
  tool: {
    name: 'propose_team_memory',
    description:
      'Propose ONE durable, team-relevant fact (a convention, owner, decision, or correction) for shared team memory, so every conversation of this agent can use it. An admin must approve it first; fire-and-forget. Never propose personal, sensitive, or DM-only information unless the person explicitly asked you to share it with the team.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fact: {
          type: 'string',
          description: `The fact as one self-contained sentence (max ${MAX_FACT_CHARS} chars), e.g. "Invoices go out on the 3rd and are chased on the 10th."`,
        },
        source: {
          type: 'string',
          description: 'Where it came from, e.g. "Maria in #finance, 2026-11-06" or a document title',
        },
      },
      required: ['fact'],
    },
  },
  async handler(args) {
    const fact = typeof args.fact === 'string' ? args.fact.trim() : '';
    if (!fact) return err('fact is required');
    if (fact.length > MAX_FACT_CHARS) return err(`fact is limited to ${MAX_FACT_CHARS} characters`);

    writeMessageOut({
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({
        action: 'propose_team_memory',
        fact,
        source: typeof args.source === 'string' ? args.source.trim() : '',
      }),
    });
    return ok('Team memory proposal sent for admin approval. You will be told whether it was saved.');
  },
};

registerTools([proposeTeamMemory]);
