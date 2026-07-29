import { isValidTaskType } from '../../lib/taskTypes';
import { getGateRequirementFieldDefinitions, resolveTaskFieldSchemaForSprint } from '../sprint-definitions/config';
import { seedSprintTaskPolicy, rememberDeletedSprintTaskTransitionRequirement } from './policy/seed';
import {
  annotateRequirementScope,
  normalizeSprintTypeKey,
  parseSprintId,
  requireSprint,
  requireTransitionRequirementScope,
  selectRequirementScopeRows,
  tableHasRequirementScopeColumns,
  tenantInsertFragment,
  tenantPredicateFor,
  withStatus,
  TransitionRequirementRecord,
} from './scope';
import { requireTransitionRequirementFieldsForScope, requireTransitionRequirementFieldsForSprint } from './validation';
import { type Db } from "../../db/adapter/types";

export async function listTransitionRequirementFields(
  db: Db,
  input: { sprint_id?: unknown; sprint_type?: unknown; task_type?: unknown; tenant_id?: unknown },
) {
  const sprintId = parseSprintId(input.sprint_id);
  if (!sprintId && !normalizeSprintTypeKey(input.sprint_type)) {
    throw withStatus('sprint_id or sprint_type is required', 400);
  }
  const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;
  if (sprintId) await requireSprint(db, sprintId, tenantId);
  const resolved = await resolveTaskFieldSchemaForSprint(db, {
      sprintId,
      sprintType: input.sprint_type,
      taskType: input.task_type,
    });
  const fields = getGateRequirementFieldDefinitions(resolved.schema.fields);
  return {
    sprint_type: resolved.sprint_type,
    task_type: typeof input.task_type === 'string' && input.task_type.trim() ? input.task_type.trim() : null,
    fields,
    field_names: fields.map(field => field.key),
  };
}

export async function listTransitionRequirements(
  db: Db,
  input: { project_id?: unknown; sprint_id?: unknown; sprint_type?: unknown; task_type?: unknown; outcome?: unknown; tenant_id?: unknown },
) {
  const taskType = input.task_type;
  const outcomeFilter = input.outcome;

  if (input.project_id != null || input.sprint_id != null || input.sprint_type != null) {
    const scope = await requireTransitionRequirementScope(db, input);
    let rows = annotateRequirementScope(await selectRequirementScopeRows(db, scope), scope.sprintId);
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
        sprint_type: scope.sprintType,
        sprint_id: scope.sprintId,
      },
    };
  }

  let query = `SELECT * FROM transition_requirements`;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (taskType) {
    conditions.push(`(task_type = ? OR task_type IS NULL)`);
    params.push(String(taskType));
  }
  if (outcomeFilter) {
    conditions.push(`outcome = ?`);
    params.push(String(outcomeFilter));
  }

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')}`;
  }

  query += ` ORDER BY task_type NULLS LAST, outcome, priority DESC, id ASC`;

  return { transition_requirements: db.prepare(query).all(...params) };
}

