import { abortChatRunBySessionKey } from '../../runtimes/OpenClawRuntime';
import { destroyAgentContext } from '../../services/browserPool';
import { recordRunCheckIn } from './observability';
import { isTerminalInstanceOutcome } from '../../lib/outcomeCatalog';
import { scheduleEndedActiveInstanceLinkageCleanup } from '../../lib/taskLifecycle';
import { insertRuntimeLog } from '../../lib/runtimeTenantScope';
import { type Db } from "../../db/adapter/types";

/**
 * Terminal outcomes that should automatically close the instance and terminate
 * the agent session when posted via POST /tasks/:id/outcome.
 *
 * Any accepted task outcome is a semantic handoff and should end the current
 * instance. Follow-up workflow states can dispatch their own fresh run.
 */
export function isTerminalOutcome(outcome: string): boolean {
  return isTerminalInstanceOutcome(outcome);
}

export interface CloseInstanceOptions {
  db: Db;
  instanceId: number;
  /** Final status to stamp on the instance. Defaults to 'done'. */
  status?: 'done' | 'failed';
  summary?: string | null;
  outcome?: string | null;
  /** If true, skip if the instance is already in a terminal state. */
  skipIfAlreadyDone?: boolean;
  /** Keep run bookkeeping but skip the visible completion check-in task note. */
  recordCompletionNote?: boolean;
}

export interface CloseInstanceResult {
  closed: boolean;
  /** 'already_done' when skipIfAlreadyDone=true and instance was already terminal. */
  reason?: 'already_done' | 'not_found';
}

const ACTIVE_INSTANCE_STATUSES = new Set(['queued', 'dispatched', 'running']);
const TERMINAL_INSTANCE_STATUSES = new Set(['done', 'failed', 'cancelled']);

export interface CloseActiveInstanceAfterSemanticHandoffOptions {
  db: Db;
  taskId: number;
  /** If omitted, the helper resolves tasks.active_instance_id for taskId. */
  instanceId?: number | null;
  outcome: string;
  summary?: string | null;
  changedBy?: string | null;
  source?: string | null;
}

export interface CloseActiveInstanceAfterSemanticHandoffResult {
  closed: boolean;
  reason:
    | 'closed'
    | 'no_active_instance'
    | 'instance_not_found'
    | 'cross_task_instance'
    | 'not_active_instance'
    | 'already_terminal'
    | 'runtime_already_ended'
    | 'inactive_status';
  instanceId?: number;
}

function normalizePositiveInteger(value: number | null | undefined): number | null {
  if (!Number.isInteger(value) || (value ?? 0) <= 0) return null;
  return value as number;
}

/**
 * Closes the active job instance after a semantic handoff has already been
 * accepted by another lifecycle path. This intentionally does not apply an
 * outcome or route the task; it only reuses closeInstance so completion
 * check-in, active-instance cleanup, browser cleanup, and best-effort session
 * abort behavior stay centralized.
 */
