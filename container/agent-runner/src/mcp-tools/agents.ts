/**
 * Agent management MCP tools: create_agent, list_agents, fan_out.
 *
 * create_agent — spawn a new long-lived sub-agent; admin-only.
 * list_agents  — list all agent destinations visible to this container.
 * fan_out      — send a prompt to multiple agents in parallel and collect replies.
 */
import { getAllDestinations } from '../destinations.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const createAgent: McpToolDefinition = {
  tool: {
    name: 'create_agent',
    description:
      'Create a long-lived companion sub-agent (research assistant, task manager, specialist) — the name becomes your destination for it. Admin-only. Fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Human-readable name (also becomes your destination name for this agent)',
        },
        instructions: {
          type: 'string',
          description: 'AGENTS.md content for the new agent (personality, role, instructions)',
        },
        description: {
          type: 'string',
          description: 'Short description of this agent\'s role, shown in /agents and list_agents',
        },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    if (!name) return err('name is required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'create_agent',
        requestId,
        name,
        instructions: (args.instructions as string) || null,
        description: (args.description as string) || null,
      }),
    });

    log(`create_agent: ${requestId} → "${name}"`);
    return ok(`Creating agent "${name}". You will be notified when it is ready.`);
  },
};

export const listAgents: McpToolDefinition = {
  tool: {
    name: 'list_agents',
    description: 'List all agent destinations you can communicate with.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  async handler(_args) {
    const agents = getAllDestinations().filter((d) => d.type === 'agent');
    if (agents.length === 0) {
      return ok('No agent destinations found. Use create_agent to spawn a sub-agent.');
    }
    const lines = agents.map((a) => {
      const label = a.displayName && a.displayName !== a.name ? ` (${a.displayName})` : '';
      return `- ${a.name}${label}`;
    });
    return ok(`Your agent destinations:\n${lines.join('\n')}`);
  },
};

export const fanOut: McpToolDefinition = {
  tool: {
    name: 'fan_out',
    description:
      'Send the same prompt to multiple agents in parallel. You receive one collect message when all agents have replied. Use this for parallelising research, drafts, or analysis across specialist agents.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agents: {
          type: 'array',
          items: { type: 'string' },
          description: 'Destination names of the agents to send to (e.g. ["researcher", "analyst"])',
        },
        prompt: {
          type: 'string',
          description: 'The task or question to send to each agent',
        },
        collect_prompt: {
          type: 'string',
          description: 'Optional instruction for synthesising the replies (appended to the collect message)',
        },
        expected_schema: {
          type: 'object',
          description:
            'Optional JSON Schema for validating each reply. Supports "type" and "required" fields. Validation errors are prefixed to the reply text.',
        },
      },
      required: ['agents', 'prompt'],
    },
  },
  async handler(args) {
    const agents = args.agents as unknown;
    const prompt = args.prompt as string;

    if (!Array.isArray(agents) || agents.length === 0) return err('agents must be a non-empty array');
    if (!prompt) return err('prompt is required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'fan_out',
        requestId,
        agents,
        prompt,
        collect_prompt: (args.collect_prompt as string) || null,
        expected_schema: args.expected_schema || null,
      }),
    });

    log(`fan_out: ${requestId} → ${(agents as string[]).join(', ')}`);
    return ok(
      `Fan-out sent to ${(agents as string[]).length} agent${(agents as string[]).length === 1 ? '' : 's'}. ` +
        `You will receive a collect message when all have replied.`,
    );
  },
};

registerTools([createAgent, listAgents, fanOut]);
