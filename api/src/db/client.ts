import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

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
let _dbPath: string | null = null;

export function getDb(): Database.Database {
  const resolvedPath = resolveDbPath();
  if (_db && _dbPath && _dbPath !== resolvedPath) {
    _db.close();
    _db = null;
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

export function getDbPath(): string {
  return resolveDbPath();
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
  _dbPath = null;
}

export default getDb;
