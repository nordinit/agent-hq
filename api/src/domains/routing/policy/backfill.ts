import { normalizeWorkflowType, starterWorkflowType, tableExists } from './metadata';
import { type Db } from "../../../db/adapter/types";
import { tableExists as sharedTableExists, columnExists as sharedColumnExists, tableColumns as sharedTableColumns, indexExists as sharedIndexExists } from "../../../db/introspection";

async function tableHasColumn(db: Db, tableName: string, columnName: string): Promise<boolean> {
    return await sharedColumnExists(db, tableName, columnName);
}

export async function resolvedOutcomeKeysForWorkflow(
  db: Db,
  workflowType: string | null | undefined,
  taskType: string | null,
): Promise<Set<string> | null> {
  if (!await tableExists(db, 'workflow_type_outcomes')) return null;
  const normalizedWorkflowType = normalizeWorkflowType(workflowType);
  if (!starterWorkflowType(normalizedWorkflowType)) return null;

  const rows = await db.all(`
    SELECT task_type, outcome_key, enabled, behavior
    FROM workflow_type_outcomes
    WHERE workflow_type_key = ?
  `, normalizedWorkflowType) as Array<{
    task_type: string | null;
    outcome_key: string;
    enabled: number;
    behavior: string;
  }>;
  if (rows.length === 0) return null;

  const baseRows = rows.filter((row) => row.task_type == null);
  const taskRows = taskType ? rows.filter((row) => row.task_type === taskType) : [];
  const keys = new Set<string>();
  for (const row of baseRows) {
    if (row.enabled === 1 && row.behavior !== 'disable') keys.add(row.outcome_key);
  }
  const hasOverride = taskRows.some((row) => row.enabled === 1 && row.behavior === 'override');
  const resolved = hasOverride ? new Set<string>() : new Set(keys);
  for (const row of taskRows) {
    if (row.enabled !== 1 || row.behavior === 'disable') {
      resolved.delete(row.outcome_key);
    } else {
      resolved.add(row.outcome_key);
    }
  }
  return resolved;
}

export async function normalizeWorkflowTaskPolicyOutcomeRows(db: Db): Promise<void> {
  if (!await tableExists(db, 'workflows') || !await tableExists(db, 'workflow_type_outcomes')) return;

  const workflows = await db.all(`
    SELECT id, workflow_type
    FROM workflows
    ORDER BY id ASC
  `) as Array<{ id: number; workflow_type: string | null }>;
  const workflowTypes = new Map(workflows.map((workflow) => [workflow.id, workflow.workflow_type]));

  await db.withTransaction(async (db) => {
    if (await tableExists(db, 'workflow_task_transitions')) {
      const rows = await db.all(`
        SELECT id, workflow_id, task_type, outcome
        FROM workflow_task_transitions
        ORDER BY id ASC
      `) as Array<{ id: number; workflow_id: number; task_type: string | null; outcome: string }>;
      for (const row of rows) {
        const allowed = await resolvedOutcomeKeysForWorkflow(db, workflowTypes.get(row.workflow_id), row.task_type ?? null);
        if (!allowed || allowed.has(row.outcome)) continue;
        await db.run(`DELETE FROM workflow_task_transitions WHERE id = ?`, row.id);
      }
    }

    if (await tableExists(db, 'workflow_task_transition_requirements')) {
      const rows = await db.all(`
        SELECT id, workflow_id, task_type, outcome
        FROM workflow_task_transition_requirements
        ORDER BY id ASC
      `) as Array<{ id: number; workflow_id: number; task_type: string | null; outcome: string }>;
      for (const row of rows) {
        const allowed = await resolvedOutcomeKeysForWorkflow(db, workflowTypes.get(row.workflow_id), row.task_type ?? null);
        if (!allowed || allowed.has(row.outcome)) continue;
        await db.run(`DELETE FROM workflow_task_transition_requirements WHERE id = ?`, row.id);
      }
    }
  });
}

export async function normalizeWorkflowTaskRoutingRuleTaskTypes(db: Db): Promise<void> {
  if (!await tableExists(db, 'workflow_task_routing_rules') || !await tableExists(db, 'workflow_type_task_types')) return;
  if (!await tableExists(db, 'workflows')) return;

  const hasWorkflowRuleScope = await tableHasColumn(db, 'workflow_task_routing_rules', 'workflow_id');
  const hasWorkflowTypeRuleScope = await tableHasColumn(db, 'workflow_task_routing_rules', 'workflow_type');
  const hasWorkflowTypeTaskType = await tableHasColumn(db, 'workflow_type_task_types', 'workflow_type_key')
    && await tableHasColumn(db, 'workflow_type_task_types', 'task_type');
  if (!hasWorkflowRuleScope || !hasWorkflowTypeTaskType) return;

  const deleteStrandedWorkflowRulesSql = `
    DELETE FROM workflow_task_routing_rules
    WHERE workflow_id IS NOT NULL
      AND task_type IS NOT NULL
      AND TRIM(task_type) != ''
      AND EXISTS (
        SELECT 1
        FROM workflows sp
        WHERE sp.id = workflow_task_routing_rules.workflow_id
      )
      AND EXISTS (
        SELECT 1
        FROM workflow_type_task_types allowed
        JOIN workflows sp ON sp.id = workflow_task_routing_rules.workflow_id
        WHERE allowed.workflow_type_key = sp.workflow_type
      )
      AND NOT EXISTS (
        SELECT 1
        FROM workflow_type_task_types allowed
        JOIN workflows sp ON sp.id = workflow_task_routing_rules.workflow_id
        WHERE allowed.workflow_type_key = sp.workflow_type
          AND allowed.task_type = workflow_task_routing_rules.task_type
      )
  `;

  await db.withTransaction(async (db) => {
    const workflowResult = await db.run(deleteStrandedWorkflowRulesSql);
    let workflowTypeDefaultChanges = 0;
    if (hasWorkflowTypeRuleScope) {
      const result = await db.run(`
        DELETE FROM workflow_task_routing_rules
        WHERE workflow_id IS NULL
          AND workflow_type IS NOT NULL
          AND task_type IS NOT NULL
          AND TRIM(task_type) != ''
          AND EXISTS (
            SELECT 1
            FROM workflow_type_task_types allowed
            WHERE allowed.workflow_type_key = workflow_task_routing_rules.workflow_type
          )
          AND NOT EXISTS (
            SELECT 1
            FROM workflow_type_task_types allowed
            WHERE allowed.workflow_type_key = workflow_task_routing_rules.workflow_type
              AND allowed.task_type = workflow_task_routing_rules.task_type
          )
      `);
      workflowTypeDefaultChanges = result.changes;
    }

    const total = workflowResult.changes + workflowTypeDefaultChanges;
    if (total > 0) {
      console.log(`[schema] Removed ${total} workflow_task_routing_rules row(s) with task_type outside workflow type definitions`);
    }
  });
}

export function backfillAllWorkflowTaskPolicies(db: Db): void {
  void db;
  // Intentionally disabled: broad runtime backfills must not re-apply default
  // workflow policy to existing workflows. Use explicit bootstrap/new-workflow
  // setup or a targeted migration instead.
}

export function backfillAllWorkflowTypeTaskStatuses(db: Db): void {
  void db;
  // Intentionally disabled: broad runtime backfills must not re-apply default
  // status policy to existing workflow definitions. Use explicit bootstrap,
  // new-tenant setup, or a targeted migration instead.
}
