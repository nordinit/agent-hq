import { execFile } from 'child_process';
import { constants as fsConstants, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  isSupportedAgentRuntimeType,
  validateAgentRuntimeConfig,
  type AgentRuntimeType,
} from '../agents/runtimeConfig';
import { normalizeCodexRuntimeConfig } from '../../runtimes/codex/config';
import { resolveEffectiveCodexHome } from '../../runtimes/codex/auth';
import { buildRuntimeChildEnv, sanitizedRuntimeProcessEnv } from '../../runtimes/environment';
import { probeAllowedRuntimeCliVersion } from '../../runtimes/runtimeCliVersion';

export const RUNTIME_DIAGNOSTIC_STATUSES = ['pass', 'warn', 'fail', 'skipped'] as const;
export type RuntimeDiagnosticStatus = (typeof RUNTIME_DIAGNOSTIC_STATUSES)[number];

export interface RuntimeDiagnosticCheck {
  key: 'config' | 'command' | 'version' | 'workspace' | 'config_home' | 'auth';
  label: string;
  status: RuntimeDiagnosticStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface RuntimeDriverDiagnostic {
  ok: boolean;
  runtime_type: AgentRuntimeType;
  agent_id: number | null;
  checked_at: string;
  duration_ms: number;
  command: string | null;
  executable_path: string | null;
  version: string | null;
  workspace_path: string | null;
  checks: RuntimeDiagnosticCheck[];
}

export interface DiagnoseRuntimeDriverInput {
  runtimeType: string;
  runtimeConfig?: Record<string, unknown> | null;
  workspacePath?: string | null;
  agentId?: number | null;
  tenantId?: number | null;
  agentSlug?: string | null;
  providerConnectionId?: number | null;
  pathValue?: string;
  versionTimeoutMs?: number;
  authTimeoutMs?: number;
}

type LocalCommandSpec = {
  defaultCommand: string;
  configField: string;
  configHomeField?: string;
};

const LOCAL_COMMAND_SPECS: Partial<Record<AgentRuntimeType, LocalCommandSpec>> = {
  openclaw: { defaultCommand: 'openclaw', configField: 'openclawBin' },
  'claude-code': {
    defaultCommand: 'claude',
    configField: 'claudeBin',
    configHomeField: 'claudeConfigDir',
  },
  codex: {
    defaultCommand: 'codex',
    configField: 'codexBin',
    configHomeField: 'codexHome',
  },
  hermes: {
    defaultCommand: 'hermes',
    configField: 'hermesBin',
    configHomeField: 'hermesHome',
  },
};

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a CLI exactly as a subprocess launch would, without invoking a shell. */
export async function resolveExecutable(command: string, pathValue = process.env.PATH ?? ''): Promise<string | null> {
  const trimmed = command.trim();
  if (!trimmed) return null;

  if (path.isAbsolute(trimmed) || trimmed.includes(path.sep) || trimmed.includes('/')) {
    const candidate = path.resolve(trimmed);
    return await isExecutableFile(candidate) ? candidate : null;
  }

  for (const pathEntry of pathValue.split(path.delimiter)) {
    if (!pathEntry) continue;
    const candidate = path.join(pathEntry, trimmed);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function compactVersionOutput(stdout: string, stderr: string): string | null {
  const line = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ? line.slice(0, 300) : null;
}

async function probeVersion(
  executablePath: string,
  timeoutMs: number,
): Promise<{ ok: true; version: string | null } | { ok: false; message: string }> {
  return await new Promise((resolve) => {
    execFile(
      executablePath,
      ['--version'],
      {
        env: sanitizedRuntimeProcessEnv(),
        timeout: timeoutMs,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const timedOut = Boolean((error as NodeJS.ErrnoException & { killed?: boolean }).killed);
          resolve({
            ok: false,
            message: timedOut
              ? `Version probe exceeded ${timeoutMs}ms.`
              : `Version probe failed: ${error.message}`,
          });
          return;
        }
        resolve({ ok: true, version: compactVersionOutput(stdout, stderr) });
      },
    );
  });
}

function versionPolicyCheck(runtimeType: AgentRuntimeType, version: string | null): RuntimeDiagnosticCheck {
  return {
    key: 'version',
    label: 'Runtime version',
    status: version ? 'pass' : 'warn',
    message: version ?? 'The CLI exited successfully but did not report a version.',
  };
}

function resolveDiagnosticConfigHome(
  runtimeType: AgentRuntimeType,
  runtimeConfig: Record<string, unknown>,
  input: DiagnoseRuntimeDriverInput,
): { path: string | null; error: string | null } {
  if (runtimeType === 'claude-code') {
    return {
      path: nonEmptyString(runtimeConfig.claudeConfigDir)
        ?? process.env.CLAUDE_CONFIG_DIR?.trim()
        ?? path.join(os.homedir(), '.claude'),
      error: null,
    };
  }
  if (runtimeType === 'codex') {
    const agentSlug = input.agentSlug?.trim();
    if ((!agentSlug || input.agentId == null || input.tenantId == null) && input.providerConnectionId == null) {
      return {
        path: nonEmptyString(runtimeConfig.codexHome),
        error: nonEmptyString(runtimeConfig.codexHome)
          ? null
          : 'Trusted tenant, agent, and slug identity is required to resolve Agent HQ’s isolated Codex home.',
      };
    }
    try {
      return {
        path: resolveEffectiveCodexHome({
          agentSlug: agentSlug || `agent-${input.agentId ?? 'draft'}`,
          config: normalizeCodexRuntimeConfig(runtimeConfig),
          providerConnectionId: input.providerConnectionId ?? null,
          tenantId: input.tenantId ?? null,
          agentId: input.agentId ?? null,
        }),
        error: null,
      };
    } catch (error) {
      return { path: null, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const configHomeField = LOCAL_COMMAND_SPECS[runtimeType]?.configHomeField;
  return {
    path: configHomeField ? nonEmptyString(runtimeConfig[configHomeField]) : null,
    error: null,
  };
}

async function probeRuntimeAuth(params: {
  runtimeType: AgentRuntimeType;
  executablePath: string;
  configHome: string | null;
  timeoutMs: number;
}): Promise<RuntimeDiagnosticCheck> {
  if (params.runtimeType !== 'claude-code' && params.runtimeType !== 'codex') {
    return {
      key: 'auth',
      label: 'Runtime authentication',
      status: 'skipped',
      message: 'This runtime has no Claude/Codex CLI authentication probe.',
    };
  }
  if (!params.configHome) {
    return {
      key: 'auth',
      label: 'Runtime authentication',
      status: 'fail',
      message: 'Authentication could not be checked because the runtime config home is unresolved.',
    };
  }

  const args = params.runtimeType === 'claude-code'
    ? ['auth', 'status', '--json']
    : ['login', 'status'];
  const env: NodeJS.ProcessEnv = {};
  if (params.runtimeType === 'claude-code') env.CLAUDE_CONFIG_DIR = params.configHome;
  else env.CODEX_HOME = params.configHome;

  return await new Promise((resolve) => {
    execFile(
      params.executablePath,
      args,
      {
        env: buildRuntimeChildEnv(env),
        encoding: 'utf8',
        timeout: params.timeoutMs,
        maxBuffer: 128 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        let authenticated = !error;
        if (authenticated && params.runtimeType === 'claude-code') {
          try {
            const parsed = JSON.parse(String(stdout)) as { loggedIn?: unknown };
            authenticated = parsed.loggedIn === true;
          } catch {
            authenticated = false;
          }
        }
        resolve({
          key: 'auth',
          label: 'Runtime authentication',
          status: authenticated ? 'pass' : 'fail',
          message: authenticated
            ? `${params.runtimeType} CLI profile is authenticated.`
            : `${params.runtimeType} CLI profile is not authenticated in its resolved config home.`,
          // Do not include stdout/stderr: auth status can contain account ids.
          details: { credential_owner: params.runtimeType },
        });
      },
    );
  });
}

async function inspectDirectory(
  key: 'workspace' | 'config_home',
  label: string,
  requestedPath: string,
  missingStatus: RuntimeDiagnosticStatus,
): Promise<RuntimeDiagnosticCheck> {
  const resolvedPath = path.resolve(requestedPath);
  try {
    const stat = await fs.stat(resolvedPath);
    if (!stat.isDirectory()) {
      return {
        key,
        label,
        status: 'fail',
        message: `${label} is not a directory.`,
        details: { path: resolvedPath },
      };
    }
    await fs.access(resolvedPath, fsConstants.R_OK | fsConstants.W_OK);
    return {
      key,
      label,
      status: 'pass',
      message: `${label} is readable and writable.`,
      details: { path: resolvedPath },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      key,
      label,
      status: code === 'ENOENT' ? missingStatus : 'fail',
      message: code === 'ENOENT'
        ? `${label} does not exist yet.`
        : `${label} is not readable and writable: ${error instanceof Error ? error.message : String(error)}`,
      details: { path: resolvedPath, code: code ?? null },
    };
  }
}

/**
 * Diagnose launch prerequisites only. This never submits a prompt or starts an
 * agent turn; subprocesses are restricted to fixed version and auth-status
 * commands whose output is not returned to the operator.
 */
export async function diagnoseRuntimeDriver(input: DiagnoseRuntimeDriverInput): Promise<RuntimeDriverDiagnostic> {
  const startedAt = Date.now();
  if (!isSupportedAgentRuntimeType(input.runtimeType)) {
    throw new Error(`Unsupported runtime_type '${input.runtimeType}'.`);
  }

  const runtimeType = input.runtimeType;
  const runtimeConfig = input.runtimeConfig ?? {};
  const checks: RuntimeDiagnosticCheck[] = [];
  const configError = validateAgentRuntimeConfig(runtimeType, runtimeConfig);
  checks.push({
    key: 'config',
    label: 'Runtime configuration',
    status: configError ? 'fail' : 'pass',
    message: configError ?? 'Runtime configuration is valid.',
  });

  const commandSpec = LOCAL_COMMAND_SPECS[runtimeType];
  const command = commandSpec
    ? nonEmptyString(runtimeConfig[commandSpec.configField]) ?? commandSpec.defaultCommand
    : null;
  let executablePath: string | null = null;
  let version: string | null = null;

  if (!commandSpec || !command) {
    checks.push({
      key: 'command',
      label: 'Runtime command',
      status: 'skipped',
      message: `${runtimeType} does not use a local CLI command.`,
    });
    checks.push({
      key: 'version',
      label: 'Runtime version',
      status: 'skipped',
      message: 'No local CLI version probe is required.',
    });
  } else if (configError) {
    // Validation includes the host-owned executable policy. Do not resolve or
    // invoke any command from an invalid config: diagnostics are reachable
    // before an agent is persisted and must not become a subprocess oracle.
    checks.push({
      key: 'command',
      label: 'Runtime command',
      status: 'skipped',
      message: 'Runtime command resolution was skipped because the configuration is invalid.',
    });
    checks.push({
      key: 'version',
      label: 'Runtime version',
      status: 'skipped',
      message: 'Version probe was skipped because the configuration is invalid.',
    });
  } else {
    const controlledVersionResult = runtimeType === 'claude-code' || runtimeType === 'codex'
      ? await probeAllowedRuntimeCliVersion({
          runtime: runtimeType,
          command,
          timeoutMs: input.versionTimeoutMs ?? 5_000,
          pathValue: input.pathValue ?? process.env.PATH ?? '',
        })
      : null;
    // Controlled runtimes take the path directly from the shared policy probe.
    // That path is the exact file already executed for --version and is reused
    // below for auth status; diagnostics never performs a second PATH lookup.
    executablePath = controlledVersionResult?.executablePath
      ?? (controlledVersionResult ? null : await resolveExecutable(
        command,
        input.pathValue ?? process.env.PATH ?? '',
      ));
    checks.push({
      key: 'command',
      label: 'Runtime command',
      status: executablePath ? 'pass' : 'fail',
      message: executablePath
        ? `Resolved ${command}.`
        : `Could not resolve executable '${command}'.`,
      details: { command, executable_path: executablePath },
    });

    if (!executablePath) {
      checks.push({
        key: 'version',
        label: 'Runtime version',
        status: 'skipped',
        message: 'Version probe was skipped because the command could not be resolved.',
      });
    } else {
      if (controlledVersionResult) {
        version = controlledVersionResult.version;
        checks.push({
          key: 'version',
          label: 'Runtime version',
          status: controlledVersionResult.ok ? 'pass' : 'fail',
          message: controlledVersionResult.message,
          details: controlledVersionResult.details,
        });
      } else {
        const versionResult = await probeVersion(executablePath, input.versionTimeoutMs ?? 5_000);
        if (versionResult.ok) {
          version = versionResult.version;
          checks.push(versionPolicyCheck(runtimeType, version));
        } else {
          checks.push({
            key: 'version',
            label: 'Runtime version',
            status: 'fail',
            message: versionResult.message,
          });
        }
      }
    }
  }

  const configuredWorkspace = nonEmptyString(input.workspacePath)
    ?? nonEmptyString(runtimeConfig.workingDirectory);
  if (configuredWorkspace) {
    checks.push(await inspectDirectory('workspace', 'Workspace', configuredWorkspace, 'fail'));
  } else {
    checks.push({
      key: 'workspace',
      label: 'Workspace',
      status: 'skipped',
      message: 'No fixed workspace is configured; a workflow worktree may supply it at dispatch time.',
    });
  }

  const resolvedConfigHome = resolveDiagnosticConfigHome(runtimeType, runtimeConfig, input);
  const configHome = resolvedConfigHome.path;
  if (configHome) {
    checks.push(await inspectDirectory('config_home', 'Runtime config home', configHome, 'warn'));
  } else if (resolvedConfigHome.error) {
    checks.push({
      key: 'config_home',
      label: 'Runtime config home',
      status: 'fail',
      message: resolvedConfigHome.error,
    });
  } else if (commandSpec?.configHomeField) {
    checks.push({
      key: 'config_home',
      label: 'Runtime config home',
      status: 'warn',
      message: `No isolated ${commandSpec.configHomeField} is configured; runtime defaults will apply.`,
    });
  } else {
    checks.push({
      key: 'config_home',
      label: 'Runtime config home',
      status: 'skipped',
      message: 'This runtime has no local config home.',
    });
  }

  if (executablePath) {
    checks.push(await probeRuntimeAuth({
      runtimeType,
      executablePath,
      configHome,
      timeoutMs: input.authTimeoutMs ?? 5_000,
    }));
  } else {
    checks.push({
      key: 'auth',
      label: 'Runtime authentication',
      status: 'skipped',
      message: 'Authentication probe was skipped because the command could not be resolved.',
    });
  }

  return {
    ok: !checks.some((check) => check.status === 'fail'),
    runtime_type: runtimeType,
    agent_id: input.agentId ?? null,
    checked_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    command,
    executable_path: executablePath,
    version,
    workspace_path: configuredWorkspace ? path.resolve(configuredWorkspace) : null,
    checks,
  };
}
