import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { type Db } from "../../db/adapter/types";
import { codexProviderHomeReference } from '../../runtimes/codex/auth';
import { claudeProviderHomeReference } from '../../runtimes/claudeCode/auth';
import { buildRuntimeChildEnv } from '../../runtimes/environment';
import { resolveAllowedRuntimeExecutable } from '../../runtimes/executablePolicy';

export type RuntimeProviderKind = 'openclaw' | 'hermes' | 'claude-code' | 'codex';

export interface RuntimeProviderCapability {
  runtime: RuntimeProviderKind;
  provider: string;
  authModes: string[];
  supportsProfiles: boolean;
  supportsInteractiveLogin: boolean;
  supportsHeadlessLogin: boolean;
}

export interface RuntimeAuthInstructions {
  command: string;
  args: string[];
  message: string;
}

export interface DiscoveredProviderConnection {
  externalRef: string;
  displayName: string;
  metadata: Record<string, unknown>;
}

export interface RuntimeDispatchSelection {
  provider: string;
  model: string | null;
  runtimeConfig: Record<string, unknown>;
}

export interface RuntimeProviderAdapter {
  capability: RuntimeProviderCapability;
  authInstructions(): RuntimeAuthInstructions;
  discover(context?: { agentSlug?: string | null; runtimeConfig?: Record<string, unknown> | null }): Promise<DiscoveredProviderConnection[]>;
  buildDispatchConfig(input: {
    model: string | null;
    externalRef: string;
    runtimeConfig: Record<string, unknown>;
  }): RuntimeDispatchSelection;
}

function readObject(filePath: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function anthropicProfileKeys(document: Record<string, unknown> | null): string[] {
  const profiles = record(document?.profiles);
  return Object.keys(profiles).filter(key => key === 'anthropic' || key.startsWith('anthropic:'));
}

function hasJsonObject(filePath: string): boolean {
  return readObject(filePath) !== null;
}

function execFileOutput(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise(resolve => {
    execFile(command, args, {
      env,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
    }, (error, stdout) => {
      resolve({ ok: !error, stdout: typeof stdout === 'string' ? stdout : '' });
    });
  });
}

async function claudeCodeAuthReady(command: string, home: string): Promise<boolean> {
  const status = await execFileOutput(
    command,
    ['auth', 'status', '--json'],
    buildRuntimeChildEnv({ CLAUDE_CONFIG_DIR: home }),
  );
  if (!status.ok) return false;
  try {
    return readObjectFromText(status.stdout)?.loggedIn === true;
  } catch {
    return false;
  }
}

async function codexAuthReady(command: string, home: string): Promise<boolean> {
  const status = await execFileOutput(
    command,
    ['login', 'status'],
    buildRuntimeChildEnv({ CODEX_HOME: home }),
  );
  return status.ok;
}

function readObjectFromText(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return record(parsed);
  } catch {
    return null;
  }
}

class OpenClawAnthropicSubscriptionAdapter implements RuntimeProviderAdapter {
  capability: RuntimeProviderCapability = {
    runtime: 'openclaw',
    provider: 'anthropic',
    authModes: ['subscription'],
    supportsProfiles: true,
    supportsInteractiveLogin: true,
    supportsHeadlessLogin: true,
  };

  authInstructions(): RuntimeAuthInstructions {
    return {
      command: 'openclaw',
      args: ['models', 'auth', 'login', '--provider', 'anthropic'],
      message: 'OpenClaw will reuse Claude CLI subscription auth when available and keep the credential in its own per-agent auth store.',
    };
  }

