import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { writeProjectAudit, diffFields, extractActor } from '../lib/projectAudit';
import { normalizeRepoConfig, validateRepoConfig } from '../lib/repoConfig';
import { ensureProjectBacklogSprint, syncStarterRoutingForProject } from '../lib/starterSetup';
import { ensureDefaultProjectId, setDefaultProjectId } from '../lib/defaultProject';
import {
  requireTenantOwnedRow,
  resolveTenantIdFromRequest,
  runTenantScopedDelete,
  runTenantScopedInsert,
  runTenantScopedUpdate,
  tenantScopedParams,
  tenantScopedWhere,
} from '../lib/tenantContext';
import {
  exportProjectManifest,
  importProjectManifest,
  manifestJson,
  validateProjectManifest,
} from '../lib/projectPortability';

const router = Router();

function routeErrorStatus(err: unknown): number {
  const status = typeof err === 'object' && err && 'status' in err ? Number((err as { status?: number }).status) : 500;
  return Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
}

function routeErrorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
    ? (err as { code: string }).code
    : undefined;
}

function routeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendRouteError(res: Response, err: unknown): Response {
  const code = routeErrorCode(err);
  return res.status(routeErrorStatus(err)).json({
    error: routeErrorMessage(err),
    ...(code ? { code } : {}),
  });
}

interface Project {
  id: number;
  name: string;
  description: string;
  context_md: string;
  repo_path: string | null;
  repo_url: string | null;
  repo_access_mode: 'worktree' | 'clone' | null;
  created_at: string;
  is_default?: number;
}

function projectSelectSql(whereClause = ''): string {
  return `
    SELECT p.*,
      COUNT(a.id) as agent_count,
      CASE WHEN p.id = CAST((SELECT value FROM app_settings WHERE key = 'default_project_id') AS INTEGER)
        THEN 1 ELSE 0 END as is_default
    FROM projects p
    LEFT JOIN agents a ON a.project_id = p.id
    ${whereClause}
    GROUP BY p.id
  `;
}

function projectSelectSqlForTenant(whereClause = ''): string {
  return projectSelectSql(tenantScopedWhere({ alias: 'p', where: whereClause.replace(/^WHERE\s+/i, '') }));
}

function requireProjectForTenant(db: ReturnType<typeof getDb>, projectId: number | string, tenantId: number): void {
  requireTenantOwnedRow(db, 'projects', projectId, tenantId, { notFoundMessage: 'Project not found' });
}

function projectExistsForTenant(db: ReturnType<typeof getDb>, projectId: number | string, tenantId: number): boolean {
  try {
    requireProjectForTenant(db, projectId, tenantId);
    return true;
  } catch (err) {
    if ((err as Error & { status?: number }).status === 404) return false;
    throw err;
  }
}

// GET /api/v1/projects
router.get('/', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, _req);
    ensureDefaultProjectId(db);
    const projects = db.prepare(`
      ${projectSelectSqlForTenant()}
      ORDER BY p.created_at DESC
    `).all(tenantId);
    res.json(projects);
  } catch (err) {
    return sendRouteError(res, err);
  }
});

// POST /api/v1/projects
router.post('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const { name, description, context_md, repo_path, repo_url, repo_access_mode } = req.body as Partial<Project>;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const repoError = validateRepoConfig({ repo_path, repo_url, repo_access_mode });
    if (repoError) {
      return res.status(400).json({ error: repoError });
    }
    const repoConfig = normalizeRepoConfig({ repo_path, repo_url, repo_access_mode });

    const result = runTenantScopedInsert(db, {
      table: 'projects',
      tenantId,
      values: {
        name,
        description: description ?? '',
        context_md: context_md ?? '',
        repo_path: repoConfig.repo_path,
        repo_url: repoConfig.repo_url,
        repo_access_mode: repoConfig.repo_access_mode,
      },
    });

    const newId = Number(result.lastInsertRowid);
    ensureProjectBacklogSprint(db, newId);
    syncStarterRoutingForProject(db, newId);
    ensureDefaultProjectId(db);
    const actor = extractActor(req);
    writeProjectAudit(db, newId, 'project', newId, 'created', actor, {
      name,
      description: description ?? '',
      context_md: context_md ?? '',
      repo_path: repoConfig.repo_path,
      repo_url: repoConfig.repo_url,
      repo_access_mode: repoConfig.repo_access_mode,
    });

    const project = db.prepare(projectSelectSqlForTenant('WHERE p.id = ?')).get(newId, tenantId);
    return res.status(201).json(project);
  } catch (err) {
    return sendRouteError(res, err);
  }
});

