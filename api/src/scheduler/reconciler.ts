import { getDb } from '../db/client';
import {
  runDispatcher, type DispatchResult,
  buildDispatchContextBundle, loadDispatchScopeContext,
  dispatchInstance, getDispatchTaskNotesContext, type DispatchInstanceParams,
  getNonDispatchableTaskStatusPredicate,
} from '../domains/runs';
import {
  buildInstanceCallbackContractSegmentDraft,
  extractWorkingDirectoryFromRuntimeConfig,
  resolveDispatchPathContext,
} from '../services/dispatch/prompt';
import { injectGitHubCredentials, resolveGitHubIdentity } from '../lib/githubIdentity';
import { attachInstanceToTask } from '../domains/runs/observability';
import { cleanupImpossibleTaskLifecycleStates, cleanupTaskExecutionLinkageForStatus } from '../lib/taskLifecycle';
import { runEligibilityPass, type EligibilityResult } from '../services/eligibility';
import { buildContractInstructions, resolveTransportMode } from '../services/contracts';
import { backfillInstanceTokensAsync } from '../domains/runs/tokenBackfill';
import { writeTaskHistory, writeTaskStatusChange } from '../domains/tasks/history';
import { markTaskNeedsAttentionForMissingSemanticHandoff, taskRequiresSemanticOutcome } from '../domains/runs/lifecycleHandoff';
import { getNeedsAttentionEligibleStatuses } from '../lib/reconcilerConfig';
import { buildHookSessionKey, resolveRuntimeAgentSlug } from '../lib/sessionKeys';
import { createDurableRunId, ensureJobInstanceDurableRunId, tableHasColumn } from '../lib/durableRunIdentity';
import { insertRuntimeLog } from '../lib/runtimeTenantScope';
import { resolveSprintTaskRoutingAssignment } from '../domains/routing/policy/statuses';
import { resolveTeamContextForDispatch } from '../domains/teams/context';
import { runRecurringTaskSchedulerTick, type RecurringTaskSchedulerSummary } from './recurringTaskScheduler';
import { syncTaskActiveAgentFromInstance } from '../domains/tasks/ownership';
import { type Db } from "../db/adapter/types";
import { reconcileRuntimeExecutions } from '../runtimes/runtimeExecutionReconciler';

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
  tenant_id: number;
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
  provider_connection_id: number | null;
  /** Remote Gateway URL — when set, dispatch routes to this remote gateway instead of the host gateway. */
  hooks_url: string | null;
  /** Remote Gateway Auth Header. */
  hooks_auth_header: string | null;
  /** Agent runtime type (openclaw, claude-code, etc.). */
  runtime_type: string | null;
  /** Agent runtime config JSON. */
  runtime_config: unknown;
  /* ── Legacy job-template label, kept for old scheduled/log rows only. ── */
  job_title: string;
  job_instructions: string;
  skill_name: string | null;
  /** Agent workspace directory — the authoritative repo root when no worktree exists. */
  workspace_path: string | null;
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
  runEligibilityPass: (db: Db, projectId?: number) => Promise<EligibilityResult>;
  runDispatcher: (db: Db, projectId?: number) => Promise<DispatchResult>;
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

async function log(db: Db, message: string, _taskId?: number, agentId?: number): Promise<void> {
  await insertRuntimeLog(db, {
        taskId: _taskId ?? null,
        agentId: agentId ?? null,
        jobTitle: 'reconciler',
        level: 'info',
        message,
      });
  console.log(`[reconciler] ${message}`);
}

async function logHistory(
  db: Db,
  taskId: number,
  changedBy: string,
  field: string,
  oldValue: string | null,
  newValue: string | null,
): Promise<void> {
  await writeTaskHistory(db, taskId, changedBy, field, oldValue, newValue, false);
}

async function resolveAgentName(db: Db, agentId: number | null): Promise<string | null> {
  if (agentId == null) return null;
  const row = await db.get(`SELECT name FROM agents WHERE id = ?`, agentId) as { name: string } | undefined;
  return row?.name ?? String(agentId);
}

async function isAgentBusy(db: Db, agentId: number): Promise<boolean> {
  const running = await db.get(`
    SELECT id FROM job_instances
    WHERE agent_id = ? AND status IN ('queued', 'dispatched', 'running')
    LIMIT 1
  `, agentId);
  return !!running;
}

async function hasTaskLiveInstance(db: Db, taskId: number): Promise<boolean> {
  const row = await db.get(`
    SELECT ji.id
    FROM job_instances ji
    WHERE ji.task_id = ?
      AND ji.status IN ('queued', 'dispatched', 'running')
    LIMIT 1
  `, taskId);
  return Boolean(row);
}

