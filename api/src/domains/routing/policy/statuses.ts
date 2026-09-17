import type { WorkflowTaskRoutingRuleRow, WorkflowTaskStatusMeta, WorkflowTaskTransitionRequirementRow, WorkflowTaskTransitionRow } from './types';
import {
  buildCanonicalPolicyStatuses,
  isWorkflowTypeStatusSeeded,
  parseJsonArray,
  parseJsonObject,
  workflowTypeTenantPredicate,
  tableExists,
  tableHasColumn,
  tenantPredicate,
  normalizeWorkflowType,
} from './metadata';
import { type Db } from "../../../db/adapter/types";

export async function listWorkflowTaskStatuses(
  db: Db,
  workflowId?: number | null,
): Promise<WorkflowTaskStatusMeta[]> {
  if (typeof workflowId === 'number' && Number.isFinite(workflowId) && await tableExists(db, 'workflow_task_statuses')) {
    const rows = await db.all(`
      SELECT status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json
      FROM workflow_task_statuses
      WHERE workflow_id = ?
      ORDER BY stage_order ASC, id ASC
    `, workflowId) as Array<{
      status_key: string;
      label: string;
      color: string;
      terminal: number;
      is_system: number;
      allowed_transitions_json: string | null;
      stage_order: number | null;
      is_default_entry: number | null;
      metadata_json: string | null;
    }>;
    if (rows.length > 0) {
      return rows.map((row, index) => {
        const metadata = parseJsonObject(row.metadata_json);
        const emoji = typeof metadata.emoji === 'string' ? metadata.emoji : null;
        return {
          name: row.status_key,
          label: row.label,
          color: row.color,
          terminal: Boolean(row.terminal),
          is_system: Boolean(row.is_system),
          allowed_transitions: parseJsonArray(row.allowed_transitions_json),
          emoji,
          metadata: emoji ? { ...metadata, emoji } : metadata,
          stage_order: Number.isFinite(Number(row.stage_order)) ? Number(row.stage_order) : index,
          is_default_entry: Boolean(row.is_default_entry),
        };
      });
    }

    return [];
  }

  return buildCanonicalPolicyStatuses(null).map((row, index) => ({
    name: row.name,
    label: row.label,
    color: row.color,
    terminal: Boolean(row.terminal),
    is_system: Boolean(row.is_system),
    allowed_transitions: parseJsonArray(row.allowed_transitions),
    emoji: row.emoji,
    metadata: row.emoji ? { emoji: row.emoji } : {},
    stage_order: index,
    is_default_entry: index === 0,
  }));
}

export async function listWorkflowTypeTaskStatuses(
  db: Db,
  workflowType: string | null | undefined,
  options?: { tenantId?: number | null },
): Promise<WorkflowTaskStatusMeta[]> {
  const normalizedWorkflowType = normalizeWorkflowType(workflowType);
  if (normalizedWorkflowType && await tableExists(db, 'workflow_type_task_statuses')) {
    const tenant = await workflowTypeTenantPredicate(db, 'workflow_type_task_statuses', options?.tenantId);
    const rows = await db.all(`
      SELECT status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json
      FROM workflow_type_task_statuses
      WHERE workflow_type_key = ?
        ${tenant.sql}
      ORDER BY stage_order ASC, id ASC
    `, normalizedWorkflowType, ...tenant.params) as Array<{
      status_key: string;
      label: string;
      color: string;
      terminal: number;
      is_system: number;
      allowed_transitions_json: string | null;
      stage_order: number | null;
      is_default_entry: number | null;
      metadata_json: string | null;
    }>;
    if (rows.length > 0) {
      return rows.map((row, index) => {
        const metadata = parseJsonObject(row.metadata_json);
        const emoji = typeof metadata.emoji === 'string' ? metadata.emoji : null;
        return {
          name: row.status_key,
          label: row.label,
          color: row.color,
          terminal: Boolean(row.terminal),
          is_system: Boolean(row.is_system),
          allowed_transitions: parseJsonArray(row.allowed_transitions_json),
          emoji,
          metadata: emoji ? { ...metadata, emoji } : metadata,
          stage_order: Number.isFinite(Number(row.stage_order)) ? Number(row.stage_order) : index,
          is_default_entry: Boolean(row.is_default_entry),
        };
      });
    }
    if (await isWorkflowTypeStatusSeeded(db, normalizedWorkflowType, options?.tenantId)) {
      return [];
    }
  }

  return buildCanonicalPolicyStatuses(normalizedWorkflowType).map((row, index) => ({
    name: row.name,
    label: row.label,
    color: row.color,
    terminal: Boolean(row.terminal),
    is_system: Boolean(row.is_system),
    allowed_transitions: parseJsonArray(row.allowed_transitions),
    emoji: row.emoji,
    metadata: row.emoji ? { emoji: row.emoji } : {},
    stage_order: index,
    is_default_entry: index === 0,
  }));
}

