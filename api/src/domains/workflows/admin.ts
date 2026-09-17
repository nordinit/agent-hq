import { normalizeEnvironmentSetup } from '../../lib/environmentSetup';
import { writeProjectAudit, diffFields } from '../../lib/projectAudit';
import { insertRuntimeLog } from '../../lib/runtimeTenantScope';
import { normalizeRepoConfig, validateRepoConfig } from '../../lib/repoConfig';
import { toCanonicalTimestamp } from '../../lib/timestamps';
import {
  completeWorkflow,
  normalizeWorkflowStatus,
  resolveWorkflowTypeOrNull,
  workflowTypeExists,
} from './lifecycle';
import type { WorkflowRecord } from './readModel';
import { type Db } from "../../db/adapter/types";
import { tableExists as sharedTableExists, columnExists as sharedColumnExists, tableColumns as sharedTableColumns, indexExists as sharedIndexExists } from "../../db/introspection";

interface WorkflowCloneSource {
  id: number;
  project_id: number;
  name: string;
  workflow_type: string;
  environment_setup?: unknown;
}

type CreateWorkflowInput = Partial<WorkflowRecord> & {
  source_workflow_id?: unknown;
  tenant_id?: unknown;
};

const ALLOWED_UPDATE_FIELDS = new Set([
  'project_id',
  'name',
  'goal',
  'workflow_type',
  'status',
  'length_kind',
  'length_value',
  'started_at',
  'ended_at',
  'repo_access_mode',
  'repo_path',
  'repo_url',
  'environment_setup',
  // Audit-only: recorded as the reason for the change, never written to a workflows column.
  // Lets an MCP client say why it paused or resumed a workflow without a second call.
  'note',
]);

async function tableExists(db: Db, table: string): Promise<boolean> {
    return await sharedTableExists(db, table);
}

async function listTableColumns(db: Db, table: string): Promise<string[]> {
  if (!await tableExists(db, table)) return [];
  try {
    return await sharedTableColumns(db, `${table}`);
  } catch {
    return [];
  }
}

async function tableHasColumn(db: Db, table: string, column: string): Promise<boolean> {
    return await sharedColumnExists(db, table, column);
}

async function workflowRoutingJoinPredicate(db: Db): Promise<string> {
  return await tableHasColumn(db, 'workflow_task_routing_rules', 'project_id')
    && await tableHasColumn(db, 'workflow_task_routing_rules', 'workflow_type')
    ? `rr.workflow_id = s.id
      OR (
        rr.project_id = s.project_id
        AND rr.workflow_type = s.workflow_type
        AND rr.workflow_id IS NULL
      )`
    : `rr.workflow_id = s.id`;
}

async function cloneWorkflowScopedRows(
  db: Db,
  table: string,
  sourceWorkflowId: number,
  targetProjectId: number,
  targetWorkflowId: number,
  targetTenantId: number | null,
): Promise<number> {
  const columns = (await listTableColumns(db, table)).filter((column) => column !== 'id');
  if (!columns.includes('workflow_id')) return 0;

  const sourceRows = await db.all(`
    SELECT *
    FROM ${table}
    WHERE workflow_id = ?
    ORDER BY id ASC
  `, sourceWorkflowId) as Array<Record<string, unknown>>;

  if (sourceRows.length === 0) return 0;

  await db.run(`DELETE FROM ${table} WHERE workflow_id = ?`, targetWorkflowId);

  const insertSql = `
    INSERT INTO ${table} (${columns.join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})
  `;

  for (const row of sourceRows) {
    await db.run(insertSql, ...columns.map((column) => {
      if (column === 'tenant_id') return targetTenantId;
      if (column === 'project_id') return targetProjectId;
      if (column === 'workflow_id') return targetWorkflowId;
      return row[column] ?? null;
    }));
  }

  return sourceRows.length;
}

