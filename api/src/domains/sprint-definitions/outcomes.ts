import { type Db } from "../../db/adapter/types";
import { tableExists as sharedTableExists, columnExists as sharedColumnExists, tableColumns as sharedTableColumns, indexExists as sharedIndexExists } from "../../db/introspection";

export type SprintOutcomeBehavior = 'base' | 'extend' | 'override' | 'disable';

export interface SprintOutcomeDefinition {
  id?: number;
  sprint_type_key: string;
  task_type: string | null;
  outcome_key: string;
  label: string;
  description: string;
  enabled: number;
  behavior: SprintOutcomeBehavior;
  badge_variant: string | null;
  stage_order: number;
  is_system: number;
  metadata: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

function normalizeSprintType(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized.length > 0 ? normalized : null;
}

function parseMetadata(value: string | null | undefined): Record<string, unknown> {
  if (typeof value !== 'string' || value.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function tableHasColumn(db: Db, table: string, column: string): Promise<boolean> {
    return await sharedColumnExists(db, table, column);
}

async function tenantPredicate(db: Db, table: string, tenantId?: number | null): Promise<{ sql: string; params: unknown[] }> {
  if (tenantId == null || !await tableHasColumn(db, table, 'tenant_id')) return { sql: '', params: [] };
  return {
    sql: ` AND (tenant_id = ? OR (tenant_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM ${table} owned
      WHERE owned.sprint_type_key = sprint_type_outcomes.sprint_type_key
        AND owned.tenant_id = ?
      LIMIT 1
    )))`,
    params: [tenantId, tenantId],
  };
}

export function getLegacyOutcomeMeta(outcomeKey: string) {
  return {
    label: outcomeKey,
    description: '',
    badge_variant: null,
  };
}

async function getSprintTypeForSprintId(db: Db, sprintId?: number | null): Promise<string | null> {
  if (typeof sprintId !== 'number' || !Number.isFinite(sprintId)) return null;
  try {
    const row = await db.get(`SELECT sprint_type FROM sprints WHERE id = ? LIMIT 1`, sprintId) as { sprint_type: string | null } | undefined;
    return normalizeSprintType(row?.sprint_type);
  } catch {
    return null;
  }
}

export async function listConfiguredSprintOutcomes(
  db: Db,
  sprintTypeOrSprintId?: string | number | null,
  options?: { tenantId?: number | null },
): Promise<SprintOutcomeDefinition[]> {
  const sprintType = typeof sprintTypeOrSprintId === 'number'
    ? await getSprintTypeForSprintId(db, sprintTypeOrSprintId)
    : normalizeSprintType(sprintTypeOrSprintId);
  if (!sprintType) return [];

  try {
    const tenant = await tenantPredicate(db, 'sprint_type_outcomes', options?.tenantId);
    const rows = await db.all(`
      SELECT id, sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, badge_variant, stage_order, is_system, metadata_json, created_at, updated_at
      FROM sprint_type_outcomes
      WHERE sprint_type_key = ?
        ${tenant.sql}
      ORDER BY CASE WHEN task_type IS NULL THEN 0 ELSE 1 END, task_type ASC, stage_order ASC, id ASC
    `, sprintType, ...tenant.params) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: Number(row.id),
      sprint_type_key: String(row.sprint_type_key),
      task_type: typeof row.task_type === 'string' && row.task_type.trim().length > 0 ? row.task_type.trim() : null,
      outcome_key: String(row.outcome_key),
      label: String(row.label ?? row.outcome_key),
      description: String(row.description ?? ''),
      enabled: Number(row.enabled ?? 1),
      behavior: (row.behavior ?? 'base') as SprintOutcomeBehavior,
      badge_variant: typeof row.badge_variant === 'string' && row.badge_variant.trim().length > 0 ? row.badge_variant.trim() : null,
      stage_order: Number(row.stage_order ?? 0),
      is_system: Number(row.is_system ?? 0),
      metadata: parseMetadata(typeof row.metadata_json === 'string' ? row.metadata_json : null),
      created_at: typeof row.created_at === 'string' ? row.created_at : undefined,
      updated_at: typeof row.updated_at === 'string' ? row.updated_at : undefined,
    }));
  } catch {
    return [];
  }
}

export async function resolveSprintOutcomeVocabulary(
  db: Db,
  options: { sprintId?: number | null; sprintType?: string | null; taskType?: string | null; fallbackOutcomes?: string[]; tenantId?: number | null },
): Promise<SprintOutcomeDefinition[]> {
  const sprintType = normalizeSprintType(options.sprintType) ?? (await getSprintTypeForSprintId(db, options.sprintId ?? null)) ?? 'generic';
  const taskType = typeof options.taskType === 'string' && options.taskType.trim().length > 0 ? options.taskType.trim() : null;
  const configured = await listConfiguredSprintOutcomes(db, sprintType, { tenantId: options.tenantId });
  const fallback = (options.fallbackOutcomes ?? []).map((outcomeKey, index) => ({
    id: undefined,
    sprint_type_key: sprintType,
    task_type: null,
    outcome_key: outcomeKey,
    label: getLegacyOutcomeMeta(outcomeKey).label,
    description: getLegacyOutcomeMeta(outcomeKey).description,
    enabled: 1,
    behavior: 'base' as SprintOutcomeBehavior,
    badge_variant: getLegacyOutcomeMeta(outcomeKey).badge_variant ?? null,
    stage_order: index,
    is_system: 1,
    metadata: {},
  }));

  const baseRows = configured.filter((row) => row.task_type == null);
  const taskRows = configured.filter((row) => row.task_type === taskType);
  const baseMap = new Map<string, SprintOutcomeDefinition>();

  for (const row of baseRows.length > 0 ? baseRows : fallback) {
    if (row.enabled !== 1 || row.behavior === 'disable') continue;
    baseMap.set(row.outcome_key, row);
  }

  const hasOverride = taskRows.some((row) => row.behavior === 'override' && row.enabled === 1);
  const result = hasOverride ? new Map<string, SprintOutcomeDefinition>() : new Map(baseMap);

  for (const row of taskRows) {
    if (row.behavior === 'disable' || row.enabled !== 1) {
      result.delete(row.outcome_key);
      continue;
    }
    result.set(row.outcome_key, row);
  }

  if (result.size === 0) {
    for (const row of fallback) result.set(row.outcome_key, row);
  }

  return [...result.values()].sort((a, b) => a.stage_order - b.stage_order || a.outcome_key.localeCompare(b.outcome_key));
}

export async function resolveSprintOutcomeMap(
  db: Db,
  options: { sprintId?: number | null; sprintType?: string | null; taskType?: string | null; fallbackOutcomes?: string[] },
): Promise<Map<string, SprintOutcomeDefinition>> {
  return new Map((await resolveSprintOutcomeVocabulary(db, options)).map((entry) => [entry.outcome_key, entry]));
}
