/**
 * Project archive helpers. An archived project keeps its data, but agents stop picking up its
 * tasks, its recurring tasks stop, and it and its contents leave normal navigation. The server
 * enforces all of that; these helpers only word it for the operator.
 */

export function isArchivedProject(project: { archived_at?: string | null } | null | undefined): boolean {
  return Boolean(project?.archived_at);
}

export function archiveConfirmMessage(projectName: string): string {
  return [
    `Archive "${projectName}"?`,
    '',
    'Agents stop picking up its tasks and its recurring tasks stop. The project and everything in it',
    'disappear from the rest of Agent HQ. Runs already in progress finish normally.',
    '',
    'You can unarchive it, or delete it permanently, from Projects → Archived.',
  ].join('\n');
}

/** Told after archiving when runs were still going, since they are not stopped. */
export function runningAfterArchiveNotice(runningInstances: number): string | null {
  if (!runningInstances) return null;
  return `${runningInstances} run${runningInstances === 1 ? ' is' : 's are'} still finishing in the archived project.`;
}

export interface ProjectDeletionSummary {
  agents_deleted?: number;
  agents_archived?: number;
  agents_kept?: string[];
}

/** One line on what happened to the project's agents, for the notice after a permanent delete. */
export function projectDeletionNotice(projectName: string, summary: ProjectDeletionSummary): string {
  const parts: string[] = [];
  const removed = (summary.agents_deleted ?? 0) + (summary.agents_archived ?? 0);
  if (removed > 0) parts.push(`${removed} agent${removed === 1 ? '' : 's'} removed`);
  if (summary.agents_kept?.length) parts.push(`${summary.agents_kept.join(', ')} kept`);
  return `Deleted ${projectName}${parts.length ? ` (${parts.join('; ')})` : ''}.`;
}
