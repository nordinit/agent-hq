import type Database from 'better-sqlite3';
import { getDb } from '../../db/client';

export type RelationshipDirectionSemantics = 'target_blocks_source' | 'source_blocks_target' | 'informational';

export interface TaskRelationshipTypeConfig {
  id: number;
  tenant_id?: number | null;
  sprint_type_key: string;
  key: string;
  label: string;
  inverse_label: string;
  category: string;
  affects_dispatch_eligibility: number;
  direction_semantics: RelationshipDirectionSemantics;
  active_statuses: string[];
  resolved_statuses: string[];
  allow_create_related_task: number;
  default_related_task_type: string | null;
  default_related_task_status: string | null;
  is_system: number;
  metadata: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface TaskRelationshipRecord {
  id: number;
  source_task_id: number;
  target_task_id: number;
  relationship_type_key: string;
  metadata: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
  type: TaskRelationshipTypeConfig | null;
  source_task?: Record<string, unknown> | null;
  target_task?: Record<string, unknown> | null;
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
  } catch {
    return [];
  }
}

function normalizeConfigKey(raw: unknown, fieldName: string): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) throw httpError(400, `${fieldName} is required`);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(value)) {
    throw httpError(400, `${fieldName} must use lowercase letters, numbers, underscores, or hyphens`);
  }
  return value;
}

function normalizeMetadata(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('metadata_json');
      return parsed as Record<string, unknown>;
    } catch {
      throw httpError(400, 'metadata_json must be a JSON object');
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  throw httpError(400, 'metadata_json must be an object');
}

