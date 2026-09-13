import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { normalizeEnvironmentSetup, type EnvironmentSetup } from '../lib/environmentSetup';

export type RepoDependencyMode = 'worktree' | 'clone';
export interface RepoWorkspaceDependencySetupResult {
  ecosystem: string;
  packageRoot: string;
  strategy: 'install' | 'skip';
  status: 'prepared' | 'skipped' | 'failed';
  reason?: string;
  command?: string[];
}
export interface DependencyInstallOptions { cwd: string; timeoutMs: number }
export type DependencyInstallRunner = (command: string, args: string[], options: DependencyInstallOptions) => Promise<string>;
export interface PrepareRepoWorkspaceDependenciesParams {
  mode: RepoDependencyMode | null;
  workspacePath?: string | null;
  sourceRepoPath?: string | null;
  setup?: EnvironmentSetup;
  installRunner?: DependencyInstallRunner;
}

// Bounded asynchronous execution keeps dispatch responsive. Kill descendants on
// timeout: package managers routinely spawn additional processes.
export const runSetupCommand: DependencyInstallRunner = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: options.cwd, env: { ...process.env, VIRTUAL_ENV: undefined, CONDA_PREFIX: undefined,
      NODE_ENV: 'development', npm_config_production: undefined, npm_config_omit: undefined,
      CI: 'true', PIP_NO_INPUT: '1', GIT_TERMINAL_PROMPT: '0', npm_config_engine_strict: 'true',
      POETRY_VIRTUALENVS_IN_PROJECT: 'true', POETRY_VIRTUALENVS_CREATE: 'true',
      UV_PROJECT_ENVIRONMENT: '.venv', BUNDLE_PATH: 'vendor/bundle', BUNDLE_FROZEN: 'true', COMPOSER_VENDOR_DIR: 'vendor' },
    stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  let output = '';
  let timedOut = false;
  const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* already exited */ }
  }, options.timeoutMs);
  child.on('error', (error) => { clearTimeout(timer); reject(error); });
  child.on('close', (code) => {
    clearTimeout(timer);
    // Registry output may contain credentials; don't copy it to task errors.
    if (timedOut) reject(new Error(`Setup timed out after ${options.timeoutMs}ms (${command})`));
    else if (code !== 0) reject(new Error(`Setup command ${command} exited with code ${code}`));
    else resolve(output.trim());
  });
});

