import { type Db } from '../../db/adapter/types';
import { hideArchivedProjectsCondition } from '../../lib/projectArchive';
import { listConfiguredTerminalStatuses } from './terminality';
import { TASK_RECURRENCE_SELECT, taskRecurrenceMetadata } from './recurrence';

/**
 * The task board's read model.
 *
 * The board used to download every task in a project, fully enriched, every ten seconds: 3,100
 * tasks at about 30 KB each, and about a dozen queries per task. Its cost grew with every task
 * ever created, almost all of them closed.
 *
 * This model returns, for each (workflow, status) column, only the newest tasks (per_status_limit,
 * or a larger limit the board asked for with `expand`), with the total count of each column, so
 * a response is bounded by the number of columns, not the number of tasks. Rows carry only what a
 * card shows. Enrichment runs a fixed number of batched queries for the whole page instead of
 * per task. The full task, with description, custom fields and schema, comes from GET /tasks/:id.
 */

export const BOARD_DEFAULT_PER_STATUS_LIMIT = 30;
export const BOARD_MAX_PER_STATUS_LIMIT = 500;
const BOARD_MAX_EXPANDED_BUCKETS = 50;
/** The card shows a failure excerpt; the full text is on the task page. */
export const BOARD_FAILURE_DETAIL_CHARS = 600;

export interface BoardQuery {
  tenant_id: number;
  project_id?: unknown;
  workflow_id?: unknown;
  q?: unknown;
  task_type?: unknown;
  live_instances_only?: unknown;
  per_status_limit?: unknown;
  /** Larger limits for columns the board has expanded: "workflowId:status:limit,…", "none" for no workflow. */
  expand?: unknown;
  include_closed?: unknown;
  include_archived?: unknown;
}

export interface BoardBucket {
  workflow_id: number | null;
  status: string;
  total: number;
  loaded: number;
}

export interface BoardTaskLink {
  id: number;
  title: string;
  status: string;
  blocks_dispatch?: boolean;
}

export interface BoardResponse {
  tasks: Array<Record<string, unknown>>;
  buckets: BoardBucket[];
  total: number;
  per_status_limit: number;
}

function positiveInt(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function idList(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(raw.map(positiveInt).filter((id): id is number => id !== null))];
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 1;
}

interface ExpandedBucket { workflowId: number | null; status: string; limit: number }

export function parseExpandedBuckets(value: unknown): ExpandedBucket[] {
  const entries = Array.isArray(value) ? value.map(String) : String(value ?? '').split(',');
  const parsed: ExpandedBucket[] = [];
  for (const entry of entries) {
    const parts = entry.trim().split(':');
    if (parts.length < 3) continue;
    const workflowPart = parts[0];
    const limit = positiveInt(parts[parts.length - 1]);
    const status = parts.slice(1, -1).join(':').trim();
    const workflowId = workflowPart === 'none' ? null : positiveInt(workflowPart);
    if (!status || limit === null || (workflowPart !== 'none' && workflowId === null)) continue;
    parsed.push({ workflowId, status, limit: Math.min(limit, BOARD_MAX_PER_STATUS_LIMIT) });
    if (parsed.length >= BOARD_MAX_EXPANDED_BUCKETS) break;
  }
  return parsed;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, char => `\\${char}`);
}

