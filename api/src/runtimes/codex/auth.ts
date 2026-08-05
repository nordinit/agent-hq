import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  resolveOAuthCredentialForProvider,
  type OpenClawOAuthCredential,
} from '../../lib/openclawOAuthProfiles';
import type {
  PrepareAuthProfilesParams,
  RuntimeAuthProfileSyncResult,
} from '../types';
import { skippedRuntimeAuthProfileSync } from '../types';
import { buildRuntimeChildEnv } from '../environment';
import { probeAllowedRuntimeCliVersion } from '../runtimeCliVersion';
import { normalizeCodexRuntimeConfig } from './config';
import type { CodexRuntimeConfig, NormalizedCodexRuntimeConfig } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trustedPositiveInteger(value: number | null | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`Managed Codex home requires a trusted positive ${label}`);
  }
  return Number(value);
}

export function resolveCodexHome(
  _agentSlug: string,
  config: Pick<NormalizedCodexRuntimeConfig, 'codexHomeRoot'>,
  identity: { tenantId?: number | null; agentId?: number | null },
): string {
  const runStateRoot = process.env.AGENT_HQ_RUN_STATE_DIR?.trim();
  const dataRoot = process.env.AGENT_HQ_DATA_DIR?.trim();
  const root = config.codexHomeRoot
    ? path.resolve(config.codexHomeRoot)
    : runStateRoot
      ? path.resolve(runStateRoot)
      : dataRoot
        ? path.join(path.resolve(dataRoot), 'runtime-state')
        : path.join(os.homedir(), '.agent-hq', 'runtime-state');
  const tenantId = trustedPositiveInteger(identity.tenantId, 'tenantId');
  const agentId = trustedPositiveInteger(identity.agentId, 'agentId');
  // Slugs are mutable display/routing labels. Only immutable database ownership
  // determines the credential home, so two tenants with the same slug cannot
  // share auth, sessions, config, or MCP state.
  return path.join(root, 'codex', `tenant-${tenantId}`, `agent-${agentId}`);
}

/** Opaque provider profile reference shared by discovery and dispatch. */
export function codexProviderHomeReference(home: string): string {
  const resolvedHome = path.resolve(home);
  const defaultHome = path.resolve(path.join(os.homedir(), '.codex'));
  if (resolvedHome === defaultHome) return 'codex:default';
  const digest = createHash('sha256').update(resolvedHome).digest('hex').slice(0, 12);
  return `codex:${digest}`;
}

function resolveRuntimeOwnedCodexHome(config: NormalizedCodexRuntimeConfig): string {
  const environmentHome = process.env.CODEX_HOME?.trim();
  // Compatibility with connections discovered before `codexHome` was added:
  // that adapter treated codexHomeRoot as the exact CLI-owned profile home.
  const configuredHome = config.codexHome ?? config.codexHomeRoot;
  // `codex:default` is a stable reference to ~/.codex. A later process-level
  // CODEX_HOME override must not silently retarget an existing default-profile
  // connection; hashed environment profiles, conversely, must still resolve
  // through the matching environment value when no exact config was stored.
  const candidate = configuredHome
    ?? (config.providerConnectionExternalRef === 'codex:default'
      ? path.join(os.homedir(), '.codex')
      : environmentHome);
  if (!candidate) {
    throw new Error(
      `Runtime-owned Codex profile ${config.providerConnectionExternalRef ?? '(unknown)'} requires runtime_config.codexHome or the original CODEX_HOME`,
    );
  }

  const resolved = path.resolve(candidate);
  const expectedRef = config.providerConnectionExternalRef;
  const actualRef = codexProviderHomeReference(resolved);
  if (expectedRef && expectedRef !== actualRef) {
    throw new Error(
      `Runtime-owned Codex profile ${expectedRef} does not match the configured CODEX_HOME (${actualRef})`,
    );
  }
  return resolved;
}

