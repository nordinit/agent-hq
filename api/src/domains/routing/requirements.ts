import { isValidTaskType } from '../../lib/taskTypes';
import { getGateRequirementFieldDefinitions, resolveTaskFieldSchemaForWorkflow } from '../workflow-definitions/config';
import { rememberDeletedWorkflowTaskTransitionRequirement } from './policy/seed';
import {
  annotateRequirementScope,
  normalizeWorkflowTypeKey,
  parseWorkflowId,
  requireWorkflow,
  requireTransitionRequirementScope,
  selectRequirementScopeRows,
  tableHasRequirementScopeColumns,
  tenantInsertFragment,
  tenantPredicateFor,
  withStatus,
  TransitionRequirementRecord,
} from './scope';
import { requireTransitionRequirementFieldsForScope, requireTransitionRequirementFieldsForWorkflow } from './validation';
import { type Db } from "../../db/adapter/types";

export async function listTransitionRequirementFields(
  db: Db,
  input: { workflow_id?: unknown; workflow_type?: unknown; task_type?: unknown; tenant_id?: unknown },
) {
  const workflowId = parseWorkflowId(input.workflow_id);
  if (!workflowId && !normalizeWorkflowTypeKey(input.workflow_type)) {
    throw withStatus('workflow_id or workflow_type is required', 400);
  }
  const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;
  if (workflowId) await requireWorkflow(db, workflowId, tenantId);
  const resolved = await resolveTaskFieldSchemaForWorkflow(db, {
      workflowId,
      workflowType: input.workflow_type,
      taskType: input.task_type,
    });
  const fields = getGateRequirementFieldDefinitions(resolved.schema.fields);
  return {
    workflow_type: resolved.workflow_type,
    task_type: typeof input.task_type === 'string' && input.task_type.trim() ? input.task_type.trim() : null,
    fields,
    field_names: fields.map(field => field.key),
  };
}

export async function listTransitionRequirements(
  db: Db,
  input: { project_id?: unknown; workflow_id?: unknown; workflow_type?: unknown; task_type?: unknown; outcome?: unknown; tenant_id?: unknown },
) {
  const taskType = input.task_type;
  const outcomeFilter = input.outcome;

  if (input.project_id != null || input.workflow_id != null || input.workflow_type != null) {
    const scope = await requireTransitionRequirementScope(db, input);
    let rows = annotateRequirementScope(await selectRequirementScopeRows(db, scope), scope.workflowId);
    if (taskType) {
      rows = rows.filter((row) => row.task_type == null || row.task_type === String(taskType));
    }
    if (outcomeFilter) {
      rows = rows.filter((row) => row.outcome === String(outcomeFilter));
    }
    return {
      transition_requirements: rows,
      scope: {
        project_id: scope.projectId,
        workflow_type: scope.workflowType,
        workflow_id: scope.workflowId,
      },
    };
  }

  requireRequirementScope(input, 'list');
}

/**
 * Refuse a requirement request that names no scope.
 *
 * Every gate requirement belongs to a workflow type or a single workflow; there is no
 * scope-less place to put one, and no scope-less set to read. There used to be: a global
 * `transition_requirements` table with no project and no tenant, consulted as the fallback for
 * EVERY workflow in every project, which an omitted scope silently addressed. Migration 15
 * moved its rows to the dev workflow default and dropped it.
 *
 * The guard outlives the table. An unscoped request is a caller that has lost track of which
 * workflow it is configuring, and the ids it is passing came from somewhere — most likely a
 * scoped row, whose id means something different here.
 */
function requireRequirementScope(
  input: { workflow_id?: unknown; project_id?: unknown; workflow_type?: unknown },
  action: 'create' | 'update' | 'delete' | 'list',
): never {
  throw withStatus(
    `Refusing to ${action} transition requirements with no scope. `
    + 'Send project_id and workflow_type for a workflow-type default, or workflow_id for a workflow override.',
    400,
  );
}