export async function listWorkflowTaskTransitions(
  db: Db,
  workflowId?: number | null,
): Promise<WorkflowTaskTransitionRow[]> {
  if (typeof workflowId === 'number' && Number.isFinite(workflowId) && await tableExists(db, 'workflow_task_transitions')) {
    const hasScopeColumns = await tableHasColumn(db, 'workflow_task_transitions', 'project_id')
      && await tableHasColumn(db, 'workflow_task_transitions', 'workflow_type');
    if (hasScopeColumns) {
      const workflow = await db.get(`SELECT project_id, workflow_type${await tableHasColumn(db, 'workflows', 'tenant_id') ? ', tenant_id' : ''} FROM workflows WHERE id = ?`, workflowId) as { project_id: number; workflow_type: string | null; tenant_id?: number | null } | undefined;
      if (!workflow?.workflow_type) return [];
      const tenant = await tenantPredicate(db, 'workflow_task_transitions', 'stt', workflow.tenant_id);
      const rows = await db.all(`
        SELECT stt.id, stt.workflow_id, COALESCE(stt.project_id, s.project_id) as project_id,
               COALESCE(stt.workflow_type, s.workflow_type) as workflow_type,
               stt.task_type, stt.from_status, stt.outcome, stt.to_status, stt.enabled,
               stt.priority, stt.is_protected, stt.created_at, stt.updated_at
        FROM workflow_task_transitions stt
        LEFT JOIN workflows s ON s.id = stt.workflow_id
        WHERE COALESCE(stt.project_id, s.project_id) = ?
          AND COALESCE(stt.workflow_type, s.workflow_type) = ?
          AND (stt.workflow_id IS NULL OR stt.workflow_id = ?)
          ${tenant.sql}
        ORDER BY CASE WHEN stt.workflow_id = ? THEN 0 ELSE 1 END, stt.priority DESC, stt.id ASC
      `, workflow.project_id, workflow.workflow_type, workflowId, ...tenant.params, workflowId) as WorkflowTaskTransitionRow[];
      const overrideKeys = new Set<string>();
      for (const row of rows) {
        if (row.workflow_id === workflowId) {
          overrideKeys.add(`${row.task_type ?? ''}::${row.from_status}::${row.outcome}`);
        }
      }
      return rows.filter((row) => row.workflow_id === workflowId || !overrideKeys.has(`${row.task_type ?? ''}::${row.from_status}::${row.outcome}`));
    }
    const rows = await db.all(`
      SELECT id, workflow_id, task_type, from_status, outcome, to_status, enabled,
             priority, is_protected, created_at, updated_at
      FROM workflow_task_transitions
      WHERE workflow_id = ?
      ORDER BY priority DESC, id ASC
    `, workflowId) as WorkflowTaskTransitionRow[];
    if (rows.length > 0) return rows;
  }

  return [];
}

