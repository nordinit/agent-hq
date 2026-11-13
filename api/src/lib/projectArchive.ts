/**
 * Project archive (migration 52). An archived project keeps all of its rows, but automation skips
 * it and list endpoints hide it and its contents unless the caller asks for archived data.
 */

/**
 * SQL predicate that holds when the project in `projectIdColumn` is not archived. Rows without a
 * project (NULL) count as active. Interpolate only trusted column references, never user input.
 */
export function activeProjectPredicate(projectIdColumn: string): string {
  return `NOT EXISTS (SELECT 1 FROM projects archived_project
    WHERE archived_project.id = ${projectIdColumn} AND archived_project.archived_at IS NOT NULL)`;
}

/** How a list request treats archived projects: `?archived=true` lists only archived ones. */
export type ArchivedScope = 'active' | 'archived' | 'all';

/**
 * Reads `archived` / `include_archived` query parameters. Normal navigation sends neither and
 * sees active projects only; the archive page asks for `archived=true`.
 */
export function archivedScopeFromQuery(query: Record<string, unknown>): ArchivedScope {
  if (query.archived === 'true') return 'archived';
  if (query.include_archived === 'true') return 'all';
  return 'active';
}

/** SQL condition for `scope` on a project id column, or null when nothing should be filtered. */
export function archivedScopeCondition(scope: ArchivedScope, projectIdColumn: string): string | null {
  if (scope === 'all') return null;
  const active = activeProjectPredicate(projectIdColumn);
  return scope === 'active' ? active : `NOT ${active}`;
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/**
 * Condition that hides rows of archived projects from a list, or null when the list should show
 * them: when the caller names a project or another explicit scope (opening an archived project
 * still shows its contents), or asks with `include_archived=true`.
 */
export function hideArchivedProjectsCondition(
  query: { project_id?: unknown; include_archived?: unknown },
  projectIdColumn: string,
  otherExplicitScope: unknown[] = [],
): string | null {
  if (present(query.project_id) || otherExplicitScope.some(present)) return null;
  if (query.include_archived === 'true' || query.include_archived === true) return null;
  return activeProjectPredicate(projectIdColumn);
}
