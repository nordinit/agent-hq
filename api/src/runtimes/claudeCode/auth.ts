import { execFile } from 'child_process';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import type {
  PrepareAuthProfilesParams,
  RuntimeAuthProfileSyncResult,
} from '../types';
import { skippedRuntimeAuthProfileSync } from '../types';
import { buildRuntimeChildEnv } from '../environment';
import { probeAllowedRuntimeCliVersion } from '../runtimeCliVersion';
import { normalizeClaudeCodeRuntimeConfig } from './config';
import type { ClaudeCodeRuntimeConfig, NormalizedClaudeCodeRuntimeConfig } from './types';

export function claudeProviderHomeReference(home: string): string {
  const resolvedHome = path.resolve(home);
  const defaultHome = path.resolve(path.join(os.homedir(), '.claude'));
  if (resolvedHome === defaultHome) return 'claude-code:default';
  const digest = createHash('sha256').update(resolvedHome).digest('hex').slice(0, 12);
  return `claude-code:${digest}`;
}

export function resolveEffectiveClaudeConfigHome(params: {
  config: NormalizedClaudeCodeRuntimeConfig;
  providerConnectionId?: number | null;
}): string {
  const defaultHome = path.join(os.homedir(), '.claude');
  const environmentHome = process.env.CLAUDE_CONFIG_DIR?.trim() || null;
  const expectedRef = params.config.providerConnectionExternalRef;

  if (params.providerConnectionId == null) {
    return path.resolve(params.config.claudeConfigDir ?? environmentHome ?? defaultHome);
  }
  if (!expectedRef) {
    throw new Error('Selected Claude Code provider connection is missing its profile reference.');
  }

  const candidate = expectedRef === 'claude-code:default'
    ? defaultHome
    : params.config.claudeConfigDir ?? environmentHome;
  if (!candidate) {
    throw new Error(`Claude Code profile ${expectedRef} requires runtime_config.claudeConfigDir or the original CLAUDE_CONFIG_DIR.`);
  }
  const actualRef = claudeProviderHomeReference(candidate);
  if (actualRef !== expectedRef) {
    throw new Error(`Claude Code profile ${expectedRef} does not match the configured profile (${actualRef}).`);
  }
  return path.resolve(candidate);
}

async function claudeAuthReady(
  claudeBin: string,
  configHome: string,
): Promise<boolean> {
  return await new Promise((resolve) => {
    execFile(
      claudeBin,
      ['auth', 'status', '--json'],
      {
        env: buildRuntimeChildEnv({ CLAUDE_CONFIG_DIR: configHome }),
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 128 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) return resolve(false);
        try {
          const parsed = JSON.parse(String(stdout)) as { loggedIn?: unknown };
          resolve(parsed.loggedIn === true);
        } catch {
          resolve(false);
        }
      },
    );
  });
}

/** Verify a selected Claude-owned provider profile immediately before launch. */
export async function prepareClaudeCodeAuthProfiles(
  baseConfig: ClaudeCodeRuntimeConfig,
  params: PrepareAuthProfilesParams,
): Promise<RuntimeAuthProfileSyncResult> {
  if (
    params.providerConnectionId != null
    && params.preferredProvider
    && params.preferredProvider !== 'anthropic'
  ) {
    return {
      ok: false,
      status: 'failed',
      providersSynced: [],
      runtimeAuthProvidersSynced: [],
      openclawAuthProvidersSynced: [],
      source: 'runtime-provider-connection',
      error: `Claude Code provider connection requires anthropic, got ${params.preferredProvider}.`,
    };
  }

  let config;
  try {
    config = normalizeClaudeCodeRuntimeConfig({
      ...baseConfig,
      ...((params.runtimeConfig as ClaudeCodeRuntimeConfig | undefined) ?? {}),
    });
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      providersSynced: [],
      runtimeAuthProvidersSynced: [],
      openclawAuthProvidersSynced: [],
      source: 'runtime-provider-connection',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const versionCheck = await probeAllowedRuntimeCliVersion({
    runtime: 'claude-code',
    command: config.claudeBin,
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
      error: 'Claude Code CLI version passed without a resolved executable identity.',
    };
  }

  let configHome: string;
  try {
    configHome = resolveEffectiveClaudeConfigHome({
      config,
      providerConnectionId: params.providerConnectionId,
    });
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      providersSynced: [],
      runtimeAuthProvidersSynced: [],
      openclawAuthProvidersSynced: [],
      source: 'runtime-provider-connection',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  // Execute auth status through the exact canonical file that passed the
  // compatibility probe; neither runtime config nor its child environment can
  // redirect this second zero-spend command through PATH.
  const ready = await claudeAuthReady(versionCheck.executablePath, configHome);
  if (params.providerConnectionId == null) {
    if (!ready) {
      return {
        ok: false,
        status: 'failed',
        providersSynced: [],
        runtimeAuthProvidersSynced: [],
        openclawAuthProvidersSynced: [],
        source: 'operator-managed-cli-profile',
        error: 'The operator-managed Claude Code profile is not authenticated; run `claude auth login` for its effective CLAUDE_CONFIG_DIR.',
        details: {
          credential_owner: 'claude-code',
          auth_ready: false,
          runtime_cli_version: versionCheck.version,
        },
      };
    }
    return skippedRuntimeAuthProfileSync(
      'Claude Code operator-managed CLI authentication was verified; no provider connection materialization was required.',
    );
  }

  return {
    ok: ready,
    status: ready ? 'synced' : 'failed',
    providersSynced: ready ? ['anthropic'] : [],
    runtimeAuthProvidersSynced: ready ? ['anthropic'] : [],
    openclawAuthProvidersSynced: [],
    source: 'runtime-provider-connection',
    refreshed: false,
    details: {
      credential_owner: 'claude-code',
      provider_connection_id: params.providerConnectionId,
      auth_ready: ready,
      runtime_cli_version: versionCheck.version,
    },
    ...(ready ? {} : {
      error: 'The selected Claude Code profile is not authenticated; run `claude auth login` for its configured CLAUDE_CONFIG_DIR.',
    }),
  };
}
