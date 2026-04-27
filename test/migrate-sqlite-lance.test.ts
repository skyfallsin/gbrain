import { describe, test, expect } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SQLiteLanceEngine } from '../src/core/sqlite-lance-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { CodeEdgeInput } from '../src/core/types.ts';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

// ── Helpers ──────────────────────────────────────────────────

async function createPGLiteSource(): Promise<PGLiteEngine> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
  await engine.initSchema();
  return engine;
}

async function createSQLiteTarget(name: string): Promise<SQLiteLanceEngine> {
  const dir = join(tmpdir(), `gbrain-migrate-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const engine = new SQLiteLanceEngine();
  await engine.connect({ engine: 'sqlite-lance', database_path: join(dir, 'brain.db') });
  await engine.initSchema();
  return engine;
}

// ── Tests ────────────────────────────────────────────────────

describe('PGLite → SQLite-Lance migration', () => {

  test('pages transfer with page_kind preserved', async () => {
    const source = await createPGLiteSource();
    const target = await createSQLiteTarget('page-kind');
    try {
      await source.putPage('src/main.ts', {
        type: 'topic', title: 'Main Entry',
        compiled_truth: 'export function main() {}',
        page_kind: 'code',
      });

      // Verify source has page_kind=code
      const [srcRow] = await source.executeRaw<{ page_kind: string }>(
        "SELECT page_kind FROM pages WHERE slug = 'src/main.ts'",
      );
      expect(srcRow.page_kind).toBe('code');

      // Migrate (simulate what migrate-engine does)
      const page = (await source.listPages())[0];
      await target.putPage(page.slug, {
        type: page.type, title: page.title,
        compiled_truth: page.compiled_truth,
        page_kind: 'code',
      });

      // Verify target preserved page_kind
      const [tgtRow] = await target.executeRaw<{ page_kind: string }>(
        "SELECT page_kind FROM pages WHERE slug = 'src/main.ts'",
      );
      expect(tgtRow.page_kind).toBe('code');
    } finally {
      await source.disconnect();
      await target.disconnect();
    }
  });

  test('chunks transfer with v0.19/v0.20 code metadata', async () => {
    const source = await createPGLiteSource();
    const target = await createSQLiteTarget('chunk-meta');
    try {
      await source.putPage('src/utils.ts', {
        type: 'topic', title: 'Utils',
        compiled_truth: 'function helper() {}',
        page_kind: 'code',
      });
      await source.upsertChunks('src/utils.ts', [{
        chunk_index: 0,
        chunk_text: 'function helper() { return 42; }',
        chunk_source: 'compiled_truth',
        language: 'typescript',
        symbol_name: 'helper',
        symbol_type: 'function',
        start_line: 1,
        end_line: 3,
        parent_symbol_path: ['Utils'],
        doc_comment: '/** A helper function */',
        symbol_name_qualified: 'Utils::helper',
      }]);

      const sourceChunks = await source.getChunks('src/utils.ts');
      expect(sourceChunks).toHaveLength(1);
      expect(sourceChunks[0].language).toBe('typescript');
      expect(sourceChunks[0].symbol_name_qualified).toBe('Utils::helper');

      // Migrate page + chunks
      await target.putPage('src/utils.ts', {
        type: 'topic', title: 'Utils',
        compiled_truth: 'function helper() {}',
        page_kind: 'code',
      });
      await target.upsertChunks('src/utils.ts', sourceChunks.map(c => ({
        chunk_index: c.chunk_index,
        chunk_text: c.chunk_text,
        chunk_source: c.chunk_source,
        language: c.language || undefined,
        symbol_name: c.symbol_name || undefined,
        symbol_type: c.symbol_type || undefined,
        start_line: c.start_line ?? undefined,
        end_line: c.end_line ?? undefined,
        parent_symbol_path: c.parent_symbol_path || undefined,
        doc_comment: c.doc_comment || undefined,
        symbol_name_qualified: c.symbol_name_qualified || undefined,
      })));

      const targetChunks = await target.getChunks('src/utils.ts');
      expect(targetChunks).toHaveLength(1);
      expect(targetChunks[0].language).toBe('typescript');
      expect(targetChunks[0].symbol_name).toBe('helper');
      expect(targetChunks[0].symbol_type).toBe('function');
      expect(targetChunks[0].start_line).toBe(1);
      expect(targetChunks[0].end_line).toBe(3);
      expect(targetChunks[0].doc_comment).toBe('/** A helper function */');
      expect(targetChunks[0].symbol_name_qualified).toBe('Utils::helper');
    } finally {
      await source.disconnect();
      await target.disconnect();
    }
  });

  test('links transfer with provenance metadata', async () => {
    const source = await createPGLiteSource();
    const target = await createSQLiteTarget('link-prov');
    try {
      await source.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: 'Alice.' });
      await source.putPage('companies/acme', { type: 'company', title: 'Acme', compiled_truth: 'Acme.' });
      await source.addLink(
        'people/alice', 'companies/acme', 'works at', 'works_at',
        'frontmatter', 'people/alice', 'employer',
      );

      const links = await source.getLinks('people/alice');
      expect(links).toHaveLength(1);
      expect(links[0].link_source).toBe('frontmatter');
      expect(links[0].origin_slug).toBe('people/alice');

      // Migrate
      await target.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: 'Alice.' });
      await target.putPage('companies/acme', { type: 'company', title: 'Acme', compiled_truth: 'Acme.' });
      await target.addLink(
        links[0].from_slug, links[0].to_slug, links[0].context, links[0].link_type,
        links[0].link_source, links[0].origin_slug, links[0].origin_field,
      );

      const targetLinks = await target.getLinks('people/alice');
      expect(targetLinks).toHaveLength(1);
      expect(targetLinks[0].link_source).toBe('frontmatter');
      expect(targetLinks[0].origin_slug).toBe('people/alice');
      expect(targetLinks[0].origin_field).toBe('employer');
    } finally {
      await source.disconnect();
      await target.disconnect();
    }
  });

  test('code edges transfer with chunk ID remapping', async () => {
    const source = await createPGLiteSource();
    const target = await createSQLiteTarget('code-edges');
    try {
      // Source: two pages with chunks + edges
      await source.putPage('src/a.ts', { type: 'topic', title: 'A', compiled_truth: 'a', page_kind: 'code' });
      await source.putPage('src/b.ts', { type: 'topic', title: 'B', compiled_truth: 'b', page_kind: 'code' });

      await source.upsertChunks('src/a.ts', [{
        chunk_index: 0, chunk_text: 'function callB() { b(); }', chunk_source: 'compiled_truth',
        symbol_name_qualified: 'A::callB',
      }]);
      await source.upsertChunks('src/b.ts', [{
        chunk_index: 0, chunk_text: 'function b() { return 1; }', chunk_source: 'compiled_truth',
        symbol_name_qualified: 'B::b',
      }]);

      const srcA = await source.getChunks('src/a.ts');
      const srcB = await source.getChunks('src/b.ts');

      // Resolved edge: A::callB → B::b
      await source.addCodeEdges([{
        from_chunk_id: srcA[0].id, to_chunk_id: srcB[0].id,
        from_symbol_qualified: 'A::callB', to_symbol_qualified: 'B::b',
        edge_type: 'calls',
      }]);
      // Unresolved edge: A::callB → External::foo
      await source.addCodeEdges([{
        from_chunk_id: srcA[0].id, to_chunk_id: null,
        from_symbol_qualified: 'A::callB', to_symbol_qualified: 'External::foo',
        edge_type: 'calls',
      }]);

      // Migrate pages + chunks to target
      for (const slug of ['src/a.ts', 'src/b.ts']) {
        const page = await source.getPage(slug);
        const [row] = await source.executeRaw<{ page_kind: string }>(
          `SELECT page_kind FROM pages WHERE slug = '${slug}'`,
        );
        await target.putPage(slug, {
          type: page!.type, title: page!.title, compiled_truth: page!.compiled_truth,
          page_kind: row.page_kind as 'code',
        });
        const chunks = await source.getChunks(slug);
        await target.upsertChunks(slug, chunks.map(c => ({
          chunk_index: c.chunk_index, chunk_text: c.chunk_text, chunk_source: c.chunk_source,
          symbol_name_qualified: c.symbol_name_qualified || undefined,
        })));
      }

      // Build chunk ID map (source → target)
      const chunkIdMap = new Map<number, number>();
      for (const slug of ['src/a.ts', 'src/b.ts']) {
        const src = await source.getChunks(slug);
        const tgt = await target.getChunks(slug);
        const tgtByIdx = new Map(tgt.map(c => [c.chunk_index, c.id]));
        for (const s of src) {
          const tid = tgtByIdx.get(s.chunk_index);
          if (tid !== undefined) chunkIdMap.set(s.id, tid);
        }
      }
      expect(chunkIdMap.size).toBe(2);

      // Remap and insert resolved edges
      const resolvedEdges = await source.executeRaw<{
        from_chunk_id: number; to_chunk_id: number;
        from_symbol_qualified: string; to_symbol_qualified: string;
        edge_type: string; edge_metadata: unknown; source_id: string | null;
      }>('SELECT from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, edge_metadata, source_id FROM code_edges_chunk');

      const resolvedBatch: CodeEdgeInput[] = [];
      for (const e of resolvedEdges) {
        const nf = chunkIdMap.get(e.from_chunk_id);
        const nt = chunkIdMap.get(e.to_chunk_id);
        if (nf !== undefined && nt !== undefined) {
          resolvedBatch.push({
            from_chunk_id: nf, to_chunk_id: nt,
            from_symbol_qualified: e.from_symbol_qualified,
            to_symbol_qualified: e.to_symbol_qualified,
            edge_type: e.edge_type,
            edge_metadata: typeof e.edge_metadata === 'string' ? JSON.parse(e.edge_metadata) : (e.edge_metadata as Record<string, unknown>) ?? {},
          });
        }
      }
      expect(resolvedBatch).toHaveLength(1);
      expect(await target.addCodeEdges(resolvedBatch)).toBe(1);

      // Remap and insert unresolved edges
      const unresolvedEdges = await source.executeRaw<{
        from_chunk_id: number;
        from_symbol_qualified: string; to_symbol_qualified: string;
        edge_type: string; edge_metadata: unknown; source_id: string | null;
      }>('SELECT from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, edge_metadata, source_id FROM code_edges_symbol');

      const unresolvedBatch: CodeEdgeInput[] = [];
      for (const e of unresolvedEdges) {
        const nf = chunkIdMap.get(e.from_chunk_id);
        if (nf !== undefined) {
          unresolvedBatch.push({
            from_chunk_id: nf, to_chunk_id: null,
            from_symbol_qualified: e.from_symbol_qualified,
            to_symbol_qualified: e.to_symbol_qualified,
            edge_type: e.edge_type,
            edge_metadata: typeof e.edge_metadata === 'string' ? JSON.parse(e.edge_metadata) : (e.edge_metadata as Record<string, unknown>) ?? {},
          });
        }
      }
      expect(unresolvedBatch).toHaveLength(1);
      expect(await target.addCodeEdges(unresolvedBatch)).toBe(1);

      // Verify edges on target
      const callees = await target.getCalleesOf('A::callB');
      expect(callees.length).toBeGreaterThanOrEqual(2);

      const resolved = callees.find(e => e.resolved && e.to_symbol_qualified === 'B::b');
      expect(resolved).toBeDefined();

      const unresolved = callees.find(e => !e.resolved && e.to_symbol_qualified === 'External::foo');
      expect(unresolved).toBeDefined();
    } finally {
      await source.disconnect();
      await target.disconnect();
    }
  });

  test('non-default sources transfer', async () => {
    const source = await createPGLiteSource();
    const target = await createSQLiteTarget('sources');
    try {
      // Insert a non-default source in PGLite
      await source.executeRaw(
        "INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (id) DO NOTHING",
        ['my-repo', 'My Repository', '/home/user/repo', '{"federated": true}'],
      );

      const [srcRow] = await source.executeRaw<{ id: string; name: string }>(
        "SELECT id, name FROM sources WHERE id = 'my-repo'",
      );
      expect(srcRow.id).toBe('my-repo');

      // Copy to SQLite target (matching what copySources does)
      const sources = await source.executeRaw<{
        id: string; name: string; local_path: string | null;
        last_commit: string | null; config: unknown; chunker_version: string | null;
      }>("SELECT id, name, local_path, last_commit, config, chunker_version FROM sources WHERE id != 'default'");

      for (const s of sources) {
        const configStr = typeof s.config === 'object' && s.config !== null
          ? JSON.stringify(s.config) : (s.config as string || '{}');
        await target.executeRaw(
          'INSERT OR IGNORE INTO sources (id, name, local_path, last_commit, config, chunker_version) VALUES (?, ?, ?, ?, ?, ?)',
          [s.id, s.name, s.local_path, s.last_commit, configStr, s.chunker_version],
        );
      }

      // Verify on target
      const [tgtRow] = await target.executeRaw<{ id: string; name: string; config: string }>(
        "SELECT id, name, config FROM sources WHERE id = 'my-repo'",
      );
      expect(tgtRow.id).toBe('my-repo');
      expect(tgtRow.name).toBe('My Repository');
      expect(JSON.parse(tgtRow.config).federated).toBe(true);
    } finally {
      await source.disconnect();
      await target.disconnect();
    }
  });

  test('data loss check detects Minion jobs', async () => {
    const source = await createPGLiteSource();
    try {
      await source.executeRaw(
        "INSERT INTO minion_jobs (name, queue, data) VALUES ($1, $2, $3::jsonb)",
        ['test-job', 'default', '{}'],
      );

      const warnings: string[] = [];
      for (const { table, label } of [
        { table: 'minion_jobs', label: 'Minion jobs' },
        { table: 'files', label: 'uploaded files' },
      ]) {
        try {
          const rows = await source.executeRaw<{ count: string | number }>(
            `SELECT count(*) as count FROM ${table}`,
          );
          const n = Number(rows[0]?.count ?? 0);
          if (n > 0) warnings.push(`${n} ${label}`);
        } catch { /* table doesn't exist */ }
      }

      expect(warnings).toContain('1 Minion jobs');
      expect(warnings).not.toContain('0 uploaded files');
    } finally {
      await source.disconnect();
    }
  });

  test('timeline and tags transfer', async () => {
    const source = await createPGLiteSource();
    const target = await createSQLiteTarget('timeline-tags');
    try {
      await source.putPage('people/bob', { type: 'person', title: 'Bob', compiled_truth: 'Bob.' });
      await source.addTag('people/bob', 'engineer');
      await source.addTag('people/bob', 'team-lead');
      await source.addTimelineEntry('people/bob', {
        date: '2024-01-15', source: 'meeting',
        summary: 'Met Bob at conference', detail: 'Discussed project alpha',
      });

      // Migrate
      const page = (await source.listPages())[0];
      await target.putPage(page.slug, {
        type: page.type, title: page.title, compiled_truth: page.compiled_truth,
      });
      for (const tag of await source.getTags(page.slug)) {
        await target.addTag(page.slug, tag);
      }
      for (const entry of await source.getTimeline(page.slug)) {
        await target.addTimelineEntry(page.slug, {
          date: String(entry.date), source: entry.source,
          summary: entry.summary, detail: entry.detail,
        });
      }

      const tags = await target.getTags('people/bob');
      expect(tags).toContain('engineer');
      expect(tags).toContain('team-lead');

      const timeline = await target.getTimeline('people/bob');
      expect(timeline).toHaveLength(1);
      expect(timeline[0].summary).toBe('Met Bob at conference');
      expect(timeline[0].detail).toBe('Discussed project alpha');
    } finally {
      await source.disconnect();
      await target.disconnect();
    }
  });

  test('raw data transfers', async () => {
    const source = await createPGLiteSource();
    const target = await createSQLiteTarget('raw-data');
    try {
      await source.putPage('companies/acme', { type: 'company', title: 'Acme', compiled_truth: 'Acme Inc.' });
      await source.putRawData('companies/acme', 'crunchbase', { funding: 5000000, stage: 'Series A' });

      await target.putPage('companies/acme', { type: 'company', title: 'Acme', compiled_truth: 'Acme Inc.' });
      const rawData = await source.getRawData('companies/acme');
      for (const rd of rawData) {
        await target.putRawData('companies/acme', rd.source, rd.data);
      }

      const tgtRaw = await target.getRawData('companies/acme');
      expect(tgtRaw).toHaveLength(1);
      expect(tgtRaw[0].source).toBe('crunchbase');
      expect((tgtRaw[0].data as any).funding).toBe(5000000);
      expect((tgtRaw[0].data as any).stage).toBe('Series A');
    } finally {
      await source.disconnect();
      await target.disconnect();
    }
  });

  test('FTS5 keyword search works after migration', async () => {
    const source = await createPGLiteSource();
    const target = await createSQLiteTarget('search');
    try {
      await source.putPage('topics/machine-learning', {
        type: 'topic', title: 'Machine Learning',
        compiled_truth: 'Machine learning is a subset of artificial intelligence.',
      });
      // searchKeyword on SQLite uses chunks_fts, so we need chunks
      await source.upsertChunks('topics/machine-learning', [{
        chunk_index: 0,
        chunk_text: 'Machine learning is a subset of artificial intelligence.',
        chunk_source: 'compiled_truth',
      }]);

      const page = (await source.listPages())[0];
      await target.putPage(page.slug, {
        type: page.type, title: page.title, compiled_truth: page.compiled_truth,
      });
      const chunks = await source.getChunks(page.slug);
      await target.upsertChunks(page.slug, chunks.map(c => ({
        chunk_index: c.chunk_index, chunk_text: c.chunk_text, chunk_source: c.chunk_source,
      })));

      // chunks_fts triggers auto-populate on INSERT, so keyword search should work
      const results = await target.searchKeyword('machine learning');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].slug).toBe('topics/machine-learning');
    } finally {
      await source.disconnect();
      await target.disconnect();
    }
  });

  test('config keys transfer', async () => {
    const source = await createPGLiteSource();
    const target = await createSQLiteTarget('config');
    try {
      await source.setConfig('embedding_model', 'text-embedding-3-large');
      await source.setConfig('embedding_dimensions', '1536');
      await source.setConfig('chunk_strategy', 'semantic');

      for (const key of ['embedding_model', 'embedding_dimensions', 'chunk_strategy']) {
        const val = await source.getConfig(key);
        if (val) await target.setConfig(key, val);
      }

      expect(await target.getConfig('embedding_model')).toBe('text-embedding-3-large');
      expect(await target.getConfig('embedding_dimensions')).toBe('1536');
      expect(await target.getConfig('chunk_strategy')).toBe('semantic');
    } finally {
      await source.disconnect();
      await target.disconnect();
    }
  });

  test('stats match after full migration', async () => {
    const source = await createPGLiteSource();
    const target = await createSQLiteTarget('stats');
    try {
      // Populate source with mixed data
      await source.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: 'Alice.' });
      await source.putPage('companies/acme', { type: 'company', title: 'Acme', compiled_truth: 'Acme.' });
      await source.putPage('topics/ai', { type: 'topic', title: 'AI', compiled_truth: 'Artificial intelligence.' });
      await source.addLink('people/alice', 'companies/acme', 'works at', 'works_at');
      await source.addTag('people/alice', 'engineer');
      await source.addTag('topics/ai', 'tech');
      await source.addTimelineEntry('people/alice', { date: '2024-01-01', summary: 'Hired' });

      // Migrate everything
      for (const page of await source.listPages({ limit: 100 })) {
        await target.putPage(page.slug, {
          type: page.type, title: page.title,
          compiled_truth: page.compiled_truth, timeline: page.timeline,
          frontmatter: page.frontmatter, content_hash: page.content_hash,
        });
        for (const tag of await source.getTags(page.slug)) await target.addTag(page.slug, tag);
        for (const entry of await source.getTimeline(page.slug)) {
          await target.addTimelineEntry(page.slug, {
            date: String(entry.date), source: entry.source,
            summary: entry.summary, detail: entry.detail,
          });
        }
      }
      for (const page of await source.listPages({ limit: 100 })) {
        for (const link of await source.getLinks(page.slug)) {
          await target.addLink(link.from_slug, link.to_slug, link.context, link.link_type);
        }
      }

      const srcStats = await source.getStats();
      const tgtStats = await target.getStats();

      expect(tgtStats.page_count).toBe(srcStats.page_count);
      expect(tgtStats.link_count).toBe(srcStats.link_count);
      expect(tgtStats.tag_count).toBe(srcStats.tag_count);
      expect(tgtStats.timeline_entry_count).toBe(srcStats.timeline_entry_count);
    } finally {
      await source.disconnect();
      await target.disconnect();
    }
  });
});
