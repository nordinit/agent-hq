import { stableJson } from '../runtimes/openclaw/stableJson';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Db } from '../db/adapter/types';
import { gatewayRpcCall, getGatewayConnectionEpoch, type GatewayRpcCallResult } from '../runtimes/openclaw/gatewayClient';
import { serializeOpenClawMaintenance } from '../runtimes/openclaw/maintenanceCommand';
import { redactSensitiveRuntimeText } from '../runtimes/sensitiveText';

type Input = { db: Db; agentId: number; bundlePath: string; bundlePluginId: string; configPath: string; force?: boolean };
type Receipt = { revision: string; epoch: number };
const applied = new Map<string, Receipt>();
const pending = new Map<string, { revision: string; promise: Promise<void> }>();
const failures = new Map<string, { revision: string; epoch: number; retryAt: number; attempts: number; error: string }>();

const batches = new Map<string, { ids: Set<string>; waiters: Array<(result: GatewayRpcCallResult) => void> }>();

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
          // OpenClaw supports at most 64 distinct plugin IDs per request.
          if (ids.length > 64) return { ok: false, error: 'MCP update batch exceeds the gateway limit of 64 plugins' };
          return gatewayRpcCall({ method: 'plugins.reload', rpcParams: { plugins: ids.map(pluginId => ({ pluginId })) },
            timeoutMs: 90_000, retryOnDisconnect: false });
        }).then(result => queued.waiters.forEach(waiter => waiter(result)), error => queued.waiters.forEach(waiter => waiter({ ok: false, error: String(error) })));
      }, 250);
    }
    batch.ids.add(pluginId);
    batch.waiters.push(resolve);
  });
}

function revisionOf(input: Input): string {
  const config = JSON.parse(fs.readFileSync(input.configPath, 'utf8'));
  return createHash('sha256')
    .update(fs.readFileSync(input.bundlePath))
    .update(fs.readFileSync(path.join(path.dirname(input.bundlePath), '.claude-plugin', 'plugin.json')))
    .update(stableJson({ plugins: config.plugins, agents: config.agents, mcp: config.mcp, executable: process.env.OPENCLAW_BIN }))
    .digest('hex');
}

/** A disk registry result never substitutes for a running-gateway acknowledgement. */
export async function reconcileOpenClawMcp(input: Input): Promise<void> {
  const target = path.resolve(input.configPath);
  const key = `${target}:${input.agentId}`;
  const revision = revisionOf(input);
  let epoch = getGatewayConnectionEpoch();
  if (!epoch) {
    // Establish a fresh connection with a read before considering any mutation.
    const health = await gatewayRpcCall({ method: 'health', timeoutMs: 10_000 });
    if (!health.ok) throw new Error(redactSensitiveRuntimeText(health.error ?? 'OpenClaw gateway unavailable'));
    epoch = getGatewayConnectionEpoch();
  }
  const current = applied.get(key);
  if (!input.force && epoch > 0 && current?.epoch === epoch && current.revision === revision) return;
  const existing = pending.get(key);
  if (existing?.revision === revision) return existing.promise;
  if (existing) { await existing.promise.catch(() => undefined); return reconcileOpenClawMcp(input); }
  const failure = failures.get(key);
  if (!input.force && failure?.revision === revision && (failure.attempts >= 3 || (failure.epoch === epoch && Date.now() < failure.retryAt))) {
    throw new Error(failure.error);
  }

  const promise = (async () => {
    await input.db.run(`INSERT INTO openclaw_mcp_reconciliation
      (target_key, agent_id, desired_revision, state) VALUES (?, ?, ?, 'pending')
      ON CONFLICT (target_key, agent_id) DO UPDATE SET desired_revision = EXCLUDED.desired_revision,
      state = 'pending', error = NULL, updated_at = now()`, target, input.agentId, revision);
    try {
      // Mutation calls cannot be automatically replayed after a disconnect:
      // the gateway may already have published the new generation.
      const response = await reloadPlugin(target, input.bundlePluginId);
      if (!response.ok) throw new Error(response.error ?? 'OpenClaw plugin application failed');
      const payload = (response.payload ?? response.result) as { ok?: boolean; runtime?: { generation?: number; pluginIds?: string[] }; warnings?: string[] } | undefined;
      if (payload?.ok !== true || typeof payload.runtime?.generation !== 'number' || !payload.runtime.pluginIds?.includes(input.bundlePluginId)) {
        throw new Error('OpenClaw did not acknowledge the requested MCP plugin generation');
      }
      if (revisionOf(input) !== revision) throw new Error('OpenClaw MCP configuration changed during application; a newer revision must be applied');
      const appliedEpoch = getGatewayConnectionEpoch();
      if (!appliedEpoch) throw new Error('OpenClaw disconnected before MCP application could be acknowledged');
      await input.db.run(`UPDATE openclaw_mcp_reconciliation SET applied_revision = ?, state = 'applied',
        receipt_json = ?, error = NULL, updated_at = now() WHERE target_key = ? AND agent_id = ? AND desired_revision = ?`,
      revision, JSON.stringify(payload.runtime), target, input.agentId, revision);
      applied.set(key, { revision, epoch: appliedEpoch });
      failures.delete(key);
      console.log(`[openclaw-mcp] Applied agent #${input.agentId} MCP configuration; gatewayGeneration=${payload.runtime.generation}`);
      for (const warning of payload.warnings ?? []) console.warn(`[openclaw-mcp] ${redactSensitiveRuntimeText(warning)}`);
    } catch (error) {
      applied.delete(key);
      const message = redactSensitiveRuntimeText(error instanceof Error ? error.message : String(error));
      // Keep an uncertain application visible, rather than replaying a mutation
      // in a tight dispatch loop. A reconnect or changed revision can recover.
      const attempts = failures.get(key)?.revision === revision ? failures.get(key)!.attempts + 1 : 1;
      const retryable = /locked|busy|superseded|configuration changed/i.test(message) && attempts < 3;
      failures.set(key, { revision, epoch: getGatewayConnectionEpoch(), attempts,
        retryAt: retryable ? Date.now() + [2000, 5000, 15000][attempts - 1] : Infinity, error: message });
      await input.db.run(`UPDATE openclaw_mcp_reconciliation SET state = 'failed', error = ?, updated_at = now()
        WHERE target_key = ? AND agent_id = ? AND desired_revision = ?`, message, target, input.agentId, revision);
      throw new Error(message);
    }
  })();
  pending.set(key, { revision, promise });
  try { await promise; }
  finally { if (pending.get(key)?.promise === promise) pending.delete(key); }
}

export function resetOpenClawMcpReconciliationForTests(): void {
  applied.clear(); pending.clear(); failures.clear();
}