  async discover(context: { agentSlug?: string | null } = {}): Promise<DiscoveredProviderConnection[]> {
    const root = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), '.openclaw');
    const agentsRoot = path.join(root, 'agents');
    const candidates: Array<{ agentSlug: string; filePath: string }> = [];
    if (context.agentSlug) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(context.agentSlug)) {
        throw new Error('OpenClaw agent slug contains unsupported path characters.');
      }
      candidates.push({
        agentSlug: context.agentSlug,
        filePath: path.join(agentsRoot, context.agentSlug, 'agent', 'auth-profiles.json'),
      });
    } else {
      try {
        for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            candidates.push({
              agentSlug: entry.name,
              filePath: path.join(agentsRoot, entry.name, 'agent', 'auth-profiles.json'),
            });
          }
        }
      } catch { /* no OpenClaw agents yet */ }
    }

    const found = new Map<string, DiscoveredProviderConnection>();
    for (const candidate of candidates) {
      for (const profileKey of anthropicProfileKeys(readObject(candidate.filePath))) {
        const externalRef = `${candidate.agentSlug}/${profileKey}`;
        found.set(externalRef, {
          externalRef,
          displayName: `Claude subscription (${candidate.agentSlug}: ${profileKey})`,
          metadata: { agent_slug: candidate.agentSlug, profile_id: profileKey, credential_owner: 'openclaw' },
        });
      }
    }
    return Array.from(found.values()).sort((a, b) => a.externalRef.localeCompare(b.externalRef));
  }

  buildDispatchConfig(input: { model: string | null; externalRef: string; runtimeConfig: Record<string, unknown> }): RuntimeDispatchSelection {
    const profileId = input.externalRef.includes('/') ? input.externalRef.split('/').slice(1).join('/') : input.externalRef;
    const model = input.model && profileId && !input.model.includes('@')
      ? `${input.model}@${profileId}`
      : input.model;
    return {
      provider: 'anthropic',
      model,
      runtimeConfig: { ...input.runtimeConfig, providerConnectionExternalRef: input.externalRef },
    };
  }
}

class HermesAnthropicSubscriptionAdapter implements RuntimeProviderAdapter {
  capability: RuntimeProviderCapability = {
    runtime: 'hermes',
    provider: 'anthropic',
    authModes: ['subscription'],
    supportsProfiles: true,
    supportsInteractiveLogin: true,
    supportsHeadlessLogin: false,
  };

  authInstructions(): RuntimeAuthInstructions {
    return {
      command: 'hermes',
      args: ['auth', 'add', 'anthropic', '--type', 'oauth'],
      message: 'Hermes owns this credential. Anthropic OAuth requires Claude Max with extra usage credits.',
    };
  }

  async discover(context: { agentSlug?: string | null; runtimeConfig?: Record<string, unknown> | null } = {}): Promise<DiscoveredProviderConnection[]> {
    const runtimeConfig = context.runtimeConfig ?? {};
    const profile = typeof runtimeConfig.profile === 'string' && runtimeConfig.profile.trim()
      ? runtimeConfig.profile.trim()
      : 'default';
    const explicitHome = typeof runtimeConfig.hermesHome === 'string' ? runtimeConfig.hermesHome.trim() : '';
    const root = explicitHome || path.join(os.homedir(), '.hermes');
    const authPaths = [
      path.join(root, 'profiles', profile, 'auth.json'),
      path.join(root, 'auth.json'),
    ];

    for (const authPath of authPaths) {
      const auth = readObject(authPath);
      const providers = record(auth?.providers);
      const pool = record(auth?.credential_pool);
      if (providers.anthropic || pool.anthropic) {
        return [{
          externalRef: `hermes:${profile}:anthropic`,
          displayName: `Claude subscription (Hermes profile: ${profile})`,
          metadata: { profile, credential_owner: 'hermes' },
        }];
      }
    }
    return [];
  }

  buildDispatchConfig(input: { model: string | null; externalRef: string; runtimeConfig: Record<string, unknown> }): RuntimeDispatchSelection {
    const model = input.model?.startsWith('anthropic/') ? input.model.slice('anthropic/'.length) : input.model;
    return {
      provider: 'anthropic',
      model,
      runtimeConfig: { ...input.runtimeConfig, provider: 'anthropic', providerConnectionExternalRef: input.externalRef },
    };
  }
}

class ClaudeCodeAnthropicSubscriptionAdapter implements RuntimeProviderAdapter {
  capability: RuntimeProviderCapability = {
    runtime: 'claude-code',
    provider: 'anthropic',
    authModes: ['subscription'],
    supportsProfiles: true,
    supportsInteractiveLogin: true,
    supportsHeadlessLogin: false,
  };

