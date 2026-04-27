/**
 * Engine migration: transfer brain data between PGLite, Postgres, and SQLite-Lance.
 *
 * Usage:
 *   gbrain migrate --to supabase [--url <connection_string>]
 *   gbrain migrate --to pglite [--path <db_path>]
 *   gbrain migrate --to sqlite [--path <db_path>]
 *   gbrain migrate --to <engine> --force  (overwrite non-empty target)
 *
 * ## SQLite-Lance migration — known gaps
 *
 * The sqlite-lance engine is a lighter-weight store for memory-constrained
 * environments (512 MB Fly machines). Migrating TO it works for the core
 * knowledge graph but the following are not yet handled:
 *
 * ### Data that is silently dropped
 * The migration warns but cannot transfer rows from tables that have no
 * SQLite-Lance equivalent:
 *   - minion_jobs / minion_inbox / minion_attachments (job queue)
 *   - subagent_messages / subagent_tool_executions / subagent_rate_leases
 *   - access_tokens / mcp_request_log
 *   - files / file_migration_ledger (uploaded-file tracking)
 *   - budget_ledger / budget_reservations
 *   - gbrain_cycle_locks
 *
 * ### Multi-source page assignment
 * Pages are copied via listPages() which returns Page objects without
 * source_id. All pages land in the 'default' source on the target even
 * if the source brain has pages assigned to non-default sources. The
 * non-default source rows ARE copied (copySources), but pages are not
 * re-associated with them. Fixing this requires either:
 *   a) adding source_id to the Page interface, or
 *   b) a post-migration executeRaw UPDATE that re-assigns pages by slug
 *      prefix / config heuristic.
 *
 * ### Ingest log
 * ingest_log rows are not copied. They are informational ("what was
 * ingested when") and regenerable from a re-sync, so the loss is
 * cosmetic rather than data-destructive.
 *
 * ### Page versions
 * The migration loops over versions but does not actually recreate them.
 * createVersion() snapshots the current page state, which is correct
 * only for the latest version. Historical snapshots would need direct
 * INSERT via executeRaw to preserve their original compiled_truth and
 * frontmatter.
 *
 * ### Date coercion
 * PGLite returns DATE columns as JavaScript Date objects. SQLite's
 * better-sqlite3 silently drops INSERT rows that receive a Date bind
 * param (zero rows, no error). Timeline dates are coerced to
 * YYYY-MM-DD strings during migration, but any future column that
 * carries a Date from PGLite will hit the same silent-drop bug.
 * A defensive toStr() wrapper around all bind params would close this
 * for good.
 *
 * ### Reverse direction (SQLite-Lance → PGLite/Postgres)
 * The core data path works because it uses BrainEngine methods, but
 * copySources writes engine-specific SQL (INSERT OR IGNORE vs
 * ON CONFLICT). The current implementation handles both directions.
 * However, PGLite/Postgres expect JSONB for the sources.config column
 * while SQLite stores TEXT — the ::jsonb cast in the Postgres INSERT
 * handles this, but edge cases with malformed JSON in the SQLite store
 * would surface as a migration error rather than silent loss.
 */

import { createEngine } from '../core/engine-factory.ts';
import { loadConfig, saveConfig, toEngineConfig, type GBrainConfig } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import type { EngineConfig, CodeEdgeInput } from '../core/types.ts';
import { homedir } from 'os';
import { join } from 'path';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

interface MigrateOpts {
  targetEngine: 'postgres' | 'pglite' | 'sqlite-lance';
  targetUrl?: string;
  targetPath?: string;
  force: boolean;
}

function parseArgs(args: string[]): MigrateOpts {
  const toIdx = args.indexOf('--to');
  if (toIdx === -1 || !args[toIdx + 1]) {
    throw new Error('Usage: gbrain migrate --to <supabase|pglite|sqlite> [--url <url>] [--path <path>] [--force]');
  }

  const targetRaw = args[toIdx + 1];
  const targetEngine: string = targetRaw === 'supabase' ? 'postgres'
    : (targetRaw === 'sqlite' || targetRaw === 'sqlite-lance') ? 'sqlite-lance'
    : targetRaw;
  if (targetEngine !== 'postgres' && targetEngine !== 'pglite' && targetEngine !== 'sqlite-lance') {
    throw new Error(`Unknown target engine: "${targetRaw}". Use: supabase, pglite, or sqlite`);
  }

  const urlIdx = args.indexOf('--url');
  const pathIdx = args.indexOf('--path');

  return {
    targetEngine: targetEngine as MigrateOpts['targetEngine'],
    targetUrl: urlIdx !== -1 ? args[urlIdx + 1] : undefined,
    targetPath: pathIdx !== -1 ? args[pathIdx + 1] : undefined,
    force: args.includes('--force'),
  };
}