export async function closeActiveInstanceAfterSemanticHandoff(
  opts: CloseActiveInstanceAfterSemanticHandoffOptions,
): Promise<CloseActiveInstanceAfterSemanticHandoffResult> {
  const { db, taskId, outcome } = opts;
  const explicitInstanceId = normalizePositiveInteger(opts.instanceId ?? null);

  const task = await db.get(`
    SELECT id, active_instance_id
    FROM tasks
    WHERE id = ?
  `, taskId) as { id: number; active_instance_id: number | null } | undefined;

  if (!task) {
    return { closed: false, reason: 'no_active_instance' };
  }

  const resolvedInstanceId = explicitInstanceId ?? normalizePositiveInteger(task.active_instance_id);
  if (resolvedInstanceId == null) {
    return { closed: false, reason: 'no_active_instance' };
  }

  const instance = await db.get(`
    SELECT id, task_id, status, runtime_ended_at, completed_at
    FROM job_instances
    WHERE id = ?
  `, resolvedInstanceId) as {
    id: number;
    task_id: number | null;
    status: string | null;
    runtime_ended_at?: string | null;
    completed_at?: string | null;
  } | undefined;

  if (!instance) {
    return { closed: false, reason: 'instance_not_found', instanceId: resolvedInstanceId };
  }

  if (instance.task_id !== taskId) {
    return { closed: false, reason: 'cross_task_instance', instanceId: resolvedInstanceId };
  }

  if (task.active_instance_id != null && task.active_instance_id !== resolvedInstanceId) {
    return { closed: false, reason: 'not_active_instance', instanceId: resolvedInstanceId };
  }

  const status = instance.status ?? '';
  if (TERMINAL_INSTANCE_STATUSES.has(status)) {
    return { closed: false, reason: 'already_terminal', instanceId: resolvedInstanceId };
  }

  if (instance.runtime_ended_at || instance.completed_at) {
    return { closed: false, reason: 'runtime_already_ended', instanceId: resolvedInstanceId };
  }

  if (!ACTIVE_INSTANCE_STATUSES.has(status)) {
    return { closed: false, reason: 'inactive_status', instanceId: resolvedInstanceId };
  }

  const summaryParts = [opts.summary?.trim(), opts.source?.trim() ? `source=${opts.source.trim()}` : null, opts.changedBy?.trim() ? `changed_by=${opts.changedBy.trim()}` : null]
    .filter((part): part is string => Boolean(part));
  const closeResult = await closeInstance({
    db,
    instanceId: resolvedInstanceId,
    status: 'done',
    summary: summaryParts.length > 0 ? summaryParts.join(' | ') : null,
    outcome,
    skipIfAlreadyDone: true,
  });

  if (!closeResult.closed) {
    return {
      closed: false,
      reason: closeResult.reason === 'not_found' ? 'instance_not_found' : 'already_terminal',
      instanceId: resolvedInstanceId,
    };
  }

  return { closed: true, reason: 'closed', instanceId: resolvedInstanceId };
}

/**
 * closeInstance — marks a job_instance as complete, records a completion
 * check-in, destroys the browser context, and asynchronously sends chat.abort
 * to terminate the agent session.
 *
 * This is a best-effort termination: session abort failures are logged but
 * do not cause the function to throw. The DB update is always authoritative.
 */