export async function resolveWorkflowTaskTransition(
  db: Db,
  workflowId: number | null | undefined,
  fromStatus: string,
  outcome: string,
  taskType?: string | null,
): Promise<WorkflowTaskTransitionRow | null> {
  if (typeof workflowId === 'number' && Number.isFinite(workflowId) && await tableExists(db, 'workflow_task_transitions')) {
    const rows = (await listWorkflowTaskTransitions(db, workflowId))
      .filter((row) => row.enabled === 1 && row.from_status === fromStatus && row.outcome === outcome)
      .filter((row) => taskType ? (row.task_type === taskType || row.task_type == null) : row.task_type == null)
      .sort((a, b) => {
        const scopeA = a.workflow_id === workflowId ? 1 : 0;
        const scopeB = b.workflow_id === workflowId ? 1 : 0;
        if (scopeA !== scopeB) return scopeB - scopeA;
        const typeA = a.task_type ? 1 : 0;
        const typeB = b.task_type ? 1 : 0;
        if (typeA !== typeB) return typeB - typeA;
        if ((a.priority ?? 0) !== (b.priority ?? 0)) return (b.priority ?? 0) - (a.priority ?? 0);
        return a.id - b.id;
      });
    if (rows.length > 0) return rows[0];

    const hasScopeColumns = await tableHasColumn(db, 'workflow_task_transitions', 'project_id')
      && await tableHasColumn(db, 'workflow_task_transitions', 'workflow_type');
    if (hasScopeColumns) return null;

    if (taskType) {
      const typeRow = await db.get(`
        SELECT id, workflow_id, task_type, from_status, outcome, to_status, enabled,
               priority, is_protected, created_at, updated_at
        FROM workflow_task_transitions
        WHERE workflow_id = ? AND task_type = ? AND from_status = ? AND outcome = ? AND enabled = 1
        ORDER BY priority DESC, id ASC
        LIMIT 1
      `, workflowId, taskType, fromStatus, outcome) as WorkflowTaskTransitionRow | undefined;
      if (typeRow) return typeRow;
    }

    const defaultRow = await db.get(`
      SELECT id, workflow_id, task_type, from_status, outcome, to_status, enabled,
             priority, is_protected, created_at, updated_at
      FROM workflow_task_transitions
      WHERE workflow_id = ? AND task_type IS NULL AND from_status = ? AND outcome = ? AND enabled = 1
      ORDER BY priority DESC, id ASC
      LIMIT 1
    `, workflowId, fromStatus, outcome) as WorkflowTaskTransitionRow | undefined;
    if (defaultRow) return defaultRow;
  }

  return null;
}

export async function loadWorkflowTaskTransitionRequirements(
  db: Db,
  workflowId: number | null | undefined,
  outcome: string,
  taskType?: string | null,
): Promise<WorkflowTaskTransitionRequirementRow[]> {
  if (typeof workflowId === 'number' && Number.isFinite(workflowId) && await tableExists(db, 'workflow_task_transition_requirements')) {
    const hasScopeColumns = await tableHasColumn(db, 'workflow_task_transition_requirements', 'project_id')
      && await tableHasColumn(db, 'workflow_task_transition_requirements', 'workflow_type');
    const workflow = hasScopeColumns
      ? await db.get(`SELECT project_id, workflow_type${await tableHasColumn(db, 'workflows', 'tenant_id') ? ', tenant_id' : ''} FROM workflows WHERE id = ? LIMIT 1`, workflowId) as { project_id: number; workflow_type: string | null; tenant_id?: number | null } | undefined
      : undefined;
    const tenant = await tenantPredicate(db, 'workflow_task_transition_requirements', 'workflow_task_transition_requirements', workflow?.tenant_id);

    const loadRows = async (specificTaskType: string | null): Promise<WorkflowTaskTransitionRequirementRow[]> => {
      if (hasScopeColumns && workflow?.workflow_type) {
        return await db.all(`
          SELECT id, workflow_id, task_type, outcome, field_name, requirement_type, match_field,
                 severity, message, enabled, priority, created_at, updated_at
          FROM workflow_task_transition_requirements
          WHERE project_id = ?
            AND workflow_type = ?
            AND (workflow_id = ? OR workflow_id IS NULL)
            AND ${specificTaskType == null ? 'task_type IS NULL' : 'task_type = ?'}
            AND outcome = ?
            AND enabled = 1
            ${tenant.sql}
          ORDER BY CASE WHEN workflow_id = ? THEN 0 ELSE 1 END, priority DESC, id ASC
        `, ...(specificTaskType == null
                  ? [workflow.project_id, workflow.workflow_type, workflowId, outcome, ...tenant.params, workflowId]
                  : [workflow.project_id, workflow.workflow_type, workflowId, specificTaskType, outcome, ...tenant.params, workflowId])) as WorkflowTaskTransitionRequirementRow[];
      }
      return await db.all(`
        SELECT id, workflow_id, task_type, outcome, field_name, requirement_type, match_field,
               severity, message, enabled, priority, created_at, updated_at
        FROM workflow_task_transition_requirements
        WHERE workflow_id = ?
          AND ${specificTaskType == null ? 'task_type IS NULL' : 'task_type = ?'}
          AND outcome = ?
          AND enabled = 1
        ORDER BY priority DESC, id ASC
      `, ...(specificTaskType == null ? [workflowId, outcome] : [workflowId, specificTaskType, outcome])) as WorkflowTaskTransitionRequirementRow[];
    };

    // Gates ACCUMULATE across the task-type dimension: a task-type row adds to the all-types
    // set rather than substituting for it.
    //
    // This used to be an early return — if any row existed for the task type, the task_type IS
    // NULL rows were never loaded. Adding one narrow gate for one task type therefore switched
    // off every default gate for that outcome for that type, silently, which is the opposite of
    // what inserting a requirement looks like it does.
    //
    // Task-type rows are collected first so that dedupe keeps them: a task-type row naming the
    // same field and requirement type as an all-types row is still an override, it just now
    // overrides that one row instead of the whole set.
    const rows: WorkflowTaskTransitionRequirementRow[] = [];
    if (taskType) rows.push(...await loadRows(taskType));
    rows.push(...await loadRows(null));
    return dedupeWorkflowTaskTransitionRequirementRows(rows);
  }

  return [];
}

