import { isValidTaskType } from '../../lib/taskTypes';
import { seedSprintTaskPolicy } from './policy/seed';
import {
  annotateRoutingRuleScope,
  detectDuplicateRoutingRule,
  normalizeRoutingRuleTaskType,
  normalizeOptionalEnabled,
  parseSprintId,
  readRoutingRuleScopeRows,
  requireProjectSprintTypeScope,
  requireSprint,
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
  requireAgentInSprintProject,
  requireRoutingRuleStatusForSprint,
  requireRoutingRuleStatusForSprintType,
  requireRoutingRuleTaskTypeForSprint,
  requireRoutingRuleTaskTypeForSprintType,
} from './validation';
import { type Db } from "../../db/adapter/types";

export async function listRoutingRulesForSprint(db: Db, input: { sprint_id?: unknown; scope?: unknown; tenant_id?: unknown }) {
  const scope = await requireProjectSprintTypeScope(db, input as { project_id?: unknown; sprint_id?: unknown; sprint_type?: unknown; tenant_id?: unknown });
  return {
    rules: annotateRoutingRuleScope(await readRoutingRuleScopeRows(db, scope, { scopeKind: input.scope }), scope.sprintId, { scopeKind: input.scope }),
    scope: {
      project_id: scope.projectId,
      sprint_type: scope.sprintType,
      sprint_id: scope.sprintId,
    },
  };
}

export async function resolveRoutingRuleForSprint(
  db: Db,
  input: { sprint_id?: unknown; task_type?: unknown; status?: unknown; tenant_id?: unknown },
) {
  const sprintId = parseSprintId(input.sprint_id);
  const normalizedTaskType = normalizeRoutingRuleTaskType(input.task_type);
  if (normalizedTaskType !== undefined && normalizedTaskType !== null && typeof normalizedTaskType !== 'string') {
    throw withStatus('task_type must be a string or null, and status must be a string', 400);
  }
  const taskType: string | null = normalizedTaskType ?? null;
  const status = typeof input.status === 'string' ? input.status.trim() : input.status;

  if (!status || !sprintId) {
    throw withStatus('sprint_id and status are required', 400);
  }

  const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;
  const sprint = await requireSprint(db, sprintId, tenantId);
  const hasScopedColumns = await tableHasRoutingRuleScopeColumns(db);
  const enabledPredicate = await tableHasColumn(db, 'sprint_task_routing_rules', 'enabled') ? 'AND trr.enabled = 1' : '';
  const tenant = await tenantPredicateFor(db, 'sprint_task_routing_rules', 'trr', tenantId);
  const rules = hasScopedColumns
    ? await db.all(`
        ${await selectScopedRoutingRuleRowSql(db)}
        WHERE (trr.project_id = ? OR trr.project_id IS NULL)
          AND trr.sprint_type = ?
          AND (trr.sprint_id IS NULL OR trr.sprint_id = ?)
          AND (trr.task_type = ? OR trr.task_type IS NULL)
          AND trr.status = ?
          ${enabledPredicate}
          ${tenant.sql}
        ORDER BY CASE WHEN trr.sprint_id = ? THEN 0 ELSE 1 END,
                 CASE WHEN trr.project_id = ? THEN 0 ELSE 1 END,
                 CASE WHEN trr.task_type = ? THEN 0 ELSE 1 END,
                 trr.priority DESC, trr.id ASC
      `, sprint.project_id, sprint.sprint_type ?? null, sprintId, taskType ?? null, status, ...tenant.params, sprintId, sprint.project_id, taskType ?? null) as RoutingRuleRow[]
    : await db.all(`
        ${await selectScopedRoutingRuleRowSql(db)}
        WHERE trr.sprint_id = ? AND (trr.task_type = ? OR trr.task_type IS NULL) AND trr.status = ?
          ${enabledPredicate}
        ORDER BY CASE WHEN trr.task_type = ? THEN 0 ELSE 1 END, trr.priority DESC, trr.id ASC
      `, sprintId, taskType ?? null, status, taskType ?? null) as RoutingRuleRow[];
  if (rules.length === 0) {
    return { matched: false, rule: null, candidates: [], reason: `No rule for ${taskType ?? '*'}/${status} in sprint ${sprintId}` };
  }

  const candidates = annotateRoutingRuleScope(rules, sprintId);
  return { matched: true, rule: candidates[0], candidates };
}

