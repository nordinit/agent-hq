import type Database from 'better-sqlite3';
import { getDb } from '../db/client';
import {
  runDispatcher, type DispatchResult,
  buildDispatchMessage, buildDispatchTaskNotesSection,
  dispatchInstance, getDispatchTaskNotesContext, type DispatchInstanceParams,
  getNonDispatchableTaskStatusPredicate,
} from '../domains/runs';
import { attachInstanceToTask } from '../domains/runs/observability';
import { cleanupImpossibleTaskLifecycleStates, cleanupTaskExecutionLinkageForStatus } from '../lib/taskLifecycle';
import { runEligibilityPass, type EligibilityResult } from '../services/eligibility';
import { buildContractInstructions, resolveTransportMode } from '../services/contracts';
import { backfillInstanceTokensAsync } from '../domains/runs/tokenBackfill';
import { writeTaskStatusChange } from '../domains/tasks/history';
import { markTaskNeedsAttentionForMissingSemanticHandoff, taskRequiresSemanticOutcome } from '../domains/runs/lifecycleHandoff';
import { getNeedsAttentionEligibleStatuses } from '../lib/reconcilerConfig';
import { buildHookSessionKey, resolveRuntimeAgentSlug } from '../lib/sessionKeys';
import { createDurableRunId, ensureJobInstanceDurableRunId, tableHasColumn } from '../lib/durableRunIdentity';
import { insertRuntimeLog } from '../lib/runtimeTenantScope';
import { resolveSprintTaskRoutingAssignment } from '../domains/routing/policy/statuses';
import { runRecurringTaskSchedulerTick, type RecurringTaskSchedulerSummary } from './recurringTaskScheduler';
import { syncTaskActiveAgentFromInstance } from '../domains/tasks/ownership';

const POLL_INTERVAL_MS = 12_000; // ~12 seconds
const DEFAULT_RECONCILER_TICK_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_RECONCILER_OPERATION_TIMEOUT_MS = 60_000;

function parsePositiveIntEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const RECONCILER_TICK_TIMEOUT_MS = parsePositiveIntEnv(
  'RECONCILER_TICK_TIMEOUT_MS',
  DEFAULT_RECONCILER_TICK_TIMEOUT_MS,
);
const RECONCILER_OPERATION_TIMEOUT_MS = parsePositiveIntEnv(
  'RECONCILER_OPERATION_TIMEOUT_MS',
  DEFAULT_RECONCILER_OPERATION_TIMEOUT_MS,
);

class ReconcilerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconcilerTimeoutError';
  }
}