async function cloneWorkflowScopedModelRoutingRules(
  db: Db,
  sourceWorkflowId: number,
  targetProjectId: number,
  targetWorkflowId: number,
  targetTenantId: number | null,
): Promise<number> {
  const columns = (await listTableColumns(db, 'story_point_model_routing')).filter((column) => column !== 'id');
  if (!columns.includes('project_id') || !columns.includes('workflow_id')) return 0;

  const sourceRows = await db.all(`
    SELECT *
    FROM story_point_model_routing
    WHERE workflow_id = ?
    ORDER BY id ASC
  `, sourceWorkflowId) as Array<Record<string, unknown>>;

  if (sourceRows.length === 0) return 0;

  const insertSql = `
    INSERT INTO story_point_model_routing (${columns.join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})
  `;

  for (const row of sourceRows) {
    await db.run(insertSql, ...columns.map((column) => {
      if (column === 'tenant_id') return targetTenantId;
      if (column === 'project_id') return targetProjectId;
      if (column === 'workflow_id') return targetWorkflowId;
      return row[column] ?? null;
    }));
  }

  return sourceRows.length;
}

async function cloneWorkflowSetup(
  db: Db,
  sourceWorkflowId: number,
  targetProjectId: number,
  targetWorkflowId: number,
  targetTenantId: number | null,
): Promise<void> {
  await cloneWorkflowScopedRows(db, 'workflow_task_statuses', sourceWorkflowId, targetProjectId, targetWorkflowId, targetTenantId);
  await cloneWorkflowScopedRows(db, 'workflow_task_transitions', sourceWorkflowId, targetProjectId, targetWorkflowId, targetTenantId);
  await cloneWorkflowScopedRows(db, 'workflow_task_transition_requirements', sourceWorkflowId, targetProjectId, targetWorkflowId, targetTenantId);
  await cloneWorkflowScopedRows(db, 'workflow_task_routing_rules', sourceWorkflowId, targetProjectId, targetWorkflowId, targetTenantId);
  await cloneWorkflowScopedModelRoutingRules(db, sourceWorkflowId, targetProjectId, targetWorkflowId, targetTenantId);
}

async function getWorkflowCloneSourceOrThrow(
  db: Db,
  sourceWorkflowIdRaw: unknown,
  projectId: number,
  tenantId?: number | null,
): Promise<WorkflowCloneSource | null> {
  if (sourceWorkflowIdRaw === undefined || sourceWorkflowIdRaw === null || sourceWorkflowIdRaw === '') return null;

  const sourceWorkflowId = Number(sourceWorkflowIdRaw);
  if (!Number.isInteger(sourceWorkflowId) || sourceWorkflowId <= 0) {
    throw Object.assign(new Error('source_workflow_id must be a positive integer'), { status: 400 });
  }

  const hasWorkflowTenantId = await tableHasColumn(db, 'workflows', 'tenant_id');
  const sourceWorkflow = await db.get(`
    SELECT id, project_id, name, workflow_type, environment_setup
    FROM workflows
    WHERE id = ?
      ${hasWorkflowTenantId && tenantId != null ? 'AND tenant_id = ?' : ''}
    LIMIT 1
  `, ...(hasWorkflowTenantId && tenantId != null ? [sourceWorkflowId, tenantId] : [sourceWorkflowId])) as WorkflowCloneSource | undefined;

  if (!sourceWorkflow) {
    throw Object.assign(new Error(`Source workflow ${sourceWorkflowId} not found`), { status: 404 });
  }

  if (sourceWorkflow.project_id !== projectId) {
    throw Object.assign(new Error(`source_workflow_id must belong to project ${projectId}`), { status: 400 });
  }

  return sourceWorkflow;
}

