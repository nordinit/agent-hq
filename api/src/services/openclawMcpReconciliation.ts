import path from 'path';
import type { Db } from '../db/adapter/types';
import { gatewayRpcCall, getGatewayConnectionEpoch, type GatewayRpcCallResult } from '../runtimes/openclaw/gatewayClient';
import { serializeOpenClawMaintenance } from '../runtimes/openclaw/maintenanceCommand';
import { openClawMcpRevision } from '../runtimes/openclaw/mcpRevision';
import { redactSensitiveRuntimeText } from '../runtimes/sensitiveText';

type Input = { db: Db; agentId: number; bundlePath: string; bundlePluginId: string; configPath: string; force?: boolean };
type Receipt = { revision: string; epoch: number };
type Persisted = { desired_revision: string; applied_revision: string | null; metadata_revision: string | null;
  runtime_revision: string | null; state: string; operation_phase: string; attempts: number;
  retry_at: string | Date | null; recovery_required: boolean; error: string | null };
const applied = new Map<string, Receipt>();
const pending = new Map<string, { revision: string; promise: Promise<void> }>();
const batches = new Map<string, { ids: Set<string>; waiters: Array<(result: GatewayRpcCallResult) => void> }>();

class ApplicationFailure extends Error {
  constructor(message: string, readonly recoveryRequired: boolean, readonly retryable = false, readonly retryAfterMs = 0) { super(message); }
}

function rejectResponse(response: GatewayRpcCallResult): never {
  const failure = response.failure;
  const runtime = failure?.details?.runtime as { committed?: boolean } | undefined;
  const persistence = failure?.details?.persistence;
  // Only a structured pre-admission refusal or an explicit non-publication is safe to retry.
  const notApplied = !persistence && runtime?.committed !== true
    && (failure?.retryable === true || runtime?.committed === false || failure?.code === 'INVALID_REQUEST');
  const retryable = notApplied && (failure?.retryable === true
    || /drain|settle|busy|locked|superseded/i.test(response.error ?? ''));
  throw new ApplicationFailure(response.error ?? 'OpenClaw plugin application failed', !notApplied, retryable, failure?.retryAfterMs);
}

async function mutation(method: string, rpcParams: Record<string, unknown>): Promise<GatewayRpcCallResult> {
  const before = getGatewayConnectionEpoch();
  const response = await gatewayRpcCall({ method, rpcParams, timeoutMs: 90_000, retryOnDisconnect: false });
  if (response.ok && (!before || getGatewayConnectionEpoch() !== before)) {
    return { ok: false, error: 'OpenClaw connection changed during plugin application; inspect the runtime before retrying' };
  }
  return response;
}

function reloadPlugin(target: string, pluginId: string): Promise<GatewayRpcCallResult> {
  return new Promise(resolve => {
    let batch = batches.get(target);
    if (!batch) {
      batch = { ids: new Set(), waiters: [] };
      batches.set(target, batch);
      const queued = batch;
      setTimeout(() => {
        batches.delete(target);
        void serializeOpenClawMaintenance(target, async () => {
          const ids = Array.from(queued.ids);
          if (ids.length > 64) return { ok: false, error: 'MCP update batch exceeds the gateway limit of 64 plugins',
            failure: { code: 'INVALID_REQUEST' } };
          return mutation('plugins.reload', { plugins: ids.map(pluginId => ({ pluginId })) });
        }).then(result => queued.waiters.forEach(waiter => waiter(result)), error => queued.waiters.forEach(waiter => waiter({ ok: false, error: String(error) })));
      }, 250);
    }
    batch.ids.add(pluginId);
    batch.waiters.push(resolve);
  });
}

function applicationReceipt(response: GatewayRpcCallResult, pluginId?: string) {
  if (!response.ok) rejectResponse(response);
  const payload = (response.payload ?? response.result) as { ok?: boolean; runtime?: { generation?: number; pluginIds?: string[] }; warnings?: string[] } | undefined;
  if (payload?.ok !== true || typeof payload.runtime?.generation !== 'number'
    || (pluginId && !payload.runtime.pluginIds?.includes(pluginId))) {
    throw new ApplicationFailure('OpenClaw did not acknowledge the requested MCP plugin generation', true);
  }
  for (const warning of payload.warnings ?? []) console.warn(`[openclaw-mcp] ${redactSensitiveRuntimeText(warning)}`);
  return payload.runtime;
}

/** A disk registry result never substitutes for a running-gateway acknowledgement. */
export async function reconcileOpenClawMcp(input: Input): Promise<void> {
  const target = path.resolve(input.configPath);
  const key = `${target}:${input.agentId}`;
  const snapshot = openClawMcpRevision(input);
  const existing = pending.get(key);
  if (existing?.revision === snapshot.revision) return existing.promise;
  if (existing) { await existing.promise.catch(() => undefined); return reconcileOpenClawMcp(input); }
  const promise = reconcile(input, target, key, snapshot);
  pending.set(key, { revision: snapshot.revision, promise });
  try { await promise; }
  finally { if (pending.get(key)?.promise === promise) pending.delete(key); }
}

