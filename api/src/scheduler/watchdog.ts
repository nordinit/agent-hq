import type Database from 'better-sqlite3';
import { getDb } from '../db/client';
import { notifyTelegram } from '../integrations/telegram';
import { HEARTBEAT_STALE_MS, START_CHECKIN_GRACE_MS } from '../domains/runs/observability';
import { resolveRepoConfig } from '../lib/repoConfig';
import { writeTaskHistory, writeTaskRuntimeEndHistory } from '../domains/tasks/history';
import { markTaskNeedsAttentionForMissingSemanticHandoff, taskRequiresSemanticOutcome } from '../domains/runs/lifecycleHandoff';
import { determineRuntimeEndEvidenceRecorded } from '../domains/runs/runtimeEnd';
import { resolveWorkflow } from '../services/contracts/workflowContract';
import { scheduleEndedActiveInstanceLinkageCleanup } from '../lib/taskLifecycle';
import { pruneOrphanedWorktrees, resolveWorktreeBasePath } from '../services/worktreeManager';
import type { RepoAccessMode } from '../services/repoWorkspaceManager';
import { evaluateOpenClawInstanceSessionState, type OpenClawInstanceSessionStateResult } from '../domains/runs/openclawSessionState';
import { taskTableHasColumn } from '../domains/tasks/ownership';
import { normalizeTokenUsage } from '../domains/runs/tokenUsage';
import { createNotificationRecord } from '../lib/notifications';
import { getActiveTenantId } from '../lib/tenantContext';
import { insertRuntimeLog } from '../lib/runtimeTenantScope';

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
  lifecycle_outcome_posted_at: string | null;
  task_outcome: string | null;
  runtime_ended_at: string | null;
  response: string | null;
  runtime_type: string | null;
  repo_path: string | null;
  artifact_started_at: string | null;
  last_agent_heartbeat_at: string | null;
  last_meaningful_output_at: string | null;
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
         ji.lifecycle_outcome_posted_at, ji.task_outcome, ji.runtime_ended_at,
         ji.response,
         a.timeout_seconds, a.repo_path, a.runtime_type,
         a.startup_grace_seconds, a.heartbeat_stale_seconds,
         ia.started_at AS artifact_started_at,
         ia.last_agent_heartbeat_at,
         ia.last_meaningful_output_at,
         a.name AS agent_name,
         a.job_title AS job_title,
         t.title AS task_title
    FROM job_instances ji
    LEFT JOIN agents a ON a.id = ji.agent_id
    LEFT JOIN instance_artifacts ia ON ia.instance_id = ji.id
    LEFT JOIN tasks t ON t.id = ji.task_id