function getManifestPath(): string {
  return join(homedir(), '.gbrain', 'migrate-manifest.json');
}

interface MigrateManifest {
  completed_slugs: string[];
  target_engine: string;
  started_at: string;
}

function loadManifest(): MigrateManifest | null {
  const path = getManifestPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function saveManifest(manifest: MigrateManifest): void {
  writeFileSync(getManifestPath(), JSON.stringify(manifest, null, 2));
}

function clearManifest(): void {
  const path = getManifestPath();
  if (existsSync(path)) unlinkSync(path);
}

// ── Migration helpers ────────────────────────────────────────

/**
 * Read page_kind (v0.19.0) for all pages. The Page interface doesn't expose
 * page_kind, so we query it directly via executeRaw.
 */
async function getPageKinds(engine: BrainEngine): Promise<Map<string, string>> {
  try {
    const rows = await engine.executeRaw<{ slug: string; page_kind: string }>(
      'SELECT slug, page_kind FROM pages',
    );
    return new Map(rows.map(r => [r.slug, r.page_kind || 'markdown']));
  } catch {
    return new Map();
  }
}

/**
 * Copy non-default sources between engines. Uses engine-appropriate SQL
 * because PGLite/Postgres use $N placeholders + ::jsonb casts while SQLite uses ?.
 */
async function copySources(source: BrainEngine, target: BrainEngine): Promise<number> {
  try {
    const rows = await source.executeRaw<{
      id: string; name: string; local_path: string | null;
      last_commit: string | null; config: unknown; chunker_version: string | null;
    }>("SELECT id, name, local_path, last_commit, config, chunker_version FROM sources WHERE id != 'default'");

    for (const s of rows) {
      const configStr = typeof s.config === 'object' && s.config !== null
        ? JSON.stringify(s.config) : (s.config as string || '{}');
      if (target.kind === 'sqlite-lance') {
        await target.executeRaw(
          'INSERT OR IGNORE INTO sources (id, name, local_path, last_commit, config, chunker_version) VALUES (?, ?, ?, ?, ?, ?)',
          [s.id, s.name, s.local_path, s.last_commit, configStr, s.chunker_version],
        );
      } else {
        await target.executeRaw(
          "INSERT INTO sources (id, name, local_path, last_commit, config, chunker_version) VALUES ($1, $2, $3, $4, $5::jsonb, $6) ON CONFLICT (id) DO NOTHING",
          [s.id, s.name, s.local_path, s.last_commit, configStr, s.chunker_version],
        );
      }
    }
    return rows.length;
  } catch {
    return 0;
  }
}

/**
 * Build a mapping from source chunk IDs → target chunk IDs.
 * Matches on (slug, chunk_index), which is unique on both engines.
 */
async function buildChunkIdMap(
  source: BrainEngine,
  target: BrainEngine,
  slugs: string[],
): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  for (const slug of slugs) {
    const sourceChunks = await source.getChunks(slug);
    if (sourceChunks.length === 0) continue;
    const targetChunks = await target.getChunks(slug);
    const targetByIndex = new Map(targetChunks.map(c => [c.chunk_index, c.id]));
    for (const sc of sourceChunks) {
      const tid = targetByIndex.get(sc.chunk_index);
      if (tid !== undefined) map.set(sc.id, tid);
    }
  }
  return map;
}

/**
 * Copy code edges (v0.20.0 Cathedral II) with chunk ID remapping.
 * Reads from both code_edges_chunk (resolved) and code_edges_symbol (unresolved),
 * remaps chunk IDs, and writes to the target via addCodeEdges.
 */
