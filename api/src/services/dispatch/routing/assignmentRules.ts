import { type Db } from '../../../db/adapter/types';
import { columnExists } from '../../../db/introspection';
import type { CandidateTask } from '../types';

/** The task fields assignment-rule matching reads. A CandidateTask satisfies it. */
export type AssignmentRuleScope = Pick<CandidateTask, 'workflow_id' | 'tenant_id' | 'project_id' | 'workflow_type' | 'status' | 'task_type'>;

/** A workflow_task_routing_rules row joined with its agent and repo fields; accessed by field name. */
export type AssignmentRuleRow = any;

async function tableHasColumn(db: Db, tableName: string, columnName: string): Promise<boolean> {
  return await columnExists(db, tableName, columnName);
}

/**
 * getMatchingAssignmentRules — returns workflow routing rules that match a task's
 * workflow_id/status/task_type, ordered by scope specificity, task-type
 * specificity, priority DESC, and stable id tiebreaker. Each row includes full
 * agent fields for dispatch.
 *
 * The one definition of "which agents can work this task in this status". The
 * dispatcher, the reconciler and Keep same agent all use it, so they agree.
 */
export async function getMatchingAssignmentRules(db: Db, task: AssignmentRuleScope): Promise<AssignmentRuleRow[]> {
  const hasProjectsTable = await tableHasColumn(db, 'projects', 'id');
  // Array.prototype.every is SYNCHRONOUS. An async callback returns a Promise, which is
  // always truthy, so `.every(async ...)` unconditionally returns true and the column check
  // never actually runs. The columns must be resolved first, then reduced.
  const REPO_COLUMNS = ['repo_path', 'repo_url', 'repo_access_mode'];
  const hasProjectRepoColumns = (await Promise.all(
    REPO_COLUMNS.map((column) => tableHasColumn(db, 'projects', column)),
  )).every(Boolean);
  const hasWorkflowRepoColumns = (await Promise.all(
    REPO_COLUMNS.map((column) => tableHasColumn(db, 'workflows', column)),
  )).every(Boolean);
  const hasScopedRoutingColumns = await tableHasColumn(db, 'workflow_task_routing_rules', 'project_id')
    && await tableHasColumn(db, 'workflow_task_routing_rules', 'workflow_type');
  const hasRoutingTenantColumn = await tableHasColumn(db, 'workflow_task_routing_rules', 'tenant_id');
  const routingRuleEnabledCondition = await tableHasColumn(db, 'workflow_task_routing_rules', 'enabled') ? 'AND rr.enabled = 1' : '';
  const hasAgentTenantColumn = await tableHasColumn(db, 'agents', 'tenant_id');
  const hasProviderConnectionColumn = await tableHasColumn(db, 'agents', 'provider_connection_id');
  const projectRepoSelect = hasProjectRepoColumns
    ? 'p.repo_path as project_repo_path, p.repo_url as project_repo_url, p.repo_access_mode as project_repo_access_mode,'
    : 'NULL as project_repo_path, NULL as project_repo_url, NULL as project_repo_access_mode,';
  const workflowRepoSelect = hasWorkflowRepoColumns
    ? 's.repo_path as workflow_repo_path, s.repo_url as workflow_repo_url, s.repo_access_mode as workflow_repo_access_mode,'
    : 'NULL as workflow_repo_path, NULL as workflow_repo_url, NULL as workflow_repo_access_mode,';
  const projectJoin = hasProjectsTable ? 'LEFT JOIN projects p ON p.id = a.project_id' : '';
  const workflowJoin = hasWorkflowRepoColumns ? 'LEFT JOIN workflows s ON s.id = COALESCE(rr.workflow_id, ?)' : '';

  const tenantCondition = [
    hasRoutingTenantColumn && task.tenant_id != null ? 'rr.tenant_id = ?' : null,
    hasAgentTenantColumn && task.tenant_id != null ? 'a.tenant_id = ?' : null,
  ].filter(Boolean).join(' AND ');
  const tenantParams = [
    ...(hasRoutingTenantColumn && task.tenant_id != null ? [task.tenant_id] : []),
    ...(hasAgentTenantColumn && task.tenant_id != null ? [task.tenant_id] : []),
  ];

  const runRuleQuery = async (scopeCondition: string, params: unknown[], status: string): Promise<AssignmentRuleRow[]> => await db.all(`
      SELECT rr.*,
             a.id as agent_id,
             a.job_instructions, a.enabled, a.timeout_seconds, a.model,
             a.skill_names,
             a.session_key as agent_session_key, a.name as agent_name, a.model as agent_model,
             a.openclaw_agent_id, a.runtime_type, a.runtime_config, a.hooks_url as agent_hooks_url,
             a.hooks_auth_header as agent_hooks_auth_header,
             a.workspace_path, a.preferred_provider, ${hasProviderConnectionColumn ? 'a.provider_connection_id' : 'NULL'} as provider_connection_id, a.repo_path, a.repo_url, a.repo_access_mode,
             ${hasAgentTenantColumn ? 'a.tenant_id' : 'NULL'} as tenant_id,
             ${projectRepoSelect}
             ${workflowRepoSelect}
             a.os_user
      FROM workflow_task_routing_rules rr
      JOIN agents a ON a.id = rr.agent_id AND a.enabled = 1
      ${projectJoin}
      ${workflowJoin}
      WHERE ${scopeCondition}
        ${tenantCondition ? `AND ${tenantCondition}` : ''}
        ${routingRuleEnabledCondition}
        AND rr.status = ?
        AND (rr.task_type = ? OR rr.task_type IS NULL)
      ORDER BY CASE WHEN rr.workflow_id = ? THEN 0 ELSE 1 END,
               CASE WHEN rr.task_type = ? THEN 0 ELSE 1 END,
               rr.priority DESC,
               rr.id ASC
    `, ...(hasWorkflowRepoColumns ? [task.workflow_id ?? null] : []), ...params, ...tenantParams, status, task.task_type ?? null, task.workflow_id ?? null, task.task_type ?? null) as AssignmentRuleRow[];

  const loadWorkflowScopedRules = async (status: string): Promise<AssignmentRuleRow[]> => {
    if (!task.workflow_id) return [];
    if (hasScopedRoutingColumns && task.project_id && task.workflow_type) {
      return await runRuleQuery(
        'rr.project_id = ? AND rr.workflow_type = ? AND (rr.workflow_id = ? OR rr.workflow_id IS NULL)',
        [task.project_id, task.workflow_type, task.workflow_id],
        status,
      );
    }
    return await runRuleQuery('rr.workflow_id = ?', [task.workflow_id], status);
  };

  // A status is worked only by its own rules. No status borrows another status's rules.
  try {
    return await loadWorkflowScopedRules(task.status);
  } catch {
    // workflow-scoped tables may not exist in minimal test DBs
    return [];
  }
}
