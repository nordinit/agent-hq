import { spawnSync } from 'child_process';
import { abortChatRunBySessionKey } from '../../runtimes/OpenClawRuntime';
import { applyStopBehavior, type StopBehavior } from './instanceStop';
import { writeTaskRuntimeEndHistory } from '../tasks/history';
import { resolveRuntime } from '../../runtimes';
import { OPENCLAW_BIN, OPENCLAW_PATH } from '../../config';
import { insertRuntimeLog } from '../../lib/runtimeTenantScope';
import { nowTimestamp } from '../../lib/timestamps';
import { type Db } from "../../db/adapter/types";
import { interruptRuntimeExecution } from '../../runtimes/runtimeExecutionStore';
import { stopDurableLocalProcess } from '../../runtimes/durableLocalProcessControl';
import { columnExists, tableExists } from '../../db/introspection';

type InstanceAbortStatus = 'succeeded' | 'already_gone' | 'timed_out' | 'failed';

interface InstanceAbortResult {
  attempted: boolean;
  ok: boolean;
  status: InstanceAbortStatus;
  error?: string;
}

/**
 * An explicit non-OpenClaw runtime owns its own abort transport. This keeps a
 * Claude/Hermes/Codex session key from being sent to OpenClaw's chat.abort and
 * gives future remote runtime drivers the same routing seam.
 */
export function resolveInstanceAbortTransport(
  runtimeType: unknown,
): 'openclaw-gateway' | 'runtime' {
  return typeof runtimeType === 'string' && runtimeType.trim() && runtimeType !== 'openclaw'
    ? 'runtime'
    : 'openclaw-gateway';
}

function fallbackRunId(runtimeType: string, instanceId: number): string {
  return runtimeType === 'veri' ? `veri-${instanceId}` : `${runtimeType}:${instanceId}`;
}

function resolveInstanceSessionKey(instance: Record<string, unknown>): string | null {
  const direct = typeof instance.session_key === 'string' && instance.session_key.trim()
    ? instance.session_key.trim()
    : null;
  if (direct) return direct;

  const fallback = typeof instance.agent_session_key === 'string' && instance.agent_session_key.trim()
    ? instance.agent_session_key.trim()
    : null;
  return fallback;
}