async function withReconcilerTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  context: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new ReconcilerTimeoutError(`${context} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Grace period before an orphan in_progress task is escalated as an integrity
 * anomaly in logs rather than immediately surfacing as operator-visible noise.
 * Configurable via ORPHAN_STALL_GRACE_MS env var; defaults to 5 minutes.
 * A short window prevents false positives during the brief moment between
 * dispatch clearing active_instance_id and the new instance being attached.
 */
const ORPHAN_STALL_GRACE_MS: number = (() => {
  const v = parseInt(process.env.ORPHAN_STALL_GRACE_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 5 * 60_000;
})();

/**
 * Grace period before treating a runtime-ended task with no persisted semantic
 * lifecycle outcome as a true hand-off failure.
 *
 * This covers the gap where observability/runtime-end metadata can land before
 * transcript parsing or lifecycle persistence finishes. After the grace window,
 * we emit the configurable missing-outcome workflow event so genuine lost
 * hand-offs remain observable without hardcoded visible status movement.
 */
const MISSING_LIFECYCLE_OUTCOME_GRACE_MS: number = (() => {
  const v = parseInt(process.env.MISSING_LIFECYCLE_OUTCOME_GRACE_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 2 * 60_000;
})();

interface TaskRow {
  id: number;
  title: string;
  description: string;
  status: string;
  priority: string;
  agent_id: number | null;
  assigned_agent_id: number | null;
  project_id: number | null;
  sprint_id: number | null;
  task_type: string | null;
  review_owner_agent_id: number | null;
  active_instance_id: number | null;
  updated_at: string;
  story_points: number | null;
  /** The status the task was in before it became stalled/failed. Preserved for human-directed recovery context. */
  previous_status: string | null;
}

interface AgentRow {
  id: number;
  name: string;
  session_key: string;
  openclaw_agent_id: string | null;
  model: string | null;
  preferred_provider: string | null;
  /** Remote Gateway URL — when set, dispatch routes to this remote gateway instead of the host gateway. */
  hooks_url: string | null;
  /** Remote Gateway Auth Header. */
  hooks_auth_header: string | null;
  /** Agent runtime type (openclaw, veri, claude-code, etc.). */
  runtime_type: string | null;
  /** Agent runtime config JSON. */
  runtime_config: unknown;
  /* ── Legacy job-template label, kept for old scheduled/log rows only. ── */
  job_title: string;
  job_instructions: string;
  skill_name: string | null;
  timeout_seconds: number;
  sprint_id: number | null;
  enabled: number;
}

interface SprintRow {
  id: number;
  name: string;
  goal: string;
  status: string;
  sprint_type: string | null;
}

interface RoutingRuleRow {
  id: number;
  project_id: number;
  task_type: string;
  status: string;
  agent_id: number | null;
  priority: number;
}

interface DispatchDeps {
  dispatchInstance: (params: DispatchInstanceParams) => Promise<void>;
}

export interface ReconcilerDeps extends DispatchDeps {
  runEligibilityPass: (db: Database.Database, projectId?: number) => EligibilityResult;
  runDispatcher: (db: Database.Database, projectId?: number) => DispatchResult;
}

export interface ReconcilerTickSummary {
  projectsChecked: number;
  projectIds: number[];
  recurring: RecurringTaskSchedulerSummary;
  promoted: number;
  blocked: number;
  stalled: number;
  unclaimed: number;
  dispatched: number;
  skipped: number;
  errors: string[];
}

const DEFAULT_RECONCILER_DEPS: ReconcilerDeps = {
  dispatchInstance,
  runEligibilityPass,
  runDispatcher,
};

function createEmptySummary(projectIds: number[] = []): ReconcilerTickSummary {
  return {
    projectsChecked: projectIds.length,
    projectIds,
    recurring: { checked: 0, created: 0, skipped: 0, failed: 0, duplicates: 0, errors: [] },
    promoted: 0,
    blocked: 0,
    stalled: 0,
    unclaimed: 0,
    dispatched: 0,
    skipped: 0,
    errors: [],
  };
}

function log(db: Database.Database, message: string, _taskId?: number, agentId?: number): void {
  insertRuntimeLog(db, {
    taskId: _taskId ?? null,
    agentId: agentId ?? null,
    jobTitle: 'reconciler',
    level: 'info',
    message,
  });
  console.log(`[reconciler] ${message}`);
}

function logHistory(
  db: Database.Database,
  taskId: number,
  changedBy: string,
  field: string,
  oldValue: string | null,
  newValue: string | null,
): void {
  db.prepare(`
    INSERT INTO task_history (task_id, changed_by, field, old_value, new_value)
    VALUES (?, ?, ?, ?, ?)
  `).run(taskId, changedBy, field, oldValue, newValue);
}

function resolveAgentName(db: Database.Database, agentId: number | null): string | null {
  if (agentId == null) return null;
  const row = db.prepare(`SELECT name FROM agents WHERE id = ?`).get(agentId) as { name: string } | undefined;
  return row?.name ?? String(agentId);
}

function isAgentBusy(db: Database.Database, agentId: number): boolean {
  const running = db.prepare(`
    SELECT id FROM job_instances
    WHERE agent_id = ? AND status IN ('queued', 'dispatched', 'running')
    LIMIT 1
  `).get(agentId);
  return !!running;
}

function hasTaskLiveInstance(db: Database.Database, taskId: number): boolean {
  const row = db.prepare(`
    SELECT ji.id
    FROM job_instances ji
    WHERE ji.task_id = ?
      AND ji.status IN ('queued', 'dispatched', 'running')
    LIMIT 1
  `).get(taskId);
  return Boolean(row);
}

function buildQaTaskContext(task: TaskRow): string {
  return [
    `## Review Task #${task.id}: ${task.title}`,
    '',
    task.description || '(no description provided)',
    '',
    `This task is already in Agent HQ review. Do not move it to in_progress or done via the generic task update endpoint.`,
    `Keep the task in review while you test it.`,
    `Use the Agent HQ Task Contract Base URL for lifecycle writes such as task notes, QA evidence, check-ins, and outcomes.`,
    `Do not send lifecycle writes to the dev API under test unless the contract Base URL explicitly points there.`,
    '',
    `PASS workflow:`,
    `1. Record QA evidence with PUT /api/v1/tasks/${task.id}/qa-evidence`,
    `2. Then POST /api/v1/tasks/${task.id}/outcome with {"outcome":"qa_pass","changed_by":"agency-qa","instance_id":<instance id>}`,
    '',
    `FAIL workflow:`,
    `1. Post a clear task note with repro + expected vs actual`,
    `2. Then POST /api/v1/tasks/${task.id}/outcome with {"outcome":"qa_fail","changed_by":"agency-qa","instance_id":<instance id>}`,
    '',
    `Never use {"status":"done"} or {"status":"in_progress"} for QA pass/fail. The outcome endpoint owns release-pipeline transitions.`,
  ].join('\n');
}

