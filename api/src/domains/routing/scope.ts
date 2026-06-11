import type Database from 'better-sqlite3';

export type StatusError = Error & { status?: number };
export type SprintRecord = { id: number; project_id: number; name: string; sprint_type?: string | null; tenant_id?: number | null };
export type RoutingRuleRecord = Record<string, unknown>;
export type TransitionRequirementRecord = Record<string, unknown>;
export type ProjectSprintTypeScope = {
  projectId: number | null;
  sprintType: string;
  sprintId: number | null;
  tenantId: number | null;
  scopeLabel: string;
};

export type RoutingScopeKind = 'sprint_type_default' | 'sprint_override';

export function normalizeRoutingRuleTaskType(input: unknown): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (typeof input !== 'string') return input as string;
  const value = input.trim();
  if (!value || value === '*') return null;
  if (value.toLowerCase() === 'all' || value.toLowerCase() === 'all_task_types' || value.toLowerCase() === 'all-task-types') return null;
  return value;
}


export type RoutingRuleRow = Record<string, unknown> & {
  scope_kind?: RoutingScopeKind;
  rule_scope_kind?: RoutingScopeKind;
  sprint_id?: number | null;
  sprint_name?: string | null;
  sprint_type?: string | null;
  project_id?: number | null;
  project_name?: string | null;
  agent_id?: number | null;
  task_type?: string | null;
  status?: string | null;
  priority?: number | null;
};


export function withStatus(message: string, status: number): StatusError {
  const error = new Error(message) as StatusError;
  error.status = status;
  return error;
}

export function parseSprintId(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function normalizeOptionalEnabled(input: unknown, fallback: number): number {
  if (input === undefined) return fallback;
  if (input === null || input === '') return fallback;
  if (typeof input === 'boolean') return input ? 1 : 0;
  if (typeof input === 'number') return input ? 1 : 0;
  if (typeof input === 'string') {
    const normalized = input.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'enabled') return 1;
    if (normalized === 'false' || normalized === '0' || normalized === 'disabled') return 0;
  }
  throw withStatus('enabled must be a boolean', 400);
}

export function tenantPredicateFor(db: Database.Database, table: string, tableAlias: string, tenantId?: number | null): { sql: string; params: number[] } {
  if (tenantId == null || !tableHasColumn(db, table, 'tenant_id')) return { sql: '', params: [] };
  return { sql: ` AND ${tableAlias}.tenant_id = ?`, params: [tenantId] };
}

export function tenantInsertFragment(db: Database.Database, table: string, tenantId?: number | null): { columns: string; placeholders: string; params: number[] } {
  if (tenantId == null || !tableHasColumn(db, table, 'tenant_id')) return { columns: '', placeholders: '', params: [] };
  return { columns: 'tenant_id, ', placeholders: '?, ', params: [tenantId] };
}

export function requireSprint(db: Database.Database, sprintId: number | null, tenantId?: number | null): SprintRecord {
  if (!sprintId) throw withStatus('sprint_id is required', 400);
  const hasTenant = tableHasColumn(db, 'sprints', 'tenant_id');
  const sprint = db.prepare(`SELECT id, project_id, name, sprint_type${hasTenant ? ', tenant_id' : ''} FROM sprints WHERE id = ?${hasTenant && tenantId != null ? ' AND tenant_id = ?' : ''}`)
    .get(...(hasTenant && tenantId != null ? [sprintId, tenantId] : [sprintId])) as SprintRecord | undefined;
  if (!sprint) throw withStatus(`Sprint ${sprintId} not found`, 404);
  return sprint;
}

export function normalizeSprintTypeKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  try {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return columns.some((entry) => entry.name === column);
  } catch {
    return false;
  }
}