export async function createTransitionRequirement(db: Db, input: Record<string, unknown>) {
  const workflowId = parseWorkflowId(input.workflow_id);
  const hasDefaultScope = input.project_id != null || input.workflow_type != null;
  const {
    task_type, outcome, field_name, requirement_type = 'required',
    match_field, severity = 'block', message = '', enabled = 1, priority = 0,
  } = input;

  if (!outcome || !field_name) {
    throw withStatus('outcome and field_name are required', 400);
  }

  if (task_type && !isValidTaskType(task_type)) {
    throw withStatus(`Invalid task_type "${task_type}". Task type keys must use lowercase letters, numbers, underscores, or hyphens.`, 400);
  }

  if (!['required', 'match', 'from_status'].includes(String(requirement_type))) {
    throw withStatus('requirement_type must be required, match, or from_status', 400);
  }

  if (!['block', 'warn'].includes(String(severity))) {
    throw withStatus('severity must be block or warn', 400);
  }

  if (workflowId || hasDefaultScope) {
    if (!await tableHasRequirementScopeColumns(db)) {
      if (!workflowId) throw withStatus('workflow_id is required', 400);
      const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;
      await requireWorkflow(db, workflowId, tenantId);
      await requireTransitionRequirementFieldsForWorkflow(db, workflowId, task_type ?? null, field_name, match_field ?? null, requirement_type);
      const tenant = await tenantInsertFragment(db, 'workflow_task_transition_requirements', tenantId);
      const result = await db.run(`
        INSERT INTO workflow_task_transition_requirements (${tenant.columns}workflow_id, task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority, created_at, updated_at)
        VALUES (${tenant.placeholders}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
      `, ...tenant.params, workflowId, task_type ?? null, outcome, field_name, requirement_type, match_field ?? null, severity, message, enabled ? 1 : 0, priority);
      const readTenant = await tenantPredicateFor(db, 'workflow_task_transition_requirements', 'workflow_task_transition_requirements', tenantId);
      return await db.get(`SELECT * FROM workflow_task_transition_requirements WHERE id = ? AND workflow_id = ?${readTenant.sql}`, result.lastInsertId, workflowId, ...readTenant.params);
    }

    const scope = await requireTransitionRequirementScope(db, input);
    await requireTransitionRequirementFieldsForScope(db, { workflowId: scope.workflowId, workflowType: scope.workflowType }, task_type ?? null, field_name, match_field ?? null, requirement_type);
    const tenant = await tenantInsertFragment(db, 'workflow_task_transition_requirements', scope.tenantId);
    const result = await db.run(`
      INSERT INTO workflow_task_transition_requirements (${tenant.columns}workflow_id, project_id, workflow_type, task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority, created_at, updated_at)
      VALUES (${tenant.placeholders}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
    `, ...tenant.params, scope.workflowId, scope.projectId, scope.workflowType, task_type ?? null, outcome, field_name, requirement_type, match_field ?? null, severity, message, enabled ? 1 : 0, priority);
    const readTenant = await tenantPredicateFor(db, 'workflow_task_transition_requirements', 'workflow_task_transition_requirements', scope.tenantId);
    return await db.get(`SELECT * FROM workflow_task_transition_requirements WHERE id = ?${readTenant.sql}`, result.lastInsertId, ...readTenant.params);
  }

  requireRequirementScope(input, 'create');
}

export async function updateTransitionRequirement(db: Db, input: Record<string, unknown> & { id: unknown; workflow_id?: unknown; project_id?: unknown; workflow_type?: unknown; tenant_id?: unknown }) {
  const id = Number(input.id);
  const workflowId = parseWorkflowId(input.workflow_id);
  const hasScopedInput = input.project_id != null || input.workflow_type != null;
  if (workflowId || hasScopedInput) {
    if (!await tableHasRequirementScopeColumns(db)) {
      if (!workflowId) throw withStatus('workflow_id is required', 400);
      const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;
      await requireWorkflow(db, workflowId, tenantId);
      const tenant = await tenantPredicateFor(db, 'workflow_task_transition_requirements', 'workflow_task_transition_requirements', tenantId);
      const existing = await db.get(`SELECT * FROM workflow_task_transition_requirements WHERE id = ? AND workflow_id = ?${tenant.sql}`, id, workflowId, ...tenant.params) as TransitionRequirementRecord | undefined;
      if (!existing) throw withStatus('Transition requirement not found', 404);
      return await updateScopedTransitionRequirementRow(db, id, existing, { ...input, workflow_id: workflowId }, { workflowId, workflowType: null, tenantId }, `WHERE id = ? AND workflow_id = ?${tenant.sql}`, [id, workflowId, ...tenant.params]);
    }

    const scope = await requireTransitionRequirementScope(db, input);
    const tenant = await tenantPredicateFor(db, 'workflow_task_transition_requirements', 'req', scope.tenantId);
    const existing = await db.get(`
      SELECT req.*
      FROM workflow_task_transition_requirements req
      LEFT JOIN workflows s ON s.id = req.workflow_id
      WHERE req.id = ?
        AND ((req.workflow_id IS NULL AND ?::text IS NULL) OR req.workflow_id = ?)
        AND COALESCE(req.project_id, s.project_id) = ?
        AND COALESCE(req.workflow_type, s.workflow_type) = ?
        ${tenant.sql}
    `, id, scope.workflowId, scope.workflowId, scope.projectId, scope.workflowType, ...tenant.params) as TransitionRequirementRecord | undefined;
    if (!existing) throw withStatus('Transition requirement not found', 404);
    const updateTenant = await tenantPredicateFor(db, 'workflow_task_transition_requirements', 'workflow_task_transition_requirements', scope.tenantId);
    return await updateScopedTransitionRequirementRow(db, id, existing, input, { workflowId: scope.workflowId, workflowType: scope.workflowType, tenantId: scope.tenantId }, `WHERE id = ?${updateTenant.sql}`, [id, ...updateTenant.params]);
  }

  requireRequirementScope(input, 'update');
}

