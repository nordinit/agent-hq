import { randomUUID } from 'crypto';
import type { Db } from '../../db/adapter/types';
import type { RuntimeAbortTarget } from '../types';
import { gatewayWsSend } from './gatewayClient';
import { abortOpenClawRun } from './abort';

/** Shared by task dispatch and chat, including cancellation during chat.send. */
export async function sendOpenClawTurn(params: {
  sessionKey: string;
  message: string;
  timeoutMs?: number;
  gatewayUrl?: string;
  runId?: string;
  cwd?: string;
  metadata?: Record<string, unknown>;
  instance?: { db: Db; id: number; tenantId: number };
}): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const runId = params.runId ?? randomUUID();
  const target: RuntimeAbortTarget = { runtimeType: 'openclaw', runId, sessionKey: params.sessionKey,
    ...(params.gatewayUrl ? { endpoint: params.gatewayUrl } : {}),
  };
  const instance = params.instance;
  if (instance) {
    const stored = await instance.db.run(`
      UPDATE job_instances SET runtime_abort_target = ?::jsonb, run_id = ?,
        abort_status = NULL, abort_error = NULL, abort_attempted_at = NULL
      WHERE id = ? AND tenant_id = ? AND stop_requested_at IS NULL
    `, JSON.stringify(target), runId, instance.id, instance.tenantId);
    if (!stored.changes) return { ok: false, error: 'Run was stopped before dispatch' };
  }

  const result = await gatewayWsSend({ ...params, runId });
  // chat.send uses the idempotency key as its run ID. Retain an explicitly
  // returned ID for compatibility with other gateway versions.
  const actualRunId = result.runId || runId;
  if (instance) {
    if (actualRunId !== runId) {
      target.runId = actualRunId;
      await instance.db.run(`
        UPDATE job_instances SET runtime_abort_target = ?::jsonb, run_id = ?
        WHERE id = ? AND tenant_id = ? AND runtime_abort_target->>'runId' = ?
      `, JSON.stringify(target), actualRunId, instance.id, instance.tenantId, runId);
    }
    const current = await instance.db.get<{ stop_requested_at: string | null }>(`
      SELECT stop_requested_at FROM job_instances WHERE id = ? AND tenant_id = ?
    `, instance.id, instance.tenantId);
    if (!current || current.stop_requested_at) {
      // Stop may have arrived before the gateway registered this run. Retry
      // against this exact turn after send returns; never abort a newer turn.
      const aborted = await abortOpenClawRun(actualRunId, params.sessionKey, { target });
      if (aborted.ok && aborted.confirmed) {
        await instance.db.run(`
          UPDATE job_instances SET abort_status = 'succeeded', abort_error = NULL,
            abort_attempted_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
          WHERE id = ? AND tenant_id = ? AND runtime_abort_target->>'runId' = ?
        `, instance.id, instance.tenantId, actualRunId);
      }
      return { ok: false, runId: actualRunId, error: 'Run was stopped during dispatch' };
    }
  }
  return result.ok ? { ok: true, runId: actualRunId } : result;
}
