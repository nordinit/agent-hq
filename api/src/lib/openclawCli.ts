import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'child_process';
import { OPENCLAW_BIN, OPENCLAW_HOME, OPENCLAW_PATH } from '../config';
import { isLoopbackHostname } from './openclawGatewayWs';

type OpenClawSpawnOptions = Partial<SpawnSyncOptionsWithStringEncoding>;

function shouldUseShell(executable: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
}

function quoteWindowsArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function gatewayCmdPath(): string {
  return path.join(OPENCLAW_HOME, 'gateway.cmd');
}

function openClawCliEntryPath(): string | null {
  const preferred = path.join(OPENCLAW_HOME, 'node_modules', 'openclaw', 'openclaw.mjs');
  if (fs.existsSync(preferred)) return preferred;

  const fallback = path.join(OPENCLAW_HOME, 'node_modules', 'openclaw', 'dist', 'index.js');
  return fs.existsSync(fallback) ? fallback : null;
}

function resolveOpenClawInvocation(args: string[]): { command: string; args: string[] } {
  const cliEntryPath = openClawCliEntryPath();
  if (process.platform === 'win32' && cliEntryPath) {
        return {
            command: process.execPath,
            args: [cliEntryPath, ...args],
        };
    }

  return {
    command: OPENCLAW_BIN,
    args,
  };
}

