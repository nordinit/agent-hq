import { execFileSync, type ExecFileSyncOptions } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  prepareRepoWorkspaceDependencies,
  type RepoWorkspaceDependencySetupResult,
} from './repoWorkspaceDependencies';

export type RepoAccessMode = 'worktree' | 'clone';

export interface RepoWorkspacePrepareResult {
  mode: RepoAccessMode;
  workspacePath: string;
  branch: string;
  created: boolean;
  error?: string;
  reusedExisting?: boolean;
  dependencySetup?: RepoWorkspaceDependencySetupResult[];
}

export interface RepoWorkspaceCleanupResult {
  removed: boolean;
  workspacePath?: string;
  worktreePath?: string;
  error?: string;
}

function gitExec(args: string[], cwd: string): string {
  const opts: ExecFileSyncOptions = {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  return execFileSync('git', args, opts) as unknown as string;
}

function gitRefExists(ref: string, cwd: string): boolean {
  try {
    gitExec(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

function resolveWorktreeBaseRef(repoPath: string, baseBranch: string): { ref: string; reason: string } {
  const remoteBaseRef = `origin/${baseBranch}`;
  if (gitRefExists(remoteBaseRef, repoPath)) {
    return { ref: remoteBaseRef, reason: `using remote-tracking ref ${remoteBaseRef}` };
  }

  if (gitRefExists(baseBranch, repoPath)) {
    return { ref: baseBranch, reason: `origin/${baseBranch} missing, falling back to local branch ${baseBranch}` };
  }

  try {
    const currentBranch = gitExec(['symbolic-ref', '--quiet', '--short', 'HEAD'], repoPath).trim();
    if (currentBranch && gitRefExists(currentBranch, repoPath)) {
      return {
        ref: currentBranch,
        reason: `origin/${baseBranch} and local ${baseBranch} missing, falling back to current branch ${currentBranch}`,
      };
    }
  } catch {
    // Detached HEAD or unborn branch, continue to HEAD fallback below.
  }

  if (gitRefExists('HEAD', repoPath)) {
    return {
      ref: 'HEAD',
      reason: `origin/${baseBranch}, local ${baseBranch}, and current branch missing, falling back to HEAD`,
    };
  }

  throw new Error(
    `No valid base ref found for worktree creation (checked origin/${baseBranch}, ${baseBranch}, current branch, and HEAD). Repository may be empty or misconfigured.`,
  );
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function buildTaskBranchName(params: {
  agentSlug: string;
  taskId: number;
  taskTitle: string;
}): string {
  const slug = slugify(params.taskTitle);
  return `${params.agentSlug}/task-${params.taskId}-${slug}`;
}

export function resolveWorktreeBasePath(params: {
  osUser?: string | null;
  workspacePath: string;
}): string {
  const { osUser, workspacePath } = params;
  if (osUser) {
    return path.join('/Users', osUser, 'workspaces');
  }
  return workspacePath;
}

export function createTaskWorktree(params: {
  repoPath: string;
  basePath: string;
  taskId: number;
  taskTitle: string;
  agentSlug: string;
  baseBranch?: string;
}): RepoWorkspacePrepareResult {
  const { repoPath, basePath, taskId, taskTitle, agentSlug, baseBranch = 'main' } = params;
  const branch = buildTaskBranchName({ agentSlug, taskId, taskTitle });
  const workspacePath = path.join(basePath, `task-${taskId}`);

  try {
    if (fs.existsSync(workspacePath)) {
      try {
        gitExec(['rev-parse', '--is-inside-work-tree'], workspacePath);
        console.log(`[repoWorkspaceManager] Reusing existing worktree at ${workspacePath}`);
        return {
          mode: 'worktree',
          workspacePath,
          branch,
          created: false,
          reusedExisting: true,
          dependencySetup: prepareRepoWorkspaceDependencies({
            mode: 'worktree',
            workspacePath,
            sourceRepoPath: repoPath,
          }),
        };
      } catch {
        console.warn(`[repoWorkspaceManager] Stale path at ${workspacePath}, removing and recreating worktree`);
        try {
          gitExec(['worktree', 'remove', workspacePath, '--force'], repoPath);
        } catch {
          fs.rmSync(workspacePath, { recursive: true, force: true });
        }
      }
    }

    try {
      gitExec(['fetch', 'origin', '--prune'], repoPath);
    } catch (fetchErr) {
      console.warn('[repoWorkspaceManager] git fetch failed (non-fatal):', fetchErr);
    }

    let branchExists = false;
    try {
      gitExec(['rev-parse', '--verify', branch], repoPath);
      branchExists = true;
    } catch {
      // branch created below
    }

    fs.mkdirSync(basePath, { recursive: true });

    if (branchExists) {
      gitExec(['worktree', 'add', workspacePath, branch], repoPath);
    } else {
      const baseRef = resolveWorktreeBaseRef(repoPath, baseBranch);
      console.log(`[repoWorkspaceManager] Creating worktree for task #${taskId} from ${baseRef.ref} (${baseRef.reason})`);
      gitExec(['worktree', 'add', '-b', branch, workspacePath, baseRef.ref], repoPath);
    }

    console.log(`[repoWorkspaceManager] Created worktree at ${workspacePath} (branch: ${branch})`);
    return {
      mode: 'worktree',
      workspacePath,
      branch,
      created: true,
      dependencySetup: prepareRepoWorkspaceDependencies({
        mode: 'worktree',
        workspacePath,
        sourceRepoPath: repoPath,
      }),
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[repoWorkspaceManager] Failed to create worktree for task #${taskId}:`, errorMsg);
    return { mode: 'worktree', workspacePath, branch, created: false, error: errorMsg };
  }
}

export function removeTaskWorktree(params: {
  repoPath: string;
  worktreePath: string;
}): RepoWorkspaceCleanupResult {
  const { repoPath, worktreePath } = params;

  try {
    if (!fs.existsSync(worktreePath)) {
      return { removed: true, workspacePath: worktreePath, worktreePath };
    }

    gitExec(['worktree', 'remove', worktreePath, '--force'], repoPath);
    try {
      gitExec(['worktree', 'prune'], repoPath);
    } catch {
      // non-fatal
    }

    return { removed: true, workspacePath: worktreePath, worktreePath };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      gitExec(['worktree', 'prune'], repoPath);
      return { removed: true, workspacePath: worktreePath, worktreePath };
    } catch {
      return { removed: false, workspacePath: worktreePath, worktreePath, error: errorMsg };
    }
  }
}

export function ensureTaskClone(params: {
  repoUrl: string;
  workspaceRoot: string;
  taskId: number;
  taskTitle: string;
  agentSlug: string;
  baseBranch?: string;
}): RepoWorkspacePrepareResult {
  const { repoUrl, workspaceRoot, taskId, taskTitle, agentSlug, baseBranch = 'main' } = params;
  const branch = buildTaskBranchName({ agentSlug, taskId, taskTitle });
  const workspacePath = path.join(workspaceRoot, `task-${taskId}`);

  try {
    const cloneAlreadyExisted = fs.existsSync(workspacePath);
    fs.mkdirSync(workspaceRoot, { recursive: true });

    if (!cloneAlreadyExisted) {
      execFileSync('git', ['clone', repoUrl, workspacePath], {
        encoding: 'utf-8',
        timeout: 60_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      gitExec(['rev-parse', '--is-inside-work-tree'], workspacePath);
      const remoteUrl = gitExec(['remote', 'get-url', 'origin'], workspacePath).trim();
      if (remoteUrl !== repoUrl) {
        throw new Error(`existing clone origin mismatch at ${workspacePath}: expected ${repoUrl}, got ${remoteUrl}`);
      }
    }

    try {
      gitExec(['fetch', 'origin', '--prune'], workspacePath);
    } catch (fetchErr) {
      console.warn('[repoWorkspaceManager] git fetch failed for clone (non-fatal):', fetchErr);
    }

    let branchExists = false;
    try {
      gitExec(['rev-parse', '--verify', branch], workspacePath);
      branchExists = true;
    } catch {
      // create below
    }

    if (branchExists) {
      gitExec(['checkout', branch], workspacePath);
    } else {
      gitExec(['checkout', '-b', branch, `origin/${baseBranch}`], workspacePath);
    }

    console.log(`[repoWorkspaceManager] Prepared clone at ${workspacePath} (branch: ${branch})`);
    return {
      mode: 'clone',
      workspacePath,
      branch,
      created: !cloneAlreadyExisted,
      reusedExisting: cloneAlreadyExisted,
      dependencySetup: prepareRepoWorkspaceDependencies({
        mode: 'clone',
        workspacePath,
      }),
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[repoWorkspaceManager] Failed to prepare clone for task #${taskId}:`, errorMsg);
    return { mode: 'clone', workspacePath, branch, created: false, error: errorMsg };
  }
}

export function removeTaskClone(params: { workspacePath: string }): RepoWorkspaceCleanupResult {
  const { workspacePath } = params;
  try {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    return { removed: true, workspacePath };
  } catch (err) {
    return { removed: false, workspacePath, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface WorktreePruneResult {
  pruned: string[];
  errors: string[];
}

export interface TaskWorktreeRecord {
  exists: boolean;
  status: string | null;
}

/**
 * Task statuses whose workspace is safe to reclaim as soon as it goes idle.
 * These are terminal: the task will never resume work in that working copy.
 */
export const RECLAIMABLE_TASK_STATUSES: ReadonlySet<string> = new Set([
  'done',
  'cancelled',
  'failed',
]);

/**
 * Backstop for tasks parked in a non-terminal status (blocked, stalled,
 * review, ...). Their workspace is kept while the task might still resume, but
 * a working copy untouched for this long is abandoned in practice. Without the
 * backstop a task that never reaches a terminal status holds its workspace
 * forever, which is how clone-mode workspaces accumulated indefinitely.
 */
const DEFAULT_STALE_WORKSPACE_DAYS = 14;

/**
 * Reclaim a task workspace using the strategy its access mode requires:
 * worktrees must be detached from the source repo via `git worktree remove`,
 * clones are standalone directories and are simply deleted.
 */
function removeWorkspaceForMode(params: {
  mode: RepoAccessMode;
  repoPath?: string | null;
  workspacePath: string;
}): RepoWorkspaceCleanupResult {
  const { mode, repoPath, workspacePath } = params;
  if (mode === 'clone') {
    return removeTaskClone({ workspacePath });
  }
  return removeTaskWorktree({ repoPath: repoPath ?? '', worktreePath: workspacePath });
}

type WorktreePruneCandidate =
  | { kind: 'task'; taskId: number }
  | { kind: 'orphan'; reason: 'malformed-task-folder' };

function classifyWorktreeDirectory(name: string): WorktreePruneCandidate | null {
  const taskMatch = name.match(/(?:^task-|^agent-hq-task-)(\d+)$/);
  if (taskMatch) {
    const taskId = Number(taskMatch[1]);
    if (Number.isFinite(taskId)) {
      return { kind: 'task', taskId };
    }
  }

  if (/^(?:task-|agent-hq-task-)/.test(name)) {
    return { kind: 'orphan', reason: 'malformed-task-folder' };
  }

  return null;
}

export async function pruneOrphanedWorktrees(params: {
  repoPath?: string | null;
  basePath: string;
  mode?: RepoAccessMode;
  maxAgeHours?: number;
  staleWorkspaceDays?: number;
  // Both callbacks query the database, which is async now, so they return promises and
  // this function must await them. Leaving the declared types synchronous would let a
  // caller pass an async callback whose promise is silently treated as a truthy object —
  // hasLiveInstance would then be true for EVERY directory and nothing would ever prune.
  getTaskRecord: (taskId: number) => TaskWorktreeRecord | Promise<TaskWorktreeRecord>;
  hasLiveInstance: (worktreePath: string, taskId: number | null) => boolean | Promise<boolean>;
}): Promise<WorktreePruneResult> {
  const {
    repoPath,
    basePath,
    mode = 'worktree',
    maxAgeHours = 24,
    staleWorkspaceDays = DEFAULT_STALE_WORKSPACE_DAYS,
    getTaskRecord,
    hasLiveInstance,
  } = params;
  const pruned: string[] = [];
  const errors: string[] = [];
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const staleMs = staleWorkspaceDays * 24 * 60 * 60 * 1000;

  if (!fs.existsSync(basePath)) return { pruned, errors };

  for (const entry of fs.readdirSync(basePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = classifyWorktreeDirectory(entry.name);
    if (!candidate) continue;

    const fullPath = path.join(basePath, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < maxAgeMs) continue;

      const taskId = candidate.kind === 'task' ? candidate.taskId : null;
      if (await hasLiveInstance(fullPath, taskId)) continue;

      if (candidate.kind === 'task') {
        const task = await getTaskRecord(candidate.taskId);
        // Terminal tasks are reclaimed as soon as they go idle. Tasks parked in
        // a non-terminal status keep their workspace until it has been
        // untouched past the stale backstop, so work in progress is preserved
        // without letting a never-completed task pin its workspace forever.
        if (task.exists && !RECLAIMABLE_TASK_STATUSES.has(task.status ?? '')) {
          if (ageMs < staleMs) continue;
          const idleDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
          console.log(
            `[repoWorkspaceManager] Reclaiming stale ${mode} workspace ${fullPath} `
            + `(task #${candidate.taskId} status=${task.status}, idle ${idleDays}d)`,
          );
        }
      }

      const result = removeWorkspaceForMode({ mode, repoPath, workspacePath: fullPath });
      if (result.removed) pruned.push(fullPath);
      else if (result.error) errors.push(`${fullPath}: ${result.error}`);
    } catch (err) {
      errors.push(`${fullPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { pruned, errors };
}