`;

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  try {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return columns.some((entry) => entry.name === column);
  } catch {
    return false;
  }
}

function resolveNotificationTenantId(db: Database.Database, taskId: number | null): number {
  if (taskId && tableHasColumn(db, 'tasks', 'tenant_id')) {
    try {
      const row = db.prepare(`SELECT tenant_id FROM tasks WHERE id = ?`).get(taskId) as { tenant_id: number | null } | undefined;
      const tenantId = Number(row?.tenant_id);
      if (Number.isInteger(tenantId) && tenantId > 0) return tenantId;
    } catch {
      // Fall through to active tenant.
    }
  }
  return getActiveTenantId(db);
}

function recordWatchdogStaleNotification(
  db: Database.Database,
  inst: WatchdogRow,
  params: { actorLabel: string; elapsedMin: number; reason: string },
): void {
  try {
    const taskPart = inst.task_id ? `Task #${inst.task_id}` : 'No linked task';
    const agentPart = inst.agent_name || inst.job_title
      ? `Agent: ${[inst.agent_name, inst.job_title].filter(Boolean).join(' / ')}`
      : `Agent #${inst.agent_id}`;
    createNotificationRecord(db, {
      tenantId: resolveNotificationTenantId(db, inst.task_id),
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

function recordWorktreePruneNotification(
  db: Database.Database,
  agent: { id: number; name: string | null; tenant_id?: number | null; project_tenant_id?: number | null },
  prunedCount: number,
): void {
  try {
    const agentLabel = agent.name || `agent #${agent.id}`;
    const agentTenantId = Number(agent.tenant_id);
    const projectTenantId = Number(agent.project_tenant_id);
    const tenantId = Number.isInteger(agentTenantId) && agentTenantId > 0
      ? agentTenantId
      : Number.isInteger(projectTenantId) && projectTenantId > 0
        ? projectTenantId
        : getActiveTenantId(db);
    createNotificationRecord(db, {
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

export function runWorktreePrunePass(db: Database.Database = getDb()): void {
  const hasAgentTenantId = tableHasColumn(db, 'agents', 'tenant_id');
  const hasAgentProjectId = tableHasColumn(db, 'agents', 'project_id');
  const hasProjectRepoColumns = hasAgentProjectId && ['repo_path', 'repo_url', 'repo_access_mode'].every((column) => tableHasColumn(db, 'projects', column));
  const hasWorkflowRepoColumns = ['repo_path', 'repo_url', 'repo_access_mode'].every((column) => tableHasColumn(db, 'sprints', column));
  const hasWorkflowRoutingColumns = ['agent_id', 'sprint_id', 'project_id', 'sprint_type'].every((column) => tableHasColumn(db, 'sprint_task_routing_rules', column));
  const hasProjectTenantId = hasAgentProjectId && tableHasColumn(db, 'projects', 'tenant_id');

  const agents = db.prepare(`
    SELECT a.id, a.name, a.workspace_path, a.repo_path, a.repo_url, a.repo_access_mode, a.os_user,
           ${hasAgentTenantId ? 'a.tenant_id' : 'NULL'} AS tenant_id,
           ${hasAgentProjectId ? 'a.project_id' : 'NULL'} AS project_id,
           ${hasProjectTenantId ? 'p.tenant_id' : 'NULL'} AS project_tenant_id,
           ${hasProjectRepoColumns ? 'p.repo_path AS project_repo_path, p.repo_url AS project_repo_url, p.repo_access_mode AS project_repo_access_mode' : 'NULL AS project_repo_path, NULL AS project_repo_url, NULL AS project_repo_access_mode'},
           ${hasWorkflowRepoColumns && hasWorkflowRoutingColumns ? 's.repo_path AS workflow_repo_path, s.repo_url AS workflow_repo_url, s.repo_access_mode AS workflow_repo_access_mode' : 'NULL AS workflow_repo_path, NULL AS workflow_repo_url, NULL AS workflow_repo_access_mode'}
    FROM agents a
    ${hasAgentProjectId ? 'LEFT JOIN projects p ON p.id = a.project_id' : ''}
    ${hasWorkflowRepoColumns && hasWorkflowRoutingColumns ? `LEFT JOIN (
      SELECT rr.agent_id, MIN(COALESCE(rr.sprint_id, sp.id)) AS sprint_id
      FROM sprint_task_routing_rules rr
      LEFT JOIN sprints sp ON sp.project_id = rr.project_id AND sp.sprint_type = rr.sprint_type
      GROUP BY rr.agent_id
    ) wr ON wr.agent_id = a.id
    LEFT JOIN sprints s ON s.id = wr.sprint_id` : ''}
    WHERE a.workspace_path IS NOT NULL AND a.workspace_path != ''
  `).all() as Array<{ id: number; name: string | null; tenant_id: number | null; project_id: number | null; project_tenant_id: number | null; workspace_path: string; repo_path: string | null; repo_url: string | null; repo_access_mode: RepoAccessMode | null; os_user: string | null; project_repo_path: string | null; project_repo_url: string | null; project_repo_access_mode: RepoAccessMode | null; workflow_repo_path: string | null; workflow_repo_url: string | null; workflow_repo_access_mode: RepoAccessMode | null }>;

  for (const agent of agents) {
    const effectiveRepo = resolveRepoConfig({
      workflow: {
        repo_path: agent.workflow_repo_path,
        repo_url: agent.workflow_repo_url,
        repo_access_mode: agent.workflow_repo_access_mode,
      },
      project: {
        repo_path: agent.project_repo_path,
        repo_url: agent.project_repo_url,
        repo_access_mode: agent.project_repo_access_mode,
      },
      agent: {
        repo_path: agent.repo_path,
        repo_url: agent.repo_url,
        repo_access_mode: agent.repo_access_mode,
      },
    });
    if (effectiveRepo.repo_access_mode !== 'worktree' || !effectiveRepo.repo_path) continue;

    const basePath = resolveWorktreeBasePath({
      osUser: agent.os_user,
      workspacePath: agent.workspace_path,
    });
    const result = pruneOrphanedWorktrees({
      repoPath: effectiveRepo.repo_path,
      basePath,
      maxAgeHours: 24,
      getTaskRecord: (taskId: number) => {
        const row = db.prepare(`
          SELECT status
          FROM tasks
          WHERE id = ?
        `).get(taskId) as { status: string } | undefined;
        return row
          ? { exists: true, status: row.status }
          : { exists: false, status: null };
      },
      hasLiveInstance: (worktreePath: string, taskId: number | null) => {
        const folderName = worktreePath.split('/').pop() ?? worktreePath;
        const row = db.prepare(`
          SELECT COUNT(*) as n
          FROM job_instances
          WHERE status IN ('queued', 'dispatched', 'running')
            AND (
              task_id = ?
              OR worktree_path = ?
              OR worktree_path = ?
              OR worktree_path LIKE ?
            )
        `).get(
          taskId,
          worktreePath,
          folderName,
          `%/${folderName}`,
        ) as { n: number };
        return row.n > 0;
      },
    });

    if (result.pruned.length > 0) {
      const agentLabel = agent.name || `agent #${agent.id}`;
      console.log(`[watchdog] Pruned ${result.pruned.length} orphaned worktree(s) for ${agentLabel}`);
      recordWorktreePruneNotification(db, agent, result.pruned.length);
      notifyTelegram(`🧹 Watchdog: pruned ${result.pruned.length} orphaned worktree(s) for ${agentLabel}`);
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
 * Preferred shape: "Forge / Agency — Backend" (agent / job title)
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
  const startedAtMs = pickLatestTimestamp(inst.started_at, inst.artifact_started_at);
  const heartbeatAtMs = normalizeTimestamp(inst.last_agent_heartbeat_at);
  const outputAtMs = normalizeTimestamp(inst.last_meaningful_output_at);

  // Pre-start lifecycle: queued/dispatched work (or a "running" row with no actual start signal yet)
  // should be judged by startup grace from dispatch/creation, not by full execution timeout.
  if (!startedAtMs) {
    const startupElapsedMs = queuedAtMs === null ? 0 : now.getTime() - queuedAtMs;
    if (startupElapsedMs >= effectiveStartCheckinGraceMs) {
      return {
        shouldFail: true,
        reason: `startup timeout: no real start/check-in within ${Math.floor(effectiveStartCheckinGraceMs / 60000)}m`,
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

  const lastLiveSignalMs = pickLatestTimestamp(
    inst.last_agent_heartbeat_at,
    inst.last_meaningful_output_at,
    inst.started_at,
    inst.artifact_started_at,
  );
  const staleElapsedMs = lastLiveSignalMs === null ? executionElapsedMs : now.getTime() - lastLiveSignalMs;
  if (staleElapsedMs >= effectiveHeartbeatStaleMs) {
    const signalLabel = outputAtMs && (!heartbeatAtMs || outputAtMs >= heartbeatAtMs)
      ? 'meaningful output'
      : heartbeatAtMs
        ? 'heartbeat'
        : 'start signal';
    return {
      shouldFail: true,
      reason: `stale run: no ${signalLabel} for ${Math.floor(staleElapsedMs / 60000)}m`,
      elapsedMs: executionElapsedMs,
    };
  }

  return { shouldFail: false, reason: null, elapsedMs: executionElapsedMs };
}

interface WatchdogTaskRuntimeContext {
  task_status: string | null;
  task_type: string | null;
  sprint_id: number | null;
  sprint_type: string | null;
  review_branch: string | null;
  review_commit: string | null;
  review_url: string | null;
  qa_verified_commit: string | null;
  qa_tested_url: string | null;
  merged_commit: string | null;
  deployed_commit: string | null;
  deploy_target: string | null;
  deployed_at: string | null;
}

function loadTaskRuntimeContext(db: Database.Database, taskId: number | null): WatchdogTaskRuntimeContext | null {
  if (!taskId) return null;
  try {
    const row = db.prepare(`
      SELECT t.status AS task_status,
             t.task_type,
             t.sprint_id,
             s.sprint_type,
             t.review_branch,
             t.review_commit,
             t.review_url,
             t.qa_verified_commit,
             t.qa_tested_url,
             t.merged_commit,
             t.deployed_commit,
             t.deploy_target,
             t.deployed_at
      FROM tasks t
      LEFT JOIN sprints s ON s.id = t.sprint_id
      WHERE t.id = ?
    `).get(taskId) as WatchdogTaskRuntimeContext | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function safeTaskRequiresSemanticOutcome(db: Database.Database, taskId: number | null): boolean {
  try {
    return taskRequiresSemanticOutcome(db, taskId);
  } catch {
    return false;
  }
}

function safeResolveWorkflow(db: Database.Database, task: WatchdogTaskRuntimeContext | null) {
  if (!task?.task_status) return null;
  try {
    return resolveWorkflow({
      taskStatus: task.task_status,
      taskType: task.task_type,
      sprintId: task.sprint_id,
      sprintType: task.sprint_type,
      db,
    });
  } catch {
    return null;
  }
}

interface WatchdogRuntimeEndEvent {
  success: boolean;
  endedAt: string;
  source: string;
  reason?: string | null;
  error?: string | null;
  type?: string | null;
  metadata?: Record<string, unknown> | null;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function booleanField(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return null;
}

function normalizeIsoTimestamp(raw: unknown, fallback?: string | null): string | null {
  const candidate = stringField(raw) ?? fallback ?? null;
  if (!candidate) return null;
  const normalized = candidate.includes('T') ? candidate : candidate.replace(' ', 'T');
  const withZ = normalized.endsWith('Z') ? normalized : `${normalized}Z`;
  const ms = new Date(withZ).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function runtimeEndFromObject(raw: Record<string, unknown>, fallback: { source?: string | null; endedAt?: string | null } = {}): WatchdogRuntimeEndEvent | null {
  const success = booleanField(raw.success ?? raw.runtime_end_success);
  const endedAt = normalizeIsoTimestamp(raw.endedAt ?? raw.ended_at ?? raw.runtime_ended_at, fallback.endedAt);
  if (success === null || !endedAt) return null;

  const source = stringField(raw.source)
    ?? stringField(raw.runtime_end_source)
    ?? stringField(raw.runtime)
    ?? stringField(raw.provider)
    ?? fallback.source
    ?? 'unknown';

  return {
    success,
    endedAt,
    source,
    reason: stringField(raw.reason) ?? stringField(raw.terminal_reason),
    error: stringField(raw.error) ?? stringField(raw.runtime_end_error),
    type: stringField(raw.type) ?? stringField(raw.runtime_end_type),
    metadata: raw,
  };
}

function runtimeEndFromResponse(response: string | null): WatchdogRuntimeEndEvent | null {
  const parsed = parseJsonObject(response);
  const runtimeEnd = parsed?.runtimeEnd;
  if (!runtimeEnd || typeof runtimeEnd !== 'object' || Array.isArray(runtimeEnd)) return null;
  return runtimeEndFromObject(runtimeEnd as Record<string, unknown>);
}

function inferRuntimeEndSource(inst: WatchdogRow, messageId: string, meta: Record<string, unknown>): string | null {
  return stringField(meta.source)
    ?? stringField(meta.runtime_end_source)
    ?? stringField(meta.runtime)
    ?? stringField(meta.provider)
    ?? (messageId.startsWith('hermes-runtime-end-') ? 'hermes' : null)
    ?? (messageId.startsWith('openclaw-runtime-end-') ? 'openclaw' : null)
    ?? inst.runtime_type;
}

function runtimeEndFromTerminalChatMessage(db: Database.Database, inst: WatchdogRow): WatchdogRuntimeEndEvent | null {
  try {
    const row = db.prepare(`
      SELECT id, timestamp, event_meta
      FROM chat_messages
      WHERE instance_id = ?
        AND event_type = 'turn_end'
      ORDER BY timestamp DESC, id DESC
      LIMIT 1
    `).get(inst.id) as { id: string; timestamp: string; event_meta: string | null } | undefined;
    if (!row) return null;
    const meta = parseJsonObject(row.event_meta);
    if (!meta) return null;
    return runtimeEndFromObject(meta, {
      endedAt: row.timestamp,
      source: inferRuntimeEndSource(inst, row.id, meta),
    });
  } catch {
    return null;
  }
}

function applyWatchdogRuntimeEnd(
  db: Database.Database,
  inst: WatchdogRow,
  event: WatchdogRuntimeEndEvent,
  discoveredFrom: 'response.runtimeEnd' | 'chat_messages.turn_end' | 'openclaw.raw_session',
): boolean {
  const task = loadTaskRuntimeContext(db, inst.task_id);
  const requiresSemanticOutcome = event.success && safeTaskRequiresSemanticOutcome(db, inst.task_id);
  const missingRequiredLifecycleOutcome = Boolean(
    event.success
    && requiresSemanticOutcome
    && !inst.lifecycle_outcome_posted_at
    && !inst.task_outcome,
  );
  const runtimeLabel = event.source === 'unknown' ? 'Runtime' : `${event.source} runtime`;
  const runtimeEndError = missingRequiredLifecycleOutcome
    ? `${runtimeLabel} ended without required lifecycle outcome`
    : event.success
      ? null
      : event.error ?? `Runtime ended with ${event.reason ?? 'error'}`;
  const finalStatus = event.success && !missingRequiredLifecycleOutcome ? 'done' : 'failed';
  const tokenUsage = normalizeTokenUsage(event.metadata, event);

  const updated = db.prepare(`
    UPDATE job_instances
    SET status = ?,
        started_at = COALESCE(started_at, ?),
        completed_at = COALESCE(completed_at, ?),
        runtime_ended_at = COALESCE(runtime_ended_at, ?),
        runtime_end_success = COALESCE(runtime_end_success, ?),
        runtime_end_error = COALESCE(runtime_end_error, ?),
        runtime_end_source = COALESCE(runtime_end_source, ?),
        token_input = COALESCE(?, token_input),
        token_output = COALESCE(?, token_output),
        token_total = COALESCE(?, token_total)
    WHERE id = ?
      AND runtime_ended_at IS NULL
      AND status IN ('running', 'dispatched', 'queued')
  `).run(
    finalStatus,
    event.endedAt,
    event.endedAt,
    event.endedAt,
    event.success ? 1 : 0,
    runtimeEndError,
    event.source,
    tokenUsage.input,
    tokenUsage.output,
    tokenUsage.total,
    inst.id,
  );
  if (updated.changes === 0) return false;

  if (inst.task_id) {
    scheduleEndedActiveInstanceLinkageCleanup(db, inst.task_id, inst.id, {
      changedBy: 'watchdog',
    });
    writeTaskRuntimeEndHistory(db, inst.task_id, 'watchdog', {
      endedAt: event.endedAt,
      success: event.success,
      source: event.source,
      error: runtimeEndError,
      lifecycleHandoff: missingRequiredLifecycleOutcome
        ? 'missing_after_runtime_end'
        : inst.lifecycle_outcome_posted_at || inst.task_outcome
          ? 'posted'
          : 'pending',
    });
  }

  if (missingRequiredLifecycleOutcome && inst.task_id) {
    const resolvedWorkflow = safeResolveWorkflow(db, task);
    markTaskNeedsAttentionForMissingSemanticHandoff(db, {
      taskId: inst.task_id,
      instanceId: inst.id,
      changedBy: 'watchdog',
      workflowPhase: resolvedWorkflow?.workflowPhase ?? null,
      priorTaskStatus: task?.task_status ?? inst.status,
      sessionKey: inst.session_key,
      reviewQaDeployEvidenceRecorded: determineRuntimeEndEvidenceRecorded(resolvedWorkflow?.workflowPhase ?? null, task),
      runtimeEnd: {
        source: event.source,
        success: event.success,
        endedAt: event.endedAt,
        error: runtimeEndError,
      },
    });
  }

  const message = event.success
    ? `Watchdog: reconciled persisted runtimeEnd for instance #${inst.id} from ${discoveredFrom} as ${finalStatus} (source=${event.source}, reason=${event.reason ?? 'completed'}, endedAt=${event.endedAt})`
    : `Watchdog: reconciled persisted runtimeEnd for instance #${inst.id} from ${discoveredFrom} as failed (source=${event.source}, reason=${event.reason ?? 'error'}) — ${runtimeEndError}`;
  insertRuntimeLog(db, {
    instanceId: inst.id,
    agentId: inst.agent_id,
    level: 'info',
    message,
  });

  console.log(`[watchdog] ${message}`);
  return true;
}

function reconcilePersistedRuntimeEnd(db: Database.Database, inst: WatchdogRow): boolean {
  if (inst.runtime_ended_at) return false;
  const responseEvent = runtimeEndFromResponse(inst.response);
  if (responseEvent && applyWatchdogRuntimeEnd(db, inst, responseEvent, 'response.runtimeEnd')) {
    return true;
  }
  const chatEvent = runtimeEndFromTerminalChatMessage(db, inst);
  if (chatEvent && applyWatchdogRuntimeEnd(db, inst, chatEvent, 'chat_messages.turn_end')) {
    return true;
  }
  return false;
}

function reconcileTerminalOpenClawSession(
  db: Database.Database,
  inst: WatchdogRow,
  rawSession: OpenClawInstanceSessionStateResult,
  now: Date,
): boolean {
  const decision = rawSession.decision;
  if (!decision?.terminal) return false;

  const endedAt = rawSession.state?.trajectoryEndedAt ?? rawSession.state?.lastEventAt ?? now.toISOString();
  const task = loadTaskRuntimeContext(db, inst.task_id);
  const requiresSemanticOutcome = decision.success && safeTaskRequiresSemanticOutcome(db, inst.task_id);
  const missingRequiredLifecycleOutcome = Boolean(
    decision.success
    && requiresSemanticOutcome
    && !inst.lifecycle_outcome_posted_at
    && !inst.task_outcome,
  );
  const runtimeEndError = missingRequiredLifecycleOutcome
    ? 'OpenClaw runtime ended without required lifecycle outcome'
    : decision.success
      ? null
      : decision.error ?? `OpenClaw runtime ended with ${decision.reason}`;
  const finalStatus = decision.success && !missingRequiredLifecycleOutcome ? 'done' : 'failed';
  const source = 'watchdog_raw_session';
  const tokenUsage = normalizeTokenUsage(decision.metadata, rawSession.state, rawSession);

  const updated = db.prepare(`
    UPDATE job_instances
    SET status = ?,
        started_at = COALESCE(started_at, ?),
        completed_at = COALESCE(completed_at, ?),
        runtime_ended_at = COALESCE(runtime_ended_at, ?),
        runtime_end_success = COALESCE(runtime_end_success, ?),
        runtime_end_error = COALESCE(runtime_end_error, ?),
        runtime_end_source = COALESCE(runtime_end_source, ?),
        token_input = COALESCE(?, token_input),
        token_output = COALESCE(?, token_output),
        token_total = COALESCE(?, token_total)
    WHERE id = ?
      AND status IN ('running', 'dispatched', 'queued')
  `).run(
    finalStatus,
    endedAt,
    endedAt,
    endedAt,
    decision.success ? 1 : 0,
    runtimeEndError,
    source,
    tokenUsage.input,
    tokenUsage.output,
    tokenUsage.total,
    inst.id,
  );
  if (updated.changes === 0) return false;

  if (inst.task_id) {
    scheduleEndedActiveInstanceLinkageCleanup(db, inst.task_id, inst.id, {
      changedBy: 'watchdog',
    });
  }

  if (missingRequiredLifecycleOutcome && inst.task_id) {
    const resolvedWorkflow = safeResolveWorkflow(db, task);
    markTaskNeedsAttentionForMissingSemanticHandoff(db, {
      taskId: inst.task_id,
      instanceId: inst.id,
      changedBy: 'watchdog',
      workflowPhase: resolvedWorkflow?.workflowPhase ?? null,
      priorTaskStatus: task?.task_status ?? inst.status,
      sessionKey: inst.session_key,
      reviewQaDeployEvidenceRecorded: determineRuntimeEndEvidenceRecorded(resolvedWorkflow?.workflowPhase ?? null, task),
      runtimeEnd: {
        source,
        success: decision.success,
        endedAt,
        error: runtimeEndError,
      },
    });
  }

  const stateDetails = rawSession.state?.trajectoryFile
    ? `${rawSession.state.kind}, trajectory=${rawSession.state.trajectoryFile}, trajectory_status=${rawSession.state.trajectoryStatus ?? 'unknown'}`
    : rawSession.state?.kind ?? 'unknown';
  const message = decision.success
    ? `Watchdog: reconciled terminal OpenClaw session for instance #${inst.id} as ${finalStatus} (${stateDetails})`
    : `Watchdog: reconciled terminal OpenClaw session for instance #${inst.id} as failed (${stateDetails}) — ${runtimeEndError ?? decision.reason}`;
  insertRuntimeLog(db, {
    instanceId: inst.id,
    agentId: inst.agent_id,
    level: 'info',
    message,
  });

  console.log(`[watchdog] ${message}`);
  return true;
}

export function runWatchdogPass(db: Database.Database, now = new Date()): void {
  const stuck = db.prepare(`
    ${WATCHDOG_ROW_SELECT}
    WHERE ji.status IN ('running', 'dispatched', 'queued')
  `).all() as WatchdogRow[];

  for (const inst of stuck) {
    if (reconcilePersistedRuntimeEnd(db, inst)) continue;

    let currentInst = inst;
    let decision = evaluateWatchdogDecision(currentInst, now);
    if (!decision.shouldFail || !decision.reason) continue;
    let decisionReason = decision.reason;

    try {
      const rawSession = evaluateOpenClawInstanceSessionState(db, inst.id, { now });
      const hasRuntimeActivity = Boolean(
        rawSession.state?.lastAssistantAt
        || rawSession.state?.lastToolUseAt
        || rawSession.state?.promptErrorAt
        || rawSession.state?.trajectoryEndedAt
        || rawSession.state?.trajectoryErrorAt,
      );
      if (rawSession.decision && !rawSession.decision.terminal && rawSession.state?.lastEventAt && hasRuntimeActivity) {
        console.info(
          `[watchdog] Deferring stale decision for instance #${inst.id};` +
          ` raw OpenClaw session state is ${rawSession.state.kind}` +
          ` (${rawSession.decision.deferReason ?? 'not_terminal'})`,
        );
        continue;
      }
      if (rawSession.decision && !rawSession.decision.terminal && rawSession.state?.lastEventAt && !hasRuntimeActivity) {
        console.info(
          `[watchdog] Not deferring stale decision for instance #${inst.id};` +
          ` raw OpenClaw session state is ${rawSession.state.kind} with no assistant/tool/terminal trajectory activity`,
        );
      }
      if (rawSession.decision?.terminal) {
        reconcileTerminalOpenClawSession(db, currentInst, rawSession, now);
        continue;
      }
      if (rawSession.state?.lastEventAt) {
        const refreshed = db.prepare(`
          ${WATCHDOG_ROW_SELECT}
          WHERE ji.id = ? AND ji.status IN ('running', 'dispatched', 'queued')
        `).get(inst.id) as WatchdogRow | undefined;
        if (refreshed) {
          currentInst = refreshed;
          decision = evaluateWatchdogDecision(currentInst, now);
          if (!decision.shouldFail || !decision.reason) continue;
          decisionReason = decision.reason;
        }
      }
    } catch (err) {
      console.warn(
        `[watchdog] Failed to backfill OpenClaw JSONL transcript before stale decision for instance #${inst.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    const elapsedMin = Math.floor(decision.elapsedMs / 60000);
    const completedAt = now.toISOString();
    db.prepare(`
      UPDATE job_instances
      SET status = 'failed',
          error  = ?,
          completed_at = ?,
          runtime_ended_at = COALESCE(runtime_ended_at, ?),
          runtime_end_success = COALESCE(runtime_end_success, 0),
          runtime_end_error = COALESCE(runtime_end_error, ?),
          runtime_end_source = COALESCE(runtime_end_source, 'watchdog')
      WHERE id = ? AND status IN ('running', 'dispatched', 'queued')
    `).run(
      `Watchdog: ${decisionReason}`,
      completedAt,
      completedAt,
      `Watchdog: ${decisionReason}`,
      currentInst.id
    );

    if (currentInst.task_id) {
      const cleared = db.prepare(`
        UPDATE tasks
        SET active_instance_id = NULL,
            ${taskTableHasColumn(db, 'agent_id') ? 'agent_id = NULL,' : ''}
            updated_at = datetime('now')
        WHERE id = ? AND active_instance_id = ?
      `).run(currentInst.task_id, currentInst.id);
      if (cleared.changes > 0) {
        writeTaskHistory(db, currentInst.task_id, 'watchdog', 'active_instance_id', String(currentInst.id), null);
      }
    }

    insertRuntimeLog(db, {
      instanceId: currentInst.id,
      agentId: currentInst.agent_id,
      taskId: currentInst.task_id,
      level: 'warn',
      message: `Watchdog: instance #${currentInst.id} was auto-failed from "${currentInst.status}" after ${elapsedMin}m — ${decisionReason} (task_id=${currentInst.task_id ?? 'none'})`,
    });

    const actorLabel = formatActorLabel(currentInst);
    console.log(`[watchdog] Auto-failed instance #${currentInst.id} (${elapsedMin}m elapsed, task=${currentInst.task_id ?? 'none'}) — ${decisionReason}`);
    recordWatchdogStaleNotification(db, currentInst, { actorLabel, elapsedMin, reason: decisionReason });
    notifyTelegram(`⏰ Watchdog: ${actorLabel} auto-failed after ${elapsedMin}m (instance #${currentInst.id}${currentInst.task_id ? `, task #${currentInst.task_id}` : ''}) — ${decisionReason}`);
  }
}

export function startWatchdog(): void {
  console.log(`[watchdog] Starting — will auto-fail instances based on per-job timeout_seconds (default ${DEFAULT_TIMEOUT_MINUTES}m)`);

  setInterval(() => {
    const db = getDb();
    runWatchdogPass(db, new Date());
  }, POLL_INTERVAL_MS);

  // ── Task worktree pruning (task #365, tightened by task #457) ───────────
  // Every 30 minutes, scan agent workspace directories for stale task worktrees.
  // Valid task worktrees are retained unless the backing task is done.
  // The orphan safety net remains for malformed task folders and missing tasks,
  // but any prune candidate must still have no live instance.
  setInterval(() => {
    try {
      runWorktreePrunePass(getDb());
    } catch (err) {
      console.error('[watchdog] Worktree prune error:', err);
    }
  }, WORKTREE_PRUNE_INTERVAL_MS);
}
