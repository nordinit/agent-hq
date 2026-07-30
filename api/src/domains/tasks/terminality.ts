import { type Db } from '../../db/adapter/types';
import { tableExists, columnExists } from '../../db/introspection';

/**
 * Terminality is user configuration, never a code constant.
 *
 * A status is terminal because an operator configured it that way, in order of
 * increasing specificity:
 *
 *   1. `task_statuses.terminal`            — global default for the instance
 *   2. `sprint_type_task_statuses.terminal` — per sprint type (tenant row wins over the shared row)
 *   3. `sprint_task_statuses.terminal`      — per workflow
 *
 * Nothing in the codebase may decide terminality from a hardcoded status name.
 * A status with no configuration anywhere is treated as non-terminal, which is
 * the safe direction: work stays visible and dispatchable rather than silently
 * disappearing because someone added a status the code had never heard of.
 */
export async function listConfiguredTerminalStatuses(
  db: Db,
  options: { sprintId?: number | null; sprintType?: string | null; tenantId?: number | null } = {},
): Promise<string[]> {
  const terminal = new Set<string>();
  const nonTerminal = new Set<string>();

  // Callers generally know the workflow, not its type; resolve it here so no
  // call site can silently skip the sprint-type layer by omitting it.
  let sprintType = options.sprintType ?? null;
  if (!sprintType && options.sprintId != null && await tableExists(db, 'sprints')) {
    const sprint = await db.get(
      `SELECT sprint_type FROM sprints WHERE id = ?`,
      options.sprintId,
    ) as { sprint_type?: string | null } | undefined;
    sprintType = sprint?.sprint_type ?? null;
  }

  // Least specific first; more specific configuration overrides it below.
  if (await tableExists(db, 'task_statuses') && await columnExists(db, 'task_statuses', 'terminal')) {
    const statusKeyColumn = await columnExists(db, 'task_statuses', 'name') ? 'name' : 'status_key';
    const rows = await db.all(
      `SELECT ${statusKeyColumn} AS status_key, terminal FROM task_statuses`,
    ) as Array<{ status_key: string; terminal: unknown }>;
    for (const row of rows) applyRow(row, terminal, nonTerminal);
  }

  if (
    sprintType
    && await tableExists(db, 'sprint_type_task_statuses')
    && await columnExists(db, 'sprint_type_task_statuses', 'terminal')
  ) {
    const hasTenant = await columnExists(db, 'sprint_type_task_statuses', 'tenant_id');
    // Shared rows first so a tenant-specific row overrides them.
    const rows = hasTenant
      ? await db.all(`
          SELECT status_key, terminal
          FROM sprint_type_task_statuses
          WHERE sprint_type_key = ? AND (tenant_id IS NULL OR tenant_id = ?)
          ORDER BY CASE WHEN tenant_id IS NULL THEN 0 ELSE 1 END ASC, id ASC
        `, sprintType, options.tenantId ?? null) as Array<{ status_key: string; terminal: unknown }>
      : await db.all(
          `SELECT status_key, terminal FROM sprint_type_task_statuses WHERE sprint_type_key = ? ORDER BY id ASC`,
          sprintType,
        ) as Array<{ status_key: string; terminal: unknown }>;
    for (const row of rows) applyRow(row, terminal, nonTerminal);
  }

  if (
    options.sprintId != null
    && await tableExists(db, 'sprint_task_statuses')
    && await columnExists(db, 'sprint_task_statuses', 'terminal')
  ) {
    const rows = await db.all(
      `SELECT status_key, terminal FROM sprint_task_statuses WHERE sprint_id = ? ORDER BY id ASC`,
      options.sprintId,
    ) as Array<{ status_key: string; terminal: unknown }>;
    for (const row of rows) applyRow(row, terminal, nonTerminal);
  }

  return [...terminal];
}

/**
 * A status configured terminal at a broader scope can be overridden back to
 * non-terminal by a narrower one, so track both and let the later write win.
 */
function applyRow(
  row: { status_key: string; terminal: unknown },
  terminal: Set<string>,
  nonTerminal: Set<string>,
): void {
  if (!row.status_key) return;
  // PostgreSQL returns bigint columns as strings; normalise before testing.
  if (Number(row.terminal) === 1) {
    terminal.add(row.status_key);
    nonTerminal.delete(row.status_key);
  } else {
    nonTerminal.add(row.status_key);
    terminal.delete(row.status_key);
  }
}