export function parseObjectJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function requireProject(db: Database.Database, projectId: unknown, tenantId?: number | null): { id: number; name: string; tenant_id?: number | null } {
  const id = Number(projectId);
  if (!Number.isFinite(id)) {
    throw withStatus('project_id is required', 400);
  }
  const hasTenant = tableHasColumn(db, 'projects', 'tenant_id');
  const project = db.prepare(`SELECT id, name${hasTenant ? ', tenant_id' : ''} FROM projects WHERE id = ?${hasTenant && tenantId != null ? ' AND tenant_id = ?' : ''}`)
    .get(...(hasTenant && tenantId != null ? [id, tenantId] : [id])) as { id: number; name: string; tenant_id?: number | null } | undefined;
  if (!project) {
    throw withStatus(`Project ${id} not found`, 404);
  }
  return project;
}

export function requireProjectSprintTypeScope(
  db: Database.Database,
  input: { project_id?: unknown; sprint_id?: unknown; sprint_type?: unknown; tenant_id?: unknown },
): ProjectSprintTypeScope {
  const sprintId = parseSprintId(input.sprint_id);
  const explicitSprintType = normalizeSprintTypeKey(input.sprint_type);
  const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;

  if (sprintId) {
    const project = requireProject(db, input.project_id, tenantId);
    const sprint = requireSprint(db, sprintId, tenantId);
    if (sprint.project_id !== project.id) {
      throw withStatus(`Sprint ${sprint.id} belongs to project ${sprint.project_id}, not project ${project.id}`, 400);
    }
    const sprintType = normalizeSprintTypeKey(sprint.sprint_type);
    if (!sprintType) {
      throw withStatus(`Sprint ${sprint.id} is missing sprint_type`, 400);
    }
    if (explicitSprintType && explicitSprintType !== sprintType) {
      throw withStatus(`Sprint ${sprint.id} uses sprint_type ${sprintType}, not ${explicitSprintType}`, 400);
    }
    return {
      projectId: project.id,
      sprintType,
      sprintId: sprint.id,
      tenantId,
      scopeLabel: sprint.name,
    };
  }

  if (!explicitSprintType) {
    throw withStatus('sprint_type is required when sprint_id is not provided', 400);
  }

  const sprintTypeRow = db.prepare(`SELECT key FROM sprint_types WHERE key = ? LIMIT 1`).get(explicitSprintType) as { key?: string } | undefined;
  if (!sprintTypeRow) {
    throw withStatus(`Unknown sprint_type \"${explicitSprintType}\"`, 404);
  }

  if (input.project_id == null || input.project_id === '') {
    return {
      projectId: null,
      sprintType: explicitSprintType,
      sprintId: null,
      tenantId,
      scopeLabel: `All Projects / ${explicitSprintType}`,
    };
  }

  const project = requireProject(db, input.project_id, tenantId);
  return {
    projectId: project.id,
    sprintType: explicitSprintType,
    sprintId: null,
    tenantId,
    scopeLabel: `${project.name} / ${explicitSprintType}`,
  };
}


export function requireTransitionRequirementScope(
  db: Database.Database,
  input: { project_id?: unknown; sprint_id?: unknown; sprint_type?: unknown; tenant_id?: unknown },
): ProjectSprintTypeScope {
  const sprintId = parseSprintId(input.sprint_id);
  if (!sprintId || input.project_id != null) return requireProjectSprintTypeScope(db, input);
  const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;
  const sprint = requireSprint(db, sprintId, tenantId);
  return requireProjectSprintTypeScope(db, { ...input, project_id: sprint.project_id, tenant_id: tenantId });
}

export function tableHasRoutingRuleScopeColumns(db: Database.Database): boolean {
  return tableHasColumn(db, 'sprint_task_routing_rules', 'sprint_type')
    && tableHasColumn(db, 'sprint_task_routing_rules', 'project_id');
}

