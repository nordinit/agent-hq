import { type Db } from '../../db/adapter/types';
import { tableExists, tableHasColumn } from '../routing/policy/metadata';
import { listWorkflowTypeTaskStatuses } from '../routing/policy/statuses';

/**
 * Routing rows that belong to one workflow. Each stores the workflow's type next to its
 * workflow_id, and routing only matches rows whose type is the workflow's current type, so they
 * must move with the workflow or they silently stop applying.
 */
const WORKFLOW_SCOPED_TYPE_TABLES = [
  'workflow_task_transitions',
  'workflow_task_routing_rules',
  'workflow_task_transition_requirements',
  'external_event_mappings',
  'story_point_model_routing',
] as const;

const INHERITED_ROUTING_TABLES = [
  'workflow_task_transitions',
  'workflow_task_routing_rules',
  'workflow_task_transition_requirements',
] as const;

async function scoped(db: Db, table: string): Promise<boolean> {
  return await tableExists(db, table)
    && await tableHasColumn(db, table, 'workflow_id')
    && await tableHasColumn(db, table, 'workflow_type');
}

async function distinctValues(db: Db, sql: string, ...params: unknown[]): Promise<string[]> {
  const rows = await db.all(sql, ...params) as Array<{ value: unknown }>;
  return rows.map((row) => row.value).filter((value): value is string => typeof value === 'string' && value.length > 0);
}

export class WorkflowTypeChangeError extends Error {
  status = 409;
  body: Record<string, unknown>;
  constructor(message: string, body: Record<string, unknown>) {
    super(message);
    this.body = { error: message, ...body };
  }
}

/**
 * Checks that a workflow can move from one type to another without losing anything: every status
 * and task type its tasks and its own routing use must exist on the target type, it must not
 * depend on type-wide routing the target lacks, and none of its rules may come from a team
 * (team rules are matched by type). Throws WorkflowTypeChangeError otherwise.
 */
export async function assertWorkflowTypeChangeIsSafe(
  db: Db,
  input: { workflowId: number; projectId: number; fromType: string; toType: string; tenantId: number | null },
): Promise<void> {
  const { workflowId, projectId, fromType, toType, tenantId } = input;
  const targetStatuses = new Set((await listWorkflowTypeTaskStatuses(db, toType, { tenantId })).map((status) => status.name));
  const targetTaskTypes = new Set(await distinctValues(
    db,
    `SELECT task_type AS value FROM workflow_type_task_types WHERE workflow_type_key = ?${tenantId != null ? ' AND tenant_id = ?' : ''}`,
    toType, ...(tenantId != null ? [tenantId] : []),
  ));

  const usedStatuses = new Set<string>(await distinctValues(db, `SELECT DISTINCT status AS value FROM tasks WHERE workflow_id = ?`, workflowId));
  const usedTaskTypes = new Set<string>(await distinctValues(db, `SELECT DISTINCT task_type AS value FROM tasks WHERE workflow_id = ?`, workflowId));
  if (await scoped(db, 'workflow_task_transitions')) {
    for (const value of await distinctValues(db, `SELECT from_status AS value FROM workflow_task_transitions WHERE workflow_id = ? UNION SELECT to_status FROM workflow_task_transitions WHERE workflow_id = ?`, workflowId, workflowId)) usedStatuses.add(value);
    for (const value of await distinctValues(db, `SELECT DISTINCT task_type AS value FROM workflow_task_transitions WHERE workflow_id = ?`, workflowId)) usedTaskTypes.add(value);
  }
  if (await scoped(db, 'workflow_task_routing_rules')) {
    for (const value of await distinctValues(db, `SELECT DISTINCT status AS value FROM workflow_task_routing_rules WHERE workflow_id = ?`, workflowId)) usedStatuses.add(value);
    for (const value of await distinctValues(db, `SELECT DISTINCT task_type AS value FROM workflow_task_routing_rules WHERE workflow_id = ?`, workflowId)) usedTaskTypes.add(value);
  }
  if (await scoped(db, 'workflow_task_transition_requirements')) {
    for (const value of await distinctValues(db, `SELECT DISTINCT task_type AS value FROM workflow_task_transition_requirements WHERE workflow_id = ?`, workflowId)) usedTaskTypes.add(value);
  }

  const missingStatuses = [...usedStatuses].filter((status) => !targetStatuses.has(status)).sort();
  const missingTaskTypes = [...usedTaskTypes].filter((taskType) => !targetTaskTypes.has(taskType)).sort();

  // Type-wide rows (workflow_id IS NULL) this workflow currently inherits stay with the old type.
  const inheritedLost: Record<string, number> = {};
  for (const table of INHERITED_ROUTING_TABLES) {
    if (!await scoped(db, table) || !await tableHasColumn(db, table, 'project_id')) continue;
    const tenantSql = tenantId != null && await tableHasColumn(db, table, 'tenant_id') ? ' AND tenant_id = ?' : '';
    const count = async (type: string) => Number((await db.get(
      `SELECT COUNT(*) AS n FROM ${table} WHERE workflow_id IS NULL AND workflow_type = ? AND (project_id = ? OR project_id IS NULL)${tenantSql}`,
      type, projectId, ...(tenantSql ? [tenantId] : []),
    ) as { n: number | string }).n);
    const fromCount = await count(fromType);
    if (fromCount > 0 && await count(toType) < fromCount) inheritedLost[table] = fromCount;
  }

  let teamRules = 0;
  if (await scoped(db, 'workflow_task_routing_rules') && await tableHasColumn(db, 'workflow_task_routing_rules', 'source_team_rule_id')) {
    teamRules = Number((await db.get(
      `SELECT COUNT(*) AS n FROM workflow_task_routing_rules WHERE workflow_id = ? AND source_team_rule_id IS NOT NULL`,
      workflowId,
    ) as { n: number | string }).n);
  }

  if (missingStatuses.length || missingTaskTypes.length || Object.keys(inheritedLost).length || teamRules) {
    const reasons = [
      missingStatuses.length ? `statuses ${missingStatuses.join(', ')} are not on "${toType}"` : null,
      missingTaskTypes.length ? `task types ${missingTaskTypes.join(', ')} are not on "${toType}"` : null,
      Object.keys(inheritedLost).length ? `it uses type-wide routing of "${fromType}" that "${toType}" does not have` : null,
      teamRules ? `${teamRules} of its assignment rules come from a team, and team rules are matched by type` : null,
    ].filter(Boolean);
    throw new WorkflowTypeChangeError(
      `Workflow ${workflowId} cannot change from "${fromType}" to "${toType}": ${reasons.join('; ')}.`,
      {
        code: 'workflow_type_change_unsafe',
        workflow_id: workflowId,
        from_type: fromType,
        to_type: toType,
        missing_statuses: missingStatuses,
        missing_task_types: missingTaskTypes,
        inherited_routing: inheritedLost,
        team_rules: teamRules,
      },
    );
  }
}

/** Moves the workflow's own routing rows onto its new type. Run in the same transaction as the type change. */
export async function moveWorkflowScopedRowsToType(db: Db, workflowId: number, toType: string): Promise<Record<string, number>> {
  const moved: Record<string, number> = {};
  for (const table of WORKFLOW_SCOPED_TYPE_TABLES) {
    if (!await scoped(db, table)) continue;
    const result = await db.run(`UPDATE ${table} SET workflow_type = ? WHERE workflow_id = ?`, toType, workflowId);
    moved[table] = result.changes;
  }
  return moved;
}
