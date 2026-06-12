/**
 * local.mjs — No-Docker mode: run Agent HQ API + UI as local Node processes.
 *
 * Source is fetched from GitHub on first run and cached in ~/.agent-hq/source/.
 * Processes are managed via PID files stored in ~/.agent-hq/local.json.
 */

import { execSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  rmSync,
  cpSync,
  lstatSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DATA_DIR = join(homedir(), '.agent-hq');
const SOURCE_DIR = join(DATA_DIR, 'source');
const STATE_FILE = join(DATA_DIR, 'local.json');
const DB_PATH = join(DATA_DIR, 'agent-hq.db');
const REPO_URL = 'https://github.com/nordinit/agent-hq.git';
const OPENCLAW_HOME = join(homedir(), '.openclaw');
const OPENCLAW_INSTALL_DIR = OPENCLAW_HOME;
const OPENCLAW_BIN_DIR = join(OPENCLAW_INSTALL_DIR, 'node_modules', '.bin');
const OPENCLAW_CLI_ENTRY = join(OPENCLAW_INSTALL_DIR, 'node_modules', 'openclaw', 'openclaw.mjs');
const OPENCLAW_DIST_ENTRY = join(OPENCLAW_INSTALL_DIR, 'node_modules', 'openclaw', 'dist', 'index.js');
const OPENCLAW_GATEWAY_CMD = join(OPENCLAW_HOME, 'gateway.cmd');
const OPENCLAW_CONFIG_FILE = join(OPENCLAW_HOME, 'openclaw.json');
const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url));
const AGENT_HQ_OPENCLAW_PLUGIN_ID = 'agent-hq-capability-tools';
const AGENT_HQ_OPENCLAW_PLUGIN_RELATIVE_PATH = join('plugins', 'openclaw-capability-tools');

// ── Helpers ──────────────────────────────────────────────────────────────────

