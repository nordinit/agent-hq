import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import sprintDefinitionsRouter from '../domains/sprint-definitions/router';
import { extractActor } from '../lib/projectAudit';
import { attachSprintJob, closeSprint, completeSprintRoute, createSprint, deleteSprint, detachSprintJob, updateSprint } from '../domains/sprints/admin';
import { checkSprintCompletion } from '../domains/sprints/lifecycle';
import { getSprintDetail, getSprintMetrics, listSprintJobs, listSprints } from '../domains/sprints/readModel';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';
import { columnExists as sharedColumnExists } from "../db/introspection";
import { parseIdParam } from '../lib/routeParams';

export { checkSprintCompletion };

const router = Router();

// ── Types ─────────────────────────────────────────────────────────────────────

interface Sprint {
  id: number;
  project_id: number;
  name: string;
  goal: string;
  sprint_type: string;
  status: 'planning' | 'planned' | 'active' | 'paused' | 'complete' | 'closed';
  length_kind: 'time' | 'runs';
  length_value: string;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

router.use(sprintDefinitionsRouter);

async function requireSprintVisibleForTenant(db: ReturnType<typeof getDb>, sprintId: number | string, tenantId: number): Promise<boolean> {
  if (!await routeTableHasColumn(db, 'sprints', 'tenant_id')) {
    return Boolean(await db.get(`SELECT id FROM sprints WHERE id = ?`, sprintId));
  }
  return Boolean(await db.get(`SELECT id FROM sprints WHERE id = ? AND tenant_id = ?`, sprintId, tenantId));
}

async function routeTableHasColumn(db: ReturnType<typeof getDb>, table: string, column: string): Promise<boolean> {
  try {
    return await sharedColumnExists(db, `${table}`, column);
  } catch {
    return false;
  }
}

async function requireProjectVisibleForTenant(db: ReturnType<typeof getDb>, projectId: number, tenantId: number): Promise<boolean> {
  if (!await routeTableHasColumn(db, 'projects', 'tenant_id')) {
    return Boolean(await db.get(`SELECT id FROM projects WHERE id = ?`, projectId));
  }
  return Boolean(await db.get(`SELECT id FROM projects WHERE id = ? AND tenant_id = ?`, projectId, tenantId));
}

async function requireAgentVisibleForTenant(db: ReturnType<typeof getDb>, agentId: number, tenantId: number): Promise<boolean> {
  if (!await routeTableHasColumn(db, 'agents', 'tenant_id')) {
    return Boolean(await db.get(`SELECT id FROM agents WHERE id = ?`, agentId));
  }
  return Boolean(await db.get(`SELECT id FROM agents WHERE id = ? AND tenant_id = ?`, agentId, tenantId));
}

// ── GET /api/v1/sprints ───────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    res.json(await listSprints(db, { ...req.query, tenant_id: tenantId }));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/sprints/:id ───────────────────────────────────────────────────

router.get('/:id', async (req: Request, res: Response) => {
  try {
    // Reject a non-numeric id before it reaches the database. SQLite silently returned no
    // match for `/workflows/types`, so this route 404'd by accident; PostgreSQL rejects the
    // cast and would 500 with a database error instead.
    if (parseIdParam(req.params.id) === null) return res.status(404).json({ error: 'Sprint not found' });
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireSprintVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Sprint not found' });
    const sprint = await getSprintDetail(db, Number(req.params.id));
    if (!sprint) return res.status(404).json({ error: 'Sprint not found' });
    return res.json(sprint);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/sprints ──────────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const projectId = Number((req.body as Partial<Sprint>)?.project_id);
    if (Number.isInteger(projectId) && projectId > 0) {
      if (!await requireProjectVisibleForTenant(db, projectId, tenantId)) return res.status(404).json({ error: 'Project not found' });
    }
    return res.status(201).json(await createSprint(db, { ...(req.body as Partial<Sprint>), tenant_id: tenantId } as Partial<Sprint>, extractActor(req)));
  } catch (err) {
    const typedErr = err as Error & { status?: number; body?: Record<string, unknown> };
    return res.status(typedErr.status ?? 500).json(typedErr.body ?? { error: typedErr.message });
  }
});

// ── PUT /api/v1/sprints/:id ───────────────────────────────────────────────────

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireSprintVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Sprint not found' });
    const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
    if (body.project_id !== undefined) {
      const projectId = Number(body.project_id);
      if (!await requireProjectVisibleForTenant(db, projectId, tenantId)) return res.status(404).json({ error: 'Project not found' });
    }
    return res.json(await updateSprint(db, Number(req.params.id), body, extractActor(req)));
  } catch (err) {
    const typedErr = err as Error & { status?: number; body?: Record<string, unknown> };
    return res.status(typedErr.status ?? 500).json(typedErr.body ?? { error: typedErr.message });
  }
});

