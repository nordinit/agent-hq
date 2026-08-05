import { hostname } from 'os';
import type { Db } from '../db/adapter/types';
import { applyRuntimeEndToJobInstance, markRuntimeEnded } from '../domains/runs/runtimeEnd';
import { timestampFromEpochMs } from '../lib/timestamps';
import {
  appendRuntimeCheckpoint,
  runtimeExecutionStoreAvailable,
  terminalRuntimeExecution,
} from './runtimeExecutionStore';
import { localProcessIdentity } from './localProcessSupervisor';
import { stopDurableLocalProcess } from './durableLocalProcessControl';
import type { RuntimeExecutionState } from './runtimeBoundary';
import type { RuntimeAbortResult } from './types';

interface ActiveLocalExecutionRow {
  id: number;
  tenant_id: number;
  instance_id: number;
  runtime_type: string;
  state: string;
  opaque_handle: unknown;
  runtime_ended_at: string | null;
  runtime_end_success: number | boolean | string | null;
  runtime_end_error: string | null;
  job_status: string;
  session_key: string | null;
  run_id: string | null;
}

interface TerminalLocalExecutionRow extends ActiveLocalExecutionRow {
  terminal_reason: string | null;
  terminal_error: string | null;
  terminal_metadata: unknown;
  ended_at: string | null;
}

interface LocalProcessHandle {
  kind: 'local-process';
  pid: number;
  processGroupId: number | null;
  hostname: string;
  processIdentity: string | null;
}

export interface RuntimeExecutionReconcileSummary {
  inspected: number;
  alive: number;
  pendingConfirmation: number;
  lost: number;
  converged: number;
  quarantined: number;
  skipped: number;
  errors: number;
  available: boolean;
}

export interface RuntimeExecutionReconcilerOptions {
  now?: () => number;
  currentHostname?: string;
  missingConfirmationMs?: number;
  platform?: NodeJS.Platform;
  processExists?: (target: number) => boolean | null;
  processIdentity?: (pid: number) => string | null;
  terminateDurableProcess?: (handle: unknown) => Promise<RuntimeAbortResult>;
}

const firstMissingAt = new Map<number, number>();
const quarantineEvidenceRecorded = new Set<number>();

function projectedExecutionState(
  row: Pick<ActiveLocalExecutionRow, 'runtime_end_success' | 'job_status'>,
): 'succeeded' | 'failed' | 'cancelled' {
  if (row.job_status === 'cancelled') return 'cancelled';
  const success = row.runtime_end_success === true
    || row.runtime_end_success === 1
    || row.runtime_end_success === '1'
    || (row.runtime_end_success == null && row.job_status === 'done');
  return success ? 'succeeded' : 'failed';
}

function parseHandle(value: unknown): LocalProcessHandle | null {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const handle = parsed as Record<string, unknown>;
  const processGroupId = handle.processGroupId == null ? null : Number(handle.processGroupId);
  return handle.kind === 'local-process'
    && Number.isSafeInteger(handle.pid)
    && Number(handle.pid) > 0
    && (processGroupId == null || (Number.isSafeInteger(processGroupId) && processGroupId > 0))
    && typeof handle.hostname === 'string'
    && handle.hostname.trim()
    ? {
        kind: 'local-process',
        pid: Number(handle.pid),
        processGroupId,
        hostname: handle.hostname,
        processIdentity: typeof handle.processIdentity === 'string'
          ? handle.processIdentity
          : null,
      }
    : null;
}

function localProcessExists(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves that the process exists even though this user cannot signal it.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    return null;
  }
}

