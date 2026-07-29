import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pruneOrphanedWorktrees } from './worktreeManager';

describe('pruneOrphanedWorktrees', () => {
  let tempRoot: string;
  let repoPath: string;
  let basePath: string;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-worktrees-'));
    repoPath = path.join(tempRoot, 'repo');
    basePath = path.join(tempRoot, 'workspaces');
    fs.mkdirSync(repoPath, { recursive: true });
    fs.mkdirSync(basePath, { recursive: true });
    execFileSync('git', ['init'], { cwd: repoPath, stdio: 'ignore' });
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function makeOldDirectory(name: string): string {
    const dir = path.join(basePath, name);
    fs.mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(dir, old, old);
    return dir;
  }

  function makeDirectoryAgedDays(name: string, days: number): string {
    const dir = path.join(basePath, name);
    fs.mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    fs.utimesSync(dir, old, old);
    return dir;
  }

  it('preserves non-terminal task worktrees that are idle but within the stale backstop', async () => {
    const reviewWorktree = makeOldDirectory('task-101');

    const result = pruneOrphanedWorktrees({
      repoPath,
      basePath,
      maxAgeHours: 1,
      getTaskRecord: (taskId) => ({ exists: true, status: taskId === 101 ? 'review' : null }),
      hasLiveInstance: () => false,
    });

    expect((await result).errors).toEqual([]);
    expect((await result).pruned).toEqual([]);
    expect(fs.existsSync(reviewWorktree)).toBe(true);
  });

  it.each(['cancelled', 'failed'])('prunes terminal %s task worktrees once idle', async (status) => {
    const terminalWorktree = makeOldDirectory('task-105');

    const result = pruneOrphanedWorktrees({
      repoPath,
      basePath,
      maxAgeHours: 1,
      getTaskRecord: (taskId) => ({ exists: true, status: taskId === 105 ? status : null }),
      hasLiveInstance: () => false,
    });

    expect((await result).errors).toEqual([]);
    expect((await result).pruned).toEqual([terminalWorktree]);
    expect(fs.existsSync(terminalWorktree)).toBe(false);
  });

  it('reclaims non-terminal task worktrees once past the stale backstop', async () => {
    const abandoned = makeDirectoryAgedDays('task-106', 30);

    const result = pruneOrphanedWorktrees({
      repoPath,
      basePath,
      maxAgeHours: 1,
      staleWorkspaceDays: 14,
      getTaskRecord: (taskId) => ({ exists: true, status: taskId === 106 ? 'blocked' : null }),
      hasLiveInstance: () => false,
    });

    expect((await result).errors).toEqual([]);
    expect((await result).pruned).toEqual([abandoned]);
    expect(fs.existsSync(abandoned)).toBe(false);
  });

  it('keeps a live non-terminal worktree even when past the stale backstop', async () => {
    const stillRunning = makeDirectoryAgedDays('task-107', 30);

    const result = pruneOrphanedWorktrees({
      repoPath,
      basePath,
      maxAgeHours: 1,
      staleWorkspaceDays: 14,
      getTaskRecord: () => ({ exists: true, status: 'blocked' }),
      hasLiveInstance: (worktreePath) => worktreePath === stillRunning,
    });

    expect((await result).errors).toEqual([]);
    expect((await result).pruned).toEqual([]);
    expect(fs.existsSync(stillRunning)).toBe(true);
  });

  it('reclaims clone-mode workspaces by deleting the directory', async () => {
    const clone = path.join(basePath, 'task-108');
    // A clone is standalone: it owns a .git directory rather than a worktree
    // pointer file, and is not registered with the source repo.
    fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
    fs.writeFileSync(path.join(clone, 'package.json'), '{}');
    // Age the directory last: writing into it bumps its mtime.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(clone, old, old);

    const result = pruneOrphanedWorktrees({
      basePath,
      mode: 'clone',
      maxAgeHours: 1,
      getTaskRecord: () => ({ exists: true, status: 'done' }),
      hasLiveInstance: () => false,
    });

    expect((await result).errors).toEqual([]);
    expect((await result).pruned).toEqual([clone]);
    expect(fs.existsSync(clone)).toBe(false);
  });

  it('prunes done task worktrees when no live instance exists', async () => {
    const current = makeOldDirectory('task-101');
    const legacy = makeOldDirectory('agent-hq-task-102');

    const result = pruneOrphanedWorktrees({
      repoPath,
      basePath,
      maxAgeHours: 1,
      getTaskRecord: () => ({ exists: true, status: 'done' }),
      hasLiveInstance: () => false,
    });

    expect((await result).errors).toEqual([]);
    expect((await result).pruned.sort()).toEqual([current, legacy].sort());
    expect(fs.existsSync(current)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('preserves done task worktrees when a live instance still exists', async () => {
    const activeDoneWorktree = makeOldDirectory('task-103');

    const result = pruneOrphanedWorktrees({
      repoPath,
      basePath,
      maxAgeHours: 1,
      getTaskRecord: () => ({ exists: true, status: 'done' }),
      hasLiveInstance: (worktreePath, taskId) => taskId === 103 && worktreePath === activeDoneWorktree,
    });

    expect((await result).errors).toEqual([]);
    expect((await result).pruned).toEqual([]);
    expect(fs.existsSync(activeDoneWorktree)).toBe(true);
  });

  it('prunes task directories whose backing task record is missing', async () => {
    const missingTask = makeOldDirectory('task-104');

    const result = pruneOrphanedWorktrees({
      repoPath,
      basePath,
      maxAgeHours: 1,
      getTaskRecord: () => ({ exists: false, status: null }),
      hasLiveInstance: () => false,
    });

    expect((await result).errors).toEqual([]);
    expect((await result).pruned).toEqual([missingTask]);
    expect(fs.existsSync(missingTask)).toBe(false);
  });

  it('prunes malformed legacy task folders with no live instance', async () => {
    const malformed = makeOldDirectory('agent-hq-task-bad');
    makeOldDirectory('not-a-task');

    const result = pruneOrphanedWorktrees({
      repoPath,
      basePath,
      maxAgeHours: 1,
      getTaskRecord: () => ({ exists: false, status: null }),
      hasLiveInstance: () => false,
    });

    expect((await result).errors).toEqual([]);
    expect((await result).pruned).toEqual([malformed]);
    expect(fs.existsSync(malformed)).toBe(false);
    expect(fs.existsSync(path.join(basePath, 'not-a-task'))).toBe(true);
  });
});
