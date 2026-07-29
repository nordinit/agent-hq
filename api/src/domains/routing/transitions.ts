import { isValidTaskType } from '../../lib/taskTypes';
import { listSprintTaskTransitions } from './policy/statuses';
import { seedSprintTaskPolicy } from './policy/seed';
import {
  parseSprintId,
  requireProjectSprintTypeScope,
  requireScopedTransitionContext,
  readScopedRoutingTransition,
  selectTransitionScopeRows,
  annotateTransitionScope,
  withStatus,
  tenantInsertFragment,
  tenantPredicateFor,
  tableHasTransitionScopeColumns,
  RoutingRuleRecord,
} from './scope';
import {
  requireRoutingRuleStatusForSprint,
  requireRoutingRuleStatusForSprintType,
  requireRoutingRuleTaskTypeForSprint,
  requireRoutingRuleTaskTypeForSprintType,
} from './validation';
import { type Db } from "../../db/adapter/types";

export async function listRoutingTransitions(db: Db, input: { project_id?: unknown; sprint_id?: unknown; sprint_type?: unknown; tenant_id?: unknown }) {
  const scope = await requireProjectSprintTypeScope(db, input);
  const transitions = annotateTransitionScope(await selectTransitionScopeRows(db, scope), scope.sprintId);
  return {
    transitions,
    scope: {
      project_id: scope.projectId,
      sprint_type: scope.sprintType,
      sprint_id: scope.sprintId,
    },
  };
}

export async function getRoutingTransition(db: Db, input: { id: unknown; project_id?: unknown; sprint_id?: unknown; sprint_type?: unknown; tenant_id?: unknown }) {
  const id = Number(input.id);
  if (!Number.isFinite(id)) throw withStatus('Valid transition id is required', 400);

  const scope = await requireProjectSprintTypeScope(db, input as { project_id?: unknown; sprint_id?: unknown; sprint_type?: unknown; tenant_id?: unknown });
  const transition = await readScopedRoutingTransition(db, scope, id);
  if (!transition) throw withStatus('Routing transition not found', 404);
  return transition;
}

export async function createRoutingTransition(db: Db, input: Record<string, unknown>) {
  const scope = await requireScopedTransitionContext(db, input.project_id, input.sprint_id, input.sprint_type, input.tenant_id);
  const { task_type, from_status, outcome, to_status, enabled = 1, priority = 0, is_protected = 0 } = input;

  if (!from_status || !outcome || !to_status) {
    throw withStatus('project_id, sprint_type or sprint_id, from_status, outcome, and to_status are required', 400);
  }

  if (task_type && !isValidTaskType(task_type)) {
    throw withStatus(`Invalid task_type "${task_type}". Task type keys must use lowercase letters, numbers, underscores, or hyphens.`, 400);
  }

  if (scope.sprintId != null) {
    await seedSprintTaskPolicy(db, scope.sprintId);
    await requireRoutingRuleStatusForSprint(db, scope.sprintId, String(from_status));
    await requireRoutingRuleStatusForSprint(db, scope.sprintId, String(to_status));
    if (task_type) await requireRoutingRuleTaskTypeForSprint(db, scope.sprintId, String(task_type));
  } else {
    await requireRoutingRuleStatusForSprintType(db, scope.sprintType, String(from_status));
    await requireRoutingRuleStatusForSprintType(db, scope.sprintType, String(to_status));
    if (task_type) await requireRoutingRuleTaskTypeForSprintType(db, scope.sprintType, String(task_type));
  }

  const tenant = await tenantInsertFragment(db, 'sprint_task_transitions', scope.tenantId);
  const result = await tableHasTransitionScopeColumns(db)
    ? await db.run(`
        INSERT INTO sprint_task_transitions (${tenant.columns}sprint_id, project_id, sprint_type, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at)
        VALUES (${tenant.placeholders}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `, ...tenant.params, scope.sprintId, scope.projectId, scope.sprintType, task_type ?? null, from_status, outcome, to_status, enabled ? 1 : 0, priority, is_protected ? 1 : 0)
    : await db.run(`
        INSERT INTO sprint_task_transitions (${tenant.columns}sprint_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at)
        VALUES (${tenant.placeholders}?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `, ...tenant.params, scope.sprintId, task_type ?? null, from_status, outcome, to_status, enabled ? 1 : 0, priority, is_protected ? 1 : 0);

  return await readScopedRoutingTransition(db, { projectId: scope.projectId, sprintType: scope.sprintType, sprintId: scope.sprintId, tenantId: scope.tenantId, scopeLabel: scope.sprintName ?? scope.sprintType }, Number(result.lastInsertId));
}

