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

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
  _dbPath = null;
}

export default getDb;
