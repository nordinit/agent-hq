import type Database from 'better-sqlite3';
import { normalizeSprintType, starterSprintType, tableExists } from './metadata';

function tableHasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>)
    .some((column) => column.name === columnName);
}

export function resolvedOutcomeKeysForSprint(
  db: Database.Database,
  sprintType: string | null | undefined,
  taskType: string | null,
): Set<string> | null {
  if (!tableExists(db, 'sprint_type_outcomes')) return null;
  const normalizedSprintType = normalizeSprintType(sprintType);
  if (!starterSprintType(normalizedSprintType)) return null;

  const rows = db.prepare(`
    SELECT task_type, outcome_key, enabled, behavior
    FROM sprint_type_outcomes
    WHERE sprint_type_key = ?
  `).all(normalizedSprintType) as Array<{
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

export function normalizeSprintTaskPolicyOutcomeRows(db: Database.Database): void {
  if (!tableExists(db, 'sprints') || !tableExists(db, 'sprint_type_outcomes')) return;

  const sprints = db.prepare(`
    SELECT id, sprint_type
    FROM sprints
    ORDER BY id ASC
  `).all() as Array<{ id: number; sprint_type: string | null }>;
  const sprintTypes = new Map(sprints.map((sprint) => [sprint.id, sprint.sprint_type]));

  const tx = db.transaction(() => {
    if (tableExists(db, 'sprint_task_transitions')) {
      const rows = db.prepare(`
        SELECT id, sprint_id, task_type, outcome
        FROM sprint_task_transitions
        ORDER BY id ASC
      `).all() as Array<{ id: number; sprint_id: number; task_type: string | null; outcome: string }>;
      const deleteRow = db.prepare(`DELETE FROM sprint_task_transitions WHERE id = ?`);
      for (const row of rows) {
        const allowed = resolvedOutcomeKeysForSprint(db, sprintTypes.get(row.sprint_id), row.task_type ?? null);
        if (!allowed || allowed.has(row.outcome)) continue;
        deleteRow.run(row.id);
      }
    }

    if (tableExists(db, 'sprint_task_transition_requirements')) {
      const rows = db.prepare(`
        SELECT id, sprint_id, task_type, outcome
        FROM sprint_task_transition_requirements
        ORDER BY id ASC
      `).all() as Array<{ id: number; sprint_id: number; task_type: string | null; outcome: string }>;
      const deleteRow = db.prepare(`DELETE FROM sprint_task_transition_requirements WHERE id = ?`);
      for (const row of rows) {
        const allowed = resolvedOutcomeKeysForSprint(db, sprintTypes.get(row.sprint_id), row.task_type ?? null);
        if (!allowed || allowed.has(row.outcome)) continue;
        deleteRow.run(row.id);
      }
    }
  });

  tx();
}

export function normalizeSprintTaskRoutingRuleTaskTypes(db: Database.Database): void {
  if (!tableExists(db, 'sprint_task_routing_rules') || !tableExists(db, 'sprint_type_task_types')) return;
  if (!tableExists(db, 'sprints')) return;

  const hasSprintRuleScope = tableHasColumn(db, 'sprint_task_routing_rules', 'sprint_id');
  const hasSprintTypeRuleScope = tableHasColumn(db, 'sprint_task_routing_rules', 'sprint_type');
  const hasSprintTypeTaskType = tableHasColumn(db, 'sprint_type_task_types', 'sprint_type_key')
    && tableHasColumn(db, 'sprint_type_task_types', 'task_type');
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

  const tx = db.transaction(() => {
    const sprintResult = deleteStrandedSprintRules.run();
    let sprintTypeDefaultChanges = 0;
    if (hasSprintTypeRuleScope) {
      const result = db.prepare(`
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
      `).run();
      sprintTypeDefaultChanges = result.changes;
    }

    const total = sprintResult.changes + sprintTypeDefaultChanges;
    if (total > 0) {
      console.log(`[schema] Removed ${total} sprint_task_routing_rules row(s) with task_type outside sprint type definitions`);
    }
  });
  tx();
}

export function backfillAllSprintTaskPolicies(db: Database.Database): void {
  void db;
  // Intentionally disabled: broad runtime backfills must not re-apply default
  // sprint policy to existing workflows. Use explicit bootstrap/new-sprint
  // setup or a targeted migration instead.
}

export function backfillAllSprintTypeTaskStatuses(db: Database.Database): void {
  void db;
  // Intentionally disabled: broad runtime backfills must not re-apply default
  // status policy to existing workflow definitions. Use explicit bootstrap,
  // new-tenant setup, or a targeted migration instead.
}