  authInstructions(): RuntimeAuthInstructions {
    return {
      command: 'claude',
      args: ['auth', 'login'],
      message: 'Claude Code owns this login. Agent HQ records only a reference to the CLI profile and never copies OAuth credentials.',
    };
  }

  async discover(context: { agentSlug?: string | null; runtimeConfig?: Record<string, unknown> | null } = {}): Promise<DiscoveredProviderConnection[]> {
    const executable = resolveAllowedRuntimeExecutable(
      'claude-code',
      context.runtimeConfig?.claudeBin,
    );
    const defaultHome = path.join(os.homedir(), '.claude');
    const configured = typeof context.runtimeConfig?.claudeConfigDir === 'string'
      ? context.runtimeConfig.claudeConfigDir.trim()
      : '';
    const home = configured || process.env.CLAUDE_CONFIG_DIR?.trim() || defaultHome;
    const credentialPath = [
      path.join(home, '.credentials.json'),
      path.join(home, 'credentials.json'),
    ].find(hasJsonObject);
    // macOS commonly keeps Claude credentials in Keychain rather than a JSON
    // file. The CLI status command is the source of truth and its output is
    // reduced to a boolean so account identifiers never enter Agent HQ.
    if (!credentialPath && !(await claudeCodeAuthReady(executable.path, home))) return [];

    const externalRef = claudeProviderHomeReference(home);
    return [{
      externalRef,
      displayName: externalRef.endsWith(':default')
        ? 'Claude subscription (Claude Code default profile)'
        : 'Claude subscription (Claude Code isolated profile)',
      metadata: {
        credential_owner: 'claude-code',
        profile: externalRef.split(':').slice(1).join(':'),
        ...(context.agentSlug ? { agent_slug: context.agentSlug } : {}),
      },
    }];
  }

  buildDispatchConfig(input: { model: string | null; externalRef: string; runtimeConfig: Record<string, unknown> }): RuntimeDispatchSelection {
    const model = input.model?.startsWith('anthropic/')
      ? input.model.slice('anthropic/'.length)
      : input.model;
    return {
      provider: 'anthropic',
      model,
      runtimeConfig: { ...input.runtimeConfig, providerConnectionExternalRef: input.externalRef },
    };
  }
}

class CodexSubscriptionAdapter implements RuntimeProviderAdapter {
  capability: RuntimeProviderCapability = {
    runtime: 'codex',
    provider: 'openai-codex',
    authModes: ['subscription'],
    supportsProfiles: true,
    supportsInteractiveLogin: true,
    supportsHeadlessLogin: true,
  };

  authInstructions(): RuntimeAuthInstructions {
    return {
      command: 'codex',
      args: ['login'],
      message: 'Codex owns this login. For an isolated profile, run it with CODEX_HOME set to that profile directory; Agent HQ stores only an opaque profile reference and never copies its OAuth credentials.',
    };
  }

  async discover(context: { agentSlug?: string | null; runtimeConfig?: Record<string, unknown> | null } = {}): Promise<DiscoveredProviderConnection[]> {
    const executable = resolveAllowedRuntimeExecutable(
      'codex',
      context.runtimeConfig?.codexBin,
    );
    const defaultHome = path.join(os.homedir(), '.codex');
    const exactConfiguredHome = typeof context.runtimeConfig?.codexHome === 'string'
      ? context.runtimeConfig.codexHome.trim()
      : '';
    // Compatibility: provider discovery historically treated codexHomeRoot as
    // an exact CLI-owned profile. The local runtime does the same only when a
    // provider connection is selected; without one it remains a managed parent.
    const legacyConfiguredHome = typeof context.runtimeConfig?.codexHomeRoot === 'string'
      ? context.runtimeConfig.codexHomeRoot.trim()
      : '';
    const environmentHome = process.env.CODEX_HOME?.trim() || '';
    const homeSource = exactConfiguredHome
      ? 'configured'
      : legacyConfiguredHome
        ? 'configured-legacy'
        : environmentHome
          ? 'environment'
          : 'default';
    const home = exactConfiguredHome || legacyConfiguredHome || environmentHome || defaultHome;
    // `auth.json` is optional when Codex uses the OS keyring. Like Claude,
    // validate through the CLI and retain only an opaque profile reference.
    if (!hasJsonObject(path.join(home, 'auth.json')) && !(await codexAuthReady(executable.path, home))) return [];

    const externalRef = codexProviderHomeReference(home);
    return [{
      externalRef,
      displayName: externalRef.endsWith(':default')
        ? 'ChatGPT subscription (Codex default profile)'
        : 'ChatGPT subscription (Codex isolated profile)',
      metadata: {
        credential_owner: 'codex',
        profile: externalRef.split(':').slice(1).join(':'),
        home_source: homeSource,
        ...(context.agentSlug ? { agent_slug: context.agentSlug } : {}),
      },
    }];
  }

