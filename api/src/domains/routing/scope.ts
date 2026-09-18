import { type Db } from "../../db/adapter/types";
import { tableExists as sharedTableExists, columnExists as sharedColumnExists, tableColumns as sharedTableColumns, indexExists as sharedIndexExists } from "../../db/introspection";

export type StatusError = Error & { status?: number };
export type WorkflowRecord = { id: number; project_id: number; name: string; workflow_type?: string | null; tenant_id?: number | null };
export type RoutingRuleRecord = Record<string, unknown>;
export type TransitionRequirementRecord = Record<string, unknown>;
export type ProjectWorkflowTypeScope = {
  projectId: number | null;
  workflowType: string;
  workflowId: number | null;
  tenantId: number | null;
  scopeLabel: string;
};

export type RoutingScopeKind = 'workflow_type_default' | 'workflow_override';

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
  workflow_id?: number | null;
  workflow_name?: string | null;
  workflow_type?: string | null;
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

export function parseWorkflowId(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * PostgreSQL normally returns booleans for `enabled`; compatibility/import paths may still
 * surface 0/1 strings. `Boolean(row.enabled)` would incorrectly treat '0' as true.
 */
export function isRowEnabled(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
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

export async function tenantPredicateFor(db: Db, table: string, tableAlias: string, tenantId?: number | null): Promise<{ sql: string; params: number[] }> {
  if (tenantId == null || !await tableHasColumn(db, table, 'tenant_id')) return { sql: '', params: [] };
  return { sql: ` AND ${tableAlias}.tenant_id = ?`, params: [tenantId] };
}

export async function tenantInsertFragment(db: Db, table: string, tenantId?: number | null): Promise<{ columns: string; placeholders: string; params: number[] }> {
  if (tenantId == null || !await tableHasColumn(db, table, 'tenant_id')) return { columns: '', placeholders: '', params: [] };
  return { columns: 'tenant_id, ', placeholders: '?, ', params: [tenantId] };
}

export async function requireWorkflow(db: Db, workflowId: number | null, tenantId?: number | null): Promise<WorkflowRecord> {
  if (!workflowId) throw withStatus('workflow_id is required', 400);
  const hasTenant = await tableHasColumn(db, 'workflows', 'tenant_id');
  const workflow = await db.get(`SELECT id, project_id, name, workflow_type${hasTenant ? ', tenant_id' : ''} FROM workflows WHERE id = ?${hasTenant && tenantId != null ? ' AND tenant_id = ?' : ''}`, ...(hasTenant && tenantId != null ? [workflowId, tenantId] : [workflowId])) as WorkflowRecord | undefined;
  if (!workflow) throw withStatus(`Workflow ${workflowId} not found`, 404);
  return workflow;
}

export function normalizeWorkflowTypeKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function tableHasColumn(db: Db, table: string, column: string): Promise<boolean> {
    return await sharedColumnExists(db, table, column);
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

export async function requireProject(db: Db, projectId: unknown, tenantId?: number | null): Promise<{ id: number; name: string; tenant_id?: number | null }> {
  const id = Number(projectId);
  if (!Number.isFinite(id)) {
    throw withStatus('project_id is required', 400);
  }
  const hasTenant = await tableHasColumn(db, 'projects', 'tenant_id');
  const project = await db.get(`SELECT id, name${hasTenant ? ', tenant_id' : ''} FROM projects WHERE id = ?${hasTenant && tenantId != null ? ' AND tenant_id = ?' : ''}`, ...(hasTenant && tenantId != null ? [id, tenantId] : [id])) as { id: number; name: string; tenant_id?: number | null } | undefined;
  if (!project) {
    throw withStatus(`Project ${id} not found`, 404);
  }
  return project;
}

export async function requireProjectWorkflowTypeScope(
  db: Db,
  input: { project_id?: unknown; workflow_id?: unknown; workflow_type?: unknown; tenant_id?: unknown },
): Promise<ProjectWorkflowTypeScope> {
  const workflowId = parseWorkflowId(input.workflow_id);
  const explicitWorkflowType = normalizeWorkflowTypeKey(input.workflow_type);
  const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;

  if (workflowId) {
    const project = await requireProject(db, input.project_id, tenantId);
    const workflow = await requireWorkflow(db, workflowId, tenantId);
    if (workflow.project_id !== project.id) {
      throw withStatus(`Workflow ${workflow.id} belongs to project ${workflow.project_id}, not project ${project.id}`, 400);
    }
    const workflowType = normalizeWorkflowTypeKey(workflow.workflow_type);
    if (!workflowType) {
      throw withStatus(`Workflow ${workflow.id} is missing workflow_type`, 400);
    }
    if (explicitWorkflowType && explicitWorkflowType !== workflowType) {
      throw withStatus(`Workflow ${workflow.id} uses workflow_type ${workflowType}, not ${explicitWorkflowType}`, 400);
    }
    return {
      projectId: project.id,
      workflowType,
      workflowId: workflow.id,
      tenantId,
      scopeLabel: workflow.name,
    };
  }

  if (!explicitWorkflowType) {
    throw withStatus('workflow_type is required when workflow_id is not provided', 400);
  }

  const workflowTypeRow = await db.get(`SELECT key FROM workflow_types WHERE key = ? LIMIT 1`, explicitWorkflowType) as { key?: string } | undefined;
  if (!workflowTypeRow) {
    throw withStatus(`Unknown workflow_type \"${explicitWorkflowType}\"`, 404);
  }

  if (input.project_id == null || input.project_id === '') {
    return {
      projectId: null,
      workflowType: explicitWorkflowType,
      workflowId: null,
      tenantId,
      scopeLabel: `All Projects / ${explicitWorkflowType}`,
    };
  }

  const project = await requireProject(db, input.project_id, tenantId);
  return {
    projectId: project.id,
    workflowType: explicitWorkflowType,
    workflowId: null,
    tenantId,
    scopeLabel: `${project.name} / ${explicitWorkflowType}`,
  };
}

export async function requireTransitionRequirementScope(
  db: Db,
  input: { project_id?: unknown; workflow_id?: unknown; workflow_type?: unknown; tenant_id?: unknown },
): Promise<ProjectWorkflowTypeScope> {
  const workflowId = parseWorkflowId(input.workflow_id);
  if (!workflowId || input.project_id != null) return await requireProjectWorkflowTypeScope(db, input);
  const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;
  const workflow = await requireWorkflow(db, workflowId, tenantId);
  return await requireProjectWorkflowTypeScope(db, { ...input, project_id: workflow.project_id, tenant_id: tenantId });
}

export async function tableHasRoutingRuleScopeColumns(db: Db): Promise<boolean> {
  return await tableHasColumn(db, 'workflow_task_routing_rules', 'workflow_type')
    && await tableHasColumn(db, 'workflow_task_routing_rules', 'project_id');
}

export async function detectDuplicateRoutingRule(
  db: Db,
  args: {
    projectId: number | null;
    workflowType: string;
    workflowId: number | null;
    taskType: string | null;
    status: string;
    agentId: number;
    priority: number;
    tenantId?: number | null;
    excludeId?: number;
  },
): Promise<{ id: number } | undefined> {
  if (await tableHasRoutingRuleScopeColumns(db)) {
    const tenant = await tenantPredicateFor(db, 'workflow_task_routing_rules', 'workflow_task_routing_rules', args.tenantId);
    const projectPredicate = args.projectId == null ? 'project_id IS NULL' : 'project_id = ?';
    const params: Array<number | string | null> = args.projectId == null
      ? [args.workflowType, args.workflowId, args.workflowId, args.taskType, args.taskType, args.status, args.agentId, args.priority]
      : [args.projectId, args.workflowType, args.workflowId, args.workflowId, args.taskType, args.taskType, args.status, args.agentId, args.priority];
    let sql = `
      SELECT id
      FROM workflow_task_routing_rules
      WHERE ${projectPredicate}
        AND workflow_type = ?
        AND ((workflow_id IS NULL AND ?::text IS NULL) OR workflow_id = ?)
        AND (task_type = ? OR (task_type IS NULL AND ?::text IS NULL))
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
    return await db.get(sql, ...params, ...tenant.params) as { id: number } | undefined;
  }

  if (args.workflowId == null) return undefined;
  const params: Array<number | string | null> = [args.workflowId, args.taskType, args.taskType, args.status, args.agentId, args.priority];
  let sql = `
    SELECT id
    FROM workflow_task_routing_rules
    WHERE workflow_id = ?
      AND (task_type = ? OR (task_type IS NULL AND ?::text IS NULL))
      AND status = ?
      AND agent_id = ?
      AND priority = ?
  `;
  const tenant = await tenantPredicateFor(db, 'workflow_task_routing_rules', 'workflow_task_routing_rules', args.tenantId);
  if (typeof args.excludeId === 'number' && Number.isFinite(args.excludeId)) {
    sql += ' AND id != ?';
    params.push(args.excludeId);
  }
  sql += tenant.sql;
  sql += ' ORDER BY id ASC LIMIT 1';
  return await db.get(sql, ...params, ...tenant.params) as { id: number } | undefined;
}

export function selectWorkflowScopedRoutingRuleRowSql(): string {
  return `
      SELECT trr.*, 'workflow_override' as rule_scope_kind, trr.agent_id as resolved_agent_id,
             s.name as workflow_name, s.project_id, p.name as project_name, s.workflow_type,
             a.job_title as job_title, a.name as agent_name
      FROM workflow_task_routing_rules trr
      LEFT JOIN workflows s ON s.id = trr.workflow_id
      LEFT JOIN projects p ON p.id = s.project_id
      LEFT JOIN agents a ON a.id = trr.agent_id
  `;
}

export async function selectScopedRoutingRuleRowSql(db: Db): Promise<string> {
  if (!await tableHasRoutingRuleScopeColumns(db)) return selectWorkflowScopedRoutingRuleRowSql();
  return `
      SELECT trr.*,
             CASE WHEN trr.workflow_id IS NULL THEN 'workflow_type_default' ELSE 'workflow_override' END as rule_scope_kind,
             trr.agent_id as resolved_agent_id,
             s.name as workflow_name,
             COALESCE(trr.project_id, s.project_id) as project_id,
             p.name as project_name,
             COALESCE(trr.workflow_type, s.workflow_type) as workflow_type,
             a.job_title as job_title, a.name as agent_name
      FROM workflow_task_routing_rules trr
      LEFT JOIN workflows s ON s.id = trr.workflow_id
      LEFT JOIN projects p ON p.id = COALESCE(trr.project_id, s.project_id)
      LEFT JOIN agents a ON a.id = trr.agent_id
  `;
}

export async function readRoutingRuleScopeRows(
  db: Db,
  scope: ProjectWorkflowTypeScope,
  options?: { scopeKind?: unknown },
): Promise<RoutingRuleRow[]> {
  const normalizedScopeKind = typeof options?.scopeKind === 'string' ? options.scopeKind.trim() : null;
  const defaultsOnly = normalizedScopeKind === 'defaults' || normalizedScopeKind === 'workflow_type_default';
  const overridesOnly = normalizedScopeKind === 'overrides' || normalizedScopeKind === 'workflow_override';

  if (await tableHasRoutingRuleScopeColumns(db)) {
    const tenant = await tenantPredicateFor(db, 'workflow_task_routing_rules', 'trr', scope.tenantId);
    const clauses = [
      'trr.workflow_type = ?',
    ];
    const params: Array<string | number | null> = [scope.workflowType];
    if (scope.projectId == null) {
      clauses.unshift('trr.project_id IS NULL');
    } else {
      clauses.unshift('trr.project_id = ?');
      params.unshift(scope.projectId);
    }

    if (defaultsOnly) {
      clauses.push('trr.workflow_id IS NULL');
    } else if (overridesOnly) {
      if (scope.workflowId == null) return [];
      clauses.push('trr.workflow_id = ?');
      params.push(scope.workflowId);
    } else {
      clauses.push('(trr.workflow_id IS NULL OR trr.workflow_id = ?)');
      params.push(scope.workflowId);
    }
    params.push(...tenant.params);

    return await db.all(`
      ${await selectScopedRoutingRuleRowSql(db)}
      WHERE ${clauses.join('\n        AND ')}
        ${tenant.sql}
      ORDER BY CASE WHEN trr.workflow_id = ? THEN 0 ELSE 1 END,
               trr.status ASC, trr.task_type ASC, trr.priority DESC, trr.id ASC
    `, ...params, scope.workflowId) as RoutingRuleRow[];
  }

  const workflowTenant = await tenantPredicateFor(db, 'workflows', 's', scope.tenantId);
  const rows = await db.all(`
    ${selectWorkflowScopedRoutingRuleRowSql()}
    WHERE s.project_id = ? AND s.workflow_type = ?
      ${workflowTenant.sql}
    ORDER BY CASE WHEN trr.workflow_id = ? THEN 0 ELSE 1 END,
             trr.status ASC, trr.task_type ASC, trr.priority DESC, trr.id ASC
  `, scope.projectId, scope.workflowType, ...workflowTenant.params, scope.workflowId ?? -1) as RoutingRuleRow[];

  return rows;
}

export function annotateRoutingRuleScope(
  rows: RoutingRuleRow[],
  selectedWorkflowId: number | null,
  options?: { scopeKind?: unknown },
): RoutingRuleRow[] {
  const normalizedScopeKind = typeof options?.scopeKind === 'string' ? options.scopeKind.trim() : null;
  const defaultsOnly = normalizedScopeKind === 'defaults' || normalizedScopeKind === 'workflow_type_default';
  // Only an ENABLED override supersedes the inherited default. Disabling an override means
  // that row is skipped and resolution falls through to the workflow-type default, which is
  // exactly what the resolvers do (`AND enabled = 1` inside the query that unions both
  // scopes). Counting disabled overrides here made the graph render a live default as
  // superseded — the canvas ghosting a rule the dispatcher was still executing.
  const overrideKeys = new Set<string>();
  if (selectedWorkflowId != null) {
    for (const row of rows) {
      if ((row.rule_scope_kind ?? row.scope_kind) === 'workflow_override' && isRowEnabled(row.enabled)) {
        overrideKeys.add(`${String(row.task_type ?? '')}::${String(row.status)}`);
      }
    }
  }

  return rows.map((row) => {
    const ruleScopeKind = (row.rule_scope_kind ?? row.scope_kind ?? 'workflow_override') as RoutingScopeKind;
    const isOverride = ruleScopeKind === 'workflow_override';
    const scopeKind = isOverride ? 'workflow_override' : 'workflow_type_default';
    const compositeKey = `${String(row.task_type ?? '')}::${String(row.status)}`;
    const overriddenByWorkflow = selectedWorkflowId != null && !isOverride && overrideKeys.has(compositeKey);
    return {
      ...row,
      scope_kind: scopeKind,
      is_inherited: !isOverride,
      is_override: isOverride,
      overridden_by_workflow: overriddenByWorkflow,
      effective_for_workflow: defaultsOnly ? !isOverride : (selectedWorkflowId == null ? true : isOverride || !overriddenByWorkflow),
    };
  });
}

export async function selectTransitionScopeRows(
  db: Db,
  scope: ProjectWorkflowTypeScope,
): Promise<Array<Record<string, unknown>>> {
  if (await tableHasTransitionScopeColumns(db)) {
    const tenant = await tenantPredicateFor(db, 'workflow_task_transitions', 'stt', scope.tenantId);
    const projectPredicate = scope.projectId == null
      ? 'COALESCE(stt.project_id, s.project_id) IS NULL'
      : 'COALESCE(stt.project_id, s.project_id) = ?';
    const filterParams: Array<string | number | null> = scope.projectId == null
      ? [scope.workflowType, scope.workflowId]
      : [scope.projectId, scope.workflowType, scope.workflowId];
    const rows = await db.all(`
      SELECT stt.id, stt.workflow_id, stt.project_id, stt.workflow_type, stt.task_type,
             stt.from_status, stt.outcome, stt.to_status, stt.enabled, stt.priority,
             stt.is_protected, stt.created_at, stt.updated_at,
             CASE WHEN stt.workflow_id IS NULL THEN 'workflow_type_default' ELSE 'workflow_override' END as rule_scope_kind,
             s.name as workflow_name,
             COALESCE(stt.project_id, s.project_id) as project_id,
             p.name as project_name,
             COALESCE(stt.workflow_type, s.workflow_type) as workflow_type
      FROM workflow_task_transitions stt
      LEFT JOIN workflows s ON s.id = stt.workflow_id
      LEFT JOIN projects p ON p.id = COALESCE(stt.project_id, s.project_id)
      WHERE ${projectPredicate}
        AND COALESCE(stt.workflow_type, s.workflow_type) = ?
        AND (stt.workflow_id IS NULL OR stt.workflow_id = ?)
        ${tenant.sql}
      ORDER BY CASE WHEN stt.workflow_id = ? THEN 0 ELSE 1 END,
               stt.from_status ASC, stt.outcome ASC, stt.task_type ASC, stt.priority DESC, stt.id ASC
    `, ...filterParams, ...tenant.params, scope.workflowId) as Array<Record<string, unknown>>;
    return rows;
  }

  if (scope.workflowId == null) return [];
  const tenant = await tenantPredicateFor(db, 'workflows', 's', scope.tenantId);
  return await db.all(`
    SELECT stt.id, stt.workflow_id, stt.task_type, stt.from_status, stt.outcome,
           stt.to_status, stt.enabled, stt.priority, stt.is_protected,
           stt.created_at, stt.updated_at, s.name as workflow_name, s.project_id, s.workflow_type
    FROM workflow_task_transitions stt
    INNER JOIN workflows s ON s.id = stt.workflow_id
    WHERE s.project_id = ?
      AND s.workflow_type = ?
      AND stt.workflow_id = ?
      ${tenant.sql}
    ORDER BY stt.priority DESC, stt.id ASC
  `, scope.projectId, scope.workflowType, scope.workflowId, ...tenant.params) as Array<Record<string, unknown>>;
}

export function annotateTransitionScope(
  rows: Array<Record<string, unknown>>,
  selectedWorkflowId: number | null,
): Array<Record<string, unknown>> {
  const overrideKeys = new Set<string>();
  if (selectedWorkflowId != null) {
    for (const row of rows) {
      if ((row.rule_scope_kind ?? row.scope_kind ?? 'workflow_override') === 'workflow_override') {
        overrideKeys.add(`${String(row.task_type ?? '')}::${String(row.from_status)}::${String(row.outcome)}`);
      }
    }
  }

  return rows.map((row) => {
    const rowWorkflowId = row.workflow_id == null ? null : Number(row.workflow_id);
    const ruleScopeKind = (row.rule_scope_kind ?? row.scope_kind ?? 'workflow_override') as RoutingScopeKind;
    const isOverride = ruleScopeKind === 'workflow_override' && selectedWorkflowId != null && rowWorkflowId === selectedWorkflowId;
    const scopeKind = ruleScopeKind === 'workflow_type_default' ? 'workflow_type_default' : 'workflow_override';
    const compositeKey = `${String(row.task_type ?? '')}::${String(row.from_status)}::${String(row.outcome)}`;
    const overriddenByWorkflow = selectedWorkflowId != null && scopeKind === 'workflow_type_default' && overrideKeys.has(compositeKey);
    return {
      ...row,
      scope_kind: scopeKind,
      is_inherited: scopeKind === 'workflow_type_default',
      is_override: isOverride,
      overridden_by_workflow: overriddenByWorkflow,
      effective_for_workflow: selectedWorkflowId == null ? true : isOverride || !overriddenByWorkflow,
    };
  });
}

export async function tableHasTransitionScopeColumns(db: Db): Promise<boolean> {
  return await tableHasColumn(db, 'workflow_task_transitions', 'project_id')
    && await tableHasColumn(db, 'workflow_task_transitions', 'workflow_type');
}

export async function tableHasRequirementScopeColumns(db: Db): Promise<boolean> {
  return await tableHasColumn(db, 'workflow_task_transition_requirements', 'project_id')
    && await tableHasColumn(db, 'workflow_task_transition_requirements', 'workflow_type');
}

export function requirementOverrideKey(row: TransitionRequirementRecord): string {
  return [
    String(row.task_type ?? ''),
    String(row.outcome ?? ''),
    String(row.field_name ?? ''),
    String(row.requirement_type ?? ''),
    String(row.match_field ?? ''),
    String(row.recurring_series_id ?? ''),
  ].join('::');
}

export async function selectRequirementScopeRows(
  db: Db,
  scope: ProjectWorkflowTypeScope,
): Promise<Array<TransitionRequirementRecord>> {
  if (!await tableHasRequirementScopeColumns(db)) {
    if (scope.workflowId == null) return [];
    const tenant = await tenantPredicateFor(db, 'workflows', 's', scope.tenantId);
    return await db.all(`
      SELECT req.*, s.name as workflow_name, s.project_id, s.workflow_type
      FROM workflow_task_transition_requirements req
      INNER JOIN workflows s ON s.id = req.workflow_id
      WHERE s.project_id = ?
        AND s.workflow_type = ?
        AND req.workflow_id = ?
        ${tenant.sql}
      ORDER BY outcome ASC,
               req.task_type IS NULL ASC,
               req.priority DESC,
               req.id ASC
    `, scope.projectId, scope.workflowType, scope.workflowId, ...tenant.params) as TransitionRequirementRecord[];
  }

  const params: unknown[] = scope.projectId == null ? [scope.workflowType] : [scope.projectId, scope.workflowType];
  let workflowPredicate = `req.workflow_id IS NULL`;
  if (scope.workflowId != null) {
    workflowPredicate = `(req.workflow_id = ? OR req.workflow_id IS NULL)`;
    params.unshift(scope.workflowId);
  }
  const projectPredicate = scope.projectId == null
    ? 'COALESCE(req.project_id, s.project_id) IS NULL'
    : 'COALESCE(req.project_id, s.project_id) = ?';
  const tenant = await tenantPredicateFor(db, 'workflow_task_transition_requirements', 'req', scope.tenantId);

  return await db.all(`
    SELECT req.*, s.name as workflow_name, COALESCE(req.project_id, s.project_id) AS project_id, COALESCE(req.workflow_type, s.workflow_type) AS workflow_type
    FROM workflow_task_transition_requirements req
    LEFT JOIN workflows s ON s.id = req.workflow_id
    WHERE ${workflowPredicate}
      AND ${projectPredicate}
      AND COALESCE(req.workflow_type, s.workflow_type) = ?
      ${tenant.sql}
    ORDER BY CASE WHEN req.workflow_id IS NULL THEN 1 ELSE 0 END,
             outcome ASC,
             req.task_type IS NULL ASC,
             req.priority DESC,
             req.id ASC
  `, ...params, ...tenant.params) as TransitionRequirementRecord[];
}

export function annotateRequirementScope(
  rows: TransitionRequirementRecord[],
  selectedWorkflowId: number | null,
): TransitionRequirementRecord[] {
  // Enabled overrides only, matching loadWorkflowTaskTransitionRequirements: it filters on
  // `enabled = 1` before deduping, so a disabled override drops out and the inherited
  // default still gates. Treating it as superseding here would ghost a live requirement.
  const overrideKeys = new Set(
    rows
      .filter((row) => selectedWorkflowId != null
        && row.workflow_id != null
        && Number(row.workflow_id) === selectedWorkflowId
        && isRowEnabled(row.enabled))
      .map(requirementOverrideKey),
  );
  return rows.map((row) => {
    const rowWorkflowId = row.workflow_id == null ? null : Number(row.workflow_id);
    const scopeKind = rowWorkflowId == null ? 'workflow_type_default' : 'workflow_override';
    const isOverride = selectedWorkflowId != null && rowWorkflowId === selectedWorkflowId;
    const overriddenByWorkflow = selectedWorkflowId != null && scopeKind === 'workflow_type_default' && overrideKeys.has(requirementOverrideKey(row));
    return {
      ...row,
      scope_kind: scopeKind,
      is_inherited: scopeKind === 'workflow_type_default',
      is_override: isOverride,
      overridden_by_workflow: overriddenByWorkflow,
      effective_for_workflow: selectedWorkflowId == null ? true : isOverride || !overriddenByWorkflow,
    };
  });
}

export async function requireScopedTransitionContext(
  db: Db,
  projectId: unknown,
  workflowIdRaw: unknown,
  workflowTypeRaw?: unknown,
  tenantIdRaw?: unknown,
): Promise<{ projectId: number | null; workflowType: string; workflowId: number | null; workflowName: string | null; tenantId: number | null }> {
  const tenantId = Number.isFinite(Number(tenantIdRaw)) ? Number(tenantIdRaw) : null;
  const scoped = await requireProjectWorkflowTypeScope(db, { project_id: projectId, workflow_id: workflowIdRaw, workflow_type: workflowTypeRaw, tenant_id: tenantId });
  const workflowId = parseWorkflowId(workflowIdRaw);
  if (!workflowId) {
    if (await tableHasTransitionScopeColumns(db)) {
      return { projectId: scoped.projectId, workflowType: scoped.workflowType, workflowId: null, workflowName: null, tenantId };
    }
    throw withStatus('workflow_id is required', 400);
  }
  const workflow = await requireWorkflow(db, scoped.workflowId, tenantId);
  return { projectId: scoped.projectId, workflowType: scoped.workflowType, workflowId: scoped.workflowId, workflowName: workflow.name, tenantId };
}

export async function readScopedRoutingTransition(db: Db, scope: ProjectWorkflowTypeScope, id: number) {
  if (await tableHasTransitionScopeColumns(db)) {
    const rows = await selectTransitionScopeRows(db, scope);
    return annotateTransitionScope(rows, scope.workflowId).find((row) => Number(row.id) === id);
  }
  if (scope.workflowId == null) return undefined;
  const workflow = await requireWorkflow(db, scope.workflowId, scope.tenantId);
  const projectName = (await db.get(`SELECT name FROM projects WHERE id = ?`, workflow.project_id) as { name?: string } | undefined)?.name ?? null;
  const row = await db.get(`
    SELECT *
    FROM workflow_task_transitions
    WHERE id = ? AND workflow_id = ?
      ${(await tenantPredicateFor(db, 'workflow_task_transitions', 'workflow_task_transitions', scope.tenantId)).sql}
  `, id, scope.workflowId, ...(await tenantPredicateFor(db, 'workflow_task_transitions', 'workflow_task_transitions', scope.tenantId)).params) as RoutingRuleRecord | undefined;
  return row ? { ...row, workflow_name: workflow.name, project_id: workflow.project_id, project_name: projectName, scope_kind: 'workflow_override', is_inherited: false, is_override: true, overridden_by_workflow: false, effective_for_workflow: true } : undefined;
}

export async function resolveRoutingRuleTarget(
  db: Db,
  input: { job_id?: unknown; agent_id?: unknown; tenant_id?: unknown },
): Promise<{ agent_id: number }> {
  const agentId = input.agent_id != null ? Number(input.agent_id) : null;
  const jobId = input.job_id != null ? Number(input.job_id) : null;
  const tenantId = Number.isFinite(Number(input.tenant_id)) ? Number(input.tenant_id) : null;
  const tenant = await tenantPredicateFor(db, 'agents', 'agents', tenantId);

  if (agentId != null && Number.isFinite(agentId)) {
    const agent = await db.get(`SELECT id FROM agents WHERE id = ?${tenant.sql}`, agentId, ...tenant.params);
    if (!agent) {
      throw withStatus(`Agent ${agentId} not found`, 404);
    }
    return { agent_id: agentId };
  }

  if (jobId != null && Number.isFinite(jobId)) {
    const agent = await db.get(`SELECT id FROM agents WHERE id = ?${tenant.sql}`, jobId, ...tenant.params);
    if (!agent) {
      throw withStatus(`Agent ${jobId} not found`, 404);
    }
    return { agent_id: jobId };
  }

  throw withStatus('agent_id is required', 400);
}