export function detectDuplicateRoutingRule(
  db: Database.Database,
  args: {
    projectId: number | null;
    sprintType: string;
    sprintId: number | null;
    taskType: string | null;
    status: string;
    agentId: number;
    priority: number;
    tenantId?: number | null;
    excludeId?: number;
  },
): { id: number } | undefined {
  if (tableHasRoutingRuleScopeColumns(db)) {
    const tenant = tenantPredicateFor(db, 'sprint_task_routing_rules', 'sprint_task_routing_rules', args.tenantId);
    const projectPredicate = args.projectId == null ? 'project_id IS NULL' : 'project_id = ?';
    const params: Array<number | string | null> = args.projectId == null
      ? [args.sprintType, args.sprintId, args.sprintId, args.taskType, args.status, args.agentId, args.priority]
      : [args.projectId, args.sprintType, args.sprintId, args.sprintId, args.taskType, args.status, args.agentId, args.priority];
    let sql = `
      SELECT id
      FROM sprint_task_routing_rules
      WHERE ${projectPredicate}
        AND sprint_type = ?
        AND ((sprint_id IS NULL AND ? IS NULL) OR sprint_id = ?)
        AND task_type IS ?
        AND status = ?
        AND agent_id = ?
        AND priority = ?
    `;
    if (typeof args.excludeId === 'number' && Number.isFinite(args.excludeId)) {
      sql += ' AND id != ?';
      params.push(args.excludeId);
    }
    sql += tenant.sql;
    sql += ' ORDER BY id ASC LIMIT 1';
    return db.prepare(sql).get(...params, ...tenant.params) as { id: number } | undefined;
  }

  if (args.sprintId == null) return undefined;
  const params: Array<number | string | null> = [args.sprintId, args.taskType, args.status, args.agentId, args.priority];
  let sql = `
    SELECT id
    FROM sprint_task_routing_rules
    WHERE sprint_id = ?
      AND task_type IS ?
      AND status = ?
      AND agent_id = ?
      AND priority = ?
  `;
  const tenant = tenantPredicateFor(db, 'sprint_task_routing_rules', 'sprint_task_routing_rules', args.tenantId);
  if (typeof args.excludeId === 'number' && Number.isFinite(args.excludeId)) {
    sql += ' AND id != ?';
    params.push(args.excludeId);
  }
  sql += tenant.sql;
  sql += ' ORDER BY id ASC LIMIT 1';
  return db.prepare(sql).get(...params, ...tenant.params) as { id: number } | undefined;
}

export function selectSprintScopedRoutingRuleRowSql(): string {
  return `
      SELECT trr.*, 'sprint_override' as rule_scope_kind, trr.agent_id as resolved_agent_id,
             s.name as sprint_name, s.project_id, p.name as project_name, s.sprint_type,
             a.job_title as job_title, a.name as agent_name
      FROM sprint_task_routing_rules trr
      LEFT JOIN sprints s ON s.id = trr.sprint_id
      LEFT JOIN projects p ON p.id = s.project_id
      LEFT JOIN agents a ON a.id = trr.agent_id
  `;
}

export function selectScopedRoutingRuleRowSql(db: Database.Database): string {
  if (!tableHasRoutingRuleScopeColumns(db)) return selectSprintScopedRoutingRuleRowSql();
  return `
      SELECT trr.*,
             CASE WHEN trr.sprint_id IS NULL THEN 'sprint_type_default' ELSE 'sprint_override' END as rule_scope_kind,
             trr.agent_id as resolved_agent_id,
             s.name as sprint_name,
             COALESCE(trr.project_id, s.project_id) as project_id,
             p.name as project_name,
             COALESCE(trr.sprint_type, s.sprint_type) as sprint_type,
             a.job_title as job_title, a.name as agent_name
      FROM sprint_task_routing_rules trr
      LEFT JOIN sprints s ON s.id = trr.sprint_id
      LEFT JOIN projects p ON p.id = COALESCE(trr.project_id, s.project_id)
      LEFT JOIN agents a ON a.id = trr.agent_id
  `;
}

