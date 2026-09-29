import { spawn } from 'child_process';
import { buildOpenClawEnv } from '../../lib/openclawCli';
import { localProcessGroupId, localProcessSpawnOptions } from '../localProcessSupervisor';
import { cleanupOwnedProcessTree } from '../ownedProcessTreeCleanup';
import { redactSensitiveRuntimeText } from '../sensitiveText';

export interface MaintenanceCommandResult {
  ok: boolean;
  command: string;
  args: string[];
  status?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  error?: string;
  skipped?: boolean;
}

/** Keep the API available to MCP callbacks while maintenance is in progress. */
export function runMaintenanceCommand(params: {
  command?: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}): Promise<MaintenanceCommandResult> {
  const command = params.command ?? (process.env.OPENCLAW_BIN?.trim() || 'openclaw');
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let failure: string | undefined;
    let settling = false;
    const limit = 256 * 1024;
    const child = spawn(command, params.args, {
      cwd: params.cwd, env: buildOpenClawEnv(), stdio: ['ignore', 'pipe', 'pipe'],
      ...localProcessSpawnOptions(),
    });
    const finish = async (status: number | null, signal: NodeJS.Signals | null) => {
      if (settling) return;
      settling = true;
      clearTimeout(timer);
      const cleanup = child.pid
        ? await cleanupOwnedProcessTree({ child, processGroupId: localProcessGroupId(child), graceMs: 250 })
        : { confirmed: true };
      if (!cleanup.confirmed) failure = 'OpenClaw maintenance process cleanup could not be confirmed';
      resolve({
        ok: !failure && status === 0, command, args: params.args, status, signal,
        stdout: redactSensitiveRuntimeText(stdout.trim()),
        stderr: redactSensitiveRuntimeText(stderr.trim()),
        ...((failure || status !== 0) ? { error: redactSensitiveRuntimeText(failure ?? `OpenClaw maintenance exited with status ${status}${signal ? ` (${signal})` : ''}`) } : {}),
      });
    };
    const timer = setTimeout(() => {
      failure = `OpenClaw maintenance timed out after ${params.timeoutMs ?? 60_000}ms`;
      void finish(null, 'SIGTERM');
    }, params.timeoutMs ?? 60_000);
    const collect = (stream: 'stdout' | 'stderr', chunk: string) => {
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length > limit) {
        stdout = stdout.slice(0, limit / 2);
        stderr = stderr.slice(0, limit / 2);
        failure = 'OpenClaw maintenance output exceeded its limit';
        void finish(null, 'SIGTERM');
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => collect('stdout', chunk));
    child.stderr.on('data', (chunk: string) => collect('stderr', chunk));
    child.once('error', (error) => { failure = error.message; void finish(null, null); });
    child.once('close', (status, signal) => { void finish(status, signal); });
  });
}

const maintenanceTails = new Map<string, Promise<unknown>>();

/** Serialize, rather than deduplicate: later callers may have published new files. */
export async function serializeOpenClawMaintenance<T>(target: string, run: () => Promise<T>): Promise<T> {
  const previous = maintenanceTails.get(target) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  maintenanceTails.set(target, next);
  try { return await next; }
  finally { if (maintenanceTails.get(target) === next) maintenanceTails.delete(target); }
}
