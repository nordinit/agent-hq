import { DEFAULT_PROJECT_NAME, LEGACY_STARTER_PROJECT_NAME } from './starterCatalog';
import { type Db } from "../db/adapter/types";

export const DEFAULT_PROJECT_SETTING_KEY = 'default_project_id';

async function ensureAppSettingsTable(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

async function readProjectId(db: Db, id: number): Promise<number | null> {
  const row = await db.get(`SELECT id FROM projects WHERE id = ? LIMIT 1`, id) as { id: number } | undefined;
  return row?.id ?? null;
}

async function resolveFallbackDefaultProjectId(db: Db): Promise<number | null> {
  const starterProject = await db.get(`
    SELECT id FROM projects
    WHERE lower(name) IN (lower(?), lower(?))
    ORDER BY CASE WHEN lower(name) = lower(?) THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `, DEFAULT_PROJECT_NAME, LEGACY_STARTER_PROJECT_NAME, DEFAULT_PROJECT_NAME) as { id: number } | undefined;
  if (starterProject?.id) return starterProject.id;

  const first = await db.get(`
    SELECT id FROM projects
    ORDER BY datetime(created_at) ASC, id ASC
    LIMIT 1
  `) as { id: number } | undefined;
  return first?.id ?? null;
}

export async function getDefaultProjectId(db: Db): Promise<number | null> {
  await ensureAppSettingsTable(db);
  const row = await db.get(`SELECT value FROM app_settings WHERE key = ?`, DEFAULT_PROJECT_SETTING_KEY) as { value: string } | undefined;
  const parsed = Number(row?.value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return await readProjectId(db, parsed);
}

export async function setDefaultProjectId(db: Db, projectId: number): Promise<number> {
  await ensureAppSettingsTable(db);
  const resolved = await readProjectId(db, projectId);
  if (!resolved) throw new Error('Project not found');

  await db.run(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `, DEFAULT_PROJECT_SETTING_KEY, String(resolved));

  return resolved;
}

export async function ensureDefaultProjectId(db: Db): Promise<number | null> {
  const existing = await getDefaultProjectId(db);
  if (existing) return existing;

  const fallback = await resolveFallbackDefaultProjectId(db);
  if (!fallback) return null;
  return await setDefaultProjectId(db, fallback);
}