export async function createWorkflow(
  db: Db,
  body: CreateWorkflowInput,
  actor: string,
) {
  const {
    project_id,
    name,
    goal = '',
    workflow_type,
    source_workflow_id,
    status = 'planning',
    length_kind = 'time',
    length_value = '',
    started_at,
    repo_access_mode,
    repo_path,
    repo_url,
    environment_setup,
  } = body;
  const tenantId = Number.isFinite(Number(body.tenant_id)) ? Number(body.tenant_id) : null;

  if (!project_id) throw Object.assign(new Error('project_id is required'), { status: 400 });
  if (!name) throw Object.assign(new Error('name is required'), { status: 400 });

  const hasProjectTenantId = await tableHasColumn(db, 'projects', 'tenant_id');
  const project = await db.get(`SELECT id${hasProjectTenantId ? ', tenant_id' : ''} FROM projects WHERE id = ?${hasProjectTenantId && tenantId != null ? ' AND tenant_id = ?' : ''}`, ...(hasProjectTenantId && tenantId != null ? [project_id, tenantId] : [project_id])) as { id: number; tenant_id?: number | null } | undefined;
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const sourceWorkflow = await getWorkflowCloneSourceOrThrow(db, source_workflow_id, Number(project_id), tenantId);
  const requestedWorkflowType = resolveWorkflowTypeOrNull(workflow_type);
  if (sourceWorkflow && requestedWorkflowType && requestedWorkflowType !== sourceWorkflow.workflow_type) {
    throw Object.assign(
      new Error(`workflow_type must match source workflow type "${sourceWorkflow.workflow_type}" when source_workflow_id is provided`),
      { status: 400 },
    );
  }

  const resolvedWorkflowType = sourceWorkflow?.workflow_type ?? requestedWorkflowType ?? 'generic';
  if (!await workflowTypeExists(db, resolvedWorkflowType)) {
    throw Object.assign(new Error(`Unknown workflow_type "${resolvedWorkflowType}"`), { status: 400 });
  }

  const normalizedStatus = normalizeWorkflowStatus(status);
  const repoValidationError = validateRepoConfig({ repo_access_mode, repo_path, repo_url });
  if (repoValidationError) {
    throw Object.assign(new Error(repoValidationError), { status: 400 });
  }
  const repoConfig = normalizeRepoConfig({ repo_access_mode, repo_path, repo_url });
  const environmentSetup = normalizeEnvironmentSetup(environment_setup === undefined ? sourceWorkflow?.environment_setup : environment_setup);
  let newId = 0;

  await db.withTransaction(async (db) => {
    const hasWorkflowTenantId = await tableHasColumn(db, 'workflows', 'tenant_id');
    const result = hasWorkflowTenantId
      ? await db.run(`
          INSERT INTO workflows (tenant_id, project_id, name, goal, workflow_type, status, length_kind, length_value, started_at, repo_path, repo_url, repo_access_mode, environment_setup)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, project.tenant_id ?? tenantId, project_id, name, goal, resolvedWorkflowType, normalizedStatus, length_kind, length_value, toCanonicalTimestamp(started_at), repoConfig.repo_path, repoConfig.repo_url, repoConfig.repo_access_mode, JSON.stringify(environmentSetup))
      : await db.run(`
          INSERT INTO workflows (project_id, name, goal, workflow_type, status, length_kind, length_value, started_at, repo_path, repo_url, repo_access_mode, environment_setup)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, project_id, name, goal, resolvedWorkflowType, normalizedStatus, length_kind, length_value, toCanonicalTimestamp(started_at), repoConfig.repo_path, repoConfig.repo_url, repoConfig.repo_access_mode, JSON.stringify(environmentSetup));

    newId = Number(result.lastInsertId);

    if (sourceWorkflow) {
      await cloneWorkflowSetup(db, sourceWorkflow.id, Number(project_id), newId, project.tenant_id ?? null);
    }
  });

  await writeProjectAudit(db, project_id, 'workflow', newId, 'created', actor, {
        name,
        goal,
        workflow_type: resolvedWorkflowType,
        source_workflow_id: sourceWorkflow?.id ?? null,
        cloned_setup: Boolean(sourceWorkflow),
        status: normalizedStatus,
        length_kind,
        length_value,
        repo_access_mode: repoConfig.repo_access_mode,
        repo_path: repoConfig.repo_path,
        repo_url: repoConfig.repo_url,
        environment_setup: environmentSetup,
      });

  return await db.get(`
    SELECT s.*, s.id AS workflow_id, p.name as project_name,
      0 as agent_count, 0 as task_count, 0 as tasks_done,
      0 as total_story_points, 0 as done_story_points, 0 as remaining_story_points
    FROM workflows s
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE s.id = ?
  `, newId);
}