export function readRoutingRuleScopeRows(
  db: Database.Database,
  scope: ProjectSprintTypeScope,
  options?: { scopeKind?: unknown },
): RoutingRuleRow[] {
  const normalizedScopeKind = typeof options?.scopeKind === 'string' ? options.scopeKind.trim() : null;
  const defaultsOnly = normalizedScopeKind === 'defaults' || normalizedScopeKind === 'sprint_type_default';
  const overridesOnly = normalizedScopeKind === 'overrides' || normalizedScopeKind === 'sprint_override';

  if (tableHasRoutingRuleScopeColumns(db)) {
    const tenant = tenantPredicateFor(db, 'sprint_task_routing_rules', 'trr', scope.tenantId);
    const clauses = [
      'trr.sprint_type = ?',
    ];
    const params: Array<string | number | null> = [scope.sprintType];
    if (scope.projectId == null) {
      clauses.unshift('trr.project_id IS NULL');
    } else {
      clauses.unshift('trr.project_id = ?');
      params.unshift(scope.projectId);
    }

    if (defaultsOnly) {
      clauses.push('trr.sprint_id IS NULL');
    } else if (overridesOnly) {
      if (scope.sprintId == null) return [];
      clauses.push('trr.sprint_id = ?');
      params.push(scope.sprintId);
    } else {
      clauses.push('(trr.sprint_id IS NULL OR trr.sprint_id = ?)');
      params.push(scope.sprintId);
    }
    params.push(...tenant.params);

    return db.prepare(`
      ${selectScopedRoutingRuleRowSql(db)}
      WHERE ${clauses.join('\n        AND ')}
        ${tenant.sql}
      ORDER BY CASE WHEN trr.sprint_id = ? THEN 0 ELSE 1 END,
               trr.status ASC, trr.task_type ASC, trr.priority DESC, trr.id ASC
    `).all(...params, scope.sprintId) as RoutingRuleRow[];
  }

  const sprintTenant = tenantPredicateFor(db, 'sprints', 's', scope.tenantId);
  const rows = db.prepare(`
    ${selectSprintScopedRoutingRuleRowSql()}
    WHERE s.project_id = ? AND s.sprint_type = ?
      ${sprintTenant.sql}
    ORDER BY CASE WHEN trr.sprint_id = ? THEN 0 ELSE 1 END,
             trr.status ASC, trr.task_type ASC, trr.priority DESC, trr.id ASC
  `).all(scope.projectId, scope.sprintType, ...sprintTenant.params, scope.sprintId ?? -1) as RoutingRuleRow[];

  return rows;
}

export function annotateRoutingRuleScope(
  rows: RoutingRuleRow[],
  selectedSprintId: number | null,
  options?: { scopeKind?: unknown },
): RoutingRuleRow[] {
  const normalizedScopeKind = typeof options?.scopeKind === 'string' ? options.scopeKind.trim() : null;
  const defaultsOnly = normalizedScopeKind === 'defaults' || normalizedScopeKind === 'sprint_type_default';
  const overrideKeys = new Set<string>();
  if (selectedSprintId != null) {
    for (const row of rows) {
      if ((row.rule_scope_kind ?? row.scope_kind) === 'sprint_override') {
        overrideKeys.add(`${String(row.task_type ?? '')}::${String(row.status)}`);
      }
    }
  }

  return rows.map((row) => {
    const ruleScopeKind = (row.rule_scope_kind ?? row.scope_kind ?? 'sprint_override') as RoutingScopeKind;
    const isOverride = ruleScopeKind === 'sprint_override';
    const scopeKind = isOverride ? 'sprint_override' : 'sprint_type_default';
    const compositeKey = `${String(row.task_type ?? '')}::${String(row.status)}`;
    const overriddenBySprint = selectedSprintId != null && !isOverride && overrideKeys.has(compositeKey);
    return {
      ...row,
      scope_kind: scopeKind,
      is_inherited: !isOverride,
      is_override: isOverride,
      overridden_by_sprint: overriddenBySprint,
      effective_for_sprint: defaultsOnly ? !isOverride : (selectedSprintId == null ? true : isOverride || !overriddenBySprint),
    };
  });
}

