import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { evaluateTaskIntegrity } from '../lib/taskRelease';
import { stopTaskActiveInstance } from '../lib/taskStop';
import {
  postTaskOutcome,
  putDeployEvidence,
  putLiveVerification,
  putQaEvidence,
  putReviewEvidence,
} from '../domains/tasks/release';
import { buildTaskContext, type TaskContextMode, type TaskContextOptions } from '../domains/tasks/context';
import { resolveTaskFieldSchema, TaskCustomFieldValidationError } from '../domains/tasks/fields';
import {
  createTaskRelationship,
  deleteTaskRelationship,
  listRelationshipTypesForTask,
  listTaskRelationships,
} from '../domains/tasks/relationships';
import {
  addTaskBlockerRecord,
  cancelTaskRecord,
  createTaskNoteRecord,
  createTaskRecord,
  deleteTaskRecord,
  pauseTaskRecord,
  removeTaskBlockerRecord,
  reopenTaskRecord,
  type CreateTaskInput,
  type UpdateTaskInput,
  unpauseTaskRecord,
  updateTaskRecord,
} from '../domains/tasks/writeModel';
import {
  getTaskById,
  listRecentlyCompletedTasks,
  listTaskAttachments,
  listTaskHistory,
  listTaskInstances,
  listTaskNotes,
  listTasks,
  searchProjectTasks,
  searchTasks,
} from '../domains/tasks/readModel';
import { resolveRequestActor } from '../domains/tasks/requestActor';
import { getMcpIdentityFromRequest } from '../lib/mcpApiAuth';
import { WorkflowAllowedValuesError, workflowAllowedValuesErrorBody } from '../lib/taskStatusValidation';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';

const UPLOADS_BASE = path.resolve(__dirname, '../../uploads/tasks');
const ACTIVE_TASK_INSTANCE_STATUSES = new Set(['queued', 'dispatched', 'running']);

function sendWorkflowAllowedValuesError(res: Response, err: unknown): boolean {
  if (!(err instanceof WorkflowAllowedValuesError)) return false;
  res.status(err.status).json(workflowAllowedValuesErrorBody(err));
  return true;
}

type ActiveOwnerRow = {
  task_id: number;
  task_status: string | null;
  task_agent_id: number | null;
  task_active_instance_id: number | null;
  active_instance_id: number | null;
  active_instance_task_id: number | null;
  active_instance_agent_id: number | null;
  active_instance_status: string | null;
};

function parseTaskRouteId(raw: string): number | null {
  const taskId = Number(raw);
  return Number.isInteger(taskId) && taskId > 0 ? taskId : null;
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const taskDir = path.join(UPLOADS_BASE, String(req.params.id));
    fs.mkdirSync(taskDir, { recursive: true });
    cb(null, taskDir);
  },
  filename: (_req, file, cb) => {
    // Prefix with timestamp to avoid collisions
    const prefix = Date.now();
    cb(null, `${prefix}-${file.originalname}`);
  },
});

const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max

const router = Router();

async function requireTaskVisibleForTenant(db: ReturnType<typeof getDb>, taskId: number | string, tenantId: number): Promise<boolean> {
  return Boolean(await db.get(`SELECT id FROM tasks WHERE id = ? AND tenant_id = ?`, taskId, tenantId));
}

// ── GET /api/v1/tasks/completed-recent?hours=N ──────────────────────────────
// Returns tasks that reached 'done' status within the last N hours (default 24).
// Includes task title, agent name, completion time, outcome, and custom_fields.
// and the terminal outcome (live_verified, qa_pass, etc.).
// Ordered by most recent completion first.

