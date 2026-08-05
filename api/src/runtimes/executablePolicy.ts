import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

export type PolicyControlledRuntime = 'claude-code' | 'codex';

interface RuntimeExecutablePolicy {
  defaultCommand: string;
  configField: 'claudeBin' | 'codexBin';
  allowlistEnvironmentVariable: string;
}

export interface ResolvedRuntimeExecutable {
  path: string;
  fingerprint: string;
}

const RUNTIME_EXECUTABLE_POLICIES: Record<PolicyControlledRuntime, RuntimeExecutablePolicy> = {
  'claude-code': {
    defaultCommand: 'claude',
    configField: 'claudeBin',
    allowlistEnvironmentVariable: 'AGENT_HQ_ALLOWED_CLAUDE_BINARIES',
  },
  codex: {
    defaultCommand: 'codex',
    configField: 'codexBin',
    allowlistEnvironmentVariable: 'AGENT_HQ_ALLOWED_CODEX_BINARIES',
  },
};

function allowlistedAbsolutePaths(environmentVariable: string): Set<string> {
  const configured = process.env[environmentVariable]?.trim();
  if (!configured) return new Set();

  return new Set(
    configured
      .split(path.delimiter)
      .map((entry) => entry.trim())
      // A host allowlist entry must itself be explicit. Silently resolving a
      // relative entry against the API cwd would make deployment configuration
      // changes unexpectedly authorize a different executable.
      .filter((entry) => path.isAbsolute(entry))
      .map((entry) => path.resolve(entry)),
  );
}

/**
 * Validate a caller-configurable local runtime executable without touching the
 * filesystem or resolving PATH.
 *
 * The adapter-owned default command is always allowed and resolves through the
 * API host's PATH. Every other value must be an absolute path that the host
 * operator explicitly listed in the runtime-specific environment variable.
 * A runtime request can therefore select an approved install, but cannot turn
 * diagnostics, provider discovery, auth checks, or dispatch into arbitrary
 * host code execution.
 */
export function validateRuntimeExecutable(
  runtime: PolicyControlledRuntime,
  configuredCommand: unknown,
): string | null {
  const policy = RUNTIME_EXECUTABLE_POLICIES[runtime];
  if (configuredCommand == null) return null;
  if (typeof configuredCommand !== 'string') {
    return `runtime_config.${policy.configField} must be a string`;
  }

  const command = configuredCommand.trim();
  if (!command || command === policy.defaultCommand) return null;
  if (!path.isAbsolute(command)) {
    return `runtime_config.${policy.configField} must be ${JSON.stringify(policy.defaultCommand)} or an absolute path listed in ${policy.allowlistEnvironmentVariable}`;
  }
  if (!allowlistedAbsolutePaths(policy.allowlistEnvironmentVariable).has(path.resolve(command))) {
    return `runtime_config.${policy.configField} path is not authorized by ${policy.allowlistEnvironmentVariable}`;
  }
  return null;
}

export function assertRuntimeExecutableAllowed(
  runtime: PolicyControlledRuntime,
  configuredCommand: unknown,
): void {
  const error = validateRuntimeExecutable(runtime, configuredCommand);
  if (error) throw new Error(error);
}

function executableCandidates(command: string, source: NodeJS.ProcessEnv): string[] {
  if (path.isAbsolute(command)) return [command];
  const pathValue = source.PATH ?? source.Path ?? source.path ?? '';
  const extensions = process.platform === 'win32'
    ? (source.PATHEXT ?? source.Pathext ?? '.EXE;.CMD;.BAT;.COM')
        .split(';')
        .filter(Boolean)
    : [''];
  return pathValue
    .split(path.delimiter)
    // Empty and relative PATH entries are cwd-dependent. The API cwd may be a
    // repository controlled by an agent, so only operator-owned absolute host
    // directories may supply the adapter's default executable.
    .filter((directory) => path.isAbsolute(directory))
    .flatMap((directory) => extensions.map((extension) => path.join(directory, `${command}${extension}`)));
}

/** Resolve an approved command to one canonical, executable host file. */
export function resolveAllowedRuntimeExecutable(
  runtime: PolicyControlledRuntime,
  configuredCommand: unknown,
  source: NodeJS.ProcessEnv = process.env,
): ResolvedRuntimeExecutable {
  assertRuntimeExecutableAllowed(runtime, configuredCommand);
  const policy = RUNTIME_EXECUTABLE_POLICIES[runtime];
  const command = typeof configuredCommand === 'string' && configuredCommand.trim()
    ? configuredCommand.trim()
    : policy.defaultCommand;

  for (const candidate of executableCandidates(command, source)) {
    try {
      const canonicalPath = fs.realpathSync(candidate);
      const stat = fs.statSync(canonicalPath);
      if (!stat.isFile()) continue;
      if (process.platform !== 'win32') fs.accessSync(canonicalPath, fs.constants.X_OK);
      const identity = [
        canonicalPath,
        stat.dev,
        stat.ino,
        stat.size,
        stat.mtimeMs,
        stat.mode,
      ].join(':');
      return {
        path: canonicalPath,
        fingerprint: `sha256:${createHash('sha256').update(identity).digest('hex')}`,
      };
    } catch {
      // Try the next host PATH candidate. No shell or runtime-owned environment
      // participates in resolution.
    }
  }
  throw new Error(`Approved ${runtime} executable ${JSON.stringify(command)} could not be resolved to an executable file.`);
}
