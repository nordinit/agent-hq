import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pruneOrphanedWorktrees } from './worktreeManager';
import { acquireWorkspaceLease } from './workspaceLease';

let tempRoot: string;
let repo: string;
let basePath: string;
function git(cwd: string, ...args: string[]) { return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }); }
beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-prune-'));
  repo = path.join(tempRoot, 'repo'); basePath = path.join(tempRoot, 'workspaces');
  fs.mkdirSync(repo); fs.mkdirSync(basePath);
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(repo, 'package.json'), '{}');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\nreport.txt\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'seed');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
});
afterEach(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
function workspace(mode: 'clone' | 'worktree' = 'clone', name = 'task-101') {
  const target = path.join(basePath, name);
  if (mode === 'clone') git(tempRoot, 'clone', repo, target);
  else git(repo, 'worktree', 'add', '-b', name, target);
  const old = new Date(Date.now() - 40 * 86400000); fs.utimesSync(target, old, old);
  return target;
}
function prune(terminal: boolean, live = false) {
  return pruneOrphanedWorktrees({ basePath, maxAgeHours: 0,
    getTaskRecord: async () => ({ exists: true, status: 'custom_closed', terminal }),
    hasLiveInstance: async () => live });
}
it.each(['clone', 'worktree'] as const)('cleans a configured terminal %s without current repository configuration', async mode => {
  const target = workspace(mode);
  expect((await prune(true)).pruned).toEqual([target]);
  expect(fs.existsSync(target)).toBe(false);
  if (mode === 'worktree') expect(git(repo, 'worktree', 'list')).not.toContain(target);
});
it('retains non-terminal tasks regardless of age', async () => {
  const target = workspace();
  expect((await prune(false)).pruned).toEqual([]);
  expect(fs.existsSync(target)).toBe(true);
});
it('retains live runs and preparation leases', async () => {
  const target = workspace();
  expect((await prune(true, true)).pruned).toEqual([]);
  const release = acquireWorkspaceLease(target)!;
  expect((await prune(true)).pruned).toEqual([]);
  release();
  expect((await prune(true)).pruned).toEqual([target]);
});
it.each(['draft.txt', 'report.txt', 'package.json'])('retains local or ignored work in %s while reclaiming ignored dependencies', async file => {
  const target = workspace();
  fs.writeFileSync(path.join(target, file), 'work');
  fs.mkdirSync(path.join(target, 'node_modules')); fs.writeFileSync(path.join(target, 'node_modules/cache'), 'generated');
  const result = await prune(true);
  expect(result.errors).toEqual([expect.stringContaining('ignored dependencies reclaimed')]);
  expect(result.pruned).toEqual([]);
  expect(fs.readFileSync(path.join(target, file), 'utf8')).toBe('work');
  expect(fs.existsSync(path.join(target, 'node_modules'))).toBe(false);
});
it('retains unpublished commits', async () => {
  const target = workspace(); git(target, 'config', 'user.name', 'Test'); git(target, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(target, 'committed.txt'), 'work'); git(target, 'add', '.'); git(target, 'commit', '-m', 'local work');
  expect((await prune(true)).pruned).toEqual([]);
});
it('rechecks terminality and liveness after taking the lease', async () => {
  const target = workspace();
  const getTaskRecord = jest.fn().mockResolvedValueOnce({ exists: true, terminal: true }).mockResolvedValue({ exists: true, terminal: false });
  expect((await pruneOrphanedWorktrees({ basePath, maxAgeHours: 0, getTaskRecord, hasLiveInstance: async () => false })).pruned).toEqual([]);
  expect(fs.existsSync(target)).toBe(true);
});
it('reclaims a clean orphan but retains malformed folders and unverified directories', async () => {
  const target = workspace(); const malformed = path.join(basePath, 'task-unknown'); fs.mkdirSync(malformed);
  const result = await pruneOrphanedWorktrees({ basePath, maxAgeHours: 0, getTaskRecord: async () => ({ exists: false, status: null }), hasLiveInstance: async () => false });
  expect(result.pruned).toEqual([target]); expect(fs.existsSync(malformed)).toBe(true);
});

it('does not retain a clean checkout solely for Agent HQ setup and run metadata', async () => {
  const target = workspace();
  fs.mkdirSync(path.join(target, '.agent-hq-setup'));
  fs.writeFileSync(path.join(target, '.agent-hq-setup/result.json'), '{}');
  fs.writeFileSync(path.join(target, '.agent-hq-run-context.json'), JSON.stringify({ task_id: 101, instance_id: 1 }));
  expect((await prune(true)).pruned).toEqual([target]);
});
