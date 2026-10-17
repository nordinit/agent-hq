import { getDb } from '../db/client';
import { notifyTelegram } from '../integrations/telegram';
import { HEARTBEAT_STALE_MS, START_CHECKIN_GRACE_MS } from '../domains/runs/observability';
import { listConfiguredTerminalStatuses } from '../domains/tasks/terminality';
import { writeTaskHistory } from '../domains/tasks/history';
import { cleanupTerminalTaskWorkspaces } from '../lib/taskLifecycle';
import { pruneOrphanedWorktrees, resolveWorktreeBasePath } from '../services/worktreeManager';
import { abortInstanceExecutionTransport } from '../domains/runs/stopInstanceExecution';
import { taskTableHasColumn } from '../domains/tasks/ownership';
import { createNotificationRecord } from '../lib/notifications';
import { getActiveTenantId } from '../lib/tenantContext';
import { insertRuntimeLog } from '../lib/runtimeTenantScope';
import { nowTimestamp, timestampFromDate } from '../lib/timestamps';
import { type Db } from "../db/adapter/types";
import { columnExists as sharedColumnExists } from "../db/introspection";

const DEFAULT_TIMEOUT_MINUTES = 20;
const DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MINUTES * 60_000;
const POLL_INTERVAL_MS = 60_000; // check every 60s
const WORKTREE_PRUNE_INTERVAL_MS = 30 * 60_000; // prune orphaned worktrees every 30 min

interface WatchdogRow {
  id: number;
  agent_id: number;
  status: string;
  dispatched_at: string | null;
  created_at: string;
  started_at: string | null;
  task_id: number | null;
  session_key: string | null;
  timeout_seconds: number | null;
  startup_grace_seconds: number | null;
  heartbeat_stale_seconds: number | null;
  worktree_path: string | null;
  runtime_type: string | null;
  runtime_config: string | null;
  agent_session_key: string | null;
  tenant_id: number | null;
  run_id: string | null;
  repo_path: string | null;
  first_agent_call_at: string | null;
  last_agent_call_at: string | null;
  agent_name: string | null;
  job_title: string | null;
  task_title: string | null;
}

interface WatchdogDecision {
  shouldFail: boolean;
  reason: string | null;
  elapsedMs: number;
}

const WATCHDOG_ROW_SELECT = `
  SELECT ji.id, ji.agent_id, ji.status, ji.dispatched_at, ji.created_at,
         ji.started_at, ji.task_id, ji.session_key, ji.worktree_path,
         ji.tenant_id, ji.run_id, ji.runtime_abort_target, ji.stop_requested_at, ji.abort_status,
         a.timeout_seconds, a.repo_path, a.runtime_type, a.runtime_config,
         a.session_key AS agent_session_key, a.openclaw_agent_id,
         a.startup_grace_seconds, a.heartbeat_stale_seconds,
         ji.first_agent_call_at, ji.last_agent_call_at,
         a.name AS agent_name,
         a.job_title AS job_title,
         t.title AS task_title
    FROM job_instances ji
    LEFT JOIN agents a ON a.id = ji.agent_id
    LEFT JOIN tasks t ON t.id = ji.task_id
`;

async function tableHasColumn(db: Db, table: string, column: string): Promise<boolean> {
    return await sharedColumnExists(db, table, column);
}

async function resolveNotificationTenantId(db: Db, taskId: number | null): Promise<number> {
  if (taskId && await tableHasColumn(db, 'tasks', 'tenant_id')) {
    try {
      const row = await db.get(`SELECT tenant_id FROM tasks WHERE id = ?`, taskId) as { tenant_id: number | null } | undefined;
      const tenantId = Number(row?.tenant_id);
      if (Number.isInteger(tenantId) && tenantId > 0) return tenantId;
    } catch {
      // Fall through to active tenant.
    }
  }
  return await getActiveTenantId(db);
}