async function reconcile(input: Input, target: string, key: string, snapshot: ReturnType<typeof openClawMcpRevision>) {
  const { revision } = snapshot;
  let epoch = getGatewayConnectionEpoch();
  if (!epoch) {
    const health = await gatewayRpcCall({ method: 'health', timeoutMs: 10_000 });
    if (!health.ok) throw new Error(redactSensitiveRuntimeText(health.error ?? 'OpenClaw gateway unavailable'));
    epoch = getGatewayConnectionEpoch();
  }
  if (!epoch) throw new Error('OpenClaw gateway connection could not be verified');
  const current = applied.get(key);
  if (!input.force && current?.epoch === epoch && current.revision === revision) return;

  const previous = await input.db.get<Persisted>(`SELECT desired_revision, applied_revision, metadata_revision,
    runtime_revision, state, operation_phase, attempts, retry_at, recovery_required, error
    FROM openclaw_mcp_reconciliation WHERE target_key = ? AND agent_id = ?`, target, input.agentId);
  // An interrupted RPC may have published. Neither a reconnect nor a newer edit proves otherwise.
  const interrupted = previous?.state === 'pending' && ['refresh', 'reload'].includes(previous.operation_phase);
  if (!input.force && (previous?.recovery_required || interrupted)) {
    applied.delete(key);
    throw new Error(previous?.error || 'OpenClaw maintenance was interrupted after mutation began; inspect the gateway and explicitly reconcile before dispatch');
  }
  const sameRevision = previous?.desired_revision === revision;
  if (!input.force && sameRevision && previous?.state === 'failed'
    && (previous.attempts >= 3 || !previous.retry_at || new Date(previous.retry_at).getTime() > Date.now())) {
    throw new Error(previous.error || 'OpenClaw MCP configuration is awaiting recovery');
  }
  const attempts = input.force || !sameRevision ? 0 : previous?.attempts ?? 0;
  await input.db.run(`INSERT INTO openclaw_mcp_reconciliation
    (target_key, agent_id, desired_revision, materialized_revision, state, operation_phase, attempts)
    VALUES (?, ?, ?, ?, 'pending', 'prepared', ?)
    ON CONFLICT (target_key, agent_id) DO UPDATE SET desired_revision = EXCLUDED.desired_revision,
    materialized_revision = EXCLUDED.materialized_revision, state = 'pending', operation_phase = 'prepared',
    attempts = EXCLUDED.attempts, retry_at = NULL, recovery_required = false, error = NULL, updated_at = now()`,
  target, input.agentId, revision, revision, attempts);
  try {
    const phase = async (value: string) => input.db.run(`UPDATE openclaw_mcp_reconciliation
      SET operation_phase = ?, updated_at = now() WHERE target_key = ? AND agent_id = ? AND desired_revision = ?`, value, target, input.agentId, revision);
    // Metadata repair belongs to the running gateway's lifecycle, not a competing registry CLI.
    // Existing legacy mode retains its externally awaited registry fallback.
    if (process.env.AGENT_HQ_OPENCLAW_MCP_RECONCILIATION_MODE === 'on-change'
      && (input.force || previous?.metadata_revision !== snapshot.metadata || previous?.runtime_revision !== snapshot.runtime)) {
      await phase('refresh');
      applicationReceipt(await serializeOpenClawMaintenance(target, () => mutation('plugins.refresh', {})));
    }
    await phase('reload');
    const runtime = applicationReceipt(await reloadPlugin(target, input.bundlePluginId), input.bundlePluginId);
    if (openClawMcpRevision(input).revision !== revision) {
      throw new ApplicationFailure('OpenClaw MCP configuration changed during application; a newer revision must be applied', false, true);
    }
    if (getGatewayConnectionEpoch() !== epoch) throw new ApplicationFailure('OpenClaw disconnected before MCP application could be acknowledged', true);
    const written = await input.db.run(`UPDATE openclaw_mcp_reconciliation SET applied_revision = ?, metadata_revision = ?,
      runtime_revision = ?, state = 'applied', operation_phase = 'verified', receipt_json = ?, attempts = 0,
      retry_at = NULL, recovery_required = false, error = NULL, updated_at = now()
      WHERE target_key = ? AND agent_id = ? AND desired_revision = ?`, revision, snapshot.metadata, snapshot.runtime,
    JSON.stringify(runtime), target, input.agentId, revision);
    if (written.changes !== 1) throw new ApplicationFailure('OpenClaw MCP revision was superseded before acknowledgement', false, true);
    applied.set(key, { revision, epoch });
    console.log(`[openclaw-mcp] Applied agent #${input.agentId} MCP configuration; gatewayGeneration=${runtime.generation}`);
  } catch (error) {
    applied.delete(key);
    const message = redactSensitiveRuntimeText(error instanceof Error ? error.message : String(error));
    const known = error instanceof ApplicationFailure ? error : null;
    const retryable = known?.retryable && attempts + 1 < 3;
    const delayMs = Math.min(90_000, Math.max(known?.retryAfterMs ?? 0, [2000, 5000, 15000][Math.min(attempts, 2)]));
    await input.db.run(`UPDATE openclaw_mcp_reconciliation SET state = 'failed', attempts = ?, retry_at = ?,
      recovery_required = ?, error = ?, updated_at = now() WHERE target_key = ? AND agent_id = ? AND desired_revision = ?`,
    attempts + 1, retryable ? new Date(Date.now() + delayMs).toISOString() : null,
    known?.recoveryRequired ?? true, message, target, input.agentId, revision);
    throw new Error(message);
  }
}

export function resetOpenClawMcpReconciliationForTests(): void {
  applied.clear(); pending.clear();
}
