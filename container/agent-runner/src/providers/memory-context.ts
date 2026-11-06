/**
 * Per-turn memory context written by the host (src/memory/hindsight.ts →
 * recallToSessionFile) at /workspace/.memory_context.md.
 *
 * It goes into the USER turn, never the system prompt: the system prompt is
 * part of the cached prefix, and changing it on every query would throw away
 * the provider's prompt cache. A tracker remembers what was last injected so
 * follow-up messages only carry memory when the recall actually changed.
 */
import fs from 'fs';

export const MEMORY_CONTEXT_PATH = '/workspace/.memory_context.md';

export function readMemoryContext(path: string = MEMORY_CONTEXT_PATH): string {
  try {
    if (!fs.existsSync(path)) return '';
    return fs.readFileSync(path, 'utf-8').trim();
  } catch {
    return '';
  }
}

/** Prefix a user message with memory context. */
export function withMemoryContext(message: string, memory: string): string {
  return memory ? `${memory}\n\n---\n\n${message}` : message;
}

/** Injects the current memory context into a message only when it changed since the last injection. */
export class MemoryContextTracker {
  private last = '';
  constructor(private readonly read: () => string = () => readMemoryContext()) {}

  decorate(message: string): string {
    const memory = this.read();
    if (!memory || memory === this.last) return message;
    this.last = memory;
    return withMemoryContext(message, memory);
  }
}
