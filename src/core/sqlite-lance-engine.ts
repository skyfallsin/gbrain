/**
 * SQLiteLanceEngine — BrainEngine implementation using Bun's built-in SQLite + LanceDB.
 *
 * SQLite handles relational storage (pages, links, tags, timeline, config, etc.)
 * LanceDB handles vector storage and similarity search.
 * FTS5 handles keyword search (replaces Postgres tsvector/GIN).
 *
 * Designed for memory-constrained environments (512MB Fly machines) where
 * PGLite's ~300MB RSS is prohibitive.
 */

import { Database } from 'bun:sqlite';
import * as lancedb from '@lancedb/lancedb';
import {
  Float32 as ArrowFloat32,
  Field,
  FixedSizeList,
  Int32,
  Schema,
  Utf8,
} from 'apache-arrow';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import type {
  BrainEngine,
  LinkBatchInput,
  TimelineBatchInput,
  ReservedConnection,
} from './engine.ts';
import { MAX_SEARCH_LIMIT, clampSearchLimit } from './engine.ts';
import type {
  Page, PageInput, PageFilters, PageType,
  Chunk, ChunkInput, StaleChunkRow,
  SearchResult, SearchOpts,
  Link, GraphNode, GraphPath,
  TimelineEntry, TimelineInput, TimelineOpts,
  RawData,
  PageVersion,
  BrainStats, BrainHealth,
  IngestLogEntry, IngestLogInput,
  EngineConfig,
  CodeEdgeInput, CodeEdgeResult,
} from './types.ts';
import { validateSlug, contentHash } from './utils.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const VECTORS_TABLE = 'chunk_vectors';

export class SQLiteLanceEngine implements BrainEngine {
  readonly kind = 'sqlite-lance' as const;
  private _db: Database | null = null;
  private _lanceDb: lancedb.Connection | null = null;
  private _lanceTable: lancedb.Table | null = null;
  private _embeddingDimensions: number = 768;
  private _inTransaction = false;

  get db(): Database {
    if (!this._db) throw new Error('SQLite not connected. Call connect() first.');
    return this._db;
  }