// ── DELETE /api/v1/sprints/:id ────────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    return res.json(await deleteSprint(db, Number(req.params.id), extractActor(req), tenantId));
  } catch (err) {
    const typedErr = err as Error & { status?: number };
    return res.status(typedErr.status ?? 500).json({ error: typedErr.message });
  }
});

// ── POST /api/v1/sprints/:id/close ───────────────────────────────────────────

router.post('/:id/close', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireSprintVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Sprint not found' });
    return res.json(await closeSprint(db, Number(req.params.id), extractActor(req)));
  } catch (err) {
    const typedErr = err as Error & { status?: number };
    return res.status(typedErr.status ?? 500).json({ error: typedErr.message });
  }
});

// ── POST /api/v1/sprints/:id/complete ────────────────────────────────────────

router.post('/:id/complete', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireSprintVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Sprint not found' });
    return res.json(await completeSprintRoute(db, Number(req.params.id)));
  } catch (err) {
    const typedErr = err as Error & { status?: number };
    return res.status(typedErr.status ?? 500).json({ error: typedErr.message });
  }
});

// ── GET /api/v1/sprints/:id/metrics ──────────────────────────────────────────

router.get('/:id/metrics', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireSprintVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Sprint not found' });
    const metrics = await getSprintMetrics(db, Number(req.params.id));
    if (!metrics) return res.status(404).json({ error: 'Sprint not found' });
    return res.json(metrics);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/sprints/:id/jobs ─────────────────────────────────────────────

router.get('/:id/jobs', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireSprintVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Sprint not found' });
    const jobs = await listSprintJobs(db, Number(req.params.id));
    if (!jobs) return res.status(404).json({ error: 'Sprint not found' });
    return res.json(jobs);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/sprints/:id/jobs ────────────────────────────────────────────
// Task #605: sprint-scoped agents are deprecated. Use sprint_task_routing_rules.
router.post('/:id/jobs', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireSprintVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Sprint not found' });
    const { job_id } = req.body as { job_id?: number };
    if (job_id) {
      if (!await requireAgentVisibleForTenant(db, job_id, tenantId)) return res.status(404).json({ error: 'Agent/job not found' });
    }
    return res.status(201).json(await attachSprintJob(db, Number(req.params.id), job_id));
  } catch (err) {
    const typedErr = err as Error & { status?: number };
    return res.status(typedErr.status ?? 500).json({ error: typedErr.message });
  }
});

// ── DELETE /api/v1/sprints/:id/jobs/:jobId ───────────────────────────────────
// Task #605: sprint-scoped agents are deprecated. Use sprint_task_routing_rules.
router.delete('/:id/jobs/:jobId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireSprintVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Sprint not found' });
    if (!await requireAgentVisibleForTenant(db, Number(req.params.jobId), tenantId)) return res.status(404).json({ error: 'Agent/job not found' });
    return res.json(await detachSprintJob(db, Number(req.params.id), Number(req.params.jobId)));
  } catch (err) {
    const typedErr = err as Error & { status?: number };
    return res.status(typedErr.status ?? 500).json({ error: typedErr.message });
  }
});

// ── GET /api/v1/sprints/:id/schedules ────────────────────────────────────────
// Task #596: sprint_job_schedules table removed. Return empty array for backward compat.
router.get('/:id/schedules', (_req: Request, res: Response) => {
  return res.json([]);
});

// ── POST /api/v1/sprints/:id/schedules ───────────────────────────────────────
// Task #596: sprint_job_schedules table removed.
router.post('/:id/schedules', (_req: Request, res: Response) => {
  return res.status(410).json({ error: 'Sprint job schedules have been removed (task #596). Use recurring task series instead.' });
});

// ── DELETE /api/v1/sprints/:id/schedules/:scheduleId ─────────────────────────
// Task #596: sprint_job_schedules table removed.
router.delete('/:id/schedules/:scheduleId', (_req: Request, res: Response) => {
  return res.status(410).json({ error: 'Sprint job schedules have been removed (task #596).' });
});

export default router;
