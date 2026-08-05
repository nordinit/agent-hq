import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { NormalizedCodexRuntimeConfig } from './types';
import { resolveCodexHome } from './auth';

export const CODEX_RUNTIME_PROFILE_PREFIX = 'agent-hq-runtime-';
/** Race grace for a just-created profile before its durable execution row exists. */
export const DEFAULT_CODEX_STALE_PROFILE_TTL_MS = 15 * 60 * 1_000;
const RUNTIME_PROFILE_FILE = /^agent-hq-runtime-(adhoc|\d+)-[a-f0-9]{20,32}\.config\.toml$/;

export interface CodexRuntimeProfile {
  name: string;
  configPath: string;
  snapshotPath: string;
  stateHome: string;
}

export interface CodexAdHocRuntimeAllocation {
  codexHome: string;
  allocationRoot: string;
  nonce: string;
  profile: CodexRuntimeProfile;
}

export interface CodexRuntimeProfileScavengeResult {
  removed: string[];
  retainedFresh: string[];
  retainedActive: string[];
  failures: Array<{ name: string; error: string }>;
}

function agentHqRuntimeStateRoot(): string {
  const configured = process.env.AGENT_HQ_RUN_STATE_DIR?.trim();
  if (configured) return path.resolve(configured);
  const dataRoot = process.env.AGENT_HQ_DATA_DIR?.trim();
  return dataRoot
    ? path.join(path.resolve(dataRoot), 'runtime-state')
    : path.join(os.homedir(), '.agent-hq', 'runtime-state');
}

/**
 * Allocate one boundaryless diagnostic home without inventing a tenant/agent
 * identity or sharing mutable config with another launch. Authentication is a
 * reference to an explicitly selected provider profile; credential bytes are
 * never copied into the ad-hoc home.
 */
export function allocateCodexAdHocRuntimeProfile(params: {
  providerAuthPath: string;
}): CodexAdHocRuntimeAllocation {
  const providerAuthPath = fs.realpathSync(params.providerAuthPath);
  if (!fs.statSync(providerAuthPath).isFile()) {
    throw new Error('Explicit Codex provider auth path is not a regular file');
  }

  const allocationRoot = path.join(agentHqRuntimeStateRoot(), 'codex', 'adhoc');
  fs.mkdirSync(allocationRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(agentHqRuntimeStateRoot(), 'codex'), 0o700);
  fs.chmodSync(allocationRoot, 0o700);

  const nonce = randomUUID().replace(/-/g, '');
  const codexHome = path.join(allocationRoot, nonce);
  fs.mkdirSync(codexHome, { mode: 0o700 });
  try {
    fs.chmodSync(codexHome, 0o700);
    fs.symlinkSync(providerAuthPath, path.join(codexHome, 'auth.json'));

    const stateHome = path.join(codexHome, 'runtime-profiles');
    fs.mkdirSync(stateHome, { mode: 0o700 });
    fs.chmodSync(stateHome, 0o700);
    const name = `${CODEX_RUNTIME_PROFILE_PREFIX}adhoc-${nonce}`;
    return {
      codexHome,
      allocationRoot,
      nonce,
      profile: {
        name,
        configPath: path.join(codexHome, `${name}.config.toml`),
        snapshotPath: path.join(stateHome, 'agent-hq-mcp-servers.json'),
        stateHome,
      },
    };
  } catch (error) {
    fs.rmSync(codexHome, { recursive: true, force: true });
    throw error;
  }
}

/** Remove only the exact nonce home returned by the ad-hoc allocator. */
export function removeCodexAdHocRuntimeProfile(
  allocation: CodexAdHocRuntimeAllocation,
): void {
  const allocationRoot = path.resolve(allocation.allocationRoot);
  const codexHome = path.resolve(allocation.codexHome);
  if (
    !/^[a-f0-9]{32}$/.test(allocation.nonce)
    || path.basename(codexHome) !== allocation.nonce
    || path.dirname(codexHome) !== allocationRoot
    || path.basename(allocationRoot) !== 'adhoc'
    || path.basename(path.dirname(allocationRoot)) !== 'codex'
  ) {
    throw new Error('Refusing to remove a Codex ad-hoc home outside its exact allocation root');
  }
  fs.rmSync(codexHome, { recursive: true, force: true });
}