  buildDispatchConfig(input: { model: string | null; externalRef: string; runtimeConfig: Record<string, unknown> }): RuntimeDispatchSelection {
    const model = input.model?.startsWith('openai/')
      ? input.model.slice('openai/'.length)
      : input.model?.startsWith('openai-codex/')
        ? input.model.slice('openai-codex/'.length)
        : input.model;
    return {
      provider: 'openai-codex',
      model,
      runtimeConfig: { ...input.runtimeConfig, providerConnectionExternalRef: input.externalRef },
    };
  }
}

const ADAPTERS: RuntimeProviderAdapter[] = [
  new OpenClawAnthropicSubscriptionAdapter(),
  new HermesAnthropicSubscriptionAdapter(),
  new ClaudeCodeAnthropicSubscriptionAdapter(),
  new CodexSubscriptionAdapter(),
];

export function listRuntimeProviderCapabilities(): RuntimeProviderCapability[] {
  return ADAPTERS.map(adapter => ({ ...adapter.capability, authModes: [...adapter.capability.authModes] }));
}

export function getRuntimeProviderAdapter(runtime: string, provider: string, authMode: string): RuntimeProviderAdapter | null {
  return ADAPTERS.find(adapter =>
    adapter.capability.runtime === runtime
    && adapter.capability.provider === provider
    && adapter.capability.authModes.includes(authMode)
  ) ?? null;
}

interface ProviderConnectionRow {
  id: number;
  tenant_id: number;
  provider_slug: string;
  auth_mode: string;
  runtime_type: string;
  external_ref: string;
  status: string;
  metadata: string;
}

function parseRuntimeConfig(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try { return record(JSON.parse(value)); } catch { return {}; }
  }
  return {};
}

export async function resolveRuntimeProviderDispatchSelection(input: {
  db: Db;
  tenantId: number;
  runtimeType: string;
  providerConnectionId?: number | null;
  preferredProvider?: string | null;
  model?: string | null;
  runtimeConfig?: unknown;
}): Promise<RuntimeDispatchSelection> {
  const runtimeConfig = parseRuntimeConfig(input.runtimeConfig);
  if (!input.providerConnectionId) {
    return { provider: input.preferredProvider ?? '', model: input.model ?? null, runtimeConfig };
  }
  const connection = await input.db.get(`
    SELECT id, tenant_id, provider_slug, auth_mode, runtime_type, external_ref, status, metadata
    FROM provider_connections
    WHERE id = ? AND tenant_id = ?
  `, input.providerConnectionId, input.tenantId) as ProviderConnectionRow | undefined;
  if (!connection) throw new Error(`Provider connection #${input.providerConnectionId} was not found for this tenant.`);
  if (connection.status !== 'connected') throw new Error(`Provider connection #${connection.id} is ${connection.status}.`);
  if (connection.runtime_type !== input.runtimeType) {
    throw new Error(`Provider connection #${connection.id} belongs to ${connection.runtime_type}, not ${input.runtimeType}.`);
  }
  if (input.preferredProvider && connection.provider_slug !== input.preferredProvider) {
    throw new Error(`Provider connection #${connection.id} is for ${connection.provider_slug}, not ${input.preferredProvider}.`);
  }
  const adapter = getRuntimeProviderAdapter(connection.runtime_type, connection.provider_slug, connection.auth_mode);
  if (!adapter) throw new Error(`No runtime provider adapter supports ${connection.runtime_type}/${connection.provider_slug}/${connection.auth_mode}.`);
  return adapter.buildDispatchConfig({ model: input.model ?? null, externalRef: connection.external_ref, runtimeConfig });
}