function resolveRoutedTaskAgentId(db: Database.Database, task: TaskRow): number | null {
  if (!task.task_type) return null;
  try {
    return resolveSprintTaskRoutingAssignment(
      db,
      task.sprint_id ?? null,
      task.task_type,
      task.status,
    ).agent_id ?? null;
  } catch {
    return null;
  }
}

function shouldReconcileTaskOwnership(task: TaskRow): boolean {
  if (!task.task_type) return false;
  if (task.active_instance_id != null) return false;
  return true;
}

function reassignTaskIfNeeded(db: Database.Database, task: TaskRow, nextAgentId: number | null): TaskRow {
  if (task.assigned_agent_id === nextAgentId && (task.status !== 'review' || task.review_owner_agent_id != null)) {
    return task;
  }

  const nextReviewOwnerAgentId = task.status === 'review'
    ? (task.review_owner_agent_id ?? (task.assigned_agent_id !== nextAgentId ? task.assigned_agent_id : null))
    : task.review_owner_agent_id;

  if (task.assigned_agent_id === nextAgentId && nextReviewOwnerAgentId === task.review_owner_agent_id) {
    return task;
  }

  db.prepare(`
    UPDATE tasks
    SET assigned_agent_id = ?,
        review_owner_agent_id = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(nextAgentId, nextReviewOwnerAgentId, task.id);
  syncTaskActiveAgentFromInstance(db, task.id);

  if (task.assigned_agent_id !== nextAgentId) {
    const oldName = task.assigned_agent_id ? (db.prepare('SELECT name FROM agents WHERE id = ?').get(task.assigned_agent_id) as { name: string } | undefined)?.name : null;
    const newName = nextAgentId ? (db.prepare('SELECT name FROM agents WHERE id = ?').get(nextAgentId) as { name: string } | undefined)?.name : null;
    logHistory(db, task.id, 'reconciler', 'assigned_agent_id', oldName ?? 'unassigned', newName ?? String(nextAgentId));
    log(db,
      `${task.status === 'review' ? 'Review' : 'Routing'} ownership: task #${task.id} "${task.title}" reassigned ${oldName ?? 'unassigned'} → ${newName ?? String(nextAgentId)}`,
      task.id,
      nextAgentId ?? undefined,
    );
  }

  return {
    ...task,
    assigned_agent_id: nextAgentId,
    review_owner_agent_id: nextReviewOwnerAgentId,
  };
}

function getReconcilerProjectIds(db: Database.Database): number[] {
  const rows = db.prepare(`
    SELECT DISTINCT project_id
    FROM (
      SELECT id AS project_id FROM projects
      UNION ALL
      SELECT project_id FROM agents WHERE project_id IS NOT NULL
      UNION ALL
      SELECT project_id FROM tasks WHERE project_id IS NOT NULL
      UNION ALL
      SELECT project_id FROM routing_config WHERE project_id IS NOT NULL
    )
    WHERE project_id IS NOT NULL
    ORDER BY project_id ASC
  `).all() as Array<{ project_id: number }>;

  return rows.map(row => row.project_id);
}