export async function updateRoutingTransition(db: Db, input: Record<string, unknown> & { id: unknown }) {
  const id = Number(input.id);
  if (!Number.isFinite(id)) throw withStatus('Valid transition id is required', 400);

  const scope = await requireScopedTransitionContext(db, input.project_id, input.sprint_id, input.sprint_type, input.tenant_id);
  if (scope.sprintId != null) await seedSprintTaskPolicy(db, scope.sprintId);
  const tenant = await tenantPredicateFor(db, 'sprint_task_transitions', 'stt', scope.tenantId);
  const existing = await tableHasTransitionScopeColumns(db)
    ? await db.get(`
        SELECT stt.*
        FROM sprint_task_transitions stt
        LEFT JOIN sprints s ON s.id = stt.sprint_id
        WHERE stt.id = ?
          AND COALESCE(stt.project_id, s.project_id) = ?
          AND COALESCE(stt.sprint_type, s.sprint_type) = ?
          AND ((stt.sprint_id IS NULL AND ? IS NULL) OR stt.sprint_id = ?)
          ${tenant.sql}
      `, id, scope.projectId, scope.sprintType, scope.sprintId, scope.sprintId, ...tenant.params) as RoutingRuleRecord | undefined
    : await db.get(`
        SELECT *
        FROM sprint_task_transitions
        WHERE id = ? AND sprint_id = ?
      `, id, scope.sprintId) as RoutingRuleRecord | undefined;
  if (!existing) throw withStatus('Routing transition not found', 404);

  const { task_type, from_status, outcome, to_status, enabled, priority, is_protected } = input;
  if (task_type !== undefined && task_type !== null && !isValidTaskType(task_type)) {
    throw withStatus(`Invalid task_type "${task_type}". Task type keys must use lowercase letters, numbers, underscores, or hyphens.`, 400);
  }

  const nextTaskType = task_type !== undefined ? (task_type ?? null) : existing.task_type;
  const nextFromStatus = String(from_status ?? existing.from_status);
  const nextToStatus = String(to_status ?? existing.to_status);
  if (scope.sprintId != null) {
    await requireRoutingRuleStatusForSprint(db, scope.sprintId, nextFromStatus);
    await requireRoutingRuleStatusForSprint(db, scope.sprintId, nextToStatus);
    if (nextTaskType) await requireRoutingRuleTaskTypeForSprint(db, scope.sprintId, String(nextTaskType));
  } else {
    await requireRoutingRuleStatusForSprintType(db, scope.sprintType, nextFromStatus);
    await requireRoutingRuleStatusForSprintType(db, scope.sprintType, nextToStatus);
    if (nextTaskType) await requireRoutingRuleTaskTypeForSprintType(db, scope.sprintType, String(nextTaskType));
  }

  const updateTenant = await tenantPredicateFor(db, 'sprint_task_transitions', 'sprint_task_transitions', scope.tenantId);
  await db.run(`
    UPDATE sprint_task_transitions SET
      task_type = ?,
      from_status = ?,
      outcome = ?,
      to_status = ?,
      enabled = ?,
      priority = ?,
      is_protected = ?,
      updated_at = datetime('now')
    WHERE id = ?${updateTenant.sql}
  `, nextTaskType, nextFromStatus, outcome ?? existing.outcome, nextToStatus, enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled, priority !== undefined ? priority : existing.priority, is_protected !== undefined ? (is_protected ? 1 : 0) : existing.is_protected, id, ...updateTenant.params);

  return await readScopedRoutingTransition(db, { projectId: scope.projectId, sprintType: scope.sprintType, sprintId: scope.sprintId, tenantId: scope.tenantId, scopeLabel: scope.sprintName ?? scope.sprintType }, id);
}