export function selectTransitionScopeRows(
  db: Database.Database,
  scope: ProjectSprintTypeScope,
): Array<Record<string, unknown>> {
  if (tableHasTransitionScopeColumns(db)) {
    const tenant = tenantPredicateFor(db, 'sprint_task_transitions', 'stt', scope.tenantId);
    const projectPredicate = scope.projectId == null
      ? 'COALESCE(stt.project_id, s.project_id) IS NULL'
      : 'COALESCE(stt.project_id, s.project_id) = ?';
    const filterParams: Array<string | number | null> = scope.projectId == null
      ? [scope.sprintType, scope.sprintId]
      : [scope.projectId, scope.sprintType, scope.sprintId];
    const rows = db.prepare(`
      SELECT stt.id, stt.sprint_id, stt.project_id, stt.sprint_type, stt.task_type,
             stt.from_status, stt.outcome, stt.to_status, stt.enabled, stt.priority,
             stt.is_protected, stt.created_at, stt.updated_at,
             CASE WHEN stt.sprint_id IS NULL THEN 'sprint_type_default' ELSE 'sprint_override' END as rule_scope_kind,
             s.name as sprint_name,
             COALESCE(stt.project_id, s.project_id) as project_id,
             p.name as project_name,
             COALESCE(stt.sprint_type, s.sprint_type) as sprint_type
      FROM sprint_task_transitions stt
      LEFT JOIN sprints s ON s.id = stt.sprint_id
      LEFT JOIN projects p ON p.id = COALESCE(stt.project_id, s.project_id)
      WHERE ${projectPredicate}
        AND COALESCE(stt.sprint_type, s.sprint_type) = ?
        AND (stt.sprint_id IS NULL OR stt.sprint_id = ?)
        ${tenant.sql}
      ORDER BY CASE WHEN stt.sprint_id = ? THEN 0 ELSE 1 END,
               stt.from_status ASC, stt.outcome ASC, stt.task_type ASC, stt.priority DESC, stt.id ASC
    `).all(...filterParams, ...tenant.params, scope.sprintId) as Array<Record<string, unknown>>;
    return rows;
  }

  if (scope.sprintId == null) return [];
  const tenant = tenantPredicateFor(db, 'sprints', 's', scope.tenantId);
  return db.prepare(`
    SELECT stt.id, stt.sprint_id, stt.task_type, stt.from_status, stt.outcome,
           stt.to_status, stt.enabled, stt.priority, stt.is_protected,
           stt.created_at, stt.updated_at, s.name as sprint_name, s.project_id, s.sprint_type
    FROM sprint_task_transitions stt
    INNER JOIN sprints s ON s.id = stt.sprint_id
    WHERE s.project_id = ?
      AND s.sprint_type = ?
      AND stt.sprint_id = ?
      ${tenant.sql}
    ORDER BY stt.priority DESC, stt.id ASC
  `).all(scope.projectId, scope.sprintType, scope.sprintId, ...tenant.params) as Array<Record<string, unknown>>;
}

export function annotateTransitionScope(
  rows: Array<Record<string, unknown>>,
  selectedSprintId: number | null,
): Array<Record<string, unknown>> {
  const overrideKeys = new Set<string>();
  if (selectedSprintId != null) {
    for (const row of rows) {
      if ((row.rule_scope_kind ?? row.scope_kind ?? 'sprint_override') === 'sprint_override') {
        overrideKeys.add(`${String(row.task_type ?? '')}::${String(row.from_status)}::${String(row.outcome)}`);
      }
    }
  }

  return rows.map((row) => {
    const rowSprintId = row.sprint_id == null ? null : Number(row.sprint_id);
    const ruleScopeKind = (row.rule_scope_kind ?? row.scope_kind ?? 'sprint_override') as RoutingScopeKind;
    const isOverride = ruleScopeKind === 'sprint_override' && selectedSprintId != null && rowSprintId === selectedSprintId;
    const scopeKind = ruleScopeKind === 'sprint_type_default' ? 'sprint_type_default' : 'sprint_override';
    const compositeKey = `${String(row.task_type ?? '')}::${String(row.from_status)}::${String(row.outcome)}`;
    const overriddenBySprint = selectedSprintId != null && scopeKind === 'sprint_type_default' && overrideKeys.has(compositeKey);
    return {
      ...row,
      scope_kind: scopeKind,
      is_inherited: scopeKind === 'sprint_type_default',
      is_override: isOverride,
      overridden_by_sprint: overriddenBySprint,
      effective_for_sprint: selectedSprintId == null ? true : isOverride || !overriddenBySprint,
    };
  });
}