export async function createTransitionRequirement(db: Db, input: Record<string, unknown>) {
  const sprintId = parseSprintId(input.sprint_id);
  const hasDefaultScope = input.project_id != null || input.sprint_type != null;
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

  if (sprintId || hasDefaultScope) {
    if (!await tableHasRequirementScopeColumns(db)) {
      if (!sprintId) throw withStatus('sprint_id is required', 400);
      const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;
      await requireSprint(db, sprintId, tenantId);
      await seedSprintTaskPolicy(db, sprintId);
      await requireTransitionRequirementFieldsForSprint(db, sprintId, task_type ?? null, field_name, match_field ?? null, requirement_type);
      const tenant = await tenantInsertFragment(db, 'sprint_task_transition_requirements', tenantId);
      const result = await db.run(`
        INSERT INTO sprint_task_transition_requirements (${tenant.columns}sprint_id, task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority, created_at, updated_at)
        VALUES (${tenant.placeholders}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `, ...tenant.params, sprintId, task_type ?? null, outcome, field_name, requirement_type, match_field ?? null, severity, message, enabled ? 1 : 0, priority);
      const readTenant = await tenantPredicateFor(db, 'sprint_task_transition_requirements', 'sprint_task_transition_requirements', tenantId);
      return await db.get(`SELECT * FROM sprint_task_transition_requirements WHERE id = ? AND sprint_id = ?${readTenant.sql}`, result.lastInsertRowid, sprintId, ...readTenant.params);
    }

    const scope = await requireTransitionRequirementScope(db, input);
    if (scope.sprintId != null) await seedSprintTaskPolicy(db, scope.sprintId);
    await requireTransitionRequirementFieldsForScope(db, { sprintId: scope.sprintId, sprintType: scope.sprintType }, task_type ?? null, field_name, match_field ?? null, requirement_type);
    const tenant = await tenantInsertFragment(db, 'sprint_task_transition_requirements', scope.tenantId);
    const result = await db.run(`
      INSERT INTO sprint_task_transition_requirements (${tenant.columns}sprint_id, project_id, sprint_type, task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority, created_at, updated_at)
      VALUES (${tenant.placeholders}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `, ...tenant.params, scope.sprintId, scope.projectId, scope.sprintType, task_type ?? null, outcome, field_name, requirement_type, match_field ?? null, severity, message, enabled ? 1 : 0, priority);
    const readTenant = await tenantPredicateFor(db, 'sprint_task_transition_requirements', 'sprint_task_transition_requirements', scope.tenantId);
    return await db.get(`SELECT * FROM sprint_task_transition_requirements WHERE id = ?${readTenant.sql}`, result.lastInsertRowid, ...readTenant.params);
  }

  const result = await db.run(`
    INSERT INTO transition_requirements (task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, task_type ?? null, outcome, field_name, requirement_type, match_field ?? null, severity, message, enabled ? 1 : 0, priority);

  return await db.get('SELECT * FROM transition_requirements WHERE id = ?', result.lastInsertRowid);
}

export async function updateTransitionRequirement(db: Db, input: Record<string, unknown> & { id: unknown; sprint_id?: unknown; project_id?: unknown; sprint_type?: unknown; tenant_id?: unknown }) {
  const id = Number(input.id);
  const sprintId = parseSprintId(input.sprint_id);
  const hasScopedInput = input.project_id != null || input.sprint_type != null;
  if (sprintId || hasScopedInput) {
    if (!await tableHasRequirementScopeColumns(db)) {
      if (!sprintId) throw withStatus('sprint_id is required', 400);
      const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;
      await requireSprint(db, sprintId, tenantId);
      await seedSprintTaskPolicy(db, sprintId);
      const tenant = await tenantPredicateFor(db, 'sprint_task_transition_requirements', 'sprint_task_transition_requirements', tenantId);
      const existing = await db.get(`SELECT * FROM sprint_task_transition_requirements WHERE id = ? AND sprint_id = ?${tenant.sql}`, id, sprintId, ...tenant.params) as TransitionRequirementRecord | undefined;
      if (!existing) throw withStatus('Transition requirement not found', 404);
      return await updateScopedTransitionRequirementRow(db, id, existing, { ...input, sprint_id: sprintId }, { sprintId, sprintType: null, tenantId }, `WHERE id = ? AND sprint_id = ?${tenant.sql}`, [id, sprintId, ...tenant.params]);
    }

    const scope = await requireTransitionRequirementScope(db, input);
    if (scope.sprintId != null) await seedSprintTaskPolicy(db, scope.sprintId);
    const tenant = await tenantPredicateFor(db, 'sprint_task_transition_requirements', 'req', scope.tenantId);
    const existing = await db.get(`
      SELECT req.*
      FROM sprint_task_transition_requirements req
      LEFT JOIN sprints s ON s.id = req.sprint_id
      WHERE req.id = ?
        AND ((req.sprint_id IS NULL AND ? IS NULL) OR req.sprint_id = ?)
        AND COALESCE(req.project_id, s.project_id) = ?
        AND COALESCE(req.sprint_type, s.sprint_type) = ?
        ${tenant.sql}
    `, id, scope.sprintId, scope.sprintId, scope.projectId, scope.sprintType, ...tenant.params) as TransitionRequirementRecord | undefined;
    if (!existing) throw withStatus('Transition requirement not found', 404);
    const updateTenant = await tenantPredicateFor(db, 'sprint_task_transition_requirements', 'sprint_task_transition_requirements', scope.tenantId);
    return await updateScopedTransitionRequirementRow(db, id, existing, input, { sprintId: scope.sprintId, sprintType: scope.sprintType, tenantId: scope.tenantId }, `WHERE id = ?${updateTenant.sql}`, [id, ...updateTenant.params]);
  }

  const existing = await db.get('SELECT * FROM transition_requirements WHERE id = ?', id) as TransitionRequirementRecord | undefined;
  if (!existing) throw withStatus('Transition requirement not found', 404);

  const { task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority } = input;

  if (task_type !== undefined && task_type !== null && !isValidTaskType(task_type)) {
    throw withStatus(`Invalid task_type "${task_type}". Task type keys must use lowercase letters, numbers, underscores, or hyphens.`, 400);
  }

  await db.run(`
    UPDATE transition_requirements SET
      task_type = ?,
      outcome = ?,
      field_name = ?,
      requirement_type = ?,
      match_field = ?,
      severity = ?,
      message = ?,
      enabled = ?,
      priority = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `, task_type !== undefined ? (task_type ?? null) : existing.task_type, outcome ?? existing.outcome, field_name ?? existing.field_name, requirement_type ?? existing.requirement_type, match_field !== undefined ? (match_field ?? null) : existing.match_field, severity ?? existing.severity, message ?? existing.message, enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled, priority ?? existing.priority, id);

  return await db.get('SELECT * FROM transition_requirements WHERE id = ?', id);
}

async function updateScopedTransitionRequirementRow(
  db: Db,
  id: number,
  existing: TransitionRequirementRecord,
  input: Record<string, unknown>,
  scope: { sprintId: number | null; sprintType: string | null; tenantId?: number | null },
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
    UPDATE sprint_task_transition_requirements SET
      task_type = ?,
      outcome = ?,
      field_name = ?,
      requirement_type = ?,
      match_field = ?,
      severity = ?,
      message = ?,
      enabled = ?,
      priority = ?,
      updated_at = datetime('now')
    ${whereClause}
  `, nextTaskType, outcome ?? existing.outcome, nextFieldName, nextRequirementType, nextMatchField, severity ?? existing.severity, message ?? existing.message, enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled, priority ?? existing.priority, ...whereParams);
  const readTenant = await tenantPredicateFor(db, 'sprint_task_transition_requirements', 'sprint_task_transition_requirements', scope.tenantId);
  return await db.get(`SELECT * FROM sprint_task_transition_requirements WHERE id = ?${readTenant.sql}`, id, ...readTenant.params);
}