export async function deleteRoutingTransition(db: Db, input: { id: unknown; project_id?: unknown; sprint_id?: unknown; sprint_type?: unknown; tenant_id?: unknown }) {
  const id = Number(input.id);
  if (!Number.isFinite(id)) throw withStatus('Valid transition id is required', 400);

  const scope = await requireScopedTransitionContext(db, input.project_id, input.sprint_id, input.sprint_type, input.tenant_id);
  const tenant = await tenantPredicateFor(db, 'sprint_task_transitions', 'stt', scope.tenantId);
  const existing = await tableHasTransitionScopeColumns(db)
    ? await db.get(`
        SELECT stt.id
        FROM sprint_task_transitions stt
        LEFT JOIN sprints s ON s.id = stt.sprint_id
        WHERE stt.id = ?
          AND COALESCE(stt.project_id, s.project_id) = ?
          AND COALESCE(stt.sprint_type, s.sprint_type) = ?
          AND ((stt.sprint_id IS NULL AND ? IS NULL) OR stt.sprint_id = ?)
          ${tenant.sql}
      `, id, scope.projectId, scope.sprintType, scope.sprintId, scope.sprintId, ...tenant.params)
    : await db.get('SELECT id FROM sprint_task_transitions WHERE id = ? AND sprint_id = ?', id, scope.sprintId);
  if (!existing) throw withStatus('Routing transition not found', 404);
  const deleteTenant = await tenantPredicateFor(db, 'sprint_task_transitions', 'sprint_task_transitions', scope.tenantId);
  await db.run(`DELETE FROM sprint_task_transitions WHERE id = ?${deleteTenant.sql}`, id, ...deleteTenant.params);
  return { ok: true };
}

export async function resolveLifecycleRule(db: Db, input: { project_id?: unknown; sprint_id?: unknown; task_type?: unknown; from_status?: unknown; outcome?: unknown; tenant_id?: unknown }) {
  const { sprintId, sprintName, projectId } = await requireScopedTransitionContext(db, input.project_id, input.sprint_id, undefined, input.tenant_id);
  const { task_type, from_status, outcome } = input;

  if (!from_status || !outcome || sprintId == null) {
    throw withStatus('project_id, sprint_id, from_status, and outcome are required', 400);
  }

  const rule = (await listSprintTaskTransitions(db, sprintId))
    .filter((transition) => transition.enabled)
    .filter((transition) => transition.from_status === String(from_status) && transition.outcome === String(outcome))
    .filter((transition) => {
      if (!task_type) return transition.task_type == null;
      return transition.task_type === String(task_type) || transition.task_type == null;
    })
    .sort((a, b) => {
      const typeWeightA = a.task_type ? 1 : 0;
      const typeWeightB = b.task_type ? 1 : 0;
      if (typeWeightA !== typeWeightB) return typeWeightB - typeWeightA;
      if ((a.priority ?? 0) !== (b.priority ?? 0)) return (b.priority ?? 0) - (a.priority ?? 0);
      return a.id - b.id;
    })[0];

  if (!rule) {
    return {
      matched: false,
      rule: null,
      project_id: projectId,
      sprint_id: sprintId,
      sprint_name: sprintName,
      reason: `No transition for ${task_type ?? '*'}/${from_status}:${outcome}`,
    };
  }

  return {
    matched: true,
    rule: {
      ...rule,
      project_id: projectId,
      sprint_id: sprintId,
      sprint_name: sprintName,
    },
  };
}