export function repositoryPath(workspace: string, relative: string): string {
  const root = fs.realpathSync(workspace);
  const candidate = path.resolve(root, relative);
  const inside = (value: string) => value === root || value.startsWith(root + path.sep);
  if (!inside(candidate)) throw new Error(`Setup path escapes repository: ${relative}`);
  let ancestor = candidate;
  while (!fs.existsSync(ancestor)) {
    try { if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error(`Broken setup symlink: ${relative}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    ancestor = path.dirname(ancestor);
  }
  if (!inside(fs.realpathSync(ancestor))) throw new Error(`Setup symlink escapes repository: ${relative}`);
  return candidate;
}

interface Recipe {
  ecosystem: string; commands: string[][]; tools: string[][]; inputs: string[]; outputs: string[];
  requiredToolVersion?: { index: number; version: string };
}
function recipeFor(root: string): Recipe {
  const has = (name: string) => fs.existsSync(path.join(root, name));
  const recipe = (ecosystem: string, commands: string[][], inputs: string[], outputs: string[] = [], tools?: string[][]): Recipe =>
    ({ ecosystem, commands, inputs, outputs, tools: tools ?? [[commands[0][0], '--version']] });
  const families = [has('package.json'), has('pyproject.toml') || has('requirements.txt'), has('Cargo.toml'),
    has('go.mod'), has('pom.xml'), has('composer.json'), has('Gemfile'), has('Package.swift'),
    fs.readdirSync(root).some((file) => /\.(sln|slnx|csproj|fsproj|vbproj)$/.test(file))];
  if (families.filter(Boolean).length > 1) throw new Error('Multiple build systems in one folder; select component folders or use Custom setup');
  if (has('package.json')) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const managers = [
      { name: 'npm', locks: ['package-lock.json', 'npm-shrinkwrap.json'], args: ['ci'] },
      { name: 'pnpm', locks: ['pnpm-lock.yaml'], args: ['install', '--frozen-lockfile'] },
      { name: 'yarn', locks: ['yarn.lock'], args: ['install', '--immutable'] },
      { name: 'bun', locks: ['bun.lock', 'bun.lockb'], args: ['install', '--frozen-lockfile'] },
    ].filter((manager) => manager.locks.some(has));
    const declared = typeof manifest.packageManager === 'string' ? manifest.packageManager.split('@')[0] : null;
    const manager = declared ? managers.find((item) => item.name === declared) : managers.length === 1 ? managers[0] : undefined;
    if (!manager) throw new Error('A matching lockfile and unambiguous package manager are required; use Custom setup otherwise');
    if (manager.name === 'yarn' && (!manifest.packageManager || /^yarn@1\./.test(manifest.packageManager))) manager.args = ['install', '--frozen-lockfile'];
    // Monorepo installs can depend on child manifests. Re-run their restore so
    // those inputs are verified by the package manager instead of an incomplete hash.
    const localDependency = Object.values({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }).some(value => typeof value === 'string' && /^(file:|link:|portal:)/.test(value));
    const hasDependencies = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some(key => Object.keys(manifest[key] ?? {}).length > 0);
    const localOutputs = manager.name === 'yarn' || manifest.workspaces || has('pnpm-workspace.yaml') || localDependency || !hasDependencies ? [] : ['node_modules'];
    const tools = manager.name === 'bun' ? [['bun', '--version']] : [['node', '--version'], [manager.name, '--version']];
    const selected = recipe(manager.name, [[manager.name, ...manager.args]],
      ['package.json', ...manager.locks, '.npmrc', '.yarnrc.yml', 'pnpm-workspace.yaml'], localOutputs, tools);
    const pinnedVersion = manifest.packageManager?.match(/^[^@]+@(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:\+.*)?$/)?.[1];
    if (pinnedVersion) selected.requiredToolVersion = { index: tools.length - 1, version: pinnedVersion };
    return selected;
  }
  if (has('uv.lock') && has('poetry.lock')) throw new Error('Multiple Python lockfiles; choose the package manager in Custom setup');
  if (has('uv.lock')) return recipe('uv', [['uv', 'sync', '--locked']], ['pyproject.toml', 'uv.lock', '.python-version']);
  if (has('poetry.lock')) return recipe('poetry', [['poetry', 'install', '--no-interaction']], ['pyproject.toml', 'poetry.lock']);
  if (has('requirements.txt')) return recipe('pip', [
    ['python3', '-m', 'venv', '.venv'],
    [path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), '-m', 'pip', 'install', '-r', 'requirements.txt'],
  ], ['requirements.txt', '.python-version'], [], [['python3', '--version']]);
  if (has('Cargo.lock')) return recipe('cargo', [['cargo', 'fetch', '--locked']], ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml']);
  if (has('go.mod')) return recipe('go', [['go', 'mod', 'download']], ['go.mod', 'go.sum', 'go.work']);
  if (has('pom.xml')) return recipe('maven', [[has('mvnw') ? './mvnw' : 'mvn', '-B', 'dependency:go-offline']], ['pom.xml', '.mvn/wrapper/maven-wrapper.properties'], [], [['java', '-version']]);
  if (has('composer.lock')) return recipe('composer', [['composer', 'install', '--no-interaction', '--prefer-dist']], ['composer.json', 'composer.lock'], [], [['php', '--version'], ['composer', '--version']]);
  if (has('Gemfile.lock')) return recipe('bundler', [['bundle', 'install']], ['Gemfile', 'Gemfile.lock', '.ruby-version'], [], [['ruby', '--version'], ['bundle', '--version']]);
  if (has('Package.swift')) return recipe('swift', [['swift', 'package', 'resolve']], ['Package.swift', 'Package.resolved']);
  if (families[8]) return recipe('dotnet', [['dotnet', 'restore']], ['global.json', 'NuGet.Config', 'packages.lock.json']);
  throw new Error('No automatic setup recipe for this folder. Use Custom setup to run its setup script, build tool, or container command');
}

export async function prepareRepoWorkspaceDependencies(params: PrepareRepoWorkspaceDependenciesParams): Promise<RepoWorkspaceDependencySetupResult[]> {
  const setup = normalizeEnvironmentSetup(params.setup);
  const result = (status: 'skipped' | 'failed', reason: string): RepoWorkspaceDependencySetupResult[] =>
    [{ ecosystem: 'environment', packageRoot: '.', strategy: 'skip', status, reason }];
  if (setup.mode === 'off') return result('skipped', 'environment_setup_off');
  if (!params.mode || !params.workspacePath) return result('failed', 'Environment setup requires a repository workspace');
  let workspace: string;
  try { workspace = fs.realpathSync(params.workspacePath); }
  catch { return result('failed', 'Repository workspace does not exist'); }
  const runner = params.installRunner ?? runSetupCommand;
  const results: RepoWorkspaceDependencySetupResult[] = [];
  const deadline = Date.now() + setup.timeoutSeconds * 1000;
  const run = (command: string[], cwd: string) => {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new Error('Environment setup exceeded its time budget');
    return runner(command[0], command.slice(1), { cwd, timeoutMs });
  };
  try {
    if (setup.mode === 'custom') {
      // Any toolchain can supply a command (for example mise run setup).
      // Custom commands always run: we cannot infer their complete inputs/outputs.
      for (const step of setup.steps) {
        const cwd = repositoryPath(workspace, step.cwd);
        await run(step.command, cwd);
        results.push({ ecosystem: 'custom', packageRoot: step.cwd, strategy: 'install', status: 'prepared', command: step.command });
      }
      return results;
    }
    for (const relative of [...new Set(setup.roots)]) {
      const root = repositoryPath(workspace, relative);
      const recipe = recipeFor(root);
      for (const output of ['node_modules', '.venv', 'vendor']) {
        try {
          if (fs.lstatSync(path.join(root, output)).isSymbolicLink()) throw new Error(`Remove the shared ${output} symlink in ${relative} before preparing this workspace`);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const versions = [];
      for (const tool of recipe.tools) versions.push(await run(tool, root));
      if (recipe.requiredToolVersion) {
        const { index, version } = recipe.requiredToolVersion;
        if (versions[index].trim() !== version) throw new Error(`Project requires ${recipe.tools[index][0]} ${version}; install that version or use Custom setup`);
      }
      const digest = crypto.createHash('sha256').update(JSON.stringify({ setup, recipe, versions, platform: process.platform, arch: process.arch }));
      for (const input of recipe.inputs) {
        const file = repositoryPath(workspace, path.relative(workspace, path.join(root, input)));
        digest.update(input).update(fs.existsSync(file) ? fs.readFileSync(file) : '<missing>');
      }
      const fingerprint = digest.digest('hex');
      fs.mkdirSync(repositoryPath(workspace, '.agent-hq-setup'), { recursive: true });
      const statePath = repositoryPath(workspace, `.agent-hq-setup/${crypto.createHash('sha256').update(relative).digest('hex')}.json`);
      let previous: { fingerprint?: string } = {};
      try { previous = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* first preparation */ }
      const reusable = recipe.outputs.length > 0 && recipe.outputs.every((output) => fs.existsSync(repositoryPath(root, output)));
      if (reusable && previous.fingerprint === fingerprint) {
        results.push({ ecosystem: recipe.ecosystem, packageRoot: relative, strategy: 'skip', status: 'prepared', reason: 'unchanged_environment' });
        continue;
      }
      fs.rmSync(statePath, { force: true });
      for (const command of recipe.commands) await run(command, root);
      if (recipe.outputs.some((output) => !fs.existsSync(repositoryPath(root, output)))) throw new Error(`Setup did not produce the expected ${recipe.ecosystem} environment in ${relative}`);
      fs.writeFileSync(statePath, JSON.stringify({ fingerprint, ecosystem: recipe.ecosystem, root: relative }));
      results.push({ ecosystem: recipe.ecosystem, packageRoot: relative, strategy: 'install', status: 'prepared', command: recipe.commands[0] });
    }
  } catch (error) {
    results.push(...result('failed', error instanceof Error ? error.message : String(error)));
  }
  return results;
}
