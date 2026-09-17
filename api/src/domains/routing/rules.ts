import { isValidTaskType } from '../../lib/taskTypes';
import {
  annotateRoutingRuleScope,
  detectDuplicateRoutingRule,
  normalizeRoutingRuleTaskType,
  normalizeOptionalEnabled,
  parseWorkflowId,
  readRoutingRuleScopeRows,
  requireProjectWorkflowTypeScope,
  requireWorkflow,
  resolveRoutingRuleTarget,
  selectScopedRoutingRuleRowSql,
  tableHasColumn,
  tableHasRoutingRuleScopeColumns,
  tenantInsertFragment,
  tenantPredicateFor,
  withStatus,
  RoutingRuleRecord,
  RoutingRuleRow,
} from './scope';
import {
  requireAgentInWorkflowProject,
  requireRoutingRuleStatusForWorkflow,
  requireRoutingRuleStatusForWorkflowType,
  requireRoutingRuleTaskTypeForWorkflow,
  requireRoutingRuleTaskTypeForWorkflowType,
} from './validation';
import { type Db } from "../../db/adapter/types";

export async function listRoutingRulesForWorkflow(db: Db, input: { workflow_id?: unknown; scope?: unknown; tenant_id?: unknown }) {
  const scope = await requireProjectWorkflowTypeScope(db, input as { project_id?: unknown; workflow_id?: unknown; workflow_type?: unknown; tenant_id?: unknown });
  return {
    rules: annotateRoutingRuleScope(await readRoutingRuleScopeRows(db, scope, { scopeKind: input.scope }), scope.workflowId, { scopeKind: input.scope }),
    scope: {
      project_id: scope.projectId,
      workflow_type: scope.workflowType,
      workflow_id: scope.workflowId,
    },
  };
}

export async function resolveRoutingRuleForWorkflow(
  db: Db,
  input: { workflow_id?: unknown; task_type?: unknown; status?: unknown; tenant_id?: unknown },
) {
  const workflowId = parseWorkflowId(input.workflow_id);
  const normalizedTaskType = normalizeRoutingRuleTaskType(input.task_type);
  if (normalizedTaskType !== undefined && normalizedTaskType !== null && typeof normalizedTaskType !== 'string') {
    throw withStatus('task_type must be a string or null, and status must be a string', 400);
  }
  const taskType: string | null = normalizedTaskType ?? null;
  const status = typeof input.status === 'string' ? input.status.trim() : input.status;

  if (!status || !workflowId) {
    throw withStatus('workflow_id and status are required', 400);
  }

  const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;
  const workflow = await requireWorkflow(db, workflowId, tenantId);
  const hasScopedColumns = await tableHasRoutingRuleScopeColumns(db);
  const enabledPredicate = await tableHasColumn(db, 'workflow_task_routing_rules', 'enabled') ? 'AND trr.enabled = 1' : '';
  const tenant = await tenantPredicateFor(db, 'workflow_task_routing_rules', 'trr', tenantId);
  const rules = hasScopedColumns
    ? await db.all(`
        ${await selectScopedRoutingRuleRowSql(db)}
        WHERE (trr.project_id = ? OR trr.project_id IS NULL)
          AND trr.workflow_type = ?
          AND (trr.workflow_id IS NULL OR trr.workflow_id = ?)
          AND (trr.task_type = ? OR trr.task_type IS NULL)
          AND trr.status = ?
          ${enabledPredicate}
          ${tenant.sql}
        ORDER BY CASE WHEN trr.workflow_id = ? THEN 0 ELSE 1 END,
                 CASE WHEN trr.project_id = ? THEN 0 ELSE 1 END,
                 CASE WHEN trr.task_type = ? THEN 0 ELSE 1 END,
                 trr.priority DESC, trr.id ASC
      `, workflow.project_id, workflow.workflow_type ?? null, workflowId, taskType ?? null, status, ...tenant.params, workflowId, workflow.project_id, taskType ?? null) as RoutingRuleRow[]
    : await db.all(`
        ${await selectScopedRoutingRuleRowSql(db)}
        WHERE trr.workflow_id = ? AND (trr.task_type = ? OR trr.task_type IS NULL) AND trr.status = ?
          ${enabledPredicate}
        ORDER BY CASE WHEN trr.task_type = ? THEN 0 ELSE 1 END, trr.priority DESC, trr.id ASC
      `, workflowId, taskType ?? null, status, taskType ?? null) as RoutingRuleRow[];
  if (rules.length === 0) {
    return { matched: false, rule: null, candidates: [], reason: `No rule for ${taskType ?? '*'}/${status} in workflow ${workflowId}` };
  }

  const candidates = annotateRoutingRuleScope(rules, workflowId);
  return { matched: true, rule: candidates[0], candidates };
}

