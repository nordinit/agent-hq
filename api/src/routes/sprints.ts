import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import sprintDefinitionsRouter from '../domains/sprint-definitions/router';
import { extractActor } from '../lib/projectAudit';
import { attachSprintJob, closeSprint, completeSprintRoute, createSprint, deleteSprint, detachSprintJob, updateSprint } from '../domains/sprints/admin';
import { checkSprintCompletion } from '../domains/sprints/lifecycle';
import { getSprintDetail, getSprintMetrics, listSprintJobs, listSprints } from '../domains/sprints/readModel';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';

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

function requireSprintVisibleForTenant(db: ReturnType<typeof getDb>, sprintId: number | string, tenantId: number): boolean {
  if (!routeTableHasColumn(db, 'sprints', 'tenant_id')) {
    return Boolean(db.prepare(`SELECT id FROM sprints WHERE id = ?`).get(sprintId));
  }
  return Boolean(db.prepare(`SELECT id FROM sprints WHERE id = ? AND tenant_id = ?`).get(sprintId, tenantId));
}

function routeTableHasColumn(db: ReturnType<typeof getDb>, table: string, column: string): boolean {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
  } catch {
    return false;
  }
}

function requireProjectVisibleForTenant(db: ReturnType<typeof getDb>, projectId: number, tenantId: number): boolean {
  if (!routeTableHasColumn(db, 'projects', 'tenant_id')) {
    return Boolean(db.prepare(`SELECT id FROM projects WHERE id = ?`).get(projectId));
  }
  return Boolean(db.prepare(`SELECT id FROM projects WHERE id = ? AND tenant_id = ?`).get(projectId, tenantId));
}

function requireAgentVisibleForTenant(db: ReturnType<typeof getDb>, agentId: number, tenantId: number): boolean {
  if (!routeTableHasColumn(db, 'agents', 'tenant_id')) {
    return Boolean(db.prepare(`SELECT id FROM agents WHERE id = ?`).get(agentId));
  }
  return Boolean(db.prepare(`SELECT id FROM agents WHERE id = ? AND tenant_id = ?`).get(agentId, tenantId));
}

// ── GET /api/v1/sprints ───────────────────────────────────────────────────────

router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    res.json(listSprints(db, { ...req.query, tenant_id: tenantId }));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/sprints/:id ───────────────────────────────────────────────────

router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    if (!requireSprintVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Sprint not found' });
    const sprint = getSprintDetail(db, Number(req.params.id));
    if (!sprint) return res.status(404).json({ error: 'Sprint not found' });
    return res.json(sprint);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/sprints ──────────────────────────────────────────────────────

router.post('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const projectId = Number((req.body as Partial<Sprint>)?.project_id);
    if (Number.isInteger(projectId) && projectId > 0) {
      if (!requireProjectVisibleForTenant(db, projectId, tenantId)) return res.status(404).json({ error: 'Project not found' });
    }
    return res.status(201).json(createSprint(db, { ...(req.body as Partial<Sprint>), tenant_id: tenantId } as Partial<Sprint>, extractActor(req)));
  } catch (err) {
    const typedErr = err as Error & { status?: number; body?: Record<string, unknown> };
    return res.status(typedErr.status ?? 500).json(typedErr.body ?? { error: typedErr.message });
  }
});

// ── PUT /api/v1/sprints/:id ───────────────────────────────────────────────────

router.put('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    if (!requireSprintVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Sprint not found' });
    const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
    if (body.project_id !== undefined) {
      const projectId = Number(body.project_id);
      if (!requireProjectVisibleForTenant(db, projectId, tenantId)) return res.status(404).json({ error: 'Project not found' });
    }
    return res.json(updateSprint(db, Number(req.params.id), body, extractActor(req)));
  } catch (err) {
    const typedErr = err as Error & { status?: number; body?: Record<string, unknown> };
    return res.status(typedErr.status ?? 500).json(typedErr.body ?? { error: typedErr.message });
  }
});

// ── DELETE /api/v1/sprints/:id ────────────────────────────────────────────────

router.delete('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    return res.json(deleteSprint(db, Number(req.params.id), extractActor(req), tenantId));
  } catch (err) {
    const typedErr = err as Error & { status?: number };
    return res.status(typedErr.status ?? 500).json({ error: typedErr.message });
  }
});

// ── POST /api/v1/sprints/:id/close ───────────────────────────────────────────

router.post('/:id/close', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    if (!requireSprintVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Sprint not found' });
    return res.json(closeSprint(db, Number(req.params.id), extractActor(req)));
  } catch (err) {
    const typedErr = err as Error & { status?: number };
    return res.status(typedErr.status ?? 500).json({ error: typedErr.message });
  }
});

// ── POST /api/v1/sprints/:id/complete ────────────────────────────────────────

router.post('/:id/complete', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    if (!requireSprintVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Sprint not found' });
    return res.json(completeSprintRoute(db, Number(req.params.id)));
  } catch (err) {
    const typedErr = err as Error & { status?: number };
    return res.status(typedErr.status ?? 500).json({ error: typedErr.message });
  }
});

// ── GET /api/v1/sprints/:id/metrics ──────────────────────────────────────────

router.get('/:id/metrics', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    if (!requireSprintVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Sprint not found' });
    const metrics = getSprintMetrics(db, Number(req.params.id));
    if (!metrics) return res.status(404).json({ error: 'Sprint not found' });
    return res.json(metrics);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/sprints/:id/jobs ─────────────────────────────────────────────

router.get('/:id/jobs', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    if (!requireSprintVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Sprint not found' });
    const jobs = listSprintJobs(db, Number(req.params.id));
    if (!jobs) return res.status(404).json({ error: 'Sprint not found' });
    return res.json(jobs);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/sprints/:id/jobs ────────────────────────────────────────────
// Task #605: sprint-scoped agents are deprecated. Use sprint_task_routing_rules.
router.post('/:id/jobs', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    if (!requireSprintVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Sprint not found' });
    const { job_id } = req.body as { job_id?: number };
    if (job_id) {
      if (!requireAgentVisibleForTenant(db, job_id, tenantId)) return res.status(404).json({ error: 'Agent/job not found' });
    }
    return res.status(201).json(attachSprintJob(db, Number(req.params.id), job_id));
  } catch (err) {
    const typedErr = err as Error & { status?: number };
    return res.status(typedErr.status ?? 500).json({ error: typedErr.message });
  }
});

// ── DELETE /api/v1/sprints/:id/jobs/:jobId ───────────────────────────────────
// Task #605: sprint-scoped agents are deprecated. Use sprint_task_routing_rules.
router.delete('/:id/jobs/:jobId', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    if (!requireSprintVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Sprint not found' });
    if (!requireAgentVisibleForTenant(db, Number(req.params.jobId), tenantId)) return res.status(404).json({ error: 'Agent/job not found' });
    return res.json(detachSprintJob(db, Number(req.params.id), Number(req.params.jobId)));
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
