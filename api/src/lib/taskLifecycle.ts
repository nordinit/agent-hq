import { listConfiguredTerminalStatuses } from '../domains/tasks/terminality';
import { acquireWorkspaceLease } from '../services/workspaceLease';
import { prepareWorkspaceCleanup } from '../services/workspaceSafety';
import path from 'path';
import { removeTaskWorktree } from '../services/worktreeManager';
import { removeTaskClone } from '../services/repoWorkspaceManager';
import { writeTaskHistory } from '../domains/tasks/history';
import { taskTableHasColumn } from '../domains/tasks/ownership';
import { nowTimestamp } from './timestamps';
import { afterCommit, type Db } from "../db/adapter/types";
import { abortInstanceExecutionTransport } from '../domains/runs/stopInstanceExecution';
import { columnExists as sharedColumnExists } from "../db/introspection";
import { isLiveInstanceStatus, LIVE_INSTANCE_STATUSES } from '../domains/runs/executionState';

export const ACTIVE_INSTANCE_END_GRACE_MS: number = (() => {
  const v = parseInt(process.env.ACTIVE_INSTANCE_END_GRACE_MS ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : 10_000;
})();
const pendingEndedLinkageCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Deferred linkage cleanup runs from a timer callback, so nothing can await it
// through the normal call graph. Track the in-flight promises so callers that
// need the work to be finished (notably tests, and shutdown paths) can wait on
// it deterministically instead of guessing how many microtask ticks it needs.
const inFlightEndedLinkageCleanups = new Set<Promise<void>>();

function trackEndedLinkageCleanup(work: () => Promise<void>): Promise<void> {
  const holder: { done?: Promise<void> } = {};
  holder.done = (async () => {
    try {
      await work();
    } finally {
      if (holder.done) inFlightEndedLinkageCleanups.delete(holder.done);
    }
  })();
  inFlightEndedLinkageCleanups.add(holder.done);
  return holder.done;
}

export async function flushPendingEndedActiveInstanceLinkageCleanups(): Promise<void> {
  while (inFlightEndedLinkageCleanups.size > 0) {
    await Promise.allSettled([...inFlightEndedLinkageCleanups]);
  }
}

export function clearPendingEndedActiveInstanceLinkageCleanupTimers(): number {
  const count = pendingEndedLinkageCleanupTimers.size;
  for (const timer of pendingEndedLinkageCleanupTimers.values()) {
    clearTimeout(timer);
  }
  pendingEndedLinkageCleanupTimers.clear();
  return count;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function normalizeTimestamp(raw?: string | null): number | null {
  if (!raw) return null;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const withZ = normalized.endsWith('Z') ? normalized : `${normalized}Z`;
  const ms = new Date(withZ).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function getEndedLinkageAnchorMs(runtimeEndedAt?: string | null, lifecycleOutcomePostedAt?: string | null): number | null {
  const candidates = [
    normalizeTimestamp(runtimeEndedAt),
    normalizeTimestamp(lifecycleOutcomePostedAt),
  ].filter((value): value is number => Number.isFinite(value));
  if (!candidates.length) return null;
  return Math.min(...candidates);
}

async function getEndedLinkageCleanupContext(db: Db, taskId: number, instanceId: number): Promise<{
  taskId: number;
  instanceId: number;
  tenantId: number;
  runtimeEndedAt: string | null;
  lifecycleOutcomePostedAt: string | null;
  anchorMs: number;
} | null> {
  const row = await db.get(`
    SELECT t.active_instance_id, t.tenant_id,
           ji.runtime_ended_at,
           ji.lifecycle_outcome_posted_at
    FROM tasks t
    JOIN job_instances ji ON ji.id = t.active_instance_id
      AND ji.task_id = t.id AND ji.tenant_id = t.tenant_id
    WHERE t.id = ?
  `, taskId) as {
    active_instance_id: number | null;
    tenant_id: number;
    runtime_ended_at: string | null;
    lifecycle_outcome_posted_at: string | null;
  } | undefined;

  if (!row || row.active_instance_id !== instanceId) return null;

  const anchorMs = getEndedLinkageAnchorMs(row.runtime_ended_at, row.lifecycle_outcome_posted_at);
  if (anchorMs == null) return null;

  return {
    taskId,
    instanceId,
    tenantId: row.tenant_id,
    runtimeEndedAt: row.runtime_ended_at,
    lifecycleOutcomePostedAt: row.lifecycle_outcome_posted_at,
    anchorMs,
  };
}

async function finalizeTaskTransitionRuntimeEndIfNeeded(
  db: Db,
  taskId: number,
  instanceId: number,
  changedBy?: string,
): Promise<void> {
  const row = await db.get(`
    SELECT status,
           session_key,
           runtime_ended_at,
           lifecycle_outcome_posted_at,
           task_outcome
    FROM job_instances
    WHERE id = ?
  `, instanceId) as {
    status: string;
    session_key: string | null;
    runtime_ended_at: string | null;
    lifecycle_outcome_posted_at: string | null;
    task_outcome: string | null;
  } | undefined;

  if (!row?.status || row.runtime_ended_at) return;
  if (!isLiveInstanceStatus(row.status)) return;

  const hasSemanticOutcome = Boolean(row.lifecycle_outcome_posted_at || row.task_outcome);
  if (!hasSemanticOutcome) return;

  const { applyRuntimeEndToJobInstance } = require('../domains/runs/runtimeEnd') as typeof import('../domains/runs/runtimeEnd');
  const endedAt = nowTimestamp();
  const result = await applyRuntimeEndToJobInstance(db, {
    instanceId,
    runtimeName: 'Agent HQ',
    runtimeEndSource: 'task_transition',
    changedBy: changedBy ?? 'task_lifecycle',
    event: {
      type: 'runtime-end',
      source: 'task_transition',
      sessionKey: row.session_key ?? `task:${taskId}:instance:${instanceId}`,
      success: true,
      endedAt,
      reason: 'task_transition',
    },
  });

  if (!result.changed) return;

  await db.run(`
    UPDATE job_instances
    SET status = 'done',
        completed_at = COALESCE(completed_at, runtime_ended_at, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
    WHERE id = ?
      AND status IN ('queued', 'dispatched', 'running')
      AND runtime_ended_at IS NOT NULL
  `, instanceId);

  if (row.status === 'dispatched' || row.status === 'running') {
    abortOrphanedInstanceAsync(
      db,
      instanceId,
      row.session_key ?? '',
      `task #${taskId} completed semantic handoff and detached instance #${instanceId}`,
    );
  }
}

export async function clearEndedActiveInstanceLinkageIfEligible(
  db: Db,
  taskId: number,
  instanceId: number,
  options?: {
    changedBy?: string;
    nowMs?: number;
    force?: boolean;
  },
): Promise<boolean> {
  const context = await getEndedLinkageCleanupContext(db, taskId, instanceId);
  if (!context) return false;

  const nowMs = options?.nowMs ?? Date.now();
  if (!options?.force && nowMs - context.anchorMs < ACTIVE_INSTANCE_END_GRACE_MS) {
    return false;
  }

  const result = await db.run(`
    UPDATE tasks
    SET active_instance_id = NULL,
        ${await taskTableHasColumn(db, 'agent_id') ? 'agent_id = NULL,' : ''}
        updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = ? AND tenant_id = ?
      AND active_instance_id = ?
  `, taskId, context.tenantId, instanceId);

  if (result.changes > 0) {
    try {
      await writeTaskHistory(db, taskId, options?.changedBy ?? 'task_lifecycle', 'active_instance_id', instanceId, null);
    } catch {
      // Non-fatal in minimal test schemas.
    }
  }

  return result.changes > 0;
}

export async function scheduleEndedActiveInstanceLinkageCleanup(
  db: Db,
  taskId: number,
  instanceId: number,
  options?: {
    changedBy?: string;
    nowMs?: number;
  },
): Promise<boolean> {
  const context = await getEndedLinkageCleanupContext(db, taskId, instanceId);
  if (!context) return false;

  const nowMs = options?.nowMs ?? Date.now();
  const remainingMs = Math.max(0, ACTIVE_INSTANCE_END_GRACE_MS - (nowMs - context.anchorMs));
  const key = `${taskId}:${instanceId}`;
  if (pendingEndedLinkageCleanupTimers.has(key)) {
    return true;
  }

  const runCleanup = (poolDb: Db) => async () => {
    pendingEndedLinkageCleanupTimers.delete(key);
    try {
      await poolDb.withTransaction(async tx => {
        const task = await tx.get<{ active_instance_id: number | null }>(
          'SELECT active_instance_id FROM tasks WHERE id = ? FOR UPDATE', taskId,
        );
        if (task?.active_instance_id !== instanceId) return;
        await cleanupTaskExecutionLinkage(tx, taskId, options);
      });
    } catch (err) {
      console.warn(
        `[taskLifecycle] Failed delayed active-instance cleanup for task #${taskId} instance #${instanceId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  };

  afterCommit(db, poolDb => {
    // Closing and cleanup can both schedule within one transaction, before
    // either callback has installed its timer.
    if (pendingEndedLinkageCleanupTimers.has(key)) return;
    if (remainingMs === 0) {
      setImmediate(() => { void trackEndedLinkageCleanup(runCleanup(poolDb)); });
      return;
    }
    const timer = setTimeout(() => { void trackEndedLinkageCleanup(runCleanup(poolDb)); }, remainingMs);
    timer.unref?.();
    pendingEndedLinkageCleanupTimers.set(key, timer);
  });
  return true;
}


function resolveCleanupRepoContext(row: {
  payload_sent?: string | null;
  repo_path: string | null;
  repo_access_mode: string | null;
}): { repoAccessMode: 'worktree' | 'clone' | null; repoPath: string | null } {
  try {
    if (row.payload_sent) {
      const payload = JSON.parse(row.payload_sent) as { repoAccessMode?: unknown; repoSource?: unknown };
      const payloadMode = payload.repoAccessMode === 'worktree' || payload.repoAccessMode === 'clone'
        ? payload.repoAccessMode
        : null;
      const payloadSource = typeof payload.repoSource === 'string' ? payload.repoSource : null;

      if (payloadMode === 'clone') {
        return { repoAccessMode: 'clone', repoPath: null };
      }

      if (payloadMode === 'worktree') {
        const repoPath = payloadSource?.startsWith('worktree:')
          ? payloadSource.slice('worktree:'.length) || null
          : row.repo_path;
        return { repoAccessMode: 'worktree', repoPath };
      }
    }
  } catch {
    // Fall back to legacy agent columns below.
  }

  return {
    repoAccessMode: row.repo_access_mode === 'worktree' || row.repo_access_mode === 'clone'
      ? row.repo_access_mode
      : null,
    repoPath: row.repo_path,
  };
}

export async function taskHasConfiguredTerminalStatus(db: Db, taskId: number): Promise<boolean> {
  const hasWorkflow = await sharedColumnExists(db, 'tasks', 'workflow_id');
  const hasTenant = await sharedColumnExists(db, 'tasks', 'tenant_id');
  const task = await db.get(`SELECT status, ${hasWorkflow ? 'workflow_id' : 'NULL AS workflow_id'}, ${hasTenant ? 'tenant_id' : 'NULL AS tenant_id'} FROM tasks WHERE id = ?`, taskId) as { status: string; workflow_id: number | null; tenant_id: number | null } | undefined;
  if (!task) return false;
  return (await listConfiguredTerminalStatuses(db, { workflowId: task.workflow_id, tenantId: task.tenant_id })).includes(task.status);
}

export async function cleanupTerminalTaskWorkspaces(db: Db, taskId: number): Promise<number> {
  if (!await taskHasConfiguredTerminalStatus(db, taskId)) return 0;
  const hasPayloadSent = await sharedColumnExists(db, 'job_instances', 'payload_sent');
  const hasRepoAccessMode = await sharedColumnExists(db, 'agents', 'repo_access_mode');
  const rows = await db.all(`
    SELECT DISTINCT ji.worktree_path,
           ${hasPayloadSent ? 'ji.payload_sent' : 'NULL AS payload_sent'},
           a.repo_path${hasRepoAccessMode ? ', a.repo_access_mode' : ', NULL AS repo_access_mode'}
    FROM job_instances ji
    LEFT JOIN agents a ON a.id = ji.agent_id
    WHERE (
        ji.task_id = ?
        OR ji.worktree_path = ?
        OR ji.worktree_path LIKE ?
        OR ji.worktree_path = ?
        OR ji.worktree_path LIKE ?
      )
      AND ji.worktree_path IS NOT NULL
      AND ji.worktree_path != ''
  `, taskId, `task-${taskId}`, `%/task-${taskId}`, `agent-hq-task-${taskId}`, `%/agent-hq-task-${taskId}`) as Array<{ worktree_path: string; payload_sent?: string | null; repo_path: string | null; repo_access_mode: string | null }>;

  let removed = 0;
  for (const row of rows) {
    if (!path.isAbsolute(row.worktree_path) || !/^(?:task-|agent-hq-task-)\d+$/.test(path.basename(row.worktree_path))) continue;
    let release: (() => void) | null = null;
    try {
      release = acquireWorkspaceLease(row.worktree_path);
      if (!release) continue;
      const live = await db.get(`SELECT id FROM job_instances WHERE status IN ('queued', 'dispatched', 'running') AND (task_id = ? OR worktree_path = ?) LIMIT 1`, taskId, row.worktree_path);
      if (live || !await taskHasConfiguredTerminalStatus(db, taskId)) continue;
      const safety = prepareWorkspaceCleanup(row.worktree_path);
      if (!safety.safe) {
        console.info(`[taskLifecycle] Task #${taskId}: ${safety.reason}`);
        continue;
      }
      const repoContext = resolveCleanupRepoContext(row);
      const result = repoContext.repoAccessMode === 'clone'
        ? removeTaskClone({ workspacePath: row.worktree_path })
        : removeTaskWorktree({
            repoPath: repoContext.repoPath ?? '',
            worktreePath: row.worktree_path,
          });
      if (result.removed) removed++;
      else if (result.error) {
        console.warn(`[taskLifecycle] Worktree cleanup failed for terminal task #${taskId} at ${row.worktree_path}: ${result.error}`);
      }
    } catch (err) {
      console.warn(`[taskLifecycle] Worktree cleanup error for terminal task #${taskId} at ${row.worktree_path}:`, err);
    } finally { release?.(); }
  }

  return removed;
}

/** @deprecated Use cleanupTerminalTaskWorkspaces; eligibility is configured terminality. */
export const cleanupDoneTaskWorktrees = cleanupTerminalTaskWorkspaces;

// Deferred lifecycle callbacks must never retain a transaction-bound adapter.
// This also replaces the legacy CLI abort/watchdog/session-deletion fallback.
export function abortOrphanedInstanceAsync(
  db: Db,
  instanceId: number,
  _sessionKey: string,
  reason: string,
): void {
  afterCommit(db, poolDb => {
    void trackEndedLinkageCleanup(async () => {
      try {
        const instance = await poolDb.get(`
          SELECT ji.*, a.session_key AS agent_session_key, a.openclaw_agent_id, a.runtime_type, a.runtime_config
          FROM job_instances ji LEFT JOIN agents a ON a.id = ji.agent_id AND a.tenant_id = ji.tenant_id
          WHERE ji.id = ?
        `, instanceId);
        if (!instance || typeof instance.tenant_id !== 'number') return;
        const tenantId = instance.tenant_id;
        // The task has already detached. Fence the instance before remote I/O,
        // preserving any successful semantic outcome already recorded on it.
        await poolDb.run(`
          UPDATE job_instances SET status = CASE WHEN status IN ('queued', 'dispatched', 'running') THEN 'cancelled' ELSE status END,
            completed_at = COALESCE(completed_at, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
          WHERE id = ? AND tenant_id = ?
        `, instanceId, tenantId);
        const { result } = await abortInstanceExecutionTransport(poolDb, instance, { instanceId, tenantId, reason });
        await poolDb.run(`
          UPDATE job_instances SET abort_attempted_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
            abort_status = ?, abort_error = ?,
            runtime_ended_at = CASE WHEN ? THEN COALESCE(runtime_ended_at, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')) ELSE runtime_ended_at END
          WHERE id = ? AND tenant_id = ?
        `, result?.status ?? 'failed', result?.ok ? null : result?.error ?? 'Runtime cancellation unconfirmed', result?.ok === true, instanceId, tenantId);
      } catch (err) {
        console.warn(`[taskLifecycle] Failed runtime cancellation for instance #${instanceId}:`, err instanceof Error ? err.message : err);
      }
    });
  });
}

/**
 * Clear only the expected task/run link. The caller holds the task row lock;
 * the predicate also fences delayed work from a newer replacement run.
 */
async function detachTaskInstance(
  db: Db, taskId: number, tenantId: number, instanceId: number, changedBy: string,
): Promise<boolean> {
  const result = await db.run(`
    UPDATE tasks
    SET active_instance_id = NULL, agent_id = NULL,
        updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = ? AND tenant_id = ? AND active_instance_id = ?
  `, taskId, tenantId, instanceId);
  if (result.changes > 0) {
    await writeTaskHistory(db, taskId, changedBy, 'active_instance_id', instanceId, null);
  }
  return result.changes > 0;
}

/**
 * Ownership follows the run, never the task's workflow status. A status edit
 * cannot stop a live run. Only an ended handoff, invalid link, or explicit
 * cancellation releases ownership.
 */
export async function cleanupTaskExecutionLinkage(
  db: Db,
  taskId: number,
  options: { changedBy?: string } = {},
): Promise<boolean> {
  return db.withTransaction(async tx => {
    const task = await tx.get<{
      id: number; tenant_id: number; active_instance_id: number | null;
    }>(`SELECT id, tenant_id, active_instance_id FROM tasks WHERE id = ? FOR UPDATE`, taskId);
    if (!task?.active_instance_id) return false;

    const instance = await tx.get<{
      id: number; task_id: number | null; tenant_id: number; status: string;
      runtime_ended_at: string | null; lifecycle_outcome_posted_at: string | null;
    }>(`SELECT id, task_id, tenant_id, status, runtime_ended_at, lifecycle_outcome_posted_at
        FROM job_instances WHERE id = ? FOR UPDATE`, task.active_instance_id);
    const ownsTask = instance?.task_id === task.id && instance.tenant_id === task.tenant_id;

    if (ownsTask) {
      // Outcome posting/runtime completion may still have final callbacks in
      // flight. Preserve the same grace period in synchronous and swept cleanup.
      const anchorMs = getEndedLinkageAnchorMs(instance.runtime_ended_at, instance.lifecycle_outcome_posted_at);
      if (anchorMs != null) {
        if (Date.now() - anchorMs < ACTIVE_INSTANCE_END_GRACE_MS) {
          await scheduleEndedActiveInstanceLinkageCleanup(tx, taskId, instance.id, options);
          return false;
        }
        await finalizeTaskTransitionRuntimeEndIfNeeded(tx, taskId, instance.id, options.changedBy);
      } else if (isLiveInstanceStatus(instance.status)) {
        return false;
      }
    }

    // Never cancel or mutate an unrelated instance when repairing a bad link.
    return detachTaskInstance(tx, taskId, task.tenant_id, task.active_instance_id,
      options.changedBy ?? 'task_lifecycle');
  });
}

/** Explicit cancellation, separate from ordinary task/status edits. */
export async function cancelTaskExecution(db: Db, taskId: number, changedBy: string): Promise<boolean> {
  return db.withTransaction(async tx => {
    const task = await tx.get<{
      id: number; tenant_id: number; active_instance_id: number | null;
    }>(`SELECT id, tenant_id, active_instance_id FROM tasks WHERE id = ? FOR UPDATE`, taskId);
    if (!task?.active_instance_id) return false;
    const instance = await tx.get<{
      id: number; task_id: number | null; tenant_id: number; status: string; session_key: string | null;
    }>(`SELECT id, task_id, tenant_id, status, session_key
        FROM job_instances WHERE id = ? FOR UPDATE`, task.active_instance_id);
    const detached = await detachTaskInstance(tx, taskId, task.tenant_id, task.active_instance_id, changedBy);
    if (!detached || !instance || instance.task_id !== taskId || instance.tenant_id !== task.tenant_id
      || !isLiveInstanceStatus(instance.status)) return detached;

    // Fence callbacks immediately; remote cancellation runs only after commit.
    await tx.run(`UPDATE job_instances SET status = 'cancelled',
      stop_requested_at = COALESCE(stop_requested_at, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')),
      completed_at = COALESCE(completed_at, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
      WHERE id = ? AND tenant_id = ?`, instance.id, task.tenant_id);
    if (instance.status !== 'queued') {
      abortOrphanedInstanceAsync(tx, instance.id, instance.session_key ?? '', `task #${taskId} explicitly cancelled`);
    }
    return detached;
  });
}

export async function cleanupImpossibleTaskLifecycleStates(db: Db): Promise<number> {
  // Select only broken or ended links. Healthy live runs in ANY task status
  // never need per-task cleanup or workflow-name checks.
  const rows = await db.all<{ id: number }>(`
    SELECT t.id
    FROM tasks t
    LEFT JOIN job_instances ji ON ji.id = t.active_instance_id
      AND ji.task_id = t.id AND ji.tenant_id = t.tenant_id
    WHERE t.active_instance_id IS NOT NULL
      AND (ji.id IS NULL OR ji.status NOT IN (?, ?, ?)
        OR ji.runtime_ended_at IS NOT NULL OR ji.lifecycle_outcome_posted_at IS NOT NULL)
  `, ...LIVE_INSTANCE_STATUSES);
  let cleared = 0;
  for (const row of rows) {
    if (await cleanupTaskExecutionLinkage(db, row.id, { changedBy: 'lifecycle_cleanup' })) cleared++;
  }
  return cleared;
}
