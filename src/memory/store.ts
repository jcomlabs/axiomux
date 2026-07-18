import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { containsSecret, redactSecrets } from "../security/secrets.js";
import type { MemoryItem } from "../types.js";
import { cosineSimilarity, decodeVector, defaultVectorDimensions, encodeVector, localTextVector, vectorModelName } from "./vector.js";

const MEMORY_CHARACTER_LIMIT = 24_000;
const DOCUMENT_CHARACTER_LIMIT = 1_000_000;
const CHUNK_CHARACTERS = 20_000;
const CHUNK_OVERLAP = 600;
const MAX_VECTOR_SCAN = 10_000;
const RANKING_VERSION = "hybrid-rrf-mmr-v1";

interface MemoryRow {
  id: number;
  content: string;
  kind: MemoryItem["kind"];
  review_status: MemoryItem["reviewStatus"];
  confidence: number;
  source_uri: string;
  source_label: string;
  created_at: string;
  importance: number;
  scope: string;
  last_accessed_at: string | null;
  access_count: number;
  expires_at: string | null;
  superseded_by: number | null;
}

interface VectorRow extends MemoryRow {
  vector: Uint8Array;
  dimensions: number;
}

interface LearningCandidateRow {
  id: number;
  session_id: string;
  title: string;
  evidence: string;
  status: "pending" | "converted" | "rejected";
  review_status: "pending" | "approved" | "rejected";
  review_notes: string | null;
  converted_skill_id: string | null;
  created_at: string;
  reviewed_at: string | null;
  converted_at: string | null;
}

interface SourceDocumentRow {
  id: number;
  source_uri: string;
  source_label: string;
  scope: string;
  content_hash: string;
  total_characters: number;
  chunk_count: number;
  created_at: string;
}

export interface MemoryStats {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  active: number;
  expired: number;
  superseded: number;
  messages: number;
  recalls: number;
  learningCandidates: number;
  sourceDocuments: number;
}

export interface SessionSummary {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messages: number;
}

export interface SourceDocument {
  id: number;
  sourceUri: string;
  sourceLabel: string;
  scope: string;
  contentHash: string;
  totalCharacters: number;
  chunkCount: number;
  memoryIds: number[];
  createdAt: string;
}

export interface SourceIngestion {
  documentId: number;
  memoryIds: number[];
  chunkCount: number;
}

export interface LearningCandidate {
  id: number;
  sessionId: string;
  title: string;
  evidence: string;
  status: "pending" | "converted" | "rejected";
  reviewStatus: "pending" | "approved" | "rejected";
  reviewNotes?: string;
  convertedSkillId?: string;
  createdAt: string;
  reviewedAt?: string;
  convertedAt?: string;
}

export type MemoryRelationType = "contradicts" | "duplicates" | "supports";

export interface MemoryRelation {
  id: number;
  leftMemoryId: number;
  rightMemoryId: number;
  relation: MemoryRelationType;
  note?: string;
  createdAt: string;
}

export interface PotentialContradiction {
  memory: MemoryItem;
  similarity: number;
  reason: string;
}

interface RankedCandidate {
  row: MemoryRow;
  vector: Float32Array;
  score: number;
  lexicalRank?: number;
  vectorRank?: number;
  vectorSimilarity: number;
}

export class MemoryStore {
  readonly database: DatabaseSync;
  private readonly vectorDimensions = defaultVectorDimensions();
  private readonly vectorModel = vectorModelName(this.vectorDimensions);

