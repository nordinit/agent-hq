import type { Db } from '../db/adapter/types';
import { columnExists } from '../db/introspection';

/**
 * A definition is available to its creating project and every project using it.
 * Keep discovery and MCP authorization on the same rule. The caller must also
 * constrain the definition's tenant; usage must never cross that boundary.
 */
export async function workflowDefinitionProjectPredicate(
  db: Db,
  projectId: number,
): Promise<{ sql: string; params: unknown[] }> {
  const hasProject = await columnExists(db, 'workflow_types', 'project_id');
  const hasTenant = await columnExists(db, 'workflow_types', 'tenant_id');
  const hasWorkflowTenant = await columnExists(db, 'workflows', 'tenant_id');
  return {
    sql: `(${hasProject ? 'workflow_types.project_id = ? OR ' : ''}EXISTS (
      SELECT 1 FROM workflows definition_usage
      WHERE definition_usage.workflow_type = workflow_types.key
        AND definition_usage.project_id = ?
        ${hasTenant && hasWorkflowTenant ? 'AND definition_usage.tenant_id = workflow_types.tenant_id' : ''}
    ))`,
    params: hasProject ? [projectId, projectId] : [projectId],
  };
}
