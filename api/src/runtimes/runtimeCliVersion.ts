import { execFile } from 'child_process';
import { sanitizedRuntimeProcessEnv } from './environment';
import {
  resolveAllowedRuntimeExecutable,
  type PolicyControlledRuntime,
} from './executablePolicy';

interface RuntimeCliVersionPolicy {
  /** Oldest CLI the adapter supports. Older versions are refused. */
  minimum: readonly [number, number, number];
  /**
   * The major.minor release family the adapter's tool-surface policy was last
   * verified against. Newer releases are allowed (Agent HQ enforces only the
   * minimum) but diagnostics warn until the policy is re-verified for them.
   */
  verifiedFamily: readonly [number, number];
}

/** Runtimes whose CLI contract Agent HQ checks before launch. */
export type VersionVerifiedRuntime = Extract<PolicyControlledRuntime, 'claude-code' | 'codex'>;

export const RUNTIME_CLI_VERSION_POLICIES: Record<VersionVerifiedRuntime, RuntimeCliVersionPolicy> = {
  'claude-code': { minimum: [2, 1, 220], verifiedFamily: [2, 1] },
  // Codex minors change feature names, model-driven tool modes and MCP approval
  // defaults. 0.164 is the first release the hardened policy supports
  // (code-mode models, MCP approval mode, agents/skills config keys).
  codex: { minimum: [0, 164, 0], verifiedFamily: [0, 164] },
};

export interface RuntimeCliVersionResult {
  ok: boolean;
  version: string | null;
  /** Canonical host path actually executed by the version probe. */
  executablePath: string | null;
  /** Non-secret identity recorded alongside the canonical executable path. */
  executableFingerprint: string | null;
  message: string;
  /** True when the CLI is newer than the release family the adapter policy was verified against. */
  newerThanVerified?: boolean;
  details: {
    minimum_supported: string;
    verified_family: string;
    detected?: string;
    newer_than_verified?: boolean;
    executable_path?: string;
    executable_fingerprint?: string;
  };
}

function compactVersionOutput(stdout: string, stderr: string): string | null {
  const line = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ? line.slice(0, 300) : null;
}

function parseSemanticVersion(value: string | null): [number, number, number] | null {
  const match = value?.match(/(?:^|\D)(\d+)\.(\d+)\.(\d+)(?:\D|$)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersion(
  actual: readonly [number, number, number],
  boundary: readonly [number, number, number],
): number {
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== boundary[index]) return actual[index] - boundary[index];
  }
  return 0;
}

export function assessRuntimeCliVersion(
  runtime: VersionVerifiedRuntime,
  version: string | null,
): RuntimeCliVersionResult {
  const { minimum, verifiedFamily } = RUNTIME_CLI_VERSION_POLICIES[runtime];
  const minimumText = minimum.join('.');
  const familyText = `${verifiedFamily.join('.')}.x`;
  const details: RuntimeCliVersionResult['details'] = {
    minimum_supported: minimumText,
    verified_family: familyText,
  };
  const actual = parseSemanticVersion(version);
  if (!actual) {
    return {
      ok: false,
      version,
      executablePath: null,
      executableFingerprint: null,
      message: `Could not verify ${runtime} CLI version; Agent HQ requires ${minimumText} or newer.`,
      details,
    };
  }

  const actualText = actual.join('.');
  const supported = compareVersion(actual, minimum) >= 0;
  const newer = compareVersion(actual, [verifiedFamily[0], verifiedFamily[1] + 1, 0]) >= 0;
  return {
    ok: supported,
    version,
    executablePath: null,
    executableFingerprint: null,
    newerThanVerified: supported && newer,
    message: !supported
      ? `${version} is older than the minimum supported ${runtime} CLI ${minimumText}.`
      : newer
        ? `${version} is allowed (>=${minimumText}) but newer than ${familyText}, the release the ${runtime} adapter's tool policy was verified against; re-verify the policy for this release.`
        : `${version} (supported: >=${minimumText}; tool policy verified on ${familyText})`,
    details: { ...details, detected: actualText, newer_than_verified: supported && newer },
  };
}

/**
 * Run only the CLI's zero-model-spend `--version` command after enforcing the
 * same host executable policy used by dispatch. `pathValue` exists for the
 * diagnostic resolver/tests; HTTP callers cannot supply it.
 */
export async function probeAllowedRuntimeCliVersion(params: {
  runtime: VersionVerifiedRuntime;
  command: string;
  timeoutMs?: number;
  pathValue?: string;
}): Promise<RuntimeCliVersionResult> {
  const policy = RUNTIME_CLI_VERSION_POLICIES[params.runtime];
  const baseDetails = {
    minimum_supported: policy.minimum.join('.'),
    verified_family: `${policy.verifiedFamily.join('.')}.x`,
  };
  let executable: ReturnType<typeof resolveAllowedRuntimeExecutable>;
  try {
    const resolverEnvironment = params.pathValue === undefined
      ? process.env
      : { ...process.env, PATH: params.pathValue };
    executable = resolveAllowedRuntimeExecutable(params.runtime, params.command, resolverEnvironment);
  } catch (error) {
    return {
      ok: false,
      version: null,
      executablePath: null,
      executableFingerprint: null,
      message: error instanceof Error ? error.message : String(error),
      details: baseDetails,
    };
  }

  const env = sanitizedRuntimeProcessEnv();
  if (params.pathValue !== undefined) env.PATH = params.pathValue;
  const probe = await new Promise<{
    ok: true;
    stdout: string;
    stderr: string;
  } | {
    ok: false;
    timedOut: boolean;
  }>((resolve) => {
    execFile(
      executable.path,
      ['--version'],
      {
        env,
        encoding: 'utf8',
        timeout: params.timeoutMs ?? 5_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            timedOut: Boolean((error as NodeJS.ErrnoException & { killed?: boolean }).killed),
          });
          return;
        }
        resolve({
          ok: true,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        });
      },
    );
  });

  if (!probe.ok) {
    return {
      ok: false,
      version: null,
      executablePath: executable.path,
      executableFingerprint: executable.fingerprint,
      message: probe.timedOut
        ? `Version probe exceeded ${params.timeoutMs ?? 5_000}ms.`
        : `${params.runtime} CLI version probe failed before launch.`,
      details: {
        ...baseDetails,
        executable_path: executable.path,
        executable_fingerprint: executable.fingerprint,
      },
    };
  }
  const assessment = assessRuntimeCliVersion(
    params.runtime,
    compactVersionOutput(probe.stdout, probe.stderr),
  );
  return {
    ...assessment,
    executablePath: executable.path,
    executableFingerprint: executable.fingerprint,
    details: {
      ...assessment.details,
      executable_path: executable.path,
      executable_fingerprint: executable.fingerprint,
    },
  };
}