function httpError(status: number, message: string): Error & { status?: number } {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  return err;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  try {
    return Boolean((db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`).get(tableName) as { name?: string } | undefined)?.name);
  } catch {
    return false;
  }
}

function tableHasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  try {
    return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).some((row) => row.name === columnName);
  } catch {
    return false;
  }
}

function sprintTypeForTask(db: Database.Database, taskId: number): string | null {
  const row = db.prepare(`
    SELECT COALESCE(s.sprint_type, 'generic') AS sprint_type
    FROM tasks t
    LEFT JOIN sprints s ON s.id = t.sprint_id
    WHERE t.id = ?
    LIMIT 1
  `).get(taskId) as { sprint_type: string | null } | undefined;
  return row ? (row.sprint_type || 'generic') : null;
}

function shapeType(row: Record<string, unknown> | undefined | null): TaskRelationshipTypeConfig | null {
  if (!row) return null;
  return {
    id: Number(row.id),
    ...(row.tenant_id == null ? {} : { tenant_id: Number(row.tenant_id) }),
    sprint_type_key: String(row.sprint_type_key),
    key: String(row.key),
    label: String(row.label ?? row.key),
    inverse_label: String(row.inverse_label ?? ''),
    category: String(row.category ?? 'informational'),
    affects_dispatch_eligibility: Number(row.affects_dispatch_eligibility ?? 0),
    direction_semantics: (row.direction_semantics ?? 'informational') as RelationshipDirectionSemantics,
    active_statuses: parseStringArray(row.active_statuses_json),
    resolved_statuses: parseStringArray(row.resolved_statuses_json),
    allow_create_related_task: Number(row.allow_create_related_task ?? 0),
    default_related_task_type: typeof row.default_related_task_type === 'string' ? row.default_related_task_type : null,
    default_related_task_status: typeof row.default_related_task_status === 'string' ? row.default_related_task_status : null,
    is_system: Number(row.is_system ?? 0),
    metadata: parseJsonObject(row.metadata_json),
    created_at: typeof row.created_at === 'string' ? row.created_at : undefined,
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : undefined,
  };
}

function getRelationshipTypeForTask(db: Database.Database, taskId: number, typeKey: string): TaskRelationshipTypeConfig | null {
  const sprintType = sprintTypeForTask(db, taskId);
  if (!sprintType) throw httpError(404, 'Source task not found');
  const hasRelationshipTenantId = tableHasColumn(db, 'sprint_type_relationship_types', 'tenant_id');
  const hasTaskTenantId = tableHasColumn(db, 'tasks', 'tenant_id');
  const taskTenant = hasRelationshipTenantId && hasTaskTenantId
    ? db.prepare(`SELECT tenant_id FROM tasks WHERE id = ?`).get(taskId) as { tenant_id: number | null } | undefined
    : undefined;
  const tenantSql = taskTenant?.tenant_id != null ? ' AND (tenant_id = ? OR tenant_id IS NULL)' : '';
  const tenantParams = taskTenant?.tenant_id != null ? [taskTenant.tenant_id] : [];
  let row = db.prepare(`
    SELECT *
    FROM sprint_type_relationship_types
    WHERE key = ? AND sprint_type_key IN (?, 'generic')
      ${tenantSql}
    ORDER BY
      ${taskTenant?.tenant_id != null ? 'CASE WHEN tenant_id = ? THEN 0 ELSE 1 END,' : ''}
      CASE WHEN sprint_type_key = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(
    typeKey,
    sprintType,
    ...tenantParams,
    ...(taskTenant?.tenant_id != null ? [taskTenant.tenant_id] : []),
    sprintType,
  ) as Record<string, unknown> | undefined;
  if (!row && typeKey === 'defect_of') {
    row = db.prepare(`
      SELECT *
      FROM sprint_type_relationship_types
      WHERE key = ?
        ${tenantSql}
      ORDER BY CASE WHEN sprint_type_key = 'dev' THEN 0 ELSE 1 END, sprint_type_key ASC
      LIMIT 1
    `).get(typeKey, ...tenantParams) as Record<string, unknown> | undefined;
  }
  return shapeType(row);
}

function taskSummary(row: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    sprint_id: row.sprint_id ?? null,
    task_type: row.task_type ?? null,
  };
}

function shapeRelationship(db: Database.Database, row: Record<string, unknown>): TaskRelationshipRecord {
  const type = getRelationshipTypeForTask(db, Number(row.source_task_id), String(row.relationship_type_key));
  return {
    id: Number(row.id),
    source_task_id: Number(row.source_task_id),
    target_task_id: Number(row.target_task_id),
    relationship_type_key: String(row.relationship_type_key),
    metadata: parseJsonObject(row.metadata_json),
    created_by: String(row.created_by ?? 'system'),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    type,
    source_task: taskSummary(row.source_title !== undefined ? {
      id: row.source_task_id,
      title: row.source_title,
      status: row.source_status,
      sprint_id: row.source_sprint_id,
      task_type: row.source_task_type,
    } : null),
    target_task: taskSummary(row.target_title !== undefined ? {
      id: row.target_task_id,
      title: row.target_title,
      status: row.target_status,
      sprint_id: row.target_sprint_id,
      task_type: row.target_task_type,
    } : null),
  };
}

export function listRelationshipTypesForSprintType(db: Database.Database, sprintTypeKey: string, tenantId?: number | null): TaskRelationshipTypeConfig[] {
  if (!tableExists(db, 'sprint_type_relationship_types')) return [];
  const hasTenantId = tableHasColumn(db, 'sprint_type_relationship_types', 'tenant_id');
  const tenantSql = tenantId != null && hasTenantId ? ' AND tenant_id = ?' : '';
  const params = tenantSql ? [sprintTypeKey, tenantId] : [sprintTypeKey];
  const rows = db.prepare(`
    SELECT *
    FROM sprint_type_relationship_types
    WHERE sprint_type_key = ?
      ${tenantSql}
    ORDER BY category ASC, key ASC
  `).all(...params) as Array<Record<string, unknown>>;
  return rows.map(shapeType).filter((row): row is TaskRelationshipTypeConfig => Boolean(row));
}

export function listRelationshipTypesForTask(db: Database.Database, taskId: number): TaskRelationshipTypeConfig[] {
  if (!tableExists(db, 'sprint_type_relationship_types')) return [];
  const sprintType = sprintTypeForTask(db, taskId);
  if (!sprintType) throw httpError(404, 'Task not found');
  const hasRelationshipTenantId = tableHasColumn(db, 'sprint_type_relationship_types', 'tenant_id');
  const hasTaskTenantId = tableHasColumn(db, 'tasks', 'tenant_id');
  const taskTenant = hasRelationshipTenantId && hasTaskTenantId
    ? db.prepare(`SELECT tenant_id FROM tasks WHERE id = ?`).get(taskId) as { tenant_id: number | null } | undefined
    : undefined;
  const tenantSql = taskTenant?.tenant_id != null ? ' AND tenant_id = ?' : '';
  const tenantParams = taskTenant?.tenant_id != null ? [taskTenant.tenant_id] : [];
  const rows = db.prepare(`
    SELECT *
    FROM sprint_type_relationship_types
    WHERE sprint_type_key IN (?, 'generic')
      ${tenantSql}
    ORDER BY CASE WHEN sprint_type_key = ? THEN 0 ELSE 1 END, category ASC, key ASC
  `).all(sprintType, ...tenantParams, sprintType) as Array<Record<string, unknown>>;

  const byKey = new Map<string, TaskRelationshipTypeConfig>();
  for (const row of rows) {
    const shaped = shapeType(row);
    if (shaped && !byKey.has(shaped.key)) byKey.set(shaped.key, shaped);
  }
  return [...byKey.values()].sort((a, b) => a.category.localeCompare(b.category) || a.key.localeCompare(b.key));
}

export function listTaskRelationships(db: Database.Database, taskId: number): TaskRelationshipRecord[] {
  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId);
  if (!task) throw httpError(404, 'Task not found');
  const rows = db.prepare(`
    SELECT tr.*,
           source.title AS source_title, source.status AS source_status, source.sprint_id AS source_sprint_id, source.task_type AS source_task_type,
           target.title AS target_title, target.status AS target_status, target.sprint_id AS target_sprint_id, target.task_type AS target_task_type
    FROM task_relationships tr
    JOIN tasks source ON source.id = tr.source_task_id
    JOIN tasks target ON target.id = tr.target_task_id
    WHERE tr.source_task_id = ? OR tr.target_task_id = ?
    ORDER BY tr.created_at ASC, tr.id ASC
  `).all(taskId, taskId) as Array<Record<string, unknown>>;
  return rows.map(row => shapeRelationship(db, row));
}

function mirrorDispatchDependency(db: Database.Database, sourceTaskId: number, targetTaskId: number, type: TaskRelationshipTypeConfig): void {
  if (type.affects_dispatch_eligibility !== 1) return;
  if (type.direction_semantics === 'target_blocks_source') {
    db.prepare(`INSERT OR IGNORE INTO task_dependencies (blocker_id, blocked_id) VALUES (?, ?)`).run(targetTaskId, sourceTaskId);
    return;
  }
  if (type.direction_semantics === 'source_blocks_target') {
    db.prepare(`INSERT OR IGNORE INTO task_dependencies (blocker_id, blocked_id) VALUES (?, ?)`).run(sourceTaskId, targetTaskId);
  }
}

function removeDispatchDependency(db: Database.Database, sourceTaskId: number, targetTaskId: number, type: TaskRelationshipTypeConfig | null): void {
  if (!type || type.affects_dispatch_eligibility !== 1) return;
  if (type.direction_semantics === 'target_blocks_source') {
    db.prepare(`DELETE FROM task_dependencies WHERE blocker_id = ? AND blocked_id = ?`).run(targetTaskId, sourceTaskId);
    return;
  }
  if (type.direction_semantics === 'source_blocks_target') {
    db.prepare(`DELETE FROM task_dependencies WHERE blocker_id = ? AND blocked_id = ?`).run(sourceTaskId, targetTaskId);
  }
}

export function createTaskRelationship(db: Database.Database, input: {
  source_task_id: unknown;
  target_task_id: unknown;
  relationship_type_key: unknown;
  metadata_json?: unknown;
  created_by?: unknown;
}): TaskRelationshipRecord {
  const sourceTaskId = Number(input.source_task_id);
  const targetTaskId = Number(input.target_task_id);
  if (!Number.isInteger(sourceTaskId) || sourceTaskId <= 0) throw httpError(400, 'source_task_id is required');
  if (!Number.isInteger(targetTaskId) || targetTaskId <= 0) throw httpError(400, 'target_task_id is required');
  if (sourceTaskId === targetTaskId) throw httpError(400, 'A task cannot relate to itself');
  const relationshipTypeKey = normalizeConfigKey(input.relationship_type_key, 'relationship_type_key');
  const metadata = normalizeMetadata(input.metadata_json);
  const createdBy = typeof input.created_by === 'string' && input.created_by.trim() ? input.created_by.trim() : 'system';

  const source = db.prepare('SELECT id, tenant_id FROM tasks WHERE id = ?').get(sourceTaskId) as { id: number; tenant_id?: number | null } | undefined;
  if (!source) throw httpError(404, 'Source task not found');
  const target = db.prepare('SELECT id, tenant_id FROM tasks WHERE id = ?').get(targetTaskId) as { id: number; tenant_id?: number | null } | undefined;
  if (!target) throw httpError(404, 'Target task not found');
  if (source.tenant_id != null && target.tenant_id != null && source.tenant_id !== target.tenant_id) {
    throw httpError(404, 'Target task not found');
  }

  const type = getRelationshipTypeForTask(db, sourceTaskId, relationshipTypeKey);
  if (!type) throw httpError(400, `Relationship type "${relationshipTypeKey}" is not defined for source task sprint type`);

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO task_relationships (source_task_id, target_task_id, relationship_type_key, metadata_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(source_task_id, target_task_id, relationship_type_key) DO UPDATE SET
        metadata_json = excluded.metadata_json,
        updated_at = datetime('now')
    `).run(sourceTaskId, targetTaskId, relationshipTypeKey, JSON.stringify(metadata), createdBy);
    mirrorDispatchDependency(db, sourceTaskId, targetTaskId, type);
  });
  tx();

  const row = db.prepare(`
    SELECT tr.*,
           source.title AS source_title, source.status AS source_status, source.sprint_id AS source_sprint_id, source.task_type AS source_task_type,
           target.title AS target_title, target.status AS target_status, target.sprint_id AS target_sprint_id, target.task_type AS target_task_type
    FROM task_relationships tr
    JOIN tasks source ON source.id = tr.source_task_id
    JOIN tasks target ON target.id = tr.target_task_id
    WHERE tr.source_task_id = ? AND tr.target_task_id = ? AND tr.relationship_type_key = ?
  `).get(sourceTaskId, targetTaskId, relationshipTypeKey) as Record<string, unknown>;
  return shapeRelationship(db, row);
}

export interface LegacyBlockerRelationshipResult {
  ok: boolean;
  relationship?: TaskRelationshipRecord;
  warning?: string;
}

export const LEGACY_BLOCKER_DEPRECATION_WARNING = 'Legacy blocker writes are compatibility-only and will be removed after one release. Use agent_hq_get_task_relationship_types and agent_hq_create_task_relationship with a workflow-configured dispatch-blocking relationship type.';

export function createRelationshipFromBlockedBy(db: Database.Database, taskId: number, blockerId: number, createdBy = 'legacy-blocker-api'): LegacyBlockerRelationshipResult {
  if (!tableExists(db, 'task_relationships') || !tableExists(db, 'sprint_type_relationship_types')) {
    return {
      ok: false,
      warning: `${LEGACY_BLOCKER_DEPRECATION_WARNING} This database does not expose the task relationship model, so no dispatch dependency was created.`,
    };
  }
  try {
    const relationship = createTaskRelationship(db, {
      source_task_id: taskId,
      target_task_id: blockerId,
      relationship_type_key: 'blocked_by',
      metadata_json: {},
      created_by: createdBy,
    });
    return {
      ok: true,
      relationship,
      warning: LEGACY_BLOCKER_DEPRECATION_WARNING,
    };
  } catch (err) {
    return {
      ok: false,
      warning: `${LEGACY_BLOCKER_DEPRECATION_WARNING} No dispatch dependency was created because blocked_by is not configured for this task workflow: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function deleteTaskRelationship(db: Database.Database, relationshipId: number): { ok: true; deleted_id: number } {
  const row = db.prepare(`SELECT * FROM task_relationships WHERE id = ?`).get(relationshipId) as Record<string, unknown> | undefined;
  if (!row) throw httpError(404, 'Relationship not found');
  const type = getRelationshipTypeForTask(db, Number(row.source_task_id), String(row.relationship_type_key));
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM task_relationships WHERE id = ?`).run(relationshipId);
    removeDispatchDependency(db, Number(row.source_task_id), Number(row.target_task_id), type);
  });
  tx();
  return { ok: true, deleted_id: relationshipId };
}

export function deleteTaskRelationshipByTuple(db: Database.Database, sourceTaskId: number, targetTaskId: number, relationshipTypeKey: string): void {
  if (!tableExists(db, 'task_relationships')) return;
  const row = db.prepare(`
    SELECT * FROM task_relationships
    WHERE source_task_id = ? AND target_task_id = ? AND relationship_type_key = ?
  `).get(sourceTaskId, targetTaskId, relationshipTypeKey) as Record<string, unknown> | undefined;
  if (!row) return;
  deleteTaskRelationship(db, Number(row.id));
}

export function getTaskRelationshipsForEnrichment(taskId: number): TaskRelationshipRecord[] {
  try {
    return listTaskRelationships(getDb(), taskId);
  } catch {
    return [];
  }
}
