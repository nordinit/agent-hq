import type { SprintTaskRoutingRuleRow, SprintTaskStatusMeta, SprintTaskTransitionRequirementRow, SprintTaskTransitionRow } from './types';
import {
  buildCanonicalPolicyStatuses,
  isSprintTypeStatusSeeded,
  parseJsonArray,
  parseJsonObject,
  sprintTypeTenantPredicate,
  tableExists,
  tableHasColumn,
  tenantPredicate,
  normalizeSprintType,
} from './metadata';
import { type Db } from "../../../db/adapter/types";

export async function listSprintTaskStatuses(
  db: Db,
  sprintId?: number | null,
): Promise<SprintTaskStatusMeta[]> {
  if (typeof sprintId === 'number' && Number.isFinite(sprintId) && await tableExists(db, 'sprint_task_statuses')) {
    const rows = await db.all(`
      SELECT status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json
      FROM sprint_task_statuses
      WHERE sprint_id = ?
      ORDER BY stage_order ASC, id ASC
    `, sprintId) as Array<{
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

export async function listSprintTypeTaskStatuses(
  db: Db,
  sprintType: string | null | undefined,
  options?: { tenantId?: number | null },
): Promise<SprintTaskStatusMeta[]> {
  const normalizedSprintType = normalizeSprintType(sprintType);
  if (normalizedSprintType && await tableExists(db, 'sprint_type_task_statuses')) {
    const tenant = await sprintTypeTenantPredicate(db, 'sprint_type_task_statuses', options?.tenantId);
    const rows = await db.all(`
      SELECT status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json
      FROM sprint_type_task_statuses
      WHERE sprint_type_key = ?
        ${tenant.sql}
      ORDER BY stage_order ASC, id ASC
    `, normalizedSprintType, ...tenant.params) as Array<{
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
    if (await isSprintTypeStatusSeeded(db, normalizedSprintType, options?.tenantId)) {
      return [];
    }
  }

  return buildCanonicalPolicyStatuses(normalizedSprintType).map((row, index) => ({
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

export async function listSprintTaskTransitions(
  db: Db,
  sprintId?: number | null,
): Promise<SprintTaskTransitionRow[]> {
  if (typeof sprintId === 'number' && Number.isFinite(sprintId) && await tableExists(db, 'sprint_task_transitions')) {
    const hasScopeColumns = await tableHasColumn(db, 'sprint_task_transitions', 'project_id')
      && await tableHasColumn(db, 'sprint_task_transitions', 'sprint_type');
    if (hasScopeColumns) {
      const sprint = await db.get(`SELECT project_id, sprint_type${await tableHasColumn(db, 'sprints', 'tenant_id') ? ', tenant_id' : ''} FROM sprints WHERE id = ?`, sprintId) as { project_id: number; sprint_type: string | null; tenant_id?: number | null } | undefined;
      if (!sprint?.sprint_type) return [];
      const tenant = await tenantPredicate(db, 'sprint_task_transitions', 'stt', sprint.tenant_id);
      const rows = await db.all(`
        SELECT stt.id, stt.sprint_id, COALESCE(stt.project_id, s.project_id) as project_id,
               COALESCE(stt.sprint_type, s.sprint_type) as sprint_type,
               stt.task_type, stt.from_status, stt.outcome, stt.to_status, stt.enabled,
               stt.priority, stt.is_protected, stt.created_at, stt.updated_at
        FROM sprint_task_transitions stt
        LEFT JOIN sprints s ON s.id = stt.sprint_id
        WHERE COALESCE(stt.project_id, s.project_id) = ?
          AND COALESCE(stt.sprint_type, s.sprint_type) = ?
          AND (stt.sprint_id IS NULL OR stt.sprint_id = ?)
          ${tenant.sql}
        ORDER BY CASE WHEN stt.sprint_id = ? THEN 0 ELSE 1 END, stt.priority DESC, stt.id ASC
      `, sprint.project_id, sprint.sprint_type, sprintId, ...tenant.params, sprintId) as SprintTaskTransitionRow[];
      const overrideKeys = new Set<string>();
      for (const row of rows) {
        if (row.sprint_id === sprintId) {
          overrideKeys.add(`${row.task_type ?? ''}::${row.from_status}::${row.outcome}`);
        }
      }
      return rows.filter((row) => row.sprint_id === sprintId || !overrideKeys.has(`${row.task_type ?? ''}::${row.from_status}::${row.outcome}`));
    }
    const rows = await db.all(`
      SELECT id, sprint_id, task_type, from_status, outcome, to_status, enabled,
             priority, is_protected, created_at, updated_at
      FROM sprint_task_transitions
      WHERE sprint_id = ?
      ORDER BY priority DESC, id ASC
    `, sprintId) as SprintTaskTransitionRow[];
    if (rows.length > 0) return rows;
  }

  return [];
}

export async function resolveSprintTaskTransition(
  db: Db,
  sprintId: number | null | undefined,
  fromStatus: string,
  outcome: string,
  taskType?: string | null,
): Promise<SprintTaskTransitionRow | null> {
  if (typeof sprintId === 'number' && Number.isFinite(sprintId) && await tableExists(db, 'sprint_task_transitions')) {
    const rows = (await listSprintTaskTransitions(db, sprintId))
      .filter((row) => row.enabled === 1 && row.from_status === fromStatus && row.outcome === outcome)
      .filter((row) => taskType ? (row.task_type === taskType || row.task_type == null) : row.task_type == null)
      .sort((a, b) => {
        const scopeA = a.sprint_id === sprintId ? 1 : 0;
        const scopeB = b.sprint_id === sprintId ? 1 : 0;
        if (scopeA !== scopeB) return scopeB - scopeA;
        const typeA = a.task_type ? 1 : 0;
        const typeB = b.task_type ? 1 : 0;
        if (typeA !== typeB) return typeB - typeA;
        if ((a.priority ?? 0) !== (b.priority ?? 0)) return (b.priority ?? 0) - (a.priority ?? 0);
        return a.id - b.id;
      });
    if (rows.length > 0) return rows[0];

    const hasScopeColumns = await tableHasColumn(db, 'sprint_task_transitions', 'project_id')
      && await tableHasColumn(db, 'sprint_task_transitions', 'sprint_type');
    if (hasScopeColumns) return null;

    if (taskType) {
      const typeRow = await db.get(`
        SELECT id, sprint_id, task_type, from_status, outcome, to_status, enabled,
               priority, is_protected, created_at, updated_at
        FROM sprint_task_transitions
        WHERE sprint_id = ? AND task_type = ? AND from_status = ? AND outcome = ? AND enabled = 1
        ORDER BY priority DESC, id ASC
        LIMIT 1
      `, sprintId, taskType, fromStatus, outcome) as SprintTaskTransitionRow | undefined;
      if (typeRow) return typeRow;
    }

    const defaultRow = await db.get(`
      SELECT id, sprint_id, task_type, from_status, outcome, to_status, enabled,
             priority, is_protected, created_at, updated_at
      FROM sprint_task_transitions
      WHERE sprint_id = ? AND task_type IS NULL AND from_status = ? AND outcome = ? AND enabled = 1
      ORDER BY priority DESC, id ASC
      LIMIT 1
    `, sprintId, fromStatus, outcome) as SprintTaskTransitionRow | undefined;
    if (defaultRow) return defaultRow;
  }

  return null;
}

export async function loadSprintTaskTransitionRequirements(
  db: Db,
  sprintId: number | null | undefined,
  outcome: string,
  taskType?: string | null,
): Promise<SprintTaskTransitionRequirementRow[]> {
  if (typeof sprintId === 'number' && Number.isFinite(sprintId) && await tableExists(db, 'sprint_task_transition_requirements')) {
    const hasScopeColumns = await tableHasColumn(db, 'sprint_task_transition_requirements', 'project_id')
      && await tableHasColumn(db, 'sprint_task_transition_requirements', 'sprint_type');
    const sprint = hasScopeColumns
      ? await db.get(`SELECT project_id, sprint_type${await tableHasColumn(db, 'sprints', 'tenant_id') ? ', tenant_id' : ''} FROM sprints WHERE id = ? LIMIT 1`, sprintId) as { project_id: number; sprint_type: string | null; tenant_id?: number | null } | undefined
      : undefined;
    const tenant = await tenantPredicate(db, 'sprint_task_transition_requirements', 'sprint_task_transition_requirements', sprint?.tenant_id);

    const loadRows = async (specificTaskType: string | null): Promise<SprintTaskTransitionRequirementRow[]> => {
      if (hasScopeColumns && sprint?.sprint_type) {
        return await db.all(`
          SELECT id, sprint_id, task_type, outcome, field_name, requirement_type, match_field,
                 severity, message, enabled, priority, created_at, updated_at
          FROM sprint_task_transition_requirements
          WHERE project_id = ?
            AND sprint_type = ?
            AND (sprint_id = ? OR sprint_id IS NULL)
            AND ${specificTaskType == null ? 'task_type IS NULL' : 'task_type = ?'}
            AND outcome = ?
            AND enabled = 1
            ${tenant.sql}
          ORDER BY CASE WHEN sprint_id = ? THEN 0 ELSE 1 END, priority DESC, id ASC
        `, ...(specificTaskType == null
                  ? [sprint.project_id, sprint.sprint_type, sprintId, outcome, ...tenant.params, sprintId]
                  : [sprint.project_id, sprint.sprint_type, sprintId, specificTaskType, outcome, ...tenant.params, sprintId])) as SprintTaskTransitionRequirementRow[];
      }
      return await db.all(`
        SELECT id, sprint_id, task_type, outcome, field_name, requirement_type, match_field,
               severity, message, enabled, priority, created_at, updated_at
        FROM sprint_task_transition_requirements
        WHERE sprint_id = ?
          AND ${specificTaskType == null ? 'task_type IS NULL' : 'task_type = ?'}
          AND outcome = ?
          AND enabled = 1
        ORDER BY priority DESC, id ASC
      `, ...(specificTaskType == null ? [sprintId, outcome] : [sprintId, specificTaskType, outcome])) as SprintTaskTransitionRequirementRow[];
    };

    if (taskType) {
      const typeRows = loadRows(taskType);
      if (typeRows.length > 0) return dedupeSprintTaskTransitionRequirementRows(typeRows);
    }

    const defaultRows = loadRows(null);
    if (defaultRows.length > 0) return dedupeSprintTaskTransitionRequirementRows(defaultRows);
  }

  return [];
}

function dedupeSprintTaskTransitionRequirementRows(rows: SprintTaskTransitionRequirementRow[]): SprintTaskTransitionRequirementRow[] {
  const seen = new Set<string>();
  const result: SprintTaskTransitionRequirementRow[] = [];
  for (const row of rows) {
    const key = [row.task_type ?? '', row.outcome, row.field_name, row.requirement_type, row.match_field ?? ''].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

export async function listSprintTaskTransitionRequirements(
  db: Db,
  sprintId?: number | null,
  taskType?: string | null,
  outcome?: string | null,
): Promise<SprintTaskTransitionRequirementRow[]> {
  if (typeof sprintId === 'number' && Number.isFinite(sprintId) && await tableExists(db, 'sprint_task_transition_requirements')) {
    const hasScopeColumns = await tableHasColumn(db, 'sprint_task_transition_requirements', 'project_id')
      && await tableHasColumn(db, 'sprint_task_transition_requirements', 'sprint_type');
    const sprint = hasScopeColumns
      ? await db.get(`SELECT project_id, sprint_type${await tableHasColumn(db, 'sprints', 'tenant_id') ? ', tenant_id' : ''} FROM sprints WHERE id = ? LIMIT 1`, sprintId) as { project_id: number; sprint_type: string | null; tenant_id?: number | null } | undefined
      : undefined;
    const tenant = await tenantPredicate(db, 'sprint_task_transition_requirements', 'sprint_task_transition_requirements', sprint?.tenant_id);
    let query = `
      SELECT id, sprint_id, task_type, outcome, field_name, requirement_type, match_field,
             severity, message, enabled, priority, created_at, updated_at
      FROM sprint_task_transition_requirements
      WHERE ${hasScopeColumns && sprint?.sprint_type ? 'project_id = ? AND sprint_type = ? AND (sprint_id = ? OR sprint_id IS NULL)' : 'sprint_id = ?'}
    `;
    const params: unknown[] = hasScopeColumns && sprint?.sprint_type ? [sprint.project_id, sprint.sprint_type, sprintId] : [sprintId];
    if (hasScopeColumns && sprint?.sprint_type && tenant.sql) {
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
    query += ` ORDER BY outcome ASC, task_type IS NULL ASC, CASE WHEN sprint_id IS NULL THEN 1 ELSE 0 END, priority DESC, id ASC`;
    return db.prepare(query).all(...params) as SprintTaskTransitionRequirementRow[];
  }

  if (!await tableExists(db, 'transition_requirements')) return [];
  let query = `
    SELECT id, NULL AS sprint_id, task_type, outcome, field_name, requirement_type, match_field,
           severity, message, enabled, priority, created_at, updated_at
    FROM transition_requirements
    WHERE 1 = 1
  `;
  const params: unknown[] = [];
  if (taskType) {
    query += ` AND (task_type = ? OR task_type IS NULL)`;
    params.push(taskType);
  }
  if (outcome) {
    query += ` AND outcome = ?`;
    params.push(outcome);
  }
  query += ` ORDER BY outcome ASC, task_type IS NULL ASC, priority DESC, id ASC`;
  return db.prepare(query).all(...params) as SprintTaskTransitionRequirementRow[];
}

export async function listSprintTaskRoutingRules(
  db: Db,
  sprintId?: number | null,
): Promise<SprintTaskRoutingRuleRow[]> {
  if (typeof sprintId === 'number' && Number.isFinite(sprintId) && await tableExists(db, 'sprint_task_routing_rules')) {
    const hasScopeColumns = await tableHasColumn(db, 'sprint_task_routing_rules', 'project_id')
      && await tableHasColumn(db, 'sprint_task_routing_rules', 'sprint_type');
    const enabledSelect = await tableHasColumn(db, 'sprint_task_routing_rules', 'enabled') ? 'enabled' : '1 as enabled';

    if (hasScopeColumns) {
      const sprint = await db.get(`SELECT project_id, sprint_type${await tableHasColumn(db, 'sprints', 'tenant_id') ? ', tenant_id' : ''} FROM sprints WHERE id = ? LIMIT 1`, sprintId) as { project_id: number; sprint_type: string | null; tenant_id?: number | null } | undefined;
      if (sprint?.sprint_type) {
        const tenant = await tenantPredicate(db, 'sprint_task_routing_rules', 'sprint_task_routing_rules', sprint.tenant_id);
        const rows = await db.all(`
          SELECT id, sprint_id, task_type, status, agent_id, ${enabledSelect}, priority, is_system, created_at, updated_at
          FROM sprint_task_routing_rules
          WHERE project_id = ?
            AND sprint_type = ?
            AND (sprint_id = ? OR sprint_id IS NULL)
            ${tenant.sql}
          ORDER BY CASE WHEN sprint_id = ? THEN 0 ELSE 1 END,
                   status ASC, task_type IS NULL ASC, task_type ASC, priority DESC, id ASC
        `, sprint.project_id, sprint.sprint_type, sprintId, ...tenant.params, sprintId) as SprintTaskRoutingRuleRow[];
        if (rows.length > 0) return rows;
      }
    }

    const rows = await db.all(`
      SELECT id, sprint_id, task_type, status, agent_id, ${enabledSelect}, priority, is_system, created_at, updated_at
      FROM sprint_task_routing_rules
      WHERE sprint_id = ?
      ORDER BY status ASC, task_type IS NULL ASC, task_type ASC, priority DESC, id ASC
    `, sprintId) as SprintTaskRoutingRuleRow[];
    if (rows.length > 0) return rows;
  }
  return [];
}

export async function resolveSprintTaskRoutingAssignment(
  db: Db,
  sprintId: number | null | undefined,
  taskType: string | null,
  status: string,
): Promise<{ agent_id: number | null }> {
  if (typeof sprintId === 'number' && Number.isFinite(sprintId) && await tableExists(db, 'sprint_task_routing_rules')) {
    const hasScopeColumns = await tableHasColumn(db, 'sprint_task_routing_rules', 'project_id')
      && await tableHasColumn(db, 'sprint_task_routing_rules', 'sprint_type');
    const enabledPredicate = await tableHasColumn(db, 'sprint_task_routing_rules', 'enabled') ? 'AND enabled = 1' : '';

    if (hasScopeColumns) {
      const sprint = await db.get(`SELECT project_id, sprint_type${await tableHasColumn(db, 'sprints', 'tenant_id') ? ', tenant_id' : ''} FROM sprints WHERE id = ? LIMIT 1`, sprintId) as { project_id: number; sprint_type: string | null; tenant_id?: number | null } | undefined;
      if (sprint?.sprint_type) {
        const tenant = await tenantPredicate(db, 'sprint_task_routing_rules', 'sprint_task_routing_rules', sprint.tenant_id);
        const row = await db.get(`
          SELECT agent_id
          FROM sprint_task_routing_rules
          WHERE project_id = ?
            AND sprint_type = ?
            AND (task_type = ? OR task_type IS NULL)
            AND status = ?
            AND (sprint_id = ? OR sprint_id IS NULL)
            ${enabledPredicate}
            ${tenant.sql}
          ORDER BY CASE WHEN sprint_id = ? THEN 0 ELSE 1 END,
                   CASE WHEN task_type = ? THEN 0 ELSE 1 END,
                   priority DESC,
                   id ASC
          LIMIT 1
        `, sprint.project_id, sprint.sprint_type, taskType, status, sprintId, ...tenant.params, sprintId, taskType) as { agent_id: number | null } | undefined;
        if (row) return { agent_id: row.agent_id ?? null };
      }
    }

    const row = await db.get(`
      SELECT agent_id
      FROM sprint_task_routing_rules
      WHERE sprint_id = ? AND task_type = ? AND status = ?
        ${enabledPredicate}
      ORDER BY priority DESC, id ASC
      LIMIT 1
    `, sprintId, taskType, status) as { agent_id: number | null } | undefined;
    if (row) return { agent_id: row.agent_id ?? null };
  }
  return { agent_id: null };
}
