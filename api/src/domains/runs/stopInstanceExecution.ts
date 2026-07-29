import { spawnSync } from 'child_process';
import { abortChatRunBySessionKey } from '../../runtimes/OpenClawRuntime';
import { applyStopBehavior, type StopBehavior } from './instanceStop';
import { writeTaskRuntimeEndHistory } from '../tasks/history';
import { resolveRuntime } from '../../runtimes';
import { OPENCLAW_BIN, OPENCLAW_PATH } from '../../config';
import { insertRuntimeLog } from '../../lib/runtimeTenantScope';
import { nowTimestamp } from '../../lib/timestamps';
import { type Db } from "../../db/adapter/types";

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
  behavior: StopBehavior,
): Promise<StopInstanceExecutionResult> {
  const instance = await db.get(`
    SELECT ji.*, a.session_key AS agent_session_key, a.runtime_type, a.runtime_config
    FROM job_instances ji
    LEFT JOIN agents a ON a.id = ji.agent_id
    WHERE ji.id = ?
  `, id) as Record<string, unknown> | undefined;

  if (!instance) throw new Error('Instance not found');

  const env = {
    ...process.env,
    PATH: OPENCLAW_PATH,
    OPENCLAW_HIDE_BANNER: '1',
    OPENCLAW_SUPPRESS_NOTES: '1',
  };

  const sessionKey = resolveInstanceSessionKey(instance);
  const stopReason = `Agent HQ manual stop for instance ${id} (${behavior})`;

  let abortResult: ReturnType<typeof abortChatRunBySessionKey> | null = null;
  if (sessionKey) {
    abortResult = await Promise.resolve(abortChatRunBySessionKey(sessionKey, stopReason));
    await db.run(`
      UPDATE job_instances
      SET abort_attempted_at = datetime('now'),
          abort_status = ?,
          abort_error = ?
      WHERE id = ?
    `, abortResult.status, abortResult.ok ? null : abortResult.error ?? 'abort failed', id);
  }

  const agentRuntimeType = instance.runtime_type as string | null;
  if (agentRuntimeType === 'veri' || agentRuntimeType === 'hermes') {
    try {
      const runtime = resolveRuntime({
        runtime_type: agentRuntimeType,
        runtime_config: instance.runtime_config ?? null,
      });

      const runId = (instance.run_id as string | null)
        ?? (agentRuntimeType === 'hermes' ? `hermes:${id}` : `veri-${id}`);
      await runtime.abort(runId, sessionKey ?? '');
    } catch (runtimeAbortErr) {
      console.warn(
        `[instances] ${agentRuntimeType} runtime abort failed for instance ${id} (non-fatal):`,
        runtimeAbortErr instanceof Error ? runtimeAbortErr.message : String(runtimeAbortErr),
      );
    }
  }

  const cronResult = removeQueuedCronJob(instance, env);

  const abortConfirmed = abortResult
    ? (abortResult.ok || abortResult.status === 'already_gone')
    : !sessionKey;
  const runtimeUncertain = Boolean(abortResult && !abortConfirmed);

  if (abortResult?.status === 'timed_out') {
    await insertRuntimeLog(db, {
            instanceId: id,
            agentId: instance.agent_id as number | null,
            jobTitle: instance.agent_id as number | null,
            level: 'warn',
            message: `Stop for instance ${id}: chat.abort timed out — underlying runtime state is uncertain. Agent HQ proceeding with authoritative stop. Session key: ${sessionKey ?? 'none'}`,
          });
  } else if (abortResult?.status === 'failed') {
    const failureReason = abortResult.error ?? 'chat.abort failed';
    await insertRuntimeLog(db, {
            instanceId: id,
            agentId: instance.agent_id as number | null,
            jobTitle: instance.agent_id as number | null,
            level: 'warn',
            message: `Stop for instance ${id}: remote abort failed (${failureReason}) — underlying runtime state is uncertain. Agent HQ proceeding with authoritative stop. Session key: ${sessionKey ?? 'none'}`,
          });
  } else if (!sessionKey && !cronResult.removed) {
    await insertRuntimeLog(db, {
            instanceId: id,
            agentId: instance.agent_id as number | null,
            jobTitle: instance.agent_id as number | null,
            level: 'warn',
            message: `Stop for instance ${id}: no live session key and no queued cron job found — underlying runtime state is uncertain. Agent HQ proceeding with authoritative stop.`,
          });
  }

  const stopResult = await applyStopBehavior(db, id, behavior);
  const stopRuntimeMessage = runtimeUncertain
    ? `Run stopped in Agent HQ (authoritative). Underlying runtime abort ${abortResult?.status === 'timed_out' ? 'timed out' : 'failed'} — runtime state is uncertain but Agent HQ has resolved the run.`
    : abortResult?.status === 'already_gone'
      ? 'Underlying hook session was already gone; Agent HQ cleaned up the stale run state.'
      : 'Run stopped successfully.';

  await db.run(`
    UPDATE job_instances
    SET status = 'failed',
        completed_at = datetime('now'),
        runtime_ended_at = COALESCE(runtime_ended_at, datetime('now')),
        runtime_end_success = COALESCE(runtime_end_success, 0),
        runtime_end_error = COALESCE(runtime_end_error, ?),
        runtime_end_source = COALESCE(runtime_end_source, 'manual_stop')
    WHERE id = ?
  `, stopRuntimeMessage, id);

  if (instance.task_id) {
    await writeTaskRuntimeEndHistory(db, Number(instance.task_id), 'instance_stop', {
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
          message: 'Underlying hook session was already gone; Agent HQ cleaned up the stale run state.',
        }
      : {
          result: 'confirmed_stopped' as const,
          message: 'Run stopped successfully.',
        };

  await insertRuntimeLog(db, {
        instanceId: id,
        agentId: instance.agent_id as number | null,
        jobTitle: instance.agent_id as number | null,
        level: 'warn',
        message: `Job stopped manually by user (behavior=${behavior}). Abort attempted: ${Boolean(sessionKey)}. Abort status: ${sessionKey ? (abortResult?.status ?? (abortResult?.ok ? 'succeeded' : 'failed')) : 'not-attempted'}. Runtime uncertain: ${runtimeUncertain}. Cron job removed: ${cronResult.removed}. Session key: ${sessionKey ?? 'none'}. ${taskSummary}`,
      });

  return {
    id,
    behavior,
    result: stopOutcome.result,
    message: stopOutcome.message,
    runtimeUncertain,
    sessionKey,
    abortAttempted: Boolean(sessionKey),
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