export async function closeInstance(opts: CloseInstanceOptions): Promise<CloseInstanceResult> {
  const { db, instanceId, status = 'done', summary, outcome, skipIfAlreadyDone = false, recordCompletionNote = true } = opts;

  // Use a simple SELECT on job_instances only first — avoids SQLITE_ERROR if
  // schema is minimal (e.g. in tests). Richer fields are fetched below only
  // if we actually proceed with closing.
  const basicInstance = await db.get(`SELECT id, status FROM job_instances WHERE id = ?`, instanceId) as { id: number; status: string } | undefined;
  if (!basicInstance) {
    return { closed: false, reason: 'not_found' };
  }

  if (skipIfAlreadyDone && (basicInstance.status === 'done' || basicInstance.status === 'failed')) {
    return { closed: false, reason: 'already_done' };
  }

  // Fetch full instance row with agent details (best-effort; may fail if schema is minimal)
  let instance: Record<string, unknown> | undefined;
  try {
    instance = await db.get(`
      SELECT ji.*, a.session_key AS agent_session_key, a.repo_path AS agent_repo_path, a.repo_access_mode AS agent_repo_access_mode
      FROM job_instances ji
      LEFT JOIN agents a ON a.id = ji.agent_id
      WHERE ji.id = ?
    `, instanceId) as Record<string, unknown> | undefined;
  } catch {
    instance = basicInstance as Record<string, unknown>;
  }
  if (!instance) instance = basicInstance as Record<string, unknown>;

  const finalStatus: 'done' | 'failed' = ['done', 'failed'].includes(status) ? status : 'done';

  // ── 1. Mark instance complete ─────────────────────────────────────────────
  // Use a graceful UPDATE: try with completed_at first; fall back to status-only
  // if the column doesn't exist (e.g. minimal test schemas).
  try {
    await db.run(`
      UPDATE job_instances
      SET status = ?,
          completed_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
          runtime_ended_at = COALESCE(runtime_ended_at, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')),
          runtime_end_success = COALESCE(runtime_end_success, ?),
          runtime_end_error = COALESCE(runtime_end_error, ?),
          runtime_end_source = COALESCE(runtime_end_source, 'task_outcome_auto_close')
      WHERE id = ?
    `, finalStatus, finalStatus === 'done' ? 1 : 0, finalStatus === 'failed' ? (summary ?? `Terminal outcome: ${outcome ?? finalStatus}`) : null, instanceId);
  } catch {
    try {
      await db.run(`UPDATE job_instances SET status = ? WHERE id = ?`, finalStatus, instanceId);
    } catch (e2) {
      console.warn(`[instanceClose] Could not update instance ${instanceId} status (non-fatal):`, e2 instanceof Error ? e2.message : e2);
    }
  }

  // ── 2. Record completion check-in (best-effort — may fail in minimal schemas) ─
  try {
    await recordRunCheckIn(db, {
            instanceId,
            stage: 'completion',
            summary: summary ?? null,
            outcome: outcome ?? finalStatus,
            meaningfulOutput: true,
            statusLabel: finalStatus,
            forceNote: true,
            suppressNote: !recordCompletionNote,
            runtimeEndSuccess: finalStatus === 'done',
            runtimeEndError: finalStatus === 'failed' ? (summary ?? `Terminal outcome: ${outcome ?? finalStatus}`) : null,
            runtimeEndSource: 'task_outcome_auto_close',
          });
  } catch {
    // Non-fatal in minimal-schema environments (e.g. tests without instance_artifacts)
  }

  try {
    const taskId = typeof instance.task_id === 'number'
      ? instance.task_id
      : Number.isFinite(Number(instance.task_id))
        ? Number(instance.task_id)
        : null;
    if (taskId != null) {
      await scheduleEndedActiveInstanceLinkageCleanup(db, taskId, instanceId, {
                changedBy: 'task_outcome_auto_close',
              });
    }
  } catch {
    // Non-fatal in minimal-schema environments.
  }

  try {
    // Resolve agent name for log entries
    const agentNameRow = instance.agent_id
      ? await db.get(`SELECT name, job_title FROM agents WHERE id = ?`, instance.agent_id) as { name: string; job_title: string | null } | undefined
      : undefined;
    const logJobTitle = agentNameRow?.job_title || agentNameRow?.name || String(instance.agent_id ?? 'unknown');

    if (summary) {
      await insertRuntimeLog(db, {
                instanceId,
                agentId: instance.agent_id as number | null,
                jobTitle: logJobTitle,
                level: 'info',
                message: `Agent completion report (auto-close): ${summary}`,
              });
    }

    await insertRuntimeLog(db, {
            instanceId,
            agentId: instance.agent_id as number | null,
            jobTitle: logJobTitle,
            level: 'info',
            message: `Job instance ${instanceId} auto-closed by terminal outcome (${outcome ?? finalStatus})`,
          });
  } catch {
    // Non-fatal in minimal-schema environments
  }

  // ── 3. Destroy browser context ────────────────────────────────────────────
  const agentSessionKey = instance.agent_session_key as string | null;
  const slugMatch = agentSessionKey?.match(/^agent:([^:]+):/);
  const agentSlug = slugMatch ? slugMatch[1] : null;
  if (agentSlug) {
    destroyAgentContext(agentSlug, instanceId).catch((err: unknown) => {
      console.warn(`[instanceClose] Browser context cleanup failed for instance ${instanceId} (non-fatal):`, err instanceof Error ? err.message : err);
    });
  }

  // ── 4. Terminate agent session (async, fire-and-forget) ───────────────────
  const instanceSessionKey = instance.session_key as string | null;
  if (instanceSessionKey) {
    setImmediate(() => {
      try {
        const result = abortChatRunBySessionKey(instanceSessionKey, `terminal outcome: ${outcome ?? finalStatus}`);
        if (!result.ok && result.status !== 'already_gone') {
          console.warn(`[instanceClose] Session abort non-fatal for instance ${instanceId} (status=${result.status}): ${result.error ?? 'unknown'}`);
        } else {
          console.log(`[instanceClose] Session abort for instance ${instanceId}: ${result.status}`);
        }
      } catch (err) {
        console.warn(`[instanceClose] Session abort threw for instance ${instanceId} (non-fatal):`, err instanceof Error ? err.message : err);
      }
    });
  }

  console.log(`[instanceClose] Instance ${instanceId} auto-closed (${finalStatus}) via terminal outcome: ${outcome ?? finalStatus}`);
  return { closed: true };
}
