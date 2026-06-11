import type Database from 'better-sqlite3';
import { DEFAULT_PROJECT_NAME, LEGACY_STARTER_PROJECT_NAME } from './starterCatalog';

export const DEFAULT_PROJECT_SETTING_KEY = 'default_project_id';

function ensureAppSettingsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function readProjectId(db: Database.Database, id: number): number | null {
  const row = db.prepare(`SELECT id FROM projects WHERE id = ? LIMIT 1`).get(id) as { id: number } | undefined;
  return row?.id ?? null;
}

function resolveFallbackDefaultProjectId(db: Database.Database): number | null {
  const starterProject = db.prepare(`
    SELECT id FROM projects
    WHERE lower(name) IN (lower(?), lower(?))
    ORDER BY CASE WHEN lower(name) = lower(?) THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `).get(DEFAULT_PROJECT_NAME, LEGACY_STARTER_PROJECT_NAME, DEFAULT_PROJECT_NAME) as { id: number } | undefined;
  if (starterProject?.id) return starterProject.id;

  const first = db.prepare(`
    SELECT id FROM projects
    ORDER BY datetime(created_at) ASC, id ASC
    LIMIT 1
  `).get() as { id: number } | undefined;
  return first?.id ?? null;
}

export function getDefaultProjectId(db: Database.Database): number | null {
  ensureAppSettingsTable(db);
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(DEFAULT_PROJECT_SETTING_KEY) as { value: string } | undefined;
  const parsed = Number(row?.value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return readProjectId(db, parsed);
}

export function setDefaultProjectId(db: Database.Database, projectId: number): number {
  ensureAppSettingsTable(db);
  const resolved = readProjectId(db, projectId);
  if (!resolved) throw new Error('Project not found');

  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(DEFAULT_PROJECT_SETTING_KEY, String(resolved));

  return resolved;
}

export function ensureDefaultProjectId(db: Database.Database): number | null {
  const existing = getDefaultProjectId(db);
  if (existing) return existing;

  const fallback = resolveFallbackDefaultProjectId(db);
  if (!fallback) return null;
  return setDefaultProjectId(db, fallback);
}
