import { isValidTaskType } from '../../lib/taskTypes';
import { listWorkflowTaskTransitions } from './policy/statuses';
import {
  parseWorkflowId,
  requireProjectWorkflowTypeScope,
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
  requireRoutingRuleStatusForWorkflow,
  requireRoutingRuleStatusForWorkflowType,
  requireRoutingRuleTaskTypeForWorkflow,
  requireRoutingRuleTaskTypeForWorkflowType,
} from './validation';
import { type Db } from "../../db/adapter/types";

export async function listRoutingTransitions(db: Db, input: { project_id?: unknown; workflow_id?: unknown; workflow_type?: unknown; tenant_id?: unknown }) {
  const scope = await requireProjectWorkflowTypeScope(db, input);
  const transitions = annotateTransitionScope(await selectTransitionScopeRows(db, scope), scope.workflowId);
  return {
    transitions,
    scope: {
      project_id: scope.projectId,
      workflow_type: scope.workflowType,
      workflow_id: scope.workflowId,
    },
  };
}

export async function getRoutingTransition(db: Db, input: { id: unknown; project_id?: unknown; workflow_id?: unknown; workflow_type?: unknown; tenant_id?: unknown }) {
  const id = Number(input.id);
  if (!Number.isFinite(id)) throw withStatus('Valid transition id is required', 400);

  const scope = await requireProjectWorkflowTypeScope(db, input as { project_id?: unknown; workflow_id?: unknown; workflow_type?: unknown; tenant_id?: unknown });
  const transition = await readScopedRoutingTransition(db, scope, id);
  if (!transition) throw withStatus('Routing transition not found', 404);
  return transition;
}

export async function createRoutingTransition(db: Db, input: Record<string, unknown>) {
  const scope = await requireScopedTransitionContext(db, input.project_id, input.workflow_id, input.workflow_type, input.tenant_id);
  const { task_type, from_status, outcome, to_status, enabled = 1, priority = 0, is_protected = 0 } = input;

  if (!from_status || !outcome || !to_status) {
    throw withStatus('project_id, workflow_type or workflow_id, from_status, outcome, and to_status are required', 400);
  }

  if (task_type && !isValidTaskType(task_type)) {
    throw withStatus(`Invalid task_type "${task_type}". Task type keys must use lowercase letters, numbers, underscores, or hyphens.`, 400);
  }

  if (scope.workflowId != null) {
    await requireRoutingRuleStatusForWorkflow(db, scope.workflowId, String(from_status));
    await requireRoutingRuleStatusForWorkflow(db, scope.workflowId, String(to_status));
    if (task_type) await requireRoutingRuleTaskTypeForWorkflow(db, scope.workflowId, String(task_type));
  } else {
    await requireRoutingRuleStatusForWorkflowType(db, scope.workflowType, String(from_status));
    await requireRoutingRuleStatusForWorkflowType(db, scope.workflowType, String(to_status));
    if (task_type) await requireRoutingRuleTaskTypeForWorkflowType(db, scope.workflowType, String(task_type));
  }

  const tenant = await tenantInsertFragment(db, 'workflow_task_transitions', scope.tenantId);
  const result = await tableHasTransitionScopeColumns(db)
    ? await db.run(`
        INSERT INTO workflow_task_transitions (${tenant.columns}workflow_id, project_id, workflow_type, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at)
        VALUES (${tenant.placeholders}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
      `, ...tenant.params, scope.workflowId, scope.projectId, scope.workflowType, task_type ?? null, from_status, outcome, to_status, enabled ? 1 : 0, priority, is_protected ? 1 : 0)
    : await db.run(`
        INSERT INTO workflow_task_transitions (${tenant.columns}workflow_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at)
        VALUES (${tenant.placeholders}?, ?, ?, ?, ?, ?, ?, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
      `, ...tenant.params, scope.workflowId, task_type ?? null, from_status, outcome, to_status, enabled ? 1 : 0, priority, is_protected ? 1 : 0);

  return await readScopedRoutingTransition(db, { projectId: scope.projectId, workflowType: scope.workflowType, workflowId: scope.workflowId, tenantId: scope.tenantId, scopeLabel: scope.workflowName ?? scope.workflowType }, Number(result.lastInsertId));
}