export async function updateWorkflow(
  db: Db,
  workflowId: number,
  body: Record<string, unknown>,
  actor: string,
) {
  const existing = await db.get('SELECT * FROM workflows WHERE id = ?', workflowId) as WorkflowRecord | undefined;
  if (!existing) throw Object.assign(new Error('Workflow not found'), { status: 404 });

  const unsupportedFields = Object.keys(body).filter((key) => !ALLOWED_UPDATE_FIELDS.has(key));
  if (unsupportedFields.length > 0) {
    const error = new Error(`Unsupported workflow update field(s): ${unsupportedFields.join(', ')}`) as Error & {
      status?: number;
      body?: Record<string, unknown>;
    };
    error.status = 400;
    error.body = {
      error: error.message,
      code: 'unsupported_workflow_update_fields',
      unsupported_fields: unsupportedFields,
      allowed_fields: Array.from(ALLOWED_UPDATE_FIELDS),
    };
    throw error;
  }

  const {
    project_id,
    name,
    goal,
    workflow_type,
    status,
    length_kind,
    length_value,
    started_at,
    ended_at,
    repo_access_mode,
    repo_path,
    repo_url,
    environment_setup,
  } = body as Partial<WorkflowRecord>;

  const resolvedWorkflowType = workflow_type !== undefined
    ? resolveWorkflowTypeOrNull(workflow_type)
    : existing.workflow_type;

  if (!resolvedWorkflowType) {
    throw Object.assign(new Error('workflow_type cannot be empty'), { status: 400 });
  }
  if (!await workflowTypeExists(db, resolvedWorkflowType)) {
    throw Object.assign(new Error(`Unknown workflow_type "${resolvedWorkflowType}"`), { status: 400 });
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
        repo_path: (existing as WorkflowRecord & { repo_path?: string | null }).repo_path ?? null,
        repo_url: (existing as WorkflowRecord & { repo_url?: string | null }).repo_url ?? null,
        repo_access_mode: (existing as WorkflowRecord & { repo_access_mode?: 'worktree' | 'clone' | null }).repo_access_mode ?? null,
      };

  const environmentSetup = normalizeEnvironmentSetup(environment_setup === undefined ? existing.environment_setup : environment_setup);
  const newValues = {
    project_id: requestedProjectId,
    name: name ?? existing.name,
    goal: goal !== undefined ? goal : existing.goal,
    workflow_type: resolvedWorkflowType,
    status: status !== undefined ? normalizeWorkflowStatus(status) : existing.status,
    length_kind: length_kind ?? existing.length_kind,
    length_value: length_value !== undefined ? length_value : existing.length_value,
    // API callers send anything from '2026-03-09' to '2026-07-06T11:55:00-04:00';
    // normalize so workflows.started_at / ended_at only hold canonical UTC.
    started_at: started_at !== undefined ? toCanonicalTimestamp(started_at) : existing.started_at,
    ended_at: ended_at !== undefined ? toCanonicalTimestamp(ended_at) : existing.ended_at,
    repo_path: repoConfig.repo_path,
    repo_url: repoConfig.repo_url,
    repo_access_mode: repoConfig.repo_access_mode,
    environment_setup: environmentSetup,
  };

  await db.run(`
    UPDATE workflows SET
      project_id = ?,
      name = ?,
      goal = ?,
      workflow_type = ?,
      status = ?,
      length_kind = ?,
      length_value = ?,
      started_at = ?,
      ended_at = ?,
      repo_path = ?,
      repo_url = ?,
      repo_access_mode = ?,
      environment_setup = ?
    WHERE id = ?
  `, newValues.project_id, newValues.name, newValues.goal, newValues.workflow_type, newValues.status, newValues.length_kind, newValues.length_value, newValues.started_at, newValues.ended_at, newValues.repo_path, newValues.repo_url, newValues.repo_access_mode, JSON.stringify(newValues.environment_setup), workflowId);

  const changes = diffFields(
    {
      name: existing.name,
      goal: existing.goal,
      workflow_type: existing.workflow_type,
      status: existing.status,
      length_kind: existing.length_kind,
      length_value: existing.length_value,
      project_id: existing.project_id,
      repo_path: (existing as WorkflowRecord & { repo_path?: string | null }).repo_path ?? null,
      repo_url: (existing as WorkflowRecord & { repo_url?: string | null }).repo_url ?? null,
      repo_access_mode: (existing as WorkflowRecord & { repo_access_mode?: string | null }).repo_access_mode ?? null,
    },
    {
      name: newValues.name,
      goal: newValues.goal,
      workflow_type: newValues.workflow_type,
      status: newValues.status,
      length_kind: newValues.length_kind,
      length_value: newValues.length_value,
      project_id: newValues.project_id,
      repo_path: newValues.repo_path,
      repo_url: newValues.repo_url,
      repo_access_mode: newValues.repo_access_mode,
    },
  );
  const oldEnvironmentSetup = normalizeEnvironmentSetup(existing.environment_setup);
  if (JSON.stringify(oldEnvironmentSetup) !== JSON.stringify(environmentSetup)) {
    changes.environment_setup = { old: oldEnvironmentSetup, new: environmentSetup };
  }
  if (Object.keys(changes).length > 0) {
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
    await writeProjectAudit(db, newValues.project_id, 'workflow', workflowId, 'updated', actor, {
      ...changes,
      ...(note ? { note } : {}),
    });
  }

  const routingJoinPredicate = await workflowRoutingJoinPredicate(db);
  return await db.get(`
    SELECT s.*, s.id AS workflow_id,
      p.name as project_name,
      COUNT(DISTINCT rr.agent_id) as agent_count,
      COUNT(DISTINCT t.id) as task_count,
      COUNT(DISTINCT CASE WHEN t.status = 'done' THEN t.id END) as tasks_done,
      COALESCE(SUM(COALESCE(t.story_points, 0)), 0) as total_story_points,
      COALESCE(SUM(CASE WHEN t.status = 'done' THEN COALESCE(t.story_points, 0) ELSE 0 END), 0) as done_story_points,
      COALESCE(SUM(CASE WHEN t.status != 'done' THEN COALESCE(t.story_points, 0) ELSE 0 END), 0) as remaining_story_points
    FROM workflows s
    LEFT JOIN projects p ON p.id = s.project_id
    LEFT JOIN workflow_task_routing_rules rr
      ON ${routingJoinPredicate}
    LEFT JOIN tasks t ON t.workflow_id = s.id
    WHERE s.id = ?
    GROUP BY s.id, p.name
  `, workflowId);
}