async function updateScopedTransitionRequirementRow(
  db: Db,
  id: number,
  existing: TransitionRequirementRecord,
  input: Record<string, unknown>,
  scope: { workflowId: number | null; workflowType: string | null; tenantId?: number | null },
  whereClause: string,
  whereParams: unknown[],
) {
  const { task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority } = input;
  if (task_type !== undefined && task_type !== null && !isValidTaskType(task_type)) {
    throw withStatus(`Invalid task_type "${task_type}". Task type keys must use lowercase letters, numbers, underscores, or hyphens.`, 400);
  }
  if (requirement_type !== undefined && !['required', 'match', 'from_status'].includes(String(requirement_type))) {
    throw withStatus('requirement_type must be required, match, or from_status', 400);
  }
  if (severity !== undefined && !['block', 'warn'].includes(String(severity))) {
    throw withStatus('severity must be block or warn', 400);
  }
  const nextTaskType = task_type !== undefined ? (task_type ?? null) : existing.task_type;
  const nextFieldName = field_name ?? existing.field_name;
  const nextRequirementType = requirement_type ?? existing.requirement_type;
  const nextMatchField = match_field !== undefined ? (match_field ?? null) : existing.match_field;
  await requireTransitionRequirementFieldsForScope(db, scope, nextTaskType, nextFieldName, nextMatchField, nextRequirementType);
  await db.run(`
    UPDATE workflow_task_transition_requirements SET
      task_type = ?,
      outcome = ?,
      field_name = ?,
      requirement_type = ?,
      match_field = ?,
      severity = ?,
      message = ?,
      enabled = ?,
      priority = ?,
      updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    ${whereClause}
  `, nextTaskType, outcome ?? existing.outcome, nextFieldName, nextRequirementType, nextMatchField, severity ?? existing.severity, message ?? existing.message, enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled, priority ?? existing.priority, ...whereParams);
  const readTenant = await tenantPredicateFor(db, 'workflow_task_transition_requirements', 'workflow_task_transition_requirements', scope.tenantId);
  return await db.get(`SELECT * FROM workflow_task_transition_requirements WHERE id = ?${readTenant.sql}`, id, ...readTenant.params);
}

export async function deleteTransitionRequirement(db: Db, input: { id: unknown; workflow_id?: unknown; project_id?: unknown; workflow_type?: unknown; tenant_id?: unknown }) {
  const id = Number(input.id);
  const workflowId = parseWorkflowId(input.workflow_id);
  const hasScopedInput = input.project_id != null || input.workflow_type != null;
  if (workflowId || hasScopedInput) {
    if (!await tableHasRequirementScopeColumns(db)) {
      if (!workflowId) throw withStatus('workflow_id is required', 400);
      const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;
      await requireWorkflow(db, workflowId, tenantId);
      const tenant = await tenantPredicateFor(db, 'workflow_task_transition_requirements', 'workflow_task_transition_requirements', tenantId);
      const existing = await db.get(`
        SELECT id, task_type, outcome, field_name, requirement_type, match_field
        FROM workflow_task_transition_requirements
        WHERE id = ? AND workflow_id = ?${tenant.sql}
      `, id, workflowId, ...tenant.params) as {
        id: number;
        task_type: string | null;
        outcome: string;
        field_name: string;
        requirement_type: string;
        match_field: string | null;
      } | undefined;
      if (!existing) throw withStatus('Transition requirement not found', 404);
      await rememberDeletedWorkflowTaskTransitionRequirement(db, workflowId, existing);
      await db.run(`DELETE FROM workflow_task_transition_requirements WHERE id = ? AND workflow_id = ?${tenant.sql}`, id, workflowId, ...tenant.params);
      return { ok: true };
    }

    const scope = await requireTransitionRequirementScope(db, input);
    const tenant = await tenantPredicateFor(db, 'workflow_task_transition_requirements', 'req', scope.tenantId);
    const existing = await db.get(`
      SELECT req.id, req.workflow_id, req.task_type, req.outcome, req.field_name, req.requirement_type, req.match_field
      FROM workflow_task_transition_requirements req
      LEFT JOIN workflows s ON s.id = req.workflow_id
      WHERE req.id = ?
        AND ((req.workflow_id IS NULL AND ?::text IS NULL) OR req.workflow_id = ?)
        AND COALESCE(req.project_id, s.project_id) = ?
        AND COALESCE(req.workflow_type, s.workflow_type) = ?
        ${tenant.sql}
    `, id, scope.workflowId, scope.workflowId, scope.projectId, scope.workflowType, ...tenant.params) as {
      id: number;
      workflow_id: number | null;
      task_type: string | null;
      outcome: string;
      field_name: string;
      requirement_type: string;
      match_field: string | null;
    } | undefined;
    if (!existing) throw withStatus('Transition requirement not found', 404);
    if (existing.workflow_id != null) await rememberDeletedWorkflowTaskTransitionRequirement(db, existing.workflow_id, existing);
    const deleteTenant = await tenantPredicateFor(db, 'workflow_task_transition_requirements', 'workflow_task_transition_requirements', scope.tenantId);
    await db.run(`DELETE FROM workflow_task_transition_requirements WHERE id = ?${deleteTenant.sql}`, id, ...deleteTenant.params);
    return { ok: true };
  }
  requireRequirementScope(input, 'delete');
}