// ── GET /api/v1/tasks/search?q=&exclude_id=&limit= ──────────────────────────
// Lightweight task search for use in pickers (e.g. blocker picker).
// Searches by numeric id prefix (if q starts with #) or by title substring.
// Returns id, title, status — enough to display in a dropdown.
router.get('/search', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    res.json(await searchTasks(db, { ...req.query, tenant_id: tenantId }));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/completed-recent', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    res.json(await listRecentlyCompletedTasks(db, req.query.hours, req.query.project_id, tenantId));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/tasks?project_id=X ──────────────────────────────────────────
// Supports optional pagination via limit/offset query params.
// When limit is provided, returns { tasks, total, hasMore, limit, offset }.
// Without limit, returns Task[] for backwards compatibility.
// Optional exclude_done=true hides tasks with status='done'.

router.get('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    res.json(await listTasks(db, { ...req.query, tenant_id: tenantId }));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/tasks/project-search ───────────────────────────────────────
// Read-only MCP search for exact follow-up dedupe inside the authenticated
// agent's assigned project. Caller-supplied project scope is intentionally
// ignored; MCP auth also requires tasks.search_project_tasks for this route.

router.post('/project-search', async (req: Request, res: Response) => {
  try {
    const identity = getMcpIdentityFromRequest(req);
    if (!identity) {
      return res.status(401).json({
        ok: false,
        code: 'mcp_api_key_missing',
        error: 'MCP API key is required',
      });
    }

    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const agent = await db.get(`
      SELECT project_id
      FROM agents
      WHERE id = ? AND tenant_id = ?
      LIMIT 1
    `, identity.agentId, tenantId) as { project_id: number | null } | undefined;
    const projectId = Number(agent?.project_id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(403).json({
        ok: false,
        code: 'mcp_scope_denied',
        error: `${identity.agentSlug} does not have an assigned project for project task search.`,
        details: {
          agent_id: identity.agentId,
          agent_slug: identity.agentSlug,
          required_capability: 'tasks.search_project_tasks',
        },
      });
    }

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    res.json(await searchProjectTasks(db, {
              ...body,
              tenant_id: tenantId,
              project_id: projectId,
            }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('custom_fields') || message.includes('custom field')) {
      return res.status(400).json({ error: message, code: 'invalid_project_task_search_filter' });
    }
    res.status(500).json({ error: message });
  }
});

// ── GET /api/v1/tasks/field-schema/resolve ───────────────────────────────────

router.get('/field-schema/resolve', async (req: Request, res: Response) => {
  try {
    const resolved = await resolveTaskFieldSchema(
          req.query.sprint_id ?? null,
          req.query.task_type ?? null,
          req.query.sprint_type ?? null,
        );
    res.json({
      sprint_type: resolved.sprint_type,
      allowed_task_types: resolved.allowed_task_types,
      fields: resolved.schema.fields,
      schema: resolved.schema,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/tasks/:id/active-owner ──────────────────────────────────────
// Returns whether the authenticated MCP agent owns the task's active run.

router.get('/:id/active-owner', async (req: Request, res: Response) => {
  try {
    const identity = getMcpIdentityFromRequest(req);
    if (!identity) {
      return res.status(401).json({
        ok: false,
        code: 'mcp_api_key_missing',
        error: 'MCP API key is required',
      });
    }

    const taskId = parseTaskRouteId(req.params.id);
    if (!taskId) {
      return res.status(400).json({
        ok: false,
        code: 'invalid_task_id',
        error: 'Invalid task id',
      });
    }

    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const row = await db.get(`
      SELECT
        t.id AS task_id,
        t.status AS task_status,
        t.agent_id AS task_agent_id,
        t.active_instance_id AS task_active_instance_id,
        ji.id AS active_instance_id,
        ji.task_id AS active_instance_task_id,
        ji.agent_id AS active_instance_agent_id,
        ji.status AS active_instance_status
      FROM tasks t
      LEFT JOIN job_instances ji ON ji.id = t.active_instance_id
      WHERE t.id = ? AND t.tenant_id = ?
      LIMIT 1
    `, taskId, tenantId) as ActiveOwnerRow | undefined;

    if (!row) {
      return res.status(404).json({
        ok: false,
        code: 'task_not_found',
        error: 'Task not found',
        task_id: taskId,
        authenticated_agent_id: identity.agentId,
        authenticated_agent_slug: identity.agentSlug,
      });
    }

    const base = {
      ok: true,
      task_id: taskId,
      task_status: row.task_status ?? null,
      task_agent_id: row.task_agent_id ?? null,
      authenticated_agent_id: identity.agentId,
      authenticated_agent_slug: identity.agentSlug,
      active_instance_id: row.task_active_instance_id ?? row.active_instance_id ?? null,
      active_instance_task_id: row.active_instance_task_id ?? null,
      active_instance_agent_id: row.active_instance_agent_id ?? null,
      active_instance_status: row.active_instance_status ?? null,
    };

    if (row.task_active_instance_id == null) {
      return res.json({
        ...base,
        is_active_owner: false,
        reason: 'task_has_no_active_instance',
      });
    }

    if (row.active_instance_id == null) {
      return res.json({
        ...base,
        is_active_owner: false,
        reason: 'active_instance_missing',
      });
    }

    if (row.active_instance_task_id !== taskId) {
      return res.json({
        ...base,
        is_active_owner: false,
        reason: 'active_instance_task_mismatch',
      });
    }

    if (!row.active_instance_status || !ACTIVE_TASK_INSTANCE_STATUSES.has(row.active_instance_status)) {
      return res.json({
        ...base,
        is_active_owner: false,
        reason: 'active_instance_not_active',
      });
    }

    if (row.active_instance_agent_id !== identity.agentId) {
      return res.json({
        ...base,
        is_active_owner: false,
        reason: 'active_instance_agent_mismatch',
      });
    }

    return res.json({
      ...base,
      is_active_owner: true,
      reason: 'active_instance_owned_by_authenticated_agent',
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── GET /api/v1/tasks/:id/context ───────────────────────────────────────────

router.get('/:id/context', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const taskId = Number(req.params.id);
    if (!Number.isFinite(taskId)) return res.status(400).json({ error: 'Invalid task id' });
    const task = await db.get(`SELECT id FROM tasks WHERE id = ? AND tenant_id = ?`, taskId, tenantId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const modeRaw = String(req.query.mode ?? 'summary').trim().toLowerCase();
    if (modeRaw !== 'summary' && modeRaw !== 'full') {
      return res.status(400).json({ error: 'mode must be summary or full' });
    }

    const parseOptionalInt = (value: unknown): number | undefined => {
      if (value === undefined || value === null || value === '') return undefined;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
    };
    const parseOptionalBool = (value: unknown): boolean | undefined => {
      if (value === undefined || value === null || value === '') return undefined;
      if (typeof value === 'boolean') return value;
      const normalized = String(value).trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
      if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
      return undefined;
    };

    const options: TaskContextOptions = {
      includeNotes: parseOptionalBool(req.query.includeNotes),
      includeHistory: parseOptionalBool(req.query.includeHistory),
      includeRuns: parseOptionalBool(req.query.includeRuns),
      includeLease: parseOptionalBool(req.query.includeLease),
      includeNoisyEvents: parseOptionalBool(req.query.includeNoisyEvents),
      recentNotesLimit: parseOptionalInt(req.query.recentNotesLimit),
      recentHistoryLimit: parseOptionalInt(req.query.recentHistoryLimit),
      recentRunsLimit: parseOptionalInt(req.query.recentRunsLimit),
      recentExternalEventsLimit: parseOptionalInt(req.query.recentExternalEventsLimit),
      timelineLimit: parseOptionalInt(req.query.timelineLimit),
      sinceTimestamp: typeof req.query.sinceTimestamp === 'string' ? req.query.sinceTimestamp : undefined,
      sinceNoteId: parseOptionalInt(req.query.sinceNoteId),
      sinceHistoryId: parseOptionalInt(req.query.sinceHistoryId),
    };

    const ctx = await buildTaskContext(taskId, modeRaw as TaskContextMode, options);
    if (!ctx) return res.status(404).json({ error: 'Task not found' });
    return res.json(ctx);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/tasks/:id ────────────────────────────────────────────────────

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireTaskVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    const task = await getTaskById(db, Number(req.params.id));
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/tasks/:id/relationships ────────────────────────────────────

router.get('/:id/relationships', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireTaskVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    res.json({ relationships: await listTaskRelationships(db, Number(req.params.id)) });
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── GET /api/v1/tasks/:id/relationship-types ───────────────────────────────

router.get('/:id/relationship-types', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireTaskVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    res.json({
      task_id: Number(req.params.id),
      relationship_types: await listRelationshipTypesForTask(db, Number(req.params.id)),
    });
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── POST /api/v1/tasks/:id/relationships ───────────────────────────────────

router.post('/:id/relationships', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireTaskVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    const targetTask = await db.get(`SELECT id FROM tasks WHERE id = ? AND tenant_id = ?`, req.body?.target_task_id, tenantId);
    if (!targetTask) return res.status(404).json({ error: 'Target task not found' });
    const createdBy = resolveRequestActor(req, req.body?.changed_by ?? req.body?.created_by ?? 'system').changedBy;
    const relationship = await createTaskRelationship(db, {
          source_task_id: Number(req.params.id),
          target_task_id: req.body?.target_task_id,
          relationship_type_key: req.body?.relationship_type_key ?? req.body?.type_key,
          metadata_json: req.body?.metadata_json ?? req.body?.metadata,
          created_by: createdBy,
        });
    res.status(201).json(relationship);
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── DELETE /api/v1/tasks/:id/relationships/:relationshipId ──────────────────

router.delete('/:id/relationships/:relationshipId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireTaskVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    const relationship = await db.get(`
      SELECT tr.id
      FROM task_relationships tr
      JOIN tasks source ON source.id = tr.source_task_id
      JOIN tasks target ON target.id = tr.target_task_id
      WHERE tr.id = ? AND source.tenant_id = ? AND target.tenant_id = ?
    `, req.params.relationshipId, tenantId, tenantId);
    if (!relationship) return res.status(404).json({ error: 'Relationship not found' });
    res.json(await deleteTaskRelationship(db, Number(req.params.relationshipId)));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── POST /api/v1/tasks ───────────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const createdBy = resolveRequestActor(req, req.body.changed_by ?? 'system').changedBy;
    res.status(201).json(await createTaskRecord(db, { ...(req.body as CreateTaskInput), tenant_id: tenantId }, createdBy));
  } catch (err) {
    const status = (err as Error & { status?: number }).status;
    if (sendWorkflowAllowedValuesError(res, err)) return;
    if (err instanceof TaskCustomFieldValidationError) {
      return res.status(err.status).json({ error: err.message, validation_errors: err.validation_errors });
    }
    const message = err instanceof Error ? err.message : String(err);
    if (status) return res.status(status).json({ error: message });
    if (message.includes('is not in the same workspace') || message.includes('does not belong to project_id')) return res.status(400).json({ error: message });
    if (message.includes('story_points') || message.includes('custom field') || message.includes('custom_fields')) return res.status(400).json({ error: message });
    if (message.includes('CHECK constraint failed')) {
      return res.status(400).json({ error: `Invalid field value: ${message.replace(/^.*CHECK constraint failed:\s*/i, '')}` });
    }
    res.status(500).json({ error: message });
  }
});

// ── PUT /api/v1/tasks/:id ────────────────────────────────────────────────────

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const existing = await db.get(`SELECT id FROM tasks WHERE id = ? AND tenant_id = ?`, req.params.id, tenantId);
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    const changedBy = (req.body?.changed_by as string | undefined) ?? 'system';
    const headerAuthorityBy = (req.header('x-agenthq-authority-by') ?? req.header('x-agent-hq-authority-by') ?? undefined) as string | undefined;
    const actor = resolveRequestActor(
      req,
      changedBy,
      headerAuthorityBy ?? (req.body.authorized_by as string | undefined) ?? (req.body.authority_by as string | undefined) ?? changedBy,
    );
    res.json(await updateTaskRecord(db, Number(req.params.id), req.body as UpdateTaskInput, actor));
  } catch (err) {
    const typedErr = err as Error & { status?: number; body?: Record<string, unknown> };
    const status = typedErr.status;
    if (sendWorkflowAllowedValuesError(res, err)) return;
    if (err instanceof TaskCustomFieldValidationError) {
      return res.status(err.status).json({ error: err.message, validation_errors: err.validation_errors });
    }
    if (typedErr.body) return res.status(status ?? 500).json(typedErr.body);
    const message = err instanceof Error ? err.message : String(err);
    if (status) return res.status(status).json({ error: message });
    if (message.includes('may change task status through the generic update endpoint')) {
      return res.status(403).json({ error: message });
    }
    if (message.includes('task_type "') && message.includes('is not allowed for sprint type')) {
      return res.status(400).json({ error: message, code: 'task_type_not_allowed_for_sprint_type' });
    }
    if (message.includes('is not in the same workspace') || message.includes('does not belong to project_id')) return res.status(400).json({ error: message });
    if (message.startsWith('Cannot move task from "') || message.startsWith('Cannot apply outcome "')) {
      return res.status(400).json({ error: message, code: 'transition_not_allowed_for_workflow' });
    }
    if (message.includes('requires ') || message.startsWith('done requires task status deployed') || message.includes('story_points') || message.includes('custom field') || message.includes('custom_fields')) {
      return res.status(400).json({ error: message });
    }
    // Safety net: convert raw SQLite CHECK constraint errors into clean 400 responses
    if (message.includes('CHECK constraint failed')) {
      return res.status(400).json({ error: `Invalid field value: ${message.replace(/^.*CHECK constraint failed:\s*/i, '')}` });
    }
    res.status(500).json({ error: message });
  }
});

// ── POST /api/v1/tasks/:id/cancel ────────────────────────────────────────────

router.post('/:id/cancel', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireTaskVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    const changedBy = resolveRequestActor(req, (req.body?.changed_by as string | undefined) ?? 'Atlas').changedBy;
    res.json(await cancelTaskRecord(db, Number(req.params.id), changedBy));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── POST /api/v1/tasks/:id/stop ──────────────────────────────────────────────
// Stop the current active run for a task without changing the task's pause
// state or workflow status. Repeated stop requests are idempotent when no
// active run exists.

router.post('/:id/stop', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const id = Number(req.params.id);
    if (!await requireTaskVisibleForTenant(db, id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    const changedBy = resolveRequestActor(req, (req.body?.changed_by as string | undefined) ?? 'User').changedBy;
    const reasonRaw = req.body?.reason as string | undefined;
    const stopReason = typeof reasonRaw === 'string' && reasonRaw.trim().length > 0 ? reasonRaw.trim() : null;
    const result = await stopTaskActiveInstance(db, id, changedBy, stopReason);

    const task = await getTaskById(db, id);
    return res.json({
      ok: true,
      ...result,
      task,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'Task not found') return res.status(404).json({ error: message });
    if (message.startsWith('Cannot stop a task in terminal status')) {
      return res.status(400).json({ error: message });
    }
    return res.status(500).json({ error: message });
  }
});

// ── POST /api/v1/tasks/:id/reopen ────────────────────────────────────────────
// Reopen a failed task: restores it to its previous_status (the status it held
// before failing). Falls back to 'ready' if previous_status is not recorded.
// Only callable on tasks in 'failed' status.

router.post('/:id/reopen', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireTaskVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    const changedBy = resolveRequestActor(req, (req.body?.changed_by as string | undefined) ?? 'Atlas').changedBy;
    res.json(await reopenTaskRecord(db, Number(req.params.id), changedBy));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── POST /api/v1/tasks/:id/pause ─────────────────────────────────────────────
// Pause a task: sets paused_at = now and stores an optional pause_reason.
// Paused tasks are excluded from routing, dispatch, and lifecycle transitions
// until explicitly unpaused. Status is not changed.

router.post('/:id/pause', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireTaskVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    const pauseReason = (req.body?.reason as string | undefined) ?? null;
    const changedBy = resolveRequestActor(req, (req.body?.changed_by as string | undefined) ?? 'user').changedBy;
    res.json(await pauseTaskRecord(db, Number(req.params.id), changedBy, pauseReason));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── POST /api/v1/tasks/:id/unpause ───────────────────────────────────────────
// Unpause a task: clears paused_at and pause_reason, restoring full dispatch
// eligibility immediately.

router.post('/:id/unpause', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireTaskVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    const changedBy = resolveRequestActor(req, (req.body?.changed_by as string | undefined) ?? 'user').changedBy;
    res.json(await unpauseTaskRecord(db, Number(req.params.id), changedBy));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── POST /api/v1/tasks/:id/outcome ───────────────────────────────────────────
// Supports atomic evidence writes through payload.review_branch,
// payload.review_commit, etc. Evidence is validated and written in the same
// SQLite transaction as the status transition, ensuring the task record
// always reflects the actual artifact when completion succeeds.

router.post('/:id/outcome', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const id = Number(req.params.id);
    if (!await requireTaskVisibleForTenant(db, id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    const changedBy = resolveRequestActor(req, (req.body?.changed_by as string | undefined) ?? 'system').changedBy;
    res.json(await postTaskOutcome(db, id, (req.body ?? {}) as Record<string, unknown>, changedBy, {
      mcpIdentity: getMcpIdentityFromRequest(req),
    }));
  } catch (err) {
    if (sendWorkflowAllowedValuesError(res, err)) return;
    const typedErr = err as Error & { status?: number; body?: Record<string, unknown>; validation_errors?: string[] };
    if (typedErr.body) {
      return res.status(typedErr.status ?? 500).json(typedErr.body);
    }
    const message = err instanceof Error ? err.message : String(err);
    if (typedErr.status === 400 && typedErr.validation_errors) {
      return res.status(400).json({ error: message, validation_errors: typedErr.validation_errors });
    }
    if (message.startsWith('No routing config found for')) {
      return res.status(422).json({ error: message });
    }
    if (message.includes('task_type "') && message.includes('is not allowed for sprint type')) {
      return res.status(400).json({ error: message, code: 'task_type_not_allowed_for_sprint_type' });
    }
    if (message.startsWith('Cannot move task from "') || message.startsWith('Cannot apply outcome "')) {
      return res.status(400).json({ error: message, code: 'transition_not_allowed_for_workflow' });
    }
    if (
      message.includes('requires ') ||
      message.startsWith('qa_pass requires') ||
      message.startsWith('deployed_live requires') ||
      message.startsWith('live_verified requires')
    ) {
      return res.status(400).json({ error: message });
    }
    res.status(typedErr.status ?? 500).json({ error: message });
  }
});

// ── POST /api/v1/tasks/:id/admin-outcome ─────────────────────────────────────
// Explicit operator/admin override path. Normal MCP runtime tools are not
// registered to this route; scoped MCP keys need admin.full_access to reach it.

router.post('/:id/admin-outcome', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const id = Number(req.params.id);
    if (!await requireTaskVisibleForTenant(db, id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    const changedBy = resolveRequestActor(req, (req.body?.changed_by as string | undefined) ?? 'Atlas').changedBy;
    res.json(await postTaskOutcome(db, id, (req.body ?? {}) as Record<string, unknown>, changedBy));
  } catch (err) {
    if (sendWorkflowAllowedValuesError(res, err)) return;
    const typedErr = err as Error & { status?: number; body?: Record<string, unknown>; validation_errors?: string[] };
    if (typedErr.body) {
      return res.status(typedErr.status ?? 500).json(typedErr.body);
    }
    const message = err instanceof Error ? err.message : String(err);
    if (typedErr.status === 400 && typedErr.validation_errors) {
      return res.status(400).json({ error: message, validation_errors: typedErr.validation_errors });
    }
    if (message.startsWith('No routing config found for')) {
      return res.status(422).json({ error: message });
    }
    if (message.includes('task_type "') && message.includes('is not allowed for sprint type')) {
      return res.status(400).json({ error: message, code: 'task_type_not_allowed_for_sprint_type' });
    }
    if (message.startsWith('Cannot move task from "') || message.startsWith('Cannot apply outcome "')) {
      return res.status(400).json({ error: message, code: 'transition_not_allowed_for_workflow' });
    }
    if (
      message.includes('requires ') ||
      message.startsWith('qa_pass requires') ||
      message.startsWith('deployed_live requires') ||
      message.startsWith('live_verified requires')
    ) {
      return res.status(400).json({ error: message });
    }
    res.status(typedErr.status ?? 500).json({ error: message });
  }
});

// ── PUT /api/v1/tasks/:id/review-evidence ────────────────────────────────────

router.put('/:id/review-evidence', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const id = Number(req.params.id);
    if (!await requireTaskVisibleForTenant(db, id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    const changedBy = resolveRequestActor(req, (req.body?.changed_by as string | undefined) ?? 'system').changedBy;
    res.json(await putReviewEvidence(db, id, (req.body ?? {}) as Record<string, unknown>, changedBy));
  } catch (err) {
    const typedErr = err as Error & { status?: number; body?: Record<string, unknown>; validation_errors?: string[] };
    const message = err instanceof Error ? err.message : String(err);
    if (typedErr.body) return res.status(typedErr.status ?? 500).json(typedErr.body);
    if (typedErr.status === 400 && typedErr.validation_errors) {
      return res.status(400).json({ error: message, validation_errors: typedErr.validation_errors });
    }
    if (message.includes('story_points')) return res.status(400).json({ error: message });
    res.status(typedErr.status ?? 500).json({ error: message });
  }
});

// ── PUT /api/v1/tasks/:id/qa-evidence ────────────────────────────────────────

router.put('/:id/qa-evidence', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const id = Number(req.params.id);
    if (!await requireTaskVisibleForTenant(db, id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    const changedBy = resolveRequestActor(req, (req.body?.changed_by as string | undefined) ?? 'system').changedBy;
    res.json(await putQaEvidence(db, id, (req.body ?? {}) as Record<string, unknown>, changedBy));
  } catch (err) {
    const typedErr = err as Error & { status?: number; body?: Record<string, unknown>; validation_errors?: string[] };
    const message = err instanceof Error ? err.message : String(err);
    if (typedErr.body) return res.status(typedErr.status ?? 500).json(typedErr.body);
    if (typedErr.status === 400 && typedErr.validation_errors) {
      return res.status(400).json({ error: message, validation_errors: typedErr.validation_errors });
    }
    if (message.includes('story_points')) return res.status(400).json({ error: message });
    res.status(typedErr.status ?? 500).json({ error: message });
  }
});

// ── PUT /api/v1/tasks/:id/deploy-evidence ────────────────────────────────────

router.put('/:id/deploy-evidence', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const id = Number(req.params.id);
    if (!await requireTaskVisibleForTenant(db, id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    const changedBy = resolveRequestActor(req, (req.body?.changed_by as string | undefined) ?? 'system').changedBy;
    res.json(await putDeployEvidence(db, id, (req.body ?? {}) as Record<string, unknown>, changedBy));
  } catch (err) {
    const typedErr = err as Error & { status?: number; validation_errors?: string[] };
    const message = err instanceof Error ? err.message : String(err);
    if (typedErr.status === 400 && typedErr.validation_errors) {
      return res.status(400).json({ error: message, validation_errors: typedErr.validation_errors });
    }
    if (message.includes('story_points')) return res.status(400).json({ error: message });
    res.status(typedErr.status ?? 500).json({ error: message });
  }
});

// ── PUT /api/v1/tasks/:id/live-verification ──────────────────────────────────

router.put('/:id/live-verification', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const id = Number(req.params.id);
    if (!await requireTaskVisibleForTenant(db, id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    const changedBy = resolveRequestActor(req, (req.body?.changed_by as string | undefined) ?? 'system').changedBy;
    res.json(await putLiveVerification(db, id, (req.body ?? {}) as Record<string, unknown>, changedBy));
  } catch (err) {
    const typedErr = err as Error & { status?: number };
    res.status(typedErr.status ?? 500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── POST /api/v1/tasks/backfill-release-integrity ───────────────────────────

router.post('/backfill-release-integrity', async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const tasks = await db.all('SELECT * FROM tasks') as Record<string, unknown>[];
    const results = tasks.map(async task => ({
      id: task.id,
      title: task.title,
      ...await evaluateTaskIntegrity(task as { status?: string | null; task_type?: string | null }, db),
    }));
    const flagged = results.filter(task => task.integrity_state !== 'clean');
    res.json({ ok: true, total: results.length, flagged: flagged.length, results, flagged_results: flagged });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── DELETE /api/v1/tasks/:id ─────────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireTaskVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    const deletedBy = (req.query.deleted_by as string | undefined) ?? (req.body?.deleted_by as string | undefined) ?? 'system';
    res.json(await deleteTaskRecord(db, Number(req.params.id), deletedBy));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── GET /api/v1/tasks/:id/history ────────────────────────────────────────────

router.get('/:id/history', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireTaskVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    res.json(await listTaskHistory(db, Number(req.params.id)));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── GET /api/v1/tasks/:id/notes ──────────────────────────────────────────────

router.get('/:id/notes', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireTaskVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    res.json(await listTaskNotes(db, Number(req.params.id)));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── POST /api/v1/tasks/:id/notes ─────────────────────────────────────────────

router.post('/:id/notes', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireTaskVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    const { author = 'system', content } = req.body as { author?: string; content: string };
    const effectiveAuthor = resolveRequestActor(req, author).changedBy;

    res.status(201).json(await createTaskNoteRecord(db, Number(req.params.id), effectiveAuthor, content));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── DELETE /api/v1/tasks/:id/notes/:noteId ───────────────────────────────────

router.delete('/:id/notes/:noteId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const taskId = Number(req.params.id);
    const noteId = Number(req.params.noteId);
    if (!await requireTaskVisibleForTenant(db, taskId, tenantId)) return res.status(404).json({ error: 'Task not found' });

    const note = await db.get('SELECT id FROM task_notes WHERE id = ? AND task_id = ?', noteId, taskId);
    if (!note) return res.status(404).json({ error: 'Note not found' });

    await db.run('DELETE FROM task_notes WHERE id = ?', noteId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/tasks/:id/blockers ─────────────────────────────────────────

router.post('/:id/blockers', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireTaskVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    const { blocker_id } = req.body as { blocker_id: number };
    if (!await requireTaskVisibleForTenant(db, blocker_id, tenantId)) return res.status(404).json({ error: 'Blocker task not found' });

    res.json(await addTaskBlockerRecord(db, Number(req.params.id), blocker_id));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── DELETE /api/v1/tasks/:id/blockers/:blocker_id ───────────────────────────

router.delete('/:id/blockers/:blocker_id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireTaskVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    if (!await requireTaskVisibleForTenant(db, req.params.blocker_id, tenantId)) return res.status(404).json({ error: 'Blocker task not found' });
    res.json(await removeTaskBlockerRecord(db, Number(req.params.id), Number(req.params.blocker_id)));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── GET /api/v1/tasks/:id/attachments ────────────────────────────────────────

router.get('/:id/attachments', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireTaskVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    res.json(await listTaskAttachments(db, Number(req.params.id)));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/v1/tasks/:id/attachments ───────────────────────────────────────

router.post('/:id/attachments', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const taskId = Number(req.params.id);

    if (!await requireTaskVisibleForTenant(db, taskId, tenantId)) return res.status(404).json({ error: 'Task not found' });

    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file provided' });

    const uploadedBy = (req.body?.uploaded_by as string) || 'system';

    const result = await db.run(`
      INSERT INTO task_attachments (task_id, filename, filepath, mime_type, size, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `, taskId, file.originalname, file.path, file.mimetype || '', file.size, uploadedBy);

    const attachment = await db.get('SELECT * FROM task_attachments WHERE id = ?', result.lastInsertId);
    res.status(201).json(attachment);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/v1/tasks/:id/attachments/:attachmentId/download ─────────────────

router.get('/:id/attachments/:attachmentId/download', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const taskId = Number(req.params.id);
    const attachmentId = Number(req.params.attachmentId);
    if (!await requireTaskVisibleForTenant(db, taskId, tenantId)) return res.status(404).json({ error: 'Task not found' });

    const attachment = await db.get('SELECT * FROM task_attachments WHERE id = ? AND task_id = ?', attachmentId, taskId) as { filepath: string; filename: string; mime_type: string } | undefined;

    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
    if (!fs.existsSync(attachment.filepath)) return res.status(404).json({ error: 'File not found on disk' });

    res.setHeader('Content-Type', attachment.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${attachment.filename}"`);
    fs.createReadStream(attachment.filepath).pipe(res);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── DELETE /api/v1/tasks/:id/attachments/:attachmentId ───────────────────────

router.delete('/:id/attachments/:attachmentId', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const taskId = Number(req.params.id);
    const attachmentId = Number(req.params.attachmentId);
    if (!await requireTaskVisibleForTenant(db, taskId, tenantId)) return res.status(404).json({ error: 'Task not found' });

    const attachment = await db.get('SELECT * FROM task_attachments WHERE id = ? AND task_id = ?', attachmentId, taskId) as { filepath: string } | undefined;

    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });

    // Remove file from disk
    try { fs.unlinkSync(attachment.filepath); } catch { /* file may already be gone */ }

    await db.run('DELETE FROM task_attachments WHERE id = ?', attachmentId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/tasks/:id/instances — job runs related to a task
router.get('/:id/instances', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    if (!await requireTaskVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Task not found' });
    return res.json(await listTaskInstances(db, Number(req.params.id)));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
