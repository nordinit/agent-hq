export {
  createTaskWorktree,
  removeTaskWorktree,
  pruneOrphanedWorktrees,
  resolveWorktreeBasePath,
  slugify,
} from './repoWorkspaceManager';

export type {
  RepoWorkspacePrepareResult as WorktreeCreateResult,
  RepoWorkspaceCleanupResult as WorktreeRemoveResult,
  TaskWorktreeRecord,
  WorktreePruneResult,
} from './repoWorkspaceManager';
