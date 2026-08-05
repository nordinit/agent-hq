import { Pool } from 'pg';
import { PostgresAdapter } from './adapter/PostgresAdapter';
import type { Db } from './adapter/types';

let pool: Pool | null = null;
let adapter: Db | null = null;
let activeUrl: string | null = null;

function databaseUrl(): string {
  const value = process.env.AGENT_HQ_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!value || !value.trim()) {
    throw new Error(
      'PostgreSQL is required. Set DATABASE_URL or AGENT_HQ_DATABASE_URL before starting Agent HQ. '
      + 'There is no SQLite or local-file fallback.',
    );
  }
  return value.trim();
}

/** Process-wide PostgreSQL adapter. The connection URL is immutable until closeDb(). */
export function getDb(): Db {
  const url = databaseUrl();
  if (adapter) {
    if (activeUrl !== url) {
      throw new Error('DATABASE_URL changed while the database pool was open; await closeDb() before switching databases.');
    }
    return adapter;
  }

  pool = new Pool({
    connectionString: url,
    max: Number(process.env.AGENT_HQ_PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
  });
  adapter = new PostgresAdapter(pool);
  activeUrl = url;
  return adapter;
}

/** Close the process-wide PostgreSQL pool and clear its cached adapter. */
export async function closeDb(): Promise<void> {
  const current = pool;
  pool = null;
  adapter = null;
  activeUrl = null;
  if (current) await current.end();
}

export default getDb;
