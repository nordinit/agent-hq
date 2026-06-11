import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  buildTaskBranchName,
  createTaskWorktree,
  ensureTaskClone,
  removeTaskClone,
  resolveWorktreeBasePath,
} from './repoWorkspaceManager';

describe('repoWorkspaceManager clone mode', () => {
  let tempRoot: string;
  let remotePath: string;
  let seedPath: string;
  let workspaceRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-clone-mode-'));
    remotePath = path.join(tempRoot, 'remote.git');
    seedPath = path.join(tempRoot, 'seed');
    workspaceRoot = path.join(tempRoot, 'workspaces');

    fs.mkdirSync(seedPath, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: seedPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: seedPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: seedPath, stdio: 'ignore' });
    fs.writeFileSync(path.join(seedPath, 'README.md'), '# test\n');
    execFileSync('git', ['add', 'README.md'], { cwd: seedPath, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'seed'], { cwd: seedPath, stdio: 'ignore' });
    execFileSync('git', ['init', '--bare', remotePath], { stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', remotePath], { cwd: seedPath, stdio: 'ignore' });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: seedPath, stdio: 'ignore' });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('clones into the task workspace and creates a task branch', () => {
    const result = ensureTaskClone({
      repoUrl: remotePath,
      workspaceRoot,
      taskId: 373,
      taskTitle: 'Agent repo source modes',
      agentSlug: 'cinder-backend',
    });

    expect(result.error).toBeUndefined();
    expect(result.mode).toBe('clone');
    expect(result.workspacePath).toBe(path.join(workspaceRoot, 'task-373'));
    expect(fs.existsSync(path.join(result.workspacePath, '.git'))).toBe(true);
    expect(result.branch).toBe(buildTaskBranchName({
      agentSlug: 'cinder-backend',
      taskId: 373,
      taskTitle: 'Agent repo source modes',
    }));
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: result.workspacePath, encoding: 'utf-8' }).trim()).toBe(result.branch);
    expect(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: result.workspacePath, encoding: 'utf-8' }).trim()).toBe(remotePath);
  });

  it('reuses an existing task clone with the same origin', () => {
    const first = ensureTaskClone({
      repoUrl: remotePath,
      workspaceRoot,
      taskId: 373,
      taskTitle: 'Agent repo source modes',
      agentSlug: 'cinder-backend',
    });
    const second = ensureTaskClone({
      repoUrl: remotePath,
      workspaceRoot,
      taskId: 373,
      taskTitle: 'Agent repo source modes',
      agentSlug: 'cinder-backend',
    });

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(second.workspacePath).toBe(first.workspacePath);
    expect(second.reusedExisting).toBe(true);
  });

  it('fails truthfully when an existing task clone points at a different origin', () => {
    const otherRemotePath = path.join(tempRoot, 'other.git');
    execFileSync('git', ['init', '--bare', otherRemotePath], { stdio: 'ignore' });

    const first = ensureTaskClone({
      repoUrl: remotePath,
      workspaceRoot,
      taskId: 373,
      taskTitle: 'Agent repo source modes',
      agentSlug: 'cinder-backend',
    });
    expect(first.error).toBeUndefined();

    const second = ensureTaskClone({
      repoUrl: otherRemotePath,
      workspaceRoot,
      taskId: 373,
      taskTitle: 'Agent repo source modes',
      agentSlug: 'cinder-backend',
    });

    expect(second.created).toBe(false);
    expect(second.error).toContain('origin mismatch');
  });

  it('removes clone workspaces during cleanup', () => {
    const result = ensureTaskClone({
      repoUrl: remotePath,
      workspaceRoot,
      taskId: 373,
      taskTitle: 'Agent repo source modes',
      agentSlug: 'cinder-backend',
    });

    const cleanup = removeTaskClone({ workspacePath: result.workspacePath });
    expect(cleanup.removed).toBe(true);
    expect(fs.existsSync(result.workspacePath)).toBe(false);
  });

  it('links local worktree dependencies from the source repo after creation', () => {
    const apiRoot = path.join(seedPath, 'api');
    fs.mkdirSync(apiRoot, { recursive: true });
    fs.writeFileSync(path.join(apiRoot, 'package.json'), JSON.stringify({
      name: 'api',
      version: '1.0.0',
      devDependencies: { jest: '^30.0.0' },
    }, null, 2));
    fs.writeFileSync(path.join(apiRoot, 'package-lock.json'), JSON.stringify({
      name: 'api',
      lockfileVersion: 3,
      packages: { '': { name: 'api', version: '1.0.0' } },
    }, null, 2));
    execFileSync('git', ['add', 'api/package.json', 'api/package-lock.json'], { cwd: seedPath, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'add api package'], { cwd: seedPath, stdio: 'ignore' });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: seedPath, stdio: 'ignore' });
    fs.mkdirSync(path.join(apiRoot, 'node_modules'), { recursive: true });

    const result = createTaskWorktree({
      repoPath: seedPath,
      basePath: workspaceRoot,
      taskId: 374,
      taskTitle: 'Dependency setup',
      agentSlug: 'cinder-backend',
    });

    expect(result.error).toBeUndefined();
    expect(result.dependencySetup?.find((entry) => entry.packageRoot === 'api')).toMatchObject({
      strategy: 'symlink',
      status: 'prepared',
      source: path.join(apiRoot, 'node_modules'),
      target: path.join(result.workspacePath, 'api', 'node_modules'),
    });
    expect(fs.realpathSync(path.join(result.workspacePath, 'api', 'node_modules'))).toBe(
      fs.realpathSync(path.join(apiRoot, 'node_modules')),
    );
  });
});