function configuredKillGraceMs(value: unknown): number {
  let config = value;
  if (typeof value === 'string') {
    try { config = JSON.parse(value) as unknown; } catch { return 10_000; }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 10_000;
  const candidate = Number((config as Record<string, unknown>).killGraceMs);
  return Number.isFinite(candidate) && candidate >= 0 ? Math.min(candidate, 30_000) : 10_000;
}

async function stopPersistedLocalProcess(
  db: Db,
  instanceId: number,
  tenantId: number,
  runtimeConfig: unknown,
): Promise<InstanceAbortResult | null> {
  if (!(await tableExists(db, 'runtime_executions'))) return null;
  const execution = await db.get<{ opaque_handle: unknown }>(`
    SELECT opaque_handle
    FROM runtime_executions
    WHERE instance_id = ?
      AND tenant_id = ?
      AND backend = 'local-process'
      AND state IN ('preparing', 'starting', 'running', 'interrupting')
    ORDER BY id DESC
    LIMIT 1
  `, instanceId, tenantId);
  if (!execution) return null;
  const result = await stopDurableLocalProcess(
    execution.opaque_handle,
    configuredKillGraceMs(runtimeConfig),
  );
  return {
    attempted: result.attempted,
    ok: result.ok && result.confirmed,
    status: result.ok && result.confirmed
      ? result.status === 'already_gone' ? 'already_gone' : 'succeeded'
      : 'failed',
    error: result.error,
  };
}

function removeQueuedCronJob(instance: Record<string, unknown>, env: NodeJS.ProcessEnv): { removed: boolean; jobId?: string | null; error?: string } {
  try {
    const payloadStr = instance.payload_sent as string | null;
    if (!payloadStr) return { removed: false, jobId: null };

    const payload = JSON.parse(payloadStr) as { args?: string[] };
    const args: string[] = payload.args ?? [];
    const nameIdx = args.indexOf('--name');
    const jobName = nameIdx !== -1 ? args[nameIdx + 1] : null;
    if (!jobName) return { removed: false, jobId: null };

    const listResult = spawnSync(OPENCLAW_BIN, ['cron', 'list', '--json'], {
      encoding: 'utf-8',
      env,
      timeout: 10000,
    });

    if (listResult.error) {
      return { removed: false, error: listResult.error.message };
    }
    if (listResult.status !== 0) {
      return { removed: false, error: listResult.stderr?.trim() || `openclaw exited with code ${listResult.status}` };
    }

    const jobs = JSON.parse(listResult.stdout || '[]') as Array<{ id: string; name: string }>;
    const match = jobs.find(job => job.name === jobName);
    if (!match) return { removed: false, jobId: null };

    const rmResult = spawnSync(OPENCLAW_BIN, ['cron', 'rm', match.id], {
      encoding: 'utf-8',
      env,
      timeout: 10000,
    });

    if (rmResult.error) {
      return { removed: false, jobId: match.id, error: rmResult.error.message };
    }
    if (rmResult.status !== 0) {
      return { removed: false, jobId: match.id, error: rmResult.stderr?.trim() || `openclaw exited with code ${rmResult.status}` };
    }

    return { removed: true, jobId: match.id };
  } catch (err) {
    return { removed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface StopInstanceExecutionResult {
  id: number;
  behavior: StopBehavior;
  result: 'confirmed_stopped' | 'already_gone' | 'stopped_runtime_uncertain';
  message: string;
  runtimeUncertain: boolean;
  sessionKey: string | null;
  abortAttempted: boolean;
  abortOk: boolean | null;
  abortStatus: 'succeeded' | 'already_gone' | 'timed_out' | 'failed' | null;
  abortError: string | null;
  cronRemoved: boolean;
  cronRemoveError: string | null;
  taskId: number | null;
  taskStatusBefore: string | null;
  taskStatusAfter: string | null;
  clearedTaskLinkage: boolean;
}

export async function stopInstanceExecution(
  db: Db,
  id: number,
  tenantId: number,
  behavior: StopBehavior,
): Promise<StopInstanceExecutionResult> {
  const jobInstancesHaveTenant = await columnExists(db, 'job_instances', 'tenant_id');
  const agentsHaveTenant = await columnExists(db, 'agents', 'tenant_id');
  if (!jobInstancesHaveTenant || !agentsHaveTenant) {
    throw new Error('Tenant-scoped instance stop is unavailable');
  }
  const instance = await db.get(`
    SELECT ji.*, a.session_key AS agent_session_key, a.runtime_type, a.runtime_config
    FROM job_instances ji
    LEFT JOIN agents a ON a.id = ji.agent_id AND a.tenant_id = ?
    WHERE ji.id = ? AND ji.tenant_id = ?
  `, tenantId, id, tenantId) as Record<string, unknown> | undefined;

  if (!instance) throw new Error('Instance not found');

  const env = {
    ...process.env,
    PATH: OPENCLAW_PATH,
    OPENCLAW_HIDE_BANNER: '1',
    OPENCLAW_SUPPRESS_NOTES: '1',
  };

  const sessionKey = resolveInstanceSessionKey(instance);
  const stopReason = `Agent HQ manual stop for instance ${id} (${behavior})`;

  const agentRuntimeType = typeof instance.runtime_type === 'string' && instance.runtime_type.trim()
    ? instance.runtime_type.trim()
    : 'openclaw';
  const abortTransport = resolveInstanceAbortTransport(agentRuntimeType);
  let abortResult: InstanceAbortResult | null = null;

  try {
    await interruptRuntimeExecution(db, { instanceId: id, tenantId, reason: stopReason });
  } catch (executionStateError) {
    // Runtime stop must still be attempted if execution-state observability is
    // temporarily unavailable; the authoritative stop below records the error.
    console.warn(
      `[instances] could not mark runtime execution interrupting for instance ${id}:`,
      executionStateError instanceof Error ? executionStateError.message : String(executionStateError),
    );
  }

  if (abortTransport === 'openclaw-gateway' && sessionKey) {
    abortResult = await Promise.resolve(abortChatRunBySessionKey(sessionKey, stopReason));
  } else if (abortTransport === 'runtime') {
    const storedRunId = typeof instance.run_id === 'string' ? instance.run_id.trim() : '';
    const runId = storedRunId || fallbackRunId(agentRuntimeType, id);
    try {
      const runtime = resolveRuntime({
        runtime_type: agentRuntimeType,
        runtime_config: instance.runtime_config ?? null,
      });
      const runtimeResult = await runtime.abort(runId, sessionKey ?? '');
      if (!runtimeResult) {
        abortResult = {
          attempted: true,
          ok: false,
          status: 'failed',
          error: `${agentRuntimeType} runtime did not return abort confirmation`,
        };
      } else if (runtimeResult.status === 'signalled') {
        abortResult = {
          attempted: runtimeResult.attempted,
          ok: runtimeResult.ok && runtimeResult.confirmed,
          status: runtimeResult.ok && runtimeResult.confirmed ? 'succeeded' : 'failed',
          error: runtimeResult.error,
        };
      } else if (runtimeResult.status === 'already_gone') {
        abortResult = {
          attempted: runtimeResult.attempted,
          ok: runtimeResult.ok && runtimeResult.confirmed,
          status: runtimeResult.ok && runtimeResult.confirmed ? 'already_gone' : 'failed',
          error: runtimeResult.error,
        };
      } else {
        // In particular, a fresh API process has no in-memory supervisor handle.
        // That is unknown runtime state, not proof the underlying CLI is gone.
        abortResult = {
          attempted: runtimeResult.attempted,
          ok: false,
          status: 'failed',
          error: runtimeResult.error ?? `${agentRuntimeType} abort target was not found`,
        };
      }

      // A signal accepted by the in-memory supervisor is not yet proof that
      // the complete process group exited. Confirm through the identity-bound
      // durable handle; this also covers API restart and another replica.
      if (!abortResult.ok) {
        const durableAbort = await stopPersistedLocalProcess(
          db,
          id,
          tenantId,
          instance.runtime_config,
        );
        if (durableAbort) abortResult = durableAbort;
      }
    } catch (runtimeAbortErr) {
      const error = runtimeAbortErr instanceof Error
        ? runtimeAbortErr.message
        : String(runtimeAbortErr);
      abortResult = { attempted: true, ok: false, status: 'failed', error };
      console.warn(
        `[instances] ${agentRuntimeType} runtime abort failed for instance ${id} (non-fatal):`,
        error,
      );
    }
  }

  if (abortResult?.attempted) {
    await db.run(`
      UPDATE job_instances
      SET abort_attempted_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
          abort_status = ?,
          abort_error = ?
      WHERE id = ? AND tenant_id = ?
    `, abortResult.status, abortResult.ok ? null : abortResult.error ?? 'abort failed', id, tenantId);
  }

  const cronResult = removeQueuedCronJob(instance, env);

  const abortConfirmed = abortResult
    ? (abortResult.ok || abortResult.status === 'already_gone')
    : abortTransport === 'openclaw-gateway' && !sessionKey;
  const runtimeUncertain = Boolean(abortResult && !abortConfirmed);

  if (abortResult?.status === 'timed_out') {
    await insertRuntimeLog(db, {
            tenantId,
            instanceId: id,
            agentId: instance.agent_id as number | null,
            jobTitle: instance.agent_id as number | null,
            level: 'warn',
            message: `Stop for instance ${id}: chat.abort timed out — underlying runtime state is uncertain. Agent HQ proceeding with authoritative stop. Session key: ${sessionKey ?? 'none'}`,
          });
  } else if (abortResult?.status === 'failed') {
    const failureReason = abortResult.error ?? 'chat.abort failed';
    await insertRuntimeLog(db, {
            tenantId,
            instanceId: id,
            agentId: instance.agent_id as number | null,
            jobTitle: instance.agent_id as number | null,
            level: 'warn',
            message: `Stop for instance ${id}: remote abort failed (${failureReason}) — underlying runtime state is uncertain. Agent HQ proceeding with authoritative stop. Session key: ${sessionKey ?? 'none'}`,
          });
  } else if (!abortResult?.attempted && !sessionKey && !cronResult.removed) {
    await insertRuntimeLog(db, {
            tenantId,
            instanceId: id,
            agentId: instance.agent_id as number | null,
            jobTitle: instance.agent_id as number | null,
            level: 'warn',
            message: `Stop for instance ${id}: no live session key and no queued cron job found — underlying runtime state is uncertain. Agent HQ proceeding with authoritative stop.`,
          });
  }

  const stopResult = await applyStopBehavior(db, id, tenantId, behavior);
  const stopRuntimeMessage = runtimeUncertain
    ? `Run stopped in Agent HQ (authoritative). Underlying runtime abort ${abortResult?.status === 'timed_out' ? 'timed out' : 'failed'} — runtime state is uncertain but Agent HQ has resolved the run.`
    : abortResult?.status === 'already_gone'
      ? 'Underlying runtime was already gone; Agent HQ cleaned up the stale run state.'
      : 'Run stopped successfully.';

  await db.run(`
    UPDATE job_instances
    SET status = 'failed',
        completed_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
        runtime_ended_at = COALESCE(runtime_ended_at, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')),
        runtime_end_success = COALESCE(runtime_end_success, 0),
        runtime_end_error = COALESCE(runtime_end_error, ?),
        runtime_end_source = COALESCE(runtime_end_source, 'manual_stop')
    WHERE id = ? AND tenant_id = ?
  `, stopRuntimeMessage, id, tenantId);

  if (stopResult.taskId) {
    await writeTaskRuntimeEndHistory(db, stopResult.taskId, 'instance_stop', {
            endedAt: nowTimestamp(),
            success: false,
            source: 'manual_stop',
            error: stopRuntimeMessage,
            lifecycleHandoff: 'missing_after_runtime_end',
          });
  }

  const taskSummary = stopResult.taskId
    ? `Task #${stopResult.taskId}: ${stopResult.taskStatusBefore ?? 'none'} -> ${stopResult.taskStatusAfter ?? 'none'}`
    : 'No linked task';

  const stopOutcome = runtimeUncertain
    ? {
        result: 'stopped_runtime_uncertain' as const,
        message: `Run stopped in Agent HQ (authoritative). Underlying runtime abort ${abortResult?.status === 'timed_out' ? 'timed out' : 'failed'} — runtime state is uncertain but Agent HQ has resolved the run.`,
      }
    : abortResult?.status === 'already_gone'
      ? {
          result: 'already_gone' as const,
          message: 'Underlying runtime was already gone; Agent HQ cleaned up the stale run state.',
        }
      : {
          result: 'confirmed_stopped' as const,
          message: 'Run stopped successfully.',
        };

  await insertRuntimeLog(db, {
        tenantId,
        instanceId: id,
        agentId: instance.agent_id as number | null,
        jobTitle: instance.agent_id as number | null,
        level: 'warn',
        message: `Job stopped manually by user (behavior=${behavior}). Abort transport: ${abortTransport}. Abort attempted: ${Boolean(abortResult?.attempted)}. Abort status: ${abortResult?.status ?? 'not-attempted'}. Runtime uncertain: ${runtimeUncertain}. Cron job removed: ${cronResult.removed}. Session key: ${sessionKey ?? 'none'}. ${taskSummary}`,
      });

  return {
    id,
    behavior,
    result: stopOutcome.result,
    message: stopOutcome.message,
    runtimeUncertain,
    sessionKey,
    abortAttempted: Boolean(abortResult?.attempted),
    abortOk: abortResult?.ok ?? null,
    abortStatus: abortResult?.status ?? null,
    abortError: abortResult?.error ?? null,
    cronRemoved: cronResult.removed,
    cronRemoveError: cronResult.error ?? null,
    taskId: stopResult.taskId,
    taskStatusBefore: stopResult.taskStatusBefore,
    taskStatusAfter: stopResult.taskStatusAfter,
    clearedTaskLinkage: stopResult.clearedTaskLinkage,
  };
}