async function copyCodeEdges(
  source: BrainEngine,
  target: BrainEngine,
  chunkIdMap: Map<number, number>,
): Promise<number> {
  if (chunkIdMap.size === 0) return 0;
  let count = 0;

  // Resolved edges (code_edges_chunk)
  try {
    const edges = await source.executeRaw<{
      from_chunk_id: number; to_chunk_id: number;
      from_symbol_qualified: string; to_symbol_qualified: string;
      edge_type: string; edge_metadata: unknown; source_id: string | null;
    }>('SELECT from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, edge_metadata, source_id FROM code_edges_chunk');

    const batch: CodeEdgeInput[] = [];
    for (const e of edges) {
      const newFrom = chunkIdMap.get(e.from_chunk_id);
      const newTo = chunkIdMap.get(e.to_chunk_id);
      if (newFrom !== undefined && newTo !== undefined) {
        batch.push({
          from_chunk_id: newFrom,
          to_chunk_id: newTo,
          from_symbol_qualified: e.from_symbol_qualified,
          to_symbol_qualified: e.to_symbol_qualified,
          edge_type: e.edge_type,
          edge_metadata: typeof e.edge_metadata === 'string'
            ? JSON.parse(e.edge_metadata)
            : (e.edge_metadata as Record<string, unknown>) ?? {},
          source_id: e.source_id,
        });
      }
    }
    if (batch.length > 0) count += await target.addCodeEdges(batch);
  } catch { /* code_edges_chunk may not exist on older brains */ }

  // Unresolved refs (code_edges_symbol)
  try {
    const edges = await source.executeRaw<{
      from_chunk_id: number;
      from_symbol_qualified: string; to_symbol_qualified: string;
      edge_type: string; edge_metadata: unknown; source_id: string | null;
    }>('SELECT from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, edge_metadata, source_id FROM code_edges_symbol');

    const batch: CodeEdgeInput[] = [];
    for (const e of edges) {
      const newFrom = chunkIdMap.get(e.from_chunk_id);
      if (newFrom !== undefined) {
        batch.push({
          from_chunk_id: newFrom,
          to_chunk_id: null,
          from_symbol_qualified: e.from_symbol_qualified,
          to_symbol_qualified: e.to_symbol_qualified,
          edge_type: e.edge_type,
          edge_metadata: typeof e.edge_metadata === 'string'
            ? JSON.parse(e.edge_metadata)
            : (e.edge_metadata as Record<string, unknown>) ?? {},
          source_id: e.source_id,
        });
      }
    }
    if (batch.length > 0) count += await target.addCodeEdges(batch);
  } catch { /* code_edges_symbol may not exist on older brains */ }

  return count;
}

/**
 * Check for data in tables that exist in PGLite/Postgres but not in SQLite-Lance.
 * Returns human-readable warnings the caller can display.
 */
async function checkDataLoss(source: BrainEngine, targetKind: string): Promise<string[]> {
  if (targetKind !== 'sqlite-lance') return [];
  const warnings: string[] = [];
  const checks: Array<{ table: string; label: string }> = [
    { table: 'minion_jobs', label: 'Minion jobs' },
    { table: 'minion_inbox', label: 'Minion inbox messages' },
    { table: 'minion_attachments', label: 'Minion attachments' },
    { table: 'access_tokens', label: 'access tokens' },
    { table: 'files', label: 'uploaded files' },
    { table: 'budget_ledger', label: 'budget ledger entries' },
    { table: 'budget_reservations', label: 'budget reservations' },
  ];
  for (const { table, label } of checks) {
    try {
      const rows = await source.executeRaw<{ count: string | number }>(
        `SELECT count(*) as count FROM ${table}`,
      );
      const n = Number(rows[0]?.count ?? 0);
      if (n > 0) warnings.push(`${n} ${label}`);
    } catch { /* table doesn't exist on this engine */ }
  }
  return warnings;
}

// ── Main migration ───────────────────────────────────────────

