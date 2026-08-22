/**
 * VectorStore — local knowledge base for the Orbital ecosystem.
 *
 * SQLite (via the built-in `node:sqlite` driver, zero native deps) with:
 * - an FTS5 lexical index when available (LIKE fallback otherwise),
 * - a per-record embedding stored as JSON, computed locally with a
 *   deterministic hashed bag-of-words vector. No external model, fully
 *   offline; the embedding function is swappable if a real model lands.
 *
 * Requires Node >= 22.5 (node:sqlite). The DB defaults to
 * `~/.config/orbital/synapse.db` and is shared across projects: rows are
 * keyed by `project` so several repositories can coexist in one file.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type MemoryKind = "pattern" | "story" | "note";

export interface MemoryRecord {
  readonly id?: string;
  readonly project: string;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly content: string;
  readonly tags?: readonly string[];
  /** Receipt that proves this memory came from a verified candidate. */
  readonly receiptId?: string;
}

export interface StoredMemory extends MemoryRecord {
  readonly id: string;
  readonly createdAt: string;
}

export const DEFAULT_DB_PATH = join(homedir(), ".config", "orbital", "synapse.db");
const EMBEDDING_DIM = 128;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

/**
 * Deterministic hashed bag-of-words embedding, L2-normalized. Same text
 * always yields the same vector, so cosine similarity is reproducible.
 */
export function hashEmbed(text: string, dimension = EMBEDDING_DIM): number[] {
  const vector = new Array<number>(dimension).fill(0);

  for (const token of tokenize(text)) {
    let hash = 2166136261;

    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }

    const slot = (hash >>> 0) % dimension;

    vector[slot] = (vector[slot] ?? 0) + 1;
  }

  let norm = 0;

  for (const value of vector) {
    norm += value * value;
  }

  norm = Math.sqrt(norm);

  return norm === 0 ? vector : vector.map((value) => value / norm);
}

/** Cosine similarity for equal-length vectors; 0 when either is empty. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;

  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number);
  }

  return dot;
}

interface Row {
  id: string;
  project: string;
  kind: string;
  title: string;
  content: string;
  tags: string;
  receipt_id: string | null;
  embedding: string;
  created_at: string;
}

function rowToMemory(row: Row): StoredMemory {
  return {
    id: row.id,
    project: row.project,
    kind: row.kind as MemoryKind,
    title: row.title,
    content: row.content,
    tags: JSON.parse(row.tags) as string[],
    ...(row.receipt_id === null ? {} : { receiptId: row.receipt_id }),
    createdAt: row.created_at
  };
}

/** Wraps user terms in double quotes so FTS operators stay literal. */
function ftsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter((term) => term !== "")
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" ");
}

export class VectorStore {
  private readonly db: DatabaseSync;
  private readonly ftsEnabled: boolean;

  constructor(options: { path?: string } = {}) {
    const filePath = options.path ?? process.env.ORBITAL_SYNAPSE_DB ?? DEFAULT_DB_PATH;

    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        receipt_id TEXT,
        embedding TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
      CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
      CREATE INDEX IF NOT EXISTS idx_memories_receipt ON memories(receipt_id);
    `);

    // FTS5 ships inside the node:sqlite bundle, but degrade gracefully on
    // exotic builds instead of refusing to start.
    try {
      this.db.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, title, content);"
      );
      this.ftsEnabled = true;
    } catch {
      this.ftsEnabled = false;
    }
  }

  insert(record: MemoryRecord): string {
    const id = record.id ?? randomUUID();
    const embedding = hashEmbed(`${record.title} ${record.content}`);

    this.db
      .prepare(
        `INSERT INTO memories (id, project, kind, title, content, tags, receipt_id, embedding, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        record.project,
        record.kind,
        record.title,
        record.content,
        JSON.stringify(record.tags ?? []),
        record.receiptId ?? null,
        JSON.stringify(embedding),
        new Date().toISOString()
      );

    if (this.ftsEnabled) {
      this.db
        .prepare("INSERT INTO memories_fts (id, title, content) VALUES (?, ?, ?)")
        .run(id, record.title, record.content);
    }

    return id;
  }

  get(id: string): StoredMemory | undefined {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
      | Row
      | undefined;

    return row === undefined ? undefined : rowToMemory(row);
  }

  /** Parsed embedding vector for one memory; undefined when absent. */
  getEmbedding(id: string): number[] | undefined {
    const row = this.db.prepare("SELECT embedding FROM memories WHERE id = ?").get(id) as
      | { embedding: string }
      | undefined;

    if (row === undefined) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(row.embedding) as unknown;

      return Array.isArray(parsed) && parsed.every((v) => typeof v === "number")
        ? parsed
        : undefined;
    } catch {
      return undefined;
    }
  }

  findByReceiptId(receiptId: string): StoredMemory | undefined {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE receipt_id = ? LIMIT 1")
      .get(receiptId) as Row | undefined;

    return row === undefined ? undefined : rowToMemory(row);
  }

  list(options: { project?: string; kind?: MemoryKind; limit?: number } = {}): StoredMemory[] {
    const clauses: string[] = [];
    const params: string[] = [];

    if (options.project !== undefined) {
      clauses.push("project = ?");
      params.push(options.project);
    }

    if (options.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = options.limit ?? 100;
    const rows = this.db
      .prepare(
        `SELECT * FROM memories ${where} ORDER BY created_at DESC LIMIT ${Number(limit)}`
      )
      .all(...params) as unknown as Row[];

    return rows.map(rowToMemory);
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number };

    return Number(row.n);
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);

    if (this.ftsEnabled) {
      this.db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
    }

    return Number(result.changes) > 0;
  }

  /**
   * Lexical candidates ranked best-first. FTS5 bm25 rank when available;
   * otherwise a LIKE scan over any-term matches (unranked).
   */
  searchLexical(query: string, limit = 25): { memory: StoredMemory; matchedTerms: number }[] {
    const terms = tokenize(query);

    if (terms.length === 0) {
      return [];
    }

    if (this.ftsEnabled) {
      const rows = this.db
        .prepare(
          `SELECT m.* FROM memories_fts f
           JOIN memories m ON m.id = f.id
           WHERE memories_fts MATCH ?
           ORDER BY rank
           LIMIT ${Number(limit)}`
        )
        .all(ftsQuery(query)) as unknown as Row[];

      return rows.map((row) => ({
        memory: rowToMemory(row),
        matchedTerms: terms.filter((term) =>
          `${row.title} ${row.content}`.toLowerCase().includes(term)
        ).length
      }));
    }

    const clauses = terms.map(() => "(title LIKE ? OR content LIKE ?)");
    const params = terms.flatMap((term) => [`%${term}%`, `%${term}%`]);
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE ${clauses.join(" OR ")} ORDER BY created_at DESC LIMIT ${Number(limit)}`
      )
      .all(...params) as unknown as Row[];

    return rows.map((row) => ({
      memory: rowToMemory(row),
      matchedTerms: terms.filter((term) =>
        `${row.title} ${row.content}`.toLowerCase().includes(term)
      ).length
    }));
  }

  close(): void {
    this.db.close();
  }
}
