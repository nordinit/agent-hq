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

  it('preserves non-done task worktrees even when stale and idle', () => {
    const reviewWorktree = makeOldDirectory('task-101');

    const result = pruneOrphanedWorktrees({
      repoPath,
      basePath,
      maxAgeHours: 1,
      getTaskRecord: (taskId) => ({ exists: true, status: taskId === 101 ? 'review' : null }),
      hasLiveInstance: () => false,
    });

    expect(result.errors).toEqual([]);
    expect(result.pruned).toEqual([]);
    expect(fs.existsSync(reviewWorktree)).toBe(true);
  });

  it('preserves cancelled task worktrees until a later explicit cleanup path handles them', () => {
    const cancelledWorktree = makeOldDirectory('task-105');

    const result = pruneOrphanedWorktrees({
      repoPath,
      basePath,
      maxAgeHours: 1,
      getTaskRecord: (taskId) => ({ exists: true, status: taskId === 105 ? 'cancelled' : null }),
      hasLiveInstance: () => false,
    });

    expect(result.errors).toEqual([]);
    expect(result.pruned).toEqual([]);
    expect(fs.existsSync(cancelledWorktree)).toBe(true);
  });

  it('prunes done task worktrees when no live instance exists', () => {
    const current = makeOldDirectory('task-101');
    const legacy = makeOldDirectory('agent-hq-task-102');

    const result = pruneOrphanedWorktrees({
      repoPath,
      basePath,
      maxAgeHours: 1,
      getTaskRecord: () => ({ exists: true, status: 'done' }),
      hasLiveInstance: () => false,
    });

    expect(result.errors).toEqual([]);
    expect(result.pruned.sort()).toEqual([current, legacy].sort());
    expect(fs.existsSync(current)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('preserves done task worktrees when a live instance still exists', () => {
    const activeDoneWorktree = makeOldDirectory('task-103');

    const result = pruneOrphanedWorktrees({
      repoPath,
      basePath,
      maxAgeHours: 1,
      getTaskRecord: () => ({ exists: true, status: 'done' }),
      hasLiveInstance: (worktreePath, taskId) => taskId === 103 && worktreePath === activeDoneWorktree,
    });

    expect(result.errors).toEqual([]);
    expect(result.pruned).toEqual([]);
    expect(fs.existsSync(activeDoneWorktree)).toBe(true);
  });

  it('prunes task directories whose backing task record is missing', () => {
    const missingTask = makeOldDirectory('task-104');

    const result = pruneOrphanedWorktrees({
      repoPath,
      basePath,
      maxAgeHours: 1,
      getTaskRecord: () => ({ exists: false, status: null }),
      hasLiveInstance: () => false,
    });

    expect(result.errors).toEqual([]);
    expect(result.pruned).toEqual([missingTask]);
    expect(fs.existsSync(missingTask)).toBe(false);
  });

  it('prunes malformed legacy task folders with no live instance', () => {
    const malformed = makeOldDirectory('agent-hq-task-bad');
    makeOldDirectory('not-a-task');

    const result = pruneOrphanedWorktrees({
      repoPath,
      basePath,
      maxAgeHours: 1,
      getTaskRecord: () => ({ exists: false, status: null }),
      hasLiveInstance: () => false,
    });

    expect(result.errors).toEqual([]);
    expect(result.pruned).toEqual([malformed]);
    expect(fs.existsSync(malformed)).toBe(false);
    expect(fs.existsSync(path.join(basePath, 'not-a-task'))).toBe(true);
  });
});
