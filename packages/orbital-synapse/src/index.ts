/**
 * @orbital/synapse — global memory engine for the Orbital ecosystem.
 *
 * Library surface (this barrel): the SQLite vector store and the hybrid
 * search engine. The bus-connected memory service lives behind the
 * `./service` subpath so library consumers do not need the WebSocket
 * transport.
 */

export {
  DEFAULT_DB_PATH,
  VectorStore,
  cosine,
  hashEmbed,
  type MemoryKind,
  type MemoryRecord,
  type StoredMemory
} from "./store/vector-db.js";

export {
  HybridSearchEngine,
  type HybridResult,
  type HybridSearchOptions
} from "./hybrid-search.js";