export async function getRoutingRule(db: Db, input: { id: unknown; workflow_id?: unknown; tenant_id?: unknown }) {
  const id = Number(input.id);
  const workflowId = parseWorkflowId(input.workflow_id);

  if (!Number.isFinite(id) || id <= 0) {
    throw withStatus('Valid routing rule id is required', 400);
  }

  const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;
  const tenant = await tenantPredicateFor(db, 'workflow_task_routing_rules', 'trr', tenantId);
  let query = `${await selectScopedRoutingRuleRowSql(db)} WHERE trr.id = ?`;
  const params: Array<number> = [id];
  if (workflowId) {
    await requireWorkflow(db, workflowId, tenantId);
    query += ' AND COALESCE(trr.workflow_id, ?) = ?';
    params.push(workflowId, workflowId);
  }
  query += tenant.sql;

  const rule = await db.get(query, ...params, ...tenant.params) as RoutingRuleRow | undefined;
  if (!rule) {
    throw withStatus('Routing rule not found', 404);
  }

  return annotateRoutingRuleScope([rule], workflowId ?? null)[0];
}

export async function createRoutingRule(db: Db, input: Record<string, unknown>) {
  const scope = await requireProjectWorkflowTypeScope(db, input as { project_id?: unknown; workflow_id?: unknown; workflow_type?: unknown; tenant_id?: unknown });
  const workflowId = parseWorkflowId(input.workflow_id);
  const normalizedTaskType = normalizeRoutingRuleTaskType(input.task_type);
  const status = typeof (input.status ?? input.task_status) === 'string'
    ? String(input.status ?? input.task_status).trim()
    : (input.status ?? input.task_status);
  const jobId = input.job_id;
  const agentId = input.agent_id;
  const priority = input.priority ?? 0;
  const normalizedPriority = Number(priority);
  const enabled = normalizeOptionalEnabled(input.enabled, 1);
  const scopeKind = typeof input.scope_kind === 'string' ? input.scope_kind.trim() : null;
  if (scopeKind === 'workflow_override' && workflowId == null) {
    throw withStatus('workflow_id is required for workflow-specific routing rules', 400);
  }
  const isWorkflowTypeDefault = scopeKind === 'workflow_type_default' || workflowId == null;

  if (!status || (jobId == null && agentId == null)) {
    throw withStatus('status, project_id, workflow_type, and either job_id or agent_id are required', 400);
  }
  if ((normalizedTaskType !== null && normalizedTaskType !== undefined && typeof normalizedTaskType !== 'string') || typeof status !== 'string') {
    throw withStatus('task_type must be a string or null, and status must be a string', 400);
  }
  if (!Number.isFinite(normalizedPriority)) {
    throw withStatus('priority must be a number', 400);
  }

  if (typeof normalizedTaskType === 'string' && !isValidTaskType(normalizedTaskType)) {
    throw withStatus(`Invalid task_type "${normalizedTaskType}". Task type keys must use lowercase letters, numbers, underscores, or hyphens.`, 400);
  }

  const taskType: string | null = normalizedTaskType ?? null;

  const target = await resolveRoutingRuleTarget(db, { job_id: jobId, agent_id: agentId, tenant_id: input.tenant_id });
  if (isWorkflowTypeDefault) {
    if (typeof taskType === 'string') await requireRoutingRuleTaskTypeForWorkflowType(db, scope.workflowType, taskType);
    await requireRoutingRuleStatusForWorkflowType(db, scope.workflowType, status);
  } else {
    const validationWorkflowId = scope.workflowId;
    if (!validationWorkflowId) {
      throw withStatus('workflow_id is required for workflow-specific routing rules', 400);
    }
    if (typeof taskType === 'string') await requireRoutingRuleTaskTypeForWorkflow(db, validationWorkflowId, taskType);
    await requireRoutingRuleStatusForWorkflow(db, validationWorkflowId, status);
  }
  if (scope.workflowId) {
    const workflow = await requireWorkflow(db, scope.workflowId, scope.tenantId);
    await requireAgentInWorkflowProject(db, workflow, target.agent_id, scope.tenantId);
  }

  const hasScopedColumns = await tableHasRoutingRuleScopeColumns(db);
  if (!hasScopedColumns && isWorkflowTypeDefault) {
    throw withStatus('Workflow-type default routing rules require the scoped routing-rule schema migration', 400);
  }
  const persistedWorkflowId = hasScopedColumns
    ? (isWorkflowTypeDefault ? null : scope.workflowId)
    : scope.workflowId;
  const duplicate = await detectDuplicateRoutingRule(db, {
      projectId: scope.projectId,
      workflowType: scope.workflowType,
      workflowId: persistedWorkflowId ?? null,
      taskType,
      status,
      agentId: target.agent_id,
      priority: normalizedPriority,
      tenantId: scope.tenantId,
    });
  if (duplicate) {
    throw withStatus(`Routing rule already exists for ${scope.workflowType} ${persistedWorkflowId == null ? 'default' : `workflow ${persistedWorkflowId}`} scope ${taskType ?? '*'}/${status} agent ${target.agent_id} priority ${normalizedPriority}`, 409);
  }
  const tenant = await tenantInsertFragment(db, 'workflow_task_routing_rules', scope.tenantId);
  const result = hasScopedColumns
    ? await db.run(`
        INSERT INTO workflow_task_routing_rules (${tenant.columns}project_id, workflow_type, workflow_id, task_type, status, agent_id, priority, enabled, is_system)
        VALUES (${tenant.placeholders}?, ?, ?, ?, ?, ?, ?, ?, 0)
      `, ...tenant.params, scope.projectId, scope.workflowType, persistedWorkflowId, taskType, status, target.agent_id, normalizedPriority, enabled)
    : await db.run(`
        INSERT INTO workflow_task_routing_rules (${tenant.columns}workflow_id, task_type, status, agent_id, priority, enabled, is_system)
        VALUES (${tenant.placeholders}?, ?, ?, ?, ?, ?, 0)
      `, ...tenant.params, scope.workflowId, taskType, status, target.agent_id, normalizedPriority, enabled);

  const readTenant = await tenantPredicateFor(db, 'workflow_task_routing_rules', 'trr', scope.tenantId);
  const created = await db.get(`${await selectScopedRoutingRuleRowSql(db)} WHERE trr.id = ?${readTenant.sql}`, result.lastInsertId, ...readTenant.params) as RoutingRuleRow;
  return annotateRoutingRuleScope([created], scope.workflowId)[0];
}