describe('repoWorkspaceManager worktree mode base ref fallback', () => {
  let tempRoot: string;
  let repoPath: string;
  let workspaceRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-worktree-mode-'));
    repoPath = path.join(tempRoot, 'repo');
    workspaceRoot = path.join(tempRoot, 'workspaces');

    fs.mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# local only repo\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoPath, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'seed'], { cwd: repoPath, stdio: 'ignore' });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('creates a worktree from a local main branch when origin/main is unavailable', () => {
    const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8' }).trim();

    const result = createTaskWorktree({
      repoPath,
      basePath: workspaceRoot,
      taskId: 375,
      taskTitle: 'Local only repo dispatch',
      agentSlug: 'cinder-backend',
    });

    expect(result.error).toBeUndefined();
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: result.workspacePath, encoding: 'utf-8' }).trim()).toBe(sourceHead);
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: result.workspacePath, encoding: 'utf-8' }).trim()).toBe(result.branch);
  });

  it('falls back to the current local branch when main is unavailable', () => {
    execFileSync('git', ['checkout', '-b', 'bootstrap'], { cwd: repoPath, stdio: 'ignore' });
    execFileSync('git', ['branch', '-D', 'main'], { cwd: repoPath, stdio: 'ignore' });
    const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8' }).trim();

    const result = createTaskWorktree({
      repoPath,
      basePath: workspaceRoot,
      taskId: 376,
      taskTitle: 'Bootstrap only repo dispatch',
      agentSlug: 'cinder-backend',
    });

    expect(result.error).toBeUndefined();
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: result.workspacePath, encoding: 'utf-8' }).trim()).toBe(sourceHead);
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: result.workspacePath, encoding: 'utf-8' }).trim()).toBe(result.branch);
  });

  it('falls back to detached HEAD when no local branch matches', () => {
    execFileSync('git', ['checkout', '-b', 'bootstrap'], { cwd: repoPath, stdio: 'ignore' });
    execFileSync('git', ['branch', '-D', 'main'], { cwd: repoPath, stdio: 'ignore' });
    const detachedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8' }).trim();
    execFileSync('git', ['checkout', detachedHead], { cwd: repoPath, stdio: 'ignore' });

    const result = createTaskWorktree({
      repoPath,
      basePath: workspaceRoot,
      taskId: 377,
      taskTitle: 'Detached head repo dispatch',
      agentSlug: 'cinder-backend',
      baseBranch: 'release',
    });

    expect(result.error).toBeUndefined();
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: result.workspacePath, encoding: 'utf-8' }).trim()).toBe(detachedHead);
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: result.workspacePath, encoding: 'utf-8' }).trim()).toBe(result.branch);
  });
});

describe('resolveWorktreeBasePath', () => {
  it('uses the os user workspace root when provided', () => {
    expect(resolveWorktreeBasePath({ osUser: 'cinder', workspacePath: '/tmp/fallback' })).toBe('/Users/cinder/workspaces');
  });

  it('falls back to workspacePath when no os user is provided', () => {
    expect(resolveWorktreeBasePath({ workspacePath: '/tmp/fallback' })).toBe('/tmp/fallback');
  });
});