export async function deleteWorkflow(db: Db, workflowId: number, actor: string, tenantId?: number) {
  const hasWorkflowTenantId = await tableHasColumn(db, 'workflows', 'tenant_id');
  const hasProjectTenantId = await tableHasColumn(db, 'projects', 'tenant_id');
  const tenantJoin = tenantId && !hasWorkflowTenantId && hasProjectTenantId
    ? 'LEFT JOIN projects p ON p.id = s.project_id'
    : '';
  const tenantPredicate = tenantId && hasWorkflowTenantId
    ? ' AND s.tenant_id = ?'
    : tenantId && hasProjectTenantId
      ? ' AND p.tenant_id = ?'
      : '';
  const params = tenantPredicate ? [workflowId, tenantId] : [workflowId];
  const workflow = await db.get(`
    SELECT s.*
    FROM workflows s
    ${tenantJoin}
    WHERE s.id = ?${tenantPredicate}
  `, ...params) as WorkflowRecord | undefined;
  if (!workflow) throw Object.assign(new Error('Workflow not found'), { status: 404 });

  await db.withTransaction(async (db) => {
    await writeProjectAudit(db, workflow.project_id, 'workflow', workflowId, 'deleted', actor, {
            name: workflow.name,
            status: workflow.status,
          });
    await db.run('DELETE FROM tasks WHERE workflow_id = ?', workflowId);
    await db.run('DELETE FROM workflows WHERE id = ?', workflowId);
  });
  return { ok: true };
}

