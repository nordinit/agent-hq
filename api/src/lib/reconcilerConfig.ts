import { type Db } from "../db/adapter/types";

export const NEEDS_ATTENTION_ELIGIBLE_STATUSES_SETTING_KEY = 'reconciler.needs_attention_eligible_statuses';
export const DEFAULT_NEEDS_ATTENTION_ELIGIBLE_STATUSES = [] as const;

function normalizeStatuses(statuses: unknown): string[] {
  if (!Array.isArray(statuses)) return [...DEFAULT_NEEDS_ATTENTION_ELIGIBLE_STATUSES];
  const normalized = Array.from(new Set(
    statuses
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.trim())
      .filter(Boolean)
      .filter(value => value !== 'needs_attention')
  ));
  return normalized.length > 0 ? normalized : [...DEFAULT_NEEDS_ATTENTION_ELIGIBLE_STATUSES];
}

export async function getNeedsAttentionEligibleStatuses(db: Db): Promise<string[]> {
  const row = await db.get('SELECT value FROM app_settings WHERE key = ?', NEEDS_ATTENTION_ELIGIBLE_STATUSES_SETTING_KEY) as { value: string } | undefined;
  if (!row?.value) return [...DEFAULT_NEEDS_ATTENTION_ELIGIBLE_STATUSES];

  try {
    return normalizeStatuses(JSON.parse(row.value));
  } catch {
    return [...DEFAULT_NEEDS_ATTENTION_ELIGIBLE_STATUSES];
  }
}

export async function setNeedsAttentionEligibleStatuses(db: Db, statuses: unknown): Promise<string[]> {
  const normalized = normalizeStatuses(statuses);
  await db.run(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `, NEEDS_ATTENTION_ELIGIBLE_STATUSES_SETTING_KEY, JSON.stringify(normalized));
  return normalized;
}

export async function isNeedsAttentionEligibleStatus(db: Db, status: string | null | undefined): Promise<boolean> {
  if (!status) return false;
  return (await getNeedsAttentionEligibleStatuses(db)).includes(status);
}