function die(msg) {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`);
  process.exit(1);
}

function info(msg) {
  console.log(`\x1b[36mℹ\x1b[0m ${msg}`);
}

function success(msg) {
  console.log(`\x1b[32m✓\x1b[0m ${msg}`);
}

function warn(msg) {
  console.log(`\x1b[33m⚠\x1b[0m ${msg}`);
}

/** Read the local state file (PIDs, mode). */
function readState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** Write state. */
function writeState(state) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** Remove state file. */
function clearState() {
  if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
}

/** Check whether a PID is still alive. */
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Run a command synchronously with inherited stdio, abort on failure. */
function run(cmd, opts = {}) {
  try {
    execSync(cmd, { stdio: 'inherit', ...opts });
  } catch (e) {
    die(`Command failed: ${cmd}`);
  }
}

/** Check if git is available. */
function hasGit() {
  try {
    runCommandSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function buildPathWith(extraDirs = []) {
  const currentPath = process.env.PATH ?? '';
  const parts = [...extraDirs.filter(Boolean), ...currentPath.split(delimiter).filter(Boolean)];
  return Array.from(new Set(parts)).join(delimiter);
}

function bundledOpenClawCandidates() {
  if (process.platform === 'win32') {
    return [
      join(OPENCLAW_BIN_DIR, 'openclaw.cmd'),
      join(OPENCLAW_BIN_DIR, 'openclaw.exe'),
      join(OPENCLAW_BIN_DIR, 'openclaw'),
    ];
  }
  return [join(OPENCLAW_BIN_DIR, 'openclaw')];
}

function resolveBundledOpenClawExecutable() {
  return bundledOpenClawCandidates().find(candidate => existsSync(candidate)) ?? null;
}

function shouldUseShell(executable) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
}

function quoteWindowsArg(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function runCommandSync(executable, args, opts = {}) {
  const result = spawnSync(executable, args, {
    ...opts,
    shell: shouldUseShell(executable),
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    const stderr = (result.stderr ?? '').toString().trim();
    const stdout = (result.stdout ?? '').toString().trim();
    throw new Error(stderr || stdout || `${executable} exited with status ${result.status}`);
  }

  return opts.encoding ? result.stdout : result.stdout?.toString() ?? '';
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function canRunOpenClaw(executable, extraPathDirs = []) {
  try {
    runCommandSync(executable, ['--version'], {
      stdio: 'pipe',
      env: {
        ...process.env,
        PATH: buildPathWith(extraPathDirs),
      },
    });
    return true;
  } catch {
    return false;
  }
}

function resolveOpenClawExecutable() {
  const bundled = resolveBundledOpenClawExecutable();
  if (bundled && canRunOpenClaw(bundled, [OPENCLAW_BIN_DIR])) {
    return bundled;
  }
  if (canRunOpenClaw('openclaw', [OPENCLAW_BIN_DIR])) {
    return 'openclaw';
  }
  return bundled ?? 'openclaw';
}

function repairOpenClawGatewayCommand() {
  if (process.platform !== 'win32') return;
  const cliEntry = existsSync(OPENCLAW_CLI_ENTRY) ? OPENCLAW_CLI_ENTRY : OPENCLAW_DIST_ENTRY;
  if (!existsSync(cliEntry)) return;

  let version = '';
  try {
    const pkg = JSON.parse(readFileSync(join(OPENCLAW_INSTALL_DIR, 'node_modules', 'openclaw', 'package.json'), 'utf8'));
    version = typeof pkg.version === 'string' ? pkg.version.trim() : '';
  } catch {
    version = '';
  }

  const home = process.env.HOME ?? homedir();
  const tmpDir = process.env.TMPDIR ?? process.env.TEMP ?? join(home, 'AppData', 'Local', 'Temp');
  const port = process.env.OPENCLAW_GATEWAY_PORT ?? '18789';
  const next = [
    '@echo off',
    version ? `rem OpenClaw Gateway (v${version})` : 'rem OpenClaw Gateway',
    `set "HOME=${home}"`,
    `set "TMPDIR=${tmpDir}"`,
    `set "OPENCLAW_GATEWAY_PORT=${port}"`,
    'set "OPENCLAW_SYSTEMD_UNIT=openclaw-gateway.service"',
    'set "OPENCLAW_WINDOWS_TASK_NAME=OpenClaw Gateway"',
    'set "OPENCLAW_SERVICE_MARKER=openclaw"',
    'set "OPENCLAW_SERVICE_KIND=gateway"',
    ...(version ? [`set "OPENCLAW_SERVICE_VERSION=${version}"`] : []),
    `${quoteWindowsArg(process.execPath)} ${quoteWindowsArg(cliEntry)} gateway --port ${port}`,
    '',
  ].join('\r\n');

  const current = existsSync(OPENCLAW_GATEWAY_CMD) ? readFileSync(OPENCLAW_GATEWAY_CMD, 'utf8') : '';
  if (current !== next) {
    writeFileSync(OPENCLAW_GATEWAY_CMD, next);
  }
}

function ensureFreshInstallGatewayMode() {
  let config = {};

  if (existsSync(OPENCLAW_CONFIG_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(OPENCLAW_CONFIG_FILE, 'utf8'));
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        warn('Fresh OpenClaw config has an unexpected shape. Leaving gateway.mode unchanged.');
        return false;
      }
      config = parsed;
    } catch {
      warn('Fresh OpenClaw config could not be parsed. Leaving gateway.mode unchanged.');
      return false;
    }
  }

  const gateway = config.gateway;
  if (gateway && typeof gateway === 'object' && !Array.isArray(gateway)) {
    if (typeof gateway.mode === 'string' && gateway.mode.trim()) {
      return false;
    }
    config.gateway = { ...gateway, mode: 'local' };
  } else {
    config.gateway = { mode: 'local' };
  }

  mkdirSync(OPENCLAW_HOME, { recursive: true });
  writeFileSync(OPENCLAW_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
  info('Configured OpenClaw gateway.mode=local for the fresh install.');
  return true;
}

function isAgentHqSourceDir(dir) {
  return (
    existsSync(join(dir, 'api', 'package.json')) &&
    existsSync(join(dir, 'ui', 'package.json'))
  );
}

function readJsonObjectFile(filePath) {
  if (!existsSync(filePath)) return {};
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${filePath} does not contain a JSON object`);
  }
  return parsed;
}

function appendUnique(values, value) {
  const current = Array.isArray(values) ? values : [];
  return current.includes(value) ? current : [...current, value];
}

function readPluginVersion(pluginDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

function ensureAgentHqOpenClawPluginConfig(sourceDir) {
  const pluginDir = join(sourceDir, AGENT_HQ_OPENCLAW_PLUGIN_RELATIVE_PATH);
  if (!existsSync(join(pluginDir, 'openclaw.plugin.json'))) {
    warn(`Agent HQ OpenClaw capability tools plugin was not found at ${pluginDir}.`);
    return false;
  }
  return configureOpenClawPluginAt(pluginDir);
}

/**
 * Docker mode has no source checkout, so the plugin ships inside the npm
 * package (cli/plugin, generated at pack time). Copy it to a stable path under
 * the data dir — npx caches are ephemeral, and openclaw.json keeps an absolute
 * path — then wire it into the OpenClaw config.
 */
export function ensureBundledOpenClawPluginConfig() {
  const candidates = [
    // Published package layout: <package root>/plugin
    join(MODULE_DIR, '..', 'plugin'),
    // Repo checkout layout: <repo root>/plugins/openclaw-capability-tools
    join(MODULE_DIR, '..', '..', AGENT_HQ_OPENCLAW_PLUGIN_RELATIVE_PATH),
  ];
  const source = candidates.find((dir) => existsSync(join(dir, 'openclaw.plugin.json')));
  if (!source) {
    warn('Agent HQ OpenClaw capability tools plugin is not bundled with this CLI install.');
    return false;
  }

  const managedDir = join(DATA_DIR, 'openclaw-plugin');
  try {
    mkdirSync(managedDir, { recursive: true });
    cpSync(source, managedDir, { recursive: true });
  } catch (error) {
    warn(`Could not copy the Agent HQ OpenClaw plugin to ${managedDir}.\n  ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  return configureOpenClawPluginAt(managedDir);
}

function configureOpenClawPluginAt(pluginDir) {
  let config;
  try {
    config = readJsonObjectFile(OPENCLAW_CONFIG_FILE);
  } catch (error) {
    warn(`OpenClaw config could not be parsed. Skipping Agent HQ tool plugin config.\n  ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  const before = JSON.stringify(config);
  const plugins = config.plugins && typeof config.plugins === 'object' && !Array.isArray(config.plugins)
    ? config.plugins
    : {};
  const entries = plugins.entries && typeof plugins.entries === 'object' && !Array.isArray(plugins.entries)
    ? plugins.entries
    : {};
  const existingEntry = entries[AGENT_HQ_OPENCLAW_PLUGIN_ID];
  entries[AGENT_HQ_OPENCLAW_PLUGIN_ID] = {
    ...(existingEntry && typeof existingEntry === 'object' && !Array.isArray(existingEntry) ? existingEntry : {}),
    enabled: true,
  };

  const load = plugins.load && typeof plugins.load === 'object' && !Array.isArray(plugins.load)
    ? plugins.load
    : {};
  load.paths = appendUnique(load.paths, pluginDir);

  const installs = plugins.installs && typeof plugins.installs === 'object' && !Array.isArray(plugins.installs)
    ? plugins.installs
    : {};
  const existingInstall = installs[AGENT_HQ_OPENCLAW_PLUGIN_ID];
  const existingInstallObject = existingInstall && typeof existingInstall === 'object' && !Array.isArray(existingInstall)
    ? existingInstall
    : {};
  const pluginVersion = readPluginVersion(pluginDir);
  installs[AGENT_HQ_OPENCLAW_PLUGIN_ID] = {
    ...existingInstallObject,
    source: 'path',
    sourcePath: pluginDir,
    installPath: pluginDir,
    ...(pluginVersion ? { version: pluginVersion } : {}),
    installedAt: existingInstallObject.installedAt ?? new Date().toISOString(),
  };

  config.plugins = {
    ...plugins,
    entries,
    load,
    installs,
  };

  const tools = config.tools && typeof config.tools === 'object' && !Array.isArray(config.tools)
    ? config.tools
    : {};
  if (Array.isArray(tools.allow) && tools.allow.length > 0) {
    tools.allow = appendUnique(tools.allow, AGENT_HQ_OPENCLAW_PLUGIN_ID);
  } else {
    tools.alsoAllow = appendUnique(tools.alsoAllow, AGENT_HQ_OPENCLAW_PLUGIN_ID);
  }
  config.tools = tools;

  if (JSON.stringify(config) === before) return false;

  mkdirSync(OPENCLAW_HOME, { recursive: true });
  writeFileSync(OPENCLAW_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
  info('Configured OpenClaw to load and allow Agent HQ-assigned tools.');
  return true;
}

function resolveAvailableSourceForOpenClawConfig() {
  return resolveLocalWorkspaceSource() ?? (isAgentHqSourceDir(SOURCE_DIR) ? SOURCE_DIR : null);
}

function isGitWorktree(dir) {
  try {
    return (
      runCommandSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: dir,
        stdio: 'pipe',
        encoding: 'utf8',
      }).trim() === 'true'
    );
  } catch {
    return false;
  }
}

function findSourceInParents(startDir) {
  let current = startDir;

  while (true) {
    if (isAgentHqSourceDir(current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveLocalWorkspaceSource() {
  return findSourceInParents(process.cwd()) ?? findSourceInParents(MODULE_DIR);
}

function ensureOpenClaw() {
  if (canRunOpenClaw(resolveOpenClawExecutable(), [OPENCLAW_BIN_DIR])) {
    return {
      runtimePath: buildPathWith(existsSync(OPENCLAW_BIN_DIR) ? [OPENCLAW_BIN_DIR] : []),
      openclawExec: resolveOpenClawExecutable(),
      freshInstall: false,
    };
  }

  info('Installing OpenClaw runtime…');
  mkdirSync(OPENCLAW_HOME, { recursive: true });
  mkdirSync(OPENCLAW_INSTALL_DIR, { recursive: true });
  run(`npm install --prefix "${OPENCLAW_INSTALL_DIR}" openclaw`);

  const installedExec = resolveOpenClawExecutable();
  if (!canRunOpenClaw(installedExec, [OPENCLAW_BIN_DIR])) {
    die(
      'OpenClaw installation completed but the CLI is still unavailable.\n' +
        `  Expected bin path: ${OPENCLAW_BIN_DIR}`
    );
  }

  success('OpenClaw installed.');
  return {
    runtimePath: buildPathWith([OPENCLAW_BIN_DIR]),
    openclawExec: installedExec,
    freshInstall: true,
  };
}

function runOpenClawGateway(args, runtime) {
  return runCommandSync(runtime.openclawExec, ['gateway', ...args], {
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      PATH: runtime.runtimePath,
    },
  });
}

function readOpenClawGatewayStatus(runtime) {
  try {
    return parseJson(runOpenClawGateway(['status', '--json'], runtime));
  } catch {
    return null;
  }
}

function isOpenClawGatewayReachable(status) {
  return Boolean(status?.rpc?.ok) || status?.port?.status === 'busy';
}

function spawnDetachedOpenClawGateway(runtime) {
  const port = process.env.OPENCLAW_GATEWAY_PORT ?? '18789';
  const cliEntry = existsSync(OPENCLAW_CLI_ENTRY) ? OPENCLAW_CLI_ENTRY : OPENCLAW_DIST_ENTRY;
  if (process.platform === 'win32' && existsSync(cliEntry)) {
    return spawnDetached(process.execPath, [cliEntry, 'gateway', 'run', '--force', '--port', port], {
      env: {
        ...process.env,
        PATH: runtime.runtimePath,
        OPENCLAW_HIDE_BANNER: '1',
        OPENCLAW_SUPPRESS_NOTES: '1',
      },
    });
  }

  return spawnDetached(runtime.openclawExec, ['gateway', 'run', '--force', '--port', port], {
    env: {
      ...process.env,
      PATH: runtime.runtimePath,
      OPENCLAW_HIDE_BANNER: '1',
      OPENCLAW_SUPPRESS_NOTES: '1',
    },
  });
}

function ensureOpenClawGateway(runtime) {
  repairOpenClawGatewayCommand();
  let status = readOpenClawGatewayStatus(runtime);

  if (isOpenClawGatewayReachable(status)) {
    info('OpenClaw gateway is already running.');
    return;
  }

  const loaded = Boolean(status?.service?.loaded);
  const running = status?.service?.runtime?.status === 'running';
  const command = loaded || running ? 'restart' : 'start';
  info(`${command === 'start' ? 'Starting' : 'Restarting'} OpenClaw gateway…`);

  try {
    const output = runOpenClawGateway([command, '--json'], runtime);
    const parsed = output ? parseJson(output) : null;
    if (parsed?.message) info(parsed.message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`OpenClaw gateway ${command} failed.\n  ${message}`);
  }

  const serviceDeadline = Date.now() + 20000;
  while (Date.now() <= serviceDeadline) {
    status = readOpenClawGatewayStatus(runtime);
    if (isOpenClawGatewayReachable(status)) {
      success(
        command === 'start'
          ? 'OpenClaw gateway started.'
          : 'OpenClaw gateway restarted.'
      );
      return;
    }
    sleep(500);
  }

  info('Falling back to a direct OpenClaw gateway process…');
  const pid = spawnDetachedOpenClawGateway(runtime);
  const directDeadline = Date.now() + 30000;
  while (Date.now() <= directDeadline) {
    status = readOpenClawGatewayStatus(runtime);
    if (isOpenClawGatewayReachable(status)) {
      success('OpenClaw gateway is running in direct background mode.');
      return;
    }
    sleep(1000);
  }

  if (pid) {
    warn(`OpenClaw gateway direct fallback started in the background (PID ${pid}) but is still warming up.`);
  } else {
    warn('OpenClaw gateway did not become reachable. Agent HQ will continue starting.');
  }
}

// ── Source management ────────────────────────────────────────────────────────

/** Ensure source is cloned and up-to-date. */
function ensureSource() {
  mkdirSync(DATA_DIR, { recursive: true });
  const workspaceSource = resolveLocalWorkspaceSource();
  if (workspaceSource) {
    info(`Using local Agent HQ source at ${workspaceSource}`);
    return workspaceSource;
  }

  if (!hasGit()) {
    die(
      'Git is required for no-docker mode.\n' +
        '  Install Git: https://git-scm.com/downloads',
    );
  }

  if (isGitWorktree(SOURCE_DIR) && isAgentHqSourceDir(SOURCE_DIR)) {
    info('Updating Agent HQ source…');
    try {
      // Older releases cloned from a repository URL that no longer exists.
      // Repoint origin so cached installs keep receiving updates.
      const origin = execSync('git remote get-url origin', {
        cwd: SOURCE_DIR,
        stdio: 'pipe',
      }).toString().trim();
      if (origin !== REPO_URL) {
        info(`Repointing source origin to ${REPO_URL}`);
        execSync(`git remote set-url origin "${REPO_URL}"`, {
          cwd: SOURCE_DIR,
          stdio: 'pipe',
        });
      }
    } catch { /* fall through to fetch with the existing origin */ }
    try {
      execSync('git fetch origin && git reset --hard origin/main', {
        cwd: SOURCE_DIR,
        stdio: 'pipe',
      });
    } catch {
      warn('Could not update source — using cached version.');
    }
    return SOURCE_DIR;
  }

  if (existsSync(SOURCE_DIR)) {
    warn('Cached Agent HQ source is incomplete or invalid. Re-downloading.');
    rmSync(SOURCE_DIR, { recursive: true, force: true });
  }

  info('Downloading Agent HQ source (first run)…');
  run(`git clone --depth 1 ${REPO_URL} "${SOURCE_DIR}"`);

  if (!isAgentHqSourceDir(SOURCE_DIR)) {
    die('Downloaded source is missing the api/ui packages.');
  }

  return SOURCE_DIR;
}

/** Install deps and build for a sub-package (api or ui). */
function buildPackage(sourceDir, name) {
  const dir = join(sourceDir, name);
  if (!existsSync(join(dir, 'package.json'))) {
    die(`${name}/package.json not found in source.`);
  }

  info(`Installing ${name} dependencies…`);
  run('npm install --production=false', { cwd: dir });

  info(`Building ${name}…`);
  run('npm run build', { cwd: dir });
}

/**
 * Copy static assets into the Next.js standalone output directory.
 *
 * When next.config.js uses `output: 'standalone'`, `next build` emits a
 * self-contained server bundle at .next/standalone/ — but it does NOT copy
 * the static file trees automatically.  Without these copies every request
 * for /_next/static/* and /public/* returns 404, leaving the page unstyled.
 *
 * Required copies (per Next.js docs):
 *   .next/static   → .next/standalone/.next/static
 *   public/        → .next/standalone/public          (if directory exists)
 */
function copyStandaloneStatics(uiDir) {
  const standaloneDir = join(uiDir, '.next', 'standalone');

  // Only needed for standalone output; skip silently if the dir isn't there.
  if (!existsSync(standaloneDir)) return;

  info('Copying static assets into standalone bundle…');

  const staticSrc = join(uiDir, '.next', 'static');
  const publicSrc = join(uiDir, 'public');

  const serverDirs = findStandaloneServerDirs(standaloneDir);
  for (const serverDir of serverDirs) {
    const staticDest = join(serverDir, '.next', 'static');
    if (existsSync(staticSrc)) {
      let shouldCopyStatic = true;
      try {
        if (existsSync(staticDest)) {
          const srcReal = realpathSync(staticSrc);
          let destReal = '';
          try {
            destReal = realpathSync(staticDest);
          } catch {
            const stat = lstatSync(staticDest);
            if (stat.isSymbolicLink()) {
              destReal = realpathSync(join(serverDir, '.next', readlinkSync(staticDest)));
            }
          }
          if (destReal && srcReal === destReal) {
            shouldCopyStatic = false;
          }
        }
      } catch {
        // Fall through to copy; if the filesystem shape is unexpected,
        // copying is still the safest default.
      }
      if (shouldCopyStatic) {
        mkdirSync(join(serverDir, '.next'), { recursive: true });
        cpSync(staticSrc, staticDest, { recursive: true });
      }
    }

    const publicDest = join(serverDir, 'public');
    if (existsSync(publicSrc)) {
      mkdirSync(serverDir, { recursive: true });
      cpSync(publicSrc, publicDest, { recursive: true });
    }
  }

  success('Static assets copied.');
}

function findStandaloneServerDirs(standaloneDir) {
  const dirs = new Set();
  const direct = join(standaloneDir, 'server.js');
  if (existsSync(direct)) dirs.add(standaloneDir);
  const stack = [standaloneDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (entry.isFile() && entry.name === 'server.js') {
        dirs.add(current);
      }
      if (entry.isDirectory()) {
        stack.push(entryPath);
      }
    }
  }

  if (dirs.size === 0) dirs.add(standaloneDir);
  return Array.from(dirs);
}

function findStandaloneServer(standaloneDir) {
  for (const dir of findStandaloneServerDirs(standaloneDir)) {
    const server = join(dir, 'server.js');
    if (existsSync(server)) return server;
  }
  return null;
}

// ── Process management ───────────────────────────────────────────────────────

/**
 * Spawn a detached background process.
 * Returns the child PID.
 */
function spawnDetached(command, args, opts) {
  const child = spawn(command, args, {
    ...opts,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

/** Gracefully kill a PID (SIGTERM, then SIGKILL after timeout). */
function killPid(pid) {
  if (!isRunning(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  // Give it a second, then force-kill
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && isRunning(pid)) {
    try {
      execSync('sleep 0.2', { stdio: 'pipe' });
    } catch {
      break;
    }
  }
  if (isRunning(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

// ── Public commands ──────────────────────────────────────────────────────────

export function localStart(flags) {
  const apiPort = flags.apiPort || process.env.AGENT_HQ_API_PORT || '3501';
  const uiPort = flags.uiPort || process.env.AGENT_HQ_UI_PORT || '3500';
  const runtimePath = buildPathWith();

  // If already running, bail
  const existing = readState();
  if (existing && existing.mode === 'local') {
    const apiAlive = existing.apiPid && isRunning(existing.apiPid);
    const uiAlive = existing.uiPid && isRunning(existing.uiPid);
    if (apiAlive && uiAlive) {
      const sourceForConfig = resolveAvailableSourceForOpenClawConfig();
      if (sourceForConfig) {
        ensureAgentHqOpenClawPluginConfig(sourceForConfig);
      }
      info('Agent HQ is already running (local mode).');
      console.log(`  UI:  http://localhost:${existing.uiPort}`);
      console.log(`  API: http://localhost:${existing.apiPort}`);
      return;
    }
    // Partial — clean up and restart
    localStop();
  }

  // 1. Fetch / update source
  const sourceDir = ensureSource();
  ensureAgentHqOpenClawPluginConfig(sourceDir);

  // 2. Build API
  buildPackage(sourceDir, 'api');

  // 3. Build UI
  buildPackage(sourceDir, 'ui');
  // Copy static assets into the standalone bundle so CSS/JS are served correctly.
  copyStandaloneStatics(join(sourceDir, 'ui'));

  // 4. Install or migrate the database. API startup is deliberately
  // non-mutating — it verifies the schema ledger and refuses to serve a
  // missing or stale database, so migrations must run before launch.
  info('Preparing database…');
  run('npm run db:migrate', {
    cwd: join(sourceDir, 'api'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      AGENT_HQ_DB_PATH: DB_PATH,
      AGENT_HQ_DATA_DIR: DATA_DIR,
      PATH: runtimePath,
    },
  });

  // 5. Start API
  info('Starting API…');
  const apiPid = spawnDetached(
    process.execPath,
    [join(sourceDir, 'api', 'dist', 'index.js')],
    {
      cwd: join(sourceDir, 'api'),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: apiPort,
        AGENT_HQ_DB_PATH: DB_PATH,
        AGENT_HQ_DATA_DIR: DATA_DIR,
        PATH: runtimePath,
      },
    },
  );

  // 6. Start UI
  info('Starting UI…');

  // Determine how to start Next.js — standalone if available, else npx next start
  const standaloneRoot = join(sourceDir, 'ui', '.next', 'standalone');
  const standaloneServer = findStandaloneServer(standaloneRoot);
  let uiPid;
  if (standaloneServer && existsSync(standaloneServer)) {
    uiPid = spawnDetached(process.execPath, [standaloneServer], {
      cwd: join(standaloneServer, '..'),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: uiPort,
        NEXT_PUBLIC_API_URL: `http://localhost:${apiPort}`,
        PATH: runtimePath,
      },
    });
  } else {
    // Fallback: use npx next start
    uiPid = spawnDetached(
      process.execPath,
      [
        join(sourceDir, 'ui', 'node_modules', '.bin', 'next'),
        'start',
        '-p',
        uiPort,
      ],
      {
        cwd: join(sourceDir, 'ui'),
        env: {
          ...process.env,
          NODE_ENV: 'production',
          PORT: uiPort,
          NEXT_PUBLIC_API_URL: `http://localhost:${apiPort}`,
          PATH: runtimePath,
        },
      },
    );
  }

  // 6. Save state
  writeState({
    mode: 'local',
    apiPid,
    uiPid,
    apiPort,
    uiPort,
    dbPath: DB_PATH,
    startedAt: new Date().toISOString(),
  });

  success('Agent HQ is starting (local mode)!');
  console.log(`  UI:  http://localhost:${uiPort}`);
  console.log(`  API: http://localhost:${apiPort}`);
  console.log(`  DB:  ${DB_PATH}`);
  console.log(`  Gateway: start and configure OpenClaw separately from Agent HQ.`);
  console.log(
    `\n  Run \x1b[1magent-hq open\x1b[0m to open the UI in your browser.`,
  );
}

export function localStop() {
  const state = readState();
  if (!state || state.mode !== 'local') {
    info('No local-mode Agent HQ instance found.');
    return;
  }

  info('Stopping Agent HQ (local mode)…');
  if (state.apiPid) killPid(state.apiPid);
  if (state.uiPid) killPid(state.uiPid);
  clearState();
  success('Agent HQ stopped.');
}

export function localStatus() {
  const state = readState();
  if (!state || state.mode !== 'local') {
    console.log('Agent HQ is not running in local mode.');
    return;
  }

  const apiAlive = state.apiPid && isRunning(state.apiPid);
  const uiAlive = state.uiPid && isRunning(state.uiPid);

  console.log(`\x1b[1mAgent HQ — Local Mode\x1b[0m`);
  console.log(`  Started: ${state.startedAt || 'unknown'}`);
  console.log(
    `  API (PID ${state.apiPid}): ${apiAlive ? '\x1b[32mrunning\x1b[0m' : '\x1b[31mstopped\x1b[0m'}  → http://localhost:${state.apiPort}`,
  );
  console.log(
    `  UI  (PID ${state.uiPid}): ${uiAlive ? '\x1b[32mrunning\x1b[0m' : '\x1b[31mstopped\x1b[0m'}  → http://localhost:${state.uiPort}`,
  );
  console.log(`  DB:  ${state.dbPath}`);

  if (!apiAlive && !uiAlive) {
    warn('Both processes have stopped. Run `agent-hq start` to restart.');
  } else if (!apiAlive || !uiAlive) {
    warn(
      'One process has stopped. Run `agent-hq stop && agent-hq start` to restart.',
    );
  }
}
