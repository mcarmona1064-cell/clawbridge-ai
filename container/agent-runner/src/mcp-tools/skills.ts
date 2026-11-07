/**
 * propose_skill — save a procedure that worked (often a browser workflow)
 * as a reusable skill. An admin reviews and approves it first.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

export const proposeSkill: McpToolDefinition = {
  tool: {
    name: 'propose_skill',
    description:
      'After you complete a multi-step task that will come up again (e.g. "download the monthly invoice from the supplier portal"), propose saving the steps as a skill. Write clear numbered steps, the URLs and what to check at each step. Never include passwords or codes; use browser_handoff for those. An admin approves before it is saved.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Short name, e.g. "supplier-invoice-download".' },
        description: { type: 'string', description: 'One line: when to use it.' },
        steps: { type: 'string', description: 'The procedure in Markdown: numbered steps, URLs, checks.' },
      },
      required: ['name', 'steps'],
    },
  },
  async handler(args) {
    writeMessageOut({
      id: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({
        action: 'propose_skill',
        name: args.name,
        description: args.description,
        steps: args.steps,
      }),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Proposed. An admin will review it before it is saved. Say so; do not claim it is saved yet.',
        },
      ],
    };
  },
};

registerTools([proposeSkill]);
