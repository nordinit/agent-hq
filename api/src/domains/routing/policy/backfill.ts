import { normalizeWorkflowType, starterWorkflowType, tableExists } from './metadata';
import { type Db } from "../../../db/adapter/types";

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