  constructor(
    path: string,
    private readonly halfLifeDays = 120,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
    this.backfillVectors();
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
        content TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS memory_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('evidence','instruction','preference','procedure')),
        review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','approved','rejected')),
        confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence >= 0 AND confidence <= 1),
        importance REAL NOT NULL DEFAULT 0.5 CHECK(importance >= 0 AND importance <= 1),
        scope TEXT NOT NULL DEFAULT 'global',
        source_uri TEXT NOT NULL,
        source_label TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        reviewed_at TEXT,
        last_accessed_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,
        superseded_by INTEGER REFERENCES memory_items(id)
      );
      CREATE TABLE IF NOT EXISTS memory_idempotency (
        idempotency_key TEXT PRIMARY KEY,
        memory_id INTEGER NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
        payload_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, source_label, content='memory_items', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory_items BEGIN
        INSERT INTO memory_fts(rowid, content, source_label) VALUES (new.id, new.content, new.source_label);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory_items BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, content, source_label) VALUES ('delete', old.id, old.content, old.source_label);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory_items BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, content, source_label) VALUES ('delete', old.id, old.content, old.source_label);
        INSERT INTO memory_fts(rowid, content, source_label) VALUES (new.id, new.content, new.source_label);
      END;
      CREATE TABLE IF NOT EXISTS recall_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        query TEXT NOT NULL,
        memory_ids TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS learning_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        evidence TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','converted','rejected')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id INTEGER PRIMARY KEY REFERENCES memory_items(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector BLOB NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS memory_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id INTEGER NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        signal INTEGER NOT NULL CHECK(signal IN (-1,0,1)),
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS memory_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        left_memory_id INTEGER NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
        right_memory_id INTEGER NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
        relation TEXT NOT NULL CHECK(relation IN ('contradicts','duplicates','supports')),
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(left_memory_id, right_memory_id, relation),
        CHECK(left_memory_id < right_memory_id)
      );
      CREATE TABLE IF NOT EXISTS source_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_uri TEXT NOT NULL,
        source_label TEXT NOT NULL,
        scope TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        total_characters INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(scope, source_uri, content_hash)
      );
      CREATE TABLE IF NOT EXISTS source_chunks (
        document_id INTEGER NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        memory_id INTEGER NOT NULL UNIQUE REFERENCES memory_items(id) ON DELETE CASCADE,
        start_character INTEGER NOT NULL,
        end_character INTEGER NOT NULL,
        chunk_hash TEXT NOT NULL,
        PRIMARY KEY(document_id, ordinal)
      );
    `);
    this.ensureColumn("memory_items", "importance", "REAL NOT NULL DEFAULT 0.5");
    this.ensureColumn("memory_items", "scope", "TEXT NOT NULL DEFAULT 'global'");
    this.ensureColumn("memory_items", "last_accessed_at", "TEXT");
    this.ensureColumn("memory_items", "access_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("memory_items", "expires_at", "TEXT");
    this.ensureColumn("memory_items", "superseded_by", "INTEGER");
    this.ensureColumn("recall_log", "ranking_version", "TEXT");
    this.ensureColumn("recall_log", "scores_json", "TEXT");
    this.ensureColumn("learning_candidates", "review_status", "TEXT NOT NULL DEFAULT 'pending'");
    this.ensureColumn("learning_candidates", "review_notes", "TEXT");
    this.ensureColumn("learning_candidates", "reviewed_at", "TEXT");
    this.ensureColumn("learning_candidates", "converted_skill_id", "TEXT");
    this.ensureColumn("learning_candidates", "converted_at", "TEXT");
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS memory_active_idx ON memory_items(review_status, superseded_by, expires_at);
      CREATE INDEX IF NOT EXISTS memory_scope_idx ON memory_items(scope, created_at DESC);
      CREATE INDEX IF NOT EXISTS memory_feedback_idx ON memory_feedback(memory_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS learning_candidates_state_idx ON learning_candidates(status, review_status, created_at DESC);
      CREATE INDEX IF NOT EXISTS source_documents_uri_idx ON source_documents(scope, source_uri, created_at DESC);
      PRAGMA user_version=3;
    `);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private backfillVectors(): void {
    const rows = this.database
      .prepare(`SELECT m.id, m.content FROM memory_items m
      LEFT JOIN memory_embeddings e ON e.memory_id=m.id AND e.model=? AND e.dimensions=?
      WHERE e.memory_id IS NULL`)
      .all(this.vectorModel, this.vectorDimensions) as Array<{ id: number; content: string }>;
    if (rows.length === 0) return;
    const upsert = this.database.prepare(`INSERT INTO memory_embeddings(memory_id, model, dimensions, vector)
      VALUES (?, ?, ?, ?) ON CONFLICT(memory_id) DO UPDATE SET model=excluded.model, dimensions=excluded.dimensions,
      vector=excluded.vector, updated_at=datetime('now')`);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) upsert.run(row.id, this.vectorModel, this.vectorDimensions, encodeVector(localTextVector(row.content, this.vectorDimensions)));
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  createSession(id: string, title?: string): void {
    this.database.prepare("INSERT OR IGNORE INTO sessions(id, title) VALUES (?, ?)").run(id, title ?? null);
  }

  addMessage(sessionId: string, role: "user" | "assistant" | "system" | "tool", content: string, model?: string): number {
    this.createSession(sessionId);
    const provider = model?.includes("/") ? model.split("/", 1)[0] : undefined;
    const safeContent = redactSecrets(content).slice(0, 200_000);
    const result = this.database
      .prepare("INSERT INTO messages(session_id, role, content, provider, model) VALUES (?, ?, ?, ?, ?)")
      .run(sessionId, role, safeContent, provider ?? null, model ?? null);
    this.database.prepare("UPDATE sessions SET updated_at=datetime('now') WHERE id=?").run(sessionId);
    return Number(result.lastInsertRowid);
  }

  recentMessages(sessionId: string, limit = 16): Array<{ role: string; content: string }> {
    const rows = this.database.prepare("SELECT role, content FROM messages WHERE session_id=? ORDER BY id DESC LIMIT ?").all(sessionId, limit) as Array<{
      role: string;
      content: string;
    }>;
    return rows.reverse();
  }

  listSessions(limit = 50): SessionSummary[] {
    const rows = this.database
      .prepare(`SELECT s.id, s.title, s.created_at, s.updated_at, COUNT(m.id) messages
      FROM sessions s LEFT JOIN messages m ON m.session_id=s.id
      GROUP BY s.id ORDER BY s.updated_at DESC LIMIT ?`)
      .all(limit) as Array<{
      id: string;
      title: string | null;
      created_at: string;
      updated_at: string;
      messages: number;
    }>;
    return rows.map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at, messages: Number(row.messages) }));
  }

  forgetSession(sessionId: string): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM recall_log WHERE session_id=?").run(sessionId);
      this.database.prepare("DELETE FROM learning_candidates WHERE session_id=?").run(sessionId);
      this.database.prepare("DELETE FROM memory_feedback WHERE session_id=?").run(sessionId);
      const result = this.database.prepare("DELETE FROM sessions WHERE id=?").run(sessionId);
      this.database.exec("COMMIT");
      return result.changes > 0;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  addMemory(input: {
    content: string;
    kind?: MemoryItem["kind"];
    reviewStatus?: MemoryItem["reviewStatus"];
    confidence?: number;
    importance?: number;
    scope?: string;
    expiresAt?: string;
    sourceUri: string;
    sourceLabel: string;
    /** Stable workflow key used to make a committed effect safe to retry. */
    idempotencyKey?: string;
  }): number {
    const normalized = normalizeMemoryInput(input);
    const idempotencyKey = input.idempotencyKey ? validateMemoryIdempotencyKey(input.idempotencyKey) : undefined;
    const payloadHash = hashNormalizedMemory(normalized);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (idempotencyKey) {
        const existing = this.database.prepare("SELECT memory_id, payload_hash FROM memory_idempotency WHERE idempotency_key=?").get(idempotencyKey) as
          | { memory_id: number; payload_hash: string }
          | undefined;
        if (existing) {
          if (existing.payload_hash !== payloadHash) throw new Error("Memory idempotency key was reused with a different payload");
          this.database.exec("COMMIT");
          return existing.memory_id;
        }
      }
      const id = this.insertMemory(normalized);
      if (idempotencyKey) {
        this.database.prepare("INSERT INTO memory_idempotency(idempotency_key, memory_id, payload_hash) VALUES (?, ?, ?)").run(idempotencyKey, id, payloadHash);
      }
      this.database.exec("COMMIT");
      return id;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  addSourceDocument(input: {
    content: string;
    kind?: MemoryItem["kind"];
    reviewStatus?: MemoryItem["reviewStatus"];
    confidence?: number;
    importance?: number;
    scope?: string;
    sourceUri: string;
    sourceLabel: string;
  }): SourceIngestion {
    const content = sanitizeDocument(input.content);
    const scope = sanitizeScope(input.scope ?? "global");
    const sourceUri = sanitizeMetadata(input.sourceUri, "sourceUri", 2_000);
    const sourceLabel = sanitizeMetadata(input.sourceLabel, "sourceLabel", 300);
    const hash = createHash("sha256").update(content).digest("hex");
    const existing = this.database.prepare(`SELECT id FROM source_documents WHERE scope=? AND source_uri=? AND content_hash=?`).get(scope, sourceUri, hash) as
      | { id: number }
      | undefined;
    if (existing) {
      const ids = this.documentMemoryIds(existing.id);
      if (ids.length > 0) return { documentId: existing.id, memoryIds: ids, chunkCount: ids.length };
      this.database.prepare("DELETE FROM source_documents WHERE id=?").run(existing.id);
    }

    const chunks = chunkDocument(content);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const documentResult = this.database
        .prepare(`INSERT INTO source_documents
        (source_uri, source_label, scope, content_hash, total_characters, chunk_count) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(sourceUri, sourceLabel, scope, hash, content.length, chunks.length);
      const documentId = Number(documentResult.lastInsertRowid);
      const memoryIds: number[] = [];
      const insertChunk = this.database.prepare(`INSERT INTO source_chunks
        (document_id, ordinal, memory_id, start_character, end_character, chunk_hash) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const [index, chunk] of chunks.entries()) {
        const chunkLabel = chunks.length === 1 ? sourceLabel : `${sourceLabel.slice(0, 260)} [chunk ${index + 1}/${chunks.length}]`;
        const memoryId = this.insertMemory(
          normalizeMemoryInput({
            content: chunk.content,
            ...(input.kind ? { kind: input.kind } : {}),
            ...(input.reviewStatus ? { reviewStatus: input.reviewStatus } : {}),
            ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
            ...(input.importance !== undefined ? { importance: input.importance } : {}),
            scope,
            sourceUri,
            sourceLabel: chunkLabel,
          }),
        );
        memoryIds.push(memoryId);
        insertChunk.run(documentId, index, memoryId, chunk.start, chunk.end, createHash("sha256").update(chunk.content).digest("hex"));
      }
      this.database.exec("COMMIT");
      return { documentId, memoryIds, chunkCount: chunks.length };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private insertMemory(input: NormalizedMemoryInput): number {
    const hash = createHash("sha256").update(`${input.kind}\0${input.scope}\0${input.content}\0${input.sourceUri}`).digest("hex");
    const existing = this.database.prepare("SELECT id FROM memory_items WHERE content_hash=?").get(hash) as { id: number } | undefined;
    if (existing) {
      this.upsertVector(existing.id, input.content);
      return existing.id;
    }
    const result = this.database
      .prepare(`INSERT INTO memory_items
      (content, kind, review_status, confidence, importance, scope, source_uri, source_label, content_hash, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        input.content,
        input.kind,
        input.reviewStatus,
        input.confidence,
        input.importance,
        input.scope,
        input.sourceUri,
        input.sourceLabel,
        hash,
        input.expiresAt,
      );
    const id = Number(result.lastInsertRowid);
    this.upsertVector(id, input.content);
    return id;
  }

  private upsertVector(id: number, content: string): void {
    this.database
      .prepare(`INSERT INTO memory_embeddings(memory_id, model, dimensions, vector)
      VALUES (?, ?, ?, ?) ON CONFLICT(memory_id) DO UPDATE SET model=excluded.model, dimensions=excluded.dimensions,
      vector=excluded.vector, updated_at=datetime('now')`)
      .run(id, this.vectorModel, this.vectorDimensions, encodeVector(localTextVector(content, this.vectorDimensions)));
  }

  reviewMemory(id: number, status: "approved" | "rejected"): boolean {
    const result = this.database.prepare("UPDATE memory_items SET review_status=?, reviewed_at=datetime('now') WHERE id=?").run(status, id);
    return result.changes > 0;
  }

  supersedeMemory(previousId: number, replacementId: number): boolean {
    if (previousId === replacementId || !this.getMemory(replacementId)) return false;
    const result = this.database.prepare("UPDATE memory_items SET superseded_by=? WHERE id=? AND superseded_by IS NULL").run(replacementId, previousId);
    return result.changes > 0;
  }

  forgetMemory(id: number): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE memory_items SET superseded_by=NULL WHERE superseded_by=?").run(id);
      const result = this.database.prepare("DELETE FROM memory_items WHERE id=?").run(id);
      this.database.exec("COMMIT");
      return result.changes > 0;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getMemory(id: number): MemoryItem | undefined {
    const row = this.database.prepare("SELECT * FROM memory_items WHERE id=?").get(id) as MemoryRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  listMemories(status?: MemoryItem["reviewStatus"], limit = 50): MemoryItem[] {
    const rows = status
      ? (this.database.prepare("SELECT * FROM memory_items WHERE review_status=? ORDER BY id DESC LIMIT ?").all(status, limit) as unknown as MemoryRow[])
      : (this.database.prepare("SELECT * FROM memory_items ORDER BY id DESC LIMIT ?").all(limit) as unknown as MemoryRow[]);
    return rows.map(mapRow);
  }

  recall(query: string, sessionId: string, limit = 8, scope?: string, logRecall = true): MemoryItem[] {
    const cleanQuery = query.trim();
    const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    if (!cleanQuery) return this.finishRecall([], sessionId, query, logRecall);
    const candidateLimit = Math.max(40, Math.min(400, boundedLimit * 12));
    const active = "m.review_status != 'rejected' AND m.superseded_by IS NULL AND (m.expires_at IS NULL OR m.expires_at > datetime('now'))";
    const scopeValue = scope ? sanitizeScope(scope) : undefined;
    const tokens =
      cleanQuery
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}_-]{2,}/gu)
        ?.slice(0, 20) ?? [];
    let lexicalRows: MemoryRow[] = [];
    if (tokens.length > 0) {
      const fts = [...new Set(tokens)].map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
      lexicalRows = scopeValue
        ? (this.database
            .prepare(`SELECT m.* FROM memory_fts f JOIN memory_items m ON m.id=f.rowid
          WHERE memory_fts MATCH ? AND ${active} AND m.scope IN (?, 'global') ORDER BY bm25(memory_fts) LIMIT ?`)
            .all(fts, scopeValue, candidateLimit) as unknown as MemoryRow[])
        : (this.database
            .prepare(`SELECT m.* FROM memory_fts f JOIN memory_items m ON m.id=f.rowid
          WHERE memory_fts MATCH ? AND ${active} ORDER BY bm25(memory_fts) LIMIT ?`)
            .all(fts, candidateLimit) as unknown as MemoryRow[]);
    }

    const vectorRows = scopeValue
      ? (this.database
          .prepare(`SELECT m.*, e.vector, e.dimensions FROM memory_items m JOIN memory_embeddings e ON e.memory_id=m.id
        WHERE ${active} AND m.scope IN (?, 'global') AND e.model=? AND e.dimensions=? ORDER BY m.id DESC LIMIT ?`)
          .all(scopeValue, this.vectorModel, this.vectorDimensions, MAX_VECTOR_SCAN) as unknown as VectorRow[])
      : (this.database
          .prepare(`SELECT m.*, e.vector, e.dimensions FROM memory_items m JOIN memory_embeddings e ON e.memory_id=m.id
        WHERE ${active} AND e.model=? AND e.dimensions=? ORDER BY m.id DESC LIMIT ?`)
          .all(this.vectorModel, this.vectorDimensions, MAX_VECTOR_SCAN) as unknown as VectorRow[]);
    const queryVector = localTextVector(cleanQuery, this.vectorDimensions);
    const vectorRanked = vectorRows
      .map((row) => ({
        row,
        vector: decodeVector(row.vector, row.dimensions),
        similarity: cosineSimilarity(queryVector, decodeVector(row.vector, row.dimensions) ?? new Float32Array(this.vectorDimensions)),
      }))
      .filter((item): item is { row: VectorRow; vector: Float32Array; similarity: number } => Boolean(item.vector) && item.similarity >= 0.04)
      .sort((left, right) => right.similarity - left.similarity || right.row.id - left.row.id)
      .slice(0, candidateLimit);

    const feedback = this.feedbackScores([...new Set([...lexicalRows.map((row) => row.id), ...vectorRanked.map((item) => item.row.id)])]);
    const candidates = new Map<number, RankedCandidate>();
    for (const [index, row] of lexicalRows.entries()) {
      const vector = this.vectorForMemory(row.id) ?? localTextVector(row.content, this.vectorDimensions);
      candidates.set(row.id, { row, vector, score: 0, lexicalRank: index + 1, vectorSimilarity: 0 });
    }
    for (const [index, item] of vectorRanked.entries()) {
      const existing = candidates.get(item.row.id);
      candidates.set(item.row.id, {
        row: item.row,
        vector: item.vector,
        score: 0,
        ...(existing?.lexicalRank ? { lexicalRank: existing.lexicalRank } : {}),
        vectorRank: index + 1,
        vectorSimilarity: item.similarity,
      });
    }
    if (candidates.size === 0) {
      const like = `%${cleanQuery.slice(0, 80)}%`;
      const fallback = scopeValue
        ? (this.database
            .prepare(`SELECT * FROM memory_items m WHERE ${active} AND m.scope IN (?, 'global') AND m.content LIKE ? LIMIT ?`)
            .all(scopeValue, like, candidateLimit) as unknown as MemoryRow[])
        : (this.database
            .prepare(`SELECT * FROM memory_items m WHERE ${active} AND m.content LIKE ? LIMIT ?`)
            .all(like, candidateLimit) as unknown as MemoryRow[]);
      for (const [index, row] of fallback.entries())
        candidates.set(row.id, {
          row,
          vector: this.vectorForMemory(row.id) ?? localTextVector(row.content, this.vectorDimensions),
          score: 0,
          lexicalRank: index + 1,
          vectorSimilarity: 0,
        });
    }

    const ranked = [...candidates.values()];
    for (const candidate of ranked) candidate.score = rankCandidate(candidate, this.halfLifeDays, feedback.get(candidate.row.id) ?? 0);
    ranked.sort((left, right) => right.score - left.score || right.row.id - left.row.id);
    const selected = diversify(ranked, boundedLimit);
    return this.finishRecall(selected, sessionId, query, logRecall);
  }

  private finishRecall(rows: RankedCandidate[], sessionId: string, query: string, logRecall: boolean): MemoryItem[] {
    if (rows.length > 0) {
      const update = this.database.prepare("UPDATE memory_items SET access_count=access_count+1, last_accessed_at=datetime('now') WHERE id=?");
      for (const item of rows) update.run(item.row.id);
    }
    if (logRecall) {
      this.createSession(sessionId);
      this.database
        .prepare(`INSERT INTO recall_log(session_id, query, memory_ids, ranking_version, scores_json)
        VALUES (?, ?, ?, ?, ?)`)
        .run(
          sessionId,
          redactSecrets(query).slice(0, 12_000),
          JSON.stringify(rows.map((item) => item.row.id)),
          RANKING_VERSION,
          JSON.stringify(
            rows.map((item) => ({
              id: item.row.id,
              score: round(item.score),
              lexicalRank: item.lexicalRank,
              vectorRank: item.vectorRank,
              vectorSimilarity: round(item.vectorSimilarity),
            })),
          ),
        );
    }
    return rows.map((item) => mapRow(item.row));
  }

  recordRecallFeedback(sessionId: string, memoryId: number, signal: -1 | 0 | 1, note?: string): number {
    if (!this.getMemory(memoryId)) throw new Error(`Memory ${memoryId} does not exist`);
    if (![-1, 0, 1].includes(signal)) throw new Error("Feedback signal must be -1, 0 or 1");
    this.createSession(sessionId);
    const safeNote = note ? sanitizeOptionalText(note, "feedback note", 2_000) : null;
    const result = this.database
      .prepare("INSERT INTO memory_feedback(memory_id, session_id, signal, note) VALUES (?, ?, ?, ?)")
      .run(memoryId, sessionId, signal, safeNote);
    return Number(result.lastInsertRowid);
  }

  private feedbackScores(memoryIds: number[]): Map<number, number> {
    if (memoryIds.length === 0) return new Map();
    const placeholders = memoryIds.map(() => "?").join(",");
    const rows = this.database
      .prepare(`SELECT memory_id, AVG(signal) score FROM memory_feedback
      WHERE memory_id IN (${placeholders}) GROUP BY memory_id`)
      .all(...memoryIds) as Array<{ memory_id: number; score: number }>;
    return new Map(rows.map((row) => [row.memory_id, Number(row.score)]));
  }

  linkMemories(leftId: number, rightId: number, relation: MemoryRelationType, note?: string): number {
    if (leftId === rightId || !this.getMemory(leftId) || !this.getMemory(rightId)) throw new Error("Relations require two distinct existing memories");
    if (!["contradicts", "duplicates", "supports"].includes(relation)) throw new Error("Invalid memory relation");
    const [left, right] = leftId < rightId ? [leftId, rightId] : [rightId, leftId];
    const safeNote = note ? sanitizeOptionalText(note, "relation note", 2_000) : null;
    this.database
      .prepare(`INSERT INTO memory_relations(left_memory_id, right_memory_id, relation, note)
      VALUES (?, ?, ?, ?) ON CONFLICT(left_memory_id, right_memory_id, relation) DO UPDATE SET note=excluded.note`)
      .run(left, right, relation, safeNote);
    const row = this.database
      .prepare(`SELECT id FROM memory_relations WHERE left_memory_id=? AND right_memory_id=? AND relation=?`)
      .get(left, right, relation) as { id: number };
    return row.id;
  }

  listMemoryRelations(memoryId?: number): MemoryRelation[] {
    const rows = memoryId
      ? this.database.prepare(`SELECT * FROM memory_relations WHERE left_memory_id=? OR right_memory_id=? ORDER BY id DESC`).all(memoryId, memoryId)
      : this.database.prepare("SELECT * FROM memory_relations ORDER BY id DESC").all();
    return (
      rows as Array<{ id: number; left_memory_id: number; right_memory_id: number; relation: MemoryRelationType; note: string | null; created_at: string }>
    ).map((row) => ({
      id: row.id,
      leftMemoryId: row.left_memory_id,
      rightMemoryId: row.right_memory_id,
      relation: row.relation,
      ...(row.note ? { note: row.note } : {}),
      createdAt: row.created_at,
    }));
  }

  findPotentialContradictions(memoryId: number, limit = 10): PotentialContradiction[] {
    const source = this.getMemory(memoryId);
    const sourceVector = this.vectorForMemory(memoryId);
    if (!source || !sourceVector) return [];
    const sourcePolarity = polarity(source.content);
    if (sourcePolarity === 0) return [];
    const active = "m.id != ? AND m.review_status != 'rejected' AND m.superseded_by IS NULL AND (m.expires_at IS NULL OR m.expires_at > datetime('now'))";
    const rows = this.database
      .prepare(`SELECT m.*, e.vector, e.dimensions FROM memory_items m JOIN memory_embeddings e ON e.memory_id=m.id
      WHERE ${active} AND m.scope IN (?, 'global') AND e.model=? AND e.dimensions=? LIMIT ?`)
      .all(memoryId, source.scope, this.vectorModel, this.vectorDimensions, MAX_VECTOR_SCAN) as unknown as VectorRow[];
    return rows
      .map((row) => ({ row, vector: decodeVector(row.vector, row.dimensions) }))
      .filter((item): item is { row: VectorRow; vector: Float32Array } => Boolean(item.vector) && polarity(item.row.content) === -sourcePolarity)
      .map((item) => ({
        memory: mapRow(item.row),
        similarity: cosineSimilarity(sourceVector, item.vector),
        reason: "Similar wording has opposite explicit polarity; human review is required.",
      }))
      .filter((item) => item.similarity >= 0.45)
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, Math.max(1, Math.min(50, limit)));
  }

  private vectorForMemory(memoryId: number): Float32Array | undefined {
    const row = this.database.prepare(`SELECT vector, dimensions FROM memory_embeddings WHERE memory_id=? AND model=?`).get(memoryId, this.vectorModel) as
      | { vector: Uint8Array; dimensions: number }
      | undefined;
    return row ? decodeVector(row.vector, row.dimensions) : undefined;
  }

  stats(): MemoryStats {
    const memory = this.database
      .prepare(`SELECT
      COUNT(*) total,
      COALESCE(SUM(review_status='pending'),0) pending,
      COALESCE(SUM(review_status='approved'),0) approved,
      COALESCE(SUM(review_status='rejected'),0) rejected,
      COALESCE(SUM(review_status!='rejected' AND superseded_by IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))),0) active,
      COALESCE(SUM(expires_at IS NOT NULL AND expires_at <= datetime('now')),0) expired,
      COALESCE(SUM(superseded_by IS NOT NULL),0) superseded
      FROM memory_items`)
      .get() as Record<string, number>;
    const messages = this.count("messages");
    const recalls = this.count("recall_log");
    return {
      total: Number(memory.total),
      pending: Number(memory.pending),
      approved: Number(memory.approved),
      rejected: Number(memory.rejected),
      active: Number(memory.active),
      expired: Number(memory.expired),
      superseded: Number(memory.superseded),
      messages,
      recalls,
      learningCandidates: this.count("learning_candidates"),
      sourceDocuments: this.count("source_documents"),
    };
  }

  private count(table: "messages" | "recall_log" | "learning_candidates" | "source_documents"): number {
    const row = this.database.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number };
    return Number(row.count);
  }

  exportPortable(): {
    version: 2;
    exportedAt: string;
    ranking: { algorithm: string; vectorModel: string };
    memories: MemoryItem[];
    sourceDocuments: SourceDocument[];
    relations: MemoryRelation[];
    learningCandidates: LearningCandidate[];
    feedback: Array<{ memoryId: number; sessionId: string; signal: number; note?: string; createdAt: string }>;
  } {
    const feedbackRows = this.database.prepare("SELECT memory_id, session_id, signal, note, created_at FROM memory_feedback ORDER BY id").all() as Array<{
      memory_id: number;
      session_id: string;
      signal: number;
      note: string | null;
      created_at: string;
    }>;
    return {
      version: 2,
      exportedAt: new Date().toISOString(),
      ranking: { algorithm: RANKING_VERSION, vectorModel: this.vectorModel },
      memories: this.listMemories(undefined, 100_000),
      sourceDocuments: this.listSourceDocuments(100_000),
      relations: this.listMemoryRelations(),
      learningCandidates: this.listLearningCandidates(undefined, 100_000),
      feedback: feedbackRows.map((row) => ({
        memoryId: row.memory_id,
        sessionId: row.session_id,
        signal: row.signal,
        ...(row.note ? { note: row.note } : {}),
        createdAt: row.created_at,
      })),
    };
  }

  listSourceDocuments(limit = 100): SourceDocument[] {
    const rows = this.database.prepare("SELECT * FROM source_documents ORDER BY id DESC LIMIT ?").all(limit) as unknown as SourceDocumentRow[];
    return rows.map((row) => mapDocument(row, this.documentMemoryIds(row.id)));
  }

  private documentMemoryIds(documentId: number): number[] {
    const rows = this.database.prepare("SELECT memory_id FROM source_chunks WHERE document_id=? ORDER BY ordinal").all(documentId) as Array<{
      memory_id: number;
    }>;
    return rows.map((row) => row.memory_id);
  }

  addLearningCandidate(sessionId: string, title: string, evidence: string): number {
    const safeSession = sanitizeMetadata(sessionId, "sessionId", 300);
    const safeTitle = sanitizeMetadata(title.replace(/\s+/g, " "), "candidate title", 300);
    const safeEvidence = sanitizeMemory(evidence);
    const existing = this.database
      .prepare(`SELECT id FROM learning_candidates
      WHERE session_id=? AND title=? AND evidence=? AND status='pending' ORDER BY id DESC LIMIT 1`)
      .get(safeSession, safeTitle, safeEvidence) as { id: number } | undefined;
    if (existing) return existing.id;
    const result = this.database
      .prepare("INSERT INTO learning_candidates(session_id, title, evidence) VALUES (?, ?, ?)")
      .run(safeSession, safeTitle, safeEvidence);
    return Number(result.lastInsertRowid);
  }

  getLearningCandidate(id: number): LearningCandidate | undefined {
    const row = this.database.prepare("SELECT * FROM learning_candidates WHERE id=?").get(id) as LearningCandidateRow | undefined;
    return row ? mapLearningCandidate(row) : undefined;
  }

  listLearningCandidates(status?: LearningCandidate["status"], limit = 100): LearningCandidate[] {
    const rows = status
      ? this.database.prepare("SELECT * FROM learning_candidates WHERE status=? ORDER BY id DESC LIMIT ?").all(status, limit)
      : this.database.prepare("SELECT * FROM learning_candidates ORDER BY id DESC LIMIT ?").all(limit);
    return (rows as unknown as LearningCandidateRow[]).map(mapLearningCandidate);
  }

  reviewLearningCandidate(id: number, decision: "approved" | "rejected", notes?: string): LearningCandidate {
    const candidate = this.getLearningCandidate(id);
    if (!candidate) throw new Error(`Learning candidate ${id} does not exist`);
    if (candidate.status === "converted") throw new Error("A converted learning candidate cannot be reviewed again");
    const safeNotes = notes ? sanitizeOptionalText(notes, "review notes", 4_000) : null;
    const lifecycle = decision === "rejected" ? "rejected" : "pending";
    this.database
      .prepare(`UPDATE learning_candidates SET review_status=?, status=?, review_notes=?, reviewed_at=datetime('now') WHERE id=?`)
      .run(decision, lifecycle, safeNotes, id);
    return this.getLearningCandidate(id) as LearningCandidate;
  }

  markLearningCandidateConverted(id: number, skillId: string): LearningCandidate {
    const candidate = this.getLearningCandidate(id);
    if (!candidate) throw new Error(`Learning candidate ${id} does not exist`);
    if (candidate.reviewStatus !== "approved" || candidate.status !== "pending") {
      throw new Error("Learning candidate must be pending and human-approved before conversion");
    }
    const safeSkillId = sanitizeSkillId(skillId);
    this.database
      .prepare(`UPDATE learning_candidates SET status='converted', converted_skill_id=?, converted_at=datetime('now') WHERE id=?`)
      .run(safeSkillId, id);
    return this.getLearningCandidate(id) as LearningCandidate;
  }
}

function validateMemoryIdempotencyKey(value: string): string {
  const key = value.trim();
  if (!/^wf_[a-f0-9]{64}$/.test(key)) throw new Error("Memory idempotency key is invalid");
  return key;
}

function hashNormalizedMemory(input: NormalizedMemoryInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.content,
        input.kind,
        input.reviewStatus,
        input.confidence,
        input.importance,
        input.scope,
        input.expiresAt,
        input.sourceUri,
        input.sourceLabel,
      ]),
    )
    .digest("hex");
}

interface NormalizedMemoryInput {
  content: string;
  kind: MemoryItem["kind"];
  reviewStatus: MemoryItem["reviewStatus"];
  confidence: number;
  importance: number;
  scope: string;
  expiresAt: string | null;
  sourceUri: string;
  sourceLabel: string;
}

function normalizeMemoryInput(input: {
  content: string;
  kind?: MemoryItem["kind"];
  reviewStatus?: MemoryItem["reviewStatus"];
  confidence?: number;
  importance?: number;
  scope?: string;
  expiresAt?: string;
  sourceUri: string;
  sourceLabel: string;
}): NormalizedMemoryInput {
  return {
    content: sanitizeMemory(input.content),
    kind: input.kind ?? "evidence",
    reviewStatus: input.reviewStatus ?? "pending",
    confidence: bounded(input.confidence ?? 0.5, "confidence"),
    importance: bounded(input.importance ?? 0.5, "importance"),
    scope: sanitizeScope(input.scope ?? "global"),
    expiresAt: normalizeDate(input.expiresAt),
    sourceUri: sanitizeMetadata(input.sourceUri, "sourceUri", 2_000),
    sourceLabel: sanitizeMetadata(input.sourceLabel, "sourceLabel", 300),
  };
}

function mapRow(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    content: row.content,
    kind: row.kind,
    reviewStatus: row.review_status,
    confidence: row.confidence,
    importance: row.importance,
    scope: row.scope,
    sourceUri: row.source_uri,
    sourceLabel: row.source_label,
    createdAt: row.created_at,
    ...(row.last_accessed_at ? { lastAccessedAt: row.last_accessed_at } : {}),
    accessCount: row.access_count,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
  };
}

function mapDocument(row: SourceDocumentRow, memoryIds: number[]): SourceDocument {
  return {
    id: row.id,
    sourceUri: row.source_uri,
    sourceLabel: row.source_label,
    scope: row.scope,
    contentHash: row.content_hash,
    totalCharacters: row.total_characters,
    chunkCount: row.chunk_count,
    memoryIds,
    createdAt: row.created_at,
  };
}

function mapLearningCandidate(row: LearningCandidateRow): LearningCandidate {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    evidence: row.evidence,
    status: row.status,
    reviewStatus: row.review_status,
    ...(row.review_notes ? { reviewNotes: row.review_notes } : {}),
    ...(row.converted_skill_id ? { convertedSkillId: row.converted_skill_id } : {}),
    createdAt: row.created_at,
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
    ...(row.converted_at ? { convertedAt: row.converted_at } : {}),
  };
}

export function chunkDocument(
  content: string,
  maxCharacters = CHUNK_CHARACTERS,
  overlap = CHUNK_OVERLAP,
): Array<{ content: string; start: number; end: number }> {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 2_000 || maxCharacters > MEMORY_CHARACTER_LIMIT) throw new Error("Invalid chunk size");
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= Math.floor(maxCharacters / 3)) throw new Error("Invalid chunk overlap");
  const result: Array<{ content: string; start: number; end: number }> = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(content.length, start + maxCharacters);
    if (end < content.length) end = chooseBoundary(content, start, end, maxCharacters);
    const raw = content.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const chunkStart = start + leading;
    const chunkEnd = end - trailing;
    if (chunkEnd > chunkStart) result.push({ content: content.slice(chunkStart, chunkEnd), start: chunkStart, end: chunkEnd });
    if (end >= content.length) break;
    const next = Math.max(start + 1, end - overlap);
    start = next;
  }
  if (result.length === 0) throw new Error("Source content cannot be empty");
  return result;
}

function chooseBoundary(content: string, start: number, proposedEnd: number, maxCharacters: number): number {
  const minimum = start + Math.floor(maxCharacters * 0.6);
  for (const marker of ["\n\n", "\n", ". ", "! ", "? ", " "]) {
    const index = content.lastIndexOf(marker, proposedEnd);
    if (index >= minimum) return index + marker.length;
  }
  return proposedEnd;
}

function sanitizeMemory(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Memory content cannot be empty");
  if (trimmed.length > MEMORY_CHARACTER_LIMIT)
    throw new Error(`Memory content exceeds the ${MEMORY_CHARACTER_LIMIT.toLocaleString("en-US")} character safety limit`);
  if (containsSecret(trimmed)) throw new Error("Memory content appears to contain a secret");
  return trimmed;
}

function sanitizeDocument(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Source content cannot be empty");
  if (trimmed.length > DOCUMENT_CHARACTER_LIMIT) throw new Error(`Source content exceeds ${DOCUMENT_CHARACTER_LIMIT} characters`);
  if (containsSecret(trimmed)) throw new Error("Source content appears to contain a secret");
  return trimmed;
}

function sanitizeScope(scope: string): string {
  const result = scope
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!result || result.length > 120) throw new Error("Invalid memory scope");
  return result;
}

function sanitizeMetadata(value: string, name: string, limit: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > limit) throw new Error(`${name} must contain 1-${limit} characters`);
  if (containsSecret(trimmed)) throw new Error(`${name} appears to contain a secret`);
  return trimmed;
}

function sanitizeOptionalText(value: string, name: string, limit: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > limit) throw new Error(`${name} must contain 1-${limit} characters`);
  if (containsSecret(trimmed)) throw new Error(`${name} appears to contain a secret`);
  return trimmed;
}

function sanitizeSkillId(value: string): string {
  const result = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!result || result.length > 80) throw new Error("Invalid converted skill id");
  return result;
}

function bounded(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`);
  return value;
}

