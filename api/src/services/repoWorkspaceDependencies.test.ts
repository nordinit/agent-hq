import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  prepareRepoWorkspaceDependencies,
  type DependencyInstallRunner,
} from './repoWorkspaceDependencies';

function writeNpmPackage(root: string, relPath: string, lockMarker = 'same'): string {
  const packageRoot = path.join(root, relPath);
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: relPath || 'root',
    version: '1.0.0',
    devDependencies: { typescript: '^5.0.0' },
  }, null, 2));
  fs.writeFileSync(path.join(packageRoot, 'package-lock.json'), JSON.stringify({
    name: relPath || 'root',
    lockfileVersion: 3,
    packages: { '': { name: relPath || 'root', version: '1.0.0' } },
    marker: lockMarker,
  }, null, 2));
  return packageRoot;
}

describe('repoWorkspaceDependencies', () => {
  let tempRoot: string;
  let sourceRepoPath: string;
  let workspacePath: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-deps-'));
    sourceRepoPath = path.join(tempRoot, 'source');
    workspacePath = path.join(tempRoot, 'workspace');
    fs.mkdirSync(sourceRepoPath, { recursive: true });
    fs.mkdirSync(workspacePath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('symlinks npm dependencies from a local source repo when lockfiles match', () => {
    const sourcePackageRoot = writeNpmPackage(sourceRepoPath, 'api');
    writeNpmPackage(workspacePath, 'api');
    fs.mkdirSync(path.join(sourcePackageRoot, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(sourcePackageRoot, 'node_modules', '.bin', 'jest'), '');

    const results = prepareRepoWorkspaceDependencies({
      mode: 'worktree',
      sourceRepoPath,
      workspacePath,
    });

    const apiResult = results.find((result) => result.packageRoot === 'api');
    expect(apiResult).toMatchObject({
      ecosystem: 'node-npm',
      strategy: 'symlink',
      status: 'prepared',
      source: path.join(sourcePackageRoot, 'node_modules'),
      target: path.join(workspacePath, 'api', 'node_modules'),
    });
    expect(fs.lstatSync(path.join(workspacePath, 'api', 'node_modules')).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(workspacePath, 'api', 'node_modules'))).toBe(
      fs.realpathSync(path.join(sourcePackageRoot, 'node_modules')),
    );
  });

  it('skips local symlink setup when lockfiles do not match', () => {
    const sourcePackageRoot = writeNpmPackage(sourceRepoPath, 'api', 'source');
    writeNpmPackage(workspacePath, 'api', 'workspace');
    fs.mkdirSync(path.join(sourcePackageRoot, 'node_modules'), { recursive: true });

    const results = prepareRepoWorkspaceDependencies({
      mode: 'worktree',
      sourceRepoPath,
      workspacePath,
    });

    expect(results.find((result) => result.packageRoot === 'api')).toMatchObject({
      strategy: 'symlink',
      status: 'skipped',
      reason: 'lockfile_mismatch',
    });
    expect(fs.existsSync(path.join(workspacePath, 'api', 'node_modules'))).toBe(false);
  });

  it('does not replace an existing real dependency directory in a local worktree', () => {
    const sourcePackageRoot = writeNpmPackage(sourceRepoPath, 'api');
    writeNpmPackage(workspacePath, 'api');
    fs.mkdirSync(path.join(sourcePackageRoot, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, 'api', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, 'api', 'node_modules', 'marker'), 'keep');

    const results = prepareRepoWorkspaceDependencies({
      mode: 'worktree',
      sourceRepoPath,
      workspacePath,
    });

    expect(results.find((result) => result.packageRoot === 'api')).toMatchObject({
      strategy: 'symlink',
      status: 'skipped',
      reason: 'existing_dependency_dir',
    });
    expect(fs.readFileSync(path.join(workspacePath, 'api', 'node_modules', 'marker'), 'utf-8')).toBe('keep');
  });

  it('replaces a stale dependency symlink in a local worktree', () => {
    const sourcePackageRoot = writeNpmPackage(sourceRepoPath, 'api');
    writeNpmPackage(workspacePath, 'api');
    const oldTarget = path.join(tempRoot, 'old-node-modules');
    fs.mkdirSync(path.join(sourcePackageRoot, 'node_modules'), { recursive: true });
    fs.mkdirSync(oldTarget, { recursive: true });
    fs.symlinkSync(oldTarget, path.join(workspacePath, 'api', 'node_modules'), 'dir');

    const results = prepareRepoWorkspaceDependencies({
      mode: 'worktree',
      sourceRepoPath,
      workspacePath,
    });

    expect(results.find((result) => result.packageRoot === 'api')).toMatchObject({
      strategy: 'symlink',
      status: 'prepared',
    });
    expect(fs.realpathSync(path.join(workspacePath, 'api', 'node_modules'))).toBe(
      fs.realpathSync(path.join(sourcePackageRoot, 'node_modules')),
    );
  });

  it('runs npm ci for remote clone workspaces', () => {
    const packageRoot = writeNpmPackage(workspacePath, 'api');
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const installRunner: DependencyInstallRunner = (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      fs.mkdirSync(path.join(options.cwd, 'node_modules'), { recursive: true });
    };

    const results = prepareRepoWorkspaceDependencies({
      mode: 'clone',
      workspacePath,
      installRunner,
    });

    expect(results.find((result) => result.packageRoot === 'api')).toMatchObject({
      strategy: 'install',
      status: 'prepared',
      command: ['npm', 'ci'],
    });
    expect(calls).toEqual([{ command: 'npm', args: ['ci'], cwd: packageRoot }]);
  });

  it('skips when no repo source is available', () => {
    expect(prepareRepoWorkspaceDependencies({ mode: null })).toEqual([{
      ecosystem: 'node-npm',
      packageRoot: '.',
      strategy: 'skip',
      status: 'skipped',
      reason: 'no_repo_source',
    }]);
  });
});
