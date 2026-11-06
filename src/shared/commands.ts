export type CommandCategory = 'admin' | 'filtered' | 'passthrough' | 'none' | 'host';

export interface SlashCommandDefinition {
  command: string;
  category: Exclude<CommandCategory, 'none'>;
  description?: string;
  adminOnly?: boolean;
}

const DEFINITIONS: SlashCommandDefinition[] = [
  { command: '/help', category: 'filtered' },
  { command: '/login', category: 'filtered' },
  { command: '/logout', category: 'filtered' },
  { command: '/doctor', category: 'filtered' },
  { command: '/config', category: 'filtered' },
  { command: '/remote-control', category: 'filtered' },
  { command: '/start', category: 'filtered' },
  { command: '/clear', category: 'admin' },
  { command: '/compact', category: 'admin' },
  { command: '/context', category: 'admin' },
  { command: '/cost', category: 'admin' },
  { command: '/files', category: 'admin' },
  // Host-handled commands (processed by the host process, not forwarded to container)
  { command: '/approve', category: 'host', adminOnly: true, description: 'Approve a pending command or request' },
  { command: '/deny', category: 'host', adminOnly: true, description: 'Deny a pending command or request' },
  { command: '/stop', category: 'host', adminOnly: true, description: 'Stop the current agent session' },
  { command: '/update', category: 'host', adminOnly: true, description: 'Check for ClawBridge updates' },
  { command: '/status', category: 'host', adminOnly: false, description: 'Show current session status' },
  { command: '/whoami', category: 'host', adminOnly: false, description: 'Show your user info and permissions' },
  { command: '/commands', category: 'host', adminOnly: false, description: 'List available commands' },
  {
    command: '/goal',
    category: 'host',
    adminOnly: false,
    description: 'Set or clear a persistent goal (/goal <target> or /goal clear)',
  },
  {
    command: '/agents',
    category: 'host',
    adminOnly: false,
    description: 'List all agent groups and their descriptions',
  },
  {
    command: '/provider',
    category: 'host',
    adminOnly: true,
    description: 'Show or switch the AI provider (/provider claude|codex [session] or /provider default)',
  },
  {
    command: '/health',
    category: 'host',
    adminOnly: false,
    description: 'Show per-agent health status (error counts, last ok)',
  },
];

export const COMMAND_REGISTRY = Object.freeze(DEFINITIONS.map((def) => Object.freeze({ ...def })));

const COMMAND_BY_NAME = new Map(COMMAND_REGISTRY.map((def) => [def.command, def]));

export interface SlashCommandClassification {
  category: CommandCategory;
  command: string;
}

export function extractSlashCommand(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return '';
  return (trimmed.split(/\s+/)[0] ?? '').toLowerCase();
}

export function classifySlashCommand(text: string): SlashCommandClassification {
  const command = extractSlashCommand(text);
  if (!command) return { category: 'none', command: '' };
  const def = COMMAND_BY_NAME.get(command);
  if (!def) return { category: 'passthrough', command };
  return { category: def.category, command };
}

export function isCommand(text: string, command: string): boolean {
  return extractSlashCommand(text) === command.toLowerCase();
}
