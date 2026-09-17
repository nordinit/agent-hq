import { tableHasColumn } from '../../../lib/durableRunIdentity';
import { type Db } from "../../../db/adapter/types";
import { columnExists as sharedColumnExists } from "../../../db/introspection";

interface StoryPointRoutingRule {
  max_points: number;
  project_id?: number | null;
  workflow_id?: number | null;
  workflow_type?: string | null;
  model: string;
  max_turns: number | null;
  max_budget_usd: number | null;
  thinking_level: string | null;
  fast_mode: number | boolean | null;
  enabled?: number | boolean | null;
  label: string | null;
}

export interface ResolvedStoryPointModel {
  model: string;
  max_turns: number | null;
  max_budget_usd: number | null;
  thinking_level: string | null;
  fast_mode: boolean | null;
  label: string | null;
}

/**
 * resolveModelFromStoryPoints — look up the story_point_model_routing table and
 * return the model (and optional max_turns / max_budget_usd overrides) for the
 * given story_points value and preferred_provider.
 *
 * Precedence rule (highest wins):
 *   1. Explicit workflow-scoped rule for the task's workflow
 *   2. Workflow-type-scoped rule for the task's project + resolved legacy workflow type
 *   3. Global workflow-type-scoped rule for the resolved legacy workflow type
 *   4. Explicit project-scoped rule for the task's project
 *
 * Within each tier, provider-specific rules win over NULL-provider rules, and
 * the smallest max_points bucket that still covers the story_points value is
 * selected.
 *
 * Returns null if story_points is null/unset, no explicit scope was supplied,
 * or no scoped rule matches.
 */