export async function runMigrateEngine(sourceEngine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: gbrain init');
    process.exit(1);
  }

  // Check source != target
  if (config.engine === opts.targetEngine) {
    console.error(`Already using ${opts.targetEngine} engine. Nothing to migrate.`);
    process.exit(1);
  }

  // Build target config
  const targetConfig: EngineConfig = { engine: opts.targetEngine };
  if (opts.targetEngine === 'postgres') {
    targetConfig.database_url = opts.targetUrl || process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
    if (!targetConfig.database_url) {
      console.error('Target is Supabase but no connection string provided. Use: --url <connection_string>');
      process.exit(1);
    }
  } else if (opts.targetEngine === 'sqlite-lance') {
    targetConfig.database_path = opts.targetPath || join(homedir(), '.gbrain', 'brain.db');
  } else {
    targetConfig.database_path = opts.targetPath || join(homedir(), '.gbrain', 'brain.pglite');
  }

  // Connect to target
  console.log(`Connecting to target (${opts.targetEngine})...`);
  const targetEngine = await createEngine(targetConfig);
  await targetEngine.connect(targetConfig);
  await targetEngine.initSchema();

  // Check if target has data
  const targetStats = await targetEngine.getStats();
  if (targetStats.page_count > 0 && !opts.force) {
    console.error(`Target brain is not empty (${targetStats.page_count} pages).`);
    console.error('Run with --force to overwrite, or migrate to an empty brain.');
    await targetEngine.disconnect();
    process.exit(1);
  }

  if (targetStats.page_count > 0 && opts.force) {
    console.log('--force: wiping target brain...');
    const pages = await targetEngine.listPages({ limit: 100000 });
    for (const p of pages) {
      await targetEngine.deletePage(p.slug);
    }
  }

  // Warn about data that will not transfer to sqlite-lance
  const lossWarnings = await checkDataLoss(sourceEngine, opts.targetEngine);
  if (lossWarnings.length > 0) {
    console.log('\n\u26A0  The following data will NOT be migrated to sqlite-lance:');
    for (const w of lossWarnings) console.log(`   \u2022 ${w}`);
    console.log('   (SQLite-Lance does not have Minion, file, or access-token tables)\n');
  }

  // Load or create manifest for resume
  let manifest = loadManifest();
  if (manifest && manifest.target_engine !== opts.targetEngine) {
    console.log('Previous migration was to a different target. Starting fresh.');
    manifest = null;
  }
  const completedSet = new Set(manifest?.completed_slugs || []);
  if (!manifest) {
    manifest = {
      completed_slugs: [],
      target_engine: opts.targetEngine,
      started_at: new Date().toISOString(),
    };
  }

  // Pre-read page_kind (not exposed in BrainEngine Page interface)
  const pageKinds = await getPageKinds(sourceEngine);

  // Copy non-default sources before pages (pages may reference them)
  const sourcesCopied = await copySources(sourceEngine, targetEngine);
  if (sourcesCopied > 0) {
    console.log(`Copied ${sourcesCopied} non-default source(s).`);
  }

  // Get all source pages
  const sourceStats = await sourceEngine.getStats();
  const allPages = await sourceEngine.listPages({ limit: 100000 });
  const pagesToMigrate = allPages.filter(p => !completedSet.has(p.slug));

  console.log(`Migrating ${pagesToMigrate.length} pages (${allPages.length} total, ${completedSet.size} already done)...`);

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('migrate.copy_pages', pagesToMigrate.length);

  let migrated = 0;
  for (const page of pagesToMigrate) {
    // Copy page (include page_kind which the Page interface lacks)
    await targetEngine.putPage(page.slug, {
      type: page.type,
      title: page.title,
      compiled_truth: page.compiled_truth,
      timeline: page.timeline,
      frontmatter: page.frontmatter,
      content_hash: page.content_hash,
      page_kind: (pageKinds.get(page.slug) as 'markdown' | 'code') || 'markdown',
    });

    // Copy chunks with embeddings + v0.19/v0.20 code metadata
    const chunks = await sourceEngine.getChunksWithEmbeddings(page.slug);
    if (chunks.length > 0) {
      await targetEngine.upsertChunks(page.slug, chunks.map(c => ({
        chunk_index: c.chunk_index,
        chunk_text: c.chunk_text,
        chunk_source: c.chunk_source,
        embedding: c.embedding || undefined,
        model: c.model,
        token_count: c.token_count || undefined,
        language: c.language || undefined,
        symbol_name: c.symbol_name || undefined,
        symbol_type: c.symbol_type || undefined,
        start_line: c.start_line ?? undefined,
        end_line: c.end_line ?? undefined,
        parent_symbol_path: c.parent_symbol_path || undefined,
        doc_comment: c.doc_comment || undefined,
        symbol_name_qualified: c.symbol_name_qualified || undefined,
      })));
    }

    // Copy tags
    const tags = await sourceEngine.getTags(page.slug);
    for (const tag of tags) {
      await targetEngine.addTag(page.slug, tag);
    }

    // Copy timeline (coerce Date objects to strings — PGLite returns Date
    // objects for date columns, but SQLite bind params silently drop them)
    const timeline = await sourceEngine.getTimeline(page.slug);
    for (const entry of timeline) {
      await targetEngine.addTimelineEntry(page.slug, {
        date: entry.date instanceof Date ? entry.date.toISOString().slice(0, 10) : String(entry.date),
        source: entry.source,
        summary: entry.summary,
        detail: entry.detail,
      });
    }

    // Copy raw data
    const rawData = await sourceEngine.getRawData(page.slug);
    for (const rd of rawData) {
      await targetEngine.putRawData(page.slug, rd.source, rd.data);
    }

    // Copy versions
    const versions = await sourceEngine.getVersions(page.slug);
    // Versions are snapshots, we recreate them on the target
    // (createVersion takes a snapshot of current state, which we just set)

    // Track progress
    manifest!.completed_slugs.push(page.slug);
    saveManifest(manifest!);
    migrated++;
    progress.tick(1, page.slug);
  }
  progress.finish();

  // Copy links (after all pages exist in target) — include provenance metadata
  console.log('Copying links...');
  progress.start('migrate.copy_links', allPages.length);
  for (const page of allPages) {
    const links = await sourceEngine.getLinks(page.slug);
    for (const link of links) {
      await targetEngine.addLink(
        link.from_slug, link.to_slug, link.context, link.link_type,
        link.link_source, link.origin_slug, link.origin_field,
      );
    }
    progress.tick(1);
  }
  progress.finish();

  // Copy code edges (v0.20.0 Cathedral II) with chunk ID remapping
  console.log('Copying code edges...');
  const allSlugs = allPages.map(p => p.slug);
  const chunkIdMap = await buildChunkIdMap(sourceEngine, targetEngine, allSlugs);
  const edgesCopied = await copyCodeEdges(sourceEngine, targetEngine, chunkIdMap);
  if (edgesCopied > 0) {
    console.log(`  ${edgesCopied} code edges transferred (${chunkIdMap.size} chunks mapped).`);
  } else {
    console.log('  No code edges to transfer.');
  }

  // Copy config (selective)
  const configKeys = ['embedding_model', 'embedding_dimensions', 'chunk_strategy'];
  for (const key of configKeys) {
    const val = await sourceEngine.getConfig(key);
    if (val) await targetEngine.setConfig(key, val);
  }

  // Update local config
  const newConfig: GBrainConfig = {
    engine: opts.targetEngine,
    ...(opts.targetEngine === 'postgres'
      ? { database_url: targetConfig.database_url }
      : { database_path: targetConfig.database_path }),
  };
  saveConfig(newConfig);

  // Clean up
  clearManifest();

  console.log(`\nMigration complete. ${migrated} pages transferred.`);
  console.log(`Config updated to engine: ${opts.targetEngine}`);
  if (config.engine === 'pglite' && config.database_path) {
    console.log(`Original PGLite brain preserved at ${config.database_path} (backup).`);
  }

  // Post-migrate verification: confirm the target is healthy before we
  // leave the user. Catches incomplete copies, schema drift, and missing
  // embeddings immediately instead of on next CLI use. Non-fatal — prints
  // warnings and keeps going so the user sees the full picture.
  console.log('\nVerifying target...');
  try {
    await verifyTarget(targetEngine, sourceStats.page_count);
  } catch (e) {
    console.warn(`  Verification could not complete: ${e instanceof Error ? e.message : String(e)}`);
  }

  await targetEngine.disconnect();
}