async function recordWatchdogStaleNotification(
  db: Db,
  inst: WatchdogRow,
  params: { actorLabel: string; elapsedMin: number; reason: string },
): Promise<void> {
  try {
    const taskPart = inst.task_id ? `Task #${inst.task_id}` : 'No linked task';
    const agentPart = inst.agent_name || inst.job_title
      ? `Agent: ${[inst.agent_name, inst.job_title].filter(Boolean).join(' / ')}`
      : `Agent #${inst.agent_id}`;
    await createNotificationRecord(db, {
            tenantId: await resolveNotificationTenantId(db, inst.task_id),
            type: 'watchdog_stale_run',
            title: `⏰ Watchdog auto-failed ${taskPart}`,
            body: [
              `${params.actorLabel} auto-failed after ${params.elapsedMin}m.`,
              `Reason: ${params.reason}`,
              `Instance #${inst.id}${inst.task_id ? ` · Task #${inst.task_id}` : ''} · ${agentPart}`,
            ].join('\n'),
            source: 'watchdog',
            outlet: 'agent_hq',
            metadata: {
              instanceId: inst.id,
              taskId: inst.task_id,
              agentId: inst.agent_id,
              agentName: inst.agent_name,
              jobTitle: inst.job_title,
              reason: params.reason,
              elapsedMin: params.elapsedMin,
            },
          });
  } catch (err) {
    console.error('[watchdog] Failed to record stale-run notification:', err);
  }
}

async function recordWorktreePruneNotification(
  db: Db,
  agent: { id: number; name: string | null; tenant_id?: number | null; project_tenant_id?: number | null },
  prunedCount: number,
): Promise<void> {
  try {
    const agentLabel = agent.name || `agent #${agent.id}`;
    const agentTenantId = Number(agent.tenant_id);
    const projectTenantId = Number(agent.project_tenant_id);
    const tenantId = Number.isInteger(agentTenantId) && agentTenantId > 0
      ? agentTenantId
      : Number.isInteger(projectTenantId) && projectTenantId > 0
        ? projectTenantId
        : await getActiveTenantId(db);
    await createNotificationRecord(db, {
            tenantId,
            type: 'worktree_pruned',
            title: `🧹 Watchdog pruned ${prunedCount} worktree${prunedCount === 1 ? '' : 's'}`,
            body: `Pruned ${prunedCount} orphaned worktree${prunedCount === 1 ? '' : 's'} for ${agentLabel}.`,
            source: 'watchdog',
            outlet: 'agent_hq',
            metadata: {
              agentId: agent.id,
              agentName: agent.name,
              prunedCount,
            },
          });
  } catch (err) {
    console.error('[watchdog] Failed to record worktree prune notification:', err);
  }
}

