import fs from 'fs';
import { type Db } from '../db/adapter/types';
import { getRuntimeProviderAdapter } from '../domains/providers/runtimeAdapters';
import { resolveAllowedRuntimeExecutable } from '../runtimes/executablePolicy';
import { readRuntimeConnectionConfig } from './runtimeOnboarding';

/**
 * The runtimes onboarding can put starter agents on. Claude Code is recommended; Codex and
 * OpenClaw are supported. Claude Code and Codex agents run the CLI on this machine with the
 * operator's own login, so they need the CLI installed and logged in where the API runs.
 */
export const STARTER_RUNTIME_TYPES = ['claude-code', 'codex', 'openclaw'] as const;
export type StarterRuntimeType = (typeof STARTER_RUNTIME_TYPES)[number];
export const RECOMMENDED_STARTER_RUNTIME: StarterRuntimeType = 'claude-code';

export type StarterRuntimeStatus = 'ready' | 'not_installed' | 'not_logged_in' | 'needs_setup';

/** A CLI login the starter agents will use, as a provider connection reference (never the credential). */
export type StarterRuntimeLogin = {
  runtime_type: 'claude-code' | 'codex';
  provider_slug: string;
  auth_mode: 'subscription';
  external_ref: string;
  display_name: string;
};

export type StarterRuntimeOption = {
  type: StarterRuntimeType;
  label: string;
  description: string;
  recommended: boolean;
  status: StarterRuntimeStatus;
  /** Plain-language state, shown next to the option. */
  message: string;
  /** Commands that fix the state, in order. Empty when ready. */
  fix: string[];
  login: StarterRuntimeLogin | null;
};

type CliRuntimeSpec = {
  type: 'claude-code' | 'codex';
  label: string;
  description: string;
  provider: string;
  install: string;
  login: string;
};

const CLI_RUNTIMES: Record<'claude-code' | 'codex', CliRuntimeSpec> = {
  'claude-code': {
    type: 'claude-code',
    label: 'Claude Code',
    description: 'Runs Claude Code on this machine with your Claude login.',
    provider: 'anthropic',
    install: 'npm install -g @anthropic-ai/claude-code',
    login: 'claude auth login',
  },
  codex: {
    type: 'codex',
    label: 'Codex',
    description: 'Runs the Codex CLI on this machine with your ChatGPT login.',
    provider: 'openai-codex',
    install: 'npm install -g @openai/codex',
    login: 'codex login',
  },
};

export const STARTER_RUNTIME_LABELS: Record<StarterRuntimeType, string> = {
  'claude-code': CLI_RUNTIMES['claude-code'].label,
  codex: CLI_RUNTIMES.codex.label,
  openclaw: 'OpenClaw',
};

export function isStarterRuntimeType(value: unknown): value is StarterRuntimeType {
  return typeof value === 'string' && (STARTER_RUNTIME_TYPES as readonly string[]).includes(value);
}

/** The Docker image has no Claude Code or Codex CLI, and the host's logins are not visible in it. */
function runningInContainer(): boolean {
  return fs.existsSync('/.dockerenv');
}

async function detectCliRuntime(spec: CliRuntimeSpec): Promise<StarterRuntimeOption> {
  const base = {
    type: spec.type,
    label: spec.label,
    description: spec.description,
    recommended: spec.type === RECOMMENDED_STARTER_RUNTIME,
  };
  try {
    resolveAllowedRuntimeExecutable(spec.type, undefined);
  } catch {
    if (runningInContainer()) {
      return {
        ...base,
        status: 'not_installed',
        message: `Agent HQ is running inside Docker, which cannot use the ${spec.label} on your machine. Start Agent HQ with --no-docker to use ${spec.label}, or choose OpenClaw.`,
        fix: [],
        login: null,
      };
    }
    return {
      ...base,
      status: 'not_installed',
      message: `${spec.label} is not installed on this machine.`,
      fix: [spec.install, spec.login],
      login: null,
    };
  }

  const adapter = getRuntimeProviderAdapter(spec.type, spec.provider, 'subscription');
  const logins = adapter ? await adapter.discover({}).catch(() => []) : [];
  const found = logins[0];
  if (!found) {
    return {
      ...base,
      status: 'not_logged_in',
      message: `${spec.label} is installed but not logged in.`,
      fix: [spec.login],
      login: null,
    };
  }
  return {
    ...base,
    status: 'ready',
    message: `${spec.label} is installed and logged in. The starter agents will use this login.`,
    fix: [],
    login: {
      runtime_type: spec.type,
      provider_slug: spec.provider,
      auth_mode: 'subscription',
      external_ref: found.externalRef,
      display_name: found.displayName,
    },
  };
}

async function detectOpenClaw(db: Db): Promise<StarterRuntimeOption> {
  const configured = (await readRuntimeConnectionConfig(db))?.kind === 'openclaw';
  return {
    type: 'openclaw',
    label: STARTER_RUNTIME_LABELS.openclaw,
    description: 'Runs agents on an OpenClaw gateway, on this machine or another one.',
    recommended: false,
    status: configured ? 'ready' : 'needs_setup',
    message: configured
      ? 'An OpenClaw gateway is connected.'
      : 'Connect a model provider and an OpenClaw gateway in the next steps.',
    fix: [],
    login: null,
  };
}

export async function detectStarterRuntime(db: Db, type: StarterRuntimeType): Promise<StarterRuntimeOption> {
  return type === 'openclaw' ? detectOpenClaw(db) : detectCliRuntime(CLI_RUNTIMES[type]);
}

/**
 * Every starter runtime and its state on this machine. `suggested` is the recommended runtime when
 * it is ready, otherwise the first ready one, otherwise the recommended one.
 */
export async function detectStarterRuntimes(db: Db): Promise<{
  recommended: StarterRuntimeType;
  suggested: StarterRuntimeType;
  options: StarterRuntimeOption[];
}> {
  const options = await Promise.all(STARTER_RUNTIME_TYPES.map((type) => detectStarterRuntime(db, type)));
  const ready = options.filter((option) => option.status === 'ready');
  const suggested = ready.find((option) => option.recommended)?.type ?? ready[0]?.type ?? RECOMMENDED_STARTER_RUNTIME;
  return { recommended: RECOMMENDED_STARTER_RUNTIME, suggested, options };
}