export async function reconcileReviewQaRouting(
  deps: DispatchDeps = { dispatchInstance },
  db: Database.Database = getDb(),
): Promise<void> {
  const reviewTasks = db.prepare(`
    SELECT t.*
    FROM tasks t
    WHERE t.status = 'review'
      AND t.paused_at IS NULL
      AND (t.sprint_id IS NULL OR EXISTS (
        SELECT 1 FROM sprints sp WHERE sp.id = t.sprint_id AND sp.status != 'closed'
      ))
    ORDER BY t.updated_at ASC
  `).all() as TaskRow[];

  const statusEligibility = getNonDispatchableTaskStatusPredicate(db, 't', 's');
  const routedTasks = db.prepare(`
    SELECT t.*
    FROM tasks t
    LEFT JOIN sprints s ON s.id = t.sprint_id
    WHERE ${statusEligibility.sql}
      AND t.paused_at IS NULL
      AND t.assigned_agent_id IS NOT NULL
      AND t.active_instance_id IS NULL
      AND (t.sprint_id IS NULL OR EXISTS (
        SELECT 1 FROM sprints sp WHERE sp.id = t.sprint_id AND sp.status != 'closed'
      ))
    ORDER BY t.updated_at ASC
  `).all(...statusEligibility.params) as TaskRow[];

  for (const task of routedTasks) {
    if (!shouldReconcileTaskOwnership(task)) continue;
    const routedAgentId = resolveRoutedTaskAgentId(db, task);
    if (routedAgentId == null || routedAgentId === task.assigned_agent_id) continue;
    reassignTaskIfNeeded(db, task, routedAgentId);
  }

  for (const originalTask of reviewTasks) {
    const routedAgentId = resolveRoutedTaskAgentId(db, originalTask);
    if (routedAgentId == null) continue;

    // Skip entire task if it already has a live instance (no point trying any rule)
    if (hasTaskLiveInstance(db, originalTask.id)) continue;

    let agent: AgentRow | undefined;
    if (routedAgentId) {
      agent = db.prepare(`SELECT * FROM agents WHERE id = ? AND enabled = 1`).get(routedAgentId) as AgentRow | undefined;
    }
    if (!agent) continue;
    const agentLabel = agent.name || agent.job_title || `Agent #${agent.id}`;

    // Agent busy? leave review ownership converged on next tick when capacity frees up
    if (isAgentBusy(db, agent.id)) continue;

    // Agent is available — now safe to write task reassignment to DB
    const task = reassignTaskIfNeeded(db, originalTask, routedAgentId);
    if (!task.assigned_agent_id) continue;

    const sprint = task.sprint_id
      ? db.prepare('SELECT * FROM sprints WHERE id = ?').get(task.sprint_id) as SprintRow | undefined
      : undefined;

    const jobInstructions = agent.job_instructions
      ? `${buildQaTaskContext(task)}\n\n---\n\n${agent.job_instructions}`
      : buildQaTaskContext(task);

    const supportsDurableRunId = tableHasColumn(db, 'job_instances', 'durable_run_id');
    const instanceResult = supportsDurableRunId
      ? db.prepare(`
          INSERT INTO job_instances (agent_id, status, durable_run_id)
          VALUES (?, 'queued', ?)
        `).run(agent.id, createDurableRunId())
      : db.prepare(`
          INSERT INTO job_instances (agent_id, status)
          VALUES (?, 'queued')
        `).run(agent.id);
    const instanceId = instanceResult.lastInsertRowid as number;
    attachInstanceToTask(db, instanceId, task.id);

    try {
      const taskNotesSection = buildDispatchTaskNotesSection(getDispatchTaskNotesContext(db, {
        taskId: task.id,
        agentId: agent.id,
        currentInstanceId: instanceId,
      }));

      // Build message via shared helper + append lifecycle contract
      let message = buildDispatchMessage({
        jobInstructions,
        skillName: agent.skill_name,
        sprintGoal: sprint?.goal || null,
        taskNotesSection,
      });

      // Append task lifecycle contract
      const agentSlug = resolveRuntimeAgentSlug(agent)
        ?? agent.session_key.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
      const durableRunId = ensureJobInstanceDurableRunId(db, instanceId);
      const runSessionKey = buildHookSessionKey(instanceId, durableRunId);
      const contract = buildContractInstructions({
        instanceId,
        durableRunId,
        taskId: task.id,
        taskStatus: task.status,
        taskType: task.task_type ?? null,
        sprintId: task.sprint_id ?? null,
        sprintType: sprint?.sprint_type ?? null,
        agentSlug,
        sessionKey: runSessionKey,
        transportMode: resolveTransportMode({
          runtimeType: agent.runtime_type,
          runtimeConfig: agent.runtime_config,
          hooksUrl: agent.hooks_url,
        }),
        db,
      });
      message += `\n\n${contract}`;

      const effectiveModel = agent.model ?? null;

      await withReconcilerTimeout(
        deps.dispatchInstance({
          instanceId,
          agentId: agent.id,
          jobTitle: agentLabel,
          sessionKey: agent.session_key,
          message,
          model: effectiveModel,
          preferredProvider: agent.preferred_provider ?? null,
          timeoutSeconds: agent.timeout_seconds,
          hooksUrl: agent.hooks_url,
          hooksAuthHeader: agent.hooks_auth_header,
          runtimeType: agent.runtime_type,
          runtimeConfig: agent.runtime_config,
          storyPoints: task.story_points ?? null,
          projectId: task.project_id ?? null,
          sprintId: task.sprint_id ?? null,
        }),
        RECONCILER_OPERATION_TIMEOUT_MS,
        `QA dispatch task #${task.id} project=${task.project_id ?? 'none'} agent=${agent.id} instance=${instanceId}`,
      );

      log(db,
        `QA auto-dispatch: task #${task.id} "${task.title}" kept in review and queued agent "${agentLabel}" (model=${effectiveModel ?? 'gateway-default'})`,
        task.id,
        agent.id,
      );
    } catch (err) {
      console.error(`[reconciler] QA dispatch failed for task #${task.id}:`, err);
      // Mark the newly created instance as failed — do NOT call
      // cleanupTaskExecutionLinkageForStatus here, because the task may
      // still have a legitimately running instance from a prior dispatch.
      // Clearing active_instance_id on a transient dispatch error causes
      // running QA/DevOps instances to lose authoritative linkage.
      db.prepare(`
        UPDATE job_instances
        SET status = 'failed',
            error = ?,
            completed_at = datetime('now')
        WHERE id = ?
          AND status NOT IN ('done', 'failed', 'cancelled')
      `).run(
        err instanceof Error ? err.message : String(err),
        instanceId
      );
      // Restore previous active_instance_id if this failed instance was set as active
      const currentTask = db.prepare('SELECT active_instance_id FROM tasks WHERE id = ?').get(task.id) as { active_instance_id: number | null } | undefined;
      if (currentTask?.active_instance_id === instanceId) {
        db.prepare(`
          UPDATE tasks SET active_instance_id = NULL, updated_at = datetime('now') WHERE id = ?
        `).run(task.id);
      }
    }
  }
}