function installedOpenClawVersion(): string | null {
  try {
    const pkgPath = path.join(OPENCLAW_HOME, 'node_modules', 'openclaw', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

function renderGatewayCmd(distPath: string): string {
  const version = installedOpenClawVersion();
  const home = process.env.HOME ?? os.homedir();
  const tmpDir =
    process.env.TMPDIR
    ?? process.env.TEMP
    ?? path.join(home, 'AppData', 'Local', 'Temp');
  const port = process.env.OPENCLAW_GATEWAY_PORT ?? '18789';

  return [
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
    `${quoteWindowsArg(process.execPath)} ${quoteWindowsArg(distPath)} gateway --port ${port}`,
    '',
  ].join('\r\n');
}

export function repairOpenClawGatewayCommand(): {
  repaired: boolean;
  path: string | null;
  reason?: string;
} {
  if (process.platform !== 'win32') {
    return { repaired: false, path: null, reason: 'not-windows' };
  }

  const cliEntryPath = openClawCliEntryPath();
  const cmdPath = gatewayCmdPath();
  if (!cliEntryPath) {
    return { repaired: false, path: cmdPath, reason: 'openclaw-dist-missing' };
  }

  const expected = renderGatewayCmd(cliEntryPath);
  const current = fs.existsSync(cmdPath) ? fs.readFileSync(cmdPath, 'utf8') : '';
  if (current === expected) {
    return { repaired: false, path: cmdPath };
  }

  fs.mkdirSync(path.dirname(cmdPath), { recursive: true });
  fs.writeFileSync(cmdPath, expected, 'utf8');
  return { repaired: true, path: cmdPath };
}

/**
 * True when a gateway URL names this host (localhost, 127.x.x.x or ::1), in any scheme.
 */
export function isLoopbackGatewayUrl(url: string | undefined): boolean {
  if (!url?.trim()) return false;
  try {
    return isLoopbackHostname(new URL(url.trim()).hostname);
  } catch {
    return false;
  }
}

/**
 * The environment for an openclaw CLI child process. Every spawn of the CLI builds its
 * environment here.
 *
 * OPENCLAW_GATEWAY_URL tells this API where the gateway is, but the CLI reads the same variable
 * as an override of the gateway its own config (OPENCLAW_CONFIG_PATH) describes. Under an
 * override the CLI does not pin the local gateway's certificate from its gateway.tls config and
 * does not reuse the config's credentials, so with TLS verification on (NODE_TLS_REJECT_UNAUTHORIZED
 * is never set here) every gateway command against the local self-signed gateway failed with
 * "gateway closed (1006)". A loopback URL is therefore dropped and the CLI connects to its
 * configured gateway, which it already trusts. A remote URL is kept: the CLI verifies that
 * gateway's certificate normally, so a private CA must be trusted through NODE_EXTRA_CA_CERTS,
 * and credentials must come from OPENCLAW_GATEWAY_TOKEN / OPENCLAW_GATEWAY_PASSWORD.
 *
 * Pass the gateway token as OPENCLAW_GATEWAY_TOKEN in extraEnv rather than as `--token` on
 * argv, where any local user can read it with `ps`.
 */
export function buildOpenClawEnv(extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_HIDE_BANNER: '1',
    OPENCLAW_SUPPRESS_NOTES: '1',
    ...extraEnv,
    PATH: OPENCLAW_PATH,
  };
  delete env.OPENCLAW_BIN;
  if (isLoopbackGatewayUrl(env.OPENCLAW_GATEWAY_URL)) delete env.OPENCLAW_GATEWAY_URL;
  return env;
}

export function runOpenClawSync(
  args: string[],
  opts: OpenClawSpawnOptions = {},
): SpawnSyncReturns<string> {
  repairOpenClawGatewayCommand();
  const invocation = resolveOpenClawInvocation(args);

  return spawnSync(invocation.command, invocation.args, {
    ...opts,
    encoding: opts.encoding ?? 'utf8',
    env: buildOpenClawEnv(opts.env ?? {}),
    shell: shouldUseShell(invocation.command),
    windowsHide: true,
  } as SpawnSyncOptionsWithStringEncoding);
}

export function requireOpenClawSync(
  args: string[],
  opts: OpenClawSpawnOptions = {},
): SpawnSyncReturns<string> {
  const result = runOpenClawSync(args, opts);

  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    const stdout = (result.stdout ?? '').trim();
    throw new Error(stderr || stdout || `${OPENCLAW_BIN} exited with status ${result.status}`);
  }

  return result;
}

export function requireOpenClawOutput(
  args: string[],
  opts: OpenClawSpawnOptions = {},
): string {
  return requireOpenClawSync(args, opts).stdout ?? '';
}

type GatewayStatus = {
  service?: {
    loaded?: boolean;
    runtime?: { status?: string };
  };
  port?: {
    status?: string;
  };
  rpc?: {
    ok?: boolean;
    error?: string;
  };
};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function readOpenClawGatewayStatus(): GatewayStatus | null {
  try {
    const raw = requireOpenClawOutput(['gateway', 'status', '--json'], {
      timeout: 30000,
      stdio: 'pipe',
    });
    const parsed = parseJson(raw);
    return parsed && typeof parsed === 'object' ? (parsed as GatewayStatus) : null;
  } catch {
    return null;
  }
}

export function isOpenClawGatewayReachable(status: GatewayStatus | null | undefined): boolean {
  return Boolean(status?.rpc?.ok) || status?.port?.status === 'busy';
}

function resolveDetachedInvocation(args: string[]): { command: string; args: string[] } {
  const cliEntryPath = openClawCliEntryPath();
  if (process.platform === 'win32' && cliEntryPath) {
    return {
      command: process.execPath,
      args: [cliEntryPath, ...args],
    };
  }

  return {
    command: OPENCLAW_BIN,
    args,
  };
}

export function spawnDetachedOpenClawGateway(): { pid: number | null } {
  const port = process.env.OPENCLAW_GATEWAY_PORT ?? '18789';
  const invocation = resolveDetachedInvocation(['gateway', 'run', '--force', '--port', port]);
  const child = spawn(invocation.command, invocation.args, {
    detached: true,
    stdio: 'ignore',
    env: buildOpenClawEnv(),
    shell: shouldUseShell(invocation.command),
    windowsHide: true,
  });
  child.unref();
  return { pid: child.pid ?? null };
}

export function waitForOpenClawGatewayReachable(timeoutMs = 20000, intervalMs = 500): {
  ok: boolean;
  status: GatewayStatus | null;
} {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = readOpenClawGatewayStatus();
  while (Date.now() <= deadline) {
    if (isOpenClawGatewayReachable(lastStatus)) {
      return { ok: true, status: lastStatus };
    }
    sleep(intervalMs);
    lastStatus = readOpenClawGatewayStatus();
  }
  return { ok: false, status: lastStatus };
}

export function ensureOpenClawGatewayAvailable(): {
  ok: boolean;
  repaired: boolean;
  usedDirectFallback: boolean;
  pid: number | null;
  message: string;
  status: GatewayStatus | null;
} {
  const repair = repairOpenClawGatewayCommand();
  const initialStatus = readOpenClawGatewayStatus();
  if (isOpenClawGatewayReachable(initialStatus)) {
    return {
      ok: true,
      repaired: repair.repaired,
      usedDirectFallback: false,
      pid: null,
      message: 'OpenClaw gateway is already reachable.',
      status: initialStatus,
    };
  }

  const serviceLoaded = Boolean(initialStatus?.service?.loaded);
  const serviceRunning = initialStatus?.service?.runtime?.status === 'running';
  const command = serviceLoaded || serviceRunning ? 'restart' : 'start';
  let message = '';

  try {
    const output = requireOpenClawOutput(['gateway', command, '--json'], {
      timeout: 120000,
      stdio: 'pipe',
    });
    const parsed = parseJson(output) as Record<string, unknown> | null;
    message = typeof parsed?.message === 'string' && parsed.message.trim()
      ? parsed.message.trim()
      : output.trim();
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }

  const serviceWait = waitForOpenClawGatewayReachable();
  if (serviceWait.ok) {
    return {
      ok: true,
      repaired: repair.repaired,
      usedDirectFallback: false,
      pid: null,
      message: message || `OpenClaw gateway ${command} succeeded.`,
      status: serviceWait.status,
    };
  }

  const fallback = spawnDetachedOpenClawGateway();
  const directWait = waitForOpenClawGatewayReachable(30000, 1000);
  if (directWait.ok) {
    return {
      ok: true,
      repaired: repair.repaired,
      usedDirectFallback: true,
      pid: fallback.pid,
      message: 'OpenClaw gateway started in direct background mode.',
      status: directWait.status,
    };
  }

  return {
    ok: false,
    repaired: repair.repaired,
    usedDirectFallback: true,
    pid: fallback.pid,
    message: fallback.pid !== null
      ? 'OpenClaw gateway process was spawned, but the gateway never became reachable.'
      : (message || 'OpenClaw gateway did not become reachable.'),
    status: directWait.status ?? serviceWait.status,
  };
}