/**
 * Lightweight doctor-style verify run against the migrated target.
 * Prints a small table of signals; does not exit. Callers own engine
 * lifecycle.
 */
async function verifyTarget(engine: BrainEngine, expectedPages: number): Promise<void> {
  const stats = await engine.getStats();
  if (stats.page_count === expectedPages) {
    console.log(`  ok  pages: ${stats.page_count} (matches source)`);
  } else {
    console.warn(`  WARN pages: ${stats.page_count} (source had ${expectedPages})`);
  }

  try {
    const health = await engine.getHealth();
    const pct = (health.embed_coverage * 100).toFixed(0);
    if (health.embed_coverage >= 0.9) {
      console.log(`  ok  embeddings: ${pct}% coverage, ${health.missing_embeddings} missing`);
    } else {
      console.warn(`  WARN embeddings: ${pct}% coverage, ${health.missing_embeddings} missing. Run: gbrain embed --stale`);
    }
  } catch (e) {
    console.warn(`  WARN embeddings: could not measure (${e instanceof Error ? e.message : String(e)})`);
  }

  // Schema version check — SQLite-Lance does not use the PGLite migration system;
  // its schema.sql creates everything at the latest equivalent. Skip the version
  // comparison for sqlite-lance targets.
  if (engine.kind !== 'sqlite-lance') {
    try {
      const version = await engine.getConfig('version');
      const { LATEST_VERSION } = await import('../core/migrate.ts');
      const schemaVersion = parseInt(version || '0', 10);
      if (schemaVersion >= LATEST_VERSION) {
        console.log(`  ok  schema: version ${schemaVersion}`);
      } else {
        console.warn(`  WARN schema: version ${schemaVersion} (latest: ${LATEST_VERSION}). Run: gbrain apply-migrations --yes`);
      }
    } catch {
      console.warn('  WARN schema: version could not be read');
    }
  } else {
    console.log('  ok  schema: sqlite-lance (standalone DDL, no migration version)');
  }

  console.log('  Full health check: gbrain doctor');
}