export async function runWorktreePrunePass(db: Db = getDb()): Promise<void> {
  const hasAgentTenantId = await tableHasColumn(db, 'agents', 'tenant_id');
  const hasAgentProjectId = await tableHasColumn(db, 'agents', 'project_id');
  const hasProjectTenantId = hasAgentProjectId && await tableHasColumn(db, 'projects', 'tenant_id');
  // Historical run paths remain eligible after repo settings or agent paths change.
  const recorded = await db.all(`SELECT DISTINCT task_id FROM job_instances WHERE worktree_path IS NOT NULL AND task_id IS NOT NULL`) as Array<{ task_id: number }>;
  for (const row of recorded) await cleanupTerminalTaskWorkspaces(db, Number(row.task_id));
  const agents = await db.all(`
    SELECT a.id, a.name, a.workspace_path, a.os_user,
      ${hasAgentTenantId ? 'a.tenant_id' : 'NULL'} AS tenant_id,
      ${hasAgentProjectId ? 'a.project_id' : 'NULL'} AS project_id,
      ${hasProjectTenantId ? 'p.tenant_id' : 'NULL'} AS project_tenant_id
    FROM agents a
    ${hasAgentProjectId ? 'LEFT JOIN projects p ON p.id = a.project_id' : ''}
    WHERE a.workspace_path IS NOT NULL AND a.workspace_path != ''
  `) as Array<{ id: number; name: string | null; tenant_id: number | null; project_id: number | null; project_tenant_id: number | null; workspace_path: string; os_user: string | null }>;
  const visited = new Set<string>();
  for (const agent of agents) {
    const basePath = resolveWorktreeBasePath({
      osUser: agent.os_user,
      workspacePath: agent.workspace_path,
    });
    if (visited.has(basePath)) continue;
    visited.add(basePath);
    const result = await pruneOrphanedWorktrees({
      basePath,
      maxAgeHours: 24,
      getTaskRecord: async (taskId: number) => {
        const row = await db.get(`
          SELECT status, ${await tableHasColumn(db, 'tasks', 'workflow_id') ? 'workflow_id' : 'NULL AS workflow_id'}, ${await tableHasColumn(db, 'tasks', 'tenant_id') ? 'tenant_id' : 'NULL AS tenant_id'}
          FROM tasks
          WHERE id = ?
        `, taskId) as { status: string; workflow_id: number | null; tenant_id: number | null } | undefined;
        return row
          ? { exists: true, status: row.status, terminal: (await listConfiguredTerminalStatuses(db, { workflowId: row.workflow_id, tenantId: row.tenant_id })).includes(row.status) }
          : { exists: false, status: null };
      },
      hasLiveInstance: async (worktreePath: string, taskId: number | null) => {
        const folderName = worktreePath.split('/').pop() ?? worktreePath;
        const row = await db.get(`
          SELECT COUNT(*) as n
          FROM job_instances
          WHERE status IN ('queued', 'dispatched', 'running')
            AND (
              task_id = ?
              OR worktree_path = ?
              OR worktree_path = ?
              OR worktree_path LIKE ?
            )
        `, taskId, worktreePath, folderName, `%/${folderName}`) as { n: number };
        return row.n > 0;
      },
    });

    for (const error of result.errors) console.info(`[watchdog] Workspace retained: ${error}`);
    if (result.pruned.length > 0) {
      const agentLabel = agent.name || `agent #${agent.id}`;
      console.log(`[watchdog] Pruned ${result.pruned.length} orphaned worktree(s) for ${agentLabel}`);
      await recordWorktreePruneNotification(db, agent, result.pruned.length);
      await notifyTelegram(`🧹 Watchdog: pruned ${result.pruned.length} orphaned worktree(s) for ${agentLabel}`);
    }
  }
}