export async function deleteTransitionRequirement(db: Db, input: { id: unknown; sprint_id?: unknown; project_id?: unknown; sprint_type?: unknown; tenant_id?: unknown }) {
  const id = Number(input.id);
  const sprintId = parseSprintId(input.sprint_id);
  const hasScopedInput = input.project_id != null || input.sprint_type != null;
  if (sprintId || hasScopedInput) {
    if (!await tableHasRequirementScopeColumns(db)) {
      if (!sprintId) throw withStatus('sprint_id is required', 400);
      const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;
      await requireSprint(db, sprintId, tenantId);
      const tenant = await tenantPredicateFor(db, 'sprint_task_transition_requirements', 'sprint_task_transition_requirements', tenantId);
      const existing = await db.get(`
        SELECT id, task_type, outcome, field_name, requirement_type, match_field
        FROM sprint_task_transition_requirements
        WHERE id = ? AND sprint_id = ?${tenant.sql}
      `, id, sprintId, ...tenant.params) as {
        id: number;
        task_type: string | null;
        outcome: string;
        field_name: string;
        requirement_type: string;
        match_field: string | null;
      } | undefined;
      if (!existing) throw withStatus('Transition requirement not found', 404);
      await rememberDeletedSprintTaskTransitionRequirement(db, sprintId, existing);
      await db.run(`DELETE FROM sprint_task_transition_requirements WHERE id = ? AND sprint_id = ?${tenant.sql}`, id, sprintId, ...tenant.params);
      return { ok: true };
    }

    const scope = await requireTransitionRequirementScope(db, input);
    const tenant = await tenantPredicateFor(db, 'sprint_task_transition_requirements', 'req', scope.tenantId);
    const existing = await db.get(`
      SELECT req.id, req.sprint_id, req.task_type, req.outcome, req.field_name, req.requirement_type, req.match_field
      FROM sprint_task_transition_requirements req
      LEFT JOIN sprints s ON s.id = req.sprint_id
      WHERE req.id = ?
        AND ((req.sprint_id IS NULL AND ? IS NULL) OR req.sprint_id = ?)
        AND COALESCE(req.project_id, s.project_id) = ?
        AND COALESCE(req.sprint_type, s.sprint_type) = ?
        ${tenant.sql}
    `, id, scope.sprintId, scope.sprintId, scope.projectId, scope.sprintType, ...tenant.params) as {
      id: number;
      sprint_id: number | null;
      task_type: string | null;
      outcome: string;
      field_name: string;
      requirement_type: string;
      match_field: string | null;
    } | undefined;
    if (!existing) throw withStatus('Transition requirement not found', 404);
    if (existing.sprint_id != null) await rememberDeletedSprintTaskTransitionRequirement(db, existing.sprint_id, existing);
    const deleteTenant = await tenantPredicateFor(db, 'sprint_task_transition_requirements', 'sprint_task_transition_requirements', scope.tenantId);
    await db.run(`DELETE FROM sprint_task_transition_requirements WHERE id = ?${deleteTenant.sql}`, id, ...deleteTenant.params);
    return { ok: true };
  }
  const existing = await db.get('SELECT id FROM transition_requirements WHERE id = ?', id);
  if (!existing) throw withStatus('Transition requirement not found', 404);

  await db.run('DELETE FROM transition_requirements WHERE id = ?', id);
  return { ok: true };
}
