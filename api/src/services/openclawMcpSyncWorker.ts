import fs from 'fs';
import type { Db } from '../db/adapter/types';
import { syncAssignedMcpForAgent } from '../runtimes/mcpMaterialization';
import { reconcileOpenClawMcp } from './openclawMcpReconciliation';
import { redactSensitiveRuntimeText } from '../runtimes/sensitiveText';

/** Opt-in only after the deployment has assigned this API exclusive maintenance ownership. */
export function assertOpenClawMaintenanceOwner(): void {
  if (process.env.AGENT_HQ_OPENCLAW_MCP_RECONCILIATION_MODE === 'on-change'
    && process.env.AGENT_HQ_OPENCLAW_MCP_MAINTENANCE_OWNER !== '1') {
    throw new Error('OpenClaw on-change reconciliation requires an explicitly configured maintenance owner');
  }
}

export async function drainOpenClawMcpSyncQueue(db: Db): Promise<void> {
  const jobs = await db.all<{ agent_id: number; revision: number }>(`
    SELECT agent_id, revision FROM openclaw_mcp_sync_queue
    WHERE attempts < 3 AND retry_at <= now() ORDER BY retry_at, agent_id LIMIT 32`);
  const prepared = [];
  for (const job of jobs) {
    try {
      const result = await syncAssignedMcpForAgent({ db, agentId: job.agent_id,
        refreshPluginRegistry: false, materializeOpenClawGlobalConfig: true });
      if (!result.ok) throw new Error(result.error ?? 'MCP materialization failed');
      prepared.push({ job, result });
    } catch (error) { await fail(db, job, error); }
  }
  await Promise.all(prepared.map(async ({ job, result }) => {
    try {
      if (result.bundlePath && result.bundlePluginId && result.openClawConfigPath && fs.existsSync(result.bundlePath)) {
        await reconcileOpenClawMcp({ db, agentId: job.agent_id, bundlePath: result.bundlePath,
          bundlePluginId: result.bundlePluginId, configPath: result.openClawConfigPath });
      }
      // An edit committed while we worked retains its own queue revision.
      await db.run('DELETE FROM openclaw_mcp_sync_queue WHERE agent_id = ? AND revision = ?', job.agent_id, job.revision);
    } catch (error) { await fail(db, job, error); }
  }));
}

async function fail(db: Db, job: { agent_id: number; revision: number }, error: unknown): Promise<void> {
  const message = redactSensitiveRuntimeText(error instanceof Error ? error.message : String(error));
  await db.run(`UPDATE openclaw_mcp_sync_queue SET attempts = attempts + 1,
    retry_at = now() + interval '15 seconds', error = ? WHERE agent_id = ? AND revision = ?`, message, job.agent_id, job.revision);
  console.warn(`[openclaw-mcp] Agent #${job.agent_id} configuration remains pending: ${message}`);
}

export function startOpenClawMcpSyncWorker(db: Db): () => void {
  assertOpenClawMaintenanceOwner();
  if (process.env.AGENT_HQ_OPENCLAW_MCP_RECONCILIATION_MODE !== 'on-change'
    || process.env.AGENT_HQ_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH === '1') return () => {};
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try { await drainOpenClawMcpSyncQueue(db); }
    catch (error) { console.warn('[openclaw-mcp] Queue recovery failed:', redactSensitiveRuntimeText(String(error))); }
    if (!stopped) { timer = setTimeout(() => { void tick(); }, 5000); timer.unref(); }
  };
  // Start only after HTTP listen, so MCP callbacks can reach the API.
  void tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