function reconcileInProgressRecovery(db: Database.Database): void {
  const inProgressTasks = db.prepare(`
    SELECT t.* FROM tasks t
      WHERE t.status = 'in_progress'
      AND t.assigned_agent_id IS NOT NULL
      AND t.paused_at IS NULL
  `).all() as TaskRow[];

  const now = Date.now();

  for (const task of inProgressTasks) {
    const agent = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(task.assigned_agent_id!) as AgentRow | undefined;
    if (!agent) continue;

    const liveInstance = db.prepare(`
      SELECT id FROM job_instances
      WHERE agent_id = ? AND status IN ('queued', 'dispatched', 'running')
      LIMIT 1
    `).get(agent.id);

    if (liveInstance) continue;

    const raw = task.updated_at;
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const withZ = normalized.endsWith('Z') ? normalized : normalized + 'Z';
    const updatedMs = new Date(withZ).getTime();
    const elapsedMs = now - updatedMs;
    const timeoutMs = (agent.timeout_seconds || 900) * 1000;

    if (elapsedMs >= timeoutMs) {
      const elapsedMin = Math.floor(elapsedMs / 60000);
      log(
        db,
        `In-progress integrity anomaly: task #${task.id} "${task.title}" remains in_progress with no live instance for agent "${agent.name}" after ${elapsedMin}m; leaving visible status unchanged`,
        task.id,
        agent.id,
      );
    }
  }
}

/**
 * reconcileOrphanInProgressTasks — detect in_progress tasks that have no live
 * instance attached and surface them as integrity anomalies.
 *
 * An "orphan" is any in_progress task where:
 *   (a) active_instance_id IS NULL, or
 *   (b) active_instance_id points to an instance with a terminal status
 *       (done, failed, cancelled).
 *
 * These tasks are invisible to the watchdog (which only monitors live
 * job_instances) and to cleanupImpossibleTaskLifecycleStates (which clears
 * the stale linkage but does not change task status). This pass preserves that
 * observability while leaving visible workflow recovery to explicit routing.
 *
 * A configurable grace period (ORPHAN_STALL_GRACE_MS, default 5 min) measured
 * from updated_at prevents false positives during the brief window between one
 * instance completing and the next being attached at re-dispatch.
 *
 * All detected orphans are logged immediately (even before the grace period
 * expires) so they are visible in observability tooling.
 */
