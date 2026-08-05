import { Router, Request, Response } from 'express';
import { getDb } from '../db/client';
import { normalizeStopBehavior } from '../domains/runs/instanceStop';
import { completeRunInstance, recordInstanceCheckIn, startRunInstance } from '../domains/runs/callbacks';
import { stopInstanceExecution } from '../domains/runs/stopInstanceExecution';
import { resolveTranscriptProvider } from '../domains/runs/transcriptProvider';
import { resolveInstanceSessionKey } from '../domains/runs/sessionKey';
import { ensureCanonicalSessionForInstance } from '../lib/canonicalSessions';
import { columnExists, tableExists } from '../db/introspection';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';
import { mapRuntimeExecutionRow, redactRuntimeMetadata } from '../domains/runtimes/runtimeView';

import { requireNumericId } from '../lib/routeParams';

const router = Router();
// Rejects a non-numeric :id before it reaches the database, restoring the 404 SQLite
// returned for a no-match. Must be per-router: app.param() does not fire for a param
// declared on a mounted sub-router.
router.param('id', requireNumericId);

function readPositiveInteger(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function readOptionalPositiveInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function fallbackExecutionState(status: unknown): string {
  switch (status) {
    case 'queued': return 'preparing';
    case 'dispatched': return 'starting';
    case 'running': return 'running';
    case 'done': return 'succeeded';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return typeof status === 'string' && status ? status : 'unknown';
  }
}

// GET /api/v1/instances — recent job runs for chat/run selectors.
// Include task ownership so pre-canonical starting runs can survive project filters.
router.get('/', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const agentId = readOptionalPositiveInteger(req.query.agent_id);
    const projectId = readOptionalPositiveInteger(req.query.project_id);
    const limit = readPositiveInteger(req.query.limit, 200, 500);
    const offset = Math.max(readPositiveInteger(req.query.offset, 0, Number.MAX_SAFE_INTEGER), 0);
    const filters: string[] = [];
    const params: unknown[] = [];

    if (agentId !== null) {
      filters.push('ji.agent_id = ?');
      params.push(agentId);
    }
    if (projectId !== null) {
      filters.push('t.project_id = ?');
      params.push(projectId);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    params.push(limit, offset);

    const instances = await db.all(`
      SELECT
        ji.*,
        a.job_title AS job_title,
        a.name AS agent_name,
        a.session_key AS agent_session_key,
        t.title AS task_title,
        t.status AS task_status,
        t.project_id AS project_id,
        ia.current_stage,
        ia.last_agent_heartbeat_at,
        ia.last_meaningful_output_at,
        ia.latest_commit_hash,
        ia.branch_name,
        ia.changed_files_json,
        ia.changed_files_count,
        ia.summary AS artifact_summary,
        ia.blocker_reason,
        ia.outcome AS artifact_outcome,
        ia.stale AS run_is_stale,
        ia.stale_at,
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
      LEFT JOIN tasks t ON t.id = ji.task_id
      LEFT JOIN instance_artifacts ia ON ia.instance_id = ji.id
      ${whereClause}
      ORDER BY ji.created_at DESC
      LIMIT ? OFFSET ?
    `, ...params);
    return res.json(instances);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/instances/:id/runtime
// Reads the durable runtime execution when available. During rollout, or for
// historical instances, it falls back to the mirrored job_instances fields.
router.get('/:id/runtime', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const jobInstancesHaveTenant = await columnExists(db, 'job_instances', 'tenant_id');
    const instance = await db.get<Record<string, unknown>>(`
      SELECT
        ji.*,
        a.runtime_type AS agent_runtime_type
      FROM job_instances ji
      LEFT JOIN agents a ON a.id = ji.agent_id
      WHERE ji.id = ?
        AND ${jobInstancesHaveTenant ? 'ji.tenant_id' : 'a.tenant_id'} = ?
    `, id, tenantId);
    if (!instance) return res.status(404).json({ error: 'Instance not found.' });

    let executionRow: Record<string, unknown> | undefined;
    if (await tableExists(db, 'runtime_executions')) {
      executionRow = await db.get<Record<string, unknown>>(`
        SELECT *
        FROM runtime_executions
        WHERE instance_id = ? AND tenant_id = ?
        ORDER BY id DESC
        LIMIT 1
      `, id, tenantId);
    }

    const runtimeType = typeof executionRow?.runtime_type === 'string'
      ? executionRow.runtime_type
      : typeof instance.agent_runtime_type === 'string'
        ? instance.agent_runtime_type
        : 'openclaw';
    const executionState = typeof executionRow?.state === 'string'
      ? executionRow.state
      : fallbackExecutionState(instance.status);
    const fallback = {
      status: instance.status ?? null,
      session_id: instance.session_key ?? instance.durable_run_id ?? instance.run_id ?? null,
      dispatched_at: instance.dispatched_at ?? null,
      started_at: instance.started_at ?? null,
      completed_at: instance.completed_at ?? null,
      runtime_ended_at: instance.runtime_ended_at ?? null,
      runtime_end_success: instance.runtime_end_success ?? null,
      runtime_end_source: instance.runtime_end_source ?? null,
      runtime_end_error: redactRuntimeMetadata(instance.runtime_end_error ?? null),
    };

    const execution = executionRow
      ? mapRuntimeExecutionRow(executionRow, { instanceId: id, runtimeType, state: executionState })
      : null;

    return res.json({
      instance_id: id,
      source: execution ? 'runtime_executions' : 'job_instances',
      runtime_type: runtimeType,
      execution_state: executionState,
      execution,
      fallback,
    });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// PUT /api/v1/instances/:id/start
// Called by agents at the beginning of a job run to register their session key
router.put('/:id/start', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { session_key } = req.body as { session_key?: string };
    return res.json(await startRunInstance(getDb(), id, session_key ?? null));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/v1/instances/:id/check-in
// Called by agents during a run to mirror progress into Agent HQ
router.post('/:id/check-in', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    return res.json(await recordInstanceCheckIn(getDb(), id, (req.body ?? {}) as Record<string, unknown>));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// PUT /api/v1/instances/:id/complete
// Called by agents when they finish a job run
router.put('/:id/complete', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    return res.json(await completeRunInstance(getDb(), id, (req.body ?? {}) as Record<string, unknown>));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/v1/instances/:id/session-key
// Resolves the real session key for a cron-dispatched job by reading the cron run JSONL
router.get('/:id/session-key', async (req: Request, res: Response) => {
  try {
    return res.json(await resolveInstanceSessionKey(getDb(), Number(req.params.id)));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/v1/instances/:id/transcript
// Serves transcript data for job runs via the transcript provider abstraction (task #471).
// The provider is resolved based on the agent's runtime_type:
//   - openclaw  → local chat_messages or gateway
//   - claude-code → .claude/projects JSONL files (fallback: chat_messages)
//   - veri      → chat_messages populated by CustomAgentRuntime (fallback: remote API)
router.get('/:id/transcript', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const provider = await resolveTranscriptProvider(id);
    const result = await provider.getTranscript(id);

    await ensureCanonicalSessionForInstance(id);

    if (result.messages.length === 0 && !result.in_progress) {
      return res.status(404).json({
        error: 'No transcript available for this instance',
        hint: `Provider: ${provider.name}. If this run is still in progress, check back after it finishes.`,
      });
    }

    // Transform to the wire format the UI expects:
    //   { type: role, event_type, event_meta, message: { content } }
    const messages = result.messages.map(m => ({
      id: m.id,
      type: m.role,
      event_type: m.event_type ?? 'text',
      event_meta: m.event_meta ?? {},
      timestamp: m.timestamp,
      message: {
        content: m.role === 'assistant'
          ? [{ type: 'text', text: m.content }]
          : m.content,
      },
    }));

    return res.json({
      sessionKey: result.sessionKey,
      source: result.source,
      provider: provider.name,
      messages,
      ...(result.in_progress ? { in_progress: true } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// PUT /api/v1/instances/:id/stop
// Kills the running job, clears task linkage, and applies an explicit stop behavior.
// Default behavior is `park` to prevent immediate redispatch loops.
export async function stopInstanceRoute(req: Request, res: Response): Promise<Response> {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const body = (req.body ?? {}) as { behavior?: unknown; mode?: unknown; action?: unknown };
    // Manual stops (no explicit behavior specified) should not alter task status.
    // Default to 'stop' so the task remains in its current state; callers who want
    // to cancel ('park') or re-queue ('requeue') must pass an explicit behavior.
    const rawBehavior = body.behavior ?? body.mode ?? body.action;
    const behavior = rawBehavior !== undefined ? normalizeStopBehavior(rawBehavior) : 'stop';

    const jobInstancesHaveTenant = await columnExists(db, 'job_instances', 'tenant_id');
    const agentsHaveTenant = await columnExists(db, 'agents', 'tenant_id');
    if (!jobInstancesHaveTenant || !agentsHaveTenant) {
      return res.status(503).json({ error: 'Tenant-scoped instance stop is unavailable.' });
    }
    const instance = await db.get(`
      SELECT ji.*, a.session_key AS agent_session_key, a.runtime_type, a.runtime_config
      FROM job_instances ji
      LEFT JOIN agents a ON a.id = ji.agent_id AND a.tenant_id = ?
      WHERE ji.id = ? AND ji.tenant_id = ?
    `, tenantId, id, tenantId) as Record<string, unknown> | undefined;
    if (!instance) return res.status(404).json({ error: 'Instance not found' });

    const status = instance.status as string;
    if (status === 'done' || status === 'failed') {
      return res.status(409).json({
        ok: false,
        code: 'already_finished',
        error: `Instance is already ${status}`,
        result: 'already_finished',
        id,
        behavior,
        instanceStatus: status,
        message: `Run already finished (${status}).`,
      });
    }

    const stopResult = await stopInstanceExecution(db, id, tenantId, behavior);
    console.log(`[instances] Instance ${id} stopped (authoritative) — behavior=${behavior} abortOk=${stopResult.abortOk ?? !stopResult.sessionKey} abortStatus=${stopResult.abortStatus ?? 'not-attempted'} runtimeUncertain=${stopResult.runtimeUncertain} cronRemoved=${stopResult.cronRemoved}`);
    return res.json({
      ok: true,
      ...stopResult,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}

router.put('/:id/stop', stopInstanceRoute);

export default router;
