import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { SqliteAdapter } from './adapter/SqliteAdapter';
import type { Db } from './adapter/types';

const REPO_ROOT = path.resolve(__dirname, '../../..');

function resolveDbPath(): string {
  const dbDir = process.env.AGENT_HQ_DATA_DIR ?? REPO_ROOT;
  // AGENT_HQ_DB_PATH is preferred. DATABASE_PATH remains supported as a generic fallback.
  return process.env.AGENT_HQ_DB_PATH ?? process.env.DATABASE_PATH ?? path.join(dbDir, 'agent-hq.db');
}

function ensureDbParentDir(dbPath: string): void {
  const dbParentDir = path.dirname(dbPath);
  if (!fs.existsSync(dbParentDir)) {
    fs.mkdirSync(dbParentDir, { recursive: true });
  }
}

let _db: Database.Database | null = null;
let _adapter: Db | null = null;
// The connection the cached adapter wraps, so a reopen can be detected.
let _adapterConnection: Database.Database | null = null;
let _pool: import('pg').Pool | null = null;
let _dbPath: string | null = null;

/**
 * The raw better-sqlite3 connection.
 *
 * Reserved for code that genuinely needs the concrete driver: PRAGMA statements, schema
 * introspection and the table-rebuild machinery in db/schema.ts. The Db interface
 * deliberately does not expose those — they have no PostgreSQL equivalent, so every
 * remaining caller of this function is a site the migration still has to answer for.
 */
export function getRawDb(): Database.Database {
  const resolvedPath = resolveDbPath();
  if (_db && _dbPath && _dbPath !== resolvedPath) {
    _db.close();
    _db = null;
    _adapter = null;
    _adapterConnection = null;
    _dbPath = null;
  }
  if (!_db) {
    ensureDbParentDir(resolvedPath);
    _db = new Database(resolvedPath);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _dbPath = resolvedPath;
  }
  return _db;
}

/**
 * Which engine this process talks to.
 *
 * PostgreSQL is selected by setting DATABASE_URL (or AGENT_HQ_DATABASE_URL). There is no
 * "auto-detect and fall back" behaviour on purpose: a fallback would let a misconfigured
 * process quietly open a local SQLite file and start serving from an empty database
 * instead of failing, which is indistinguishable from a fresh install and very hard to
 * notice until data is missing.
 */
export type Engine = 'sqlite' | 'postgres';

export function getEngine(): Engine {
  return postgresUrl() ? 'postgres' : 'sqlite';
}

function postgresUrl(): string | undefined {
  return process.env.AGENT_HQ_DATABASE_URL ?? process.env.DATABASE_URL ?? undefined;
}

/**
 * The database handle application code uses.
 *
 * Returns the async Db interface rather than a driver, so no call site names a concrete
 * engine. The adapter is cached and invalidated together with its connection, so a path
 * or URL change never leaves an adapter wrapping the previous one.
 */
export function getDb(): Db {
  const url = postgresUrl();

  // SQLite: resolve the raw connection FIRST, every time. getRawDb() is what notices that
  // AGENT_HQ_DB_PATH changed and reopens, and short-circuiting on a cached adapter before
  // calling it hands back an adapter still wrapping the OLD, now-closed connection —
  // "TypeError: The database connection is not open" on the next query. Test suites hit
  // this constantly because they point the path at a fresh temp file per test.
  if (!url) {
    const raw = getRawDb();
    if (!_adapter || _adapterConnection !== raw) {
      _adapter = new SqliteAdapter(raw);
      _adapterConnection = raw;
    }
    return _adapter;
  }

  if (_adapter) return _adapter;
  if (url) {
    // Required rather than imported at module scope: pulling in `pg` unconditionally would
    // make it a hard dependency of every SQLite-only entrypoint and every test process.
    const { Pool } = require('pg') as typeof import('pg');
    const { PostgresAdapter } = require('./adapter/PostgresAdapter') as typeof import('./adapter/PostgresAdapter');
    _pool = new Pool({
      connectionString: url,
      // Bounded so a burst of concurrent handlers cannot exhaust the server's connection
      // slots. SQLite serialised everything behind one writer; PostgreSQL will happily
      // accept far more concurrency than the database is configured for.
      max: Number(process.env.AGENT_HQ_PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
    });
    _adapter = new PostgresAdapter(_pool);
    return _adapter;
  }

  throw new Error('unreachable: the SQLite path returns above');
}

export function getDbPath(): string {
  return resolveDbPath();
}

/** Closes the PostgreSQL pool, if this process opened one. */
export async function closeDbAsync(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
  closeDb();
}

/**
 * NOTE: foreign-key enforcement helpers deliberately do NOT live here.
 *
 * The connection opened above is a process-wide singleton, so a leaked
 * `PRAGMA foreign_keys = OFF` disables ON DELETE CASCADE for every later query in
 * the process. Migrations must therefore toggle the pragma through
 * withForeignKeysDisabled(), which lives in src/lib/tenantContext.ts because many
 * test suites replace this module with a partial jest.mock({ getDb }) — importing a
 * helper from here would resolve to undefined in those suites.
 */

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
  // The PostgreSQL pool is intentionally NOT ended here: closeDb() is synchronous and
  // pool.end() is not. Use closeDbAsync() where the pool must actually be released.
  _adapter = null;
  _adapterConnection = null;
  _dbPath = null;
}

export default getDb;
