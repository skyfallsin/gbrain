import type { BrainEngine } from './engine.ts';
import type { EngineConfig } from './types.ts';

/**
 * Create an engine instance based on config.
 * Uses dynamic imports so PGLite WASM is never loaded for Postgres users.
 */
export async function createEngine(config: EngineConfig): Promise<BrainEngine> {
  const engineType = config.engine || 'postgres';

  switch (engineType) {
    case 'pglite': {
      const { PGLiteEngine } = await import('./pglite-engine.ts');
      return new PGLiteEngine();
    }
    case 'postgres': {
      const { PostgresEngine } = await import('./postgres-engine.ts');
      return new PostgresEngine();
    }
    case 'sqlite-lance': {
      const { SQLiteLanceEngine } = await import('./sqlite-lance-engine.ts');
      return new SQLiteLanceEngine();
    }
    default:
      throw new Error(
        `Unknown engine type: "${engineType}". Supported engines: postgres, pglite, sqlite-lance.`
      );
  }
}