export function tableHasTransitionScopeColumns(db: Database.Database): boolean {
  return tableHasColumn(db, 'sprint_task_transitions', 'project_id')
    && tableHasColumn(db, 'sprint_task_transitions', 'sprint_type');
}

export function tableHasRequirementScopeColumns(db: Database.Database): boolean {
  return tableHasColumn(db, 'sprint_task_transition_requirements', 'project_id')
    && tableHasColumn(db, 'sprint_task_transition_requirements', 'sprint_type');
}

export function requirementOverrideKey(row: TransitionRequirementRecord): string {
  return [
    String(row.task_type ?? ''),
    String(row.outcome ?? ''),
    String(row.field_name ?? ''),
    String(row.requirement_type ?? ''),
    String(row.match_field ?? ''),
  ].join('::');
}

export function selectRequirementScopeRows(
  db: Database.Database,
  scope: ProjectSprintTypeScope,
): Array<TransitionRequirementRecord> {
  if (!tableHasRequirementScopeColumns(db)) {
    if (scope.sprintId == null) return [];
    const tenant = tenantPredicateFor(db, 'sprints', 's', scope.tenantId);
    return db.prepare(`
      SELECT req.*, s.name as sprint_name, s.project_id, s.sprint_type
      FROM sprint_task_transition_requirements req
      INNER JOIN sprints s ON s.id = req.sprint_id
      WHERE s.project_id = ?
        AND s.sprint_type = ?
        AND req.sprint_id = ?
        ${tenant.sql}
      ORDER BY outcome ASC,
               req.task_type IS NULL ASC,
               req.priority DESC,
               req.id ASC
    `).all(scope.projectId, scope.sprintType, scope.sprintId, ...tenant.params) as TransitionRequirementRecord[];
  }

  const params: unknown[] = scope.projectId == null ? [scope.sprintType] : [scope.projectId, scope.sprintType];
  let sprintPredicate = `req.sprint_id IS NULL`;
  if (scope.sprintId != null) {
    sprintPredicate = `(req.sprint_id = ? OR req.sprint_id IS NULL)`;
    params.unshift(scope.sprintId);
  }
  const projectPredicate = scope.projectId == null
    ? 'COALESCE(req.project_id, s.project_id) IS NULL'
    : 'COALESCE(req.project_id, s.project_id) = ?';
  const tenant = tenantPredicateFor(db, 'sprint_task_transition_requirements', 'req', scope.tenantId);

  return db.prepare(`
    SELECT req.*, s.name as sprint_name, COALESCE(req.project_id, s.project_id) AS project_id, COALESCE(req.sprint_type, s.sprint_type) AS sprint_type
    FROM sprint_task_transition_requirements req
    LEFT JOIN sprints s ON s.id = req.sprint_id
    WHERE ${sprintPredicate}
      AND ${projectPredicate}
      AND COALESCE(req.sprint_type, s.sprint_type) = ?
      ${tenant.sql}
    ORDER BY CASE WHEN req.sprint_id IS NULL THEN 1 ELSE 0 END,
             outcome ASC,
             req.task_type IS NULL ASC,
             req.priority DESC,
             req.id ASC
  `).all(...params, ...tenant.params) as TransitionRequirementRecord[];
}

export function annotateRequirementScope(
  rows: TransitionRequirementRecord[],
  selectedSprintId: number | null,
): TransitionRequirementRecord[] {
  const overrideKeys = new Set(
    rows
      .filter((row) => selectedSprintId != null && row.sprint_id != null && Number(row.sprint_id) === selectedSprintId)
      .map(requirementOverrideKey),
  );
  return rows.map((row) => {
    const rowSprintId = row.sprint_id == null ? null : Number(row.sprint_id);
    const scopeKind = rowSprintId == null ? 'sprint_type_default' : 'sprint_override';
    const isOverride = selectedSprintId != null && rowSprintId === selectedSprintId;
    const overriddenBySprint = selectedSprintId != null && scopeKind === 'sprint_type_default' && overrideKeys.has(requirementOverrideKey(row));
    return {
      ...row,
      scope_kind: scopeKind,
      is_inherited: scopeKind === 'sprint_type_default',
      is_override: isOverride,
      overridden_by_sprint: overriddenBySprint,
      effective_for_sprint: selectedSprintId == null ? true : isOverride || !overriddenBySprint,
    };
  });
}