function boardFilter(query: BoardQuery): { sql: string; params: unknown[] } {
  const conditions = ['t.tenant_id = ?'];
  const params: unknown[] = [query.tenant_id];

  const projectId = positiveInt(query.project_id);
  if (projectId !== null) {
    conditions.push('t.project_id = ?');
    params.push(projectId);
  }
  const workflowIds = idList(query.workflow_id);
  if (workflowIds.length > 0) {
    conditions.push('t.workflow_id = ANY(?::bigint[])');
    params.push(workflowIds);
  }
  const hideArchived = hideArchivedProjectsCondition(
    { project_id: projectId ?? undefined, include_archived: query.include_archived },
    't.project_id',
    [workflowIds.length > 0 ? workflowIds[0] : undefined],
  );
  if (hideArchived) conditions.push(hideArchived);
  if (!isTruthyFlag(query.include_closed)) {
    conditions.push(`(t.workflow_id IS NULL OR EXISTS (
      SELECT 1 FROM workflows sp WHERE sp.id = t.workflow_id AND sp.status != 'closed'
    ))`);
  }

  const search = typeof query.q === 'string' ? query.q.trim() : '';
  if (search) {
    const idQuery = search.replace(/^#/, '');
    const pattern = `%${escapeLike(search)}%`;
    if (/^\d+$/.test(idQuery) && Number.isSafeInteger(Number(idQuery))) {
      conditions.push('(t.id = ? OR t.title ILIKE ?)');
      params.push(Number(idQuery), pattern);
    } else {
      conditions.push('t.title ILIKE ?');
      params.push(pattern);
    }
  }
  const taskType = typeof query.task_type === 'string' ? query.task_type.trim() : '';
  if (taskType) {
    conditions.push('t.task_type = ?');
    params.push(taskType);
  }
  if (isTruthyFlag(query.live_instances_only)) {
    conditions.push(`EXISTS (
      SELECT 1 FROM job_instances live_ji
      WHERE live_ji.id = t.active_instance_id AND live_ji.status IN ('queued', 'dispatched', 'running')
    )`);
  }
  return { sql: conditions.join(' AND '), params };
}

/** The per-column row limit, with the board's expanded columns taking their own limit. */
function bucketLimitSql(defaultLimit: number, expanded: ExpandedBucket[]): { sql: string; params: unknown[] } {
  if (expanded.length === 0) return { sql: '?', params: [defaultLimit] };
  const params: unknown[] = [];
  const cases = expanded.map(bucket => {
    if (bucket.workflowId === null) {
      params.push(bucket.status, bucket.limit);
      return 'WHEN ranked.workflow_id IS NULL AND ranked.status = ?::text THEN ?::int';
    }
    params.push(bucket.workflowId, bucket.status, bucket.limit);
    return 'WHEN ranked.workflow_id = ?::bigint AND ranked.status = ?::text THEN ?::int';
  });
  params.push(defaultLimit);
  return { sql: `(CASE ${cases.join(' ')} ELSE ?::int END)`, params };
}

const BOARD_COLUMNS = `
  t.id, t.title, t.status, t.priority, t.project_id, t.tenant_id,
  t.workflow_id, s.name AS workflow_name, s.workflow_type,
  t.task_type, t.story_points, t.recurring, ${TASK_RECURRENCE_SELECT},
  t.agent_id, a.name AS agent_name,
  t.assigned_agent_id, assigned.name AS assigned_agent_name,
  t.active_instance_id, ji.status AS active_instance_status, ji.task_outcome AS active_instance_task_outcome,
  (
    SELECT ji2.task_outcome
    FROM job_instances ji2
    WHERE ji2.task_id = t.id AND ji2.task_outcome IS NOT NULL AND ji2.task_outcome != ''
    ORDER BY COALESCE(ji2.lifecycle_outcome_posted_at, ji2.completed_at, ji2.runtime_completed_at, ji2.runtime_ended_at, ji2.created_at) DESC,
             ji2.id DESC
    LIMIT 1
  ) AS latest_task_outcome,
  t.origin_task_id, origin_t.title AS origin_task_title,
  t.defect_type, COALESCE(tom.spawned_defects, 0) AS spawned_defects,
  t.paused_at, t.pause_reason,
  LEFT(t.failure_detail, ${BOARD_FAILURE_DETAIL_CHARS}) AS failure_detail,
  (char_length(t.failure_detail) > ${BOARD_FAILURE_DETAIL_CHARS}) AS failure_detail_truncated,
  t.created_at, t.updated_at
`;

const BOARD_JOINS = `
  LEFT JOIN workflows s ON s.id = t.workflow_id
  LEFT JOIN agents a ON a.id = t.agent_id
  LEFT JOIN agents assigned ON assigned.id = t.assigned_agent_id
  LEFT JOIN job_instances ji ON ji.id = t.active_instance_id
  LEFT JOIN tasks origin_t ON origin_t.id = t.origin_task_id
  LEFT JOIN task_outcome_metrics tom ON tom.task_id = t.id
`;

export async function listBoardTasks(db: Db, query: BoardQuery): Promise<BoardResponse> {
  const perStatusLimit = Math.min(
    positiveInt(query.per_status_limit) ?? BOARD_DEFAULT_PER_STATUS_LIMIT,
    BOARD_MAX_PER_STATUS_LIMIT,
  );
  const filter = boardFilter(query);
  const limit = bucketLimitSql(perStatusLimit, parseExpandedBuckets(query.expand));

  const bucketRows = await db.all<{ workflow_id: number | null; status: string; total: number }>(`
    SELECT t.workflow_id, t.status, COUNT(*)::int AS total
    FROM tasks t
    WHERE ${filter.sql}
    GROUP BY t.workflow_id, t.status
  `, ...filter.params);

  const rows = await db.all<Record<string, unknown>>(`
    SELECT ${BOARD_COLUMNS}
    FROM (
      SELECT t.id, t.workflow_id, t.status,
             ROW_NUMBER() OVER (PARTITION BY t.workflow_id, t.status ORDER BY t.created_at DESC, t.id DESC) AS bucket_rank
      FROM tasks t
      WHERE ${filter.sql}
    ) ranked
    JOIN tasks t ON t.id = ranked.id
    ${BOARD_JOINS}
    WHERE ranked.bucket_rank <= ${limit.sql}
    ORDER BY t.created_at DESC, t.id DESC
  `, ...filter.params, ...limit.params);

  const tasks = await enrichBoardRows(db, rows);

  const loaded = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.workflow_id ?? 'none'}:${row.status}`;
    loaded.set(key, (loaded.get(key) ?? 0) + 1);
  }
  const buckets = bucketRows.map(bucket => ({
    workflow_id: bucket.workflow_id == null ? null : Number(bucket.workflow_id),
    status: String(bucket.status),
    total: Number(bucket.total),
    loaded: loaded.get(`${bucket.workflow_id ?? 'none'}:${bucket.status}`) ?? 0,
  }));
  return {
    tasks,
    buckets,
    total: buckets.reduce((sum, bucket) => sum + bucket.total, 0),
    per_status_limit: perStatusLimit,
  };
}

// ── Batched enrichment ──────────────────────────────────────────────────────

interface RelationshipTypeRow {
  tenant_id: number | null;
  workflow_type_key: string;
  key: string;
  affects_dispatch_eligibility: number;
  direction_semantics: string;
  resolved_statuses: string[];
}

function parseStatusList(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
  } catch {
    return [];
  }
}

/**
 * Resolves a relationship's type exactly as relationships.ts getRelationshipTypeForTask does,
 * from one load of the (small) type table: the source task's workflow type or 'generic',
 * the task's tenant row before a shared one, the workflow type before 'generic', and
 * defect_of falling back to any workflow type, 'dev' first.
 */
function relationshipTypeResolver(types: RelationshipTypeRow[]) {
  return (key: string, workflowType: string, tenantId: number | null): RelationshipTypeRow | null => {
    const tenantOk = (row: RelationshipTypeRow) => tenantId == null || row.tenant_id == null || row.tenant_id === tenantId;
    const tenantRank = (row: RelationshipTypeRow) => (tenantId != null && row.tenant_id === tenantId ? 0 : 1);
    const matches = types
      .filter(row => row.key === key && (row.workflow_type_key === workflowType || row.workflow_type_key === 'generic') && tenantOk(row))
      .sort((a, b) => tenantRank(a) - tenantRank(b)
        || (a.workflow_type_key === workflowType ? 0 : 1) - (b.workflow_type_key === workflowType ? 0 : 1));
    if (matches[0]) return matches[0];
    if (key !== 'defect_of') return null;
    const fallback = types
      .filter(row => row.key === key && tenantOk(row))
      .sort((a, b) => (a.workflow_type_key === 'dev' ? 0 : 1) - (b.workflow_type_key === 'dev' ? 0 : 1)
        || a.workflow_type_key.localeCompare(b.workflow_type_key));
    return fallback[0] ?? null;
  };
}

async function enrichBoardRows(db: Db, rows: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  if (rows.length === 0) return [];
  const ids = rows.map(row => Number(row.id));

  const terminalCache = new Map<string, Promise<string[]>>();
  const terminalStatuses = (workflowId: number | null, tenantId: number | null) => {
    const key = `${workflowId ?? 'none'}:${tenantId ?? 'none'}`;
    let statuses = terminalCache.get(key);
    if (!statuses) {
      statuses = listConfiguredTerminalStatuses(db, { workflowId, tenantId });
      terminalCache.set(key, statuses);
    }
    return statuses;
  };

  // Blockers and blocking, the way enrichTask lists them: legacy task_dependencies plus
  // blocked_by / blocks relationships, limited to tasks in the same tenant.
  const links = await db.all<{ subject_id: number; other_id: number; side: 'blocker' | 'blocking'; title: string; status: string }>(`
    SELECT DISTINCT pair.subject_id, pair.other_id, pair.side, other.title, other.status
    FROM (
      SELECT blocked_id AS subject_id, blocker_id AS other_id, 'blocker' AS side FROM task_dependencies WHERE blocked_id = ANY(?::bigint[])
      UNION SELECT source_task_id, target_task_id, 'blocker' FROM task_relationships
        WHERE relationship_type_key = 'blocked_by' AND source_task_id = ANY(?::bigint[])
      UNION SELECT target_task_id, source_task_id, 'blocker' FROM task_relationships
        WHERE relationship_type_key = 'blocks' AND target_task_id = ANY(?::bigint[])
      UNION SELECT blocker_id, blocked_id, 'blocking' FROM task_dependencies WHERE blocker_id = ANY(?::bigint[])
      UNION SELECT target_task_id, source_task_id, 'blocking' FROM task_relationships
        WHERE relationship_type_key = 'blocked_by' AND target_task_id = ANY(?::bigint[])
      UNION SELECT source_task_id, target_task_id, 'blocking' FROM task_relationships
        WHERE relationship_type_key = 'blocks' AND source_task_id = ANY(?::bigint[])
    ) pair
    JOIN tasks subject ON subject.id = pair.subject_id
    JOIN tasks other ON other.id = pair.other_id
    WHERE other.tenant_id IS NOT DISTINCT FROM subject.tenant_id
    ORDER BY pair.other_id
  `, ids, ids, ids, ids, ids, ids);

  // Dispatch-blocking state, decided as enrichTask's resolveBlockerState decides it: every
  // relationship whose type affects dispatch eligibility, from whichever side blocks.
  const relationships = await db.all<{
    source_task_id: number; target_task_id: number; relationship_type_key: string;
    source_workflow_type: string | null; source_tenant_id: number | null;
    source_status: string; source_workflow_id: number | null; source_title: string;
    target_status: string; target_workflow_id: number | null; target_title: string;
  }>(`
    SELECT tr.source_task_id, tr.target_task_id, tr.relationship_type_key,
           COALESCE(source_wf.workflow_type, 'generic') AS source_workflow_type, source.tenant_id AS source_tenant_id,
           source.status AS source_status, source.workflow_id AS source_workflow_id, source.title AS source_title,
           target.status AS target_status, target.workflow_id AS target_workflow_id, target.title AS target_title
    FROM task_relationships tr
    JOIN tasks source ON source.id = tr.source_task_id
    JOIN tasks target ON target.id = tr.target_task_id
    LEFT JOIN workflows source_wf ON source_wf.id = source.workflow_id
    WHERE tr.source_task_id = ANY(?::bigint[]) OR tr.target_task_id = ANY(?::bigint[])
  `, ids, ids);
  const typeRows = relationships.length === 0 ? [] : (await db.all<Record<string, unknown>>(`
    SELECT tenant_id, workflow_type_key, key, affects_dispatch_eligibility, direction_semantics, resolved_statuses_json
    FROM workflow_type_relationship_types
  `)).map(row => ({
    tenant_id: row.tenant_id == null ? null : Number(row.tenant_id),
    workflow_type_key: String(row.workflow_type_key),
    key: String(row.key),
    affects_dispatch_eligibility: Number(row.affects_dispatch_eligibility ?? 0),
    direction_semantics: String(row.direction_semantics ?? 'informational'),
    resolved_statuses: parseStatusList(row.resolved_statuses_json),
  }));
  const resolveType = relationshipTypeResolver(typeRows);

  // Tool-configuration recoveries, matched per task as getTaskMcpRecovery matches them.
  const recoveries = await db.all<Record<string, unknown> & { id: number; agent_id: number; agent_tenant_id: number | null }>(`
    SELECT r.*, a.tenant_id AS agent_tenant_id
    FROM agent_mcp_recovery r
    JOIN agents a ON a.id = r.agent_id
    WHERE r.resolved_at IS NULL
    ORDER BY r.started_at
  `);
  const recoveryLinks = recoveries.length === 0 ? [] : await db.all<{ recovery_id: number; task_id: number }>(
    'SELECT recovery_id, task_id FROM agent_mcp_recovery_tasks WHERE task_id = ANY(?::bigint[])', ids,
  );

  const blockersById = new Map<number, BoardTaskLink[]>();
  const blockingById = new Map<number, BoardTaskLink[]>();
  for (const link of links) {
    const target = link.side === 'blocker' ? blockersById : blockingById;
    const list = target.get(Number(link.subject_id)) ?? [];
    list.push({ id: Number(link.other_id), title: String(link.title ?? ''), status: String(link.status ?? '') });
    target.set(Number(link.subject_id), list);
  }

  const idSet = new Set(ids);
  const candidatesById = new Map<number, Array<{ blockerId: number; status: string; workflowId: number | null; resolved: string[] }>>();
  for (const relationship of relationships) {
    const type = resolveType(relationship.relationship_type_key, relationship.source_workflow_type ?? 'generic',
      relationship.source_tenant_id == null ? null : Number(relationship.source_tenant_id));
    if (!type || type.affects_dispatch_eligibility !== 1) continue;
    const sourceId = Number(relationship.source_task_id);
    const targetId = Number(relationship.target_task_id);
    if (type.direction_semantics === 'target_blocks_source' && idSet.has(sourceId)) {
      const list = candidatesById.get(sourceId) ?? [];
      list.push({ blockerId: targetId, status: String(relationship.target_status ?? ''), workflowId: relationship.target_workflow_id == null ? null : Number(relationship.target_workflow_id), resolved: type.resolved_statuses });
      candidatesById.set(sourceId, list);
    }
    if (type.direction_semantics === 'source_blocks_target' && idSet.has(targetId)) {
      const list = candidatesById.get(targetId) ?? [];
      list.push({ blockerId: sourceId, status: String(relationship.source_status ?? ''), workflowId: relationship.source_workflow_id == null ? null : Number(relationship.source_workflow_id), resolved: type.resolved_statuses });
      candidatesById.set(targetId, list);
    }
  }

  return Promise.all(rows.map(async row => {
    const id = Number(row.id);
    const tenantId = row.tenant_id == null ? null : Number(row.tenant_id);
    const workflowId = row.workflow_id == null ? null : Number(row.workflow_id);

    const activeBlockerIds = new Set<number>();
    for (const candidate of candidatesById.get(id) ?? []) {
      if (candidate.resolved.includes(candidate.status)) continue;
      if ((await terminalStatuses(candidate.workflowId, tenantId)).includes(candidate.status)) continue;
      activeBlockerIds.add(candidate.blockerId);
    }
    const taskIsTerminal = activeBlockerIds.size > 0
      && (await terminalStatuses(workflowId, tenantId)).includes(String(row.status));

    let runtimeRecovery: Record<string, unknown> | null = null;
    if (row.active_instance_id == null && recoveries.length > 0) {
      const assigned = row.assigned_agent_id ?? row.agent_id;
      const assignedId = assigned == null ? null : Number(assigned);
      const linkedRecoveryIds = new Set(recoveryLinks.filter(link => Number(link.task_id) === id).map(link => Number(link.recovery_id)));
      const recovery = recoveries.find(candidate => tenantId !== null && Number(candidate.agent_tenant_id) === tenantId
        && (assignedId !== null ? Number(candidate.agent_id) === assignedId : linkedRecoveryIds.has(Number(candidate.id))));
      if (recovery && !(await terminalStatuses(workflowId, tenantId)).includes(String(row.status))) {
        const { agent_tenant_id: _agentTenantId, ...publicRecovery } = recovery;
        runtimeRecovery = publicRecovery;
      }
    }

    const latestOutcome = typeof row.latest_task_outcome === 'string' && row.latest_task_outcome.trim()
      ? row.latest_task_outcome.trim()
      : (typeof row.active_instance_task_outcome === 'string' && row.active_instance_task_outcome.trim() ? row.active_instance_task_outcome.trim() : null);

    return {
      ...row,
      ...taskRecurrenceMetadata(row),
      failure_detail_truncated: Boolean(row.failure_detail_truncated),
      spawned_defects: Number(row.spawned_defects ?? 0),
      latest_task_outcome: latestOutcome,
      active_agent_name: row.agent_name ?? null,
      runtime_recovery: runtimeRecovery,
      is_blocked: !taskIsTerminal && activeBlockerIds.size > 0,
      blockers: (blockersById.get(id) ?? []).map(blocker => ({ ...blocker, blocks_dispatch: activeBlockerIds.has(blocker.id) })),
      blocking: blockingById.get(id) ?? [],
    };
  }));
}
