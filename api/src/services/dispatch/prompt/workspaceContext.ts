import path from 'path';
import { type ContextSegmentDraft } from './contextBundle';

/** The resolved view of "where does this run actually work". */
export interface DispatchPathContext {
  activeRepoRoot: string | null;
  workspaceContainerRoot: string | null;
  worktreeRoot: string | null;
  runtimeConfigWorkingDirectory: string | null;
  pathMode: 'worktree' | 'runtime-config' | 'workspace';
  repoRootSource: 'worktree' | 'runtime-config' | 'workspace' | 'none';
  workspaceContainerSource: 'workspace' | 'active-repo-root' | 'none';
}

function normalizePathOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return path.resolve(trimmed);
}

export function extractWorkingDirectoryFromRuntimeConfig(runtimeConfig: unknown): string | null {
  if (typeof runtimeConfig === 'string') {
    try {
      const parsed = JSON.parse(runtimeConfig) as Record<string, unknown>;
      return typeof parsed.workingDirectory === 'string' ? parsed.workingDirectory : null;
    } catch {
      return null;
    }
  }
  if (runtimeConfig && typeof runtimeConfig === 'object') {
    const parsed = runtimeConfig as Record<string, unknown>;
    return typeof parsed.workingDirectory === 'string' ? parsed.workingDirectory : null;
  }
  return null;
}

/**
 * Which of several plausible roots is the authoritative one for this run.
 *
 * Lives beside the block it feeds so every dispatch path can resolve it, not just the one that
 * happens to create worktrees. A caller with no worktree still has a runtime-config working
 * directory or an agent workspace, and saying so is better than saying nothing.
 */
export function resolveDispatchPathContext(params: {
  worktreePath?: string | null;
  runtimeConfigWorkingDirectory?: string | null;
  workspacePath?: string | null;
}): DispatchPathContext {
  const worktreeRoot = normalizePathOrNull(params.worktreePath);
  const runtimeConfigWorkingDirectory = normalizePathOrNull(params.runtimeConfigWorkingDirectory);
  const workspacePath = normalizePathOrNull(params.workspacePath);
  const activeRepoRoot = worktreeRoot ?? runtimeConfigWorkingDirectory ?? workspacePath;
  const workspaceContainerRoot = workspacePath ?? activeRepoRoot;
  const pathMode: 'worktree' | 'runtime-config' | 'workspace' = worktreeRoot
    ? 'worktree'
    : runtimeConfigWorkingDirectory
      ? 'runtime-config'
      : 'workspace';
  const repoRootSource: 'worktree' | 'runtime-config' | 'workspace' | 'none' = worktreeRoot
    ? 'worktree'
    : runtimeConfigWorkingDirectory
      ? 'runtime-config'
      : workspacePath
        ? 'workspace'
        : 'none';
  const workspaceContainerSource: 'workspace' | 'active-repo-root' | 'none' = workspacePath
    ? 'workspace'
    : activeRepoRoot
      ? 'active-repo-root'
      : 'none';
  return {
    activeRepoRoot,
    workspaceContainerRoot,
    worktreeRoot,
    runtimeConfigWorkingDirectory,
    pathMode,
    repoRootSource,
    workspaceContainerSource,
  };
}

/**
 * Tells the agent which of several plausible roots is the real one.
 *
 * An agent handed a worktree under a workspace container will otherwise start probing the
 * container for repo files and conclude the checkout is broken, so the block is prescriptive
 * rather than merely informational.
 */
export function buildWorkspaceContextSection(pathContext: DispatchPathContext): string {
  return [
    '## Active Workspace Context',
    `- **Path mode:** ${pathContext.pathMode}`,
    `- **Active repo root:** ${pathContext.activeRepoRoot ?? 'unknown'}`,
    `- **Workspace container root:** ${pathContext.workspaceContainerRoot ?? 'unknown'}`,
    `- **Task worktree:** ${pathContext.worktreeRoot ?? 'none'}`,
    '',
    'Use the active repo root as the authoritative cwd for repo files, git commands, and task implementation work.',
    'Start all file inspection, searches, edits, and git commands from the active repo root first.',
    'Do not begin by probing the workspace container root for repo files when the active repo root differs.',
    'Do not treat the workspace container root as the repo root when a task worktree or other active repo root is present.',
    'Treat the workspace container root as a broader container boundary only, not the repo root, when these differ.',
    '',
  ].join('\n');
}

export function buildWorkspaceContextSegmentDraft(
  pathContext: DispatchPathContext | null,
): ContextSegmentDraft {
  if (!pathContext || pathContext.repoRootSource === 'none') {
    return {
      kind: 'workspace_path',
      label: 'Active Workspace Context',
      text: '',
      source: { type: 'workspace', label: 'No workspace resolved' },
      notInjectedReason: 'This agent has no worktree, runtime working directory, or workspace path',
    };
  }
  return {
    kind: 'workspace_path',
    label: 'Active Workspace Context',
    text: buildWorkspaceContextSection(pathContext),
    source: {
      type: 'workspace',
      label: pathContext.activeRepoRoot ?? 'unknown repo root',
      detail: {
        path_mode: pathContext.pathMode,
        repo_root_source: pathContext.repoRootSource,
        workspace_container_source: pathContext.workspaceContainerSource,
        active_repo_root: pathContext.activeRepoRoot,
        workspace_container_root: pathContext.workspaceContainerRoot,
        task_worktree: pathContext.worktreeRoot,
      },
    },
  };
}