async function resolveRoutedTaskAgentId(db: Db, task: TaskRow): Promise<number | null> {
  if (!task.task_type) return null;
  try {
    return (await resolveSprintTaskRoutingAssignment(
          db,
          task.sprint_id ?? null,
          task.task_type,
          task.status,
        )).agent_id ?? null;
  } catch {
    return null;
  }
}

function shouldReconcileTaskOwnership(task: TaskRow): boolean {
  if (!task.task_type) return false;
  if (task.active_instance_id != null) return false;
  return true;
}

async function reassignTaskIfNeeded(db: Db, task: TaskRow, nextAgentId: number | null): Promise<TaskRow> {
  if (task.assigned_agent_id === nextAgentId && (task.status !== 'review' || task.review_owner_agent_id != null)) {
    return task;
  }

  const nextReviewOwnerAgentId = task.status === 'review'
    ? (task.review_owner_agent_id ?? (task.assigned_agent_id !== nextAgentId ? task.assigned_agent_id : null))
    : task.review_owner_agent_id;

  if (task.assigned_agent_id === nextAgentId && nextReviewOwnerAgentId === task.review_owner_agent_id) {
    return task;
  }

  await db.run(`
    UPDATE tasks
    SET assigned_agent_id = ?,
        review_owner_agent_id = ?,
        updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = ?
  `, nextAgentId, nextReviewOwnerAgentId, task.id);
  await syncTaskActiveAgentFromInstance(db, task.id);

  if (task.assigned_agent_id !== nextAgentId) {
    const oldName = task.assigned_agent_id ? (await db.get('SELECT name FROM agents WHERE id = ?', task.assigned_agent_id) as { name: string } | undefined)?.name : null;
    const newName = nextAgentId ? (await db.get('SELECT name FROM agents WHERE id = ?', nextAgentId) as { name: string } | undefined)?.name : null;
    await logHistory(db, task.id, 'reconciler', 'assigned_agent_id', oldName ?? 'unassigned', newName ?? String(nextAgentId));
    await log(db,
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

async function getReconcilerProjectIds(db: Db): Promise<number[]> {
  const rows = await db.all(`
    SELECT DISTINCT project_id
    FROM (
      SELECT id AS project_id FROM projects
      UNION ALL
      SELECT project_id FROM agents WHERE project_id IS NOT NULL
      UNION ALL
      SELECT project_id FROM tasks WHERE project_id IS NOT NULL
      UNION ALL
      SELECT project_id FROM routing_config WHERE project_id IS NOT NULL
    ) project_ids
    WHERE project_id IS NOT NULL
    ORDER BY project_id ASC
  `) as Array<{ project_id: number }>;

  return rows.map(row => row.project_id);
}

/**
 * Re-dispatch tasks sitting in `review` to whichever agent the routing rules name.
 *
 * NOT a QA-specific path, despite the name. It fires on the literal status `review` for any
 * workflow, and plenty of workflows have no QA concept at all — a review status might mean human
 * approval, a security pass, or a design check.
 *
 * That is why this used to be wrong. It prepended a hardcoded procedure to the agent's
 * instructions that named `qa_pass`/`qa_fail` outcomes, a `changed_by` of "agency-qa", and direct
 * `PUT /qa-evidence` and `POST /outcome` HTTP calls. All three were assumptions:
 *
 *   - the outcomes are workflow-configured (resolveWorkflow reads them from sprint type config;
 *     qa_pass/qa_fail are only the compatibility fallback), so a workflow using `approved` /
 *     `changes_requested` was told to post an outcome it did not accept;
 *   - the HTTP instructions contradicted the contract template rendered into the same prompt,
 *     which says to use the MCP lifecycle tools and never call the endpoints directly;
 *   - "agency-qa" is one deployment's actor slug.
 *
 * Everything it carried is already rendered correctly and per-workflow by the contract template —
 * see the QA section of agent-contracts/dev.md, which is scoped to "status is review, or valid
 * outcomes include qa_pass/qa_fail" rather than assumed for everyone. So this path now assembles
 * exactly like every other dispatch.
 */
export async function reconcileReviewQaRouting(
  deps: DispatchDeps = { dispatchInstance },
  db: Db = getDb(),
): Promise<void> {
  const reviewTasks = await db.all(`
    SELECT t.*
    FROM tasks t
    WHERE t.status = 'review'
      AND t.paused_at IS NULL
      AND (t.sprint_id IS NULL OR EXISTS (
        SELECT 1 FROM sprints sp WHERE sp.id = t.sprint_id AND sp.status != 'closed'
      ))
    ORDER BY t.updated_at ASC
  `) as TaskRow[];

  const statusEligibility = await getNonDispatchableTaskStatusPredicate(db, 't', 's');
  const routedTasks = await db.all(`
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
  `, ...statusEligibility.params) as TaskRow[];

  for (const task of routedTasks) {
    if (!shouldReconcileTaskOwnership(task)) continue;
    const routedAgentId = await resolveRoutedTaskAgentId(db, task);
    if (routedAgentId == null || routedAgentId === task.assigned_agent_id) continue;
    await reassignTaskIfNeeded(db, task, routedAgentId);
  }

  for (const originalTask of reviewTasks) {
    const routedAgentId = await resolveRoutedTaskAgentId(db, originalTask);
    if (routedAgentId == null) continue;

    // Skip entire task if it already has a live instance (no point trying any rule)
    if (await hasTaskLiveInstance(db, originalTask.id)) continue;

    let agent: AgentRow | undefined;
    if (routedAgentId) {
      agent = await db.get(`SELECT * FROM agents WHERE id = ? AND enabled = 1`, routedAgentId) as AgentRow | undefined;
    }
    if (!agent) continue;
    const agentLabel = agent.name || agent.job_title || `Agent #${agent.id}`;

    // Agent busy? leave review ownership converged on next tick when capacity frees up
    if (await isAgentBusy(db, agent.id)) continue;

    // Agent is available — now safe to write task reassignment to DB
    const task = await reassignTaskIfNeeded(db, originalTask, routedAgentId);
    if (!task.assigned_agent_id) continue;

    const sprint = task.sprint_id
      ? await db.get('SELECT * FROM sprints WHERE id = ?', task.sprint_id) as SprintRow | undefined
      : undefined;

    // The agent's own instructions, exactly as the routed dispatch path uses them. This path used
    // to prepend a hardcoded QA procedure; see the note on reconcileReviewQaRouting for why that
    // could not be correct for every workflow.
    const jobInstructions = agent.job_instructions;

    const supportsDurableRunId = await tableHasColumn(db, 'job_instances', 'durable_run_id');
    const instanceResult = supportsDurableRunId
      ? await db.run(`
          INSERT INTO job_instances (tenant_id, agent_id, status, durable_run_id)
          VALUES (?, ?, 'queued', ?)
        `, task.tenant_id, agent.id, createDurableRunId())
      : await db.run(`
          INSERT INTO job_instances (tenant_id, agent_id, status)
          VALUES (?, ?, 'queued')
        `, task.tenant_id, agent.id);
    const instanceId = instanceResult.lastInsertId as number;
    await attachInstanceToTask(db, instanceId, task.id);

    try {
      const taskNotesContext = await getDispatchTaskNotesContext(db, {
                  taskId: task.id,
                  agentId: agent.id,
                  currentInstanceId: instanceId,
                });

      const teamContext = await resolveTeamContextForDispatch(db, {
        agentId: agent.id,
        sprintId: task.sprint_id ?? null,
      });

      const agentSlug = resolveRuntimeAgentSlug(agent)
        ?? agent.session_key.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
      const durableRunId = await ensureJobInstanceDurableRunId(db, instanceId);
      const runSessionKey = buildHookSessionKey(instanceId, durableRunId);

      // This path never creates a worktree — dispatchInstance reads whatever the payload already
      // carries — so the authoritative root is the agent's runtime working directory or its
      // workspace. Resolving it here is what lets a QA retry carry the same workspace block a
      // first dispatch does, instead of leaving the agent to guess.
      const pathContext = resolveDispatchPathContext({
        worktreePath: null,
        runtimeConfigWorkingDirectory: extractWorkingDirectoryFromRuntimeConfig(agent.runtime_config),
        workspacePath: agent.workspace_path ?? null,
      });
      const ghIdentity = await resolveGitHubIdentity(db, agent.id);
      if (ghIdentity && pathContext.activeRepoRoot) {
        injectGitHubCredentials(pathContext.activeRepoRoot, ghIdentity.identity);
      }

      const scope = await loadDispatchScopeContext(db, {
        projectId: task.project_id ?? null,
        workflowId: task.sprint_id ?? null,
      });

      const contextBundle = buildDispatchContextBundle({
        workflow: {
          id: task.sprint_id ?? null,
          name: sprint?.name ?? scope.workflow?.name ?? null,
          goal: sprint?.goal ?? scope.workflow?.goal ?? null,
        },
        team: teamContext,
        project: scope.project,
        job: { agentId: agent.id, title: agentLabel, instructions: jobInstructions },
        task: {
          id: task.id,
          title: task.title,
          description: task.description ?? '',
          priority: task.priority ?? 'medium',
          status: task.status,
          workflowName: sprint?.name ?? null,
        },
        skillName: agent.skill_name,
        taskNotes: { context: taskNotesContext, taskId: task.id },
        workspace: pathContext,
        contract: await buildInstanceCallbackContractSegmentDraft({
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
        }),
        githubIdentity: { resolved: ghIdentity, workingDirectory: pathContext.activeRepoRoot },
      });
      const message = contextBundle.promptText;

      const effectiveModel = agent.model ?? null;

      await withReconcilerTimeout(
        deps.dispatchInstance({
          instanceId,
          agentId: agent.id,
          jobTitle: agentLabel,
          sessionKey: agent.session_key,
          openclawAgentId: agent.openclaw_agent_id,
          message,
          model: effectiveModel,
          preferredProvider: agent.preferred_provider ?? null,
          providerConnectionId: agent.provider_connection_id ?? null,
          timeoutSeconds: agent.timeout_seconds,
          hooksUrl: agent.hooks_url,
          hooksAuthHeader: agent.hooks_auth_header,
          runtimeType: agent.runtime_type,
          runtimeConfig: agent.runtime_config,
          storyPoints: task.story_points ?? null,
          projectId: task.project_id ?? null,
          sprintId: task.sprint_id ?? null,
          taskId: task.id,
          contextBundle,
        }),
        RECONCILER_OPERATION_TIMEOUT_MS,
        `QA dispatch task #${task.id} project=${task.project_id ?? 'none'} agent=${agent.id} instance=${instanceId}`,
      );

      await log(db,
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
      await db.run(`
        UPDATE job_instances
        SET status = 'failed',
            error = ?,
            completed_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
        WHERE id = ?
          AND status NOT IN ('done', 'failed', 'cancelled')
      `, err instanceof Error ? err.message : String(err), instanceId);
      // Restore previous active_instance_id if this failed instance was set as active
      const currentTask = await db.get('SELECT active_instance_id FROM tasks WHERE id = ?', task.id) as { active_instance_id: number | null } | undefined;
      if (currentTask?.active_instance_id === instanceId) {
        await db.run(`
          UPDATE tasks SET active_instance_id = NULL, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?
        `, task.id);
        // Recorded so the detach is visible. An agent refused for not owning "the active
        // dispatched instance" is refused precisely because this link is gone, and without a
        // history row there is nothing to show it was ever here or who removed it.
        await writeTaskHistory(db, task.id, 'reconciler', 'active_instance_id', instanceId, null);
      }
    }
  }
}

async function reconcileInProgressRecovery(db: Db): Promise<void> {
  const inProgressTasks = await db.all(`
    SELECT t.* FROM tasks t
      WHERE t.status = 'in_progress'
      AND t.assigned_agent_id IS NOT NULL
      AND t.paused_at IS NULL
  `) as TaskRow[];

  const now = Date.now();

  for (const task of inProgressTasks) {
    const agent = await db.get(`SELECT * FROM agents WHERE id = ?`, task.assigned_agent_id!) as AgentRow | undefined;
    if (!agent) continue;

    const liveInstance = await db.get(`
      SELECT id FROM job_instances
      WHERE agent_id = ? AND status IN ('queued', 'dispatched', 'running')
      LIMIT 1
    `, agent.id);

    if (liveInstance) continue;

    const raw = task.updated_at;
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const withZ = normalized.endsWith('Z') ? normalized : normalized + 'Z';
    const updatedMs = new Date(withZ).getTime();
    const elapsedMs = now - updatedMs;
    const timeoutMs = (agent.timeout_seconds || 900) * 1000;

    if (elapsedMs >= timeoutMs) {
      const elapsedMin = Math.floor(elapsedMs / 60000);
      await log(
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
export async function reconcileOrphanInProgressTasks(db: Db): Promise<void> {
  const orphans = await db.all(`
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
  `) as Array<{
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

    const agentName = await resolveAgentName(db, orphan.agent_id);

    // Always log orphan detection for observability (rate-limited to once per 10 min per task).
    const recentOrphanLog = await db.get(`
      SELECT id FROM logs
      WHERE message LIKE ? AND created_at > to_char((now() AT TIME ZONE 'utc' - interval '10 minute'), 'YYYY-MM-DD HH24:MI:SS')
      LIMIT 1
    `, `%Orphan in_progress: task #${orphan.id}%`) as { id: number } | undefined;

    if (!recentOrphanLog) {
      const detectMsg = `Orphan in_progress: task #${orphan.id} "${orphan.title}" — ${instanceDesc}, elapsed=${elapsedMin}m, agent=${agentName ?? 'none'}`;
      console.warn(`[reconciler] ${detectMsg}`);
      await log(db, detectMsg, orphan.id, orphan.agent_id ?? undefined);
    }

    if (elapsedMs < ORPHAN_STALL_GRACE_MS) continue;

    await log(
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

async function reconcileMissingLifecycleOutcomeAfterRuntimeEnd(db: Db): Promise<void> {
  const now = Date.now();
  const eligibleStatuses = await getNeedsAttentionEligibleStatuses(db);
  if (eligibleStatuses.length === 0) return;
  const placeholders = eligibleStatuses.map(() => '?').join(', ');

  const candidates = await db.all(`
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
  `, ...eligibleStatuses) as Array<{
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
    if (!await taskRequiresSemanticOutcome(db, task.id)) continue;

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

    await markTaskNeedsAttentionForMissingSemanticHandoff(db, {
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

    await log(db,
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
async function logStuckReviewTasks(db: Db): Promise<void> {
  const stuckTasks = await db.all(`
    SELECT t.id, t.title, t.agent_id, t.updated_at
    FROM tasks t
    WHERE t.status = 'review'
      AND t.paused_at IS NULL
      AND t.active_instance_id IS NULL
      AND t.updated_at < to_char((now() AT TIME ZONE 'utc' - interval '5 minute'), 'YYYY-MM-DD HH24:MI:SS')
      AND (t.sprint_id IS NULL OR EXISTS (
        SELECT 1 FROM sprints sp WHERE sp.id = t.sprint_id AND sp.status != 'closed'
      ))
  `) as Array<{ id: number; title: string; agent_id: number | null; updated_at: string }>;

  for (const task of stuckTasks) {
    const agentName = await resolveAgentName(db, task.agent_id);
    const msg = `⚠ Stuck review: task #${task.id} "${task.title}" has been in review with no active instance for >5 min (agent=${agentName ?? 'none'}, updated_at=${task.updated_at})`;
    console.warn(`[reconciler] ${msg}`);
    // Log to DB but only once per 30 minutes per task to avoid spam
    const recentLog = await db.get(`
      SELECT id FROM logs
      WHERE message LIKE ? AND created_at > to_char((now() AT TIME ZONE 'utc' - interval '30 minute'), 'YYYY-MM-DD HH24:MI:SS')
      LIMIT 1
    `, `%Stuck review: task #${task.id}%`) as { id: number } | undefined;
    if (!recentLog) {
      await log(db, msg, task.id, task.agent_id ?? undefined);
    }
  }
}

export async function runReconcilerTick(
  deps: ReconcilerDeps = DEFAULT_RECONCILER_DEPS,
  db: Db = getDb(),
): Promise<ReconcilerTickSummary> {
  try {
    const runtimeSummary = await reconcileRuntimeExecutions(db);
    if (runtimeSummary.lost > 0 || runtimeSummary.converged > 0 || runtimeSummary.errors > 0) {
      console.warn(
        `[runtime-reconciler] inspected=${runtimeSummary.inspected} alive=${runtimeSummary.alive} lost=${runtimeSummary.lost} converged=${runtimeSummary.converged} errors=${runtimeSummary.errors}`,
      );
    }
  } catch (error) {
    // Runtime integrity must not block workflow reconciliation during a rolling
    // migration or a transient database failure.
    console.warn(
      '[runtime-reconciler] tick failed:',
      error instanceof Error ? error.message : String(error),
    );
  }
  await reconcileMissingLifecycleOutcomeAfterRuntimeEnd(db);
  await cleanupImpossibleTaskLifecycleStates(db);

  const projectIds = await getReconcilerProjectIds(db);
  const summary = createEmptySummary(projectIds);
  summary.recurring = await runRecurringTaskSchedulerTick(db);

  for (const projectId of projectIds) {
    try {
      const eligibility = await deps.runEligibilityPass(db, projectId);
      const dispatch = await deps.runDispatcher(db, projectId);

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
  await reconcileOrphanInProgressTasks(db);
  await reconcileInProgressRecovery(db);
  await logStuckReviewTasks(db);

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