export function reconcileOrphanInProgressTasks(db: Database.Database): void {
  const orphans = db.prepare(`
    SELECT t.id, t.title, t.agent_id, t.active_instance_id, t.updated_at, t.paused_at,
           ji.status AS instance_status
    FROM tasks t
    LEFT JOIN job_instances ji ON ji.id = t.active_instance_id
    WHERE t.status = 'in_progress'
      AND t.paused_at IS NULL
      AND (
        t.active_instance_id IS NULL
        OR ji.status IN ('done', 'failed', 'cancelled')
      )
  `).all() as Array<{
    id: number;
    title: string;
    agent_id: number | null;
    active_instance_id: number | null;
    updated_at: string;
    paused_at: string | null;
    instance_status: string | null;
  }>;

  if (orphans.length === 0) return;

  const now = Date.now();

  for (const orphan of orphans) {
    const raw = orphan.updated_at;
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const withZ = normalized.endsWith('Z') ? normalized : normalized + 'Z';
    const updatedMs = new Date(withZ).getTime();
    const elapsedMs = now - updatedMs;
    const elapsedMin = Math.floor(elapsedMs / 60000);

    const instanceDesc = orphan.active_instance_id === null
      ? 'no active_instance_id'
      : `active_instance_id=${orphan.active_instance_id} (${orphan.instance_status})`;

    const agentName = resolveAgentName(db, orphan.agent_id);

    // Always log orphan detection for observability (rate-limited to once per 10 min per task).
    const recentOrphanLog = db.prepare(`
      SELECT id FROM logs
      WHERE message LIKE ? AND created_at > datetime('now', '-10 minutes')
      LIMIT 1
    `).get(`%Orphan in_progress: task #${orphan.id}%`) as { id: number } | undefined;

    if (!recentOrphanLog) {
      const detectMsg = `Orphan in_progress: task #${orphan.id} "${orphan.title}" — ${instanceDesc}, elapsed=${elapsedMin}m, agent=${agentName ?? 'none'}`;
      console.warn(`[reconciler] ${detectMsg}`);
      log(db, detectMsg, orphan.id, orphan.agent_id ?? undefined);
    }

    if (elapsedMs < ORPHAN_STALL_GRACE_MS) continue;

    log(
      db,
      `Orphan in_progress integrity anomaly: task #${orphan.id} "${orphan.title}" remains in_progress with ${instanceDesc} for ${elapsedMin}m (grace=${Math.floor(ORPHAN_STALL_GRACE_MS / 60000)}m), agent=${agentName ?? 'none'}; leaving visible status unchanged`,
      orphan.id,
      orphan.agent_id ?? undefined,
    );

    console.log(
      `[reconciler] Orphan in_progress integrity anomaly: task #${orphan.id} "${orphan.title}" (${instanceDesc}, elapsed=${elapsedMin}m)`
    );
  }
}

