export type CommandCategory = 'admin' | 'filtered' | 'passthrough' | 'none';

export interface SlashCommandDefinition {
  command: string;
  category: Exclude<CommandCategory, 'none'>;
  description?: string;
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