export function resolveEffectiveCodexHome(params: {
  agentSlug: string;
  config: NormalizedCodexRuntimeConfig;
  providerConnectionId?: number | null;
  tenantId?: number | null;
  agentId?: number | null;
}): string {
  return params.providerConnectionId != null
    ? resolveRuntimeOwnedCodexHome(params.config)
    : resolveCodexHome(params.agentSlug, params.config, params);
}

function readJson(filePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeJsonAtomic(filePath: string, value: Record<string, unknown>): boolean {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  let previous = '';
  try {
    previous = fs.readFileSync(filePath, 'utf8');
  } catch {
    // First materialization.
  }
  if (previous === serialized) {
    fs.chmodSync(filePath, 0o600);
    return false;
  }

  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filePath);
  return true;
}

export function upsertCodexOAuthAuth(
  authPath: string,
  credential: OpenClawOAuthCredential,
): boolean {
  const existing = readJson(authPath);
  const existingTokens = isRecord(existing.tokens) ? existing.tokens : {};
  const tokens: Record<string, unknown> = {
    ...existingTokens,
    access_token: credential.access,
    refresh_token: credential.refresh,
  };
  delete tokens.id_token;
  delete tokens.account_id;
  if (credential.idToken) tokens.id_token = credential.idToken;
  if (credential.accountId) tokens.account_id = credential.accountId;

  const unchanged =
    existing.OPENAI_API_KEY === null &&
    existingTokens.access_token === tokens.access_token &&
    existingTokens.refresh_token === tokens.refresh_token &&
    existingTokens.id_token === tokens.id_token &&
    existingTokens.account_id === tokens.account_id;
  if (unchanged && fs.existsSync(authPath)) {
    fs.chmodSync(authPath, 0o600);
    return false;
  }

  return writeJsonAtomic(authPath, {
    ...existing,
    OPENAI_API_KEY: null,
    tokens,
    last_refresh: new Date().toISOString(),
  });
}

export function codexAuthReady(authPath: string): boolean {
  const data = readJson(authPath);
  if (typeof data.OPENAI_API_KEY === 'string' && data.OPENAI_API_KEY.trim()) return true;
  const tokens = isRecord(data.tokens) ? data.tokens : {};
  return [tokens.access_token, tokens.refresh_token].some(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
}

async function codexCliAuthReady(codexBin: string, codexHome: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      codexBin,
      ['login', 'status'],
      {
        env: buildRuntimeChildEnv({ CODEX_HOME: codexHome }),
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 128 * 1024,
      },
      (error) => resolve(!error),
    );
  });
}