async function recordQuarantineEvidence(
  db: Db,
  row: ActiveLocalExecutionRow,
  executionId: number,
  reason: string,
  handle: LocalProcessHandle,
  signalAttempted = false,
): Promise<void> {
  if (quarantineEvidenceRecorded.has(executionId)) return;
  try {
    const result = await appendRuntimeCheckpoint(db, {
      executionId,
      kind: 'reconciled',
      state: row.state as RuntimeExecutionState,
      sessionId: row.session_key,
      data: {
        decision: 'quarantined',
        reason,
        leader_pid: handle.pid,
        process_group_id: handle.processGroupId,
        signal_attempted: signalAttempted,
      },
    });
    if (result.status === 'persisted') quarantineEvidenceRecorded.add(executionId);
  } catch (error) {
    console.warn(
      `[runtime-reconciler] failed to persist quarantine evidence for execution #${executionId}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function terminalMetadata(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) as unknown; } catch { return {}; }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function terminalReason(row: TerminalLocalExecutionRow): string {
  if (row.terminal_reason?.trim()) return row.terminal_reason.trim();
  if (row.state === 'succeeded') return 'completed';
  if (row.state === 'cancelled') return 'aborted';
  return 'error';
}

function terminalJobStatus(row: TerminalLocalExecutionRow): string {
  if (row.state === 'succeeded') return 'done';
  if (row.state === 'cancelled') return 'cancelled';
  return 'failed';
}

async function repairDurableTerminalProjectionFallback(params: {
  db: Db;
  row: TerminalLocalExecutionRow;
  endedAt: string;
  success: boolean;
  reason: string;
}): Promise<void> {
  const runtimeError = params.row.terminal_error
    ?? (params.success ? null : params.reason);
  const activeRepair = await params.db.run(`
    UPDATE job_instances
    SET status = ?,
        started_at = COALESCE(started_at, ?),
        completed_at = COALESCE(completed_at, ?),
        runtime_ended_at = ?,
        runtime_end_success = ?,
        runtime_end_error = ?,
        runtime_end_source = 'runtime-reconciler'
    WHERE id = ?
      AND status IN ('queued', 'dispatched', 'running')
  `,
    terminalJobStatus(params.row),
    params.endedAt,
    params.endedAt,
    params.endedAt,
    params.success ? 1 : 0,
    runtimeError,
    Number(params.row.instance_id),
  );
  if (activeRepair.changes > 0) return;

  // The status may have become terminal concurrently, or it may already have
  // been terminal while only the runtime-end transport fields were missing.
  // Preserve that workflow outcome while filling its missing projection.
  const current = await params.db.get<{ status: string }>(`
    SELECT status FROM job_instances WHERE id = ?
  `, Number(params.row.instance_id));
  if (!current) {
    throw new Error(`job instance #${params.row.instance_id} disappeared during terminal repair`);
  }
  await markRuntimeEnded(params.db, {
    instanceId: Number(params.row.instance_id),
    nextStatus: current.status,
    endedAt: params.endedAt,
    success: params.success,
    error: runtimeError,
    source: 'runtime-reconciler',
  });
}

async function confirmTerminalProcessTreeAbsent(params: {
  db: Db;
  row: TerminalLocalExecutionRow;
  currentHostname: string;
  platform: NodeJS.Platform;
  processExists: (target: number) => boolean | null;
  inspectProcessIdentity: (pid: number) => string | null;
  terminateDurableProcess: (handle: unknown) => Promise<RuntimeAbortResult>;
}): Promise<'confirmed' | 'quarantined' | 'skipped'> {
  const executionId = Number(params.row.id);
  const handle = parseHandle(params.row.opaque_handle);
  if (!handle) return 'quarantined';
  if (handle.hostname !== params.currentHostname) return 'skipped';

  const directExists = params.processExists(handle.pid);
  const hasInspectableGroup = params.platform !== 'win32' && handle.processGroupId != null;
  if (!hasInspectableGroup) {
    await recordQuarantineEvidence(
      params.db,
      params.row,
      executionId,
      params.platform === 'win32'
        ? 'terminal_projection_process_tree_unconfirmable_without_windows_job_object'
        : 'terminal_projection_process_group_id_missing',
      handle,
    );
    return 'quarantined';
  }

  const groupExists = params.processExists(-handle.processGroupId!);
  if (groupExists === null || directExists === null) {
    await recordQuarantineEvidence(
      params.db,
      params.row,
      executionId,
      'terminal_projection_process_tree_inspection_failed',
      handle,
    );
    return 'quarantined';
  }

  if (groupExists) {
    const identityMatches = directExists === true
      && Boolean(handle.processIdentity)
      && params.inspectProcessIdentity(handle.pid) === handle.processIdentity;
    if (!identityMatches) {
      await recordQuarantineEvidence(
        params.db,
        params.row,
        executionId,
        directExists === false
          ? 'terminal_projection_leader_exited_process_group_survives'
          : 'terminal_projection_leader_identity_unverified_process_group_survives',
        handle,
      );
      return 'quarantined';
    }

    const stopped = await params.terminateDurableProcess(params.row.opaque_handle);
    if (!stopped.confirmed) {
      await recordQuarantineEvidence(
        params.db,
        params.row,
        executionId,
        'terminal_projection_process_group_cleanup_unconfirmed',
        handle,
        stopped.attempted,
      );
      return 'quarantined';
    }
    return 'confirmed';
  }

  if (directExists) {
    const observedIdentity = params.inspectProcessIdentity(handle.pid);
    // A differing durable birth fingerprint proves PID reuse, so the original
    // process is gone. Missing/unreadable identity cannot prove that: quarantine
    // instead of projecting a terminal job over a possibly live original child.
    if (!handle.processIdentity || !observedIdentity || observedIdentity === handle.processIdentity) {
      await recordQuarantineEvidence(
        params.db,
        params.row,
        executionId,
        handle.processIdentity && observedIdentity === handle.processIdentity
          ? 'terminal_projection_verified_leader_alive_outside_persisted_process_group'
          : 'terminal_projection_live_pid_identity_unverified_outside_persisted_process_group',
        handle,
      );
      return 'quarantined';
    }
  }
  return 'confirmed';
}

/**
 * Reconcile durable local-process handles after an API restart.
 *
 * A missing PID is observed twice with a grace interval before it is marked
 * lost. This avoids racing a normal child `close` callback that is about to
 * persist a successful terminal event. Cross-host and future remote handles
 * are deliberately left to their execution-target inspectors.
 */
export async function reconcileRuntimeExecutions(
  db: Db,
  options: RuntimeExecutionReconcilerOptions = {},
): Promise<RuntimeExecutionReconcileSummary> {
  const summary: RuntimeExecutionReconcileSummary = {
    inspected: 0,
    alive: 0,
    pendingConfirmation: 0,
    lost: 0,
    converged: 0,
    quarantined: 0,
    skipped: 0,
    errors: 0,
    available: false,
  };
  if (!(await runtimeExecutionStoreAvailable(db))) return summary;
  summary.available = true;

  const rows = await db.all<ActiveLocalExecutionRow>(`
    SELECT re.id, re.tenant_id, re.instance_id, re.runtime_type, re.state, re.opaque_handle,
           ji.runtime_ended_at, ji.runtime_end_success, ji.runtime_end_error,
           ji.status AS job_status, ji.session_key, ji.run_id
    FROM runtime_executions re
    JOIN job_instances ji ON ji.id = re.instance_id AND ji.tenant_id = re.tenant_id
    WHERE re.backend = 'local-process'
      AND re.state IN ('preparing', 'starting', 'running', 'interrupting')
    ORDER BY re.id
  `);
  const terminalRows = await db.all<TerminalLocalExecutionRow>(`
    SELECT re.id, re.tenant_id, re.instance_id, re.runtime_type, re.state, re.opaque_handle,
           re.terminal_reason, re.terminal_error, re.terminal_metadata, re.ended_at,
           ji.runtime_ended_at, ji.runtime_end_success, ji.runtime_end_error,
           ji.status AS job_status, ji.session_key, ji.run_id
    FROM runtime_executions re
    JOIN job_instances ji ON ji.id = re.instance_id AND ji.tenant_id = re.tenant_id
    WHERE re.backend = 'local-process'
      AND re.state IN ('succeeded', 'failed', 'cancelled', 'lost')
      AND (
        ji.runtime_ended_at IS NULL
        OR ji.status IN ('queued', 'dispatched', 'running')
      )
    ORDER BY re.id
  `);
  const now = options.now ?? Date.now;
  const currentHostname = options.currentHostname ?? hostname();
  const processExists = options.processExists ?? localProcessExists;
  const inspectProcessIdentity = options.processIdentity ?? localProcessIdentity;
  const platform = options.platform ?? process.platform;
  const terminateDurableProcess = options.terminateDurableProcess
    ?? ((handle: unknown) => stopDurableLocalProcess(handle, 1_000));
  const confirmationMs = Math.max(1_000, options.missingConfirmationMs ?? 15_000);

  // A driver may persist durable terminal truth and then lose its job projection
  // to a transient database/side-effect failure. Recover that half-commit without
  // ever hiding a process tree that is still alive.
  for (const row of terminalRows) {
    summary.inspected += 1;
    let tree: 'confirmed' | 'quarantined' | 'skipped';
    try {
      tree = await confirmTerminalProcessTreeAbsent({
        db,
        row,
        currentHostname,
        platform,
        processExists,
        inspectProcessIdentity,
        terminateDurableProcess,
      });
    } catch (error) {
      summary.errors += 1;
      console.warn(
        `[runtime-reconciler] failed to inspect or clean terminal execution #${row.id}:`,
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }
    if (tree === 'skipped') {
      summary.skipped += 1;
      continue;
    }
    if (tree === 'quarantined') {
      summary.quarantined += 1;
      continue;
    }

    try {
      const success = row.state === 'succeeded';
      const endedAt = row.ended_at ?? timestampFromEpochMs(now()) ?? new Date(now()).toISOString();
      const reason = terminalReason(row);
      const event = {
        type: 'runEnded',
        source: 'runtime-reconciler',
        sessionKey: row.session_key ?? `instance:${row.instance_id}`,
        ...(row.run_id ? { runId: row.run_id } : {}),
        success,
        endedAt,
        reason,
        ...(row.terminal_error ? { error: row.terminal_error } : {}),
        metadata: {
          ...terminalMetadata(row.terminal_metadata),
          reconciled: true,
          execution_id: Number(row.id),
          projection: 'durable_terminal_execution',
          process_group_absent: true,
        },
      };
      const activeJob = ['queued', 'dispatched', 'running'].includes(row.job_status);
      let changed = false;
      if (activeJob && !row.runtime_ended_at) {
        const projected = await applyRuntimeEndToJobInstance(db, {
          instanceId: Number(row.instance_id),
          event,
          runtimeName: row.runtime_type,
          runtimeEndSource: 'runtime-reconciler',
          changedBy: 'runtime-reconciler',
        });
        changed = projected.changed;
      }
      if (!changed) {
        await repairDurableTerminalProjectionFallback({
          db,
          row,
          endedAt,
          success,
          reason,
        });
      }
      quarantineEvidenceRecorded.delete(Number(row.id));
      summary.converged += 1;
    } catch (error) {
      summary.errors += 1;
      console.warn(
        `[runtime-reconciler] failed to repair job projection from terminal execution #${row.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  for (const row of rows) {
    summary.inspected += 1;
    const executionId = Number(row.id);

    const handle = parseHandle(row.opaque_handle);
    if (!handle || handle.hostname !== currentHostname) {
      firstMissingAt.delete(Number(row.id));
      summary.skipped += 1;
      continue;
    }

    const directExists = processExists(handle.pid);
    const hasInspectableGroup = platform !== 'win32' && handle.processGroupId != null;
    if (!hasInspectableGroup) {
      if (directExists === true && handle.processIdentity
        && inspectProcessIdentity(handle.pid) === handle.processIdentity
        && !row.runtime_ended_at) {
        firstMissingAt.delete(executionId);
        summary.alive += 1;
        continue;
      }
      await recordQuarantineEvidence(
        db,
        row,
        executionId,
        platform === 'win32'
          ? 'process_tree_unconfirmable_without_windows_job_object'
          : 'process_group_id_missing',
        handle,
      );
      firstMissingAt.delete(executionId);
      summary.quarantined += 1;
      continue;
    }

    const groupExists = processExists(-handle.processGroupId!);
    if (groupExists === null || directExists === null) {
      await recordQuarantineEvidence(db, row, executionId, 'process_tree_inspection_failed', handle);
      firstMissingAt.delete(executionId);
      summary.quarantined += 1;
      continue;
    }

    if (groupExists) {
      const identityMatches = directExists === true
        && Boolean(handle.processIdentity)
        && inspectProcessIdentity(handle.pid) === handle.processIdentity;
      if (!identityMatches) {
        // The leaderless group may still contain credential-bearing descendants,
        // but its numeric PGID is not durable authority after restart. Never
        // signal or terminalize it without birth-identity proof.
        await recordQuarantineEvidence(
          db,
          row,
          executionId,
          directExists === false
            ? 'leader_exited_process_group_survives'
            : 'leader_identity_unverified_process_group_survives',
          handle,
        );
        firstMissingAt.delete(executionId);
        summary.quarantined += 1;
        continue;
      }

      if (!row.runtime_ended_at) {
        firstMissingAt.delete(executionId);
        summary.alive += 1;
        continue;
      }

      const stopped = await terminateDurableProcess(row.opaque_handle);
      if (!stopped.confirmed) {
        await recordQuarantineEvidence(
          db,
          row,
          executionId,
          'terminal_projection_process_group_cleanup_unconfirmed',
          handle,
          stopped.attempted,
        );
        firstMissingAt.delete(executionId);
        summary.quarantined += 1;
        continue;
      }
    } else if (
      directExists
      && handle.processIdentity
      && inspectProcessIdentity(handle.pid) === handle.processIdentity
    ) {
      await recordQuarantineEvidence(db, row, executionId, 'verified_leader_alive_outside_persisted_process_group', handle);
      firstMissingAt.delete(executionId);
      summary.quarantined += 1;
      continue;
    }

    // A runtime-end projection may win the race with this durable execution
    // update. Converge only after the complete persisted group is confirmed
    // absent (or was identity-safely stopped above).
    if (row.runtime_ended_at) {
      try {
        const state = projectedExecutionState(row);
        const result = await terminalRuntimeExecution(db, {
          instanceId: Number(row.instance_id),
          tenantId: Number(row.tenant_id),
          state,
          reason: 'job_runtime_projection_terminal',
          error: row.runtime_end_error,
          endedAt: row.runtime_ended_at,
          metadata: {
            reconciled: true,
            previous_state: row.state,
            execution_id: executionId,
            projection: 'job_instances.runtime_ended_at',
            process_group_id: handle.processGroupId,
            process_group_absent: true,
          },
        });
        if (result.status !== 'persisted' || result.executionId == null) {
          summary.errors += 1;
          continue;
        }
        await appendRuntimeCheckpoint(db, {
          executionId: result.executionId,
          kind: 'reconciled',
          state,
          sessionId: row.session_key,
          data: { decision: 'converged', reason: 'job_runtime_projection_terminal', process_group_absent: true },
          createdAt: row.runtime_ended_at,
        });
        firstMissingAt.delete(executionId);
        quarantineEvidenceRecorded.delete(executionId);
        summary.converged += 1;
      } catch (error) {
        summary.errors += 1;
        console.warn(
          `[runtime-reconciler] failed to converge execution #${executionId} from job runtime projection:`,
          error instanceof Error ? error.message : String(error),
        );
      }
      continue;
    }

    const observedAt = firstMissingAt.get(executionId);
    const checkedAt = now();
    if (observedAt == null || checkedAt - observedAt < confirmationMs) {
      if (observedAt == null) firstMissingAt.set(executionId, checkedAt);
      summary.pendingConfirmation += 1;
      continue;
    }

    try {
      const endedAt = timestampFromEpochMs(checkedAt) ?? undefined;
      const error = `Persisted ${row.runtime_type} process ${handle.pid} and process group ${handle.processGroupId} are no longer present on ${currentHostname}.`;
      const projectionResult = await applyRuntimeEndToJobInstance(db, {
        instanceId: Number(row.instance_id),
        event: {
          type: 'runEnded',
          source: 'runtime-reconciler',
          sessionKey: row.session_key ?? `instance:${row.instance_id}`,
          ...(row.run_id ? { runId: row.run_id } : {}),
          success: false,
          endedAt: endedAt ?? new Date(checkedAt).toISOString(),
          reason: 'error',
          error,
          metadata: {
            reconciled: true,
            execution_id: executionId,
            previous_state: row.state,
            terminal_reason: 'local_process_missing_after_restart',
            process_group_id: handle.processGroupId,
            process_group_absent: true,
          },
        },
        runtimeName: row.runtime_type,
        runtimeEndSource: 'runtime-reconciler',
        changedBy: 'runtime-reconciler',
      });
      if (!projectionResult.changed) {
        // A concurrent runtime end may have won after the row scan. Respect that
        // outcome instead of overwriting it with `lost`. If no runtime end was
        // recorded because the instance was already in a terminal status, fill
        // only its transport projection while preserving that status.
        const currentProjection = await db.get<{
          runtime_ended_at: string | null;
          runtime_end_success: number | boolean | string | null;
          runtime_end_error: string | null;
          status: string;
        }>(`
          SELECT runtime_ended_at, runtime_end_success, runtime_end_error, status
          FROM job_instances
          WHERE id = ?
        `, Number(row.instance_id));
        if (!currentProjection) {
          throw new Error(`job instance #${row.instance_id} disappeared during runtime reconciliation`);
        }
        if (currentProjection.runtime_ended_at) {
          const state = projectedExecutionState({
            runtime_end_success: currentProjection.runtime_end_success,
            job_status: currentProjection.status,
          });
          const result = await terminalRuntimeExecution(db, {
            instanceId: Number(row.instance_id),
            tenantId: Number(row.tenant_id),
            state,
            reason: 'job_runtime_projection_terminal',
            error: currentProjection.runtime_end_error,
            endedAt: currentProjection.runtime_ended_at,
            metadata: {
              reconciled: true,
              previous_state: row.state,
              execution_id: executionId,
              projection: 'concurrent_job_runtime_end',
            },
          });
          if (result.status !== 'persisted' || result.executionId == null) {
            summary.errors += 1;
            continue;
          }
          await appendRuntimeCheckpoint(db, {
            executionId: result.executionId,
            kind: 'reconciled',
            state,
            data: { decision: 'converged', reason: 'concurrent_job_runtime_end' },
            createdAt: currentProjection.runtime_ended_at,
          });
          firstMissingAt.delete(executionId);
          summary.converged += 1;
          continue;
        }
        await markRuntimeEnded(db, {
          instanceId: Number(row.instance_id),
          nextStatus: currentProjection.status,
          endedAt: endedAt ?? new Date(checkedAt).toISOString(),
          success: false,
          error,
          source: 'runtime-reconciler',
        });
      }
      const result = await terminalRuntimeExecution(db, {
        instanceId: Number(row.instance_id),
        tenantId: Number(row.tenant_id),
        state: 'lost',
        reason: 'local_process_missing_after_restart',
        error,
        metadata: {
          reconciled: true,
          previous_state: row.state,
          execution_id: executionId,
          process_group_id: handle.processGroupId,
          process_group_absent: true,
        },
        ...(endedAt ? { endedAt } : {}),
      });
      if (result.status === 'persisted' && result.executionId != null) {
        await appendRuntimeCheckpoint(db, {
          executionId: result.executionId,
          kind: 'reconciled',
          state: 'lost',
          data: {
            decision: 'lost',
            reason: 'local_process_missing_after_restart',
            process_group_id: handle.processGroupId,
            process_group_absent: true,
          },
          ...(endedAt ? { createdAt: endedAt } : {}),
        });
        firstMissingAt.delete(executionId);
        quarantineEvidenceRecorded.delete(executionId);
        summary.lost += 1;
      } else {
        // Keep the missing observation so a later tick retries convergence.
        summary.errors += 1;
      }
    } catch (error) {
      summary.errors += 1;
      console.warn(
        `[runtime-reconciler] failed to mark execution #${executionId} lost:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return summary;
}

export function clearRuntimeExecutionReconcilerStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Runtime execution reconciler state can only be cleared in tests');
  }
  firstMissingAt.clear();
  quarantineEvidenceRecorded.clear();
}
