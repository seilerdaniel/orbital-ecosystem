/**
 * Hybrid search over the synapse knowledge base.
 *
 * Blends two signals per candidate:
 * - lexical: FTS5/LIKE match quality (term coverage + rank position)
 * - semantic: cosine similarity between the query embedding and the stored
 *   hashed-term vector
 *
 * Candidates come from the lexical index plus a recent-memory pool, so a
 * fresh entry can surface even before it has lexical traction. Both
 * signals are deterministic; results are stable for identical inputs.
 */

import {
  cosine,
  hashEmbed,
  VectorStore,
  type MemoryKind,
  type StoredMemory
} from "./store/vector-db.js";

export interface HybridSearchOptions {
  readonly project?: string;
  readonly kind?: MemoryKind;
  /** Final result count. */
  readonly limit?: number;
  /** Weight of the lexical signal, 0..1 (semantic gets the remainder). */
  readonly lexicalWeight?: number;
}

export interface HybridResult {
  readonly memory: StoredMemory;
  readonly lexicalScore: number;
  readonly semanticScore: number;
  readonly combinedScore: number;
}

const DEFAULT_LIMIT = 5;
const CANDIDATE_POOL = 25;

export class HybridSearchEngine {
  private readonly store: VectorStore;

  constructor(store: VectorStore) {
    this.store = store;
  }

  search(query: string, options: HybridSearchOptions = {}): HybridResult[] {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const lexicalWeight = clamp01(options.lexicalWeight ?? 0.4);
    const trimmed = query.trim();

    if (trimmed === "") {
      return [];
    }

    // Candidate pool: lexical hits first, padded with recent memories so
    // brand-new entries compete even with zero term overlap.
    const lexicalHits = this.store.searchLexical(trimmed, CANDIDATE_POOL);
    const scores = new Map<string, { memory: StoredMemory; lexical: number }>();
    const bestPossible = Math.max(lexicalHits.length, 1);

    lexicalHits.forEach((hit, index) => {
      const coverage =
        hit.matchedTerms > 0 ? hit.matchedTerms / countTerms(trimmed) : 0;
      const positional = 1 - index / bestPossible;

      scores.set(hit.memory.id, {
        memory: hit.memory,
        lexical: clamp01(0.5 * positional + 0.5 * coverage)
      });
    });

    if (scores.size < CANDIDATE_POOL) {
      for (const memory of this.store.list({
        ...(options.project === undefined ? {} : { project: options.project }),
        limit: CANDIDATE_POOL
      })) {
        if (!scores.has(memory.id)) {
          scores.set(memory.id, { memory, lexical: 0 });
        }
      }
    }

    const queryVector = hashEmbed(trimmed);
    const results: HybridResult[] = [];

    for (const { memory, lexical } of scores.values()) {
      if (
        options.project !== undefined &&
        memory.project !== options.project
      ) {
        continue;
      }

      if (options.kind !== undefined && memory.kind !== options.kind) {
        continue;
      }

      const vector = this.store.getEmbedding(memory.id);

      if (vector === undefined) {
        continue;
      }

      const semantic = clamp01((cosine(queryVector, vector) + 1) / 2);
      const combined = lexicalWeight * lexical + (1 - lexicalWeight) * semantic;

      results.push({
        memory,
        lexicalScore: Number(lexical.toFixed(4)),
        semanticScore: Number(semantic.toFixed(4)),
        combinedScore: Number(combined.toFixed(4))
      });
    }

    return results.sort((a, b) => b.combinedScore - a.combinedScore).slice(0, limit);
  }
}

function countTerms(query: string): number {
  return query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1).length || 1;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
