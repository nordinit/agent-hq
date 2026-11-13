/**
 * Helpers for the task board's bounded read (GET /api/v1/tasks/board), which returns the newest
 * tasks of each (workflow, status) column plus every column's total instead of every task.
 */

export interface BoardBucketLike {
  workflow_id: number | null;
  status: string;
  total: number;
  loaded: number;
}

/** Newest tasks loaded per column before "Show more". */
export const BOARD_PER_STATUS_LIMIT = 30;
/** How many more tasks each "Show more" loads into a column. */
export const BOARD_LOAD_MORE_STEP = 30;

/** A column's key, as the board API's `expand` parameter spells it. */
export function boardBucketKey(workflowId: number | null | undefined, status: string): string {
  return `${workflowId ?? 'none'}:${status}`;
}

/**
 * Keeps the previous object for every task whose content did not change, so memoized cards skip
 * re-rendering when a refresh brings back the same data. Order follows `next`.
 */
export function reuseUnchangedTasks<T extends { id: number }>(previous: readonly T[], next: readonly T[]): T[] {
  if (previous.length === 0) return [...next];
  const previousById = new Map<number, { task: T; json: string }>();
  for (const task of previous) previousById.set(task.id, { task, json: JSON.stringify(task) });
  return next.map(task => {
    const prior = previousById.get(task.id);
    return prior && prior.json === JSON.stringify(task) ? prior.task : task;
  });
}

/**
 * Total tasks in one status column, across the given workflows (all workflows when none are
 * given). Columns with no workflow count only when no workflow filter is set.
 */
export function boardColumnTotal(
  buckets: readonly BoardBucketLike[],
  status: string,
  workflowIds?: readonly (number | null)[] | null,
): number {
  const allowed = workflowIds && workflowIds.length > 0 ? new Set(workflowIds) : null;
  let total = 0;
  for (const bucket of buckets) {
    if (bucket.status !== status) continue;
    if (allowed && !allowed.has(bucket.workflow_id)) continue;
    total += bucket.total;
  }
  return total;
}

/** Total tasks across a workflow's columns (null = tasks with no workflow). */
export function boardWorkflowTotal(buckets: readonly BoardBucketLike[], workflowId: number | null): number {
  return buckets.reduce((sum, bucket) => (bucket.workflow_id === workflowId ? sum + bucket.total : sum), 0);
}

/**
 * The `expand` entries a "Show more" on one status column produces: every matching workflow
 * column that still has unloaded tasks grows by one step from what it holds now.
 */
export function expandBoardColumn(
  current: Readonly<Record<string, number>>,
  buckets: readonly BoardBucketLike[],
  status: string,
  workflowIds: readonly (number | null)[] | null,
  perStatusLimit = BOARD_PER_STATUS_LIMIT,
  step = BOARD_LOAD_MORE_STEP,
): Record<string, number> {
  const allowed = workflowIds && workflowIds.length > 0 ? new Set(workflowIds) : null;
  const next = { ...current };
  for (const bucket of buckets) {
    if (bucket.status !== status) continue;
    if (allowed && !allowed.has(bucket.workflow_id)) continue;
    if (bucket.loaded >= bucket.total) continue;
    const key = boardBucketKey(bucket.workflow_id, bucket.status);
    next[key] = Math.max(current[key] ?? perStatusLimit, bucket.loaded) + step;
  }
  return next;
}