export async function getRoutingRule(db: Db, input: { id: unknown; sprint_id?: unknown; tenant_id?: unknown }) {
  const id = Number(input.id);
  const sprintId = parseSprintId(input.sprint_id);

  if (!Number.isFinite(id) || id <= 0) {
    throw withStatus('Valid routing rule id is required', 400);
  }

  const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;
  const tenant = await tenantPredicateFor(db, 'sprint_task_routing_rules', 'trr', tenantId);
  let query = `${await selectScopedRoutingRuleRowSql(db)} WHERE trr.id = ?`;
  const params: Array<number> = [id];
  if (sprintId) {
    await requireSprint(db, sprintId, tenantId);
    query += ' AND COALESCE(trr.sprint_id, ?) = ?';
    params.push(sprintId, sprintId);
  }
  query += tenant.sql;

  const rule = db.prepare(query).get(...params, ...tenant.params) as RoutingRuleRow | undefined;
  if (!rule) {
    throw withStatus('Routing rule not found', 404);
  }

  return annotateRoutingRuleScope([rule], sprintId ?? null)[0];
}

export async function createRoutingRule(db: Db, input: Record<string, unknown>) {
  const scope = await requireProjectSprintTypeScope(db, input as { project_id?: unknown; sprint_id?: unknown; sprint_type?: unknown; tenant_id?: unknown });
  const sprintId = parseSprintId(input.sprint_id);
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
  if (scopeKind === 'sprint_override' && sprintId == null) {
    throw withStatus('sprint_id is required for sprint-specific routing rules', 400);
  }
  const isSprintTypeDefault = scopeKind === 'sprint_type_default' || sprintId == null;

  if (!status || (jobId == null && agentId == null)) {
    throw withStatus('status, project_id, sprint_type, and either job_id or agent_id are required', 400);
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
  if (isSprintTypeDefault) {
    if (typeof taskType === 'string') await requireRoutingRuleTaskTypeForSprintType(db, scope.sprintType, taskType);
    await requireRoutingRuleStatusForSprintType(db, scope.sprintType, status);
  } else {
    const validationSprintId = scope.sprintId;
    if (!validationSprintId) {
      throw withStatus('sprint_id is required for sprint-specific routing rules', 400);
    }
    await seedSprintTaskPolicy(db, validationSprintId);
    if (typeof taskType === 'string') await requireRoutingRuleTaskTypeForSprint(db, validationSprintId, taskType);
    await requireRoutingRuleStatusForSprint(db, validationSprintId, status);
  }
  if (scope.sprintId) {
    const sprint = await requireSprint(db, scope.sprintId, scope.tenantId);
    await requireAgentInSprintProject(db, sprint, target.agent_id, scope.tenantId);
  }

  const hasScopedColumns = await tableHasRoutingRuleScopeColumns(db);
  if (!hasScopedColumns && isSprintTypeDefault) {
    throw withStatus('Sprint-type default routing rules require the scoped routing-rule schema migration', 400);
  }
  const persistedSprintId = hasScopedColumns
    ? (isSprintTypeDefault ? null : scope.sprintId)
    : scope.sprintId;
  const duplicate = await detectDuplicateRoutingRule(db, {
      projectId: scope.projectId,
      sprintType: scope.sprintType,
      sprintId: persistedSprintId ?? null,
      taskType,
      status,
      agentId: target.agent_id,
      priority: normalizedPriority,
      tenantId: scope.tenantId,
    });
  if (duplicate) {
    throw withStatus(`Routing rule already exists for ${scope.sprintType} ${persistedSprintId == null ? 'default' : `sprint ${persistedSprintId}`} scope ${taskType ?? '*'}/${status} agent ${target.agent_id} priority ${normalizedPriority}`, 409);
  }
  const tenant = await tenantInsertFragment(db, 'sprint_task_routing_rules', scope.tenantId);
  const result = hasScopedColumns
    ? await db.run(`
        INSERT INTO sprint_task_routing_rules (${tenant.columns}project_id, sprint_type, sprint_id, task_type, status, agent_id, priority, enabled, is_system)
        VALUES (${tenant.placeholders}?, ?, ?, ?, ?, ?, ?, ?, 0)
      `, ...tenant.params, scope.projectId, scope.sprintType, persistedSprintId, taskType, status, target.agent_id, normalizedPriority, enabled)
    : await db.run(`
        INSERT INTO sprint_task_routing_rules (${tenant.columns}sprint_id, task_type, status, agent_id, priority, enabled, is_system)
        VALUES (${tenant.placeholders}?, ?, ?, ?, ?, ?, 0)
      `, ...tenant.params, scope.sprintId, taskType, status, target.agent_id, normalizedPriority, enabled);

  const readTenant = await tenantPredicateFor(db, 'sprint_task_routing_rules', 'trr', scope.tenantId);
  const created = await db.get(`${await selectScopedRoutingRuleRowSql(db)} WHERE trr.id = ?${readTenant.sql}`, result.lastInsertRowid, ...readTenant.params) as RoutingRuleRow;
  return annotateRoutingRuleScope([created], scope.sprintId)[0];
}

export async function updateRoutingRule(db: Db, input: Record<string, unknown> & { id: unknown }) {
  const id = Number(input.id);
  const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;
  const initialTenant = await tenantPredicateFor(db, 'sprint_task_routing_rules', 'sprint_task_routing_rules', tenantId);
  const existing = await db.get(`SELECT * FROM sprint_task_routing_rules WHERE id = ?${initialTenant.sql}`, id, ...initialTenant.params) as RoutingRuleRecord | undefined;
  if (!existing) throw withStatus('Routing rule not found', 404);

  const scope = await requireProjectSprintTypeScope(db, {
      project_id: input.project_id ?? existing.project_id,
      sprint_id: input.sprint_id ?? input.sprintId ?? existing.sprint_id,
      sprint_type: input.sprint_type ?? existing.sprint_type,
      tenant_id: tenantId,
    });
  const requestedScopeKind = typeof input.scope_kind === 'string' ? input.scope_kind.trim() : null;
  const isSprintTypeDefault = requestedScopeKind === 'sprint_type_default' || scope.sprintId == null;
  if (requestedScopeKind === 'sprint_override' && scope.sprintId == null) {
    throw withStatus('sprint_id is required for sprint-specific routing rules', 400);
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
  if (isSprintTypeDefault) {
    if (typeof nextTaskType === 'string') await requireRoutingRuleTaskTypeForSprintType(db, scope.sprintType, nextTaskType);
    await requireRoutingRuleStatusForSprintType(db, scope.sprintType, nextStatus);
  } else {
    const validationSprintId = scope.sprintId;
    if (!validationSprintId) {
      throw withStatus('sprint_id is required for sprint-specific routing rules', 400);
    }
    await seedSprintTaskPolicy(db, validationSprintId);
    if (typeof nextTaskType === 'string') await requireRoutingRuleTaskTypeForSprint(db, validationSprintId, nextTaskType);
    await requireRoutingRuleStatusForSprint(db, validationSprintId, nextStatus);
  }
  if (scope.sprintId) {
    const sprint = await requireSprint(db, scope.sprintId, scope.tenantId);
    await requireAgentInSprintProject(db, sprint, target.agent_id, scope.tenantId);
  }

  if (await tableHasRoutingRuleScopeColumns(db)) {
    const nextSprintId = (requestedScopeKind === 'sprint_type_default' || scope.sprintId == null) ? null : scope.sprintId;
    const duplicate = await detectDuplicateRoutingRule(db, {
          projectId: scope.projectId,
          sprintType: scope.sprintType,
          sprintId: nextSprintId,
          taskType: nextTaskType,
          status: nextStatus,
          agentId: target.agent_id,
          priority: nextPriority,
          tenantId: scope.tenantId,
          excludeId: id,
        });
    if (duplicate) {
      throw withStatus(`Routing rule already exists for ${scope.sprintType} ${nextSprintId == null ? 'default' : `sprint ${nextSprintId}`} scope ${nextTaskType ?? '*'}${'/' + nextStatus} agent ${target.agent_id} priority ${nextPriority}`, 409);
    }
    await db.run(`
      UPDATE sprint_task_routing_rules
      SET project_id = ?, sprint_type = ?, sprint_id = ?, task_type = ?, status = ?, agent_id = ?, priority = ?, enabled = ?, is_system = 0, updated_at = datetime('now')
      WHERE id = ?${initialTenant.sql}
    `, scope.projectId, scope.sprintType, nextSprintId, nextTaskType, nextStatus, target.agent_id, nextPriority, nextEnabled, id, ...initialTenant.params);
  } else {
    if (!scope.sprintId) throw withStatus('sprint_id is required', 400);
    const duplicate = await detectDuplicateRoutingRule(db, {
          projectId: scope.projectId,
          sprintType: scope.sprintType,
          sprintId: scope.sprintId,
          taskType: nextTaskType,
          status: nextStatus,
          agentId: target.agent_id,
          priority: nextPriority,
          tenantId: scope.tenantId,
          excludeId: id,
        });
    if (duplicate) {
      throw withStatus(`Routing rule already exists for sprint ${scope.sprintId} scope ${nextTaskType ?? '*'}${'/' + nextStatus} agent ${target.agent_id} priority ${nextPriority}`, 409);
    }
    await db.run(`
      UPDATE sprint_task_routing_rules
      SET sprint_id = ?, task_type = ?, status = ?, agent_id = ?, priority = ?, enabled = ?, is_system = 0, updated_at = datetime('now')
      WHERE id = ?${initialTenant.sql}
    `, scope.sprintId, nextTaskType, nextStatus, target.agent_id, nextPriority, nextEnabled, id, ...initialTenant.params);
  }

  const readTenant = await tenantPredicateFor(db, 'sprint_task_routing_rules', 'trr', scope.tenantId);
  const updated = await db.get(`${await selectScopedRoutingRuleRowSql(db)} WHERE trr.id = ?${readTenant.sql}`, id, ...readTenant.params) as RoutingRuleRow;
  return annotateRoutingRuleScope([updated], scope.sprintId)[0];
}

export async function deleteRoutingRule(db: Db, input: Record<string, unknown> & { id: unknown }) {
  const id = Number(input.id);
  const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;
  const tenant = await tenantPredicateFor(db, 'sprint_task_routing_rules', 'sprint_task_routing_rules', tenantId);
  const existing = await db.get(`SELECT * FROM sprint_task_routing_rules WHERE id = ?${tenant.sql}`, id, ...tenant.params) as RoutingRuleRecord | undefined;
  if (!existing) throw withStatus('Routing rule not found', 404);

  const sprintId = parseSprintId(input.sprint_id ?? existing.sprint_id);
  if (sprintId) await requireSprint(db, sprintId, tenantId);
  await db.run(`DELETE FROM sprint_task_routing_rules WHERE id = ?${tenant.sql}`, id, ...tenant.params);
  return {
    ok: true,
    deleted: true,
    rule_id: id,
    sprint_id: sprintId ?? null,
    scope_kind: existing.sprint_id == null ? 'sprint_type_default' : 'sprint_override',
  };
}