/**
 * First row wins per (outcome, field, requirement type, match field). task_type is deliberately
 * NOT part of the key: the caller hands this the task-type rows ahead of the all-types rows, so
 * leaving it out is what makes a task-type row override the matching all-types row while rows
 * naming different fields accumulate. It was in the key back when each call passed a single
 * task type's rows, where it was constant and so had no effect.
 */
function dedupeWorkflowTaskTransitionRequirementRows(rows: WorkflowTaskTransitionRequirementRow[]): WorkflowTaskTransitionRequirementRow[] {
  const seen = new Set<string>();
  const result: WorkflowTaskTransitionRequirementRow[] = [];
  for (const row of rows) {
    const key = [row.outcome, row.field_name, row.requirement_type, row.match_field ?? ''].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

export async function listWorkflowTaskTransitionRequirements(
  db: Db,
  workflowId?: number | null,
  taskType?: string | null,
  outcome?: string | null,
): Promise<WorkflowTaskTransitionRequirementRow[]> {
  if (typeof workflowId === 'number' && Number.isFinite(workflowId) && await tableExists(db, 'workflow_task_transition_requirements')) {
    const hasScopeColumns = await tableHasColumn(db, 'workflow_task_transition_requirements', 'project_id')
      && await tableHasColumn(db, 'workflow_task_transition_requirements', 'workflow_type');
    const workflow = hasScopeColumns
      ? await db.get(`SELECT project_id, workflow_type${await tableHasColumn(db, 'workflows', 'tenant_id') ? ', tenant_id' : ''} FROM workflows WHERE id = ? LIMIT 1`, workflowId) as { project_id: number; workflow_type: string | null; tenant_id?: number | null } | undefined
      : undefined;
    const tenant = await tenantPredicate(db, 'workflow_task_transition_requirements', 'workflow_task_transition_requirements', workflow?.tenant_id);
    let query = `
      SELECT id, workflow_id, task_type, outcome, field_name, requirement_type, match_field,
             severity, message, enabled, priority, created_at, updated_at
      FROM workflow_task_transition_requirements
      WHERE ${hasScopeColumns && workflow?.workflow_type ? 'project_id = ? AND workflow_type = ? AND (workflow_id = ? OR workflow_id IS NULL)' : 'workflow_id = ?'}
    `;
    const params: unknown[] = hasScopeColumns && workflow?.workflow_type ? [workflow.project_id, workflow.workflow_type, workflowId] : [workflowId];
    if (hasScopeColumns && workflow?.workflow_type && tenant.sql) {
      query += tenant.sql;
      params.push(...tenant.params);
    }
    if (taskType) {
      query += ` AND (task_type = ? OR task_type IS NULL)`;
      params.push(taskType);
    }
    if (outcome) {
      query += ` AND outcome = ?`;
      params.push(outcome);
    }
    query += ` ORDER BY outcome ASC, task_type IS NULL ASC, CASE WHEN workflow_id IS NULL THEN 1 ELSE 0 END, priority DESC, id ASC`;
    return await db.all(query, ...params) as WorkflowTaskTransitionRequirementRow[];
  }

  // No workflow id means no scope, and gate requirements only exist inside one. This used to
  // list the global `transition_requirements` table instead, which migration 15 dropped.
  return [];
}

export async function listWorkflowTaskRoutingRules(
  db: Db,
  workflowId?: number | null,
): Promise<WorkflowTaskRoutingRuleRow[]> {
  if (typeof workflowId === 'number' && Number.isFinite(workflowId) && await tableExists(db, 'workflow_task_routing_rules')) {
    const hasScopeColumns = await tableHasColumn(db, 'workflow_task_routing_rules', 'project_id')
      && await tableHasColumn(db, 'workflow_task_routing_rules', 'workflow_type');
    const enabledSelect = await tableHasColumn(db, 'workflow_task_routing_rules', 'enabled') ? 'enabled' : '1 as enabled';

    if (hasScopeColumns) {
      const workflow = await db.get(`SELECT project_id, workflow_type${await tableHasColumn(db, 'workflows', 'tenant_id') ? ', tenant_id' : ''} FROM workflows WHERE id = ? LIMIT 1`, workflowId) as { project_id: number; workflow_type: string | null; tenant_id?: number | null } | undefined;
      if (workflow?.workflow_type) {
        const tenant = await tenantPredicate(db, 'workflow_task_routing_rules', 'workflow_task_routing_rules', workflow.tenant_id);
        const rows = await db.all(`
          SELECT id, workflow_id, task_type, status, agent_id, ${enabledSelect}, priority, is_system, created_at, updated_at
          FROM workflow_task_routing_rules
          WHERE project_id = ?
            AND workflow_type = ?
            AND (workflow_id = ? OR workflow_id IS NULL)
            ${tenant.sql}
          ORDER BY CASE WHEN workflow_id = ? THEN 0 ELSE 1 END,
                   status ASC, task_type IS NULL ASC, task_type ASC, priority DESC, id ASC
        `, workflow.project_id, workflow.workflow_type, workflowId, ...tenant.params, workflowId) as WorkflowTaskRoutingRuleRow[];
        if (rows.length > 0) return rows;
      }
    }

    const rows = await db.all(`
      SELECT id, workflow_id, task_type, status, agent_id, ${enabledSelect}, priority, is_system, created_at, updated_at
      FROM workflow_task_routing_rules
      WHERE workflow_id = ?
      ORDER BY status ASC, task_type IS NULL ASC, task_type ASC, priority DESC, id ASC
    `, workflowId) as WorkflowTaskRoutingRuleRow[];
    if (rows.length > 0) return rows;
  }
  return [];
}

export async function resolveWorkflowTaskRoutingAssignment(
  db: Db,
  workflowId: number | null | undefined,
  taskType: string | null,
  status: string,
): Promise<{ agent_id: number | null }> {
  if (typeof workflowId === 'number' && Number.isFinite(workflowId) && await tableExists(db, 'workflow_task_routing_rules')) {
    const hasScopeColumns = await tableHasColumn(db, 'workflow_task_routing_rules', 'project_id')
      && await tableHasColumn(db, 'workflow_task_routing_rules', 'workflow_type');
    const enabledPredicate = await tableHasColumn(db, 'workflow_task_routing_rules', 'enabled') ? 'AND enabled = 1' : '';

    if (hasScopeColumns) {
      const workflow = await db.get(`SELECT project_id, workflow_type${await tableHasColumn(db, 'workflows', 'tenant_id') ? ', tenant_id' : ''} FROM workflows WHERE id = ? LIMIT 1`, workflowId) as { project_id: number; workflow_type: string | null; tenant_id?: number | null } | undefined;
      if (workflow?.workflow_type) {
        const tenant = await tenantPredicate(db, 'workflow_task_routing_rules', 'workflow_task_routing_rules', workflow.tenant_id);
        const row = await db.get(`
          SELECT agent_id
          FROM workflow_task_routing_rules
          WHERE project_id = ?
            AND workflow_type = ?
            AND (task_type = ? OR task_type IS NULL)
            AND status = ?
            AND (workflow_id = ? OR workflow_id IS NULL)
            ${enabledPredicate}
            ${tenant.sql}
          ORDER BY CASE WHEN workflow_id = ? THEN 0 ELSE 1 END,
                   CASE WHEN task_type = ? THEN 0 ELSE 1 END,
                   priority DESC,
                   id ASC
          LIMIT 1
        `, workflow.project_id, workflow.workflow_type, taskType, status, workflowId, ...tenant.params, workflowId, taskType) as { agent_id: number | null } | undefined;
        if (row) return { agent_id: row.agent_id ?? null };
      }
    }

    const row = await db.get(`
      SELECT agent_id
      FROM workflow_task_routing_rules
      WHERE workflow_id = ? AND task_type = ? AND status = ?
        ${enabledPredicate}
      ORDER BY priority DESC, id ASC
      LIMIT 1
    `, workflowId, taskType, status) as { agent_id: number | null } | undefined;
    if (row) return { agent_id: row.agent_id ?? null };
  }
  return { agent_id: null };
}