  get lanceDb(): lancedb.Connection {
    if (!this._lanceDb) throw new Error('LanceDB not connected. Call connect() first.');
    return this._lanceDb;
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async connect(config: EngineConfig): Promise<void> {
    const dbPath = config.database_path || ':memory:';
    this._db = new Database(dbPath === ':memory:' ? ':memory:' : dbPath);
    this._db.exec('PRAGMA journal_mode = WAL');
    this._db.exec('PRAGMA foreign_keys = ON');
    this._db.exec('PRAGMA synchronous = NORMAL');
    this._db.exec('PRAGMA cache_size = -64000');

    const lancePath = dbPath === ':memory:'
      ? '/tmp/gbrain-lance-' + Date.now() + '-' + Math.random().toString(36).slice(2)
      : dbPath.replace(/\.db$/, '') + '-lance';
    this._lanceDb = await lancedb.connect(lancePath);
  }

  async disconnect(): Promise<void> {
    if (this._db) { this._db.close(); this._db = null; }
    this._lanceTable = null;
    this._lanceDb = null;
  }

  async initSchema(): Promise<void> {
    const schemaSQL = readFileSync(join(__dirname, 'sqlite-lance-schema.sql'), 'utf-8');
    this.db.exec(schemaSQL);
    await this._ensureLanceTable();
  }

  private async _ensureLanceTable(): Promise<lancedb.Table> {
    if (this._lanceTable) return this._lanceTable;
    const tables = await this.lanceDb.tableNames();
    if (tables.includes(VECTORS_TABLE)) {
      this._lanceTable = await this.lanceDb.openTable(VECTORS_TABLE);
    } else {
      const schema = new Schema([
        new Field('chunk_id', new Int32(), false),
        new Field('vector', new FixedSizeList(this._embeddingDimensions, new Field('item', new ArrowFloat32(), false)), false),
        new Field('slug', new Utf8(), false),
        new Field('page_id', new Int32(), false),
        new Field('chunk_index', new Int32(), false),
        new Field('chunk_text', new Utf8(), false),
        new Field('chunk_source', new Utf8(), false),
      ]);
      this._lanceTable = await this.lanceDb.createEmptyTable(VECTORS_TABLE, schema);
    }
    return this._lanceTable;
  }

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    if (this._inTransaction) return fn(this);
    this.db.exec('BEGIN');
    this._inTransaction = true;
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      this._inTransaction = false;
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      this._inTransaction = false;
      throw err;
    }
  }

  async withReservedConnection<T>(fn: (conn: ReservedConnection) => Promise<T>): Promise<T> {
    const db = this.db;
    const conn: ReservedConnection = {
      async executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]> {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH') || trimmed.startsWith('PRAGMA')) {
          return (params ? db.prepare(sql).all(...params) : db.prepare(sql).all()) as R[];
        }
        params ? db.prepare(sql).run(...params) : db.prepare(sql).run();
        return [] as R[];
      },
    };
    return fn(conn);
  }

  // ── Pages CRUD ─────────────────────────────────────────────

  async getPage(slug: string): Promise<Page | null> {
    const row = this.db.prepare(
      `SELECT id, slug, type, title, compiled_truth, timeline, frontmatter,
              content_hash, created_at, updated_at
       FROM pages WHERE slug = ?`
    ).get(slug) as Record<string, unknown> | null;
    if (!row) return null;
    return this._rowToPage(row);
  }

  async putPage(slug: string, page: PageInput): Promise<Page> {
    slug = validateSlug(slug);
    const hash = page.content_hash || contentHash(page);
    const frontmatter = page.frontmatter || {};
    const now = new Date().toISOString();
    const pageKind = page.page_kind || 'markdown';

    const row = this.db.prepare(
      `INSERT INTO pages (slug, type, page_kind, title, compiled_truth, timeline, frontmatter, content_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_id, slug) DO UPDATE SET
         type = excluded.type,
         page_kind = excluded.page_kind,
         title = excluded.title,
         compiled_truth = excluded.compiled_truth,
         timeline = excluded.timeline,
         frontmatter = excluded.frontmatter,
         content_hash = excluded.content_hash,
         updated_at = ?
       RETURNING id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at`
    ).get(
      slug, page.type, pageKind, page.title, page.compiled_truth, page.timeline || '',
      JSON.stringify(frontmatter), hash, now, now
    ) as Record<string, unknown>;
    return this._rowToPage(row);
  }

  async deletePage(slug: string): Promise<void> {
    const page = this.db.prepare('SELECT id FROM pages WHERE slug = ?').get(slug) as { id: number } | null;
    if (page) {
      try { const t = await this._ensureLanceTable(); await t.delete(`page_id = ${page.id}`); } catch {}
    }
    this.db.prepare('DELETE FROM pages WHERE slug = ?').run(slug);
  }

  async listPages(filters?: PageFilters): Promise<Page[]> {
    const limit = filters?.limit || 100;
    const offset = filters?.offset || 0;
    const where: string[] = [];
    const params: unknown[] = [];
    let tagJoin = '';

    if (filters?.type) { params.push(filters.type); where.push('p.type = ?'); }
    if (filters?.tag) { tagJoin = 'JOIN tags t ON t.page_id = p.id'; params.push(filters.tag); where.push('t.tag = ?'); }
    if (filters?.updated_after) { params.push(filters.updated_after); where.push('p.updated_at > ?'); }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit, offset);
    return (this.db.prepare(
      `SELECT p.* FROM pages p ${tagJoin} ${whereSql} ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`
    ).all(...params) as Record<string, unknown>[]).map(r => this._rowToPage(r));
  }

  async getAllSlugs(): Promise<Set<string>> {
    return new Set((this.db.prepare('SELECT slug FROM pages').all() as { slug: string }[]).map(r => r.slug));
  }

  async resolveSlugs(partial: string): Promise<string[]> {
    const exact = this.db.prepare('SELECT slug FROM pages WHERE slug = ?').get(partial) as { slug: string } | null;
    if (exact) return [exact.slug];
    const like = `%${partial}%`;
    return (this.db.prepare(
      `SELECT DISTINCT slug FROM (
        SELECT p.slug, 1 as pri FROM pages p JOIN pages_fts ON pages_fts.rowid = p.id WHERE pages_fts MATCH ?
        UNION ALL
        SELECT slug, 2 as pri FROM pages WHERE slug LIKE ? OR title LIKE ?
      ) ORDER BY pri LIMIT 5`
    ).all(partial, like, like) as { slug: string }[]).map(r => r.slug);
  }

  // ── Search ─────────────────────────────────────────────────

  async searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const limit = clampSearchLimit(opts?.limit);
    const offset = opts?.offset || 0;
    const detailFilter = opts?.detail === 'low' ? `AND cc.chunk_source = 'compiled_truth'` : '';
    if (opts?.limit && opts.limit > MAX_SEARCH_LIMIT)
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${MAX_SEARCH_LIMIT}`);

    // v0.20.0: chunk-grain FTS via chunks_fts, deduped to best-chunk-per-page.
    const innerLimit = Math.min(limit * 3, MAX_SEARCH_LIMIT * 3);
    let extraFilter = '';
    const params: unknown[] = [query, innerLimit];
    if (opts?.language) {
      params.push(opts.language);
      extraFilter += ` AND cc.language = ?`;
    }
    if (opts?.symbolKind) {
      params.push(opts.symbolKind);
      extraFilter += ` AND cc.symbol_type = ?`;
    }

    // Inner query: rank at chunk grain. Outer: dedup to best per page.
    const rows = this.db.prepare(
      `SELECT * FROM (
         SELECT p.slug, p.id as page_id, p.title, p.type, p.source_id,
           cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
           chunks_fts.rank as score,
           CASE WHEN p.updated_at < (SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id) THEN 1 ELSE 0 END AS stale,
           ROW_NUMBER() OVER (PARTITION BY p.slug ORDER BY chunks_fts.rank) as rn
         FROM chunks_fts
         JOIN content_chunks cc ON cc.id = chunks_fts.rowid
         JOIN pages p ON p.id = cc.page_id
         WHERE chunks_fts MATCH ? ${detailFilter}${extraFilter}
         ORDER BY chunks_fts.rank
         LIMIT ?
       ) WHERE rn = 1
       ORDER BY score
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Record<string, unknown>[];

    return rows.map(r => this._rowToSearchResult(r));
  }

  async searchKeywordChunks(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const limit = clampSearchLimit(opts?.limit);
    const offset = opts?.offset || 0;
    const detailFilter = opts?.detail === 'low' ? `AND cc.chunk_source = 'compiled_truth'` : '';
    if (opts?.limit && opts.limit > MAX_SEARCH_LIMIT)
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${MAX_SEARCH_LIMIT}`);

    let extraFilter = '';
    const params: unknown[] = [query];
    if (opts?.language) {
      params.push(opts.language);
      extraFilter += ` AND cc.language = ?`;
    }
    if (opts?.symbolKind) {
      params.push(opts.symbolKind);
      extraFilter += ` AND cc.symbol_type = ?`;
    }

    const rows = this.db.prepare(
      `SELECT p.slug, p.id as page_id, p.title, p.type, p.source_id,
        cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
        chunks_fts.rank as score,
        CASE WHEN p.updated_at < (SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id) THEN 1 ELSE 0 END AS stale
      FROM chunks_fts
      JOIN content_chunks cc ON cc.id = chunks_fts.rowid
      JOIN pages p ON p.id = cc.page_id
      WHERE chunks_fts MATCH ? ${detailFilter}${extraFilter}
      ORDER BY chunks_fts.rank LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Record<string, unknown>[];

    return rows.map(r => this._rowToSearchResult(r));
  }

  async searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]> {
    const limit = clampSearchLimit(opts?.limit);
    const detailFilter = opts?.detail === 'low' ? 'compiled_truth' : null;
    if (opts?.limit && opts.limit > MAX_SEARCH_LIMIT)
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${MAX_SEARCH_LIMIT}`);

    try {
      const table = await this._ensureLanceTable();
      if (await table.countRows() === 0) return [];
      const results = await table.search(Array.from(embedding)).limit(limit * 2).toArray();
      if (results.length === 0) return [];

      const chunkIds = results.map((r: any) => r.chunk_id);
      const ph = chunkIds.map(() => '?').join(',');
      const chunkRows = this.db.prepare(
        `SELECT p.slug, p.id as page_id, p.title, p.type, p.source_id,
                cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
                CASE WHEN p.updated_at < (SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id) THEN 1 ELSE 0 END AS stale
         FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
         WHERE cc.id IN (${ph}) ${detailFilter ? `AND cc.chunk_source = '${detailFilter}'` : ''}`
      ).all(...chunkIds) as Record<string, unknown>[];

      const chunkMap = new Map<number, Record<string, unknown>>();
      for (const row of chunkRows) chunkMap.set(row.chunk_id as number, row);

      const out: SearchResult[] = [];
      for (const r of results) {
        const row = chunkMap.get(r.chunk_id as number);
        if (!row) continue;
        out.push({
          slug: row.slug as string, page_id: row.page_id as number,
          title: row.title as string, type: row.type as PageType,
          chunk_text: row.chunk_text as string,
          chunk_source: row.chunk_source as 'compiled_truth' | 'timeline',
          chunk_id: row.chunk_id as number, chunk_index: row.chunk_index as number,
          score: 1 - (r._distance as number), stale: Boolean(row.stale),
          source_id: row.source_id as string | undefined,
        });
        if (out.length >= limit) break;
      }
      return out;
    } catch { return []; }
  }

  async getEmbeddingsByChunkIds(ids: number[]): Promise<Map<number, Float32Array>> {
    if (ids.length === 0) return new Map();
    const result = new Map<number, Float32Array>();
    try {
      const table = await this._ensureLanceTable();
      const rows = await table.query().filter(`chunk_id IN (${ids.join(',')})`).toArray();
      for (const row of rows) {
        if (row.vector) result.set(row.chunk_id as number, Float32Array.from(row.vector as Iterable<number>));
      }
    } catch {}
    return result;
  }

  // ── Chunks ─────────────────────────────────────────────────

  async upsertChunks(slug: string, chunks: ChunkInput[]): Promise<void> {
    const pageRow = this.db.prepare('SELECT id FROM pages WHERE slug = ?').get(slug) as { id: number } | null;
    if (!pageRow) throw new Error(`Page not found: ${slug}`);
    const pageId = pageRow.id;

    const newIndices = chunks.map(c => c.chunk_index);
    if (newIndices.length > 0) {
      const ph = newIndices.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM content_chunks WHERE page_id = ? AND chunk_index NOT IN (${ph})`).run(pageId, ...newIndices);
    } else {
      this.db.prepare('DELETE FROM content_chunks WHERE page_id = ?').run(pageId);
      try { const t = await this._ensureLanceTable(); await t.delete(`page_id = ${pageId}`); } catch {}
      return;
    }

    const upsertStmt = this.db.prepare(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, model, token_count, embedded_at, language, symbol_name, symbol_type, start_line, end_line, parent_symbol_path, doc_comment, symbol_name_qualified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (page_id, chunk_index) DO UPDATE SET
         chunk_text = CASE WHEN excluded.chunk_text != content_chunks.chunk_text THEN excluded.chunk_text ELSE content_chunks.chunk_text END,
         chunk_source = excluded.chunk_source,
         model = COALESCE(excluded.model, content_chunks.model),
         token_count = excluded.token_count,
         embedded_at = COALESCE(excluded.embedded_at, content_chunks.embedded_at),
         language = excluded.language,
         symbol_name = excluded.symbol_name,
         symbol_type = excluded.symbol_type,
         start_line = excluded.start_line,
         end_line = excluded.end_line,
         parent_symbol_path = excluded.parent_symbol_path,
         doc_comment = excluded.doc_comment,
         symbol_name_qualified = excluded.symbol_name_qualified
       RETURNING id`
    );

    const vectorsToAdd: Array<{ chunk_id: number; vector: number[]; slug: string; page_id: number; chunk_index: number; chunk_text: string; chunk_source: string }> = [];

    for (const chunk of chunks) {
      const now = chunk.embedding ? new Date().toISOString() : null;
      const parentPath = chunk.parent_symbol_path && chunk.parent_symbol_path.length > 0
        ? JSON.stringify(chunk.parent_symbol_path)
        : null;
      const result = upsertStmt.get(
        pageId, chunk.chunk_index, chunk.chunk_text, chunk.chunk_source,
        chunk.model || 'text-embedding-3-large', chunk.token_count || null, now,
        chunk.language || null, chunk.symbol_name || null, chunk.symbol_type || null,
        chunk.start_line ?? null, chunk.end_line ?? null,
        parentPath, chunk.doc_comment || null, chunk.symbol_name_qualified || null,
      ) as { id: number };

      if (chunk.embedding) {
        vectorsToAdd.push({
          chunk_id: result.id, vector: Array.from(chunk.embedding),
          slug, page_id: pageId, chunk_index: chunk.chunk_index,
          chunk_text: chunk.chunk_text, chunk_source: chunk.chunk_source,
        });
      }
    }

    if (vectorsToAdd.length > 0) {
      try {
        const table = await this._ensureLanceTable();
        const cids = vectorsToAdd.map(v => v.chunk_id);
        try { await table.delete(`chunk_id IN (${cids.join(',')})`); } catch {}
        await table.add(vectorsToAdd);
      } catch (err) { console.warn('[sqlite-lance] LanceDB vector upsert failed:', err); }
    }
  }

  async getChunks(slug: string): Promise<Chunk[]> {
    return (this.db.prepare(
      `SELECT cc.* FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.slug = ? ORDER BY cc.chunk_index`
    ).all(slug) as Record<string, unknown>[]).map(r => this._rowToChunk(r));
  }

  async deleteChunks(slug: string): Promise<void> {
    const p = this.db.prepare('SELECT id FROM pages WHERE slug = ?').get(slug) as { id: number } | null;
    if (p) {
      this.db.prepare('DELETE FROM content_chunks WHERE page_id = ?').run(p.id);
      try { const t = await this._ensureLanceTable(); await t.delete(`page_id = ${p.id}`); } catch {}
    }
  }

  async countStaleChunks(): Promise<number> {
    const row = this.db.prepare(
      `SELECT count(*) as count FROM content_chunks WHERE embedded_at IS NULL`
    ).get() as { count: number };
    return Number(row.count);
  }

  async listStaleChunks(): Promise<StaleChunkRow[]> {
    return this.db.prepare(
      `SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source,
              cc.model, cc.token_count
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE cc.embedded_at IS NULL
        ORDER BY p.id, cc.chunk_index
        LIMIT 100000`
    ).all() as StaleChunkRow[];
  }

  // ── Code Edges (v0.20.0 Cathedral II) ──────────────────────

  async addCodeEdges(edges: CodeEdgeInput[]): Promise<number> {
    if (edges.length === 0) return 0;
    let inserted = 0;
    const resolved = edges.filter(e => e.to_chunk_id != null);
    const unresolved = edges.filter(e => e.to_chunk_id == null);

    if (resolved.length > 0) {
      const stmt = this.db.prepare(
        `INSERT OR IGNORE INTO code_edges_chunk
           (from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, edge_metadata, source_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const run = this.db.transaction((batch: CodeEdgeInput[]) => {
        let c = 0;
        for (const e of batch) {
          const r = stmt.run(
            e.from_chunk_id, e.to_chunk_id, e.from_symbol_qualified,
            e.to_symbol_qualified, e.edge_type,
            JSON.stringify(e.edge_metadata ?? {}),
            e.source_id ?? null,
          );
          c += r.changes;
        }
        return c;
      });
      inserted += run(resolved);
    }

    if (unresolved.length > 0) {
      const stmt = this.db.prepare(
        `INSERT OR IGNORE INTO code_edges_symbol
           (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, edge_metadata, source_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const run = this.db.transaction((batch: CodeEdgeInput[]) => {
        let c = 0;
        for (const e of batch) {
          const r = stmt.run(
            e.from_chunk_id, e.from_symbol_qualified, e.to_symbol_qualified, e.edge_type,
            JSON.stringify(e.edge_metadata ?? {}),
            e.source_id ?? null,
          );
          c += r.changes;
        }
        return c;
      });
      inserted += run(unresolved);
    }
    return inserted;
  }

  async deleteCodeEdgesForChunks(chunkIds: number[]): Promise<void> {
    if (chunkIds.length === 0) return;
    const ph = chunkIds.map(() => '?').join(',');
    this.db.prepare(
      `DELETE FROM code_edges_chunk WHERE from_chunk_id IN (${ph}) OR to_chunk_id IN (${ph})`
    ).run(...chunkIds, ...chunkIds);
    this.db.prepare(
      `DELETE FROM code_edges_symbol WHERE from_chunk_id IN (${ph})`
    ).run(...chunkIds);
  }

  async getCallersOf(
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number },
  ): Promise<CodeEdgeResult[]> {
    const limit = Math.min(opts?.limit ?? 100, 500);
    const sourceClause = opts?.allSources || !opts?.sourceId ? '' : `AND source_id = ?`;
    const params: unknown[] = sourceClause ? [qualifiedName, opts!.sourceId, qualifiedName, opts!.sourceId, limit] : [qualifiedName, qualifiedName, limit];

    const rows = this.db.prepare(
      `SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
              edge_type, edge_metadata, source_id, 1 as resolved
         FROM code_edges_chunk
         WHERE to_symbol_qualified = ? ${sourceClause}
       UNION ALL
       SELECT id, from_chunk_id, NULL as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
              edge_type, edge_metadata, source_id, 0 as resolved
         FROM code_edges_symbol
         WHERE to_symbol_qualified = ? ${sourceClause}
       LIMIT ?`
    ).all(...params) as Record<string, unknown>[];
    return rows.map(rowToCodeEdge);
  }

  async getCalleesOf(
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number },
  ): Promise<CodeEdgeResult[]> {
    const limit = Math.min(opts?.limit ?? 100, 500);
    const sourceClause = opts?.allSources || !opts?.sourceId ? '' : `AND source_id = ?`;
    const params: unknown[] = sourceClause ? [qualifiedName, opts!.sourceId, qualifiedName, opts!.sourceId, limit] : [qualifiedName, qualifiedName, limit];

    const rows = this.db.prepare(
      `SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
              edge_type, edge_metadata, source_id, 1 as resolved
         FROM code_edges_chunk
         WHERE from_symbol_qualified = ? ${sourceClause}
       UNION ALL
       SELECT id, from_chunk_id, NULL as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
              edge_type, edge_metadata, source_id, 0 as resolved
         FROM code_edges_symbol
         WHERE from_symbol_qualified = ? ${sourceClause}
       LIMIT ?`
    ).all(...params) as Record<string, unknown>[];
    return rows.map(rowToCodeEdge);
  }

  async getEdgesByChunk(
    chunkId: number,
    opts?: { direction?: 'in' | 'out' | 'both'; edgeType?: string; limit?: number },
  ): Promise<CodeEdgeResult[]> {
    const direction = opts?.direction ?? 'both';
    const limit = Math.min(opts?.limit ?? 50, 200);
    const edgeTypeClause = opts?.edgeType ? `AND edge_type = '${opts.edgeType.replace(/'/g, "''")}'` : '';

    let chunkFilter = '';
    if (direction === 'in') chunkFilter = `WHERE to_chunk_id = ?`;
    else if (direction === 'out') chunkFilter = `WHERE from_chunk_id = ?`;
    else chunkFilter = `WHERE (from_chunk_id = ? OR to_chunk_id = ?)`;

    let symbolFilter = '';
    if (direction === 'out' || direction === 'both') {
      symbolFilter = `WHERE from_chunk_id = ?`;
    }

    const unionClause = symbolFilter ? `
      UNION ALL
      SELECT id, from_chunk_id, NULL as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
             edge_type, edge_metadata, source_id, 0 as resolved
        FROM code_edges_symbol
        ${symbolFilter} ${edgeTypeClause}
    ` : '';

    const params: unknown[] = [];
    if (direction === 'both') { params.push(chunkId, chunkId); } else { params.push(chunkId); }
    if (symbolFilter) params.push(chunkId);
    params.push(limit);

    const rows = this.db.prepare(
      `SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
              edge_type, edge_metadata, source_id, 1 as resolved
         FROM code_edges_chunk
         ${chunkFilter} ${edgeTypeClause}
       ${unionClause}
       LIMIT ?`
    ).all(...params) as Record<string, unknown>[];
    return rows.map(rowToCodeEdge);
  }

  // ── Links ──────────────────────────────────────────────────

  async addLink(from: string, to: string, context?: string, linkType?: string, linkSource?: string, originSlug?: string, originField?: string): Promise<void> {
    const src = linkSource ?? 'markdown';
    const fromP = this.db.prepare('SELECT id FROM pages WHERE slug = ?').get(from) as { id: number } | null;
    const toP = this.db.prepare('SELECT id FROM pages WHERE slug = ?').get(to) as { id: number } | null;
    if (!fromP || !toP) return;
    const originId = originSlug ? (this.db.prepare('SELECT id FROM pages WHERE slug = ?').get(originSlug) as { id: number } | null)?.id ?? null : null;

    // Use DELETE+INSERT to match the COALESCE-based unique index (SQLite ON CONFLICT can't reference functional indexes)
    this.db.prepare(
      `DELETE FROM links WHERE from_page_id = ? AND to_page_id = ? AND link_type = ? AND COALESCE(link_source, '') = COALESCE(?, '') AND COALESCE(origin_page_id, 0) = COALESCE(?, 0)`
    ).run(fromP.id, toP.id, linkType || '', src, originId);
    this.db.prepare(
      `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(fromP.id, toP.id, linkType || '', context || '', src, originId, originField ?? null);
  }

  async addLinksBatch(links: LinkBatchInput[]): Promise<number> {
    if (links.length === 0) return 0;
    const checkStmt = this.db.prepare(
      `SELECT 1 FROM links WHERE from_page_id = ? AND to_page_id = ? AND link_type = ? AND COALESCE(link_source, '') = COALESCE(?, '') AND COALESCE(origin_page_id, 0) = COALESCE(?, 0)`
    );
    const insertStmt = this.db.prepare(
      `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const getPage = this.db.prepare('SELECT id FROM pages WHERE slug = ? AND source_id = ?');

    let count = 0;
    const run = this.db.transaction((batch: LinkBatchInput[]) => {
      let c = 0;
      for (const link of batch) {
        const fp = getPage.get(link.from_slug, link.from_source_id || 'default') as { id: number } | null;
        const tp = getPage.get(link.to_slug, link.to_source_id || 'default') as { id: number } | null;
        if (!fp || !tp) continue;
        const oid = link.origin_slug ? (getPage.get(link.origin_slug, link.origin_source_id || 'default') as { id: number } | null)?.id ?? null : null;
        const existing = checkStmt.get(fp.id, tp.id, link.link_type || '', link.link_source || 'markdown', oid);
        if (existing) continue;
        const r = insertStmt.run(fp.id, tp.id, link.link_type || '', link.context || '', link.link_source || 'markdown', oid, link.origin_field || null);
        c += r.changes;
      }
      return c;
    });
    count = run(links);
    return count;
  }

  async removeLink(from: string, to: string, linkType?: string, linkSource?: string): Promise<void> {
    const fp = this.db.prepare('SELECT id FROM pages WHERE slug = ?').get(from) as { id: number } | null;
    const tp = this.db.prepare('SELECT id FROM pages WHERE slug = ?').get(to) as { id: number } | null;
    if (!fp || !tp) return;

    if (linkType !== undefined && linkSource !== undefined) {
      this.db.prepare(`DELETE FROM links WHERE from_page_id = ? AND to_page_id = ? AND link_type = ? AND (link_source IS ? OR (? IS NULL AND link_source IS NULL))`).run(fp.id, tp.id, linkType, linkSource, linkSource);
    } else if (linkType !== undefined) {
      this.db.prepare('DELETE FROM links WHERE from_page_id = ? AND to_page_id = ? AND link_type = ?').run(fp.id, tp.id, linkType);
    } else if (linkSource !== undefined) {
      this.db.prepare(`DELETE FROM links WHERE from_page_id = ? AND to_page_id = ? AND (link_source IS ? OR (? IS NULL AND link_source IS NULL))`).run(fp.id, tp.id, linkSource, linkSource);
    } else {
      this.db.prepare('DELETE FROM links WHERE from_page_id = ? AND to_page_id = ?').run(fp.id, tp.id);
    }
  }

  async getLinks(slug: string): Promise<Link[]> {
    return this.db.prepare(
      `SELECT f.slug as from_slug, t.slug as to_slug, l.link_type, l.context, l.link_source, o.slug as origin_slug, l.origin_field
       FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id LEFT JOIN pages o ON o.id = l.origin_page_id
       WHERE f.slug = ?`
    ).all(slug) as Link[];
  }

  async getBacklinks(slug: string): Promise<Link[]> {
    return this.db.prepare(
      `SELECT f.slug as from_slug, t.slug as to_slug, l.link_type, l.context, l.link_source, o.slug as origin_slug, l.origin_field
       FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id LEFT JOIN pages o ON o.id = l.origin_page_id
       WHERE t.slug = ?`
    ).all(slug) as Link[];
  }

  async findByTitleFuzzy(name: string, dirPrefix?: string, minSimilarity: number = 0.55): Promise<{ slug: string; similarity: number } | null> {
    const prefixPattern = dirPrefix ? `${dirPrefix}/%` : '%';
    const nl = name.toLowerCase();
    const rows = this.db.prepare(
      `SELECT slug, title,
        CAST(CASE WHEN LOWER(title) = ? THEN 1.0 WHEN LOWER(title) LIKE ? THEN 0.8 WHEN LOWER(title) LIKE ? THEN 0.6 ELSE 0.0 END AS REAL) as sim
       FROM pages WHERE slug LIKE ? AND (LOWER(title) = ? OR LOWER(title) LIKE ? OR LOWER(title) LIKE ?)
       ORDER BY sim DESC, slug ASC LIMIT 1`
    ).all(nl, `${nl}%`, `%${nl}%`, prefixPattern, nl, `${nl}%`, `%${nl}%`) as { slug: string; sim: number }[];
    if (rows.length === 0 || rows[0].sim < minSimilarity) return null;
    return { slug: rows[0].slug, similarity: rows[0].sim };
  }

  async traverseGraph(slug: string, depth: number = 5): Promise<GraphNode[]> {
    const rows = this.db.prepare(
      `WITH RECURSIVE graph(id, slug, title, type, depth, path) AS (
        SELECT p.id, p.slug, p.title, p.type, 0, '|' || p.id || '|' FROM pages p WHERE p.slug = ?
        UNION ALL
        SELECT p2.id, p2.slug, p2.title, p2.type, g.depth + 1, g.path || p2.id || '|'
        FROM graph g JOIN links l ON l.from_page_id = g.id JOIN pages p2 ON p2.id = l.to_page_id
        WHERE g.depth < ? AND g.path NOT LIKE '%|' || p2.id || '|%'
      )
      SELECT DISTINCT g.slug, g.title, g.type, g.depth FROM graph g ORDER BY g.depth, g.slug`
    ).all(slug, depth) as Record<string, unknown>[];

    return rows.map(r => {
      const nodeLinks = this.db.prepare(
        `SELECT DISTINCT p3.slug as to_slug, l.link_type FROM links l JOIN pages p3 ON p3.id = l.to_page_id JOIN pages pf ON pf.id = l.from_page_id WHERE pf.slug = ?`
      ).all(r.slug as string) as { to_slug: string; link_type: string }[];
      return { slug: r.slug as string, title: r.title as string, type: r.type as PageType, depth: r.depth as number, links: nodeLinks };
    });
  }

  async traversePaths(slug: string, opts?: { depth?: number; linkType?: string; direction?: 'in' | 'out' | 'both' }): Promise<GraphPath[]> {
    const depth = opts?.depth ?? 5;
    const direction = opts?.direction ?? 'out';
    const linkType = opts?.linkType ?? null;
    const ltWhere = linkType !== null ? 'AND l.link_type = ?' : '';

    let rows: Record<string, unknown>[];
    const baseParams: unknown[] = linkType !== null ? [slug, depth, linkType] : [slug, depth];
    const emitParams: unknown[] = linkType !== null ? [depth, linkType] : [depth];

    if (direction === 'out') {
      rows = this.db.prepare(
        `WITH RECURSIVE walk(id, slug, depth, path) AS (
          SELECT p.id, p.slug, 0, '|' || p.id || '|' FROM pages p WHERE p.slug = ?
          UNION ALL
          SELECT p2.id, p2.slug, w.depth + 1, w.path || p2.id || '|'
          FROM walk w JOIN links l ON l.from_page_id = w.id JOIN pages p2 ON p2.id = l.to_page_id
          WHERE w.depth < ? AND w.path NOT LIKE '%|' || p2.id || '|%' ${ltWhere}
        )
        SELECT pf.slug AS from_slug, pt.slug AS to_slug, l.link_type, l.context, w.depth + 1 AS depth
        FROM walk w JOIN links l ON l.from_page_id = w.id JOIN pages pf ON pf.id = l.from_page_id JOIN pages pt ON pt.id = l.to_page_id
        WHERE w.depth < ? ${ltWhere} ORDER BY depth, from_slug, to_slug`
      ).all(...baseParams, ...emitParams) as Record<string, unknown>[];
    } else if (direction === 'in') {
      rows = this.db.prepare(
        `WITH RECURSIVE walk(id, slug, depth, path) AS (
          SELECT p.id, p.slug, 0, '|' || p.id || '|' FROM pages p WHERE p.slug = ?
          UNION ALL
          SELECT p2.id, p2.slug, w.depth + 1, w.path || p2.id || '|'
          FROM walk w JOIN links l ON l.to_page_id = w.id JOIN pages p2 ON p2.id = l.from_page_id
          WHERE w.depth < ? AND w.path NOT LIKE '%|' || p2.id || '|%' ${ltWhere}
        )
        SELECT pf.slug AS from_slug, pt.slug AS to_slug, l.link_type, l.context, w.depth + 1 AS depth
        FROM walk w JOIN links l ON l.to_page_id = w.id JOIN pages pf ON pf.id = l.from_page_id JOIN pages pt ON pt.id = l.to_page_id
        WHERE w.depth < ? ${ltWhere} ORDER BY depth, from_slug, to_slug`
      ).all(...baseParams, ...emitParams) as Record<string, unknown>[];
    } else {
      rows = this.db.prepare(
        `WITH RECURSIVE walk(id, depth, path) AS (
          SELECT p.id, 0, '|' || p.id || '|' FROM pages p WHERE p.slug = ?
          UNION ALL
          SELECT p2.id, w.depth + 1, w.path || p2.id || '|'
          FROM walk w JOIN links l ON (l.from_page_id = w.id OR l.to_page_id = w.id)
          JOIN pages p2 ON p2.id = CASE WHEN l.from_page_id = w.id THEN l.to_page_id ELSE l.from_page_id END
          WHERE w.depth < ? AND w.path NOT LIKE '%|' || p2.id || '|%' ${ltWhere}
        )
        SELECT pf.slug AS from_slug, pt.slug AS to_slug, l.link_type, l.context, w.depth + 1 AS depth
        FROM walk w JOIN links l ON (l.from_page_id = w.id OR l.to_page_id = w.id)
        JOIN pages pf ON pf.id = l.from_page_id JOIN pages pt ON pt.id = l.to_page_id
        WHERE w.depth < ? ${ltWhere} ORDER BY depth, from_slug, to_slug`
      ).all(...baseParams, ...emitParams) as Record<string, unknown>[];
    }

    const seen = new Set<string>();
    const result: GraphPath[] = [];
    for (const r of rows) {
      const key = `${r.from_slug}|${r.to_slug}|${r.link_type}|${r.depth}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ from_slug: r.from_slug as string, to_slug: r.to_slug as string, link_type: r.link_type as string, context: (r.context as string) || '', depth: r.depth as number });
    }
    return result;
  }

  async getBacklinkCounts(slugs: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (slugs.length === 0) return result;
    for (const s of slugs) result.set(s, 0);
    const ph = slugs.map(() => '?').join(',');
    for (const r of this.db.prepare(`SELECT p.slug, COUNT(l.id) AS cnt FROM pages p LEFT JOIN links l ON l.to_page_id = p.id WHERE p.slug IN (${ph}) GROUP BY p.slug`).all(...slugs) as { slug: string; cnt: number }[])
      result.set(r.slug, Number(r.cnt));
    return result;
  }

  async findOrphanPages(): Promise<Array<{ slug: string; title: string; domain: string | null }>> {
    return this.db.prepare(
      `SELECT p.slug, COALESCE(p.title, p.slug) AS title, json_extract(p.frontmatter, '$.domain') AS domain
       FROM pages p WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id) ORDER BY p.slug`
    ).all() as Array<{ slug: string; title: string; domain: string | null }>;
  }

  // ── Tags ───────────────────────────────────────────────────

  async addTag(slug: string, tag: string): Promise<void> {
    this.db.prepare('INSERT OR IGNORE INTO tags (page_id, tag) SELECT id, ? FROM pages WHERE slug = ?').run(tag, slug);
  }

  async removeTag(slug: string, tag: string): Promise<void> {
    this.db.prepare('DELETE FROM tags WHERE page_id = (SELECT id FROM pages WHERE slug = ?) AND tag = ?').run(slug, tag);
  }

  async getTags(slug: string): Promise<string[]> {
    return (this.db.prepare('SELECT tag FROM tags WHERE page_id = (SELECT id FROM pages WHERE slug = ?) ORDER BY tag').all(slug) as { tag: string }[]).map(r => r.tag);
  }

  // ── Timeline ───────────────────────────────────────────────

  async addTimelineEntry(slug: string, entry: TimelineInput, opts?: { skipExistenceCheck?: boolean }): Promise<void> {
    if (!opts?.skipExistenceCheck) {
      if (!this.db.prepare('SELECT 1 FROM pages WHERE slug = ?').get(slug)) throw new Error(`Page not found: ${slug}`);
    }
    this.db.prepare(
      'INSERT OR IGNORE INTO timeline_entries (page_id, date, source, summary, detail) SELECT id, ?, ?, ?, ? FROM pages WHERE slug = ?'
    ).run(entry.date, entry.source || '', entry.summary, entry.detail || '', slug);
  }

  async addTimelineEntriesBatch(entries: TimelineBatchInput[]): Promise<number> {
    if (entries.length === 0) return 0;
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO timeline_entries (page_id, date, source, summary, detail) SELECT p.id, ?, ?, ?, ? FROM pages p WHERE p.slug = ? AND p.source_id = ?'
    );
    const run = this.db.transaction((batch: TimelineBatchInput[]) => {
      let c = 0;
      for (const e of batch) {
        c += stmt.run(e.date, e.source || '', e.summary, e.detail || '', e.slug, e.source_id || 'default').changes;
      }
      return c;
    });
    return run(entries);
  }

  async getTimeline(slug: string, opts?: TimelineOpts): Promise<TimelineEntry[]> {
    const limit = opts?.limit || 100;
    let rows: Record<string, unknown>[];
    if (opts?.after && opts?.before) {
      rows = this.db.prepare('SELECT te.* FROM timeline_entries te JOIN pages p ON p.id = te.page_id WHERE p.slug = ? AND te.date >= ? AND te.date <= ? ORDER BY te.date DESC LIMIT ?').all(slug, opts.after, opts.before, limit) as Record<string, unknown>[];
    } else if (opts?.after) {
      rows = this.db.prepare('SELECT te.* FROM timeline_entries te JOIN pages p ON p.id = te.page_id WHERE p.slug = ? AND te.date >= ? ORDER BY te.date DESC LIMIT ?').all(slug, opts.after, limit) as Record<string, unknown>[];
    } else {
      rows = this.db.prepare('SELECT te.* FROM timeline_entries te JOIN pages p ON p.id = te.page_id WHERE p.slug = ? ORDER BY te.date DESC LIMIT ?').all(slug, limit) as Record<string, unknown>[];
    }
    return rows.map(r => ({ id: r.id as number, page_id: r.page_id as number, date: r.date as string, source: r.source as string, summary: r.summary as string, detail: r.detail as string, created_at: new Date(r.created_at as string) }));
  }

  // ── Raw Data ───────────────────────────────────────────────

  async putRawData(slug: string, source: string, data: object): Promise<void> {
    this.db.prepare(
      `INSERT INTO raw_data (page_id, source, data) SELECT id, ?, ? FROM pages WHERE slug = ?
       ON CONFLICT (page_id, source) DO UPDATE SET data = excluded.data, fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    ).run(source, JSON.stringify(data), slug);
  }

  async getRawData(slug: string, source?: string): Promise<RawData[]> {
    const rows = source
      ? this.db.prepare('SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd JOIN pages p ON p.id = rd.page_id WHERE p.slug = ? AND rd.source = ?').all(slug, source)
      : this.db.prepare('SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd JOIN pages p ON p.id = rd.page_id WHERE p.slug = ?').all(slug);
    return (rows as Record<string, unknown>[]).map(r => ({
      source: r.source as string,
      data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data as Record<string, unknown>,
      fetched_at: new Date(r.fetched_at as string),
    }));
  }

  // ── Versions ───────────────────────────────────────────────

  async createVersion(slug: string): Promise<PageVersion> {
    const row = this.db.prepare(
      'INSERT INTO page_versions (page_id, compiled_truth, frontmatter) SELECT id, compiled_truth, frontmatter FROM pages WHERE slug = ? RETURNING *'
    ).get(slug) as Record<string, unknown>;
    return this._rowToPageVersion(row);
  }

  async getVersions(slug: string): Promise<PageVersion[]> {
    return (this.db.prepare(
      'SELECT pv.* FROM page_versions pv JOIN pages p ON p.id = pv.page_id WHERE p.slug = ? ORDER BY pv.snapshot_at DESC'
    ).all(slug) as Record<string, unknown>[]).map(r => this._rowToPageVersion(r));
  }

  async revertToVersion(slug: string, versionId: number): Promise<void> {
    const v = this.db.prepare('SELECT compiled_truth, frontmatter FROM page_versions WHERE id = ?').get(versionId) as { compiled_truth: string; frontmatter: string } | null;
    if (!v) return;
    this.db.prepare("UPDATE pages SET compiled_truth = ?, frontmatter = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE slug = ?").run(v.compiled_truth, v.frontmatter, slug);
  }

  // ── Stats + Health ─────────────────────────────────────────

  async getStats(): Promise<BrainStats> {
    const s = this.db.prepare(`SELECT
      (SELECT count(*) FROM pages) as page_count,
      (SELECT count(*) FROM content_chunks) as chunk_count,
      (SELECT count(*) FROM content_chunks WHERE embedded_at IS NOT NULL) as embedded_count,
      (SELECT count(*) FROM links) as link_count,
      (SELECT count(DISTINCT tag) FROM tags) as tag_count,
      (SELECT count(*) FROM timeline_entries) as timeline_entry_count`).get() as Record<string, number>;

    const pages_by_type: Record<string, number> = {};
    for (const t of this.db.prepare('SELECT type, count(*) as count FROM pages GROUP BY type ORDER BY count DESC').all() as { type: string; count: number }[])
      pages_by_type[t.type] = t.count;

    return { page_count: Number(s.page_count), chunk_count: Number(s.chunk_count), embedded_count: Number(s.embedded_count), link_count: Number(s.link_count), tag_count: Number(s.tag_count), timeline_entry_count: Number(s.timeline_entry_count), pages_by_type };
  }

  async getHealth(): Promise<BrainHealth> {
    const h = this.db.prepare(`SELECT
      (SELECT count(*) FROM pages) as page_count,
      CAST((SELECT count(*) FROM content_chunks WHERE embedded_at IS NOT NULL) AS REAL) / MAX(CAST((SELECT count(*) FROM content_chunks) AS REAL), 1.0) as embed_coverage,
      (SELECT count(*) FROM pages p WHERE p.updated_at < (SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id)) as stale_pages,
      (SELECT count(*) FROM pages p WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id) AND NOT EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = p.id)) as orphan_pages,
      (SELECT count(*) FROM links l WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = l.to_page_id)) as dead_links,
      (SELECT count(*) FROM content_chunks WHERE embedded_at IS NULL) as missing_embeddings,
      (SELECT count(*) FROM links) as link_count,
      (SELECT count(DISTINCT page_id) FROM timeline_entries) as pages_with_timeline`).get() as Record<string, unknown>;

    const ec = (this.db.prepare("SELECT count(*) as cnt FROM pages WHERE type IN ('person', 'company')").get() as { cnt: number }).cnt;
    const le = ec > 0 ? (this.db.prepare("SELECT count(*) as cnt FROM pages p WHERE p.type IN ('person', 'company') AND EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id)").get() as { cnt: number }).cnt : 0;
    const te = ec > 0 ? (this.db.prepare("SELECT count(*) as cnt FROM pages p WHERE p.type IN ('person', 'company') AND EXISTS (SELECT 1 FROM timeline_entries t WHERE t.page_id = p.id)").get() as { cnt: number }).cnt : 0;
    const connected = this.db.prepare("SELECT p.slug, (SELECT count(*) FROM links l WHERE l.from_page_id = p.id OR l.to_page_id = p.id) as link_count FROM pages p WHERE p.type IN ('person', 'company') ORDER BY link_count DESC LIMIT 5").all() as { slug: string; link_count: number }[];

    const pc = Number(h.page_count), emb = Number(h.embed_coverage), op = Number(h.orphan_pages), dl = Number(h.dead_links), lc = Number(h.link_count), pt = Number(h.pages_with_timeline);
    const ld = pc > 0 ? Math.min(lc / pc, 1) : 0;
    const tc = pc > 0 ? Math.min(pt / pc, 1) : 0;
    const no = pc > 0 ? 1 - (op / pc) : 1;
    const nd = pc > 0 ? 1 - Math.min(dl / pc, 1) : 1;
    const ecs = pc === 0 ? 0 : Math.round(emb * 35);
    const lds = pc === 0 ? 0 : Math.round(ld * 25);
    const tcs = pc === 0 ? 0 : Math.round(tc * 15);
    const nos = pc === 0 ? 0 : Math.round(no * 15);
    const nds = pc === 0 ? 0 : Math.round(nd * 10);

    return {
      page_count: pc, embed_coverage: emb, stale_pages: Number(h.stale_pages), orphan_pages: op,
      missing_embeddings: Number(h.missing_embeddings), brain_score: ecs + lds + tcs + nos + nds,
      dead_links: dl, link_coverage: ec > 0 ? le / ec : 0, timeline_coverage: ec > 0 ? te / ec : 0,
      most_connected: connected.map(c => ({ slug: c.slug, link_count: Number(c.link_count) })),
      embed_coverage_score: ecs, link_density_score: lds, timeline_coverage_score: tcs, no_orphans_score: nos, no_dead_links_score: nds,
    };
  }

  // ── Ingest Log ─────────────────────────────────────────────

  async logIngest(entry: IngestLogInput): Promise<void> {
    this.db.prepare('INSERT INTO ingest_log (source_type, source_ref, pages_updated, summary) VALUES (?, ?, ?, ?)').run(entry.source_type, entry.source_ref, JSON.stringify(entry.pages_updated), entry.summary);
  }

  async getIngestLog(opts?: { limit?: number }): Promise<IngestLogEntry[]> {
    return (this.db.prepare('SELECT * FROM ingest_log ORDER BY created_at DESC LIMIT ?').all(opts?.limit || 50) as Record<string, unknown>[]).map(r => ({
      id: r.id as number, source_type: r.source_type as string, source_ref: r.source_ref as string,
      pages_updated: typeof r.pages_updated === 'string' ? JSON.parse(r.pages_updated) : r.pages_updated as string[],
      summary: r.summary as string, created_at: new Date(r.created_at as string),
    }));
  }

  // ── Sync ───────────────────────────────────────────────────

  async updateSlug(oldSlug: string, newSlug: string): Promise<void> {
    newSlug = validateSlug(newSlug);
    this.db.prepare("UPDATE pages SET slug = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE slug = ?").run(newSlug, oldSlug);
    try {
      const t = await this._ensureLanceTable();
      const p = this.db.prepare('SELECT id FROM pages WHERE slug = ?').get(newSlug) as { id: number } | null;
      if (p) {
        const existing = await t.query().filter(`page_id = ${p.id}`).toArray();
        if (existing.length > 0) {
          await t.delete(`page_id = ${p.id}`);
          await t.add(existing.map((r: any) => ({ ...r, slug: newSlug })));
        }
      }
    } catch {}
  }

  async rewriteLinks(): Promise<void> { /* Links use page_id FKs, already correct after updateSlug */ }

  // ── Config ─────────────────────────────────────────────────

  async getConfig(key: string): Promise<string | null> {
    const r = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | null;
    return r ? r.value : null;
  }

  async setConfig(key: string, value: string): Promise<void> {
    this.db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ── Migration support ──────────────────────────────────────

  async runMigration(version: number, sql: string): Promise<void> {
    this.db.exec(sql);
    this.db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(version);
  }

  async getChunksWithEmbeddings(slug: string): Promise<Chunk[]> {
    const chunks = await this.getChunks(slug);
    if (chunks.length > 0) {
      const embs = await this.getEmbeddingsByChunkIds(chunks.map(c => c.id));
      for (const c of chunks) { const e = embs.get(c.id); if (e) c.embedding = e; }
    }
    return chunks;
  }

  async executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const t = sql.trim().toUpperCase();
    if (t.startsWith('SELECT') || t.startsWith('WITH') || t.startsWith('PRAGMA'))
      return (params ? this.db.prepare(sql).all(...params) : this.db.prepare(sql).all()) as T[];
    params ? this.db.prepare(sql).run(...params) : this.db.prepare(sql).run();
    return [] as T[];
  }

  // ── Private helpers ────────────────────────────────────────

  private _rowToPage(row: Record<string, unknown>): Page {
    return {
      id: row.id as number, slug: row.slug as string, type: row.type as PageType,
      title: row.title as string, compiled_truth: row.compiled_truth as string,
      timeline: row.timeline as string,
      frontmatter: (typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter) as Record<string, unknown>,
      content_hash: row.content_hash as string | undefined,
      created_at: new Date(row.created_at as string), updated_at: new Date(row.updated_at as string),
    };
  }

  private _rowToChunk(row: Record<string, unknown>): Chunk {
    return {
      id: row.id as number, page_id: row.page_id as number,
      chunk_index: row.chunk_index as number, chunk_text: row.chunk_text as string,
      chunk_source: row.chunk_source as 'compiled_truth' | 'timeline' | 'fenced_code',
      embedding: null, model: row.model as string,
      token_count: row.token_count as number | null,
      embedded_at: row.embedded_at ? new Date(row.embedded_at as string) : null,
      language: row.language as string | null ?? null,
      symbol_name: row.symbol_name as string | null ?? null,
      symbol_type: row.symbol_type as string | null ?? null,
      start_line: row.start_line as number | null ?? null,
      end_line: row.end_line as number | null ?? null,
      parent_symbol_path: row.parent_symbol_path ? JSON.parse(row.parent_symbol_path as string) : null,
      doc_comment: row.doc_comment as string | null ?? null,
      symbol_name_qualified: row.symbol_name_qualified as string | null ?? null,
    };
  }

  private _rowToSearchResult(row: Record<string, unknown>): SearchResult {
    const r: SearchResult = {
      slug: row.slug as string, page_id: row.page_id as number,
      title: row.title as string, type: row.type as PageType,
      chunk_text: row.chunk_text as string, chunk_source: row.chunk_source as 'compiled_truth' | 'timeline' | 'fenced_code',
      chunk_id: row.chunk_id as number, chunk_index: row.chunk_index as number,
      score: Number(row.score), stale: Boolean(row.stale),
    };
    if (typeof row.source_id === 'string') r.source_id = row.source_id;
    return r;
  }

  private _rowToPageVersion(row: Record<string, unknown>): PageVersion {
    return {
      id: row.id as number, page_id: row.page_id as number,
      compiled_truth: row.compiled_truth as string,
      frontmatter: (typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter) as Record<string, unknown>,
      snapshot_at: new Date(row.snapshot_at as string),
    };
  }
}

function rowToCodeEdge(row: Record<string, unknown>): CodeEdgeResult {
  return {
    id: row.id as number,
    from_chunk_id: row.from_chunk_id as number,
    to_chunk_id: row.to_chunk_id == null ? null : (row.to_chunk_id as number),
    from_symbol_qualified: (row.from_symbol_qualified as string) ?? '',
    to_symbol_qualified: (row.to_symbol_qualified as string) ?? '',
    edge_type: (row.edge_type as string) ?? '',
    edge_metadata: typeof row.edge_metadata === 'string' ? JSON.parse(row.edge_metadata) : (row.edge_metadata as Record<string, unknown>) ?? {},
    source_id: row.source_id == null ? null : (row.source_id as string),
    resolved: Boolean(row.resolved),
  };
}
