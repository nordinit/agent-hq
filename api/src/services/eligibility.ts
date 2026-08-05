import { notifyTelegram } from '../integrations/telegram';
import { writeTaskStatusChange } from '../domains/tasks/history';
import { type Db } from "../db/adapter/types";
import { columnExists as sharedColumnExists } from "../db/introspection";

// ── Types ────────────────────────────────────────────────────────────────────

export interface EligibilityResult {
  promoted: number;   // retained for API compatibility; background pass should keep this at 0
  blocked: number;    // retained for API compatibility; background pass should keep this at 0
  stalled: number;    // retained for API compatibility; no visible auto-stall remains
  unclaimed: number;  // retained for API compatibility; no visible auto-unclaim remains
}

interface TaskRow {
  id: number;
  status: string;
  agent_id: number | null;
  assigned_agent_id?: number | null;
  project_id: number | null;
  sprint_id: number | null;
  claimed_at: string | null;
  dispatched_at: string | null;
  retry_count: number;
  max_retries: number;
  review_owner_agent_id: number | null;
  updated_at: string;
  task_type: string | null;
  active_instance_id?: number | null;
  review_commit?: string | null;
  qa_verified_commit?: string | null;
}

interface RoutingConfigRow {
  stall_threshold_min: number;
  max_retries: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getRoutingConfig(db: Db, agentId: number | null): Promise<RoutingConfigRow> {
  // Task #596: routing_config_legacy has been removed. Read config from agents table.
  if (agentId == null) return { stall_threshold_min: 30, max_retries: 3 };
  try {
    const agentRow = await db.get(`SELECT stall_threshold_min, max_retries FROM agents WHERE id = ?`, agentId) as RoutingConfigRow | undefined;
    return agentRow ?? { stall_threshold_min: 30, max_retries: 3 };
  } catch {
    return { stall_threshold_min: 30, max_retries: 3 };
  }
}


// ── Main pass ────────────────────────────────────────────────────────────────

export async function runEligibilityPass(db: Db, projectId?: number): Promise<EligibilityResult> {
  const result: EligibilityResult = { promoted: 0, blocked: 0, stalled: 0, unclaimed: 0 };

  const projectFilter = projectId != null ? `AND t.project_id = ${projectId}` : '';

  // ── 1. Background eligibility never changes visible workflow status ───────
  // No todo → ready, ready → dispatched, review → ready_to_merge, or any other
  // board-facing transition belongs here. Visible movement must happen through
  // explicit outcomes or workflow-event routing.

  // ── 2. Runtime-integrity observability only ───────────────────────────────
  // Automatic in_progress → stalled recovery has been removed. Reconciler and
  // eligibility still repair linkage drift elsewhere, but visible workflow
  // recovery must come from explicit routing/outcomes, not hidden heuristics.

  // ── 5. stalled ───────────────────────────────────────────────────────────
  // Stalled tasks are intentionally left untouched by automatic eligibility
  // or reconciler recovery. They remain stalled until a human explicitly
  // moves them.

  // ── 6. review → ready (QA fail path) — handled by QA agent via PUT /tasks/:id ──
  // The QA agent sets status='todo' and resets agent_id to review_owner_agent_id.
  // This service handles the retry_count increment + failed promotion.
  const reviewTasks = await db.all(`
    SELECT t.*
    FROM tasks t
    WHERE t.status = 'review'
    ${projectFilter}
  `) as TaskRow[];

  for (const task of reviewTasks) {
    // Only act if review_owner_agent_id is set AND the task has exceeded max_retries
    // Normal QA fail flow is initiated by the QA agent — we only sweep for stuck review tasks
    // that have been rejected but not re-routed.
    // (Standard path: QA agent does PUT {status:'todo', agent_id: review_owner_agent_id} — not here)
    // This block is intentionally left as documentation for the dispatcher to handle via QA agent.
    void task; // suppress unused warning
  }

  return result;
}

/**
 * resetFromQAFail — called by QA agent (or review endpoint) to demote a reviewed task back.
 * Increments retry_count. If retry_count >= max_retries: sets failed. Otherwise: resets to ready.
 * Returns the new status.
 */
export async function resetFromQAFail(db: Db, taskId: number): Promise<'ready' | 'failed'> {
  const task = await db.get(`SELECT * FROM tasks WHERE id = ?`, taskId) as TaskRow | undefined;
  if (!task) throw new Error(`Task ${taskId} not found`);

  const assignedAgentId = task.assigned_agent_id ?? task.agent_id;
  const config = await getRoutingConfig(db, assignedAgentId);
  const newRetryCount = task.retry_count + 1;
  const maxRetries = config.max_retries ?? task.max_retries ?? 3;

  if (newRetryCount >= maxRetries) {
    await db.run(`
      UPDATE tasks SET status = 'failed', retry_count = ?, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?
    `, newRetryCount, taskId);
    await writeTaskStatusChange(db, taskId, 'eligibility', task.status, 'failed');
    return 'failed';
  } else {
    const targetAgentId = task.review_owner_agent_id ?? assignedAgentId;
    const hasAssignedAgentColumn = await sharedColumnExists(db, 'tasks', 'assigned_agent_id');
    const assignmentColumn = hasAssignedAgentColumn ? 'assigned_agent_id' : 'agent_id';
    await db.run(`
      UPDATE tasks
      SET status = 'ready', retry_count = ?, ${assignmentColumn} = ?, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = ?
    `, newRetryCount, targetAgentId, taskId);
    await writeTaskStatusChange(db, taskId, 'eligibility', task.status, 'ready');
    return 'ready';
  }
}