export function scavengeStaleCodexRuntimeProfiles(
  credentialHome: string,
  options: {
    nowMs?: number;
    ttlMs?: number;
    protectedInstanceIds?: ReadonlySet<number>;
  } = {},
): CodexRuntimeProfileScavengeResult {
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_CODEX_STALE_PROFILE_TTL_MS;
  if (!Number.isFinite(nowMs) || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('Codex stale profile scavenging requires a positive finite TTL');
  }
  const result: CodexRuntimeProfileScavengeResult = {
    removed: [],
    retainedFresh: [],
    retainedActive: [],
    failures: [],
  };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(credentialHome, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error;
  }

  for (const entry of entries) {
    const match = entry.name.match(RUNTIME_PROFILE_FILE);
    if (!match || !entry.isFile()) continue;
    const instanceId = match[1] === 'adhoc' ? null : Number(match[1]);
    if (instanceId != null && options.protectedInstanceIds?.has(instanceId)) {
      result.retainedActive.push(entry.name);
      continue;
    }
    const filePath = path.join(credentialHome, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      result.failures.push({
        name: entry.name,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!stat.isFile() || nowMs - stat.mtimeMs < ttlMs) {
      result.retainedFresh.push(entry.name);
      continue;
    }
    try {
      fs.unlinkSync(filePath);
      result.removed.push(entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        result.removed.push(entry.name);
      } else {
        result.failures.push({
          name: entry.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return result;
}

/**
 * Resolve storage owned by Agent HQ, not by the Codex CLI credential profile.
 *
 * `codexHomeRoot` was historically interpreted as the exact provider home when
 * a provider connection is selected. In that compatibility shape it must not
 * also become the mutable runtime-state root. An independently configured root
 * remains usable when it is distinct from the credential home.
 */
export function resolveCodexRuntimeStateHome(params: {
  agentSlug: string;
  config: NormalizedCodexRuntimeConfig;
  credentialHome: string;
  providerConnectionId?: number | null;
  tenantId: number | null;
  agentId: number | null;
}): string {
  const configuredRoot = params.config.codexHomeRoot
    && path.resolve(params.config.codexHomeRoot) !== path.resolve(params.credentialHome)
    ? params.config.codexHomeRoot
    : null;
  const stateConfig: Pick<NormalizedCodexRuntimeConfig, 'codexHomeRoot'> = {
    codexHomeRoot: params.providerConnectionId != null ? configuredRoot : params.config.codexHomeRoot,
  };
  return path.join(
    resolveCodexHome(params.agentSlug, stateConfig, params),
    'runtime-profiles',
  );
}

/** Allocate paths for one immutable-in-use Codex profile. */
export function allocateCodexRuntimeProfile(params: {
  agentSlug: string;
  config: NormalizedCodexRuntimeConfig;
  credentialHome: string;
  providerConnectionId?: number | null;
  tenantId: number | null;
  agentId: number | null;
  instanceId: number | null;
}): CodexRuntimeProfile {
  const stateHome = resolveCodexRuntimeStateHome(params);
  fs.mkdirSync(stateHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateHome, 0o700);

  const instance = params.instanceId == null ? 'adhoc' : String(params.instanceId);
  const nonce = randomUUID().replace(/-/g, '');
  const name = `${CODEX_RUNTIME_PROFILE_PREFIX}${instance}-${nonce}`;
  return {
    name,
    configPath: path.join(params.credentialHome, `${name}.config.toml`),
    snapshotPath: path.join(stateHome, 'agent-hq-mcp-servers.json'),
    stateHome,
  };
}

/** Remove only a profile allocated by the helper above. */
export function removeCodexRuntimeProfile(
  credentialHome: string,
  profile: Pick<CodexRuntimeProfile, 'name' | 'configPath'>,
): void {
  const expected = path.join(path.resolve(credentialHome), `${profile.name}.config.toml`);
  if (
    !profile.name.startsWith(CODEX_RUNTIME_PROFILE_PREFIX)
    || path.resolve(profile.configPath) !== expected
  ) {
    throw new Error('Refusing to remove a Codex profile outside the allocated credential home');
  }
  try {
    fs.unlinkSync(expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
