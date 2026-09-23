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

const LIVE_TASK_STATUSES = ['in_progress', 'dev_deploy_queued', 'dev_deploying', 'stalled'] as const;
const LIVE_INSTANCE_STATUSES = ['queued', 'dispatched', 'running'] as const;
// Dispatch attaches an instance before the visible agent_started mapping moves
// the task out of ready, so retain live ownership during that handoff window.
const ACTIVE_LINKAGE_RETAIN_STATUSES = ['ready', 'dispatched', 'in_progress', 'dev_deploy_queued', 'dev_deploying', 'stalled', 'review', 'ready_to_merge', 'deployed', 'blocked'] as const;
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

async function isQaAgent(db: Db, agentId: number | null | undefined): Promise<boolean> {
  if (!agentId) return false;

  const row = await db.get(`
    SELECT name, job_title
    FROM agents
    WHERE id = ?
  `, agentId) as { name: string | null; job_title: string | null } | undefined;
  const haystack = ((row?.job_title ?? '') + ' ' + (row?.name ?? '')).toLowerCase();

  return /\bqa\b/.test(haystack);
}

async function taskAllowsReviewExecution(db: Db, task: { agent_id?: number | null; active_instance_id: number | null }): Promise<boolean> {
  if (!task.active_instance_id || !task.agent_id || !await isQaAgent(db, task.agent_id)) return false;

  const instance = await db.get(`
    SELECT agent_id, status
    FROM job_instances
    WHERE id = ?
  `, task.active_instance_id) as { agent_id: number; status: string } | undefined;

  if (!instance) return false;
  if (instance.agent_id !== task.agent_id) return false;
  return LIVE_INSTANCE_STATUSES.includes(instance.status as typeof LIVE_INSTANCE_STATUSES[number]);
}

/**
 * Returns true when a deployment-stage instance is still live and owns
 * the task. Outcome posting closes the instance and schedules ended-linkage
 * cleanup; this guard only preserves authority while that live release run is
 * still legitimately in flight.
 */
async function taskAllowsReleaseExecution(db: Db, task: { agent_id?: number | null; active_instance_id: number | null }): Promise<boolean> {
  if (!task.active_instance_id) return false;

  const instance = await db.get(`
    SELECT agent_id, status
    FROM job_instances
    WHERE id = ?
  `, task.active_instance_id) as { agent_id: number; status: string } | undefined;

  if (!instance) return false;
  return LIVE_INSTANCE_STATUSES.includes(instance.status as typeof LIVE_INSTANCE_STATUSES[number]);
}

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

function isWithinEndedLinkageGraceWindow(
  runtimeEndedAt?: string | null,
  lifecycleOutcomePostedAt?: string | null,
  nowMs = Date.now(),
): boolean {
  const anchorMs = getEndedLinkageAnchorMs(runtimeEndedAt, lifecycleOutcomePostedAt);
  if (anchorMs == null) return false;
  return nowMs - anchorMs < ACTIVE_INSTANCE_END_GRACE_MS;
}