function reconcileMissingLifecycleOutcomeAfterRuntimeEnd(db: Database.Database): void {
  const now = Date.now();
  const eligibleStatuses = getNeedsAttentionEligibleStatuses(db);
  if (eligibleStatuses.length === 0) return;
  const placeholders = eligibleStatuses.map(() => '?').join(', ');

  const candidates = db.prepare(`
    SELECT
      t.id,
      t.title,
      t.status,
      t.previous_status,
      t.project_id,
      t.agent_id,
      t.active_instance_id,
      ji.status AS instance_status,
      ji.runtime_ended_at,
      ji.runtime_end_error,
      ji.runtime_end_source,
      ji.task_outcome,
      ji.lifecycle_outcome_posted_at
    FROM tasks t
    JOIN job_instances ji ON ji.id = t.active_instance_id
    WHERE t.paused_at IS NULL
      AND t.status IN (${placeholders})
      AND ji.runtime_ended_at IS NOT NULL
      AND ji.lifecycle_outcome_posted_at IS NULL
      AND COALESCE(ji.task_outcome, '') = ''
  `).all(...eligibleStatuses) as Array<{
    id: number;
    title: string;
    status: string;
    previous_status: string | null;
    project_id: number | null;
    agent_id: number | null;
    active_instance_id: number;
    instance_status: string | null;
    runtime_ended_at: string;
    runtime_end_error: string | null;
    runtime_end_source: string | null;
    task_outcome: string | null;
    lifecycle_outcome_posted_at: string | null;
  }>;

  for (const task of candidates) {
    if (!taskRequiresSemanticOutcome(db, task.id)) continue;

    const normalized = task.runtime_ended_at.includes('T')
      ? task.runtime_ended_at
      : task.runtime_ended_at.replace(' ', 'T');
    const withZ = normalized.endsWith('Z') ? normalized : `${normalized}Z`;
    const runtimeEndedMs = new Date(withZ).getTime();
    const elapsedMs = now - runtimeEndedMs;
    const elapsedMin = Math.floor(elapsedMs / 60000);

    if (!Number.isFinite(runtimeEndedMs) || elapsedMs < MISSING_LIFECYCLE_OUTCOME_GRACE_MS) {
      continue;
    }

    markTaskNeedsAttentionForMissingSemanticHandoff(db, {
      taskId: task.id,
      instanceId: task.active_instance_id,
      changedBy: 'reconciler',
      workflowPhase: null,
      priorTaskStatus: task.status,
      runtimeEnd: {
        source: task.runtime_end_source,
        success: task.instance_status === 'done' ? true : task.runtime_end_error ? false : null,
        endedAt: withZ,
        error: task.runtime_end_error,
      },
    });

    log(db,
      `Lifecycle recovery: task #${task.id} "${task.title}" — emitted missing-outcome workflow event after runtime ended on instance #${task.active_instance_id} without lifecycle outcome for ${elapsedMin}m (grace=${Math.floor(MISSING_LIFECYCLE_OUTCOME_GRACE_MS / 60000)}m)`,
      task.id,
      task.agent_id ?? undefined,
    );
  }
}

/**
 * logStuckReviewTasks — emit a warning log for tasks that have been in 'review'
 * status with no active_instance_id for longer than 5 minutes. This surfaces
 * QA dispatch failures that would otherwise silently block the pipeline.
 */
function logStuckReviewTasks(db: Database.Database): void {
  const stuckTasks = db.prepare(`
    SELECT t.id, t.title, t.agent_id, t.updated_at
    FROM tasks t
    WHERE t.status = 'review'
      AND t.paused_at IS NULL
      AND t.active_instance_id IS NULL
      AND t.updated_at < datetime('now', '-5 minutes')
      AND (t.sprint_id IS NULL OR EXISTS (
        SELECT 1 FROM sprints sp WHERE sp.id = t.sprint_id AND sp.status != 'closed'
      ))
  `).all() as Array<{ id: number; title: string; agent_id: number | null; updated_at: string }>;

  for (const task of stuckTasks) {
    const agentName = resolveAgentName(db, task.agent_id);
    const msg = `⚠ Stuck review: task #${task.id} "${task.title}" has been in review with no active instance for >5 min (agent=${agentName ?? 'none'}, updated_at=${task.updated_at})`;
    console.warn(`[reconciler] ${msg}`);
    // Log to DB but only once per 30 minutes per task to avoid spam
    const recentLog = db.prepare(`
      SELECT id FROM logs
      WHERE message LIKE ? AND created_at > datetime('now', '-30 minutes')
      LIMIT 1
    `).get(`%Stuck review: task #${task.id}%`) as { id: number } | undefined;
    if (!recentLog) {
      log(db, msg, task.id, task.agent_id ?? undefined);
    }
  }
}

