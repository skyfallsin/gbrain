-- GBrain SQLite+LanceDB schema
-- Equivalent to pglite-schema.ts but using SQLite DDL, FTS5, and json functions.
-- Vector storage is handled by LanceDB (separate from SQLite).
--
-- Key differences from Postgres/PGLite schema:
-- - No pgvector (vectors in LanceDB)
-- - No pg_trgm (fuzzy search via FTS5 or Levenshtein)
-- - No tsvector triggers (FTS5 virtual tables instead)
-- - No SERIAL (INTEGER PRIMARY KEY AUTOINCREMENT)
-- - No TIMESTAMPTZ (TEXT ISO-8601 timestamps)
-- - No JSONB (TEXT with json functions)
-- - No unnest() (multi-row VALUES + JOIN)
-- - No RLS / access_tokens
-- - No Minions job queue (we have our own task infra)
-- - No subagent runtime tables

-- ============================================================
-- sources: multi-brain tenancy (v0.18.0)
-- ============================================================
CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  local_path    TEXT,
  last_commit   TEXT,
  last_sync_at  TEXT,
  config        TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO sources (id, name, config)
  VALUES ('default', 'default', '{"federated": true}');

-- ============================================================
-- pages: the core content table
-- ============================================================
CREATE TABLE IF NOT EXISTS pages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id       TEXT    NOT NULL DEFAULT 'default'
                  REFERENCES sources(id) ON DELETE CASCADE,
  slug            TEXT    NOT NULL,
  type            TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  compiled_truth  TEXT    NOT NULL DEFAULT '',
  timeline        TEXT    NOT NULL DEFAULT '',
  frontmatter     TEXT    NOT NULL DEFAULT '{}',
  content_hash    TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (source_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type);
CREATE INDEX IF NOT EXISTS idx_pages_source_id ON pages(source_id);
CREATE INDEX IF NOT EXISTS idx_pages_slug ON pages(slug);
CREATE INDEX IF NOT EXISTS idx_pages_updated_at ON pages(updated_at);

-- ============================================================
-- FTS5 virtual table for keyword search (replaces tsvector)
-- ============================================================
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title,
  compiled_truth,
  timeline,
  content='pages',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Triggers to keep FTS5 in sync with pages table
CREATE TRIGGER IF NOT EXISTS pages_fts_insert AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, compiled_truth, timeline)
  VALUES (NEW.id, NEW.title, NEW.compiled_truth, NEW.timeline);
END;

CREATE TRIGGER IF NOT EXISTS pages_fts_update AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, compiled_truth, timeline)
  VALUES ('delete', OLD.id, OLD.title, OLD.compiled_truth, OLD.timeline);
  INSERT INTO pages_fts(rowid, title, compiled_truth, timeline)
  VALUES (NEW.id, NEW.title, NEW.compiled_truth, NEW.timeline);
END;

CREATE TRIGGER IF NOT EXISTS pages_fts_delete AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, compiled_truth, timeline)
  VALUES ('delete', OLD.id, OLD.title, OLD.compiled_truth, OLD.timeline);
END;

-- ============================================================
-- content_chunks: chunked content (embeddings in LanceDB)
-- ============================================================
CREATE TABLE IF NOT EXISTS content_chunks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id       INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  chunk_text    TEXT    NOT NULL,
  chunk_source  TEXT    NOT NULL DEFAULT 'compiled_truth',
  model         TEXT    NOT NULL DEFAULT 'text-embedding-3-large',
  token_count   INTEGER,
  embedded_at   TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (page_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chunks_page ON content_chunks(page_id);

-- ============================================================
-- links: cross-references between pages
-- ============================================================
CREATE TABLE IF NOT EXISTS links (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_page_id    INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id      INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  link_type       TEXT    NOT NULL DEFAULT '',
  context         TEXT    NOT NULL DEFAULT '',
  link_source     TEXT    CHECK (link_source IS NULL OR link_source IN ('markdown', 'frontmatter', 'manual')),
  origin_page_id  INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  origin_field    TEXT,
  resolution_type TEXT    CHECK (resolution_type IS NULL OR resolution_type IN ('qualified', 'unqualified')),
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Functional unique index: COALESCE origin_page_id to 0 so NULL = NULL for dedup
CREATE UNIQUE INDEX IF NOT EXISTS idx_links_dedup
  ON links(from_page_id, to_page_id, link_type, COALESCE(link_source, ''), COALESCE(origin_page_id, 0));

CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_page_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_page_id);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(link_source);
CREATE INDEX IF NOT EXISTS idx_links_origin ON links(origin_page_id);

-- ============================================================
-- tags
-- ============================================================
CREATE TABLE IF NOT EXISTS tags (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tag     TEXT    NOT NULL,
  UNIQUE(page_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_tags_page_id ON tags(page_id);

-- ============================================================
-- raw_data: sidecar data
-- ============================================================
CREATE TABLE IF NOT EXISTS raw_data (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id    INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source     TEXT    NOT NULL,
  data       TEXT    NOT NULL,
  fetched_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(page_id, source)
);

CREATE INDEX IF NOT EXISTS idx_raw_data_page ON raw_data(page_id);

-- ============================================================
-- timeline_entries: structured timeline
-- ============================================================
CREATE TABLE IF NOT EXISTS timeline_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id    INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  date       TEXT    NOT NULL,
  source     TEXT    NOT NULL DEFAULT '',
  summary    TEXT    NOT NULL,
  detail     TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (page_id, date, summary)
);

CREATE INDEX IF NOT EXISTS idx_timeline_page ON timeline_entries(page_id);
CREATE INDEX IF NOT EXISTS idx_timeline_date ON timeline_entries(date);

-- ============================================================
-- page_versions: snapshot history
-- ============================================================
CREATE TABLE IF NOT EXISTS page_versions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id         INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  compiled_truth  TEXT    NOT NULL,
  frontmatter     TEXT    NOT NULL DEFAULT '{}',
  snapshot_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_versions_page ON page_versions(page_id);

-- ============================================================
-- ingest_log
-- ============================================================
CREATE TABLE IF NOT EXISTS ingest_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type   TEXT    NOT NULL,
  source_ref    TEXT    NOT NULL,
  pages_updated TEXT    NOT NULL DEFAULT '[]',
  summary       TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================
-- config: brain-level settings
-- ============================================================
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO config (key, value) VALUES
  ('version', '1'),
  ('engine', 'sqlite-lance'),
  ('embedding_model', 'text-embedding-3-large'),
  ('embedding_dimensions', '768'),
  ('chunk_strategy', 'semantic');

-- ============================================================
-- schema_migrations: track applied migrations
-- ============================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