function normalizeDate(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("expiresAt must be a valid date");
  return date.toISOString().replace("T", " ").replace(".000Z", "").replace("Z", "");
}

function rankCandidate(candidate: RankedCandidate, halfLifeDays: number, feedback: number): number {
  const lexicalRrf = candidate.lexicalRank ? 1 / (60 + candidate.lexicalRank) : 0;
  const vectorRrf = candidate.vectorRank ? 1 / (60 + candidate.vectorRank) : 0;
  const age = Math.max(0, Date.now() - parseSqliteDate(candidate.row.created_at));
  const recency = Math.exp((-Math.log(2) * age) / (Math.max(1, halfLifeDays) * 86_400_000));
  const authority = candidate.row.review_status === "approved" && (candidate.row.kind === "instruction" || candidate.row.kind === "preference") ? 1 : 0;
  return (
    (lexicalRrf * 0.58 + vectorRrf * 0.42) * 32 +
    Math.max(0, candidate.vectorSimilarity) * 0.2 +
    candidate.row.confidence * 0.08 +
    candidate.row.importance * 0.08 +
    recency * 0.06 +
    authority * 0.08 +
    Math.min(1, Math.log1p(candidate.row.access_count) / 6) * 0.02 +
    feedback * 0.1
  );
}

function diversify(candidates: RankedCandidate[], limit: number): RankedCandidate[] {
  if (candidates.length <= 1) return candidates.slice(0, limit);
  const selected: RankedCandidate[] = [];
  const maximum = candidates[0]?.score || 1;
  const remaining = [...candidates];
  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const [index, candidate] of remaining.entries()) {
      const relevance = candidate.score / maximum;
      const redundancy = selected.length === 0 ? 0 : Math.max(...selected.map((item) => Math.max(0, cosineSimilarity(candidate.vector, item.vector))));
      const mmr = relevance * 0.78 - redundancy * 0.22;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIndex = index;
      }
    }
    const [next] = remaining.splice(bestIndex, 1);
    if (next) selected.push(next);
  }
  return selected;
}

function parseSqliteDate(value: string): number {
  const parsed = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function polarity(content: string): -1 | 0 | 1 {
  // Portuguese tokens are retained as input-safety data because memories may be
  // written in the operator's language; they are not CLI/TUI localization.
  const negative = /\b(?:not|never|no longer|must not|do not|nao|não|nunca|jamais|deixar de)\b/iu.test(content); // language-audit: allow-portuguese-input
  const assertive = /\b(?:must|should|is|are|always|use|require|deve|tem de|usar|e|é|sao|são|sempre)\b/iu.test(content); // language-audit: allow-portuguese-input
  if (negative) return -1;
  return assertive ? 1 : 0;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
