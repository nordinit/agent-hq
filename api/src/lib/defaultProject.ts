import { type Db } from "../db/adapter/types";

export const DEFAULT_PROJECT_SETTING_KEY = 'default_project_id';

async function readProjectId(db: Db, id: number): Promise<number | null> {
  const row = await db.get(`SELECT id FROM projects WHERE id = ? LIMIT 1`, id) as { id: number } | undefined;
  return row?.id ?? null;
}

export async function getDefaultProjectId(db: Db): Promise<number | null> {
  const row = await db.get(`SELECT value FROM app_settings WHERE key = ?`, DEFAULT_PROJECT_SETTING_KEY) as { value: string } | undefined;
  const parsed = Number(row?.value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return await readProjectId(db, parsed);
}

export async function setDefaultProjectId(db: Db, projectId: number): Promise<number> {
  const resolved = await readProjectId(db, projectId);
  if (!resolved) throw new Error('Project not found');

  await db.run(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
  `, DEFAULT_PROJECT_SETTING_KEY, String(resolved));

  return resolved;
}

export async function ensureDefaultProjectId(db: Db): Promise<number | null> {
  // Kept as a compatibility alias for callers that previously expected this function to
  // reconcile a missing setting. Reads must not choose or persist configuration implicitly.
  return await getDefaultProjectId(db);
}