export async function closeWorkflow(db: Db, workflowId: number, actor: string, note?: string) {
  const workflow = await db.get('SELECT * FROM workflows WHERE id = ?', workflowId) as WorkflowRecord | undefined;
  if (!workflow) throw Object.assign(new Error('Workflow not found'), { status: 404 });
  if (workflow.status === 'closed') {
    return await db.get('SELECT *, id AS workflow_id FROM workflows WHERE id = ?', workflowId);
  }

  const oldStatus = workflow.status;
  await db.run(`
    UPDATE workflows SET status = 'closed', ended_at = COALESCE(ended_at, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')) WHERE id = ?
  `, workflowId);

  await writeProjectAudit(db, workflow.project_id, 'workflow', workflowId, 'updated', actor, {
        status: { old: oldStatus, new: 'closed' },
        ...(note ? { note } : {}),
      });

  await insertRuntimeLog(db, {
        projectId: workflow.project_id,
        jobTitle: `Workflow: ${workflow.name}`,
        level: 'info',
        message: `Workflow "${workflow.name}" (id=${workflowId}) closed manually.`,
      });

  console.log(`[workflows] Workflow ${workflowId} "${workflow.name}" closed.`);
  return await db.get('SELECT *, id AS workflow_id FROM workflows WHERE id = ?', workflowId);
}

export async function completeWorkflowRoute(db: Db, workflowId: number, actor = 'api', note?: string) {
  const workflow = await db.get('SELECT id FROM workflows WHERE id = ?', workflowId);
  if (!workflow) throw Object.assign(new Error('Workflow not found'), { status: 404 });
  await completeWorkflow(workflowId, actor, note);
  return await db.get('SELECT *, id AS workflow_id FROM workflows WHERE id = ?', workflowId);
}

export async function attachWorkflowJob(db: Db, workflowId: number, jobId?: number) {
  const workflow = await db.get('SELECT id FROM workflows WHERE id = ?', workflowId);
  if (!workflow) throw Object.assign(new Error('Workflow not found'), { status: 404 });
  if (!jobId) throw Object.assign(new Error('job_id is required'), { status: 400 });

  const job = await db.get('SELECT id FROM agents WHERE id = ?', jobId);
  if (!job) throw Object.assign(new Error('Agent/job not found'), { status: 404 });

  throw Object.assign(
    new Error('Workflow-scoped agents are deprecated. Configure workflow-specific dispatch with workflow_task_routing_rules instead.'),
    { status: 410 },
  );
}

export async function detachWorkflowJob(db: Db, workflowId: number, jobId: number) {
  const workflow = await db.get('SELECT id FROM workflows WHERE id = ?', workflowId);
  if (!workflow) throw Object.assign(new Error('Workflow not found'), { status: 404 });
  const job = await db.get('SELECT id FROM agents WHERE id = ?', jobId);
  if (!job) throw Object.assign(new Error('Agent/job not found'), { status: 404 });

  throw Object.assign(
    new Error('Workflow-scoped agents are deprecated. Remove or update workflow_task_routing_rules instead.'),
    { status: 410 },
  );
}
