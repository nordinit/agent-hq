import { execSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { localStart, localStop, localStatus } from './local.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const COMPOSE_SOURCE = join(__dirname, '..', 'docker-compose.yml');

// Data directory where we keep the compose file and any local config
const DATA_DIR = join(homedir(), '.agent-hq');

const HELP = `
agent-hq — CLI launcher for Agent HQ

Usage:
  agent-hq <command> [options]

Commands:
  start     Start Agent HQ
  restart   Restart Agent HQ
  stop      Stop Agent HQ
  status    Show current runtime status
  open      Open the Agent HQ UI in a browser
  help      Show this help message

Options:
  --port-api <port>   Host port for the API  (default: 3501, env: AGENT_HQ_API_PORT)
  --port-ui  <port>   Host port for the UI   (default: 3500, env: AGENT_HQ_UI_PORT)
  --docker            Run with Docker Compose
  --no-docker         Alias for local mode (kept for compatibility)

Agent HQ defaults to local mode.
Use --docker only when you explicitly want the Docker Compose stack.

Examples:
  agent-hq start
  agent-hq restart
  agent-hq start --docker
  agent-hq start --port-ui 8080
  agent-hq status
  agent-hq stop
`.trim();

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

/** Returns true if Docker + Docker Compose are available and the daemon is running. */
function isDockerAvailable() {
  try {
    execFileSync('docker', ['--version'], { stdio: 'pipe' });
  } catch {
    return false;
  }
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe' });
  } catch {
    return false;
  }
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'pipe' });
  } catch {
    return false;
  }
  return true;
}

function checkDocker() {
  try {
    execFileSync('docker', ['--version'], { stdio: 'pipe' });
  } catch {
    die(
      'Docker is not installed or not in PATH.\n' +
      '  Install Docker Desktop: https://docs.docker.com/get-docker/\n' +
      '  Then run this command again.'
    );
  }

  // Check Docker daemon is running
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe' });
  } catch {
    die(
      'Docker daemon is not running.\n' +
      '  Start Docker Desktop and try again.'
    );
  }

  // Check docker compose is available
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'pipe' });
  } catch {
    die(
      'Docker Compose (V2) is not available.\n' +
      '  Update Docker Desktop or install the compose plugin:\n' +
      '  https://docs.docker.com/compose/install/'
    );
  }
}

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  // Copy compose file into data dir so Docker Compose has a stable project dir
  const dest = join(DATA_DIR, 'docker-compose.yml');
  writeFileSync(dest, readFileSync(COMPOSE_SOURCE));
  return DATA_DIR;
}

function compose(args, opts = {}) {
  const cwd = ensureDataDir();
  const cmd = ['docker', 'compose', ...args].join(' ');
  try {
    execSync(cmd, { cwd, stdio: 'inherit', ...opts });
  } catch (e) {
    if (!opts.ignoreError) {
      die(`Command failed: ${cmd}`);
    }
  }
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port-api' && argv[i + 1]) {
      flags.apiPort = argv[++i];
    } else if (argv[i] === '--port-ui' && argv[i + 1]) {
      flags.uiPort = argv[++i];
    } else if (argv[i] === '--docker') {
      flags.docker = true;
    } else if (argv[i] === '--no-docker') {
      flags.noDocker = true;
    }
  }
  return flags;
}

function setPortEnv(flags) {
  if (flags.apiPort) process.env.AGENT_HQ_API_PORT = flags.apiPort;
  if (flags.uiPort) process.env.AGENT_HQ_UI_PORT = flags.uiPort;
}

function getEnv(name, fallback) {
  return process.env[name] || fallback;
}

function getUiPort() {
  return getEnv('AGENT_HQ_UI_PORT', '3500');
}

function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      execFileSync('open', [url], { stdio: 'pipe' });
    } else if (platform === 'win32') {
      execFileSync('cmd', ['/c', 'start', url], { stdio: 'pipe' });
    } else {
      execFileSync('xdg-open', [url], { stdio: 'pipe' });
    }
  } catch {
    info(`Could not open browser automatically. Visit: ${url}`);
  }
}