// GET /api/v1/projects/default
router.get('/default', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, _req);
    const defaultProjectId = ensureDefaultProjectId(db);
    if (!defaultProjectId) return res.json({ project: null, default_project_id: null });

    const project = db.prepare(projectSelectSqlForTenant('WHERE p.id = ?')).get(defaultProjectId, tenantId);
    return res.json({ project, default_project_id: defaultProjectId });
  } catch (err) {
    return sendRouteError(res, err);
  }
});

// PUT /api/v1/projects/:id/default
router.put('/:id/default', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ error: 'Project id must be a positive integer' });
    }

    if (!projectExistsForTenant(db, projectId, tenantId)) return res.status(404).json({ error: 'Project not found' });
    setDefaultProjectId(db, projectId);
    const actor = extractActor(req);
    writeProjectAudit(db, projectId, 'project', projectId, 'updated', actor, { default_project: true });

    const selectedProject = db.prepare(projectSelectSqlForTenant('WHERE p.id = ?')).get(projectId, tenantId);
    return res.json({ ok: true, project: selectedProject, default_project_id: projectId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message === 'Project not found' ? res.status(404).json({ error: message }) : sendRouteError(res, err);
  }
});

// GET /api/v1/projects/:id/export?include_files=true
router.get('/:id/export', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ error: 'Project id must be a positive integer' });
    }
    const project = db.prepare(`SELECT id, name FROM projects ${tenantScopedWhere({ where: 'id = ?' })}`).get(...tenantScopedParams(tenantId, [projectId])) as { id: number; name: string } | undefined;
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const includeFiles = req.query.include_files === 'true';
    const { manifest, warnings } = exportProjectManifest(db, projectId, includeFiles);
    const filename = `${project.name.replace(/[^a-zA-Z0-9_.-]/g, '_') || 'project'}-manifest-v1.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (warnings.length > 0) res.setHeader('X-Agent-HQ-Export-Warnings', String(warnings.length));
    return res.send(manifestJson(manifest));
  } catch (err) {
    return sendRouteError(res, err);
  }
});

// POST /api/v1/projects/import/preview
router.post('/import/preview', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const manifest = (req.body as { manifest?: unknown }).manifest ?? req.body;
    const preview = validateProjectManifest(db, manifest, {
      projectName: typeof req.body?.project_name === 'string' ? req.body.project_name : undefined,
      importFiles: Boolean(req.body?.include_files),
    });
    return res.status(preview.valid ? 200 : 400).json(preview);
  } catch (err) {
    return sendRouteError(res, err);
  }
});

// POST /api/v1/projects/import
router.post('/import', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const manifest = (req.body as { manifest?: unknown }).manifest ?? req.body;
    const actor = extractActor(req);
    const result = importProjectManifest(db, manifest, {
      projectName: typeof req.body?.project_name === 'string' ? req.body.project_name : undefined,
      enableAgents: Boolean(req.body?.enable_agents),
      activateWorkflows: Boolean(req.body?.activate_workflows),
      importFiles: Boolean(req.body?.include_files),
      tenantId,
      actor,
    });
    const project = db.prepare(projectSelectSqlForTenant('WHERE p.id = ?')).get(result.project_id, tenantId);
    return res.status(201).json({ ok: true, project, ...result });
  } catch (err) {
    const withPreview = err as { status?: number; preview?: unknown; message?: string };
    return res.status(withPreview.status ?? 500).json({
      error: err instanceof Error ? err.message : String(err),
      preview: withPreview.preview,
    });
  }
});

// GET /api/v1/projects/:id
router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    ensureDefaultProjectId(db);
    const project = db.prepare(projectSelectSqlForTenant('WHERE p.id = ?')).get(req.params.id, tenantId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    return res.json(project);
  } catch (err) {
    return sendRouteError(res, err);
  }
});

// PUT /api/v1/projects/:id
router.put('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const existing = db.prepare(`SELECT * FROM projects ${tenantScopedWhere({ where: 'id = ?' })}`).get(...tenantScopedParams(tenantId, [req.params.id])) as Project | undefined;
    if (!existing) return res.status(404).json({ error: 'Project not found' });

    const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
    const allowedFields = new Set(['name', 'description', 'context_md', 'repo_path', 'repo_url', 'repo_access_mode']);
    const unsupportedFields = Object.keys(body).filter((key) => !allowedFields.has(key));
    if (unsupportedFields.length > 0) {
      return res.status(400).json({
        error: `Unsupported project update field(s): ${unsupportedFields.join(', ')}`,
        code: 'unsupported_project_update_fields',
        unsupported_fields: unsupportedFields,
        allowed_fields: Array.from(allowedFields),
      });
    }

    const { name, description, context_md, repo_path, repo_url, repo_access_mode } = body as Partial<Project>;

    const repoConfig = normalizeRepoConfig({
      repo_path: repo_path !== undefined ? repo_path : existing.repo_path,
      repo_url: repo_url !== undefined ? repo_url : existing.repo_url,
      repo_access_mode: repo_access_mode !== undefined ? repo_access_mode : existing.repo_access_mode,
    });
    const repoError = validateRepoConfig(repoConfig);
    if (repoError) {
      return res.status(400).json({ error: repoError });
    }

    const newValues = {
      name: name ?? existing.name,
      description: description !== undefined ? description : existing.description,
      context_md: context_md !== undefined ? context_md : existing.context_md,
      repo_path: repoConfig.repo_path,
      repo_url: repoConfig.repo_url,
      repo_access_mode: repoConfig.repo_access_mode,
    };

    runTenantScopedUpdate(db, {
      table: 'projects',
      id: req.params.id,
      tenantId,
      values: newValues,
    });

    const changes = diffFields(
      {
        name: existing.name,
        description: existing.description,
        context_md: existing.context_md,
        repo_path: existing.repo_path,
        repo_url: existing.repo_url,
        repo_access_mode: existing.repo_access_mode,
      },
      newValues,
    );
    if (Object.keys(changes).length > 0) {
      const actor = extractActor(req);
      writeProjectAudit(db, existing.id, 'project', existing.id, 'updated', actor, changes);
    }

    ensureDefaultProjectId(db);
    const updated = db.prepare(projectSelectSqlForTenant('WHERE p.id = ?')).get(req.params.id, tenantId);
    return res.json(updated);
  } catch (err) {
    return sendRouteError(res, err);
  }
});

// GET /api/v1/projects/:id/cascade-check — check for active work before deleting
router.get('/:id/cascade-check', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    if (!projectExistsForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Project not found' });

    const activeTasksRow = db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE project_id = ? AND tenant_id = ? AND status IN ('in_progress', 'review')
    `).get(req.params.id, tenantId) as { count: number };

    const runningInstancesRow = db.prepare(`
      SELECT COUNT(*) as count FROM job_instances ji
      JOIN agents a ON a.id = ji.agent_id
      WHERE a.project_id = ? AND a.tenant_id = ? AND ji.status IN ('queued', 'dispatched', 'running')
    `).get(req.params.id, tenantId) as { count: number };

    const sprintCountRow = db.prepare(`SELECT COUNT(*) as count FROM sprints WHERE project_id = ? AND tenant_id = ?`).get(req.params.id, tenantId) as { count: number };
    const taskCountRow = db.prepare(`SELECT COUNT(*) as count FROM tasks WHERE project_id = ? AND tenant_id = ?`).get(req.params.id, tenantId) as { count: number };
    const agentCountRow = db.prepare(`SELECT COUNT(*) as count FROM agents WHERE project_id = ? AND tenant_id = ?`).get(req.params.id, tenantId) as { count: number };

    return res.json({
      active_tasks: activeTasksRow.count ?? 0,
      running_instances: runningInstancesRow.count ?? 0,
      dependent_sprints: sprintCountRow.count ?? 0,
      dependent_tasks: taskCountRow.count ?? 0,
      dependent_agents: agentCountRow.count ?? 0,
    });
  } catch (err) {
    return sendRouteError(res, err);
  }
});

