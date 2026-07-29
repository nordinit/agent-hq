import { normalizeSprintType, starterSprintType, tableExists } from './metadata';
import { type Db } from "../../../db/adapter/types";

async function tableHasColumn(db: Db, tableName: string, columnName: string): Promise<boolean> {
  return (await db.all(`PRAGMA table_info(${tableName})`) as Array<{ name: string }>)
    .some((column) => column.name === columnName);
}

export async function resolvedOutcomeKeysForSprint(
  db: Db,
  sprintType: string | null | undefined,
  taskType: string | null,
): Promise<Set<string> | null> {
  if (!await tableExists(db, 'sprint_type_outcomes')) return null;
  const normalizedSprintType = normalizeSprintType(sprintType);
  if (!starterSprintType(normalizedSprintType)) return null;

  const rows = await db.all(`
    SELECT task_type, outcome_key, enabled, behavior
    FROM sprint_type_outcomes
    WHERE sprint_type_key = ?
  `, normalizedSprintType) as Array<{
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

export async function normalizeSprintTaskPolicyOutcomeRows(db: Db): Promise<void> {
  if (!await tableExists(db, 'sprints') || !await tableExists(db, 'sprint_type_outcomes')) return;

  const sprints = await db.all(`
    SELECT id, sprint_type
    FROM sprints
    ORDER BY id ASC
  `) as Array<{ id: number; sprint_type: string | null }>;
  const sprintTypes = new Map(sprints.map((sprint) => [sprint.id, sprint.sprint_type]));

  const tx = db.transaction(async () => {
    if (await tableExists(db, 'sprint_task_transitions')) {
      const rows = await db.all(`
        SELECT id, sprint_id, task_type, outcome
        FROM sprint_task_transitions
        ORDER BY id ASC
      `) as Array<{ id: number; sprint_id: number; task_type: string | null; outcome: string }>;
      const deleteRow = db.prepare(`DELETE FROM sprint_task_transitions WHERE id = ?`);
      for (const row of rows) {
        const allowed = await resolvedOutcomeKeysForSprint(db, sprintTypes.get(row.sprint_id), row.task_type ?? null);
        if (!allowed || allowed.has(row.outcome)) continue;
        deleteRow.run(row.id);
      }
    }

    if (await tableExists(db, 'sprint_task_transition_requirements')) {
      const rows = await db.all(`
        SELECT id, sprint_id, task_type, outcome
        FROM sprint_task_transition_requirements
        ORDER BY id ASC
      `) as Array<{ id: number; sprint_id: number; task_type: string | null; outcome: string }>;
      const deleteRow = db.prepare(`DELETE FROM sprint_task_transition_requirements WHERE id = ?`);
      for (const row of rows) {
        const allowed = await resolvedOutcomeKeysForSprint(db, sprintTypes.get(row.sprint_id), row.task_type ?? null);
        if (!allowed || allowed.has(row.outcome)) continue;
        deleteRow.run(row.id);
      }
    }
  });

  tx();
}

export async function normalizeSprintTaskRoutingRuleTaskTypes(db: Db): Promise<void> {
  if (!await tableExists(db, 'sprint_task_routing_rules') || !await tableExists(db, 'sprint_type_task_types')) return;
  if (!await tableExists(db, 'sprints')) return;

  const hasSprintRuleScope = await tableHasColumn(db, 'sprint_task_routing_rules', 'sprint_id');
  const hasSprintTypeRuleScope = await tableHasColumn(db, 'sprint_task_routing_rules', 'sprint_type');
  const hasSprintTypeTaskType = await tableHasColumn(db, 'sprint_type_task_types', 'sprint_type_key')
    && await tableHasColumn(db, 'sprint_type_task_types', 'task_type');
  if (!hasSprintRuleScope || !hasSprintTypeTaskType) return;

  const deleteStrandedSprintRules = db.prepare(`
    DELETE FROM sprint_task_routing_rules
    WHERE sprint_id IS NOT NULL
      AND task_type IS NOT NULL
      AND TRIM(task_type) != ''
      AND EXISTS (
        SELECT 1
        FROM sprints sp
        WHERE sp.id = sprint_task_routing_rules.sprint_id
      )
      AND EXISTS (
        SELECT 1
        FROM sprint_type_task_types allowed
        JOIN sprints sp ON sp.id = sprint_task_routing_rules.sprint_id
        WHERE allowed.sprint_type_key = sp.sprint_type
      )
      AND NOT EXISTS (
        SELECT 1
        FROM sprint_type_task_types allowed
        JOIN sprints sp ON sp.id = sprint_task_routing_rules.sprint_id
        WHERE allowed.sprint_type_key = sp.sprint_type
          AND allowed.task_type = sprint_task_routing_rules.task_type
      )
  `);

  const tx = db.transaction(async () => {
    const sprintResult = deleteStrandedSprintRules.run();
    let sprintTypeDefaultChanges = 0;
    if (hasSprintTypeRuleScope) {
      const result = await db.run(`
        DELETE FROM sprint_task_routing_rules
        WHERE sprint_id IS NULL
          AND sprint_type IS NOT NULL
          AND task_type IS NOT NULL
          AND TRIM(task_type) != ''
          AND EXISTS (
            SELECT 1
            FROM sprint_type_task_types allowed
            WHERE allowed.sprint_type_key = sprint_task_routing_rules.sprint_type
          )
          AND NOT EXISTS (
            SELECT 1
            FROM sprint_type_task_types allowed
            WHERE allowed.sprint_type_key = sprint_task_routing_rules.sprint_type
              AND allowed.task_type = sprint_task_routing_rules.task_type
          )
      `);
      sprintTypeDefaultChanges = result.changes;
    }

    const total = sprintResult.changes + sprintTypeDefaultChanges;
    if (total > 0) {
      console.log(`[schema] Removed ${total} sprint_task_routing_rules row(s) with task_type outside sprint type definitions`);
    }
  });
  tx();
}

export function backfillAllSprintTaskPolicies(db: Db): void {
  void db;
  // Intentionally disabled: broad runtime backfills must not re-apply default
  // sprint policy to existing workflows. Use explicit bootstrap/new-sprint
  // setup or a targeted migration instead.
}

export function backfillAllSprintTypeTaskStatuses(db: Db): void {
  void db;
  // Intentionally disabled: broad runtime backfills must not re-apply default
  // status policy to existing workflow definitions. Use explicit bootstrap,
  // new-tenant setup, or a targeted migration instead.
}