function normalizeTimestamp(raw?: string | null): number | null {
  if (!raw) return null;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const withZ = normalized.endsWith('Z') ? normalized : `${normalized}Z`;
  const ms = new Date(withZ).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function pickLatestTimestamp(...values: Array<string | null | undefined>): number | null {
  let latest: number | null = null;
  for (const value of values) {
    const parsed = normalizeTimestamp(value);
    if (parsed !== null && (latest === null || parsed > latest)) latest = parsed;
  }
  return latest;
}

/**
 * Build a compact human-readable label for a watchdog notification.
 * Preferred shape: "Kepler / Acme — Backend" (agent / job title)
 * Falls back to agent-only, job-only, or "unknown agent" when data is missing.
 * Appends task title in quotes when available and fits.
 */
export function formatActorLabel(inst: Pick<WatchdogRow, 'agent_name' | 'job_title' | 'task_title'>): string {
  const parts: string[] = [];
  if (inst.agent_name) parts.push(inst.agent_name);
  if (inst.job_title) parts.push(inst.job_title);
  let label = parts.length > 0 ? parts.join(' / ') : 'unknown agent';
  if (inst.task_title) label += ` — "${inst.task_title}"`;
  return label;
}

export function evaluateWatchdogDecision(inst: WatchdogRow, now = new Date()): WatchdogDecision {
  const timeoutMs = inst.timeout_seconds && inst.timeout_seconds > 0
    ? inst.timeout_seconds * 1000
    : DEFAULT_TIMEOUT_MS;

  // Per-agent overrides for startup grace and heartbeat stale; fall back to global defaults.
  const effectiveStartCheckinGraceMs = inst.startup_grace_seconds && inst.startup_grace_seconds > 0
    ? inst.startup_grace_seconds * 1000
    : START_CHECKIN_GRACE_MS;
  const effectiveHeartbeatStaleMs = inst.heartbeat_stale_seconds && inst.heartbeat_stale_seconds > 0
    ? inst.heartbeat_stale_seconds * 1000
    : HEARTBEAT_STALE_MS;

  const queuedAtMs = pickLatestTimestamp(inst.dispatched_at, inst.created_at);
  // Old rows may have a start timestamp, but runtime telemetry never renews it.
  const startedAtMs = normalizeTimestamp(inst.first_agent_call_at)
    ?? normalizeTimestamp(inst.started_at);

  // Pre-start lifecycle: queued/dispatched work (or a "running" row with no actual start signal yet)
  // should be judged by startup grace from dispatch/creation, not by full execution timeout.
  if (!startedAtMs) {
    const startupElapsedMs = queuedAtMs === null ? 0 : now.getTime() - queuedAtMs;
    if (startupElapsedMs >= effectiveStartCheckinGraceMs) {
      return {
        shouldFail: true,
        reason: `startup timeout: no Agent HQ call/start within ${Math.floor(effectiveStartCheckinGraceMs / 60000)}m`,
        elapsedMs: startupElapsedMs,
      };
    }
    return { shouldFail: false, reason: null, elapsedMs: startupElapsedMs };
  }

  const executionElapsedMs = now.getTime() - startedAtMs;
  if (executionElapsedMs >= timeoutMs) {
    return {
      shouldFail: true,
      reason: `execution timeout: exceeded ${Math.ceil(timeoutMs / 60000)}m from real start`,
      elapsedMs: executionElapsedMs,
    };
  }

  const lastLiveSignalMs = normalizeTimestamp(inst.last_agent_call_at) ?? startedAtMs;
  const staleElapsedMs = now.getTime() - lastLiveSignalMs;
  if (staleElapsedMs >= effectiveHeartbeatStaleMs) {
    return {
      shouldFail: true,
      reason: `stale run: no authenticated Agent HQ call for ${Math.floor(staleElapsedMs / 60000)}m`,
      elapsedMs: executionElapsedMs,
    };
  }

  return { shouldFail: false, reason: null, elapsedMs: executionElapsedMs };
}

/** Abort transport is used only after expiry; it is never consulted for liveness. */
async function abortStuckInstanceExecution(db: Db, inst: WatchdogRow, reason: string): Promise<void> {
  const tenantId = Number(inst.tenant_id);
  if (!Number.isInteger(tenantId) || tenantId <= 0) return;

  try {
    const attempt = await abortInstanceExecutionTransport(db, inst as unknown as Record<string, unknown>, {
      instanceId: inst.id,
      tenantId,
      reason,
    });
    if (attempt.result?.attempted && !attempt.result.ok && attempt.result.status !== 'already_gone') {
      console.warn(
        `[watchdog] Abort for instance #${inst.id} via ${attempt.transport} did not confirm` +
        ` (status=${attempt.result.status}): ${attempt.result.error ?? 'unknown'}`,
      );
    }
  } catch (err) {
    // Expiry has already committed. Preserve the abort failure for diagnosis
    // without losing ownership cleanup or the stale-run notification.
    console.warn(
      `[watchdog] Abort threw for instance #${inst.id} (non-fatal):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function failStuckInstance(db: Db, candidate: WatchdogRow, now: Date): Promise<void> {
  const expired = await db.withTransaction(async tx => {
    // The activity UPDATE takes this same row lock. After waiting for it, read
    // again in a fresh statement so a call arriving during the scan wins.
    const locked = await tx.get(`SELECT id FROM job_instances WHERE id = ?
      AND status IN ('running', 'dispatched', 'queued') FOR UPDATE`, candidate.id);
    if (!locked) return null;
    const currentInst = await tx.get<WatchdogRow>(`${WATCHDOG_ROW_SELECT} WHERE ji.id = ?`, candidate.id);
    if (!currentInst) return null;
    const decision = evaluateWatchdogDecision(currentInst, now);
    if (!decision.shouldFail || !decision.reason) return null;
    const completedAt = timestampFromDate(now) ?? nowTimestamp();
    await tx.run(`UPDATE job_instances SET status = 'failed', error = ?, completed_at = ?,
      runtime_ended_at = COALESCE(runtime_ended_at, ?), runtime_end_success = COALESCE(runtime_end_success, 0),
      runtime_end_error = COALESCE(runtime_end_error, ?), runtime_end_source = COALESCE(runtime_end_source, 'watchdog')
      WHERE id = ?`, `Watchdog: ${decision.reason}`, completedAt, completedAt, `Watchdog: ${decision.reason}`, currentInst.id);
    return { currentInst, decision, decisionReason: decision.reason };
  });
  if (!expired) return;
  const { currentInst, decision, decisionReason } = expired;
  const elapsedMin = Math.floor(decision.elapsedMs / 60000);
  await abortStuckInstanceExecution(db, currentInst, `Watchdog: ${decisionReason}`);

  if (currentInst.task_id) {
    const cleared = await db.run(`
      UPDATE tasks
      SET active_instance_id = NULL,
          ${await taskTableHasColumn(db, 'agent_id') ? 'agent_id = NULL,' : ''}
          updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = ? AND active_instance_id = ?
    `, currentInst.task_id, currentInst.id);
    if (cleared.changes > 0) {
      await writeTaskHistory(db, currentInst.task_id, 'watchdog', 'active_instance_id', String(currentInst.id), null);
    }
  }

  await insertRuntimeLog(db, {
          instanceId: currentInst.id,
          agentId: currentInst.agent_id,
          taskId: currentInst.task_id,
          level: 'warn',
          message: `Watchdog: instance #${currentInst.id} was auto-failed from "${currentInst.status}" after ${elapsedMin}m — ${decisionReason} (task_id=${currentInst.task_id ?? 'none'})`,
        });

  const actorLabel = formatActorLabel(currentInst);
  console.log(`[watchdog] Auto-failed instance #${currentInst.id} (${elapsedMin}m elapsed, task=${currentInst.task_id ?? 'none'}) — ${decisionReason}`);
  await recordWatchdogStaleNotification(db, currentInst, { actorLabel, elapsedMin, reason: decisionReason });
  await notifyTelegram(`⏰ Watchdog: ${actorLabel} auto-failed after ${elapsedMin}m (instance #${currentInst.id}${currentInst.task_id ? `, task #${currentInst.task_id}` : ''}) — ${decisionReason}`);
}

export async function runWatchdogPass(db: Db, now = new Date()): Promise<void> {
  const stuck = await db.all(`
    ${WATCHDOG_ROW_SELECT}
    WHERE ji.status IN ('running', 'dispatched', 'queued')
  `) as WatchdogRow[];

  for (const inst of stuck) {
    const decision = evaluateWatchdogDecision(inst, now);
    if (decision.shouldFail) await failStuckInstance(db, inst, now);
  }
}

export function startWatchdog(): void {
  console.log(`[watchdog] Starting — will auto-fail instances based on per-job timeout_seconds (default ${DEFAULT_TIMEOUT_MINUTES}m)`);

  setInterval(async () => {
    const db = getDb();
    await runWatchdogPass(db, new Date());
  }, POLL_INTERVAL_MS);

  // ── Task worktree pruning (task #365, tightened by task #457) ───────────
  // Every 30 minutes, scan agent workspace directories for stale task worktrees.
  // Valid task worktrees are retained unless the backing task is done.
  // The orphan safety net remains for malformed task folders and missing tasks,
  // but any prune candidate must still have no live instance.
  setInterval(async () => {
    try {
      await runWorktreePrunePass(getDb());
    } catch (err) {
      console.error('[watchdog] Worktree prune error:', err);
    }
  }, WORKTREE_PRUNE_INTERVAL_MS);
}
