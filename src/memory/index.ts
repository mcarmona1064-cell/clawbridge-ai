export { MemoryManager } from './manager.js';
export { extractMemories } from './extractor.js';
export { initMemoryDb } from './db.js';
export { runReflectionAgent } from './reflection-agent.js';
export { generateCrossClientReport } from './cross-client.js';
export { embed, keywordSimilarity, cosineSimilarity } from './embeddings.js';
export type { Memory, MemorySegment, MemoryQueryResult } from './types.js';

// Memory scope (which bank a session may use)
export {
  memoryScopeForSession,
  memoryScopesForSessions,
  originForSession,
  provenanceTags,
  readableScopesForSession,
  teamScopeForAgentGroup,
} from './scope.js';
export type { MemoryOrigin } from './scope.js';

// Hindsight integration
export {
  hindsightRetain,
  hindsightRecall,
  hindsightReflect,
  ensureClientBank,
  isHindsightAvailable,
  bankId,
  recallToSessionFile,
  recallFromScopes,
  retainTurn,
  MEMORY_CONTEXT_FILENAME,
} from './hindsight.js';