/**
 * Determine whether to use local mode.
 * Local is the default. Docker is only used when --docker is passed.
 */
function shouldUseLocalMode(flags) {
  if (flags.docker) {
    if (!isDockerAvailable()) {
      die(
        'Docker mode was requested, but Docker is not available.\n' +
        '  Install Docker Desktop: https://docs.docker.com/get-docker/\n' +
        '  Or run without --docker to use local mode.'
      );
    }
    return false;
  }
  if (flags.noDocker) return true;
  return true;
}

// ── Commands ─────────────────────────────────────────────────────────────────

function cmdStart(flags) {
  if (shouldUseLocalMode(flags)) {
    localStart(flags);
    return;
  }

  checkDocker();
  setPortEnv(flags);
  const uiPort = getUiPort();
  const apiPort = getEnv('AGENT_HQ_API_PORT', '3501');

  info('Pulling latest Agent HQ images…');
  compose(['pull']);

  info('Starting Agent HQ…');
  compose(['up', '-d', '--remove-orphans']);

  success(`Agent HQ is starting!`);
  console.log(`  UI:  http://localhost:${uiPort}`);
  console.log(`  API: http://localhost:${apiPort}`);
  console.log(`\n  Run \x1b[1magent-hq open\x1b[0m to open the UI in your browser.`);
}

function cmdStop(flags) {
  const localState = readLocalState();
  if (!flags.docker && localState && localState.mode === 'local') {
    localStop();
    return;
  }

  if (!flags.docker) {
    localStop();
    return;
  }

  checkDocker();
  info('Stopping Agent HQ…');
  compose(['down']);
  success('Agent HQ stopped.');
}

function cmdRestart(flags) {
  if (shouldUseLocalMode(flags)) {
    const localState = readLocalState();
    if (localState && localState.mode === 'local') {
      info('Restarting Agent HQ (local mode)…');
      localStop();
    } else {
      info('No local-mode Agent HQ instance found. Starting a fresh local instance…');
    }
    localStart(flags);
    return;
  }

  checkDocker();
  setPortEnv(flags);
  const uiPort = getUiPort();
  const apiPort = getEnv('AGENT_HQ_API_PORT', '3501');

  info('Restarting Agent HQ…');
  compose(['down'], { ignoreError: true });
  compose(['up', '-d', '--remove-orphans']);

  success('Agent HQ restarted.');
  console.log(`  UI:  http://localhost:${uiPort}`);
  console.log(`  API: http://localhost:${apiPort}`);
}

function cmdStatus(flags) {
  const localState = readLocalState();
  if (!flags.docker && localState && localState.mode === 'local') {
    localStatus();
    return;
  }

  if (!flags.docker) {
    localStatus();
    return;
  }

  checkDocker();
  ensureDataDir();
  compose(['ps'], { ignoreError: true });
}

function cmdOpen(flags) {
  setPortEnv(flags);
  const uiPort = getUiPort();
  const url = `http://localhost:${uiPort}`;
  info(`Opening ${url}…`);
  openBrowser(url);
}

/** Read local state without importing local.mjs dependency (avoids circular). */
function readLocalState() {
  const stateFile = join(DATA_DIR, 'local.json');
  if (!existsSync(stateFile)) return null;
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

export function run(argv) {
  const command = argv[0];
  const flags = parseFlags(argv.slice(1));

  switch (command) {
    case 'start':
      cmdStart(flags);
      break;
    case 'restart':
      cmdRestart(flags);
      break;
    case 'stop':
      cmdStop(flags);
      break;
    case 'status':
      cmdStatus(flags);
      break;
    case 'open':
      cmdOpen(flags);
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(HELP);
      break;
    default:
      die(`Unknown command: ${command}\n\nRun \x1b[1magent-hq help\x1b[0m for usage.`);
  }
}