export async function updateRoutingTransition(db: Db, input: Record<string, unknown> & { id: unknown }) {
  const id = Number(input.id);
  if (!Number.isFinite(id)) throw withStatus('Valid transition id is required', 400);

  const scope = await requireScopedTransitionContext(db, input.project_id, input.workflow_id, input.workflow_type, input.tenant_id);
  const tenant = await tenantPredicateFor(db, 'workflow_task_transitions', 'stt', scope.tenantId);
  const existing = await tableHasTransitionScopeColumns(db)
    ? await db.get(`
        SELECT stt.*
        FROM workflow_task_transitions stt
        LEFT JOIN workflows s ON s.id = stt.workflow_id
        WHERE stt.id = ?
          AND COALESCE(stt.project_id, s.project_id) = ?
          AND COALESCE(stt.workflow_type, s.workflow_type) = ?
          AND ((stt.workflow_id IS NULL AND ?::text IS NULL) OR stt.workflow_id = ?)
          ${tenant.sql}
      `, id, scope.projectId, scope.workflowType, scope.workflowId, scope.workflowId, ...tenant.params) as RoutingRuleRecord | undefined
    : await db.get(`
        SELECT *
        FROM workflow_task_transitions
        WHERE id = ? AND workflow_id = ?
      `, id, scope.workflowId) as RoutingRuleRecord | undefined;
  if (!existing) throw withStatus('Routing transition not found', 404);

  const { task_type, from_status, outcome, to_status, enabled, priority, is_protected } = input;
  if (task_type !== undefined && task_type !== null && !isValidTaskType(task_type)) {
    throw withStatus(`Invalid task_type "${task_type}". Task type keys must use lowercase letters, numbers, underscores, or hyphens.`, 400);
  }

  const nextTaskType = task_type !== undefined ? (task_type ?? null) : existing.task_type;
  const nextFromStatus = String(from_status ?? existing.from_status);
  const nextToStatus = String(to_status ?? existing.to_status);
  if (scope.workflowId != null) {
    await requireRoutingRuleStatusForWorkflow(db, scope.workflowId, nextFromStatus);
    await requireRoutingRuleStatusForWorkflow(db, scope.workflowId, nextToStatus);
    if (nextTaskType) await requireRoutingRuleTaskTypeForWorkflow(db, scope.workflowId, String(nextTaskType));
  } else {
    await requireRoutingRuleStatusForWorkflowType(db, scope.workflowType, nextFromStatus);
    await requireRoutingRuleStatusForWorkflowType(db, scope.workflowType, nextToStatus);
    if (nextTaskType) await requireRoutingRuleTaskTypeForWorkflowType(db, scope.workflowType, String(nextTaskType));
  }

  const updateTenant = await tenantPredicateFor(db, 'workflow_task_transitions', 'workflow_task_transitions', scope.tenantId);
  await db.run(`
    UPDATE workflow_task_transitions SET
      task_type = ?,
      from_status = ?,
      outcome = ?,
      to_status = ?,
      enabled = ?,
      priority = ?,
      is_protected = ?,
      updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = ?${updateTenant.sql}
  `, nextTaskType, nextFromStatus, outcome ?? existing.outcome, nextToStatus, enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled, priority !== undefined ? priority : existing.priority, is_protected !== undefined ? (is_protected ? 1 : 0) : existing.is_protected, id, ...updateTenant.params);

  return await readScopedRoutingTransition(db, { projectId: scope.projectId, workflowType: scope.workflowType, workflowId: scope.workflowId, tenantId: scope.tenantId, scopeLabel: scope.workflowName ?? scope.workflowType }, id);
}

export async function deleteRoutingTransition(db: Db, input: { id: unknown; project_id?: unknown; workflow_id?: unknown; workflow_type?: unknown; tenant_id?: unknown }) {
  const id = Number(input.id);
  if (!Number.isFinite(id)) throw withStatus('Valid transition id is required', 400);

  const scope = await requireScopedTransitionContext(db, input.project_id, input.workflow_id, input.workflow_type, input.tenant_id);
  const tenant = await tenantPredicateFor(db, 'workflow_task_transitions', 'stt', scope.tenantId);
  const existing = await tableHasTransitionScopeColumns(db)
    ? await db.get(`
        SELECT stt.id
        FROM workflow_task_transitions stt
        LEFT JOIN workflows s ON s.id = stt.workflow_id
        WHERE stt.id = ?
          AND COALESCE(stt.project_id, s.project_id) = ?
          AND COALESCE(stt.workflow_type, s.workflow_type) = ?
          AND ((stt.workflow_id IS NULL AND ?::text IS NULL) OR stt.workflow_id = ?)
          ${tenant.sql}
      `, id, scope.projectId, scope.workflowType, scope.workflowId, scope.workflowId, ...tenant.params)
    : await db.get('SELECT id FROM workflow_task_transitions WHERE id = ? AND workflow_id = ?', id, scope.workflowId);
  if (!existing) throw withStatus('Routing transition not found', 404);
  const deleteTenant = await tenantPredicateFor(db, 'workflow_task_transitions', 'workflow_task_transitions', scope.tenantId);
  await db.run(`DELETE FROM workflow_task_transitions WHERE id = ?${deleteTenant.sql}`, id, ...deleteTenant.params);
  return { ok: true };
}

export async function resolveLifecycleRule(db: Db, input: { project_id?: unknown; workflow_id?: unknown; task_type?: unknown; from_status?: unknown; outcome?: unknown; tenant_id?: unknown }) {
  const { workflowId, workflowName, projectId } = await requireScopedTransitionContext(db, input.project_id, input.workflow_id, undefined, input.tenant_id);
  const { task_type, from_status, outcome } = input;

  if (!from_status || !outcome || workflowId == null) {
    throw withStatus('project_id, workflow_id, from_status, and outcome are required', 400);
  }

  const rule = (await listWorkflowTaskTransitions(db, workflowId))
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
      workflow_id: workflowId,
      workflow_name: workflowName,
      reason: `No transition for ${task_type ?? '*'}/${from_status}:${outcome}`,
    };
  }

  return {
    matched: true,
    rule: {
      ...rule,
      project_id: projectId,
      workflow_id: workflowId,
      workflow_name: workflowName,
    },
  };
}
