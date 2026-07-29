import { tableHasColumn } from '../../../lib/durableRunIdentity';
import { type Db } from "../../../db/adapter/types";

interface StoryPointRoutingRule {
  max_points: number;
  project_id?: number | null;
  sprint_id?: number | null;
  sprint_type?: string | null;
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
 *   1. Explicit sprint-scoped rule for the task's sprint
 *   2. Workflow-type-scoped rule for the task's project + resolved legacy sprint type
 *   3. Global workflow-type-scoped rule for the resolved legacy sprint type
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
  scope?: { projectId?: number | null; sprintId?: number | null; sprintType?: string | null; tenantId?: number | null },
): Promise<ResolvedStoryPointModel | null> {
  if (story_points == null) return null;

  try {
    const provider = preferred_provider ?? null;
    let projectId = scope?.projectId ?? null;
    const sprintId = scope?.sprintId ?? null;
    let sprintType = scope?.sprintType ?? null;
    const tenantId = scope?.tenantId ?? null;
    if (projectId == null && sprintId == null && sprintType == null) return null;

    if (sprintId != null && (sprintType == null || projectId == null)) {
      try {
        const sprintHasTenant = await tableHasColumn(db, 'sprints', 'tenant_id');
        const sprintTenantPredicate = sprintHasTenant && tenantId != null ? 'AND tenant_id = ?' : '';
        const sprintParams = sprintHasTenant && tenantId != null ? [sprintId, tenantId] : [sprintId];
        const sprint = await db.get(`SELECT project_id, sprint_type FROM sprints WHERE id = ? ${sprintTenantPredicate} LIMIT 1`, ...sprintParams) as { project_id?: number | null; sprint_type?: string | null } | undefined;
        projectId = projectId ?? sprint?.project_id ?? null;
        sprintType = sprintType ?? (sprint?.sprint_type ? String(sprint.sprint_type).trim() : null);
      } catch {
        sprintType = sprintType ?? null;
      }
    }

    const whereClauses: string[] = [];
    const params: unknown[] = [story_points, provider];
    const orderParams: unknown[] = [];
    let scopeOrderCase = '';
    const hasSprintTypeRoutingScope = await (async () => {
      try {
        return (await db.all(`PRAGMA table_info(story_point_model_routing)`) as Array<{ name: string }>).some((column) => column.name === 'sprint_type');
      } catch {
        return false;
      }
    })();
    const sprintTypeBlankPredicate = hasSprintTypeRoutingScope ? `(sprint_type IS NULL OR sprint_type = '')` : '1 = 1';
    const sprintTypeSelect = hasSprintTypeRoutingScope ? 'sprint_type' : 'NULL as sprint_type';
    const hasFastModeRouting = await tableHasColumn(db, 'story_point_model_routing', 'fast_mode');
    const fastModeSelect = hasFastModeRouting ? 'fast_mode' : 'NULL as fast_mode';
    const enabledPredicate = await tableHasColumn(db, 'story_point_model_routing', 'enabled') ? 'AND enabled = 1' : '';
    const hasTenantRoutingScope = await tableHasColumn(db, 'story_point_model_routing', 'tenant_id');
    const tenantPredicate = hasTenantRoutingScope && tenantId != null ? 'AND tenant_id = ?' : '';

    if (projectId != null && sprintId != null) {
      if (hasSprintTypeRoutingScope && sprintType != null) {
        whereClauses.push(`(
          (project_id = ? AND sprint_id = ? AND ${sprintTypeBlankPredicate})
          OR (project_id = ? AND sprint_id IS NULL AND sprint_type = ?)
          OR (project_id IS NULL AND sprint_id IS NULL AND sprint_type = ?)
          OR (project_id = ? AND sprint_id IS NULL AND ${sprintTypeBlankPredicate})
        )`);
        orderParams.push(projectId, sprintId, projectId, sprintType, sprintType, projectId);
        scopeOrderCase = `
          CASE
            WHEN project_id = ? AND sprint_id = ? THEN 0
            WHEN project_id = ? AND sprint_id IS NULL AND sprint_type = ? THEN 1
            WHEN project_id IS NULL AND sprint_id IS NULL AND sprint_type = ? THEN 2
            WHEN project_id = ? AND sprint_id IS NULL THEN 3
            ELSE 4
          END ASC,
        `;
        params.push(projectId, sprintId, projectId, sprintType, sprintType, projectId);
      } else {
        whereClauses.push(`((project_id = ? AND sprint_id = ?) OR (project_id = ? AND sprint_id IS NULL AND ${sprintTypeBlankPredicate}))`);
        orderParams.push(projectId, sprintId, projectId);
        scopeOrderCase = `
          CASE
            WHEN project_id = ? AND sprint_id = ? THEN 0
            WHEN project_id = ? AND sprint_id IS NULL THEN 1
            ELSE 2
          END ASC,
        `;
        params.push(projectId, sprintId, projectId);
      }
    } else if (projectId != null) {
      if (hasSprintTypeRoutingScope && sprintType != null) {
        whereClauses.push(`(
          (project_id = ? AND sprint_id IS NULL AND sprint_type = ?)
          OR (project_id IS NULL AND sprint_id IS NULL AND sprint_type = ?)
          OR (project_id = ? AND sprint_id IS NULL AND ${sprintTypeBlankPredicate})
        )`);
        orderParams.push(projectId, sprintType, sprintType, projectId);
        scopeOrderCase = `
          CASE
            WHEN project_id = ? AND sprint_id IS NULL AND sprint_type = ? THEN 0
            WHEN project_id IS NULL AND sprint_id IS NULL AND sprint_type = ? THEN 1
            WHEN project_id = ? AND sprint_id IS NULL THEN 2
            ELSE 3
          END ASC,
        `;
        params.push(projectId, sprintType, sprintType, projectId);
      } else {
        whereClauses.push(`(project_id = ? AND sprint_id IS NULL AND ${sprintTypeBlankPredicate})`);
        params.push(projectId);
      }
    } else if (hasSprintTypeRoutingScope && sprintType != null) {
      whereClauses.push(`(project_id IS NULL AND sprint_id IS NULL AND sprint_type = ?)`);
      params.push(sprintType);
    } else {
      whereClauses.push(`(project_id IS NULL AND sprint_id = ? AND ${sprintTypeBlankPredicate})`);
      params.push(sprintId);
    }

    const row = await db.get(`
      SELECT max_points, project_id, sprint_id, ${sprintTypeSelect}, model, max_turns, max_budget_usd, thinking_level, ${fastModeSelect}, label
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
