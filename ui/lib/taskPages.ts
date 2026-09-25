export interface TaskPage<T> {
  tasks: T[];
  total: number;
  hasMore: boolean;
}

/** Collect a complete snapshot before publishing a refresh. The API may cap each page. */
export async function fetchTaskPages<T extends { id: number }>(
  fetchPage: (offset: number, limit: number) => Promise<TaskPage<T>>,
  onPage?: (snapshot: TaskPage<T>) => void | Promise<void>,
): Promise<TaskPage<T>> {
  const tasks = new Map<number, T>();
  let offset = 0;
  for (;;) {
    const page = await fetchPage(offset, offset === 0 && onPage ? 50 : 200);
    if (!Array.isArray(page.tasks) || (page.hasMore && page.tasks.length === 0)) {
      throw new Error('Incomplete task page');
    }
    for (const task of page.tasks) tasks.set(task.id, task);
    // Count server rows, not the board's length: lazy workflow loads may add other rows.
    offset += page.tasks.length;
    const snapshot = { tasks: [...tasks.values()], total: page.total, hasMore: page.hasMore };
    await onPage?.(snapshot);
    if (!page.hasMore) return snapshot;
  }
}
