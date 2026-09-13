import fs from 'fs';
import os from 'os';
import path from 'path';
import { prepareRepoWorkspaceDependencies, runSetupCommand, type DependencyInstallRunner } from './repoWorkspaceDependencies';
import { normalizeEnvironmentSetup } from '../lib/environmentSetup';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-setup-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function write(file: string, content = file.endsWith('package.json') ? '{"dependencies":{"example":"1.0.0"}}' : '{}') { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), content); }
const automatic = (roots = ['.']) => normalizeEnvironmentSetup({ mode: 'auto', roots });
function runner(): jest.MockedFunction<DependencyInstallRunner> {
  return jest.fn(async (command, args, options) => {
    if (args.includes('--version') || args.includes('-version')) return '1.0.0';
    if (['npm', 'pnpm', 'bun'].includes(command)) fs.mkdirSync(path.join(options.cwd, 'node_modules'), { recursive: true });
    if (command === 'composer') fs.mkdirSync(path.join(options.cwd, 'vendor'), { recursive: true });
    return '';
  });
}

it.each(['clone', 'worktree'] as const)('leaves %s checkout unprepared by default', async mode => {
  write('package.json'); write('package-lock.json');
  const installRunner = runner();
  expect(await prepareRepoWorkspaceDependencies({ mode, workspacePath: root, installRunner })).toEqual([expect.objectContaining({ status: 'skipped', reason: 'environment_setup_off' })]);
  expect(installRunner).not.toHaveBeenCalled();
});
it.each([
  ['package.json', 'package-lock.json', 'npm', ['ci']],
  ['package.json', 'pnpm-lock.yaml', 'pnpm', ['install', '--frozen-lockfile']],
  ['package.json', 'yarn.lock', 'yarn', ['install', '--frozen-lockfile']],
  ['package.json', 'bun.lock', 'bun', ['install', '--frozen-lockfile']],
  ['pyproject.toml', 'uv.lock', 'uv', ['sync', '--locked']],
  ['pyproject.toml', 'poetry.lock', 'poetry', ['install', '--no-interaction']],
  ['Cargo.toml', 'Cargo.lock', 'cargo', ['fetch', '--locked']],
  ['go.mod', 'go.sum', 'go', ['mod', 'download']],
  ['pom.xml', 'pom.xml', 'mvn', ['-B', 'dependency:go-offline']],
  ['composer.json', 'composer.lock', 'composer', ['install', '--no-interaction', '--prefer-dist']],
  ['Gemfile', 'Gemfile.lock', 'bundle', ['install']],
  ['Package.swift', 'Package.resolved', 'swift', ['package', 'resolve']],
  ['App.csproj', 'packages.lock.json', 'dotnet', ['restore']],
] as Array<[string, string, string, string[]]>)('detects %s and uses its own tool', async (manifest, lock, command, args) => {
  write(manifest); write(lock);
  const installRunner = runner();
  const results = await prepareRepoWorkspaceDependencies({ mode: 'clone', workspacePath: root, setup: automatic(), installRunner });
  expect(results[0].status).toBe('prepared');
  expect(installRunner).toHaveBeenCalledWith(command, args, expect.objectContaining({ cwd: fs.realpathSync(root) }));
});
it('prepares only selected folders and reuses unchanged local dependencies', async () => {
  for (const dir of ['api', 'ui']) { write(`${dir}/package.json`); write(`${dir}/package-lock.json`); }
  const installRunner = runner();
  const params = { mode: 'worktree' as const, workspacePath: root, setup: automatic(['api']), installRunner };
  await prepareRepoWorkspaceDependencies(params);
  expect(fs.existsSync(path.join(root, 'ui/node_modules'))).toBe(false);
  expect((await prepareRepoWorkspaceDependencies(params))[0].reason).toBe('unchanged_environment');
  write('api/package-lock.json', '{"changed":true}');
  expect((await prepareRepoWorkspaceDependencies(params))[0].strategy).toBe('install');
  fs.rmSync(path.join(root, 'api/node_modules'), { recursive: true });
  expect((await prepareRepoWorkspaceDependencies(params))[0].strategy).toBe('install');
});
it('does not cache workspace packages with child manifest inputs', async () => {
  write('package.json', '{"workspaces":["packages/*"]}'); write('package-lock.json');
  const params = { mode: 'clone' as const, workspacePath: root, setup: automatic(), installRunner: runner() };
  await prepareRepoWorkspaceDependencies(params);
  expect((await prepareRepoWorkspaceDependencies(params))[0].strategy).toBe('install');
});
it('does not reuse an environment after a failed preparation', async () => {
  write('package.json'); write('package-lock.json');
  const installRunner = runner();
  const params = { mode: 'clone' as const, workspacePath: root, setup: automatic(), installRunner };
  await prepareRepoWorkspaceDependencies(params);
  write('package-lock.json', '{"changed":true}');
  installRunner.mockImplementation(async () => { throw new Error('tool missing'); });
  expect((await prepareRepoWorkspaceDependencies(params))[0].status).toBe('failed');
  params.installRunner = runner();
  expect((await prepareRepoWorkspaceDependencies(params))[0].strategy).toBe('install');
});
it('fails on unknown or ambiguous layouts instead of silently succeeding', async () => {
  expect((await prepareRepoWorkspaceDependencies({ mode: 'clone', workspacePath: root, setup: automatic(), installRunner: runner() }))[0].status).toBe('failed');
  write('package.json'); write('package-lock.json'); write('yarn.lock');
  expect((await prepareRepoWorkspaceDependencies({ mode: 'clone', workspacePath: root, setup: automatic(), installRunner: runner() }))[0].reason).toMatch(/unambiguous/);
});
it('rejects paths and dependency links outside the workspace', async () => {
  expect(() => automatic(['../outside'])).toThrow(/relative/);
  fs.symlinkSync(os.tmpdir(), path.join(root, 'outside'));
  expect((await prepareRepoWorkspaceDependencies({ mode: 'clone', workspacePath: root, setup: automatic(['outside']), installRunner: runner() }))[0].reason).toMatch(/escapes/);
  write('package.json'); write('package-lock.json');
  fs.symlinkSync(os.tmpdir(), path.join(root, 'node_modules'));
  expect((await prepareRepoWorkspaceDependencies({ mode: 'worktree', workspacePath: root, setup: automatic(), installRunner: runner() }))[0].reason).toMatch(/shared/);
});
it('runs a language-independent project command and propagates failure', async () => {
  const setup = normalizeEnvironmentSetup({ mode: 'custom', steps: [{ command: [process.execPath, '-e', "require('fs').writeFileSync('prepared.txt', 'ok')"] }] });
  expect((await prepareRepoWorkspaceDependencies({ mode: 'clone', workspacePath: root, setup }))[0].status).toBe('prepared');
  expect(fs.readFileSync(path.join(root, 'prepared.txt'), 'utf8')).toBe('ok');
  await expect(runSetupCommand(process.execPath, ['-e', 'process.exit(7)'], { cwd: root, timeoutMs: 1000 })).rejects.toThrow(/code 7/);
  await expect(runSetupCommand(process.execPath, ['-e', 'setInterval(() => {}, 100)'], { cwd: root, timeoutMs: 100 })).rejects.toThrow(/timed out/);
});
it('stops custom steps at the first failure and requires a workspace', async () => {
  const installRunner = runner(); installRunner.mockRejectedValue(new Error('failed'));
  const setup = normalizeEnvironmentSetup({ mode: 'custom', steps: [{ command: ['mise', 'install'] }, { command: ['mise', 'run', 'setup'] }] });
  expect((await prepareRepoWorkspaceDependencies({ mode: null, setup, installRunner }))[0].status).toBe('failed');
  expect(installRunner).not.toHaveBeenCalled();
  expect((await prepareRepoWorkspaceDependencies({ mode: 'clone', workspacePath: root, setup, installRunner }))[0].status).toBe('failed');
  expect(installRunner).toHaveBeenCalledTimes(1);
});

it('does not require Node for a Bun-only project', async () => {
  write('package.json'); write('bun.lock');
  const installRunner = runner();
  const result = await prepareRepoWorkspaceDependencies({ mode: 'clone', workspacePath: root, setup: automatic(), installRunner });
  expect(result[0].status).toBe('prepared');
  expect(installRunner.mock.calls.some(([command]) => command === 'node')).toBe(false);
});
it('honors the pinned package-manager version before installing', async () => {
  write('package.json', JSON.stringify({ packageManager: 'pnpm@10.0.0', dependencies: { example: '1.0.0' } })); write('pnpm-lock.yaml');
  const installRunner = runner();
  const result = await prepareRepoWorkspaceDependencies({ mode: 'clone', workspacePath: root, setup: automatic(), installRunner });
  expect(result[0].reason).toMatch(/requires pnpm 10.0.0/);
  expect(installRunner.mock.calls.some(([, args]) => args[0] === 'install')).toBe(false);
});
it('includes development dependencies independently of the API process environment', async () => {
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  try {
    const output = await runSetupCommand(process.execPath, ['-e', 'process.stdout.write(process.env.NODE_ENV)'], { cwd: root, timeoutMs: 1000 });
    expect(output).toBe('development');
  } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});
