import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type RepoDependencyMode = 'worktree' | 'clone';
export type RepoDependencyEcosystem = 'node-npm';
export type RepoDependencyStrategy = 'symlink' | 'install' | 'skip';
export type RepoDependencyStatus = 'prepared' | 'skipped' | 'failed';

export interface RepoWorkspaceDependencySetupResult {
  ecosystem: RepoDependencyEcosystem;
  packageRoot: string;
  strategy: RepoDependencyStrategy;
  status: RepoDependencyStatus;
  reason?: string;
  source?: string | null;
  target?: string | null;
  command?: string[];
}

export interface DependencyInstallOptions {
  cwd: string;
  timeoutMs: number;
}

export type DependencyInstallRunner = (
  command: string,
  args: string[],
  options: DependencyInstallOptions,
) => void;

export interface PrepareRepoWorkspaceDependenciesParams {
  mode: RepoDependencyMode | null;
  workspacePath?: string | null;
  sourceRepoPath?: string | null;
  installRunner?: DependencyInstallRunner;
}

interface NpmPackageRoot {
  relativePath: string;
  absolutePath: string;
}

const EXCLUDED_DIRS = new Set([
  '.git',
  '.next',
  'coverage',
  'dist',
  'build',
  'node_modules',
]);

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

const NPM_INSTALL_TIMEOUT_MS = 180_000;

function defaultInstallRunner(command: string, args: string[], options: DependencyInstallOptions): void {
  execFileSync(command, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function normalizeRelativePath(rootPath: string, packagePath: string): string {
  const relative = path.relative(rootPath, packagePath);
  return relative === '' ? '.' : relative;
}

function lstatOrNull(targetPath: string): fs.Stats | null {
  try {
    return fs.lstatSync(targetPath);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

function packageDeclaresDependencies(packageJsonPath: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as Record<string, unknown>;
    return DEPENDENCY_FIELDS.some((field) => {
      const value = parsed[field];
      return !!value && typeof value === 'object' && Object.keys(value).length > 0;
    });
  } catch {
    return false;
  }
}

function discoverNpmPackageRoots(workspacePath: string): NpmPackageRoot[] {
  const roots: NpmPackageRoot[] = [];

  function visit(dir: string): void {
    const packageJsonPath = path.join(dir, 'package.json');
    const packageLockPath = path.join(dir, 'package-lock.json');
    if (
      fs.existsSync(packageJsonPath) &&
      fs.existsSync(packageLockPath) &&
      packageDeclaresDependencies(packageJsonPath)
    ) {
      roots.push({
        relativePath: normalizeRelativePath(workspacePath, dir),
        absolutePath: dir,
      });
    }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name)) continue;
      visit(path.join(dir, entry.name));
    }
  }

  if (workspacePath && fs.existsSync(workspacePath)) {
    visit(workspacePath);
  }

  return roots.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function hashFile(filePath: string): string | null {
  try {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
  } catch {
    return null;
  }
}

function skippedResult(reason: string): RepoWorkspaceDependencySetupResult[] {
  return [{
    ecosystem: 'node-npm',
    packageRoot: '.',
    strategy: 'skip',
    status: 'skipped',
    reason,
  }];
}

function resolveSymlinkTarget(linkPath: string, rawTarget: string): string {
  return path.resolve(path.dirname(linkPath), rawTarget);
}

function setupWorktreeNpmDependencies(params: {
  packageRoot: NpmPackageRoot;
  workspacePath: string;
  sourceRepoPath: string;
}): RepoWorkspaceDependencySetupResult {
  const { packageRoot, sourceRepoPath } = params;
  const sourcePackageRoot = path.join(sourceRepoPath, packageRoot.relativePath);
  const sourceLockfile = path.join(sourcePackageRoot, 'package-lock.json');
  const workspaceLockfile = path.join(packageRoot.absolutePath, 'package-lock.json');
  const sourceNodeModules = path.join(sourcePackageRoot, 'node_modules');
  const workspaceNodeModules = path.join(packageRoot.absolutePath, 'node_modules');
  const baseResult = {
    ecosystem: 'node-npm' as const,
    packageRoot: packageRoot.relativePath,
    strategy: 'symlink' as const,
    source: sourceNodeModules,
    target: workspaceNodeModules,
  };

  if (!fs.existsSync(sourceLockfile)) {
    return { ...baseResult, status: 'skipped', reason: 'source_lockfile_missing' };
  }

  if (hashFile(sourceLockfile) !== hashFile(workspaceLockfile)) {
    return { ...baseResult, status: 'skipped', reason: 'lockfile_mismatch' };
  }

  const sourceStats = lstatOrNull(sourceNodeModules);
  if (!sourceStats || (!sourceStats.isDirectory() && !sourceStats.isSymbolicLink())) {
    return { ...baseResult, status: 'skipped', reason: 'source_dependencies_missing' };
  }

  const existingStats = lstatOrNull(workspaceNodeModules);
  if (existingStats?.isSymbolicLink()) {
    const currentTarget = resolveSymlinkTarget(
      workspaceNodeModules,
      fs.readlinkSync(workspaceNodeModules),
    );
    if (currentTarget === sourceNodeModules) {
      return { ...baseResult, status: 'prepared', reason: 'already_linked' };
    }
    fs.unlinkSync(workspaceNodeModules);
  } else if (existingStats) {
    return { ...baseResult, status: 'skipped', reason: 'existing_dependency_dir' };
  }

  fs.symlinkSync(sourceNodeModules, workspaceNodeModules, 'dir');
  return { ...baseResult, status: 'prepared' };
}

function setupCloneNpmDependencies(params: {
  packageRoot: NpmPackageRoot;
  installRunner: DependencyInstallRunner;
}): RepoWorkspaceDependencySetupResult {
  const { packageRoot, installRunner } = params;
  const command = ['npm', 'ci'];
  const baseResult = {
    ecosystem: 'node-npm' as const,
    packageRoot: packageRoot.relativePath,
    strategy: 'install' as const,
    target: path.join(packageRoot.absolutePath, 'node_modules'),
    command,
  };

  try {
    installRunner(command[0], command.slice(1), {
      cwd: packageRoot.absolutePath,
      timeoutMs: NPM_INSTALL_TIMEOUT_MS,
    });
    return { ...baseResult, status: 'prepared' };
  } catch (err) {
    return {
      ...baseResult,
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export function prepareRepoWorkspaceDependencies(
  params: PrepareRepoWorkspaceDependenciesParams,
): RepoWorkspaceDependencySetupResult[] {
  const { mode, workspacePath, sourceRepoPath, installRunner = defaultInstallRunner } = params;

  if (!mode || !workspacePath) {
    return skippedResult('no_repo_source');
  }

  const packageRoots = discoverNpmPackageRoots(workspacePath);
  if (packageRoots.length === 0) {
    return skippedResult('no_supported_package_roots');
  }

  if (mode === 'worktree') {
    if (!sourceRepoPath) {
      return skippedResult('no_repo_source');
    }
    return packageRoots.map((packageRoot) => setupWorktreeNpmDependencies({
      packageRoot,
      workspacePath,
      sourceRepoPath,
    }));
  }

  return packageRoots.map((packageRoot) => setupCloneNpmDependencies({
    packageRoot,
    installRunner,
  }));
}
