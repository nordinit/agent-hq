import { STARTER_BACKLOG_WORKFLOW_NAME } from './starterCatalog';
import { type Db } from "../db/adapter/types";
import { tableExists as sharedTableExists, columnExists as sharedColumnExists, tableColumns as sharedTableColumns, indexExists as sharedIndexExists } from "../db/introspection";

type WorkflowRow = {
  id: number;
  project_id: number;
  workflow_type: string | null;
};

async function tableHasColumn(db: Db, tableName: string, columnName: string): Promise<boolean> {
    return await sharedColumnExists(db, tableName, columnName);
}

async function loadWorkflowRow(db: Db, workflowId: number): Promise<WorkflowRow | null> {
  return await db.get(`
    SELECT id, project_id, workflow_type
    FROM workflows
    WHERE id = ?
    LIMIT 1
  `, workflowId) as WorkflowRow | undefined ?? null;
}

export async function ensureProjectBacklogWorkflow(db: Db, projectId: number): Promise<number> {
  const project = await db.get(`SELECT tenant_id FROM projects WHERE id = ?`, projectId) as { tenant_id: number | null } | undefined;
  const tenantWorkflowType = project?.tenant_id != null
    ? (await db.get(`
      SELECT key
      FROM workflow_types
      WHERE tenant_id = ? AND (key = 'generic' OR key LIKE ?)
      ORDER BY CASE WHEN key = 'generic' THEN 0 ELSE 1 END, key ASC
      LIMIT 1
    `, project.tenant_id, '%__generic') as { key: string } | undefined)?.key ?? 'generic'
    : 'generic';
  const existing = await db.get(`
    SELECT id
    FROM workflows
    WHERE project_id = ?
      AND (lower(name) = lower(?) OR workflow_type = ?)
    ORDER BY CASE WHEN lower(name) = lower(?) THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `, projectId, STARTER_BACKLOG_WORKFLOW_NAME, tenantWorkflowType, STARTER_BACKLOG_WORKFLOW_NAME) as { id: number } | undefined;
  if (existing) return existing.id;

  const result = await db.run(`
    INSERT INTO workflows (tenant_id, project_id, name, goal, workflow_type, status, length_kind, length_value)
    VALUES (?, ?, ?, '', ?, 'active', 'time', 'ongoing')
  `, project?.tenant_id ?? null, projectId, STARTER_BACKLOG_WORKFLOW_NAME, tenantWorkflowType);

  return Number(result.lastInsertId);
}

export async function resolveDefaultProjectWorkflowId(db: Db, projectId: number | null | undefined): Promise<number | null> {
  if (!projectId || !Number.isFinite(projectId)) return null;
  return await ensureProjectBacklogWorkflow(db, projectId);
}