export async function updateRoutingRule(db: Db, input: Record<string, unknown> & { id: unknown }) {
  const id = Number(input.id);
  const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;
  const initialTenant = await tenantPredicateFor(db, 'workflow_task_routing_rules', 'workflow_task_routing_rules', tenantId);
  const existing = await db.get(`SELECT * FROM workflow_task_routing_rules WHERE id = ?${initialTenant.sql}`, id, ...initialTenant.params) as RoutingRuleRecord | undefined;
  if (!existing) throw withStatus('Routing rule not found', 404);

  const scope = await requireProjectWorkflowTypeScope(db, {
      project_id: input.project_id ?? existing.project_id,
      workflow_id: input.workflow_id ?? input.workflowId ?? existing.workflow_id,
      workflow_type: input.workflow_type ?? existing.workflow_type,
      tenant_id: tenantId,
    });
  const requestedScopeKind = typeof input.scope_kind === 'string' ? input.scope_kind.trim() : null;
  const isWorkflowTypeDefault = requestedScopeKind === 'workflow_type_default' || scope.workflowId == null;
  if (requestedScopeKind === 'workflow_override' && scope.workflowId == null) {
    throw withStatus('workflow_id is required for workflow-specific routing rules', 400);
  }

  const { status, job_id, agent_id, priority } = input;
  const nextEnabled = normalizeOptionalEnabled(input.enabled, Number(existing.enabled ?? 1));
  const normalizedTaskType = normalizeRoutingRuleTaskType(input.task_type);
  if (normalizedTaskType !== undefined && normalizedTaskType !== null && typeof normalizedTaskType !== 'string') {
    throw withStatus('task_type must be a string or null', 400);
  }
  if (typeof normalizedTaskType === 'string' && !isValidTaskType(normalizedTaskType)) {
    throw withStatus(`Invalid task_type "${normalizedTaskType}". Task type keys must use lowercase letters, numbers, underscores, or hyphens.`, 400);
  }
  const existingTaskType = typeof existing.task_type === 'string' ? existing.task_type.trim() : null;
  const nextTaskType: string | null = normalizedTaskType === undefined ? existingTaskType : (normalizedTaskType ?? null);
  const target = (job_id !== undefined || agent_id !== undefined)
    ? await resolveRoutingRuleTarget(db, { job_id: job_id ?? null, agent_id: agent_id ?? existing.agent_id, tenant_id: tenantId })
    : { agent_id: Number(existing.agent_id) };
  const nextPriority = priority === undefined ? Number(existing.priority ?? 0) : Number(priority);
  if (!Number.isFinite(nextPriority)) {
    throw withStatus('priority must be a number', 400);
  }
  const nextStatus = typeof status === 'string' ? status.trim() : String(existing.status ?? '').trim();
  if (!nextStatus) {
    throw withStatus('status is required', 400);
  }
  if (isWorkflowTypeDefault) {
    if (typeof nextTaskType === 'string') await requireRoutingRuleTaskTypeForWorkflowType(db, scope.workflowType, nextTaskType);
    await requireRoutingRuleStatusForWorkflowType(db, scope.workflowType, nextStatus);
  } else {
    const validationWorkflowId = scope.workflowId;
    if (!validationWorkflowId) {
      throw withStatus('workflow_id is required for workflow-specific routing rules', 400);
    }
    if (typeof nextTaskType === 'string') await requireRoutingRuleTaskTypeForWorkflow(db, validationWorkflowId, nextTaskType);
    await requireRoutingRuleStatusForWorkflow(db, validationWorkflowId, nextStatus);
  }
  if (scope.workflowId) {
    const workflow = await requireWorkflow(db, scope.workflowId, scope.tenantId);
    await requireAgentInWorkflowProject(db, workflow, target.agent_id, scope.tenantId);
  }

  if (await tableHasRoutingRuleScopeColumns(db)) {
    const nextWorkflowId = (requestedScopeKind === 'workflow_type_default' || scope.workflowId == null) ? null : scope.workflowId;
    const duplicate = await detectDuplicateRoutingRule(db, {
          projectId: scope.projectId,
          workflowType: scope.workflowType,
          workflowId: nextWorkflowId,
          taskType: nextTaskType,
          status: nextStatus,
          agentId: target.agent_id,
          priority: nextPriority,
          tenantId: scope.tenantId,
          excludeId: id,
        });
    if (duplicate) {
      throw withStatus(`Routing rule already exists for ${scope.workflowType} ${nextWorkflowId == null ? 'default' : `workflow ${nextWorkflowId}`} scope ${nextTaskType ?? '*'}${'/' + nextStatus} agent ${target.agent_id} priority ${nextPriority}`, 409);
    }
    await db.run(`
      UPDATE workflow_task_routing_rules
      SET project_id = ?, workflow_type = ?, workflow_id = ?, task_type = ?, status = ?, agent_id = ?, priority = ?, enabled = ?, is_system = 0, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = ?${initialTenant.sql}
    `, scope.projectId, scope.workflowType, nextWorkflowId, nextTaskType, nextStatus, target.agent_id, nextPriority, nextEnabled, id, ...initialTenant.params);
  } else {
    if (!scope.workflowId) throw withStatus('workflow_id is required', 400);
    const duplicate = await detectDuplicateRoutingRule(db, {
          projectId: scope.projectId,
          workflowType: scope.workflowType,
          workflowId: scope.workflowId,
          taskType: nextTaskType,
          status: nextStatus,
          agentId: target.agent_id,
          priority: nextPriority,
          tenantId: scope.tenantId,
          excludeId: id,
        });
    if (duplicate) {
      throw withStatus(`Routing rule already exists for workflow ${scope.workflowId} scope ${nextTaskType ?? '*'}${'/' + nextStatus} agent ${target.agent_id} priority ${nextPriority}`, 409);
    }
    await db.run(`
      UPDATE workflow_task_routing_rules
      SET workflow_id = ?, task_type = ?, status = ?, agent_id = ?, priority = ?, enabled = ?, is_system = 0, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = ?${initialTenant.sql}
    `, scope.workflowId, nextTaskType, nextStatus, target.agent_id, nextPriority, nextEnabled, id, ...initialTenant.params);
  }

  const readTenant = await tenantPredicateFor(db, 'workflow_task_routing_rules', 'trr', scope.tenantId);
  const updated = await db.get(`${await selectScopedRoutingRuleRowSql(db)} WHERE trr.id = ?${readTenant.sql}`, id, ...readTenant.params) as RoutingRuleRow;
  return annotateRoutingRuleScope([updated], scope.workflowId)[0];
}

