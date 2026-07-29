import { getDb } from '../../db/client';
import { evaluateTaskIntegrity } from '../../lib/taskRelease';
import { TERMINAL_TASK_STATUSES } from '../../lib/taskStatuses';
import { parseCustomFields, resolveTaskFieldSchema } from './fields';
import { getCanonicalTaskCustomFields, getCanonicalTaskRecord, stripTaskLifecycleEvidenceFields } from './evidence';
import { getTaskRelationshipsForEnrichment } from './relationships';

export type TaskRecord = Record<string, unknown>;

const LIVE_TASK_INSTANCE_STATUSES = ['queued', 'dispatched', 'running'] as const;

export function stripRetiredTaskColumns(row: TaskRecord): TaskRecord {
  const retiredFailureColumn = ['failure', 'class'].join('_');
  const { [retiredFailureColumn]: _retiredFailureColumn, ...rest } = row;
  return rest;
}

async function tableHasTaskColumn(db: ReturnType<typeof getDb>, column: string): Promise<boolean> {
  return (await db.all('PRAGMA table_info(tasks)') as Array<{ name: string }>).some((row) => row.name === column);
}

function stripPublicTaskResponseColumns(row: TaskRecord): TaskRecord {
  return stripTaskLifecycleEvidenceFields(stripRetiredTaskColumns(row));
}

