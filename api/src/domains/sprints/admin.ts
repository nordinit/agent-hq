import type Database from 'better-sqlite3';
import { seedSprintTaskPolicy } from '../routing/policy/seed';
import { writeProjectAudit, diffFields } from '../../lib/projectAudit';
import { insertRuntimeLog } from '../../lib/runtimeTenantScope';
import {
  completeSprint,
  normalizeSprintStatus,
  resolveSprintTypeOrNull,
  sprintTypeExists,
} from './lifecycle';
import type { SprintRecord } from './readModel';

interface SprintCloneSource {
  id: number;
  project_id: number;
  name: string;
  sprint_type: string;
}

type CreateSprintInput = Partial<SprintRecord> & {
  source_sprint_id?: unknown;
  tenant_id?: unknown;
};

const ALLOWED_UPDATE_FIELDS = new Set([
  'project_id',
  'name',
  'goal',
  'sprint_type',
  'status',
  'length_kind',
  'length_value',
  'started_at',
  'ended_at',
]);

function tableExists(db: Database.Database, table: string): boolean {
  try {
    const row = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
      LIMIT 1
    `).get(table) as { name: string } | undefined;
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

function listTableColumns(db: Database.Database, table: string): string[] {
  if (!tableExists(db, table)) return [];
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
  } catch {
    return [];
  }
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  return listTableColumns(db, table).includes(column);
}

function sprintRoutingJoinPredicate(db: Database.Database): string {
  return tableHasColumn(db, 'sprint_task_routing_rules', 'project_id')
    && tableHasColumn(db, 'sprint_task_routing_rules', 'sprint_type')
    ? `rr.sprint_id = s.id
      OR (
        rr.project_id = s.project_id
        AND rr.sprint_type = s.sprint_type
        AND rr.sprint_id IS NULL
      )`
    : `rr.sprint_id = s.id`;
}

function cloneSprintScopedRows(
  db: Database.Database,
  table: string,
  sourceSprintId: number,
  targetProjectId: number,
  targetSprintId: number,
  targetTenantId: number | null,
): number {
  const columns = listTableColumns(db, table).filter((column) => column !== 'id');
  if (!columns.includes('sprint_id')) return 0;

  const sourceRows = db.prepare(`
    SELECT *
    FROM ${table}
    WHERE sprint_id = ?
    ORDER BY id ASC
  `).all(sourceSprintId) as Array<Record<string, unknown>>;

  if (sourceRows.length === 0) return 0;

  db.prepare(`DELETE FROM ${table} WHERE sprint_id = ?`).run(targetSprintId);

  const insert = db.prepare(`
    INSERT INTO ${table} (${columns.join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})
  `);

  for (const row of sourceRows) {
    insert.run(...columns.map((column) => {
      if (column === 'tenant_id') return targetTenantId;
      if (column === 'project_id') return targetProjectId;
      if (column === 'sprint_id') return targetSprintId;
      return row[column] ?? null;
    }));
  }

  return sourceRows.length;
}

function cloneSprintScopedModelRoutingRules(
  db: Database.Database,
  sourceSprintId: number,
  targetProjectId: number,
  targetSprintId: number,
  targetTenantId: number | null,
): number {
  const columns = listTableColumns(db, 'story_point_model_routing').filter((column) => column !== 'id');
  if (!columns.includes('project_id') || !columns.includes('sprint_id')) return 0;

  const sourceRows = db.prepare(`
    SELECT *
    FROM story_point_model_routing
    WHERE sprint_id = ?
    ORDER BY id ASC
  `).all(sourceSprintId) as Array<Record<string, unknown>>;

  if (sourceRows.length === 0) return 0;

  const insert = db.prepare(`
    INSERT INTO story_point_model_routing (${columns.join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})
  `);

  for (const row of sourceRows) {
    insert.run(...columns.map((column) => {
      if (column === 'tenant_id') return targetTenantId;
      if (column === 'project_id') return targetProjectId;
      if (column === 'sprint_id') return targetSprintId;
      return row[column] ?? null;
    }));
  }

  return sourceRows.length;
}

function cloneSprintSetup(
  db: Database.Database,
  sourceSprintId: number,
  targetProjectId: number,
  targetSprintId: number,
  targetTenantId: number | null,
): void {
  cloneSprintScopedRows(db, 'sprint_task_statuses', sourceSprintId, targetProjectId, targetSprintId, targetTenantId);
  cloneSprintScopedRows(db, 'sprint_task_transitions', sourceSprintId, targetProjectId, targetSprintId, targetTenantId);
  cloneSprintScopedRows(db, 'sprint_task_transition_requirements', sourceSprintId, targetProjectId, targetSprintId, targetTenantId);
  cloneSprintScopedRows(db, 'sprint_task_routing_rules', sourceSprintId, targetProjectId, targetSprintId, targetTenantId);
  cloneSprintScopedModelRoutingRules(db, sourceSprintId, targetProjectId, targetSprintId, targetTenantId);
}

function getSprintCloneSourceOrThrow(
  db: Database.Database,
  sourceSprintIdRaw: unknown,
  projectId: number,
  tenantId?: number | null,
): SprintCloneSource | null {
  if (sourceSprintIdRaw === undefined || sourceSprintIdRaw === null || sourceSprintIdRaw === '') return null;

  const sourceSprintId = Number(sourceSprintIdRaw);
  if (!Number.isInteger(sourceSprintId) || sourceSprintId <= 0) {
    throw Object.assign(new Error('source_sprint_id must be a positive integer'), { status: 400 });
  }

  const hasSprintTenantId = tableHasColumn(db, 'sprints', 'tenant_id');
  const sourceSprint = db.prepare(`
    SELECT id, project_id, name, sprint_type
    FROM sprints
    WHERE id = ?
      ${hasSprintTenantId && tenantId != null ? 'AND tenant_id = ?' : ''}
    LIMIT 1
  `).get(...(hasSprintTenantId && tenantId != null ? [sourceSprintId, tenantId] : [sourceSprintId])) as SprintCloneSource | undefined;

  if (!sourceSprint) {
    throw Object.assign(new Error(`Source sprint ${sourceSprintId} not found`), { status: 404 });
  }

  if (sourceSprint.project_id !== projectId) {
    throw Object.assign(new Error(`source_sprint_id must belong to project ${projectId}`), { status: 400 });
  }

  return sourceSprint;
}

export function createSprint(
  db: Database.Database,
  body: CreateSprintInput,
  actor: string,
) {
  const {
    project_id,
    name,
    goal = '',
    sprint_type,
    source_sprint_id,
    status = 'planning',
    length_kind = 'time',
    length_value = '',
    started_at,
  } = body;
  const tenantId = Number.isFinite(Number(body.tenant_id)) ? Number(body.tenant_id) : null;

  if (!project_id) throw Object.assign(new Error('project_id is required'), { status: 400 });
  if (!name) throw Object.assign(new Error('name is required'), { status: 400 });

  const hasProjectTenantId = tableHasColumn(db, 'projects', 'tenant_id');
  const project = db.prepare(`SELECT id${hasProjectTenantId ? ', tenant_id' : ''} FROM projects WHERE id = ?${hasProjectTenantId && tenantId != null ? ' AND tenant_id = ?' : ''}`)
    .get(...(hasProjectTenantId && tenantId != null ? [project_id, tenantId] : [project_id])) as { id: number; tenant_id?: number | null } | undefined;
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const sourceSprint = getSprintCloneSourceOrThrow(db, source_sprint_id, Number(project_id), tenantId);
  const requestedSprintType = resolveSprintTypeOrNull(sprint_type);
  if (sourceSprint && requestedSprintType && requestedSprintType !== sourceSprint.sprint_type) {
    throw Object.assign(
      new Error(`sprint_type must match source sprint type "${sourceSprint.sprint_type}" when source_sprint_id is provided`),
      { status: 400 },
    );
  }

  const resolvedSprintType = sourceSprint?.sprint_type ?? requestedSprintType ?? 'generic';
  if (!sprintTypeExists(db, resolvedSprintType)) {
    throw Object.assign(new Error(`Unknown sprint_type "${resolvedSprintType}"`), { status: 400 });
  }

  const normalizedStatus = normalizeSprintStatus(status);
  let newId = 0;

  db.transaction(() => {
    const hasSprintTenantId = tableHasColumn(db, 'sprints', 'tenant_id');
    const result = hasSprintTenantId
      ? db.prepare(`
          INSERT INTO sprints (tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value, started_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(project.tenant_id ?? tenantId, project_id, name, goal, resolvedSprintType, normalizedStatus, length_kind, length_value, started_at ?? null)
      : db.prepare(`
          INSERT INTO sprints (project_id, name, goal, sprint_type, status, length_kind, length_value, started_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(project_id, name, goal, resolvedSprintType, normalizedStatus, length_kind, length_value, started_at ?? null);

    newId = Number(result.lastInsertRowid);

    if (sourceSprint) {
      cloneSprintSetup(db, sourceSprint.id, Number(project_id), newId, project.tenant_id ?? null);
    }
  })();

  writeProjectAudit(db, project_id, 'sprint', newId, 'created', actor, {
    name,
    goal,
    sprint_type: resolvedSprintType,
    source_sprint_id: sourceSprint?.id ?? null,
    cloned_setup: Boolean(sourceSprint),
    status: normalizedStatus,
    length_kind,
    length_value,
  });

  return db.prepare(`
    SELECT s.*, p.name as project_name,
      0 as agent_count, 0 as task_count, 0 as tasks_done,
      0 as total_story_points, 0 as done_story_points, 0 as remaining_story_points
    FROM sprints s
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE s.id = ?
  `).get(newId);
}

export function updateSprint(
  db: Database.Database,
  sprintId: number,
  body: Record<string, unknown>,
  actor: string,
) {
  const existing = db.prepare('SELECT * FROM sprints WHERE id = ?').get(sprintId) as SprintRecord | undefined;
  if (!existing) throw Object.assign(new Error('Sprint not found'), { status: 404 });

  const unsupportedFields = Object.keys(body).filter((key) => !ALLOWED_UPDATE_FIELDS.has(key));
  if (unsupportedFields.length > 0) {
    const error = new Error(`Unsupported sprint update field(s): ${unsupportedFields.join(', ')}`) as Error & {
      status?: number;
      body?: Record<string, unknown>;
    };
    error.status = 400;
    error.body = {
      error: error.message,
      code: 'unsupported_sprint_update_fields',
      unsupported_fields: unsupportedFields,
      allowed_fields: Array.from(ALLOWED_UPDATE_FIELDS),
    };
    throw error;
  }

  const {
    project_id,
    name,
    goal,
    sprint_type,
    status,
    length_kind,
    length_value,
    started_at,
    ended_at,
  } = body as Partial<SprintRecord>;

  const resolvedSprintType = sprint_type !== undefined
    ? resolveSprintTypeOrNull(sprint_type)
    : existing.sprint_type;

  if (!resolvedSprintType) {
    throw Object.assign(new Error('sprint_type cannot be empty'), { status: 400 });
  }
  if (!sprintTypeExists(db, resolvedSprintType)) {
    throw Object.assign(new Error(`Unknown sprint_type "${resolvedSprintType}"`), { status: 400 });
  }

  const requestedProjectId = project_id !== undefined ? Number(project_id) : existing.project_id;
  if (!Number.isInteger(requestedProjectId) || requestedProjectId <= 0) {
    throw Object.assign(new Error('project_id must be a positive integer when provided'), { status: 400 });
  }

  const targetProject = db.prepare('SELECT id FROM projects WHERE id = ?').get(requestedProjectId);
  if (!targetProject) {
    throw Object.assign(new Error(`Project ${requestedProjectId} does not exist`), { status: 400 });
  }

  const newValues = {
    project_id: requestedProjectId,
    name: name ?? existing.name,
    goal: goal !== undefined ? goal : existing.goal,
    sprint_type: resolvedSprintType,
    status: status !== undefined ? normalizeSprintStatus(status) : existing.status,
    length_kind: length_kind ?? existing.length_kind,
    length_value: length_value !== undefined ? length_value : existing.length_value,
    started_at: started_at !== undefined ? started_at : existing.started_at,
    ended_at: ended_at !== undefined ? ended_at : existing.ended_at,
  };

  db.prepare(`
    UPDATE sprints SET
      project_id = ?,
      name = ?,
      goal = ?,
      sprint_type = ?,
      status = ?,
      length_kind = ?,
      length_value = ?,
      started_at = ?,
      ended_at = ?
    WHERE id = ?
  `).run(
    newValues.project_id,
    newValues.name,
    newValues.goal,
    newValues.sprint_type,
    newValues.status,
    newValues.length_kind,
    newValues.length_value,
    newValues.started_at,
    newValues.ended_at,
    sprintId,
  );

  seedSprintTaskPolicy(db, sprintId);

  const changes = diffFields(
    {
      name: existing.name,
      goal: existing.goal,
      sprint_type: existing.sprint_type,
      status: existing.status,
      length_kind: existing.length_kind,
      length_value: existing.length_value,
      project_id: existing.project_id,
    },
    {
      name: newValues.name,
      goal: newValues.goal,
      sprint_type: newValues.sprint_type,
      status: newValues.status,
      length_kind: newValues.length_kind,
      length_value: newValues.length_value,
      project_id: newValues.project_id,
    },
  );
  if (Object.keys(changes).length > 0) {
    writeProjectAudit(db, newValues.project_id, 'sprint', sprintId, 'updated', actor, changes);
  }

  const routingJoinPredicate = sprintRoutingJoinPredicate(db);
  return db.prepare(`
    SELECT s.*,
      p.name as project_name,
      COUNT(DISTINCT rr.agent_id) as agent_count,
      COUNT(DISTINCT t.id) as task_count,
      COUNT(DISTINCT CASE WHEN t.status = 'done' THEN t.id END) as tasks_done,
      COALESCE(SUM(COALESCE(t.story_points, 0)), 0) as total_story_points,
      COALESCE(SUM(CASE WHEN t.status = 'done' THEN COALESCE(t.story_points, 0) ELSE 0 END), 0) as done_story_points,
      COALESCE(SUM(CASE WHEN t.status != 'done' THEN COALESCE(t.story_points, 0) ELSE 0 END), 0) as remaining_story_points
    FROM sprints s
    LEFT JOIN projects p ON p.id = s.project_id
    LEFT JOIN sprint_task_routing_rules rr
      ON ${routingJoinPredicate}
    LEFT JOIN tasks t ON t.sprint_id = s.id
    WHERE s.id = ?
    GROUP BY s.id
  `).get(sprintId);
}

export function deleteSprint(db: Database.Database, sprintId: number, actor: string, tenantId?: number) {
  const hasSprintTenantId = tableHasColumn(db, 'sprints', 'tenant_id');
  const hasProjectTenantId = tableHasColumn(db, 'projects', 'tenant_id');
  const tenantJoin = tenantId && !hasSprintTenantId && hasProjectTenantId
    ? 'LEFT JOIN projects p ON p.id = s.project_id'
    : '';
  const tenantPredicate = tenantId && hasSprintTenantId
    ? ' AND s.tenant_id = ?'
    : tenantId && hasProjectTenantId
      ? ' AND p.tenant_id = ?'
      : '';
  const params = tenantPredicate ? [sprintId, tenantId] : [sprintId];
  const sprint = db.prepare(`
    SELECT s.*
    FROM sprints s
    ${tenantJoin}
    WHERE s.id = ?${tenantPredicate}
  `).get(...params) as SprintRecord | undefined;
  if (!sprint) throw Object.assign(new Error('Sprint not found'), { status: 404 });

  db.transaction(() => {
    writeProjectAudit(db, sprint.project_id, 'sprint', sprintId, 'deleted', actor, {
      name: sprint.name,
      status: sprint.status,
    });
    db.prepare('DELETE FROM tasks WHERE sprint_id = ?').run(sprintId);
    db.prepare('DELETE FROM sprints WHERE id = ?').run(sprintId);
  })();
  return { ok: true };
}

export function closeSprint(db: Database.Database, sprintId: number, actor: string) {
  const sprint = db.prepare('SELECT * FROM sprints WHERE id = ?').get(sprintId) as SprintRecord | undefined;
  if (!sprint) throw Object.assign(new Error('Sprint not found'), { status: 404 });
  if (sprint.status === 'closed') {
    return db.prepare('SELECT * FROM sprints WHERE id = ?').get(sprintId);
  }

  const oldStatus = sprint.status;
  db.prepare(`
    UPDATE sprints SET status = 'closed', ended_at = COALESCE(ended_at, datetime('now')) WHERE id = ?
  `).run(sprintId);

  writeProjectAudit(db, sprint.project_id, 'sprint', sprintId, 'updated', actor, {
    status: { old: oldStatus, new: 'closed' },
  });

  insertRuntimeLog(db, {
    projectId: sprint.project_id,
    jobTitle: `Sprint: ${sprint.name}`,
    level: 'info',
    message: `Sprint "${sprint.name}" (id=${sprintId}) closed manually.`,
  });

  console.log(`[sprints] Sprint ${sprintId} "${sprint.name}" closed.`);
  return db.prepare('SELECT * FROM sprints WHERE id = ?').get(sprintId);
}

export function completeSprintRoute(db: Database.Database, sprintId: number) {
  const sprint = db.prepare('SELECT id FROM sprints WHERE id = ?').get(sprintId);
  if (!sprint) throw Object.assign(new Error('Sprint not found'), { status: 404 });
  completeSprint(sprintId);
  return db.prepare('SELECT * FROM sprints WHERE id = ?').get(sprintId);
}

export function attachSprintJob(db: Database.Database, sprintId: number, jobId?: number) {
  const sprint = db.prepare('SELECT id FROM sprints WHERE id = ?').get(sprintId);
  if (!sprint) throw Object.assign(new Error('Sprint not found'), { status: 404 });
  if (!jobId) throw Object.assign(new Error('job_id is required'), { status: 400 });

  const job = db.prepare('SELECT id FROM agents WHERE id = ?').get(jobId);
  if (!job) throw Object.assign(new Error('Agent/job not found'), { status: 404 });

  throw Object.assign(
    new Error('Sprint-scoped agents are deprecated. Configure sprint-specific dispatch with sprint_task_routing_rules instead.'),
    { status: 410 },
  );
}

export function detachSprintJob(db: Database.Database, sprintId: number, jobId: number) {
  const sprint = db.prepare('SELECT id FROM sprints WHERE id = ?').get(sprintId);
  if (!sprint) throw Object.assign(new Error('Sprint not found'), { status: 404 });
  const job = db.prepare('SELECT id FROM agents WHERE id = ?').get(jobId);
  if (!job) throw Object.assign(new Error('Agent/job not found'), { status: 404 });

  throw Object.assign(
    new Error('Sprint-scoped agents are deprecated. Remove or update sprint_task_routing_rules instead.'),
    { status: 410 },
  );
}