export function requireScopedTransitionContext(
  db: Database.Database,
  projectId: unknown,
  sprintIdRaw: unknown,
  sprintTypeRaw?: unknown,
  tenantIdRaw?: unknown,
): { projectId: number | null; sprintType: string; sprintId: number | null; sprintName: string | null; tenantId: number | null } {
  const tenantId = Number.isFinite(Number(tenantIdRaw)) ? Number(tenantIdRaw) : null;
  const scoped = requireProjectSprintTypeScope(db, { project_id: projectId, sprint_id: sprintIdRaw, sprint_type: sprintTypeRaw, tenant_id: tenantId });
  const sprintId = parseSprintId(sprintIdRaw);
  if (!sprintId) {
    if (tableHasTransitionScopeColumns(db)) {
      return { projectId: scoped.projectId, sprintType: scoped.sprintType, sprintId: null, sprintName: null, tenantId };
    }
    throw withStatus('sprint_id is required', 400);
  }
  const sprint = requireSprint(db, scoped.sprintId, tenantId);
  return { projectId: scoped.projectId, sprintType: scoped.sprintType, sprintId: scoped.sprintId, sprintName: sprint.name, tenantId };
}

export function readScopedRoutingTransition(db: Database.Database, scope: ProjectSprintTypeScope, id: number) {
  if (tableHasTransitionScopeColumns(db)) {
    const rows = selectTransitionScopeRows(db, scope);
    return annotateTransitionScope(rows, scope.sprintId).find((row) => Number(row.id) === id);
  }
  if (scope.sprintId == null) return undefined;
  const sprint = requireSprint(db, scope.sprintId, scope.tenantId);
  const projectName = (db.prepare(`SELECT name FROM projects WHERE id = ?`).get(sprint.project_id) as { name?: string } | undefined)?.name ?? null;
  const row = db.prepare(`
    SELECT *
    FROM sprint_task_transitions
    WHERE id = ? AND sprint_id = ?
      ${tenantPredicateFor(db, 'sprint_task_transitions', 'sprint_task_transitions', scope.tenantId).sql}
  `).get(id, scope.sprintId, ...tenantPredicateFor(db, 'sprint_task_transitions', 'sprint_task_transitions', scope.tenantId).params) as RoutingRuleRecord | undefined;
  return row ? { ...row, sprint_name: sprint.name, project_id: sprint.project_id, project_name: projectName, scope_kind: 'sprint_override', is_inherited: false, is_override: true, overridden_by_sprint: false, effective_for_sprint: true } : undefined;
}


export function resolveRoutingRuleTarget(
  db: Database.Database,
  input: { job_id?: unknown; agent_id?: unknown; tenant_id?: unknown },
): { agent_id: number } {
  const agentId = input.agent_id != null ? Number(input.agent_id) : null;
  const jobId = input.job_id != null ? Number(input.job_id) : null;
  const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;
  const tenant = tenantPredicateFor(db, 'agents', 'agents', tenantId);

  if (agentId != null && Number.isFinite(agentId)) {
    const agent = db.prepare(`SELECT id FROM agents WHERE id = ?${tenant.sql}`).get(agentId, ...tenant.params);
    if (!agent) {
      throw withStatus(`Agent ${agentId} not found`, 404);
    }
    return { agent_id: agentId };
  }

  if (jobId != null && Number.isFinite(jobId)) {
    const agent = db.prepare(`SELECT id FROM agents WHERE id = ?${tenant.sql}`).get(jobId, ...tenant.params);
    if (!agent) {
      throw withStatus(`Agent ${jobId} not found`, 404);
    }
    return { agent_id: jobId };
  }

  throw withStatus('agent_id is required', 400);
}
