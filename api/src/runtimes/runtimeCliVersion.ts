import { execFile } from 'child_process';
import { sanitizedRuntimeProcessEnv } from './environment';
import {
  resolveAllowedRuntimeExecutable,
  type PolicyControlledRuntime,
} from './executablePolicy';

interface VerifiedCliRange {
  minimum: readonly [number, number, number];
  maximumExclusive: readonly [number, number, number];
}

export const VERIFIED_RUNTIME_CLI_RANGES: Record<PolicyControlledRuntime, VerifiedCliRange> = {
  'claude-code': { minimum: [2, 1, 220], maximumExclusive: [2, 2, 0] },
  codex: { minimum: [0, 146, 0], maximumExclusive: [0, 147, 0] },
};

export interface RuntimeCliVersionResult {
  ok: boolean;
  version: string | null;
  /** Canonical host path actually executed by the version probe. */
  executablePath: string | null;
  /** Non-secret identity recorded alongside the canonical executable path. */
  executableFingerprint: string | null;
  message: string;
  details: {
    minimum_supported: string;
    maximum_exclusive: string;
    detected?: string;
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
  runtime: PolicyControlledRuntime,
  version: string | null,
): RuntimeCliVersionResult {
  const { minimum, maximumExclusive } = VERIFIED_RUNTIME_CLI_RANGES[runtime];
  const minimumText = minimum.join('.');
  const maximumText = maximumExclusive.join('.');
  const details: RuntimeCliVersionResult['details'] = {
    minimum_supported: minimumText,
    maximum_exclusive: maximumText,
  };
  const actual = parseSemanticVersion(version);
  if (!actual) {
    return {
      ok: false,
      version,
      executablePath: null,
      executableFingerprint: null,
      message: `Could not verify ${runtime} CLI version; Agent HQ supports ${minimumText} through versions below ${maximumText}.`,
      details,
    };
  }

  const actualText = actual.join('.');
  const supported = compareVersion(actual, minimum) >= 0
    && compareVersion(actual, maximumExclusive) < 0;
  return {
    ok: supported,
    version,
    executablePath: null,
    executableFingerprint: null,
    message: supported
      ? `${version} (supported: >=${minimumText}, <${maximumText})`
      : `${version} is outside the verified ${runtime} CLI range >=${minimumText}, <${maximumText}.`,
    details: { ...details, detected: actualText },
  };
}

/**
 * Run only the CLI's zero-model-spend `--version` command after enforcing the
 * same host executable policy used by dispatch. `pathValue` exists for the
 * diagnostic resolver/tests; HTTP callers cannot supply it.
 */
export async function probeAllowedRuntimeCliVersion(params: {
  runtime: PolicyControlledRuntime;
  command: string;
  timeoutMs?: number;
  pathValue?: string;
}): Promise<RuntimeCliVersionResult> {
  const range = VERIFIED_RUNTIME_CLI_RANGES[params.runtime];
  const baseDetails = {
    minimum_supported: range.minimum.join('.'),
    maximum_exclusive: range.maximumExclusive.join('.'),
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
