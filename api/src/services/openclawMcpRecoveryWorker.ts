import type { Db } from '../db/adapter/types';
import path from 'path';
import { OPENCLAW_CONFIG_PATH } from '../config';
import { escalateMcpRecoveries, restoreMcpRecoveries, NEXT_RECOVERY_ATTEMPT_SQL, type McpRecovery } from '../lib/mcpRecovery';
import { deliverPendingNotifications } from '../lib/notificationDelivery';
import { syncAssignedMcpForAgent } from '../runtimes/mcpMaterialization';
import { redactSensitiveRuntimeText } from '../runtimes/sensitiveText';

export async function attemptMcpRecovery(db: Db, target = path.resolve(OPENCLAW_CONFIG_PATH)): Promise<void> {
  // A transaction-scoped advisory lock is released on process death. Its connection carries no
  // row writes; state/attempt updates commit separately so the escalation timer can see them.
  await db.withTransaction(async lock => {
    // Escalated (attention) incidents stay in the queue on a slower schedule; a past-deadline row
    // still `recovering` waits for escalation so the deadline alert is never skipped.
    const jobs = await db.all<McpRecovery>(`SELECT r.* FROM openclaw_mcp_recovery r JOIN agents a ON a.id = r.agent_id
      WHERE r.target_key = ? AND (r.state = 'attention' OR (r.state = 'recovering' AND r.deadline_at > now()))
        AND r.next_attempt_at <= now() AND a.enabled = 1 AND a.deleted_at IS NULL ORDER BY r.next_attempt_at LIMIT 32`, target);
    for (const job of jobs) {
      const acquired = await lock.value<boolean>('SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0))', `mcp-recovery:${job.target_key}`);
      if (!acquired) continue;
      const claimed = await db.get<McpRecovery>(`UPDATE openclaw_mcp_recovery SET attempts = attempts + 1,
        next_attempt_at = ${NEXT_RECOVERY_ATTEMPT_SQL} WHERE id = ?
        AND (state = 'attention' OR (state = 'recovering' AND deadline_at > now())) AND next_attempt_at <= now() RETURNING *`, job.id);
      if (!claimed) continue;
      try {
        // The normal per-agent materialization queue and reconciliation lock are shared with
        // manual sync and dispatch. Gateway plugin RPCs also acquire its atomic lifecycle lease;
        // a still-running pre-disconnect update refuses admission rather than overlapping.
        const result = await syncAssignedMcpForAgent({ db, agentId: job.agent_id,
          forceReconciliation: true, recoveryId: job.id, refreshPluginRegistry: true,
          materializeOpenClawGlobalConfig: true });
        if (!result.ok) throw new Error(result.error ?? 'Tool configuration recovery failed');
      } catch (error) {
        await db.run(`UPDATE openclaw_mcp_recovery SET last_error = ?, next_attempt_at = ${NEXT_RECOVERY_ATTEMPT_SQL}
          WHERE id = ? AND resolved_at IS NULL`,redactSensitiveRuntimeText(error instanceof Error ? error.message : String(error)), job.id);
      }
      return;
    }
  });
}

export function startMcpRecoveryWorker(db: Db): () => void {
  let stopped = false;
  let recovering = false;
  let escalating = false;
  let delivering = false;
  let initialized = false;
  let initializing = false;
  const tick = () => {
    if (stopped) return;
    if (!initialized) {
      if (!initializing) {
        initializing = true;
        void restoreMcpRecoveries(db).then(() => { initialized = true; tick(); })
          .catch(e => console.error('[mcp-recovery] startup recovery scan failed', String(e)))
          .finally(() => { initializing = false; });
      }
      return;
    }
    // Independent tasks: a slow plugin RPC or Telegram timeout cannot postpone the deadline.
    if (!escalating) {
      escalating = true;
      void escalateMcpRecoveries(db).catch(e => console.error('[mcp-recovery] escalation failed', String(e)))
        .finally(() => { escalating = false; });
    }
    if (!delivering) {
      delivering = true;
      void deliverPendingNotifications(db).catch(e => console.error('[mcp-recovery] alert delivery failed', String(e)))
        .finally(() => { delivering = false; });
    }
    if (!recovering && !stopped) {
      recovering = true;
      void attemptMcpRecovery(db).catch(e => console.error('[mcp-recovery] worker failed', String(e)))
        .finally(() => { recovering = false; });
    }
  };
  tick();
  const timer = setInterval(tick, 5000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