export async function deleteRoutingRule(db: Db, input: Record<string, unknown> & { id: unknown }) {
  const id = Number(input.id);
  const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;
  const tenant = await tenantPredicateFor(db, 'workflow_task_routing_rules', 'workflow_task_routing_rules', tenantId);
  const existing = await db.get(`SELECT * FROM workflow_task_routing_rules WHERE id = ?${tenant.sql}`, id, ...tenant.params) as RoutingRuleRecord | undefined;
  if (!existing) throw withStatus('Routing rule not found', 404);

  // Scope guard. Previously this parsed workflowId, called requireWorkflow for its side
  // effect, then DELETEd on `id` alone — so any rule in the tenant could be removed
  // regardless of which project or workflow the caller was addressing, and deleting a
  // workflow-type default while viewing one workflow silently removed it from every
  // workflow of that type. Mirrors the guard deleteRoutingTransition already applies.
  const requestedProjectId = Number.isFinite(Number(input.project_id)) ? Number(input.project_id) : null;
  const requestedWorkflowType = typeof input.workflow_type === 'string' && input.workflow_type.trim().length > 0
    ? input.workflow_type.trim()
    : null;
  const requestedWorkflowId = parseWorkflowId(input.workflow_id);
  if (requestedProjectId != null && existing.project_id != null && Number(existing.project_id) !== requestedProjectId) {
    throw withStatus('Routing rule not found', 404);
  }
  if (requestedWorkflowType != null && existing.workflow_type != null && String(existing.workflow_type) !== requestedWorkflowType) {
    throw withStatus('Routing rule not found', 404);
  }
  // A caller addressing a specific workflow must not delete the shared default: the
  // row's own workflow_id has to match what was asked for, NULL included.
  if (input.workflow_id !== undefined) {
    const existingWorkflowId = existing.workflow_id == null ? null : Number(existing.workflow_id);
    if (existingWorkflowId !== requestedWorkflowId) {
      throw withStatus('Routing rule not found', 404);
    }
  }

  const workflowId = parseWorkflowId(input.workflow_id ?? existing.workflow_id);
  if (workflowId) await requireWorkflow(db, workflowId, tenantId);
  await db.run(`DELETE FROM workflow_task_routing_rules WHERE id = ?${tenant.sql}`, id, ...tenant.params);
  return {
    ok: true,
    deleted: true,
    rule_id: id,
    workflow_id: workflowId ?? null,
    scope_kind: existing.workflow_id == null ? 'workflow_type_default' : 'workflow_override',
  };
}