export async function enrichTask(task: TaskRecord): Promise<TaskRecord> {
  const db = getDb();
  const canonicalTask = getCanonicalTaskRecord(task);
  const publicTask = stripPublicTaskResponseColumns(task);
  const id = task.id as number;
  const tenantId = typeof task.tenant_id === 'number' ? task.tenant_id : null;
  const tenantFilter = tenantId == null ? '' : ' AND t.tenant_id = ?';
  const changedFiles = (() => {
    try {
      const raw = task.changed_files_json;
      return typeof raw === 'string' ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  })();
  const customFields = (() => {
    try {
      return getCanonicalTaskCustomFields(task);
    } catch {
      return {};
    }
  })();
  const resolvedFieldSchema = await resolveTaskFieldSchema(task.sprint_id, task.task_type);
  const assignedAgentId = typeof task.assigned_agent_id === 'number' ? task.assigned_agent_id : null;
  const activeAgentId = typeof task.agent_id === 'number' ? task.agent_id : null;
  const agentNames = (async () => {
    const ids = [...new Set([assignedAgentId, activeAgentId].filter((value): value is number => value != null))];
    if (ids.length === 0) return new Map<number, string>();
    const rows = await db.all(`
      SELECT id, name
      FROM agents
      WHERE id IN (${ids.map(() => '?').join(',')})
    `, ...ids) as Array<{ id: number; name: string }>;
    return new Map(rows.map((row) => [row.id, row.name]));
  })();
  const unifiedCustomFields = { ...customFields };
  for (const field of resolvedFieldSchema.schema.fields ?? []) {
    if (unifiedCustomFields[field.key] !== undefined && unifiedCustomFields[field.key] !== null && unifiedCustomFields[field.key] !== '') continue;
    const legacyValue = canonicalTask[field.key];
    if (legacyValue !== undefined && legacyValue !== null && legacyValue !== '') {
      unifiedCustomFields[field.key] = legacyValue;
    }
  }

  const hasRelationshipTable = Boolean((await db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='task_relationships' LIMIT 1`) as { name?: string } | undefined)?.name);
  const blockers = hasRelationshipTable
    ? await db.all(`
      SELECT DISTINCT t.*, a.name as agent_name, s.name as sprint_name
      FROM tasks t
      LEFT JOIN agents a ON a.id = t.agent_id
      LEFT JOIN sprints s ON s.id = t.sprint_id
      WHERE (
        t.id IN (SELECT blocker_id FROM task_dependencies WHERE blocked_id = ?)
         OR t.id IN (
           SELECT target_task_id
           FROM task_relationships
           WHERE source_task_id = ? AND relationship_type_key = 'blocked_by'
         )
         OR t.id IN (
           SELECT source_task_id
           FROM task_relationships
           WHERE target_task_id = ? AND relationship_type_key = 'blocks'
         )
      )
      ${tenantFilter}
    `, ...(tenantId == null ? [id, id, id] : [id, id, id, tenantId])) as TaskRecord[]
    : await db.all(`
      SELECT t.*, a.name as agent_name, s.name as sprint_name
      FROM tasks t
      LEFT JOIN agents a ON a.id = t.agent_id
      LEFT JOIN sprints s ON s.id = t.sprint_id
      WHERE t.id IN (SELECT blocker_id FROM task_dependencies WHERE blocked_id = ?)
      ${tenantFilter}
    `, ...(tenantId == null ? [id] : [id, tenantId])) as TaskRecord[];

  const blocking = hasRelationshipTable
    ? await db.all(`
      SELECT DISTINCT t.*, a.name as agent_name, s.name as sprint_name
      FROM tasks t
      LEFT JOIN agents a ON a.id = t.agent_id
      LEFT JOIN sprints s ON s.id = t.sprint_id
      WHERE (
        t.id IN (SELECT blocked_id FROM task_dependencies WHERE blocker_id = ?)
         OR t.id IN (
           SELECT source_task_id
           FROM task_relationships
           WHERE target_task_id = ? AND relationship_type_key = 'blocked_by'
         )
         OR t.id IN (
           SELECT target_task_id
           FROM task_relationships
           WHERE source_task_id = ? AND relationship_type_key = 'blocks'
         )
      )
      ${tenantFilter}
    `, ...(tenantId == null ? [id, id, id] : [id, id, id, tenantId])) as TaskRecord[]
    : await db.all(`
      SELECT t.*, a.name as agent_name, s.name as sprint_name
      FROM tasks t
      LEFT JOIN agents a ON a.id = t.agent_id
      LEFT JOIN sprints s ON s.id = t.sprint_id
      WHERE t.id IN (SELECT blocked_id FROM task_dependencies WHERE blocker_id = ?)
      ${tenantFilter}
    `, ...(tenantId == null ? [id] : [id, tenantId])) as TaskRecord[];

  const latestTaskOutcome = typeof task.latest_task_outcome === 'string' && task.latest_task_outcome.trim()
    ? task.latest_task_outcome.trim()
    : (typeof task.active_instance_task_outcome === 'string' && task.active_instance_task_outcome.trim() ? task.active_instance_task_outcome.trim() : null);
  return {
    ...publicTask,
    ...await evaluateTaskIntegrity({ ...canonicalTask, ...unifiedCustomFields } as { status?: string | null; task_type?: string | null }, db),
    latest_task_outcome: latestTaskOutcome,
    changed_files: changedFiles,
    custom_fields: unifiedCustomFields,
    resolved_sprint_type: resolvedFieldSchema.sprint_type,
    resolved_custom_field_schema: resolvedFieldSchema.schema,
    relationships: await getTaskRelationshipsForEnrichment(id),
    assigned_agent_name: assignedAgentId == null ? null : agentNames.get(assignedAgentId) ?? null,
    active_agent_name: activeAgentId == null ? null : agentNames.get(activeAgentId) ?? null,
    blockers: blockers.map(stripPublicTaskResponseColumns),
    blocking: blocking.map(stripPublicTaskResponseColumns),
  };
}

export function enrichTasks(tasks: TaskRecord[]): TaskRecord[] {
  return tasks.map(enrichTask);
}

export const TASK_SELECT = `
  SELECT
    t.*,
    a.name as agent_name,
    s.name as sprint_name,
    ji.id as active_instance_id,
    ji.status as active_instance_status,
    ji.session_key as active_instance_session_key,
    ji.created_at as active_instance_created_at,
    ji.dispatched_at as active_instance_dispatched_at,
    ji.started_at as active_instance_started_at,
    ji.completed_at as active_instance_completed_at,
    ji.runtime_ended_at as active_instance_runtime_ended_at,
    ji.runtime_completed_at as active_instance_runtime_completed_at,
    ji.runtime_end_success as active_instance_runtime_end_success,
    ji.runtime_end_error as active_instance_runtime_end_error,
    ji.runtime_end_source as active_instance_runtime_end_source,
    ji.lifecycle_handoff_status as active_instance_lifecycle_handoff_status,
    ji.semantic_outcome_missing as active_instance_semantic_outcome_missing,
    ji.lifecycle_outcome_posted_at as active_instance_lifecycle_outcome_posted_at,
    ia.current_stage as latest_run_stage,
    ia.last_agent_heartbeat_at,
    ia.last_meaningful_output_at,
    ia.latest_commit_hash,
    ia.branch_name,
    ia.changed_files_json,
    ia.changed_files_count,
    ia.summary as latest_artifact_summary,
    ia.blocker_reason,
    ia.outcome as latest_run_outcome,
    ia.stale as run_is_stale,
    ia.stale_at as run_stale_at,
    ia.updated_at as artifact_updated_at,
    ji.task_outcome as active_instance_task_outcome,
    (
      SELECT ji2.task_outcome
      FROM job_instances ji2
      WHERE ji2.task_id = t.id
        AND ji2.task_outcome IS NOT NULL
        AND ji2.task_outcome != ''
      ORDER BY COALESCE(ji2.lifecycle_outcome_posted_at, ji2.completed_at, ji2.runtime_completed_at, ji2.runtime_ended_at, ji2.created_at) DESC,
               ji2.id DESC
      LIMIT 1
    ) AS latest_task_outcome,
    origin_t.title as origin_task_title,
    COALESCE(tom.spawned_defects, 0) as spawned_defects
  FROM tasks t
  LEFT JOIN agents a ON a.id = t.agent_id
  LEFT JOIN sprints s ON s.id = t.sprint_id
  LEFT JOIN job_instances ji ON ji.id = t.active_instance_id
  LEFT JOIN instance_artifacts ia ON ia.instance_id = ji.id
  LEFT JOIN tasks origin_t ON origin_t.id = t.origin_task_id
  LEFT JOIN task_outcome_metrics tom ON tom.task_id = t.id
`;

export async function searchTasks(
  db: ReturnType<typeof getDb>,
  query: { q?: unknown; exclude_id?: unknown; limit?: unknown; project_id?: unknown; sprint_id?: unknown; tenant_id?: unknown },
): Promise<Array<{ id: number; title: string; status: string }>> {
  const q = String(query.q ?? '').trim();
  const excludeId = query.exclude_id ? Number(query.exclude_id) : null;
  const projectId = query.project_id ? Number(query.project_id) : null;
  const sprintId = query.sprint_id ? Number(query.sprint_id) : null;
  const tenantId = query.tenant_id ? Number(query.tenant_id) : null;
  const limit = Math.min(Math.max(1, Number(query.limit) || 20), 50);

  if (!q) return [];

  const params: unknown[] = [];
  const idQuery = q.replace(/^#/, '');
  let condition = '';

  if (/^\d+$/.test(idQuery)) {
    condition = 'CAST(t.id AS TEXT) LIKE ?';
    params.push(`${idQuery}%`);
  } else {
    condition = 'LOWER(t.title) LIKE ?';
    params.push(`%${q.toLowerCase()}%`);
  }

  let excludeCondition = '';
  if (excludeId !== null) {
    excludeCondition = ' AND t.id != ?';
    params.push(excludeId);
  }

  let contextCondition = '';
  if (projectId !== null && Number.isInteger(projectId) && projectId > 0) {
    contextCondition += ' AND t.project_id = ?';
    params.push(projectId);
  }
  if (sprintId !== null && Number.isInteger(sprintId) && sprintId > 0) {
    contextCondition += ' AND t.sprint_id = ?';
    params.push(sprintId);
  }
  if (tenantId !== null && Number.isInteger(tenantId) && tenantId > 0) {
    contextCondition += ' AND t.tenant_id = ?';
    params.push(tenantId);
  }

  params.push(limit);

  return await db.all(`
    SELECT t.id, t.title, t.status
    FROM tasks t
    WHERE ${condition}${excludeCondition}${contextCondition}
    ORDER BY t.id DESC
    LIMIT ?
  `, ...params) as Array<{ id: number; title: string; status: string }>;
}

const PROJECT_TASK_SEARCH_MAX_LIMIT = 50;
const PROJECT_TASK_SEARCH_DEFAULT_LIMIT = 20;
const CUSTOM_FIELD_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export interface ProjectTaskSearchInput {
  tenant_id: number;
  project_id: number;
  sprint_id?: unknown;
  workflow_id?: unknown;
  statuses?: unknown;
  status?: unknown;
  active_only?: unknown;
  nonterminal_only?: unknown;
  task_type?: unknown;
  custom_fields?: unknown;
  limit?: unknown;
  offset?: unknown;
}

export interface ProjectTaskSearchResult {
  tasks: Array<{
    id: number;
    title: string;
    status: string | null;
    task_type: string | null;
    project_id: number;
    sprint_id: number | null;
    sprint_name: string | null;
    agent_id: number | null;
    agent_name: string | null;
    active_instance_id: number | null;
    updated_at: string | null;
    matched_custom_fields: Record<string, unknown>;
  }>;
  total: number;
  hasMore: boolean;
  limit: number;
  offset: number;
  project_id: number;
}

function parseBoundedPositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(1, Math.trunc(parsed)), max);
}

function parseBoundedOffset(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function parseBooleanFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function parseExactCustomFieldMatches(value: unknown): Record<string, unknown> {
  if (value == null || value === '') return {};
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('custom_fields must be an object of exact field matches');
  }
  const matches = parsed as Record<string, unknown>;
  for (const [key, matchValue] of Object.entries(matches)) {
    if (!CUSTOM_FIELD_KEY_PATTERN.test(key)) {
      throw new Error(`Invalid custom field key "${key}"`);
    }
    if (
      matchValue !== null
      && typeof matchValue !== 'string'
      && typeof matchValue !== 'number'
      && typeof matchValue !== 'boolean'
    ) {
      throw new Error(`custom_fields.${key} must be a string, number, boolean, or null exact match`);
    }
  }
  return matches;
}

function customFieldMatchesSqlPath(key: string): string {
  return `$."${key.replace(/"/g, '\\"')}"`;
}

function normalizeCustomFieldSqlValue(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

export async function searchProjectTasks(
  db: ReturnType<typeof getDb>,
  input: ProjectTaskSearchInput,
): Promise<ProjectTaskSearchResult> {
  const tenantId = Number(input.tenant_id);
  const projectId = Number(input.project_id);
  if (!Number.isInteger(tenantId) || tenantId <= 0) throw new Error('tenant_id is required');
  if (!Number.isInteger(projectId) || projectId <= 0) throw new Error('project_id is required');

  const limit = parseBoundedPositiveInt(input.limit, PROJECT_TASK_SEARCH_DEFAULT_LIMIT, PROJECT_TASK_SEARCH_MAX_LIMIT);
  const offset = parseBoundedOffset(input.offset);
  const parsedSprintId = Number(input.workflow_id ?? input.sprint_id);
  const sprintId = Number.isInteger(parsedSprintId) && parsedSprintId > 0 ? parsedSprintId : null;
  const statuses = parseStringList(input.statuses ?? input.status);
  const taskType = typeof input.task_type === 'string' && input.task_type.trim() ? input.task_type.trim() : null;
  const customFieldMatches = parseExactCustomFieldMatches(input.custom_fields);

  const conditions = ['t.tenant_id = ?', 't.project_id = ?'];
  const params: unknown[] = [tenantId, projectId];

  if (sprintId !== null) {
    conditions.push('t.sprint_id = ?');
    params.push(sprintId);
  }
  if (statuses.length === 1) {
    conditions.push('t.status = ?');
    params.push(statuses[0]);
  } else if (statuses.length > 1) {
    conditions.push(`t.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (parseBooleanFlag(input.active_only) || parseBooleanFlag(input.nonterminal_only)) {
    conditions.push(`(t.status IS NULL OR t.status NOT IN (${TERMINAL_TASK_STATUSES.map(() => '?').join(',')}))`);
    params.push(...TERMINAL_TASK_STATUSES);
  }
  if (taskType) {
    conditions.push('t.task_type = ?');
    params.push(taskType);
  }
  for (const [key, value] of Object.entries(customFieldMatches)) {
    // `IS ?` is SQLite-only NULL-safe equality; Postgres rejects a parameter after IS.
    // The SQL here is built per request, so branch on nullness instead.
    const sqlValue = normalizeCustomFieldSqlValue(value);
    if (sqlValue === null || sqlValue === undefined) {
      conditions.push('json_extract(t.custom_fields_json, ?) IS NULL');
      params.push(customFieldMatchesSqlPath(key));
    } else {
      conditions.push('json_extract(t.custom_fields_json, ?) = ?');
      params.push(customFieldMatchesSqlPath(key), sqlValue);
    }
  }

  const whereSql = conditions.join(' AND ');
  const total = (await db.get(`SELECT COUNT(*) AS total FROM tasks t WHERE ${whereSql}`, ...params) as { total: number }).total;
  const rows = await db.all(`
    SELECT
      t.id,
      t.title,
      t.status,
      t.task_type,
      t.project_id,
      t.sprint_id,
      s.name AS sprint_name,
      t.agent_id,
      a.name AS agent_name,
      t.active_instance_id,
      t.updated_at,
      t.custom_fields_json
    FROM tasks t
    LEFT JOIN sprints s ON s.id = t.sprint_id AND s.tenant_id = t.tenant_id
    LEFT JOIN agents a ON a.id = t.agent_id AND a.tenant_id = t.tenant_id
    WHERE ${whereSql}
    ORDER BY t.updated_at DESC, t.id DESC
    LIMIT ? OFFSET ?
  `, ...params, limit, offset) as Array<Record<string, unknown>>;

  const customFieldKeys = Object.keys(customFieldMatches);
  return {
    tasks: rows.map((row) => {
      const customFields = parseCustomFields(row.custom_fields_json);
      const matchedCustomFields: Record<string, unknown> = {};
      for (const key of customFieldKeys) {
        matchedCustomFields[key] = customFields[key] ?? null;
      }
      return {
        id: Number(row.id),
        title: String(row.title ?? ''),
        status: typeof row.status === 'string' ? row.status : null,
        task_type: typeof row.task_type === 'string' ? row.task_type : null,
        project_id: Number(row.project_id),
        sprint_id: typeof row.sprint_id === 'number' ? row.sprint_id : null,
        sprint_name: typeof row.sprint_name === 'string' ? row.sprint_name : null,
        agent_id: typeof row.agent_id === 'number' ? row.agent_id : null,
        agent_name: typeof row.agent_name === 'string' ? row.agent_name : null,
        active_instance_id: typeof row.active_instance_id === 'number' ? row.active_instance_id : null,
        updated_at: typeof row.updated_at === 'string' ? row.updated_at : null,
        matched_custom_fields: matchedCustomFields,
      };
    }),
    total,
    hasMore: offset + limit < total,
    limit,
    offset,
    project_id: projectId,
  };
}

export async function listRecentlyCompletedTasks(
  db: ReturnType<typeof getDb>,
  hoursRaw: unknown,
  projectIdRaw?: unknown,
  tenantIdRaw?: unknown,
): Promise<{ hours: number; count: number; tasks: Record<string, unknown>[] }> {
  const hours = Math.max(1, Math.min(168, Number(hoursRaw) || 24));
  const projectId = Number(projectIdRaw) || null;
  const tenantId = Number(tenantIdRaw) || null;
  const projectFilter = projectId ? 'AND t.project_id = ?' : '';
  const tenantFilter = tenantId ? 'AND t.tenant_id = ?' : '';
  const params: unknown[] = [hours];
  if (projectId) params.push(projectId);
  if (tenantId) params.push(tenantId);
  const customFieldsSelect = await tableHasTaskColumn(db, 'custom_fields_json')
    ? 't.custom_fields_json'
    : 'NULL AS custom_fields_json';

  const rows = await db.all(`
    SELECT
      t.id,
      t.title,
      t.status,
      t.priority,
      t.project_id,
      ${customFieldsSelect},
      t.updated_at,
      t.agent_id,
      a.name  AS agent_name,
      a.job_title AS job_title,
      p.name  AS project_name,
      s.name  AS sprint_name,
      (
        SELECT th.new_value
        FROM task_history th
        WHERE th.task_id = t.id
          AND th.field = 'status'
          AND th.new_value = 'done'
        ORDER BY th.created_at DESC
        LIMIT 1
      ) AS completion_status,
      (
        SELECT th.created_at
        FROM task_history th
        WHERE th.task_id = t.id
          AND th.field = 'status'
          AND th.new_value = 'done'
        ORDER BY th.created_at DESC
        LIMIT 1
      ) AS completed_at,
      (
        SELECT ji2.task_outcome
        FROM job_instances ji2
        WHERE ji2.task_id = t.id
          AND ji2.task_outcome IS NOT NULL
          AND ji2.task_outcome != ''
        ORDER BY ji2.completed_at DESC
        LIMIT 1
      ) AS outcome
    FROM tasks t
    LEFT JOIN agents a ON a.id = t.agent_id
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN sprints s ON s.id = t.sprint_id
    WHERE t.status = 'done'
      AND t.updated_at >= datetime('now', '-' || ? || ' hours')
      ${projectFilter}
      ${tenantFilter}
    ORDER BY t.updated_at DESC
  `, ...params) as Record<string, unknown>[];

  return {
    hours,
    count: rows.length,
    tasks: rows.map((row) => ({
      ...stripPublicTaskResponseColumns(row),
      custom_fields: parseCustomFields(row.custom_fields_json),
    })),
  };
}

export async function listTasks(
  db: ReturnType<typeof getDb>,
  query: {
    project_id?: unknown;
    sprint_id?: unknown;
    job_id?: unknown;
    limit?: unknown;
    offset?: unknown;
    exclude_done?: unknown;
    include_closed?: unknown;
    origin_task_id?: unknown;
    defect_type?: unknown;
    status?: unknown;
    activeInstancesOnly?: unknown;
    active_instances_only?: unknown;
    live_instances_only?: unknown;
    tenant_id?: unknown;
  },
): Promise<Record<string, unknown>[] | Record<string, unknown>> {
  const {
    project_id,
    sprint_id,
    job_id,
    limit,
    offset,
    exclude_done,
    include_closed,
    origin_task_id,
    defect_type,
    status,
    activeInstancesOnly,
    active_instances_only,
    live_instances_only,
    tenant_id,
  } = query;

  let sql = TASK_SELECT;
  const params: unknown[] = [];
  const conditions: string[] = [];
  const hasAssignedAgentColumn = (await db.all('PRAGMA table_info(tasks)') as Array<{ name: string }>).some((col) => col.name === 'assigned_agent_id');

  if (project_id) {
    conditions.push('t.project_id = ?');
    params.push(Number(project_id));
  }
  if (tenant_id) {
    conditions.push('t.tenant_id = ?');
    params.push(Number(tenant_id));
  }
  if (sprint_id) {
    conditions.push('t.sprint_id = ?');
    params.push(Number(sprint_id));
  }
  if (job_id) {
    conditions.push(hasAssignedAgentColumn
      ? '(COALESCE(t.assigned_agent_id, t.agent_id) = ? OR (t.assigned_agent_id IS NULL AND t.agent_id IS NULL))'
      : '(t.agent_id = ? OR t.agent_id IS NULL)');
    params.push(Number(job_id));
  }
  if (origin_task_id) {
    conditions.push('t.origin_task_id = ?');
    params.push(Number(origin_task_id));
  }
  if (defect_type) {
    conditions.push('t.defect_type = ?');
    params.push(String(defect_type));
  }
  if (status) {
    const statuses = String(status).split(',').map((entry) => entry.trim()).filter(Boolean);
    if (statuses.length === 1) {
      conditions.push('t.status = ?');
      params.push(statuses[0]);
    } else if (statuses.length > 1) {
      conditions.push(`t.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
  }
  if (
    activeInstancesOnly === 'true' ||
    activeInstancesOnly === '1' ||
    active_instances_only === 'true' ||
    active_instances_only === '1'
  ) {
    conditions.push('t.active_instance_id IS NOT NULL');
  }
  if (live_instances_only === 'true' || live_instances_only === '1') {
    conditions.push(`t.active_instance_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM job_instances live_ji
      WHERE live_ji.id = t.active_instance_id
        AND live_ji.status IN (${LIVE_TASK_INSTANCE_STATUSES.map(() => '?').join(',')})
    )`);
    params.push(...LIVE_TASK_INSTANCE_STATUSES);
  }
  if (exclude_done === 'true' || exclude_done === '1') {
    conditions.push("t.status != 'done'");
  }
  if (!include_closed || include_closed === 'false') {
    conditions.push(`(t.sprint_id IS NULL OR EXISTS (
      SELECT 1 FROM sprints sp WHERE sp.id = t.sprint_id AND sp.status != 'closed'
    ))`);
  }
  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(' AND ')}`;
  }

  sql += ' ORDER BY t.created_at DESC';

  if (limit !== undefined) {
    const lim = Math.min(Math.max(1, Number(limit) || 50), 500);
    const off = Math.max(0, Number(offset) || 0);

    let countQuery = 'SELECT COUNT(*) as total FROM tasks t';
    if (conditions.length > 0) {
      countQuery += ` WHERE ${conditions.join(' AND ')}`;
    }
    const countResult = await db.get(countQuery, ...params) as { total: number };
    const total = countResult.total;

    sql += ' LIMIT ? OFFSET ?';
    const tasks = await db.all(sql, ...params, lim, off) as Record<string, unknown>[];

    return {
      tasks: enrichTasks(tasks),
      total,
      hasMore: off + lim < total,
      limit: lim,
      offset: off,
    };
  }

  const tasks = await db.all(sql, ...params) as Record<string, unknown>[];
  return enrichTasks(tasks);
}

export async function getTaskById(db: ReturnType<typeof getDb>, taskId: number): Promise<TaskRecord | null> {
  const task = await db.get(`${TASK_SELECT} WHERE t.id = ?`, taskId) as TaskRecord | undefined;
  return task ? await enrichTask(task) : null;
}

export async function listTaskHistory(db: ReturnType<typeof getDb>, taskId: number) {
  const task = await db.get('SELECT id FROM tasks WHERE id = ?', taskId);
  if (!task) {
    const error = new Error('Task not found') as Error & { status?: number };
    error.status = 404;
    throw error;
  }
  return await db.all(`
    SELECT * FROM task_history WHERE task_id = ? ORDER BY created_at DESC
  `, taskId);
}

export async function listTaskNotes(db: ReturnType<typeof getDb>, taskId: number) {
  const task = await db.get('SELECT id FROM tasks WHERE id = ?', taskId);
  if (!task) {
    const error = new Error('Task not found') as Error & { status?: number };
    error.status = 404;
    throw error;
  }
  return await db.all(`
    SELECT * FROM task_notes WHERE task_id = ? ORDER BY created_at ASC
  `, taskId);
}

export async function listTaskAttachments(db: ReturnType<typeof getDb>, taskId: number) {
  return await db.all('SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created_at ASC', taskId);
}

export async function listTaskInstances(db: ReturnType<typeof getDb>, taskId: number) {
  if (!Number.isFinite(taskId)) {
    const error = new Error('Invalid task id') as Error & { status?: number };
    error.status = 400;
    throw error;
  }

  return await db.all(`
    SELECT ji.*, a.job_title as job_title, a.name as agent_name,
           ia.current_stage, ia.last_agent_heartbeat_at, ia.last_meaningful_output_at,
           ia.latest_commit_hash, ia.branch_name, ia.changed_files_json, ia.changed_files_count,
           ia.summary as artifact_summary, ia.blocker_reason, ia.outcome as artifact_outcome,
           ia.stale as run_is_stale, ia.stale_at,
           ji.task_outcome,
           ji.runtime_ended_at,
           ji.runtime_completed_at,
           ji.runtime_end_success,
           ji.runtime_end_error,
           ji.runtime_end_source,
           ji.lifecycle_handoff_status,
           ji.semantic_outcome_missing,
           ji.lifecycle_outcome_posted_at
    FROM job_instances ji
    LEFT JOIN agents a ON a.id = ji.agent_id
    LEFT JOIN instance_artifacts ia ON ia.instance_id = ji.id
    WHERE ji.task_id = ?
    ORDER BY ji.created_at DESC
    LIMIT 50
  `, taskId);
}
