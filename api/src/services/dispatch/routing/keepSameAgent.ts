import { type Db } from '../../../db/adapter/types';
import {
  getTaskStatusOwner,
  isKeepSameAgentEnabled,
  recordTaskStatusOwner,
  type TaskStatusOwner,
} from '../../../domains/tasks/statusOwners';
import { getMatchingAssignmentRules, type AssignmentRuleScope } from './assignmentRules';

/**
 * Keep same agent: when a workflow type turns it on, a task that comes back to a status it has been
 * worked in before can only be dispatched to that status's owner (see domains/tasks/statusOwners).
 * If the owner is busy the task waits for them.
 *
 * The owner is required only while it can still work the status: it must be one of the candidates
 * the assignment rules produce (an enabled agent with an enabled rule for this status and task type).
 * On a first visit to a status, or when the owner was disabled or lost its rule, nothing is required
 * and normal rule priority applies. With the setting off nothing changes at all.
 */

export type KeepSameAgentTask = AssignmentRuleScope & { id: number };

export async function applyKeepSameAgent<T extends { agent_id: number }>(
  db: Db,
  task: KeepSameAgentTask,
  candidates: T[],
): Promise<{ candidates: T[]; owner: TaskStatusOwner | null }> {
  if (candidates.length === 0 || !await isKeepSameAgentEnabled(db, task.workflow_id)) return { candidates, owner: null };
  const owner = await getTaskStatusOwner(db, task.id, task.status);
  if (!owner) return { candidates, owner: null };
  const ownerCandidates = candidates.filter(candidate => Number(candidate.agent_id) === Number(owner.agent_id));
  return ownerCandidates.length > 0 ? { candidates: ownerCandidates, owner } : { candidates, owner: null };
}

async function loadKeepSameAgentTask(db: Db, taskId: number, status?: string): Promise<KeepSameAgentTask | null> {
  const row = await db.get<KeepSameAgentTask>(`
    SELECT t.id, t.tenant_id, t.project_id, t.workflow_id, w.workflow_type, t.status, t.task_type
    FROM tasks t
    LEFT JOIN workflows w ON w.id = t.workflow_id
    WHERE t.id = ?
  `, taskId);
  if (!row) return null;
  return status === undefined ? row : { ...row, status };
}

/**
 * The owner Keep same agent requires for a task in `status` (default: its current status), or null
 * when it requires none.
 */
export async function resolveRequiredStatusOwner(db: Db, taskId: number, status?: string): Promise<TaskStatusOwner | null> {
  const task = await loadKeepSameAgentTask(db, taskId, status);
  if (!task) return null;
  return (await applyKeepSameAgent(db, task, await getMatchingAssignmentRules(db, task))).owner;
}

/** A launched run makes its agent the owner of the status it was dispatched for. */
export async function recordDispatchStatusOwner(db: Db, input: {
  taskId: number;
  status: string;
  agentId: number;
  instanceId: number;
}): Promise<void> {
  await recordTaskStatusOwner(db, { ...input, source: 'dispatch' });
}
