import { STARTER_BACKLOG_SPRINT_NAME } from './starterCatalog';
import { seedSprintTaskPolicy } from '../domains/routing/policy/seed';
import { type Db } from "../db/adapter/types";
import { tableExists as sharedTableExists, columnExists as sharedColumnExists, tableColumns as sharedTableColumns, indexExists as sharedIndexExists } from "../db/introspection";

type SprintRow = {
  id: number;
  project_id: number;
  sprint_type: string | null;
};

async function tableHasColumn(db: Db, tableName: string, columnName: string): Promise<boolean> {
    return await sharedColumnExists(db, tableName, columnName);
}

async function loadSprintRow(db: Db, sprintId: number): Promise<SprintRow | null> {
  return await db.get(`
    SELECT id, project_id, sprint_type
    FROM sprints
    WHERE id = ?
    LIMIT 1
  `, sprintId) as SprintRow | undefined ?? null;
}

export async function ensureProjectBacklogSprint(db: Db, projectId: number): Promise<number> {
  const project = await db.get(`SELECT tenant_id FROM projects WHERE id = ?`, projectId) as { tenant_id: number | null } | undefined;
  const tenantSprintType = project?.tenant_id != null
    ? (await db.get(`
      SELECT key
      FROM sprint_types
      WHERE tenant_id = ? AND (key = 'generic' OR key LIKE ?)
      ORDER BY CASE WHEN key = 'generic' THEN 0 ELSE 1 END, key ASC
      LIMIT 1
    `, project.tenant_id, '%__generic') as { key: string } | undefined)?.key ?? 'generic'
    : 'generic';
  const existing = await db.get(`
    SELECT id
    FROM sprints
    WHERE project_id = ?
      AND (lower(name) = lower(?) OR sprint_type = ?)
    ORDER BY CASE WHEN lower(name) = lower(?) THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `, projectId, STARTER_BACKLOG_SPRINT_NAME, tenantSprintType, STARTER_BACKLOG_SPRINT_NAME) as { id: number } | undefined;
  if (existing) return existing.id;

  const result = await db.run(`
    INSERT INTO sprints (tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value)
    VALUES (?, ?, ?, '', ?, 'active', 'time', 'ongoing')
  `, project?.tenant_id ?? null, projectId, STARTER_BACKLOG_SPRINT_NAME, tenantSprintType);

  const sprintId = Number(result.lastInsertId);
  // Statuses and transitions come from the workflow definition. Routing rules do
  // NOT get inferred here — a workflow with no declared rules correctly has none.
  await seedSprintTaskPolicy(db, sprintId);
  return sprintId;
}

export async function resolveDefaultProjectSprintId(db: Db, projectId: number | null | undefined): Promise<number | null> {
  if (!projectId || !Number.isFinite(projectId)) return null;
  return await ensureProjectBacklogSprint(db, projectId);
}
