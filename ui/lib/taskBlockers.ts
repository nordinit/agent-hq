export type BlockerLike = {
  status: string;
  /** Set by the API: this blocker still holds the task back. */
  blocks_dispatch?: boolean;
};

export type BlockableTaskLike = {
  /** Set by the API: an unresolved blocker relationship holds the task back. */
  is_blocked?: boolean;
  blockers?: BlockerLike[];
};

/** Whether one entry of a task's `blockers` still holds it back. */
export function blockerStillBlocks(blocker: BlockerLike): boolean {
  // Older API responses lack blocks_dispatch; fall back to the old status check.
  return blocker.blocks_dispatch ?? blocker.status !== 'done';
}

/**
 * Whether an unresolved blocker relationship holds the task back. The API
 * decides this the way dispatch does, so a cancelled blocker no longer blocks.
 * A run that ended with a "blocked" outcome does not make a task blocked here:
 * that outcome is history, and the task may have moved on since.
 */
export function isTaskBlocked(task: BlockableTaskLike): boolean {
  if (typeof task.is_blocked === 'boolean') return task.is_blocked;
  return (task.blockers ?? []).some(blockerStillBlocks);
}
