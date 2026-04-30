/**
 * SQLiteLanceEngine Tests — validates all BrainEngine methods against SQLite + LanceDB.
 *
 * No Docker, no DATABASE_URL, no PGLite WASM. Pure SQLite + LanceDB (both in-memory/tmp).
 * Mirrors pglite-engine.test.ts structure but adds SQLite-specific edge cases.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { SQLiteLanceEngine } from '../src/core/sqlite-lance-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { PageInput, ChunkInput } from '../src/core/types.ts';
import { rmSync } from 'fs';

let engine: SQLiteLanceEngine;
let lancePath: string;

beforeAll(async () => {
  engine = new SQLiteLanceEngine();
  await engine.connect({}); // in-memory SQLite, tmp LanceDB
  await engine.initSchema();
  // Capture lance path for cleanup
  lancePath = (engine as any)._lanceDb?.uri || '';
});

afterAll(async () => {
  await engine.disconnect();
  // Cleanup LanceDB tmp directory
  if (lancePath) {
    try { rmSync(lancePath, { recursive: true, force: true }); } catch {}
  }
});

// Helper to reset data between test groups
function truncateAll() {
  const db = (engine as any).db;
  const tables = [
    'content_chunks', 'links', 'tags', 'raw_data',
    'timeline_entries', 'page_versions', 'ingest_log', 'pages',
  ];
  for (const t of tables) {
    db.exec(`DELETE FROM ${t}`);
  }
  // Reset FTS5
  db.exec(`INSERT INTO pages_fts(pages_fts) VALUES('rebuild')`);
}

const testPage: PageInput = {
  type: 'concept',
  title: 'Test Page',
  compiled_truth: 'This is a test page about NovaMind AI agents.',
  timeline: '2024-01-15: Founded NovaMind',
};

// ─────────────────────────────────────────────────────────────────
// Engine Kind
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: Kind discriminator', () => {
  test('exposes readonly kind = sqlite-lance', () => {
    expect(engine.kind).toBe('sqlite-lance');
  });
});

// ─────────────────────────────────────────────────────────────────
// Pages CRUD
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: Pages', () => {
  beforeEach(truncateAll);

  test('putPage + getPage round trip', async () => {
    const page = await engine.putPage('test/hello', testPage);
    expect(page.slug).toBe('test/hello');
    expect(page.title).toBe('Test Page');
    expect(page.type).toBe('concept');
    expect(page.compiled_truth).toContain('NovaMind');

    const fetched = await engine.getPage('test/hello');
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe('Test Page');
    expect(fetched!.content_hash).toBeTruthy();
  });

  test('putPage upserts on conflict', async () => {
    await engine.putPage('test/upsert', testPage);
    const updated = await engine.putPage('test/upsert', {
      ...testPage,
      title: 'Updated Title',
    });
    expect(updated.title).toBe('Updated Title');

    const all = await engine.listPages();
    const matches = all.filter(p => p.slug === 'test/upsert');
    expect(matches.length).toBe(1);
  });

  test('getPage returns null for missing slug', async () => {
    const result = await engine.getPage('nonexistent/slug');
    expect(result).toBeNull();
  });

  test('deletePage removes page', async () => {
    await engine.putPage('test/delete-me', testPage);
    await engine.deletePage('test/delete-me');
    const result = await engine.getPage('test/delete-me');
    expect(result).toBeNull();
  });

  test('listPages with type filter', async () => {
    await engine.putPage('people/alice', { ...testPage, type: 'person', title: 'Alice' });
    await engine.putPage('concepts/rag', { ...testPage, type: 'concept', title: 'RAG' });

    const people = await engine.listPages({ type: 'person' });
    expect(people.length).toBe(1);
    expect(people[0].title).toBe('Alice');
  });

  test('listPages with tag filter', async () => {
    await engine.putPage('test/tagged', testPage);
    await engine.addTag('test/tagged', 'special');

    const tagged = await engine.listPages({ tag: 'special' });
    expect(tagged.length).toBe(1);
    expect(tagged[0].slug).toBe('test/tagged');
  });

  test('listPages with limit and offset', async () => {
    for (let i = 0; i < 5; i++) {
      await engine.putPage(`test/page-${i}`, { ...testPage, title: `Page ${i}` });
    }
    const page1 = await engine.listPages({ limit: 2, offset: 0 });
    expect(page1.length).toBe(2);
    const page2 = await engine.listPages({ limit: 2, offset: 2 });
    expect(page2.length).toBe(2);
    // No overlap
    const slugs1 = page1.map(p => p.slug);
    const slugs2 = page2.map(p => p.slug);
    expect(slugs1.filter(s => slugs2.includes(s)).length).toBe(0);
  });

  test('listPages with updated_after filter', async () => {
    await engine.putPage('test/old', testPage);
    await new Promise(r => setTimeout(r, 10));
    const cutoff = new Date().toISOString();
    await new Promise(r => setTimeout(r, 10));
    await engine.putPage('test/new', testPage);

    const recent = await engine.listPages({ updated_after: cutoff, limit: 100 });
    const recentSlugs = recent.map(p => p.slug);
    expect(recentSlugs).toContain('test/new');
    expect(recentSlugs).not.toContain('test/old');
  });

  test('resolveSlugs exact match', async () => {
    await engine.putPage('test/exact', testPage);
    const slugs = await engine.resolveSlugs('test/exact');
    expect(slugs).toEqual(['test/exact']);
  });

  test('resolveSlugs fuzzy match via LIKE', async () => {
    await engine.putPage('people/sarah-chen', { ...testPage, title: 'Sarah Chen' });
    const slugs = await engine.resolveSlugs('sarah');
    expect(slugs.length).toBeGreaterThan(0);
    expect(slugs).toContain('people/sarah-chen');
  });

  test('updateSlug renames page', async () => {
    await engine.putPage('test/old-name', testPage);
    await engine.updateSlug('test/old-name', 'test/new-name');
    expect(await engine.getPage('test/old-name')).toBeNull();
    expect((await engine.getPage('test/new-name'))?.title).toBe('Test Page');
  });

  test('validateSlug rejects path traversal', async () => {
    await expect(engine.putPage('../etc/passwd', testPage)).rejects.toThrow();
  });

  test('validateSlug rejects leading slash', async () => {
    await expect(engine.putPage('/absolute/path', testPage)).rejects.toThrow();
  });

  test('validateSlug normalizes to lowercase', async () => {
    const page = await engine.putPage('Test/UPPER', testPage);
    expect(page.slug).toBe('test/upper');
  });

  test('getAllSlugs returns Set of all page slugs', async () => {
    await engine.putPage('people/alice', { ...testPage, type: 'person', title: 'Alice' });
    await engine.putPage('people/bob', { ...testPage, type: 'person', title: 'Bob' });
    await engine.putPage('companies/acme', { ...testPage, type: 'company', title: 'Acme' });
    const slugs = await engine.getAllSlugs();
    expect(slugs).toBeInstanceOf(Set);
    expect(slugs.size).toBe(3);
    expect(slugs.has('people/alice')).toBe(true);
    expect(slugs.has('companies/acme')).toBe(true);
  });

  test('getAllSlugs on empty brain returns empty Set', async () => {
    const slugs = await engine.getAllSlugs();
    expect(slugs.size).toBe(0);
  });

  test('putPage preserves frontmatter as JSON', async () => {
    await engine.putPage('test/fm', {
      ...testPage,
      frontmatter: { domain: 'tech', investors: ['a16z', 'sequoia'] },
    });
    const page = await engine.getPage('test/fm');
    expect(page!.frontmatter.domain).toBe('tech');
    expect(page!.frontmatter.investors).toEqual(['a16z', 'sequoia']);
  });

  test('putPage with empty frontmatter defaults to {}', async () => {
    await engine.putPage('test/no-fm', { ...testPage, frontmatter: undefined });
    const page = await engine.getPage('test/no-fm');
    expect(page!.frontmatter).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────
// Search (FTS5)
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: FTS5 Keyword Search', () => {
  beforeAll(async () => {
    truncateAll();
    await engine.putPage('companies/novamind', {
      type: 'company', title: 'NovaMind',
      compiled_truth: 'NovaMind builds AI agents for enterprise automation.',
    });
    await engine.upsertChunks('companies/novamind', [
      { chunk_index: 0, chunk_text: 'NovaMind builds AI agents for enterprise', chunk_source: 'compiled_truth' },
    ]);
    await engine.putPage('concepts/rag', {
      type: 'concept', title: 'Retrieval-Augmented Generation',
      compiled_truth: 'RAG combines retrieval with generation for better answers.',
    });
    await engine.upsertChunks('concepts/rag', [
      { chunk_index: 0, chunk_text: 'RAG combines retrieval with generation', chunk_source: 'compiled_truth' },
    ]);
  });

  test('searchKeyword returns results for matching term', async () => {
    const results = await engine.searchKeyword('NovaMind');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].slug).toBe('companies/novamind');
  });

  test('searchKeyword returns empty for non-matching term', async () => {
    const results = await engine.searchKeyword('xyznonexistent');
    expect(results.length).toBe(0);
  });

  test('FTS5 triggers populate on insert', async () => {
    // chunk_text contains 'enterprise' — chunk-grain FTS via chunks_fts
    const results = await engine.searchKeyword('enterprise');
    expect(results.length).toBeGreaterThan(0);
  });

  test('searchKeyword respects limit', async () => {
    const results = await engine.searchKeyword('NovaMind', { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  test('searchKeyword limit clamped to MAX_SEARCH_LIMIT', async () => {
    // Should not throw, just clamp
    const results = await engine.searchKeyword('NovaMind', { limit: 500 });
    expect(results.length).toBeLessThanOrEqual(100);
  });

  test('searchVector returns empty when no embeddings', async () => {
    const fakeEmbedding = new Float32Array(768);
    const results = await engine.searchVector(fakeEmbedding);
    expect(results.length).toBe(0);
  });

  test('FTS5 updates when page content changes', async () => {
    truncateAll();
    await engine.putPage('test/fts-update', {
      type: 'concept', title: 'Original',
      compiled_truth: 'This talks about quantum computing.',
    });
    await engine.upsertChunks('test/fts-update', [
      { chunk_index: 0, chunk_text: 'quantum computing', chunk_source: 'compiled_truth' },
    ]);

    let results = await engine.searchKeyword('quantum');
    expect(results.length).toBeGreaterThan(0);

    // Update the page content
    await engine.putPage('test/fts-update', {
      type: 'concept', title: 'Updated',
      compiled_truth: 'This talks about machine learning.',
    });
    await engine.upsertChunks('test/fts-update', [
      { chunk_index: 0, chunk_text: 'machine learning', chunk_source: 'compiled_truth' },
    ]);

    // Old term should not match in FTS
    results = await engine.searchKeyword('quantum');
    expect(results.length).toBe(0);

    // New term should match
    results = await engine.searchKeyword('machine learning');
    expect(results.length).toBeGreaterThan(0);
  });

  test('FTS5 deletes when page is deleted', async () => {
    truncateAll();
    await engine.putPage('test/fts-delete', {
      type: 'concept', title: 'DeleteMe',
      compiled_truth: 'This page discusses blockchain technology.',
    });
    await engine.upsertChunks('test/fts-delete', [
      { chunk_index: 0, chunk_text: 'blockchain technology', chunk_source: 'compiled_truth' },
    ]);

    let results = await engine.searchKeyword('blockchain');
    expect(results.length).toBeGreaterThan(0);

    await engine.deletePage('test/fts-delete');

    results = await engine.searchKeyword('blockchain');
    expect(results.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// Vector Search (LanceDB)
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: Vector Search', () => {
  beforeEach(truncateAll);

  test('upsert chunk with embedding + searchVector finds it', async () => {
    await engine.putPage('test/vec', testPage);
    const embedding = new Float32Array(768);
    // Create a distinctive embedding
    for (let i = 0; i < 768; i++) embedding[i] = Math.sin(i * 0.1);

    await engine.upsertChunks('test/vec', [
      { chunk_index: 0, chunk_text: 'Vector test content', chunk_source: 'compiled_truth', embedding },
    ]);

    // Search with similar embedding
    const searchEmb = new Float32Array(768);
    for (let i = 0; i < 768; i++) searchEmb[i] = Math.sin(i * 0.1) + (Math.random() * 0.01);

    const results = await engine.searchVector(searchEmb);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].slug).toBe('test/vec');
    expect(results[0].score).toBeGreaterThan(0.5);
  });

  test('searchVector returns results ordered by similarity', async () => {
    await engine.putPage('test/close', { ...testPage, title: 'Close match' });
    await engine.putPage('test/far', { ...testPage, title: 'Far match' });

    const closeEmb = new Float32Array(768);
    const farEmb = new Float32Array(768);
    const queryEmb = new Float32Array(768);

    for (let i = 0; i < 768; i++) {
      queryEmb[i] = Math.sin(i * 0.1);
      closeEmb[i] = Math.sin(i * 0.1) + 0.01; // Very close
      farEmb[i] = Math.cos(i * 0.1); // Different direction
    }

    await engine.upsertChunks('test/close', [
      { chunk_index: 0, chunk_text: 'Close content', chunk_source: 'compiled_truth', embedding: closeEmb },
    ]);
    await engine.upsertChunks('test/far', [
      { chunk_index: 0, chunk_text: 'Far content', chunk_source: 'compiled_truth', embedding: farEmb },
    ]);

    const results = await engine.searchVector(queryEmb);
    expect(results.length).toBe(2);
    expect(results[0].slug).toBe('test/close');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  test('getEmbeddingsByChunkIds returns embeddings from LanceDB', async () => {
    await engine.putPage('test/emb', testPage);
    const embedding = new Float32Array(768).fill(0.42);

    await engine.upsertChunks('test/emb', [
      { chunk_index: 0, chunk_text: 'Embedded content', chunk_source: 'compiled_truth', embedding },
    ]);

    const chunks = await engine.getChunks('test/emb');
    const embMap = await engine.getEmbeddingsByChunkIds([chunks[0].id]);
    expect(embMap.size).toBe(1);
    const retrieved = embMap.get(chunks[0].id)!;
    expect(retrieved).toBeInstanceOf(Float32Array);
    expect(Math.abs(retrieved[0] - 0.42)).toBeLessThan(0.001);
  });

  test('getChunksWithEmbeddings enriches from LanceDB', async () => {
    await engine.putPage('test/enrich', testPage);
    const embedding = new Float32Array(768).fill(0.5);

    await engine.upsertChunks('test/enrich', [
      { chunk_index: 0, chunk_text: 'Enriched', chunk_source: 'compiled_truth', embedding },
    ]);

    const chunks = await engine.getChunksWithEmbeddings('test/enrich');
    expect(chunks.length).toBe(1);
    expect(chunks[0].embedding).not.toBeNull();
    expect(chunks[0].embedding!.length).toBe(768);
  });
});

// ─────────────────────────────────────────────────────────────────
// Chunks
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: Chunks', () => {
  beforeEach(truncateAll);

  test('upsertChunks + getChunks round trip', async () => {
    await engine.putPage('test/chunks', testPage);
    await engine.upsertChunks('test/chunks', [
      { chunk_index: 0, chunk_text: 'Chunk zero', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'Chunk one', chunk_source: 'compiled_truth' },
    ]);
    const chunks = await engine.getChunks('test/chunks');
    expect(chunks.length).toBe(2);
    expect(chunks[0].chunk_text).toBe('Chunk zero');
    expect(chunks[1].chunk_text).toBe('Chunk one');
  });

  test('upsertChunks removes orphan chunks', async () => {
    await engine.putPage('test/orphan', testPage);
    await engine.upsertChunks('test/orphan', [
      { chunk_index: 0, chunk_text: 'Keep', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'Remove', chunk_source: 'compiled_truth' },
    ]);
    await engine.upsertChunks('test/orphan', [
      { chunk_index: 0, chunk_text: 'Updated', chunk_source: 'compiled_truth' },
    ]);
    const chunks = await engine.getChunks('test/orphan');
    expect(chunks.length).toBe(1);
    expect(chunks[0].chunk_text).toBe('Updated');
  });

  test('upsertChunks throws for missing page', async () => {
    await expect(
      engine.upsertChunks('nonexistent/page', [
        { chunk_index: 0, chunk_text: 'test', chunk_source: 'compiled_truth' },
      ])
    ).rejects.toThrow('Page not found');
  });

  test('deleteChunks removes all chunks for page', async () => {
    await engine.putPage('test/delete-chunks', testPage);
    await engine.upsertChunks('test/delete-chunks', [
      { chunk_index: 0, chunk_text: 'Gone', chunk_source: 'compiled_truth' },
    ]);
    await engine.deleteChunks('test/delete-chunks');
    const chunks = await engine.getChunks('test/delete-chunks');
    expect(chunks.length).toBe(0);
  });

  test('upsertChunks with empty array clears all', async () => {
    await engine.putPage('test/clear', testPage);
    await engine.upsertChunks('test/clear', [
      { chunk_index: 0, chunk_text: 'Will be cleared', chunk_source: 'compiled_truth' },
    ]);
    await engine.upsertChunks('test/clear', []);
    const chunks = await engine.getChunks('test/clear');
    expect(chunks.length).toBe(0);
  });

  test('chunks ordered by chunk_index', async () => {
    await engine.putPage('test/order', testPage);
    await engine.upsertChunks('test/order', [
      { chunk_index: 2, chunk_text: 'Third', chunk_source: 'compiled_truth' },
      { chunk_index: 0, chunk_text: 'First', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'Second', chunk_source: 'compiled_truth' },
    ]);
    const chunks = await engine.getChunks('test/order');
    expect(chunks.map(c => c.chunk_text)).toEqual(['First', 'Second', 'Third']);
  });

  test('changed chunk_text nulls embedded_at so listStaleChunks picks it up', async () => {
    await engine.putPage('test/stale-embed', testPage);

    // 1. Upsert with a fake embedding so embedded_at is set
    const fakeVec = new Float32Array(768).fill(0.1);
    await engine.upsertChunks('test/stale-embed', [
      { chunk_index: 0, chunk_text: 'Original text', chunk_source: 'compiled_truth', embedding: fakeVec },
      { chunk_index: 1, chunk_text: 'Unchanged text', chunk_source: 'compiled_truth', embedding: fakeVec },
    ]);

    // Verify both are embedded (not stale)
    const chunksV1 = await engine.getChunks('test/stale-embed');
    expect(chunksV1[0].embedded_at).not.toBeNull();
    expect(chunksV1[1].embedded_at).not.toBeNull();
    expect(await engine.countStaleChunks()).toBe(0);

    // 2. Re-upsert: chunk 0 has changed text but no embedding, chunk 1 unchanged
    await engine.upsertChunks('test/stale-embed', [
      { chunk_index: 0, chunk_text: 'Updated text', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'Unchanged text', chunk_source: 'compiled_truth' },
    ]);

    // 3. Verify: changed chunk has embedded_at = NULL, unchanged keeps its timestamp
    const chunksV2 = await engine.getChunks('test/stale-embed');
    expect(chunksV2[0].chunk_text).toBe('Updated text');
    expect(chunksV2[0].embedded_at).toBeNull();
    expect(chunksV2[1].chunk_text).toBe('Unchanged text');
    expect(chunksV2[1].embedded_at).not.toBeNull();

    // 4. listStaleChunks should include the changed chunk
    const stale = await engine.listStaleChunks();
    const staleTexts = stale.map(s => s.chunk_text);
    expect(staleTexts).toContain('Updated text');
    expect(staleTexts).not.toContain('Unchanged text');
  });
});

// ─────────────────────────────────────────────────────────────────
// Links + Graph
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: Links', () => {
  beforeEach(async () => {
    truncateAll();
    await engine.putPage('people/alice', { ...testPage, type: 'person', title: 'Alice' });
    await engine.putPage('companies/acme', { ...testPage, type: 'company', title: 'ACME' });
    await engine.putPage('companies/beta', { ...testPage, type: 'company', title: 'Beta' });
  });

  test('addLink + getLinks', async () => {
    await engine.addLink('people/alice', 'companies/acme', 'works at', 'employment');
    const links = await engine.getLinks('people/alice');
    expect(links.length).toBe(1);
    expect(links[0].to_slug).toBe('companies/acme');
    expect(links[0].context).toBe('works at');
    expect(links[0].link_type).toBe('employment');
  });

  test('getBacklinks', async () => {
    await engine.addLink('people/alice', 'companies/acme');
    const backlinks = await engine.getBacklinks('companies/acme');
    expect(backlinks.length).toBe(1);
    expect(backlinks[0].from_slug).toBe('people/alice');
  });

  test('removeLink', async () => {
    await engine.addLink('people/alice', 'companies/acme');
    await engine.removeLink('people/alice', 'companies/acme');
    const links = await engine.getLinks('people/alice');
    expect(links.length).toBe(0);
  });

  test('addLink to nonexistent page is no-op', async () => {
    await engine.addLink('people/alice', 'nonexistent/page');
    const links = await engine.getLinks('people/alice');
    expect(links.length).toBe(0);
  });

  test('traverseGraph with depth', async () => {
    await engine.addLink('people/alice', 'companies/acme');
    await engine.addLink('companies/acme', 'companies/beta');

    const graph = await engine.traverseGraph('people/alice', 2);
    expect(graph.length).toBeGreaterThanOrEqual(2);
    const slugs = graph.map(n => n.slug);
    expect(slugs).toContain('people/alice');
    expect(slugs).toContain('companies/acme');
  });

  test('traverseGraph includes link details', async () => {
    await engine.addLink('people/alice', 'companies/acme', 'CEO', 'works_at');
    const graph = await engine.traverseGraph('people/alice', 1);
    const alice = graph.find(n => n.slug === 'people/alice');
    expect(alice!.links.length).toBe(1);
    expect(alice!.links[0].to_slug).toBe('companies/acme');
    expect(alice!.links[0].link_type).toBe('works_at');
  });

  test('multi-type links: same (from, to) with different types both stored', async () => {
    await engine.addLink('people/alice', 'companies/acme', 'CEO', 'works_at');
    await engine.addLink('people/alice', 'companies/acme', 'on the board', 'advises');
    const links = await engine.getLinks('people/alice');
    expect(links.length).toBe(2);
    const types = links.map(l => l.link_type).sort();
    expect(types).toEqual(['advises', 'works_at']);
  });

  test('upsert on same (from, to, type) updates context', async () => {
    await engine.addLink('people/alice', 'companies/acme', 'old context', 'works_at');
    await engine.addLink('people/alice', 'companies/acme', 'new context', 'works_at');
    const links = await engine.getLinks('people/alice');
    expect(links.length).toBe(1);
    expect(links[0].context).toBe('new context');
  });

  test('removeLink without linkType removes ALL types', async () => {
    await engine.addLink('people/alice', 'companies/acme', 'a', 'works_at');
    await engine.addLink('people/alice', 'companies/acme', 'b', 'advises');
    await engine.removeLink('people/alice', 'companies/acme');
    const links = await engine.getLinks('people/alice');
    expect(links.length).toBe(0);
  });

  test('removeLink with linkType removes only that type', async () => {
    await engine.addLink('people/alice', 'companies/acme', 'a', 'works_at');
    await engine.addLink('people/alice', 'companies/acme', 'b', 'advises');
    await engine.removeLink('people/alice', 'companies/acme', 'works_at');
    const links = await engine.getLinks('people/alice');
    expect(links.length).toBe(1);
    expect(links[0].link_type).toBe('advises');
  });
});

// ─────────────────────────────────────────────────────────────────
// Batch Links
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: addLinksBatch', () => {
  beforeEach(async () => {
    truncateAll();
    await engine.putPage('a', { type: 'concept', title: 'A', compiled_truth: '', timeline: '' });
    await engine.putPage('b', { type: 'concept', title: 'B', compiled_truth: '', timeline: '' });
    await engine.putPage('c', { type: 'concept', title: 'C', compiled_truth: '', timeline: '' });
  });

  test('empty batch returns 0', async () => {
    expect(await engine.addLinksBatch([])).toBe(0);
  });

  test('batch of 1 with missing optional fields', async () => {
    const inserted = await engine.addLinksBatch([{ from_slug: 'a', to_slug: 'b' }]);
    expect(inserted).toBe(1);
    const links = await engine.getLinks('a');
    expect(links.length).toBe(1);
    expect(links[0].context).toBe('');
    expect(links[0].link_type).toBe('');
  });

  test('within-batch duplicates are deduped', async () => {
    const inserted = await engine.addLinksBatch([
      { from_slug: 'a', to_slug: 'b', link_type: 'mention' },
      { from_slug: 'a', to_slug: 'b', link_type: 'mention' },
      { from_slug: 'a', to_slug: 'c', link_type: 'mention' },
    ]);
    expect(inserted).toBe(2);
  });

  test('rows with missing slug are silently dropped', async () => {
    const inserted = await engine.addLinksBatch([
      { from_slug: 'doesnt-exist', to_slug: 'b' },
      { from_slug: 'a', to_slug: 'b' },
    ]);
    expect(inserted).toBe(1);
  });

  test('half-existing batch returns count of new only', async () => {
    await engine.addLink('a', 'b', '', 'mention');
    const inserted = await engine.addLinksBatch([
      { from_slug: 'a', to_slug: 'b', link_type: 'mention' },
      { from_slug: 'a', to_slug: 'c', link_type: 'mention' },
    ]);
    expect(inserted).toBe(1);
  });

  test('batch of 100 fresh rows returns 100', async () => {
    for (let i = 0; i < 100; i++) {
      await engine.putPage(`target/${i}`, { type: 'concept', title: `T${i}`, compiled_truth: '', timeline: '' });
    }
    const batch = Array.from({ length: 100 }, (_, i) => ({
      from_slug: 'a', to_slug: `target/${i}`, link_type: 'mention',
    }));
    expect(await engine.addLinksBatch(batch)).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────
// Source-aware batch ops
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: batch ops source-awareness', () => {
  beforeEach(async () => {
    truncateAll();
    const db = (engine as any).db;
    db.exec(`INSERT OR IGNORE INTO sources (id, name) VALUES ('alt', 'alt')`);
    await engine.putPage('topics/ai', { type: 'concept', title: 'AI (default)', compiled_truth: '', timeline: '' });
    await engine.putPage('topics/ml', { type: 'concept', title: 'ML (default)', compiled_truth: '', timeline: '' });
    // Alt-source pages
    db.exec(
      `INSERT INTO pages (slug, type, title, compiled_truth, timeline, frontmatter, content_hash, source_id, updated_at)
       VALUES ('topics/ai', 'concept', 'AI (alt)', '', '', '{}', 'h1', 'alt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              ('topics/ml', 'concept', 'ML (alt)', '', '', '{}', 'h2', 'alt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
    );
  });

  test('addLinksBatch default source_id does NOT fan out across sources', async () => {
    const inserted = await engine.addLinksBatch([
      { from_slug: 'topics/ai', to_slug: 'topics/ml', link_type: 'mention' },
    ]);
    expect(inserted).toBe(1);
    const db = (engine as any).db;
    const rows = db.prepare(
      `SELECT f.source_id AS from_src, t.source_id AS to_src
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id`
    ).all();
    expect(rows.length).toBe(1);
    expect(rows[0].from_src).toBe('default');
    expect(rows[0].to_src).toBe('default');
  });

  test('addLinksBatch with explicit alt source_id', async () => {
    const inserted = await engine.addLinksBatch([
      {
        from_slug: 'topics/ai', to_slug: 'topics/ml', link_type: 'mention',
        from_source_id: 'alt', to_source_id: 'alt',
      },
    ]);
    expect(inserted).toBe(1);
    const db = (engine as any).db;
    const rows = db.prepare(
      `SELECT f.source_id AS from_src, t.source_id AS to_src
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id`
    ).all();
    expect(rows.length).toBe(1);
    expect(rows[0].from_src).toBe('alt');
    expect(rows[0].to_src).toBe('alt');
  });

  test('addTimelineEntriesBatch default source_id does NOT fan out', async () => {
    const inserted = await engine.addTimelineEntriesBatch([
      { slug: 'topics/ai', date: '2024-01-15', summary: 'Founded' },
    ]);
    expect(inserted).toBe(1);
    const db = (engine as any).db;
    const rows = db.prepare(
      `SELECT p.source_id FROM timeline_entries te
       JOIN pages p ON p.id = te.page_id`
    ).all();
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('default');
  });

  test('addTimelineEntriesBatch with explicit alt source_id', async () => {
    const inserted = await engine.addTimelineEntriesBatch([
      { slug: 'topics/ai', date: '2024-01-15', summary: 'Founded', source_id: 'alt' },
    ]);
    expect(inserted).toBe(1);
    const db = (engine as any).db;
    const rows = db.prepare(
      `SELECT p.source_id FROM timeline_entries te
       JOIN pages p ON p.id = te.page_id`
    ).all();
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('alt');
  });
});

// ─────────────────────────────────────────────────────────────────
// Graph Traversal
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: traversePaths', () => {
  beforeEach(async () => {
    truncateAll();
    await engine.putPage('people/alice', { ...testPage, type: 'person', title: 'Alice' });
    await engine.putPage('people/bob', { ...testPage, type: 'person', title: 'Bob' });
    await engine.putPage('people/carol', { ...testPage, type: 'person', title: 'Carol' });
    await engine.putPage('companies/acme', { ...testPage, type: 'company', title: 'Acme' });
    await engine.putPage('meetings/standup', { ...testPage, type: 'meeting', title: 'Standup' });
    await engine.addLink('meetings/standup', 'people/alice', '', 'attended');
    await engine.addLink('meetings/standup', 'people/bob', '', 'attended');
    await engine.addLink('meetings/standup', 'people/carol', '', 'attended');
    await engine.addLink('people/alice', 'companies/acme', '', 'works_at');
    await engine.addLink('people/bob', 'companies/acme', '', 'invested_in');
  });

  test('out direction: follows from->to edges', async () => {
    const paths = await engine.traversePaths('meetings/standup', { depth: 1 });
    expect(paths.length).toBe(3);
    expect(new Set(paths.map(p => p.to_slug))).toEqual(new Set(['people/alice', 'people/bob', 'people/carol']));
    expect(paths.every(p => p.link_type === 'attended')).toBe(true);
  });

  test('in direction: follows to->from edges', async () => {
    const paths = await engine.traversePaths('companies/acme', { depth: 1, direction: 'in' });
    expect(paths.length).toBe(2);
    expect(new Set(paths.map(p => p.from_slug))).toEqual(new Set(['people/alice', 'people/bob']));
  });

  test('linkType per-edge filter', async () => {
    const paths = await engine.traversePaths('companies/acme', {
      depth: 1, direction: 'in', linkType: 'works_at',
    });
    expect(paths.length).toBe(1);
    expect(paths[0].from_slug).toBe('people/alice');
  });

  test('depth 2: multi-hop traversal', async () => {
    const paths = await engine.traversePaths('meetings/standup', { depth: 2 });
    expect(paths.length).toBeGreaterThanOrEqual(5);
    const acmePaths = paths.filter(p => p.to_slug === 'companies/acme');
    expect(acmePaths.length).toBe(2);
    expect(acmePaths.every(p => p.depth === 2)).toBe(true);
  });

  test('non-existent slug returns empty', async () => {
    const paths = await engine.traversePaths('does/not-exist', { depth: 5 });
    expect(paths).toEqual([]);
  });

  test('both directions', async () => {
    const paths = await engine.traversePaths('people/alice', { depth: 1, direction: 'both' });
    // Alice has outbound to acme and inbound from standup
    expect(paths.length).toBeGreaterThanOrEqual(2);
    const toSlugs = paths.map(p => p.to_slug);
    const fromSlugs = paths.map(p => p.from_slug);
    expect(toSlugs).toContain('companies/acme');
    expect(fromSlugs).toContain('meetings/standup');
  });
});

describe('SQLiteLanceEngine: Cycle prevention', () => {
  beforeEach(async () => {
    truncateAll();
    await engine.putPage('people/a', { ...testPage, type: 'person', title: 'A' });
    await engine.putPage('people/b', { ...testPage, type: 'person', title: 'B' });
    await engine.addLink('people/a', 'people/b', '', 'mentions');
    await engine.addLink('people/b', 'people/a', '', 'mentions');
  });

  test('traverseGraph does not loop on cyclic graphs', async () => {
    const graph = await engine.traverseGraph('people/a', 5);
    const slugs = graph.map(n => n.slug);
    const counts = new Map<string, number>();
    for (const s of slugs) counts.set(s, (counts.get(s) ?? 0) + 1);
    for (const [, count] of counts) {
      expect(count).toBeLessThanOrEqual(2);
    }
  });

  test('traversePaths does not loop on cyclic graphs', async () => {
    const paths = await engine.traversePaths('people/a', { depth: 10 });
    // Should terminate with bounded results
    expect(paths.length).toBeLessThan(20);
  });
});

// ─────────────────────────────────────────────────────────────────
// Backlink Counts
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: getBacklinkCounts', () => {
  beforeEach(async () => {
    truncateAll();
    await engine.putPage('people/alice', { ...testPage, type: 'person', title: 'Alice' });
    await engine.putPage('people/bob', { ...testPage, type: 'person', title: 'Bob' });
    await engine.putPage('companies/acme', { ...testPage, type: 'company', title: 'Acme' });
  });

  test('returns Map<slug, count> for given slugs', async () => {
    await engine.addLink('people/alice', 'companies/acme', '', 'works_at');
    await engine.addLink('people/bob', 'companies/acme', '', 'invested_in');
    const counts = await engine.getBacklinkCounts(['companies/acme', 'people/alice']);
    expect(counts.get('companies/acme')).toBe(2);
    expect(counts.get('people/alice')).toBe(0);
  });

  test('empty input -> empty Map', async () => {
    const counts = await engine.getBacklinkCounts([]);
    expect(counts.size).toBe(0);
  });

  test('slugs with zero links: present with 0', async () => {
    const counts = await engine.getBacklinkCounts(['people/alice']);
    expect(counts.get('people/alice')).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// Orphan Pages
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: findOrphanPages', () => {
  beforeEach(truncateAll);

  test('returns pages with no inbound links', async () => {
    await engine.putPage('people/alice', { ...testPage, type: 'person', title: 'Alice' });
    await engine.putPage('companies/acme', { ...testPage, type: 'company', title: 'Acme' });

    const orphans = await engine.findOrphanPages();
    expect(orphans.length).toBe(2);
  });

  test('page with inbound link is not an orphan', async () => {
    await engine.putPage('people/alice', { ...testPage, type: 'person', title: 'Alice' });
    await engine.putPage('companies/acme', { ...testPage, type: 'company', title: 'Acme' });
    await engine.addLink('people/alice', 'companies/acme');

    const orphans = await engine.findOrphanPages();
    const orphanSlugs = orphans.map(o => o.slug);
    expect(orphanSlugs).not.toContain('companies/acme');
    expect(orphanSlugs).toContain('people/alice');
  });

  test('includes domain from frontmatter', async () => {
    await engine.putPage('test/domain', {
      ...testPage,
      frontmatter: { domain: 'tech' },
    });
    const orphans = await engine.findOrphanPages();
    const found = orphans.find(o => o.slug === 'test/domain');
    expect(found!.domain).toBe('tech');
  });
});

// ─────────────────────────────────────────────────────────────────
// Tags
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: Tags', () => {
  beforeEach(async () => {
    truncateAll();
    await engine.putPage('test/tags', testPage);
  });

  test('addTag + getTags', async () => {
    await engine.addTag('test/tags', 'alpha');
    await engine.addTag('test/tags', 'beta');
    const tags = await engine.getTags('test/tags');
    expect(tags).toEqual(['alpha', 'beta']);
  });

  test('removeTag', async () => {
    await engine.addTag('test/tags', 'remove-me');
    await engine.removeTag('test/tags', 'remove-me');
    const tags = await engine.getTags('test/tags');
    expect(tags).not.toContain('remove-me');
  });

  test('duplicate tag is idempotent', async () => {
    await engine.addTag('test/tags', 'dup');
    await engine.addTag('test/tags', 'dup');
    const tags = await engine.getTags('test/tags');
    expect(tags.filter(t => t === 'dup').length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// Timeline
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: Timeline', () => {
  beforeEach(async () => {
    truncateAll();
    await engine.putPage('test/timeline', testPage);
  });

  test('addTimelineEntry + getTimeline', async () => {
    await engine.addTimelineEntry('test/timeline', {
      date: '2024-01-15', summary: 'Founded', detail: 'Company founded',
    });
    const entries = await engine.getTimeline('test/timeline');
    expect(entries.length).toBe(1);
    expect(entries[0].summary).toBe('Founded');
    expect(entries[0].detail).toBe('Company founded');
  });

  test('getTimeline with date range', async () => {
    await engine.addTimelineEntry('test/timeline', { date: '2024-01-01', summary: 'Jan' });
    await engine.addTimelineEntry('test/timeline', { date: '2024-06-01', summary: 'Jun' });
    await engine.addTimelineEntry('test/timeline', { date: '2024-12-01', summary: 'Dec' });

    const filtered = await engine.getTimeline('test/timeline', {
      after: '2024-03-01', before: '2024-09-01',
    });
    expect(filtered.length).toBe(1);
    expect(filtered[0].summary).toBe('Jun');
  });

  test('getTimeline with after only', async () => {
    await engine.addTimelineEntry('test/timeline', { date: '2024-01-01', summary: 'Jan' });
    await engine.addTimelineEntry('test/timeline', { date: '2024-06-01', summary: 'Jun' });

    const filtered = await engine.getTimeline('test/timeline', { after: '2024-03-01' });
    expect(filtered.length).toBe(1);
    expect(filtered[0].summary).toBe('Jun');
  });

  test('dedup: same (date, summary) is idempotent', async () => {
    await engine.addTimelineEntry('test/timeline', { date: '2026-01-15', summary: 'Event A' });
    await engine.addTimelineEntry('test/timeline', { date: '2026-01-15', summary: 'Event A' });
    const entries = await engine.getTimeline('test/timeline');
    expect(entries.length).toBe(1);
  });

  test('different summary on same date: both inserted', async () => {
    await engine.addTimelineEntry('test/timeline', { date: '2026-01-15', summary: 'Morning' });
    await engine.addTimelineEntry('test/timeline', { date: '2026-01-15', summary: 'Evening' });
    const entries = await engine.getTimeline('test/timeline');
    expect(entries.length).toBe(2);
  });

  test('throws on missing page (default behavior)', async () => {
    await expect(engine.addTimelineEntry('does/not-exist', { date: '2026-01-15', summary: 'X' }))
      .rejects.toThrow();
  });

  test('skipExistenceCheck=true: silent no-op on missing page', async () => {
    await engine.addTimelineEntry(
      'does/not-exist',
      { date: '2026-01-15', summary: 'X' },
      { skipExistenceCheck: true },
    );
    // No throw = pass
  });
});

// ─────────────────────────────────────────────────────────────────
// Batch Timeline
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: addTimelineEntriesBatch', () => {
  beforeEach(async () => {
    truncateAll();
    await engine.putPage('p1', { type: 'concept', title: 'P1', compiled_truth: '', timeline: '' });
    await engine.putPage('p2', { type: 'concept', title: 'P2', compiled_truth: '', timeline: '' });
  });

  test('empty batch returns 0', async () => {
    expect(await engine.addTimelineEntriesBatch([])).toBe(0);
  });

  test('batch of 1 with missing optionals', async () => {
    const inserted = await engine.addTimelineEntriesBatch([
      { slug: 'p1', date: '2024-01-15', summary: 'Founded' },
    ]);
    expect(inserted).toBe(1);
    const entries = await engine.getTimeline('p1');
    expect(entries.length).toBe(1);
    expect(entries[0].source).toBe('');
    expect(entries[0].detail).toBe('');
  });

  test('within-batch duplicates are deduped', async () => {
    const inserted = await engine.addTimelineEntriesBatch([
      { slug: 'p1', date: '2024-01-15', summary: 'Founded' },
      { slug: 'p1', date: '2024-01-15', summary: 'Founded' },
      { slug: 'p1', date: '2024-02-01', summary: 'Launched' },
    ]);
    expect(inserted).toBe(2);
  });

  test('rows with missing slug are dropped', async () => {
    const inserted = await engine.addTimelineEntriesBatch([
      { slug: 'no-such-page', date: '2024-01-15', summary: 'Phantom' },
      { slug: 'p1', date: '2024-01-15', summary: 'Real' },
    ]);
    expect(inserted).toBe(1);
  });

  test('mix of new + existing returns count of new only', async () => {
    await engine.addTimelineEntry('p1', { date: '2024-01-15', summary: 'Founded' });
    const inserted = await engine.addTimelineEntriesBatch([
      { slug: 'p1', date: '2024-01-15', summary: 'Founded' },
      { slug: 'p1', date: '2024-02-01', summary: 'Launched' },
      { slug: 'p2', date: '2024-03-01', summary: 'Spun off' },
    ]);
    expect(inserted).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────
// Raw Data, Versions, Config, IngestLog
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: RawData', () => {
  beforeEach(async () => {
    truncateAll();
    await engine.putPage('test/raw', testPage);
  });

  test('putRawData + getRawData', async () => {
    await engine.putRawData('test/raw', 'crunchbase', { funding: '$10M' });
    const data = await engine.getRawData('test/raw', 'crunchbase');
    expect(data.length).toBe(1);
    expect((data[0].data as any).funding).toBe('$10M');
  });

  test('putRawData upserts on same source', async () => {
    await engine.putRawData('test/raw', 'crunchbase', { funding: '$10M' });
    await engine.putRawData('test/raw', 'crunchbase', { funding: '$20M' });
    const data = await engine.getRawData('test/raw', 'crunchbase');
    expect(data.length).toBe(1);
    expect((data[0].data as any).funding).toBe('$20M');
  });

  test('getRawData without source returns all', async () => {
    await engine.putRawData('test/raw', 'source1', { a: 1 });
    await engine.putRawData('test/raw', 'source2', { b: 2 });
    const data = await engine.getRawData('test/raw');
    expect(data.length).toBe(2);
  });
});

describe('SQLiteLanceEngine: Versions', () => {
  beforeEach(async () => {
    truncateAll();
    await engine.putPage('test/version', testPage);
  });

  test('createVersion + getVersions', async () => {
    const v = await engine.createVersion('test/version');
    expect(v.compiled_truth).toBe(testPage.compiled_truth);

    const versions = await engine.getVersions('test/version');
    expect(versions.length).toBe(1);
  });

  test('revertToVersion restores content', async () => {
    await engine.createVersion('test/version');
    await engine.putPage('test/version', { ...testPage, compiled_truth: 'Changed' });

    const versions = await engine.getVersions('test/version');
    await engine.revertToVersion('test/version', versions[0].id);

    const page = await engine.getPage('test/version');
    expect(page!.compiled_truth).toBe(testPage.compiled_truth);
  });

  test('multiple versions maintained', async () => {
    await engine.createVersion('test/version');
    await engine.putPage('test/version', { ...testPage, compiled_truth: 'V2' });
    await engine.createVersion('test/version');
    await engine.putPage('test/version', { ...testPage, compiled_truth: 'V3' });
    await engine.createVersion('test/version');

    const versions = await engine.getVersions('test/version');
    expect(versions.length).toBe(3);
  });
});

describe('SQLiteLanceEngine: Config', () => {
  test('getConfig + setConfig', async () => {
    await engine.setConfig('test_key', 'test_value');
    const val = await engine.getConfig('test_key');
    expect(val).toBe('test_value');
  });

  test('getConfig returns null for missing key', async () => {
    const val = await engine.getConfig('nonexistent_key');
    expect(val).toBeNull();
  });

  test('setConfig upserts', async () => {
    await engine.setConfig('upsert_key', 'v1');
    await engine.setConfig('upsert_key', 'v2');
    expect(await engine.getConfig('upsert_key')).toBe('v2');
  });
});

describe('SQLiteLanceEngine: IngestLog', () => {
  test('logIngest + getIngestLog', async () => {
    await engine.logIngest({
      source_type: 'git', source_ref: '/tmp/test-repo',
      pages_updated: ['test/a', 'test/b'], summary: 'Imported 2 pages',
    });
    const log = await engine.getIngestLog({ limit: 10 });
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].source_type).toBe('git');
    expect(log[0].pages_updated).toEqual(['test/a', 'test/b']);
  });

  test('getIngestLog respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await engine.logIngest({
        source_type: 'git', source_ref: `ref-${i}`,
        pages_updated: [], summary: `Entry ${i}`,
      });
    }
    const log = await engine.getIngestLog({ limit: 3 });
    expect(log.length).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────
// Stats + Health
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: Stats & Health', () => {
  beforeAll(async () => {
    truncateAll();
    await engine.putPage('test/stats', testPage);
    await engine.upsertChunks('test/stats', [
      { chunk_index: 0, chunk_text: 'chunk', chunk_source: 'compiled_truth' },
    ]);
    await engine.addTag('test/stats', 'stat-tag');
  });

  test('getStats returns correct counts', async () => {
    const stats = await engine.getStats();
    expect(stats.page_count).toBe(1);
    expect(stats.chunk_count).toBe(1);
    expect(stats.tag_count).toBe(1);
    expect(stats.pages_by_type.concept).toBe(1);
  });

  test('getHealth returns coverage metrics', async () => {
    const health = await engine.getHealth();
    expect(health.page_count).toBe(1);
    expect(health.missing_embeddings).toBe(1);
    expect(health.embed_coverage).toBe(0);
  });

  test('getHealth orphan_pages = islanded pages', async () => {
    truncateAll();
    await engine.putPage('people/alice', { ...testPage, type: 'person', title: 'Alice' });
    await engine.putPage('people/bob', { ...testPage, type: 'person', title: 'Bob' });
    await engine.putPage('companies/acme', { ...testPage, type: 'company', title: 'Acme' });

    let h = await engine.getHealth();
    expect(h.orphan_pages).toBe(3);

    await engine.addLink('people/alice', 'companies/acme', '', 'works_at');
    h = await engine.getHealth();
    expect(h.orphan_pages).toBe(1); // Only Bob is islanded
  });

  test('getHealth link_coverage', async () => {
    truncateAll();
    await engine.putPage('people/alice', { ...testPage, type: 'person', title: 'Alice' });
    await engine.putPage('people/bob', { ...testPage, type: 'person', title: 'Bob' });
    await engine.putPage('companies/acme', { ...testPage, type: 'company', title: 'Acme' });

    await engine.addLink('people/alice', 'companies/acme', '', 'works_at');
    const h = await engine.getHealth();
    expect(h.link_coverage).toBeCloseTo(1 / 3, 2);
  });

  test('getHealth timeline_coverage', async () => {
    truncateAll();
    await engine.putPage('people/alice', { ...testPage, type: 'person', title: 'Alice' });
    await engine.putPage('people/bob', { ...testPage, type: 'person', title: 'Bob' });
    await engine.putPage('companies/acme', { ...testPage, type: 'company', title: 'Acme' });

    await engine.addTimelineEntry('people/alice', { date: '2026-01-15', summary: 'Joined' });
    const h = await engine.getHealth();
    expect(h.timeline_coverage).toBeCloseTo(1 / 3, 2);
  });

  test('getHealth most_connected', async () => {
    truncateAll();
    await engine.putPage('people/alice', { ...testPage, type: 'person', title: 'Alice' });
    await engine.putPage('people/bob', { ...testPage, type: 'person', title: 'Bob' });
    await engine.putPage('companies/acme', { ...testPage, type: 'company', title: 'Acme' });
    await engine.addLink('people/alice', 'companies/acme', '', 'works_at');
    await engine.addLink('people/bob', 'companies/acme', '', 'invested_in');

    const h = await engine.getHealth();
    expect(h.most_connected.length).toBeGreaterThan(0);
    expect(h.most_connected[0].slug).toBe('companies/acme');
    expect(h.most_connected[0].link_count).toBe(2);
  });

  test('getHealth brain_score components sum to brain_score', async () => {
    truncateAll();
    await engine.putPage('test/score', testPage);
    const h = await engine.getHealth();
    const sum = h.embed_coverage_score + h.link_density_score +
                h.timeline_coverage_score + h.no_orphans_score + h.no_dead_links_score;
    expect(sum).toBe(h.brain_score);
  });
});

// ─────────────────────────────────────────────────────────────────
// Transactions
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: Transactions', () => {
  beforeEach(truncateAll);

  test('transaction commits on success', async () => {
    await engine.transaction(async (tx) => {
      await tx.putPage('test/tx-ok', testPage);
    });
    const page = await engine.getPage('test/tx-ok');
    expect(page).not.toBeNull();
  });

  test('transaction rolls back on error', async () => {
    try {
      await engine.transaction(async (tx) => {
        await tx.putPage('test/tx-fail', testPage);
        throw new Error('Deliberate rollback');
      });
    } catch { /* expected */ }

    const page = await engine.getPage('test/tx-fail');
    expect(page).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// Cascade Deletes
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: Cascade deletes', () => {
  test('deleting a page cascades to chunks, tags, links', async () => {
    truncateAll();
    await engine.putPage('test/cascade', testPage);
    await engine.upsertChunks('test/cascade', [
      { chunk_index: 0, chunk_text: 'cascade chunk', chunk_source: 'compiled_truth' },
    ]);
    await engine.addTag('test/cascade', 'cascade-tag');
    await engine.putPage('test/other', testPage);
    await engine.addLink('test/cascade', 'test/other');

    await engine.deletePage('test/cascade');

    const chunks = await engine.getChunks('test/cascade');
    expect(chunks.length).toBe(0);
    const tags = await engine.getTags('test/cascade');
    expect(tags.length).toBe(0);
    const links = await engine.getLinks('test/cascade');
    expect(links.length).toBe(0);
  });

  test('cascades to timeline entries', async () => {
    truncateAll();
    await engine.putPage('test/cascade-tl', testPage);
    await engine.addTimelineEntry('test/cascade-tl', { date: '2024-01-01', summary: 'Alive' });
    await engine.deletePage('test/cascade-tl');

    // Verify entry is gone by checking raw SQL
    const db = (engine as any).db;
    const count = db.prepare('SELECT count(*) as cnt FROM timeline_entries').get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  test('cascades to raw_data', async () => {
    truncateAll();
    await engine.putPage('test/cascade-rd', testPage);
    await engine.putRawData('test/cascade-rd', 'source', { a: 1 });
    await engine.deletePage('test/cascade-rd');

    const data = await engine.getRawData('test/cascade-rd');
    expect(data.length).toBe(0);
  });

  test('cascades to page_versions', async () => {
    truncateAll();
    await engine.putPage('test/cascade-ver', testPage);
    await engine.createVersion('test/cascade-ver');
    await engine.deletePage('test/cascade-ver');

    const db = (engine as any).db;
    const count = db.prepare('SELECT count(*) as cnt FROM page_versions').get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// findByTitleFuzzy
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: findByTitleFuzzy', () => {
  beforeEach(async () => {
    truncateAll();
    await engine.putPage('people/sarah-chen', { ...testPage, type: 'person', title: 'Sarah Chen' });
    await engine.putPage('people/bob-smith', { ...testPage, type: 'person', title: 'Bob Smith' });
    await engine.putPage('companies/acme-corp', { ...testPage, type: 'company', title: 'Acme Corp' });
  });

  test('exact title match returns similarity 1.0', async () => {
    const result = await engine.findByTitleFuzzy('Sarah Chen');
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('people/sarah-chen');
    expect(result!.similarity).toBe(1.0);
  });

  test('prefix match returns result', async () => {
    const result = await engine.findByTitleFuzzy('Sarah');
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('people/sarah-chen');
  });

  test('substring match returns result', async () => {
    const result = await engine.findByTitleFuzzy('Acme');
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('companies/acme-corp');
  });

  test('dirPrefix filters to matching prefix', async () => {
    const result = await engine.findByTitleFuzzy('Sarah Chen', 'companies');
    expect(result).toBeNull(); // Sarah is under people/, not companies/
  });

  test('returns null for no match', async () => {
    const result = await engine.findByTitleFuzzy('zzznonexistent');
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// executeRaw
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: executeRaw', () => {
  test('SELECT query returns rows', async () => {
    truncateAll();
    await engine.putPage('test/raw-query', testPage);
    const rows = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE slug = ?', ['test/raw-query']);
    expect(rows.length).toBe(1);
    expect(rows[0].slug).toBe('test/raw-query');
  });

  test('INSERT via executeRaw works', async () => {
    await engine.executeRaw(
      "INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)",
      ['raw_key', 'raw_value']
    );
    const val = await engine.getConfig('raw_key');
    expect(val).toBe('raw_value');
  });

  test('PRAGMA works via executeRaw', async () => {
    const rows = await engine.executeRaw<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(rows.length).toBe(1);
    // :memory: databases can't use WAL, returns 'memory'
    expect(['wal', 'memory']).toContain(rows[0].journal_mode);
  });
});

// ─────────────────────────────────────────────────────────────────
// withReservedConnection
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: withReservedConnection', () => {
  test('executeRaw within reserved connection works', async () => {
    truncateAll();
    await engine.putPage('test/reserved', testPage);
    const result = await engine.withReservedConnection(async (conn) => {
      const rows = await conn.executeRaw<{ cnt: number }>('SELECT count(*) as cnt FROM pages');
      return rows[0].cnt;
    });
    expect(result).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// Migration support
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: Migration support', () => {
  test('runMigration executes SQL and records version', async () => {
    await engine.runMigration(999, "INSERT OR IGNORE INTO config (key, value) VALUES ('migration_test', 'done')");
    const val = await engine.getConfig('migration_test');
    expect(val).toBe('done');

    const db = (engine as any).db;
    const row = db.prepare('SELECT version FROM schema_migrations WHERE version = 999').get();
    expect(row).not.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────
// Engine Factory
// ─────────────────────────────────────────────────────────────────
describe('Engine Factory: sqlite-lance', () => {
  test('createEngine with sqlite-lance returns SQLiteLanceEngine', async () => {
    const { createEngine } = await import('../src/core/engine-factory.ts');
    const e = await createEngine({ engine: 'sqlite-lance' });
    expect(e.kind).toBe('sqlite-lance');
    await e.disconnect();
  });
});

// ─────────────────────────────────────────────────────────────────
// Slug update with related data
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: updateSlug preserves related data', () => {
  beforeEach(truncateAll);

  test('updateSlug preserves tags', async () => {
    await engine.putPage('test/old', testPage);
    await engine.addTag('test/old', 'important');
    await engine.updateSlug('test/old', 'test/new');

    const tags = await engine.getTags('test/new');
    expect(tags).toContain('important');
  });

  test('updateSlug preserves links (via page_id FK)', async () => {
    await engine.putPage('test/a', testPage);
    await engine.putPage('test/b', testPage);
    await engine.addLink('test/a', 'test/b');

    await engine.updateSlug('test/a', 'test/a-renamed');
    const links = await engine.getLinks('test/a-renamed');
    expect(links.length).toBe(1);
    expect(links[0].to_slug).toBe('test/b');
  });

  test('updateSlug preserves chunks', async () => {
    await engine.putPage('test/chunked', testPage);
    await engine.upsertChunks('test/chunked', [
      { chunk_index: 0, chunk_text: 'preserved chunk', chunk_source: 'compiled_truth' },
    ]);
    await engine.updateSlug('test/chunked', 'test/chunked-renamed');

    const chunks = await engine.getChunks('test/chunked-renamed');
    expect(chunks.length).toBe(1);
    expect(chunks[0].chunk_text).toBe('preserved chunk');
  });
});

// ─────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────
describe('SQLiteLanceEngine: Edge cases', () => {
  beforeEach(truncateAll);

  test('empty brain stats', async () => {
    const stats = await engine.getStats();
    expect(stats.page_count).toBe(0);
    expect(stats.chunk_count).toBe(0);
    expect(stats.link_count).toBe(0);
  });

  test('empty brain health', async () => {
    const health = await engine.getHealth();
    expect(health.page_count).toBe(0);
    expect(health.brain_score).toBe(0);
    expect(health.most_connected).toEqual([]);
  });

  test('getEmbeddingsByChunkIds with empty array', async () => {
    const result = await engine.getEmbeddingsByChunkIds([]);
    expect(result.size).toBe(0);
  });

  test('getEmbeddingsByChunkIds with nonexistent ids', async () => {
    const result = await engine.getEmbeddingsByChunkIds([99999, 99998]);
    expect(result.size).toBe(0);
  });

  test('searchKeyword on empty brain returns empty', async () => {
    const results = await engine.searchKeyword('anything');
    expect(results.length).toBe(0);
  });

  test('traverseGraph on nonexistent slug returns empty', async () => {
    const graph = await engine.traverseGraph('nonexistent/slug');
    expect(graph.length).toBe(0);
  });

  test('very long slug is handled', async () => {
    const longSlug = 'a'.repeat(500);
    const page = await engine.putPage(longSlug, testPage);
    expect(page.slug).toBe(longSlug);
    const fetched = await engine.getPage(longSlug);
    expect(fetched).not.toBeNull();
  });

  test('unicode in title and content', async () => {
    await engine.putPage('test/unicode', {
      type: 'concept',
      title: '日本語テスト 🇯🇵',
      compiled_truth: '这是一个关于人工智能的测试页面。Ñoño.',
    });
    const page = await engine.getPage('test/unicode');
    expect(page!.title).toBe('日本語テスト 🇯🇵');
    expect(page!.compiled_truth).toContain('人工智能');
  });

  test('special characters in FTS5 search', async () => {
    await engine.putPage('test/special', {
      type: 'concept', title: 'C++ Programming',
      compiled_truth: 'C++ is a powerful language.',
    });
    await engine.upsertChunks('test/special', [
      { chunk_index: 0, chunk_text: 'C++ programming language', chunk_source: 'compiled_truth' },
    ]);
    // FTS5 should handle this without crashing
    const results = await engine.searchKeyword('programming');
    expect(results.length).toBeGreaterThan(0);
  });

  test('concurrent reads do not conflict', async () => {
    await engine.putPage('test/concurrent', testPage);
    const promises = Array.from({ length: 10 }, () => engine.getPage('test/concurrent'));
    const results = await Promise.all(promises);
    expect(results.every(r => r !== null)).toBe(true);
  });
});

// ============================================================
// v0.20.0+ new methods: countStaleChunks, listStaleChunks,
// searchKeywordChunks, code edges
// ============================================================

describe('SQLiteLanceEngine: countStaleChunks & listStaleChunks', () => {
  beforeAll(async () => {
    truncateAll();
    await engine.putPage('stale/test-page', {
      type: 'note', title: 'Stale Test',
      compiled_truth: 'Content for stale chunk testing.',
    });
    // Chunks without embeddings are "stale"
    await engine.upsertChunks('stale/test-page', [
      { chunk_index: 0, chunk_text: 'chunk zero no embedding', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'chunk one with embedding', chunk_source: 'compiled_truth',
        embedding: new Float32Array(768).fill(0.1), model: 'test-model', token_count: 5 },
      { chunk_index: 2, chunk_text: 'chunk two no embedding', chunk_source: 'compiled_truth' },
    ]);
  });

  test('countStaleChunks returns count of chunks with no embedding', async () => {
    const count = await engine.countStaleChunks();
    expect(count).toBe(2); // chunks 0 and 2
  });

  test('listStaleChunks returns stale chunk rows', async () => {
    const stale = await engine.listStaleChunks();
    expect(stale.length).toBe(2);
    expect(stale[0].slug).toBe('stale/test-page');
    expect(stale[0].chunk_index).toBe(0);
    expect(stale[1].chunk_index).toBe(2);
  });

  test('countStaleChunks returns 0 when all embedded', async () => {
    truncateAll();
    await engine.putPage('stale/all-embedded', {
      type: 'note', title: 'All Embedded',
      compiled_truth: 'All chunks have embeddings.',
    });
    await engine.upsertChunks('stale/all-embedded', [
      { chunk_index: 0, chunk_text: 'embedded chunk', chunk_source: 'compiled_truth',
        embedding: new Float32Array(768).fill(0.2), model: 'test', token_count: 3 },
    ]);
    expect(await engine.countStaleChunks()).toBe(0);
  });
});

describe('SQLiteLanceEngine: searchKeywordChunks', () => {
  beforeAll(async () => {
    truncateAll();
    await engine.putPage('search/page-a', {
      type: 'note', title: 'Page A',
      compiled_truth: 'Alpha content.',
    });
    await engine.upsertChunks('search/page-a', [
      { chunk_index: 0, chunk_text: 'alpha bravo charlie', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'alpha delta echo', chunk_source: 'compiled_truth' },
    ]);
    await engine.putPage('search/page-b', {
      type: 'note', title: 'Page B',
      compiled_truth: 'Bravo content.',
    });
    await engine.upsertChunks('search/page-b', [
      { chunk_index: 0, chunk_text: 'alpha foxtrot golf', chunk_source: 'compiled_truth' },
    ]);
  });

  test('returns all matching chunks (no page dedup)', async () => {
    const results = await engine.searchKeywordChunks('alpha');
    // 3 chunks contain 'alpha' across 2 pages
    expect(results.length).toBe(3);
  });

  test('searchKeyword deduplicates to one per page', async () => {
    const results = await engine.searchKeyword('alpha');
    // 2 pages contain 'alpha'
    expect(results.length).toBe(2);
    const slugs = results.map(r => r.slug);
    expect(new Set(slugs).size).toBe(2);
  });

  test('respects limit', async () => {
    const results = await engine.searchKeywordChunks('alpha', { limit: 1 });
    expect(results.length).toBe(1);
  });

  test('returns empty for non-matching term', async () => {
    const results = await engine.searchKeywordChunks('zzznotfound');
    expect(results.length).toBe(0);
  });
});

describe('SQLiteLanceEngine: Code chunk metadata', () => {
  beforeAll(async () => {
    truncateAll();
    await engine.putPage('code/myfile.ts', {
      type: 'code', title: 'myfile.ts',
      compiled_truth: 'function greet() { return "hello"; }',
      page_kind: 'code',
    });
    await engine.upsertChunks('code/myfile.ts', [
      {
        chunk_index: 0, chunk_text: 'function greet() { return "hello"; }',
        chunk_source: 'fenced_code',
        language: 'typescript', symbol_name: 'greet', symbol_type: 'function',
        start_line: 1, end_line: 1,
        parent_symbol_path: ['module'],
        doc_comment: 'Greets the user',
        symbol_name_qualified: 'myfile.greet',
      },
    ]);
  });

  test('getChunks returns code metadata', async () => {
    const chunks = await engine.getChunks('code/myfile.ts');
    expect(chunks.length).toBe(1);
    expect(chunks[0].language).toBe('typescript');
    expect(chunks[0].symbol_name).toBe('greet');
    expect(chunks[0].symbol_type).toBe('function');
    expect(chunks[0].start_line).toBe(1);
    expect(chunks[0].end_line).toBe(1);
    expect(chunks[0].parent_symbol_path).toEqual(['module']);
    expect(chunks[0].doc_comment).toBe('Greets the user');
    expect(chunks[0].symbol_name_qualified).toBe('myfile.greet');
    expect(chunks[0].chunk_source).toBe('fenced_code');
  });

  test('markdown chunks have null code metadata', async () => {
    await engine.putPage('plain/note', {
      type: 'note', title: 'Note',
      compiled_truth: 'Just text.',
    });
    await engine.upsertChunks('plain/note', [
      { chunk_index: 0, chunk_text: 'Just plain text.', chunk_source: 'compiled_truth' },
    ]);
    const chunks = await engine.getChunks('plain/note');
    expect(chunks[0].language).toBeNull();
    expect(chunks[0].symbol_name).toBeNull();
    expect(chunks[0].parent_symbol_path).toBeNull();
  });

  test('searchKeywordChunks with language filter', async () => {
    const ts = await engine.searchKeywordChunks('greet', { language: 'typescript' });
    expect(ts.length).toBe(1);
    const py = await engine.searchKeywordChunks('greet', { language: 'python' });
    expect(py.length).toBe(0);
  });
});

describe('SQLiteLanceEngine: Code Edges', () => {
  let chunkA: number;
  let chunkB: number;
  let chunkC: number;

  beforeAll(async () => {
    truncateAll();
    await engine.putPage('code/a.ts', {
      type: 'code', title: 'a.ts', compiled_truth: 'function fnA() {}', page_kind: 'code',
    });
    await engine.upsertChunks('code/a.ts', [
      { chunk_index: 0, chunk_text: 'function fnA() { fnB(); }', chunk_source: 'fenced_code',
        symbol_name_qualified: 'a.fnA', language: 'typescript', symbol_name: 'fnA', symbol_type: 'function' },
    ]);
    await engine.putPage('code/b.ts', {
      type: 'code', title: 'b.ts', compiled_truth: 'function fnB() {}', page_kind: 'code',
    });
    await engine.upsertChunks('code/b.ts', [
      { chunk_index: 0, chunk_text: 'function fnB() { fnC(); }', chunk_source: 'fenced_code',
        symbol_name_qualified: 'b.fnB', language: 'typescript', symbol_name: 'fnB', symbol_type: 'function' },
    ]);
    await engine.putPage('code/c.ts', {
      type: 'code', title: 'c.ts', compiled_truth: 'function fnC() {}', page_kind: 'code',
    });
    await engine.upsertChunks('code/c.ts', [
      { chunk_index: 0, chunk_text: 'function fnC() { }', chunk_source: 'fenced_code',
        symbol_name_qualified: 'c.fnC', language: 'typescript', symbol_name: 'fnC', symbol_type: 'function' },
    ]);

    // Get chunk IDs
    const chunksA = await engine.getChunks('code/a.ts');
    const chunksB = await engine.getChunks('code/b.ts');
    const chunksC = await engine.getChunks('code/c.ts');
    chunkA = chunksA[0].id;
    chunkB = chunksB[0].id;
    chunkC = chunksC[0].id;
  });

  test('addCodeEdges inserts resolved edges', async () => {
    const count = await engine.addCodeEdges([
      { from_chunk_id: chunkA, to_chunk_id: chunkB, from_symbol_qualified: 'a.fnA',
        to_symbol_qualified: 'b.fnB', edge_type: 'calls' },
      { from_chunk_id: chunkB, to_chunk_id: chunkC, from_symbol_qualified: 'b.fnB',
        to_symbol_qualified: 'c.fnC', edge_type: 'calls' },
    ]);
    expect(count).toBe(2);
  });

  test('addCodeEdges inserts unresolved edges', async () => {
    const count = await engine.addCodeEdges([
      { from_chunk_id: chunkA, from_symbol_qualified: 'a.fnA',
        to_symbol_qualified: 'external.util', edge_type: 'imports' },
    ]);
    expect(count).toBe(1);
  });

  test('addCodeEdges is idempotent (ON CONFLICT DO NOTHING)', async () => {
    const count = await engine.addCodeEdges([
      { from_chunk_id: chunkA, to_chunk_id: chunkB, from_symbol_qualified: 'a.fnA',
        to_symbol_qualified: 'b.fnB', edge_type: 'calls' },
    ]);
    expect(count).toBe(0);
  });

  test('getCallersOf returns edges pointing to a symbol', async () => {
    const callers = await engine.getCallersOf('b.fnB');
    expect(callers.length).toBe(1);
    expect(callers[0].from_chunk_id).toBe(chunkA);
    expect(callers[0].edge_type).toBe('calls');
    expect(callers[0].resolved).toBe(true);
  });

  test('getCalleesOf returns edges from a symbol', async () => {
    const callees = await engine.getCalleesOf('a.fnA');
    // resolved: a.fnA -> b.fnB, unresolved: a.fnA -> external.util
    expect(callees.length).toBe(2);
    const types = callees.map(e => e.edge_type).sort();
    expect(types).toEqual(['calls', 'imports']);
  });

  test('getEdgesByChunk direction=out', async () => {
    const edges = await engine.getEdgesByChunk(chunkA, { direction: 'out' });
    // resolved: a->b, unresolved: a->external.util
    expect(edges.length).toBe(2);
    expect(edges.every(e => e.from_chunk_id === chunkA)).toBe(true);
  });

  test('getEdgesByChunk direction=in', async () => {
    const edges = await engine.getEdgesByChunk(chunkB, { direction: 'in' });
    expect(edges.length).toBe(1);
    expect(edges[0].from_chunk_id).toBe(chunkA);
    expect(edges[0].to_chunk_id).toBe(chunkB);
  });

  test('getEdgesByChunk direction=both', async () => {
    const edges = await engine.getEdgesByChunk(chunkB, { direction: 'both' });
    // in: a->b, out: b->c, unresolved out: none (b has no unresolved)
    expect(edges.length).toBe(2);
  });

  test('getEdgesByChunk with edgeType filter', async () => {
    const edges = await engine.getEdgesByChunk(chunkA, { direction: 'out', edgeType: 'imports' });
    expect(edges.length).toBe(1);
    expect(edges[0].to_symbol_qualified).toBe('external.util');
  });

  test('deleteCodeEdgesForChunks removes edges in both directions', async () => {
    // Delete edges for chunkA
    await engine.deleteCodeEdgesForChunks([chunkA]);
    // a->b gone (resolved), a->external.util gone (unresolved)
    const callersB = await engine.getCallersOf('b.fnB');
    expect(callersB.length).toBe(0);
    const calleesA = await engine.getCalleesOf('a.fnA');
    expect(calleesA.length).toBe(0);
    // b->c should still exist
    const calleesB = await engine.getCalleesOf('b.fnB');
    expect(calleesB.length).toBe(1);
    expect(calleesB[0].to_symbol_qualified).toBe('c.fnC');
  });

  test('deleteCodeEdgesForChunks with empty array is no-op', async () => {
    await engine.deleteCodeEdgesForChunks([]);
    // Should not throw
  });

  test('code edge metadata round-trips as JSON', async () => {
    await engine.addCodeEdges([
      { from_chunk_id: chunkA, to_chunk_id: chunkB, from_symbol_qualified: 'a.fnA',
        to_symbol_qualified: 'b.fnB', edge_type: 'calls',
        edge_metadata: { line: 5, confidence: 0.9 } },
    ]);
    const edges = await engine.getCallersOf('b.fnB');
    expect(edges.length).toBe(1);
    expect(edges[0].edge_metadata).toEqual({ line: 5, confidence: 0.9 });
  });
});

describe('SQLiteLanceEngine: page_kind support', () => {
  beforeAll(async () => {
    truncateAll();
  });

  test('putPage with page_kind=code stores correctly', async () => {
    const page = await engine.putPage('code/test.ts', {
      type: 'code', title: 'test.ts',
      compiled_truth: 'const x = 1;',
      page_kind: 'code',
    });
    expect(page.type).toBe('code');
    // page_kind is stored but not in the Page return type currently
    const raw = await engine.executeRaw<{ page_kind: string }>(
      'SELECT page_kind FROM pages WHERE slug = ?', ['code/test.ts']);
    expect(raw[0].page_kind).toBe('code');
  });

  test('putPage defaults page_kind to markdown', async () => {
    await engine.putPage('notes/default', {
      type: 'note', title: 'Default Kind',
      compiled_truth: 'No explicit page_kind.',
    });
    const raw = await engine.executeRaw<{ page_kind: string }>(
      'SELECT page_kind FROM pages WHERE slug = ?', ['notes/default']);
    expect(raw[0].page_kind).toBe('markdown');
  });
});
