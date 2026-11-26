import { type Db } from '../../db/adapter/types';
import { tableColumns } from '../../db/introspection';
import { tableExists, tableHasColumn } from '../routing/policy/metadata';

/**
 * Tables that define a workflow type, keyed by `workflow_type_key`. Copying a type copies all of
 * them, so a workflow moved onto the copy keeps the same statuses, task types, outcomes,
 * relationship types and task fields.
 */
const TYPE_DEFINITION_TABLES = [
  'workflow_type_task_types',
  'workflow_type_task_statuses',
  'workflow_type_outcomes',
  'workflow_type_relationship_types',
  'task_field_schemas',
] as const;

/**
 * Routing rows that apply to every workflow of a type (`workflow_id IS NULL`), keyed by
 * `workflow_type`. Their per-workflow rows are moved, not copied, when a workflow changes type.
 */
const TYPE_DEFAULT_ROUTING_TABLES = [
  'workflow_task_transitions',
  'workflow_task_routing_rules',
  'workflow_task_transition_requirements',
  'external_event_mappings',
] as const;

const NEVER_COPIED = new Set(['id', 'created_at', 'updated_at']);

async function columnsOf(db: Db, table: string): Promise<string[]> {
  return [...new Set(await tableColumns(db, table))];
}

async function copyRows(
  db: Db,
  table: string,
  whereSql: string,
  params: unknown[],
  overrides: Record<string, unknown>,
): Promise<number> {
  if (!await tableExists(db, table)) return 0;
  const columns = (await columnsOf(db, table)).filter((column) => !NEVER_COPIED.has(column));
  const rows = await db.all(`SELECT * FROM ${table} WHERE ${whereSql} ORDER BY id ASC`, ...params) as Array<Record<string, unknown>>;
  if (rows.length === 0) return 0;
  const insertSql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  for (const row of rows) {
    await db.run(insertSql, ...columns.map((column) => (column in overrides ? overrides[column] : row[column] ?? null)));
  }
  return rows.length;
}

export interface WorkflowTypeCopyResult {
  source: string;
  key: string;
  copied: Record<string, number>;
}

/**
 * Copies a workflow type's definition onto a new type that already has its `workflow_types` row.
 * Runs inside the caller's transaction. With `projectId` (a type made for one project), type-wide
 * routing is copied only for that project and for all projects. The copy belongs to the tenant (`is_system = 0`), so
 * starter-type maintenance never prunes or rewrites it.
 */
export async function copyWorkflowTypeDefinition(
  db: Db,
  input: { tenantId: number; sourceKey: string; targetKey: string; projectId?: number | null },
): Promise<WorkflowTypeCopyResult> {
  const copied: Record<string, number> = {};
  for (const table of TYPE_DEFINITION_TABLES) {
    const hasSystem = await tableExists(db, table) && await tableHasColumn(db, table, 'is_system');
    copied[table] = await copyRows(
      db,
      table,
      'tenant_id = ? AND workflow_type_key = ?',
      [input.tenantId, input.sourceKey],
      { workflow_type_key: input.targetKey, tenant_id: input.tenantId, ...(hasSystem ? { is_system: 0 } : {}) },
    );
  }
  for (const table of TYPE_DEFAULT_ROUTING_TABLES) {
    if (!await tableExists(db, table)
      || !await tableHasColumn(db, table, 'workflow_type')
      || !await tableHasColumn(db, table, 'workflow_id')) continue;
    const hasTenant = await tableHasColumn(db, table, 'tenant_id');
    // A type made for one project takes only that project's type-wide routing (and rows that
    // apply to every project); other projects' rows could never apply to its workflows.
    const projectScoped = input.projectId != null && await tableHasColumn(db, table, 'project_id');
    copied[table] = await copyRows(
      db,
      table,
      `workflow_id IS NULL AND workflow_type = ?${hasTenant ? ' AND tenant_id = ?' : ''}${projectScoped ? ' AND (project_id = ? OR project_id IS NULL)' : ''}`,
      [input.sourceKey, ...(hasTenant ? [input.tenantId] : []), ...(projectScoped ? [input.projectId] : [])],
      { workflow_type: input.targetKey },
    );
  }
  return { source: input.sourceKey, key: input.targetKey, copied };
}

/** The `workflow_types` columns a copy takes from its source (everything but identity and naming). */
export async function copiedWorkflowTypeColumns(db: Db, sourceRow: Record<string, unknown>): Promise<Record<string, unknown>> {
  const columns = await columnsOf(db, 'workflow_types');
  const skip = new Set(['id', 'key', 'name', 'description', 'is_system', 'status_seeded_at', 'created_at', 'updated_at', 'tenant_id', 'project_id']);
  return Object.fromEntries(columns.filter((column) => !skip.has(column)).map((column) => [column, sourceRow[column] ?? null]));
}