// DELETE /api/v1/projects/:id
// Query params: ?force=true to bypass cascade warnings
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const project = db.prepare(`SELECT * FROM projects ${tenantScopedWhere({ where: 'id = ?' })}`).get(...tenantScopedParams(tenantId, [req.params.id])) as Project | undefined;
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const force = req.query.force === 'true';

    const activeTasksRow = db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE project_id = ? AND tenant_id = ? AND status IN ('in_progress', 'review')
    `).get(req.params.id, tenantId) as { count: number };

    const runningInstancesRow = db.prepare(`
      SELECT COUNT(*) as count FROM job_instances ji
      JOIN agents a ON a.id = ji.agent_id
      WHERE a.project_id = ? AND a.tenant_id = ? AND ji.status IN ('queued', 'dispatched', 'running')
    `).get(req.params.id, tenantId) as { count: number };

    const sprintCountRow = db.prepare(`SELECT COUNT(*) as count FROM sprints WHERE project_id = ? AND tenant_id = ?`).get(req.params.id, tenantId) as { count: number };
    const taskCountRow = db.prepare(`SELECT COUNT(*) as count FROM tasks WHERE project_id = ? AND tenant_id = ?`).get(req.params.id, tenantId) as { count: number };
    const agentCountRow = db.prepare(`SELECT COUNT(*) as count FROM agents WHERE project_id = ? AND tenant_id = ?`).get(req.params.id, tenantId) as { count: number };

    const activeTasks = activeTasksRow.count ?? 0;
    const runningInstances = runningInstancesRow.count ?? 0;
    const sprintCount = sprintCountRow.count ?? 0;
    const taskCount = taskCountRow.count ?? 0;
    const agentCount = agentCountRow.count ?? 0;

    if (!force && (activeTasks > 0 || runningInstances > 0 || sprintCount > 0 || taskCount > 0 || agentCount > 0)) {
      return res.status(409).json({
        error: 'Project delete requires confirmation',
        code: 'project_delete_requires_force',
        active_tasks: activeTasks,
        running_instances: runningInstances,
        dependent_sprints: sprintCount,
        dependent_tasks: taskCount,
        dependent_agents: agentCount,
        message: `Project ${req.params.id} still owns ${sprintCount} sprint(s), ${taskCount} task(s), and ${agentCount} agent(s), with ${activeTasks} active task(s) and ${runningInstances} running instance(s). Pass ?force=true to delete this project and its dependents.`,
      });
    }

    const actor = extractActor(req);
    const proj = project as Project;
    writeProjectAudit(db, proj.id, 'project', proj.id, 'deleted', actor, {
      name: proj.name, description: proj.description,
    });

    runTenantScopedDelete(db, { table: 'projects', id: req.params.id, tenantId });
    ensureDefaultProjectId(db);
    return res.json({ ok: true, deleted: true, project_id: Number(req.params.id), forced: force });
  } catch (err) {
    return sendRouteError(res, err);
  }
});

// GET /api/v1/projects/:id/metrics — aggregate metrics across all sprints
router.get('/:id/metrics', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    if (!projectExistsForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Project not found' });

    const taskRow = db.prepare(`
      SELECT
        COUNT(*) as tasks_total,
        COUNT(CASE WHEN t.status = 'done' THEN 1 END) as tasks_done
      FROM tasks t
      WHERE t.project_id = ? AND t.tenant_id = ?
    `).get(Number(req.params.id), tenantId) as { tasks_total: number; tasks_done: number };

    const blockerRow = db.prepare(`
      SELECT COUNT(DISTINCT td.blocked_id) as blocker_count
      FROM task_dependencies td
      JOIN tasks blocked ON blocked.id = td.blocked_id
      JOIN tasks blocker ON blocker.id = td.blocker_id
      WHERE blocked.project_id = ?
        AND blocked.tenant_id = ?
        AND blocker.tenant_id = ?
        AND blocker.status != 'done'
    `).get(Number(req.params.id), tenantId, tenantId) as { blocker_count: number };

    const durationRow = db.prepare(`
      SELECT AVG(
        (strftime('%s', updated_at) - strftime('%s', created_at)) * 1000
      ) as avg_ms
      FROM tasks
      WHERE project_id = ? AND tenant_id = ? AND status = 'done'
    `).get(Number(req.params.id), tenantId) as { avg_ms: number | null };

    const runRow = db.prepare(`
      SELECT
        COUNT(*) as job_runs_total,
        COUNT(CASE WHEN ji.status = 'done' THEN 1 END) as job_runs_success,
        COUNT(CASE WHEN ji.status = 'failed' THEN 1 END) as job_runs_failed
      FROM job_instances ji
      JOIN agents a ON a.id = ji.agent_id
      WHERE a.project_id = ? AND a.tenant_id = ?
    `).get(Number(req.params.id), tenantId) as { job_runs_total: number; job_runs_success: number; job_runs_failed: number };

    const sprintCount = (db.prepare('SELECT COUNT(*) as n FROM sprints WHERE project_id = ? AND tenant_id = ?').get(Number(req.params.id), tenantId) as { n: number }).n;

    const tasks_total = taskRow.tasks_total ?? 0;
    const tasks_done = taskRow.tasks_done ?? 0;
    const completion_rate = tasks_total > 0 ? Math.round((tasks_done / tasks_total) * 100) : 0;
    const job_runs_total = runRow.job_runs_total ?? 0;
    const job_runs_success = runRow.job_runs_success ?? 0;
    const job_runs_failed = runRow.job_runs_failed ?? 0;
    const success_rate = job_runs_total > 0
      ? Math.round((job_runs_success / job_runs_total) * 1000) / 10
      : 0;

    return res.json({
      project_id: Number(req.params.id),
      sprint_count: sprintCount,
      tasks_total,
      tasks_done,
      completion_rate,
      job_runs_total,
      job_runs_success,
      job_runs_failed,
      success_rate,
      blocker_count: blockerRow.blocker_count ?? 0,
      avg_task_duration_ms: Math.round(durationRow.avg_ms ?? 0),
    });
  } catch (err) {
    return sendRouteError(res, err);
  }
});

// GET /api/v1/projects/:id/jobs — list job templates for this project
router.get('/:id/jobs', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    if (!projectExistsForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Project not found' });

    // Read from agents table — agents now have all job-template columns
    const jobs = db.prepare(`
      SELECT a.*, a.name as agent_name, a.session_key as agent_session_key,
             a.job_title as title, p.name as project_name
      FROM agents a
      LEFT JOIN projects p ON p.id = a.project_id
      WHERE a.project_id = ? AND a.tenant_id = ?
      ORDER BY a.created_at DESC
    `).all(req.params.id, tenantId);
    return res.json(jobs);
  } catch (err) {
    return sendRouteError(res, err);
  }
});

// GET /api/v1/projects/:id/audit — project-level audit history
router.get('/:id/audit', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ error: 'Project id must be a positive integer' });
    }
    if (!projectExistsForTenant(db, projectId, tenantId)) return res.status(404).json({ error: 'Project not found' });

    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    const entityType = req.query.entity_type as string | undefined;

    let query = `
      SELECT * FROM project_audit_log
      WHERE project_id = ?
    `;
    const params: unknown[] = [projectId];

    if (entityType && ['project', 'sprint', 'job_template'].includes(entityType)) {
      query += ` AND entity_type = ?`;
      params.push(entityType);
    }

    query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = db.prepare(query).all(...params) as Array<Record<string, unknown>>;

    // Parse the changes JSON for each row
    const entries = rows.map(row => ({
      ...row,
      changes: (() => { try { return JSON.parse(row.changes as string); } catch { return {}; } })(),
    }));

    return res.json(entries);
  } catch (err) {
    return sendRouteError(res, err);
  }
});

export default router;