export async function resolveModelFromStoryPoints(
  db: Db,
  story_points: number | null | undefined,
  preferred_provider?: string | null,
  scope?: { projectId?: number | null; workflowId?: number | null; workflowType?: string | null; tenantId?: number | null },
): Promise<ResolvedStoryPointModel | null> {
  if (story_points == null) return null;

  try {
    const provider = preferred_provider ?? null;
    let projectId = scope?.projectId ?? null;
    const workflowId = scope?.workflowId ?? null;
    let workflowType = scope?.workflowType ?? null;
    const tenantId = scope?.tenantId ?? null;
    if (projectId == null && workflowId == null && workflowType == null) return null;

    if (workflowId != null && (workflowType == null || projectId == null)) {
      try {
        const workflowHasTenant = await tableHasColumn(db, 'workflows', 'tenant_id');
        const workflowTenantPredicate = workflowHasTenant && tenantId != null ? 'AND tenant_id = ?' : '';
        const workflowParams = workflowHasTenant && tenantId != null ? [workflowId, tenantId] : [workflowId];
        const workflow = await db.get(`SELECT project_id, workflow_type FROM workflows WHERE id = ? ${workflowTenantPredicate} LIMIT 1`, ...workflowParams) as { project_id?: number | null; workflow_type?: string | null } | undefined;
        projectId = projectId ?? workflow?.project_id ?? null;
        workflowType = workflowType ?? (workflow?.workflow_type ? String(workflow.workflow_type).trim() : null);
      } catch {
        workflowType = workflowType ?? null;
      }
    }

    const whereClauses: string[] = [];
    const params: unknown[] = [story_points, provider];
    const orderParams: unknown[] = [];
    let scopeOrderCase = '';
    const hasWorkflowTypeRoutingScope = await (async () => {
      try {
        return await sharedColumnExists(db, 'story_point_model_routing', 'workflow_type');
      } catch {
        return false;
      }
    })();
    const workflowTypeBlankPredicate = hasWorkflowTypeRoutingScope ? `(workflow_type IS NULL OR workflow_type = '')` : '1 = 1';
    const workflowTypeSelect = hasWorkflowTypeRoutingScope ? 'workflow_type' : 'NULL as workflow_type';
    const hasFastModeRouting = await tableHasColumn(db, 'story_point_model_routing', 'fast_mode');
    const fastModeSelect = hasFastModeRouting ? 'fast_mode' : 'NULL as fast_mode';
    const enabledPredicate = await tableHasColumn(db, 'story_point_model_routing', 'enabled') ? 'AND enabled = 1' : '';
    const hasTenantRoutingScope = await tableHasColumn(db, 'story_point_model_routing', 'tenant_id');
    const tenantPredicate = hasTenantRoutingScope && tenantId != null ? 'AND tenant_id = ?' : '';

    if (projectId != null && workflowId != null) {
      if (hasWorkflowTypeRoutingScope && workflowType != null) {
        whereClauses.push(`(
          (project_id = ? AND workflow_id = ? AND ${workflowTypeBlankPredicate})
          OR (project_id = ? AND workflow_id IS NULL AND workflow_type = ?)
          OR (project_id IS NULL AND workflow_id IS NULL AND workflow_type = ?)
          OR (project_id = ? AND workflow_id IS NULL AND ${workflowTypeBlankPredicate})
        )`);
        orderParams.push(projectId, workflowId, projectId, workflowType, workflowType, projectId);
        scopeOrderCase = `
          CASE
            WHEN project_id = ? AND workflow_id = ? THEN 0
            WHEN project_id = ? AND workflow_id IS NULL AND workflow_type = ? THEN 1
            WHEN project_id IS NULL AND workflow_id IS NULL AND workflow_type = ? THEN 2
            WHEN project_id = ? AND workflow_id IS NULL THEN 3
            ELSE 4
          END ASC,
        `;
        params.push(projectId, workflowId, projectId, workflowType, workflowType, projectId);
      } else {
        whereClauses.push(`((project_id = ? AND workflow_id = ?) OR (project_id = ? AND workflow_id IS NULL AND ${workflowTypeBlankPredicate}))`);
        orderParams.push(projectId, workflowId, projectId);
        scopeOrderCase = `
          CASE
            WHEN project_id = ? AND workflow_id = ? THEN 0
            WHEN project_id = ? AND workflow_id IS NULL THEN 1
            ELSE 2
          END ASC,
        `;
        params.push(projectId, workflowId, projectId);
      }
    } else if (projectId != null) {
      if (hasWorkflowTypeRoutingScope && workflowType != null) {
        whereClauses.push(`(
          (project_id = ? AND workflow_id IS NULL AND workflow_type = ?)
          OR (project_id IS NULL AND workflow_id IS NULL AND workflow_type = ?)
          OR (project_id = ? AND workflow_id IS NULL AND ${workflowTypeBlankPredicate})
        )`);
        orderParams.push(projectId, workflowType, workflowType, projectId);
        scopeOrderCase = `
          CASE
            WHEN project_id = ? AND workflow_id IS NULL AND workflow_type = ? THEN 0
            WHEN project_id IS NULL AND workflow_id IS NULL AND workflow_type = ? THEN 1
            WHEN project_id = ? AND workflow_id IS NULL THEN 2
            ELSE 3
          END ASC,
        `;
        params.push(projectId, workflowType, workflowType, projectId);
      } else {
        whereClauses.push(`(project_id = ? AND workflow_id IS NULL AND ${workflowTypeBlankPredicate})`);
        params.push(projectId);
      }
    } else if (hasWorkflowTypeRoutingScope && workflowType != null) {
      whereClauses.push(`(project_id IS NULL AND workflow_id IS NULL AND workflow_type = ?)`);
      params.push(workflowType);
    } else {
      whereClauses.push(`(project_id IS NULL AND workflow_id = ? AND ${workflowTypeBlankPredicate})`);
      params.push(workflowId);
    }

    const row = await db.get(`
      SELECT max_points, project_id, workflow_id, ${workflowTypeSelect}, model, max_turns, max_budget_usd, thinking_level, ${fastModeSelect}, label
      FROM story_point_model_routing
      WHERE max_points >= ?
        AND (provider = ? OR provider IS NULL)
        AND ${whereClauses.join(' AND ')}
        ${tenantPredicate}
        ${enabledPredicate}
      ORDER BY
        ${scopeOrderCase}
        max_points ASC,
        CASE WHEN provider = ? THEN 0 ELSE 1 END ASC
      LIMIT 1
    `, ...params, ...(hasTenantRoutingScope && tenantId != null ? [tenantId] : []), ...orderParams, provider) as StoryPointRoutingRule | undefined;

    if (!row) return null;
    return {
      model: row.model,
      max_turns: row.max_turns ?? null,
      max_budget_usd: row.max_budget_usd ?? null,
      thinking_level: row.thinking_level ?? null,
      fast_mode: row.fast_mode == null ? null : Boolean(row.fast_mode),
      label: row.label ?? null,
    };
  } catch {
    return null;
  }
}