async function getEndedLinkageCleanupContext(db: Db, taskId: number, instanceId: number): Promise<{
  taskId: number;
  instanceId: number;
  runtimeEndedAt: string | null;
  lifecycleOutcomePostedAt: string | null;
  anchorMs: number;
} | null> {
  const row = await db.get(`
    SELECT t.active_instance_id,
           ji.runtime_ended_at,
           ji.lifecycle_outcome_posted_at
    FROM tasks t
    LEFT JOIN job_instances ji ON ji.id = t.active_instance_id
    WHERE t.id = ?
  `, taskId) as {
    active_instance_id: number | null;
    runtime_ended_at: string | null;
    lifecycle_outcome_posted_at: string | null;
  } | undefined;

  if (!row || row.active_instance_id !== instanceId) return null;

  const anchorMs = getEndedLinkageAnchorMs(row.runtime_ended_at, row.lifecycle_outcome_posted_at);
  if (anchorMs == null) return null;

  return {
    taskId,
    instanceId,
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
  if (!LIVE_INSTANCE_STATUSES.includes(row.status as typeof LIVE_INSTANCE_STATUSES[number])) return;

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
    WHERE id = ?
      AND active_instance_id = ?
  `, taskId, instanceId);

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
      await finalizeTaskTransitionRuntimeEndIfNeeded(poolDb, taskId, instanceId, options?.changedBy);
      await clearEndedActiveInstanceLinkageIfEligible(poolDb, taskId, instanceId, {
                changedBy: options?.changedBy,
                force: true,
              });
    } catch (err) {
      console.warn(
        `[taskLifecycle] Failed delayed active-instance cleanup for task #${taskId} instance #${instanceId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  };

  afterCommit(db, poolDb => {
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

export function taskAllowsActiveExecution(status: string | null | undefined): boolean {
  return Boolean(status && LIVE_TASK_STATUSES.includes(status as typeof LIVE_TASK_STATUSES[number]));
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

async function markInstanceFailed(db: Db, instanceId: number, reason: string): Promise<void> {
  try {
    await db.run(`
      UPDATE job_instances
      SET status = 'failed',
          stop_requested_at = COALESCE(stop_requested_at, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')),
          abort_attempted_at = COALESCE(abort_attempted_at, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')),
          abort_status = 'failed',
          abort_error = ?,
          error = ?,
          completed_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = ?
        AND status NOT IN ('done', 'failed', 'cancelled')
    `, reason, reason, instanceId);
  } catch (err) {
    console.error(`[taskLifecycle] failed to mark instance #${instanceId} as failed:`, err);
  }
}

// ── Exported lifecycle functions ─────────────────────────────────────────────

export async function cleanupTaskExecutionLinkageForStatus(
  db: Db,
  taskId: number,
  nextStatus?: string | null,
  options?: {
    deferEndedActiveInstanceCleanup?: boolean;
    authoritativeInstanceId?: number | null;
    changedBy?: string;
  },
): Promise<boolean> {
  const task = await db.get(`
    SELECT id, status, agent_id, active_instance_id
    FROM tasks
    WHERE id = ?
  `, taskId) as { id: number; status: string; agent_id: number | null; active_instance_id: number | null } | undefined;

  if (!task) return false;

  const effectiveStatus = nextStatus ?? task.status;
  if (effectiveStatus === task.status && await taskHasConfiguredTerminalStatus(db, taskId)) {
    await cleanupTerminalTaskWorkspaces(db, taskId);
  }

  if (!task.active_instance_id) return false;

  if (taskAllowsActiveExecution(effectiveStatus)) return false;
  if (effectiveStatus === 'review' && await taskAllowsReviewExecution(db, task)) return false;
  // Deployment-stage exception: preserve authority while a release run is still
  // live. Once an outcome closes the instance, ended-linkage cleanup clears it.
  if ((effectiveStatus === 'ready_to_merge' || effectiveStatus === 'deployed') && await taskAllowsReleaseExecution(db, task)) return false;

  if (options?.deferEndedActiveInstanceCleanup) {
    const authoritativeInstanceId = options.authoritativeInstanceId ?? task.active_instance_id;
    if (authoritativeInstanceId != null && authoritativeInstanceId === task.active_instance_id) {
      const scheduled = await scheduleEndedActiveInstanceLinkageCleanup(db, taskId, authoritativeInstanceId, {
              changedBy: options.changedBy,
            });
      if (scheduled) return false;
    }
  }

  // Capture orphaned instance info before clearing linkage
  const orphanedInstanceId = task.active_instance_id;
  const orphanedInstance = await db.get(`
    SELECT id, session_key, status
    FROM job_instances
    WHERE id = ?
  `, orphanedInstanceId) as { id: number; session_key: string | null; status: string } | undefined;

  const result = await db.run(`
    UPDATE tasks
    SET active_instance_id = NULL,
        ${await taskTableHasColumn(db, 'agent_id') ? 'agent_id = NULL,' : ''}
        updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = ?
      AND active_instance_id IS NOT NULL
  `, taskId);

  if (result.changes > 0) {
    // Recorded whether or not the orphaned instance row still exists: the link was removed
    // either way, and that removal is what a later refused lifecycle write hinges on.
    await writeTaskHistory(db, taskId, 'task_lifecycle', 'active_instance_id', orphanedInstanceId, null);
  }

  if (result.changes > 0 && orphanedInstance) {
    const { session_key: sessionKey, status: instanceStatus } = orphanedInstance;

    // Only abort instances that are still live (dispatched/running).
    // Queued instances have no active session to abort — just mark failed.
    const isLive = instanceStatus === 'dispatched' || instanceStatus === 'running';

    if (isLive) {
      // Fire-and-forget async abort — never blocks the event loop
      abortOrphanedInstanceAsync(
        db,
        orphanedInstanceId,
        sessionKey ?? '',
        `task #${taskId} cancelled/stopped (status → ${effectiveStatus})`,
      );
    } else if (instanceStatus === 'queued') {
      // Queued or live-but-sessionless: no session to abort, mark failed immediately
      await markInstanceFailed(
                db,
                orphanedInstanceId,
                `orphaned by task #${taskId} cancel/stop (status → ${effectiveStatus}); no session key to abort`,
              );
    }
    // Already-terminal instances (done/failed) are left untouched
  }

  return result.changes > 0;
}

export async function cleanupImpossibleTaskLifecycleStates(db: Db): Promise<number> {
  const rows = await db.all(`
    SELECT t.id, t.status, t.active_instance_id,
           ji.status AS instance_status,
           ji.runtime_ended_at,
           ji.lifecycle_outcome_posted_at
    FROM tasks t
    LEFT JOIN job_instances ji ON ji.id = t.active_instance_id
    WHERE t.active_instance_id IS NOT NULL
  `) as Array<{
    id: number;
    status: string;
    active_instance_id: number;
    instance_status: string | null;
    runtime_ended_at: string | null;
    lifecycle_outcome_posted_at: string | null;
  }>;

  let cleared = 0;
  const nowMs = Date.now();

  for (const row of rows) {
    const liveInstance = row.instance_status != null
      && LIVE_INSTANCE_STATUSES.includes(row.instance_status as typeof LIVE_INSTANCE_STATUSES[number]);
    const validLiveStatus = ACTIVE_LINKAGE_RETAIN_STATUSES.includes(row.status as typeof ACTIVE_LINKAGE_RETAIN_STATUSES[number]);
    if (liveInstance && validLiveStatus) {
      continue;
    }

    if (isWithinEndedLinkageGraceWindow(row.runtime_ended_at, row.lifecycle_outcome_posted_at, nowMs)) {
      continue;
    }

    const result = await db.run(`
      UPDATE tasks
      SET active_instance_id = NULL,
          ${await taskTableHasColumn(db, 'agent_id') ? 'agent_id = NULL,' : ''}
          updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = ?
        AND active_instance_id = ?
    `, row.id, row.active_instance_id);
    if (result.changes > 0) {
      // This sweep detaches links in bulk from a background pass, which makes it the easiest
      // place for a link to vanish with nothing to attribute it to.
      await writeTaskHistory(db, row.id, 'lifecycle_cleanup', 'active_instance_id', row.active_instance_id, null);
    }
    cleared += result.changes;
  }

  return cleared;
}
