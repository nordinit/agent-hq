import { seedSprintTaskPolicy } from '../routing/policy/seed';
import { writeProjectAudit, diffFields } from '../../lib/projectAudit';
import { insertRuntimeLog } from '../../lib/runtimeTenantScope';
import { normalizeRepoConfig, validateRepoConfig } from '../../lib/repoConfig';
import { toCanonicalTimestamp } from '../../lib/timestamps';
import {
  completeSprint,
  normalizeSprintStatus,
  resolveSprintTypeOrNull,
  sprintTypeExists,
} from './lifecycle';
import type { SprintRecord } from './readModel';
import { type Db } from "../../db/adapter/types";

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
  'repo_access_mode',
  'repo_path',
  'repo_url',
]);

async function tableExists(db: Db, table: string): Promise<boolean> {
  try {
    const row = await db.get(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
      LIMIT 1
    `, table) as { name: string } | undefined;
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

async function listTableColumns(db: Db, table: string): Promise<string[]> {
  if (!await tableExists(db, table)) return [];
  try {
    return (await db.all(`PRAGMA table_info(${table})`) as Array<{ name: string }>).map((row) => row.name);
  } catch {
    return [];
  }
}

async function tableHasColumn(db: Db, table: string, column: string): Promise<boolean> {
  return (await listTableColumns(db, table)).includes(column);
}

async function sprintRoutingJoinPredicate(db: Db): Promise<string> {
  return await tableHasColumn(db, 'sprint_task_routing_rules', 'project_id')
    && await tableHasColumn(db, 'sprint_task_routing_rules', 'sprint_type')
    ? `rr.sprint_id = s.id
      OR (
        rr.project_id = s.project_id
        AND rr.sprint_type = s.sprint_type
        AND rr.sprint_id IS NULL
      )`
    : `rr.sprint_id = s.id`;
}

async function cloneSprintScopedRows(
  db: Db,
  table: string,
  sourceSprintId: number,
  targetProjectId: number,
  targetSprintId: number,
  targetTenantId: number | null,
): Promise<number> {
  const columns = (await listTableColumns(db, table)).filter((column) => column !== 'id');
  if (!columns.includes('sprint_id')) return 0;

  const sourceRows = await db.all(`
    SELECT *
    FROM ${table}
    WHERE sprint_id = ?
    ORDER BY id ASC
  `, sourceSprintId) as Array<Record<string, unknown>>;

  if (sourceRows.length === 0) return 0;

  await db.run(`DELETE FROM ${table} WHERE sprint_id = ?`, targetSprintId);

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

async function cloneSprintScopedModelRoutingRules(
  db: Db,
  sourceSprintId: number,
  targetProjectId: number,
  targetSprintId: number,
  targetTenantId: number | null,
): Promise<number> {
  const columns = (await listTableColumns(db, 'story_point_model_routing')).filter((column) => column !== 'id');
  if (!columns.includes('project_id') || !columns.includes('sprint_id')) return 0;

  const sourceRows = await db.all(`
    SELECT *
    FROM story_point_model_routing
    WHERE sprint_id = ?
    ORDER BY id ASC
  `, sourceSprintId) as Array<Record<string, unknown>>;

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

async function cloneSprintSetup(
  db: Db,
  sourceSprintId: number,
  targetProjectId: number,
  targetSprintId: number,
  targetTenantId: number | null,
): Promise<void> {
  await cloneSprintScopedRows(db, 'sprint_task_statuses', sourceSprintId, targetProjectId, targetSprintId, targetTenantId);
  await cloneSprintScopedRows(db, 'sprint_task_transitions', sourceSprintId, targetProjectId, targetSprintId, targetTenantId);
  await cloneSprintScopedRows(db, 'sprint_task_transition_requirements', sourceSprintId, targetProjectId, targetSprintId, targetTenantId);
  await cloneSprintScopedRows(db, 'sprint_task_routing_rules', sourceSprintId, targetProjectId, targetSprintId, targetTenantId);
  await cloneSprintScopedModelRoutingRules(db, sourceSprintId, targetProjectId, targetSprintId, targetTenantId);
}

async function getSprintCloneSourceOrThrow(
  db: Db,
  sourceSprintIdRaw: unknown,
  projectId: number,
  tenantId?: number | null,
): Promise<SprintCloneSource | null> {
  if (sourceSprintIdRaw === undefined || sourceSprintIdRaw === null || sourceSprintIdRaw === '') return null;

  const sourceSprintId = Number(sourceSprintIdRaw);
  if (!Number.isInteger(sourceSprintId) || sourceSprintId <= 0) {
    throw Object.assign(new Error('source_sprint_id must be a positive integer'), { status: 400 });
  }

  const hasSprintTenantId = await tableHasColumn(db, 'sprints', 'tenant_id');
  const sourceSprint = await db.get(`
    SELECT id, project_id, name, sprint_type
    FROM sprints
    WHERE id = ?
      ${hasSprintTenantId && tenantId != null ? 'AND tenant_id = ?' : ''}
    LIMIT 1
  `, ...(hasSprintTenantId && tenantId != null ? [sourceSprintId, tenantId] : [sourceSprintId])) as SprintCloneSource | undefined;

  if (!sourceSprint) {
    throw Object.assign(new Error(`Source sprint ${sourceSprintId} not found`), { status: 404 });
  }

  if (sourceSprint.project_id !== projectId) {
    throw Object.assign(new Error(`source_sprint_id must belong to project ${projectId}`), { status: 400 });
  }

  return sourceSprint;
}

export async function createSprint(
  db: Db,
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
    repo_access_mode,
    repo_path,
    repo_url,
  } = body;
  const tenantId = Number.isFinite(Number(body.tenant_id)) ? Number(body.tenant_id) : null;

  if (!project_id) throw Object.assign(new Error('project_id is required'), { status: 400 });
  if (!name) throw Object.assign(new Error('name is required'), { status: 400 });

  const hasProjectTenantId = await tableHasColumn(db, 'projects', 'tenant_id');
  const project = await db.get(`SELECT id${hasProjectTenantId ? ', tenant_id' : ''} FROM projects WHERE id = ?${hasProjectTenantId && tenantId != null ? ' AND tenant_id = ?' : ''}`, ...(hasProjectTenantId && tenantId != null ? [project_id, tenantId] : [project_id])) as { id: number; tenant_id?: number | null } | undefined;
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const sourceSprint = await getSprintCloneSourceOrThrow(db, source_sprint_id, Number(project_id), tenantId);
  const requestedSprintType = resolveSprintTypeOrNull(sprint_type);
  if (sourceSprint && requestedSprintType && requestedSprintType !== sourceSprint.sprint_type) {
    throw Object.assign(
      new Error(`sprint_type must match source sprint type "${sourceSprint.sprint_type}" when source_sprint_id is provided`),
      { status: 400 },
    );
  }

  const resolvedSprintType = sourceSprint?.sprint_type ?? requestedSprintType ?? 'generic';
  if (!await sprintTypeExists(db, resolvedSprintType)) {
    throw Object.assign(new Error(`Unknown sprint_type "${resolvedSprintType}"`), { status: 400 });
  }

  const normalizedStatus = normalizeSprintStatus(status);
  const repoValidationError = validateRepoConfig({ repo_access_mode, repo_path, repo_url });
  if (repoValidationError) {
    throw Object.assign(new Error(repoValidationError), { status: 400 });
  }
  const repoConfig = normalizeRepoConfig({ repo_access_mode, repo_path, repo_url });
  let newId = 0;

  db.transaction(async () => {
    const hasSprintTenantId = await tableHasColumn(db, 'sprints', 'tenant_id');
    const result = hasSprintTenantId
      ? await db.run(`
          INSERT INTO sprints (tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value, started_at, repo_path, repo_url, repo_access_mode)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, project.tenant_id ?? tenantId, project_id, name, goal, resolvedSprintType, normalizedStatus, length_kind, length_value, toCanonicalTimestamp(started_at), repoConfig.repo_path, repoConfig.repo_url, repoConfig.repo_access_mode)
      : await db.run(`
          INSERT INTO sprints (project_id, name, goal, sprint_type, status, length_kind, length_value, started_at, repo_path, repo_url, repo_access_mode)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, project_id, name, goal, resolvedSprintType, normalizedStatus, length_kind, length_value, toCanonicalTimestamp(started_at), repoConfig.repo_path, repoConfig.repo_url, repoConfig.repo_access_mode);

    newId = Number(result.lastInsertId);

    if (sourceSprint) {
      await cloneSprintSetup(db, sourceSprint.id, Number(project_id), newId, project.tenant_id ?? null);
    }
  })();

  await writeProjectAudit(db, project_id, 'sprint', newId, 'created', actor, {
        name,
        goal,
        sprint_type: resolvedSprintType,
        source_sprint_id: sourceSprint?.id ?? null,
        cloned_setup: Boolean(sourceSprint),
        status: normalizedStatus,
        length_kind,
        length_value,
        repo_access_mode: repoConfig.repo_access_mode,
        repo_path: repoConfig.repo_path,
        repo_url: repoConfig.repo_url,
      });

  return await db.get(`
    SELECT s.*, p.name as project_name,
      0 as agent_count, 0 as task_count, 0 as tasks_done,
      0 as total_story_points, 0 as done_story_points, 0 as remaining_story_points
    FROM sprints s
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE s.id = ?
  `, newId);
}

export async function updateSprint(
  db: Db,
  sprintId: number,
  body: Record<string, unknown>,
  actor: string,
) {
  const existing = await db.get('SELECT * FROM sprints WHERE id = ?', sprintId) as SprintRecord | undefined;
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
    repo_access_mode,
    repo_path,
    repo_url,
  } = body as Partial<SprintRecord>;

  const resolvedSprintType = sprint_type !== undefined
    ? resolveSprintTypeOrNull(sprint_type)
    : existing.sprint_type;

  if (!resolvedSprintType) {
    throw Object.assign(new Error('sprint_type cannot be empty'), { status: 400 });
  }
  if (!await sprintTypeExists(db, resolvedSprintType)) {
    throw Object.assign(new Error(`Unknown sprint_type "${resolvedSprintType}"`), { status: 400 });
  }

  const requestedProjectId = project_id !== undefined ? Number(project_id) : existing.project_id;
  if (!Number.isInteger(requestedProjectId) || requestedProjectId <= 0) {
    throw Object.assign(new Error('project_id must be a positive integer when provided'), { status: 400 });
  }

  const targetProject = await db.get('SELECT id FROM projects WHERE id = ?', requestedProjectId);
  if (!targetProject) {
    throw Object.assign(new Error(`Project ${requestedProjectId} does not exist`), { status: 400 });
  }

  const repoPatchProvided = repo_access_mode !== undefined || repo_path !== undefined || repo_url !== undefined;
  const repoValidationError = repoPatchProvided
    ? validateRepoConfig({ repo_access_mode, repo_path, repo_url })
    : null;
  if (repoValidationError) {
    throw Object.assign(new Error(repoValidationError), { status: 400 });
  }
  const repoConfig = repoPatchProvided
    ? normalizeRepoConfig({ repo_access_mode, repo_path, repo_url })
    : {
        repo_path: (existing as SprintRecord & { repo_path?: string | null }).repo_path ?? null,
        repo_url: (existing as SprintRecord & { repo_url?: string | null }).repo_url ?? null,
        repo_access_mode: (existing as SprintRecord & { repo_access_mode?: 'worktree' | 'clone' | null }).repo_access_mode ?? null,
      };

  const newValues = {
    project_id: requestedProjectId,
    name: name ?? existing.name,
    goal: goal !== undefined ? goal : existing.goal,
    sprint_type: resolvedSprintType,
    status: status !== undefined ? normalizeSprintStatus(status) : existing.status,
    length_kind: length_kind ?? existing.length_kind,
    length_value: length_value !== undefined ? length_value : existing.length_value,
    // API callers send anything from '2026-03-09' to '2026-07-06T11:55:00-04:00';
    // normalize so sprints.started_at / ended_at only hold canonical UTC.
    started_at: started_at !== undefined ? toCanonicalTimestamp(started_at) : existing.started_at,
    ended_at: ended_at !== undefined ? toCanonicalTimestamp(ended_at) : existing.ended_at,
    repo_path: repoConfig.repo_path,
    repo_url: repoConfig.repo_url,
    repo_access_mode: repoConfig.repo_access_mode,
  };

  await db.run(`
    UPDATE sprints SET
      project_id = ?,
      name = ?,
      goal = ?,
      sprint_type = ?,
      status = ?,
      length_kind = ?,
      length_value = ?,
      started_at = ?,
      ended_at = ?,
      repo_path = ?,
      repo_url = ?,
      repo_access_mode = ?
    WHERE id = ?
  `, newValues.project_id, newValues.name, newValues.goal, newValues.sprint_type, newValues.status, newValues.length_kind, newValues.length_value, newValues.started_at, newValues.ended_at, newValues.repo_path, newValues.repo_url, newValues.repo_access_mode, sprintId);

  await seedSprintTaskPolicy(db, sprintId);

  const changes = diffFields(
    {
      name: existing.name,
      goal: existing.goal,
      sprint_type: existing.sprint_type,
      status: existing.status,
      length_kind: existing.length_kind,
      length_value: existing.length_value,
      project_id: existing.project_id,
      repo_path: (existing as SprintRecord & { repo_path?: string | null }).repo_path ?? null,
      repo_url: (existing as SprintRecord & { repo_url?: string | null }).repo_url ?? null,
      repo_access_mode: (existing as SprintRecord & { repo_access_mode?: string | null }).repo_access_mode ?? null,
    },
    {
      name: newValues.name,
      goal: newValues.goal,
      sprint_type: newValues.sprint_type,
      status: newValues.status,
      length_kind: newValues.length_kind,
      length_value: newValues.length_value,
      project_id: newValues.project_id,
      repo_path: newValues.repo_path,
      repo_url: newValues.repo_url,
      repo_access_mode: newValues.repo_access_mode,
    },
  );
  if (Object.keys(changes).length > 0) {
    await writeProjectAudit(db, newValues.project_id, 'sprint', sprintId, 'updated', actor, changes);
  }

  const routingJoinPredicate = await sprintRoutingJoinPredicate(db);
  return await db.get(`
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
    GROUP BY s.id, p.name
  `, sprintId);
}

export async function deleteSprint(db: Db, sprintId: number, actor: string, tenantId?: number) {
  const hasSprintTenantId = await tableHasColumn(db, 'sprints', 'tenant_id');
  const hasProjectTenantId = await tableHasColumn(db, 'projects', 'tenant_id');
  const tenantJoin = tenantId && !hasSprintTenantId && hasProjectTenantId
    ? 'LEFT JOIN projects p ON p.id = s.project_id'
    : '';
  const tenantPredicate = tenantId && hasSprintTenantId
    ? ' AND s.tenant_id = ?'
    : tenantId && hasProjectTenantId
      ? ' AND p.tenant_id = ?'
      : '';
  const params = tenantPredicate ? [sprintId, tenantId] : [sprintId];
  const sprint = await db.get(`
    SELECT s.*
    FROM sprints s
    ${tenantJoin}
    WHERE s.id = ?${tenantPredicate}
  `, ...params) as SprintRecord | undefined;
  if (!sprint) throw Object.assign(new Error('Sprint not found'), { status: 404 });

  db.transaction(async () => {
    await writeProjectAudit(db, sprint.project_id, 'sprint', sprintId, 'deleted', actor, {
            name: sprint.name,
            status: sprint.status,
          });
    await db.run('DELETE FROM tasks WHERE sprint_id = ?', sprintId);
    await db.run('DELETE FROM sprints WHERE id = ?', sprintId);
  })();
  return { ok: true };
}

export async function closeSprint(db: Db, sprintId: number, actor: string) {
  const sprint = await db.get('SELECT * FROM sprints WHERE id = ?', sprintId) as SprintRecord | undefined;
  if (!sprint) throw Object.assign(new Error('Sprint not found'), { status: 404 });
  if (sprint.status === 'closed') {
    return await db.get('SELECT * FROM sprints WHERE id = ?', sprintId);
  }

  const oldStatus = sprint.status;
  await db.run(`
    UPDATE sprints SET status = 'closed', ended_at = COALESCE(ended_at, datetime('now')) WHERE id = ?
  `, sprintId);

  await writeProjectAudit(db, sprint.project_id, 'sprint', sprintId, 'updated', actor, {
        status: { old: oldStatus, new: 'closed' },
      });

  await insertRuntimeLog(db, {
        projectId: sprint.project_id,
        jobTitle: `Sprint: ${sprint.name}`,
        level: 'info',
        message: `Sprint "${sprint.name}" (id=${sprintId}) closed manually.`,
      });

  console.log(`[sprints] Sprint ${sprintId} "${sprint.name}" closed.`);
  return await db.get('SELECT * FROM sprints WHERE id = ?', sprintId);
}

export async function completeSprintRoute(db: Db, sprintId: number) {
  const sprint = await db.get('SELECT id FROM sprints WHERE id = ?', sprintId);
  if (!sprint) throw Object.assign(new Error('Sprint not found'), { status: 404 });
  await completeSprint(sprintId);
  return await db.get('SELECT * FROM sprints WHERE id = ?', sprintId);
}

export async function attachSprintJob(db: Db, sprintId: number, jobId?: number) {
  const sprint = await db.get('SELECT id FROM sprints WHERE id = ?', sprintId);
  if (!sprint) throw Object.assign(new Error('Sprint not found'), { status: 404 });
  if (!jobId) throw Object.assign(new Error('job_id is required'), { status: 400 });

  const job = await db.get('SELECT id FROM agents WHERE id = ?', jobId);
  if (!job) throw Object.assign(new Error('Agent/job not found'), { status: 404 });

  throw Object.assign(
    new Error('Sprint-scoped agents are deprecated. Configure sprint-specific dispatch with sprint_task_routing_rules instead.'),
    { status: 410 },
  );
}

export async function detachSprintJob(db: Db, sprintId: number, jobId: number) {
  const sprint = await db.get('SELECT id FROM sprints WHERE id = ?', sprintId);
  if (!sprint) throw Object.assign(new Error('Sprint not found'), { status: 404 });
  const job = await db.get('SELECT id FROM agents WHERE id = ?', jobId);
  if (!job) throw Object.assign(new Error('Agent/job not found'), { status: 404 });

  throw Object.assign(
    new Error('Sprint-scoped agents are deprecated. Remove or update sprint_task_routing_rules instead.'),
    { status: 410 },
  );
}