export async function prepareCodexAuthProfiles(
  baseConfig: CodexRuntimeConfig,
  params: PrepareAuthProfilesParams,
): Promise<RuntimeAuthProfileSyncResult> {
  const config = normalizeCodexRuntimeConfig({
    ...baseConfig,
    ...((params.runtimeConfig as CodexRuntimeConfig | undefined) ?? {}),
  });
  const versionCheck = await probeAllowedRuntimeCliVersion({
    runtime: 'codex',
    command: config.codexBin,
  });
  if (!versionCheck.ok) {
    return {
      ok: false,
      status: 'failed',
      providersSynced: [],
      runtimeAuthProvidersSynced: [],
      openclawAuthProvidersSynced: [],
      source: 'runtime-cli-version',
      error: versionCheck.message,
      details: { runtime_cli_version: versionCheck.version, ...versionCheck.details },
    };
  }
  if (!versionCheck.executablePath) {
    return {
      ok: false,
      status: 'failed',
      providersSynced: [],
      runtimeAuthProvidersSynced: [],
      openclawAuthProvidersSynced: [],
      source: 'runtime-cli-version',
      error: 'Codex CLI version passed without a resolved executable identity.',
    };
  }
  let codexHome: string;
  try {
    codexHome = resolveEffectiveCodexHome({
      agentSlug: params.agentSlug,
      config,
      providerConnectionId: params.providerConnectionId,
      tenantId: params.tenantId,
      agentId: params.agentId,
    });
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      providersSynced: [],
      runtimeAuthProvidersSynced: [],
      openclawAuthProvidersSynced: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const authPath = path.join(codexHome, 'auth.json');
  const provider = params.preferredProvider ?? null;

  if (provider != null && provider !== 'openai-codex') {
    return {
      ok: false,
      status: 'failed',
      providersSynced: [],
      runtimeAuthProvidersSynced: [],
      openclawAuthProvidersSynced: [],
      source: 'runtime-provider-configuration',
      error: `Codex runtime supports the openai-codex provider, not ${provider}; API-key child environment credentials are intentionally unavailable.`,
      details: { runtime_cli_version: versionCheck.version },
    };
  }

  if (provider == null) {
    const ready = codexAuthReady(authPath) || await codexCliAuthReady(versionCheck.executablePath, codexHome);
    if (!ready) {
      return {
        ok: false,
        status: 'failed',
        providersSynced: [],
        runtimeAuthProvidersSynced: [],
        openclawAuthProvidersSynced: [],
        source: 'operator-managed-cli-profile',
        error: 'Codex has no selected provider connection and its effective CODEX_HOME is not authenticated; run `codex login` for that home or select an openai-codex connection.',
        details: {
          credential_owner: 'codex',
          auth_ready: false,
          runtime_cli_version: versionCheck.version,
        },
      };
    }
    return skippedRuntimeAuthProfileSync(
      'Codex operator-managed CLI authentication was verified; no provider connection materialization was required.',
    );
  }

  if (params.providerConnectionId != null) {
    // The provider connection is only an opaque reference. Codex remains the
    // credential owner, including refresh and keyring state; never copy global
    // OpenClaw OAuth into this home.
    const ready = codexAuthReady(authPath) || await codexCliAuthReady(versionCheck.executablePath, codexHome);
    return {
      ok: ready,
      status: ready ? 'synced' : 'failed',
      providersSynced: ready ? ['openai-codex'] : [],
      runtimeAuthProvidersSynced: ready ? ['openai-codex'] : [],
      openclawAuthProvidersSynced: [],
      runtimeAuthPath: authPath,
      source: 'runtime-provider-connection',
      refreshed: false,
      details: {
        codex_home: codexHome,
        credential_owner: 'codex',
        provider_connection_id: params.providerConnectionId,
        auth_ready: ready,
        auth_changed: false,
        runtime_cli_version: versionCheck.version,
      },
      ...(ready ? {} : {
        error: `Runtime-owned Codex profile at ${codexHome} is not authenticated; run ${versionCheck.executablePath} login with CODEX_HOME set to that directory.`,
      }),
    };
  }

  const resolved = await resolveOAuthCredentialForProvider({ provider: 'openai-codex' });
  if (!resolved.ok || !resolved.credential) {
    return {
      ok: false,
      status: 'failed',
      providersSynced: [],
      runtimeAuthProvidersSynced: [],
      openclawAuthProvidersSynced: [],
      runtimeAuthPath: authPath,
      source: resolved.source,
      refreshed: resolved.refreshed,
      error: resolved.error ?? 'No usable openai-codex OAuth credential was found.',
    };
  }

  const changed = upsertCodexOAuthAuth(authPath, resolved.credential);
  const ready = codexAuthReady(authPath);
  return {
    ok: ready,
    status: ready ? 'synced' : 'failed',
    providersSynced: ready ? ['openai-codex'] : [],
    runtimeAuthProvidersSynced: ready ? ['openai-codex'] : [],
    openclawAuthProvidersSynced: [],
    runtimeAuthPath: authPath,
    source: resolved.source,
    refreshed: resolved.refreshed,
    details: {
      codex_home: codexHome,
      auth_ready: ready,
      auth_changed: changed,
      expires_at: resolved.expiresAt ?? null,
      runtime_cli_version: versionCheck.version,
    },
    ...(ready ? {} : { error: `Codex auth file ${authPath} is not usable after sync.` }),
  };
}