export async function runReconcilerTick(
  deps: ReconcilerDeps = DEFAULT_RECONCILER_DEPS,
  db: Database.Database = getDb(),
): Promise<ReconcilerTickSummary> {
  reconcileMissingLifecycleOutcomeAfterRuntimeEnd(db);
  cleanupImpossibleTaskLifecycleStates(db);

  const projectIds = getReconcilerProjectIds(db);
  const summary = createEmptySummary(projectIds);
  summary.recurring = runRecurringTaskSchedulerTick(db);

  for (const projectId of projectIds) {
    try {
      const eligibility = deps.runEligibilityPass(db, projectId);
      const dispatch = deps.runDispatcher(db, projectId);

      summary.promoted += eligibility.promoted;
      summary.blocked += eligibility.blocked;
      summary.stalled += eligibility.stalled;
      summary.unclaimed += eligibility.unclaimed;
      summary.dispatched += dispatch.dispatched;
      summary.skipped += dispatch.skipped;
      summary.errors.push(...dispatch.errors.map(error => `[project ${projectId}] ${error}`));

      if (eligibility.promoted > 0 || eligibility.blocked > 0 || eligibility.stalled > 0 || eligibility.unclaimed > 0 || dispatch.dispatched > 0 || dispatch.errors.length > 0) {
        console.log(
          `[reconciler] project=${projectId} promoted=${eligibility.promoted} blocked=${eligibility.blocked} stalled=${eligibility.stalled} unclaimed=${eligibility.unclaimed} dispatched=${dispatch.dispatched} skipped=${dispatch.skipped} errors=${dispatch.errors.length}`
        );
      }
    } catch (err) {
      const message = `[project ${projectId}] ${String(err)}`;
      summary.errors.push(message);
      console.error('[reconciler] Project automation error:', message);
    }
  }

  await withReconcilerTimeout(
    reconcileReviewQaRouting({ dispatchInstance: deps.dispatchInstance }, db),
    RECONCILER_OPERATION_TIMEOUT_MS,
    `review/QA routing projects=${projectIds.join(',') || 'none'}`,
  );
  reconcileOrphanInProgressTasks(db);
  reconcileInProgressRecovery(db);
  logStuckReviewTasks(db);

  // Backfill token usage from OpenClaw session data for recently completed instances.
  // Uses the async token-backfill path so reconciler ticks do not block the Node.js event loop.
  try {
    await withReconcilerTimeout(
      backfillInstanceTokensAsync(db),
      RECONCILER_OPERATION_TIMEOUT_MS,
      `token backfill projects=${projectIds.join(',') || 'none'}`,
    );
  } catch (err) {
    console.warn('[reconciler] Token backfill error:', err);
  }

  if (summary.dispatched > 0 || summary.promoted > 0 || summary.blocked > 0 || summary.stalled > 0 || summary.unclaimed > 0 || summary.recurring.created > 0 || summary.recurring.failed > 0 || summary.errors.length > 0) {
    console.log(
      `[reconciler] tick summary projects=${summary.projectsChecked} recurring_created=${summary.recurring.created} recurring_failed=${summary.recurring.failed} dispatched=${summary.dispatched} promoted=${summary.promoted} blocked=${summary.blocked} stalled=${summary.stalled} unclaimed=${summary.unclaimed} errors=${summary.errors.length}`
    );
  }

  return summary;
}

async function tick(): Promise<void> {
  try {
    await runReconcilerTick();
  } catch (err) {
    console.error('[reconciler] Tick error:', err);
  }
}

interface ReconcilerSchedulerOptions {
  intervalMs?: number;
  tickTimeoutMs?: number;
  runTick?: () => Promise<void>;
}

export function startReconciler(options: ReconcilerSchedulerOptions = {}): NodeJS.Timeout | undefined {
  if (process.env.AGENT_HQ_DISABLE_RECONCILER === '1') {
    console.warn('[reconciler] Disabled by AGENT_HQ_DISABLE_RECONCILER=1');
    return;
  }

  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const tickTimeoutMs = options.tickTimeoutMs ?? RECONCILER_TICK_TIMEOUT_MS;
  const runTick = options.runTick ?? tick;

  console.log(`[reconciler] Starting — polling every ${intervalMs / 1000}s`);
  let running = false;
  let activeTick: { id: number; startedAt: number } | null = null;
  let nextTickId = 1;

  const timer = setInterval(() => {
    if (running) {
      const elapsedMs = activeTick ? Date.now() - activeTick.startedAt : 0;
      const tickContext = activeTick ? `tick #${activeTick.id} elapsed=${elapsedMs}ms` : 'unknown tick';
      console.warn(`[reconciler] Previous tick still running; skipping overlapping tick (${tickContext})`);
      return;
    }

    const tickId = nextTickId++;
    running = true;
    activeTick = { id: tickId, startedAt: Date.now() };
    withReconcilerTimeout(
      Promise.resolve().then(runTick),
      tickTimeoutMs,
      `scheduler tick #${tickId}`,
    )
      .catch(err => console.error('[reconciler] Tick error:', err))
      .finally(() => {
        if (activeTick?.id === tickId) {
          running = false;
          activeTick = null;
        }
      });
  }, intervalMs);
  console.log('[reconciler] Running');
  return timer;
}
