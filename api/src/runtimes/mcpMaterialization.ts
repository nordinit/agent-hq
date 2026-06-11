import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { ensureMaterializedMcpApiKeyForAgent } from '../lib/mcpApiAuth';
import { parseAgentSessionKey, resolveRuntimeAgentSlug } from '../lib/sessionKeys';

const MANAGED_KEYS_FIELD = 'agentHqManagedMcpServers';
const HERMES_MANAGED_KEYS_FIELD = 'agent_hq_managed_mcp_servers';
const HERMES_MCP_SERVERS_FIELD = 'mcp_servers';
const OPENCLAW_MCP_BUNDLE_ID = 'agent-hq-mcp';
const OPENCLAW_MCP_BUNDLE_DIR = path.join('.openclaw', 'extensions', OPENCLAW_MCP_BUNDLE_ID);
const OPENCLAW_MCP_BUNDLE_MANIFEST_PATH = path.join('.claude-plugin', 'plugin.json');
const OPENCLAW_AGENT_SCOPED_SERVER_SEPARATOR = '__agent-';
const AGENT_HQ_API_KEY_SERVER_SLUGS = new Set(['agent-hq', 'dev-environment-lease-manager']);

interface AgentMcpRow {
  slug: string;
  command: string | null;
  args: string | null;
  env: string | null;
  cwd: string | null;
  overrides: string | null;
}

interface AgentWorkspaceRow {
  id: number;
  name: string | null;
  role: string | null;
  session_key: string | null;
  openclaw_agent_id: string | null;
  runtime_type: string | null;
  workspace_path: string | null;
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  const tableExists = Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(table));
  if (!tableExists) return false;
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
}

export interface McpMaterializationResult {
  ok: boolean;
  count: number;
  path: string;
  bundlePath: string;
  openClawConfigPath: string;
  warnings: string[];
  error?: string;
}

export interface HermesMcpMaterializationResult {
  ok: boolean;
  count: number;
  path: string;
  serverNames: string[];
  warnings: string[];
  error?: string;
}

export interface AgentMcpSyncResult {
  agentId: number;
  runtimeType: string;
  workingDirectory: string | null;
  ok: boolean;
  count: number;
  warnings: string[];
  path?: string;
  bundlePath?: string;
  openClawConfigPath?: string;
  error?: string;
  skipped?: 'agent_not_found' | 'missing_workspace' | 'unsupported_runtime' | 'shared_workspace';
}

export interface OpenClawPluginRegistryRefreshResult {
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

type OpenClawPluginRegistryRefreshFn = (context: {
  agentId?: number;
  mcpServerId?: number;
  workingDirectory?: string | null;
  materializedCount: number;
}) => OpenClawPluginRegistryRefreshResult;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonStringArray(value: string | null | undefined): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    return parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.trim())
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

function parseJsonStringMap(value: string | null | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) return undefined;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, entry]) => typeof entry === 'string')
        .map(([key, entry]) => [key, String(entry)]),
    );
  } catch {
    return undefined;
  }
}

function extractServerMap(raw: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(raw)) return {};
  const nested = isRecord(raw.mcpServers)
    ? raw.mcpServers
    : isRecord(raw.servers)
      ? raw.servers
      : raw;
  if (!isRecord(nested)) return {};
  return Object.fromEntries(
    Object.entries(nested)
      .filter(([, value]) => isRecord(value))
      .map(([key, value]) => [key, { ...(value as Record<string, unknown>) }]),
  );
}

function resolveOpenClawConfigPath(): string {
  return process.env.OPENCLAW_CONFIG_PATH
    ?? path.join(process.env.HOME ?? os.homedir(), '.openclaw', 'openclaw.json');
}

export function refreshOpenClawPluginRegistry(context: {
  agentId?: number;
  mcpServerId?: number;
  workingDirectory?: string | null;
  materializedCount: number;
}): OpenClawPluginRegistryRefreshResult {
  const command = process.env.OPENCLAW_BIN?.trim() || 'openclaw';
  const args = ['plugins', 'registry', '--refresh'];
  if (process.env.AGENT_HQ_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH === '1') {
    return { ok: true, command, args, skipped: true };
  }

  const result = spawnSync(command, args, {
    cwd: context.workingDirectory ?? undefined,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : undefined;
  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : undefined;
  if (result.error) {
    return {
      ok: false,
      command,
      args,
      status: result.status,
      signal: result.signal,
      stdout,
      stderr,
      error: result.error.message,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      command,
      args,
      status: result.status,
      signal: result.signal,
      stdout,
      stderr,
      error: stderr || stdout || `openclaw plugins registry --refresh exited with status ${result.status}`,
    };
  }
  return {
    ok: true,
    command,
    args,
    status: result.status,
    signal: result.signal,
    stdout,
    stderr,
  };
}

function appendRegistryRefreshFailure(
  result: McpMaterializationResult | AgentMcpSyncResult,
  refreshResult: OpenClawPluginRegistryRefreshResult,
  context: string,
): void {
  const command = [refreshResult.command, ...refreshResult.args].join(' ');
  const details = [
    refreshResult.error,
    refreshResult.stderr ? `stderr: ${refreshResult.stderr}` : null,
    refreshResult.stdout ? `stdout: ${refreshResult.stdout}` : null,
    refreshResult.status !== undefined && refreshResult.status !== null ? `status: ${refreshResult.status}` : null,
    refreshResult.signal ? `signal: ${refreshResult.signal}` : null,
  ].filter(Boolean).join('; ');
  const message = `[mcp-materialization] OpenClaw plugin registry refresh failed after ${context}; command: ${command}; ${details || 'unknown error'}`;
  result.ok = false;
  result.error = message;
  result.warnings.push(message);
  console.warn(message);
}

function readJsonRecordFile(filePath: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!fs.existsSync(filePath)) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!isRecord(parsed)) return { ok: false, error: `${filePath} is not a JSON object` };
    return { ok: true, value: parsed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function extractOpenClawMcpServers(rawConfig: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const mcp = isRecord(rawConfig.mcp) ? rawConfig.mcp : {};
  const servers = isRecord(mcp.servers) ? mcp.servers : {};
  return Object.fromEntries(
    Object.entries(servers)
      .filter(([, value]) => isRecord(value))
      .map(([key, value]) => [key, { ...(value as Record<string, unknown>) }]),
  );
}

function openClawScopedMcpServerName(slug: string, agentId: number): string {
  return `${slug}${OPENCLAW_AGENT_SCOPED_SERVER_SEPARATOR}${agentId}`;
}

function openClawScopedMcpServerSlugForAgent(name: string, agentId: number): string | null {
  const suffix = `${OPENCLAW_AGENT_SCOPED_SERVER_SEPARATOR}${agentId}`;
  if (!name.endsWith(suffix)) return null;
  const slug = name.slice(0, -suffix.length).trim();
  return slug || null;
}

function isAgentHqManagedOpenClawScopedMcpServerNameForAgent(name: string, agentId: number): boolean {
  const slug = openClawScopedMcpServerSlugForAgent(name, agentId);
  return Boolean(slug && AGENT_HQ_API_KEY_SERVER_SLUGS.has(slug));
}

function extractOpenClawScopedServersForAgent(
  rawConfig: Record<string, unknown>,
  agentId: number,
): Record<string, Record<string, unknown>> {
  const servers = extractOpenClawMcpServers(rawConfig);
  const scoped: Record<string, Record<string, unknown>> = {};
  for (const [name, server] of Object.entries(servers)) {
    const slug = openClawScopedMcpServerSlugForAgent(name, agentId);
    if (slug && AGENT_HQ_API_KEY_SERVER_SLUGS.has(slug)) scoped[name] = server;
  }
  return scoped;
}

function resolveOpenClawAgentSlug(agent: AgentWorkspaceRow): string {
  return resolveRuntimeAgentSlug(agent) ?? `agent-${agent.id}`;
}

function resolveFsPathOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

const OPENCLAW_DEFAULT_AGENT_ID = 'main';

function normalizeOpenClawAgentId(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim().toLowerCase();
  if (!trimmed) return OPENCLAW_DEFAULT_AGENT_ID;
  return trimmed
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 64) || OPENCLAW_DEFAULT_AGENT_ID;
}

function expandHomePath(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

interface OpenClawConfiguredAgent {
  id: string;
  workspace: string | null;
  isDefault: boolean;
}

function listOpenClawConfiguredAgents(rawConfig: Record<string, unknown>): OpenClawConfiguredAgent[] {
  const agents: Record<string, unknown> = isRecord(rawConfig.agents) ? rawConfig.agents : {};
  const list = Array.isArray(agents.list) ? agents.list : [];
  return list
    .filter(isRecord)
    .map((entry) => ({
      id: normalizeOpenClawAgentId(typeof entry.id === 'string' ? entry.id : null),
      workspace: typeof entry.workspace === 'string' && entry.workspace.trim() ? entry.workspace.trim() : null,
      isDefault: entry.default === true,
    }));
}

export interface OpenClawWorkspaceResolution {
  /** Workspace dir OpenClaw bundle discovery scans for this agent id, or null when no config exists. */
  workspaceDir: string | null;
  /** True when the agent id has its own entry in the OpenClaw `agents.list`. */
  configured: boolean;
  /** True when the global OpenClaw config file exists and parsed. */
  configAvailable: boolean;
  /** Other OpenClaw agent ids whose resolved workspace is the same directory. */
  sharedWithAgentIds: string[];
}

/**
 * resolveOpenClawWorkspaceForAgentSlug — mirror of OpenClaw's
 * resolveAgentWorkspaceDir() so the MCP bundle is materialized into the exact
 * directory OpenClaw bundle discovery scans for the dispatched agent id:
 * the agent's configured `workspace`, else `agents.defaults.workspace/<id>`,
 * else `<state dir>/workspace-<id>`.
 */
export function resolveOpenClawWorkspaceForAgentSlug(
  agentSlug: string,
  configPath = resolveOpenClawConfigPath(),
): OpenClawWorkspaceResolution {
  const unavailable: OpenClawWorkspaceResolution = {
    workspaceDir: null,
    configured: false,
    configAvailable: false,
    sharedWithAgentIds: [],
  };
  if (!fs.existsSync(configPath)) return unavailable;
  const parsed = readJsonRecordFile(configPath);
  if (!parsed.ok) return unavailable;

  const agents = listOpenClawConfiguredAgents(parsed.value);
  const id = normalizeOpenClawAgentId(agentSlug);
  const stateDir = resolveFsPathOrNull(process.env.OPENCLAW_STATE_DIR) ?? path.dirname(path.resolve(configPath));
  const agentsRecord: Record<string, unknown> = isRecord(parsed.value.agents) ? parsed.value.agents : {};
  const defaultsRecord: Record<string, unknown> = isRecord(agentsRecord.defaults) ? agentsRecord.defaults : {};
  const defaultsWorkspace = typeof defaultsRecord.workspace === 'string' && defaultsRecord.workspace.trim()
    ? path.resolve(expandHomePath(defaultsRecord.workspace.trim()))
    : null;
  const defaultAgentId = agents.find((agent) => agent.isDefault)?.id
    ?? agents[0]?.id
    ?? OPENCLAW_DEFAULT_AGENT_ID;

  const resolveForId = (agentId: string, configuredWorkspace: string | null): string => {
    if (configuredWorkspace) return path.resolve(expandHomePath(configuredWorkspace));
    if (agentId === defaultAgentId) return defaultsWorkspace ?? path.join(stateDir, 'workspace');
    if (defaultsWorkspace) return path.join(defaultsWorkspace, agentId);
    return path.join(stateDir, `workspace-${agentId}`);
  };

  const entry = agents.find((agent) => agent.id === id);
  const workspaceDir = resolveForId(id, entry?.workspace ?? null);
  const sharedWithAgentIds = agents
    .filter((agent) => agent.id !== id)
    .filter((agent) => resolveForId(agent.id, agent.workspace) === workspaceDir)
    .map((agent) => agent.id);

  return {
    workspaceDir,
    configured: Boolean(entry),
    configAvailable: true,
    sharedWithAgentIds,
  };
}

/**
 * Candidate OpenClaw agent ids for an Agent HQ agent, most authoritative
 * first. The dispatch-time routing slug always wins because it is the id the
 * OpenClaw gateway parses out of the routed `agent:<slug>:run:*` session key.
 */
function buildOpenClawAgentSlugCandidates(
  agent: AgentWorkspaceRow,
  dispatchAgentSlug?: string | null,
): string[] {
  const parsed = parseAgentSessionKey(agent.session_key);
  const candidates = [
    dispatchAgentSlug,
    agent.openclaw_agent_id,
    parsed?.agentNameSlug,
    parsed?.runtimeSlug,
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/**
 * ensureOpenClawMcpWorkspaceBundleEnabled — one-time trust grant for the
 * Agent HQ workspace bundle plugin (`agent-hq-mcp`).
 *
 * OpenClaw disables workspace-origin plugins by default because bundles can
 * spawn MCP server subprocesses, so the bundle Agent HQ materializes into
 * each agent workspace is only discovered once the plugin id is enabled in
 * the global OpenClaw config (`plugins.entries['agent-hq-mcp'].enabled`).
 *
 * Enabling the plugin rewrites the shared OpenClaw config and triggers a
 * plugin-registry refresh, so this must only run at provisioning/boot time —
 * never on the per-dispatch hot path. Idempotent: a no-op once enabled.
 */
export function ensureOpenClawMcpWorkspaceBundleEnabled(configPath = resolveOpenClawConfigPath()): {
  ok: boolean;
  changed: boolean;
  path: string;
  error?: string;
} {
  if (!fs.existsSync(configPath)) {
    // OpenClaw is not provisioned on this host. Never create a global config
    // just to register the workspace bundle plugin.
    return { ok: true, changed: false, path: configPath };
  }

  let rawConfig: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!isRecord(parsed)) {
      return { ok: false, changed: false, path: configPath, error: 'OpenClaw config is not a JSON object' };
    }
    rawConfig = parsed;
  } catch (err) {
    return {
      ok: false,
      changed: false,
      path: configPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const plugins = isRecord(rawConfig.plugins) ? { ...rawConfig.plugins } : {};
  const entries = isRecord(plugins.entries) ? { ...plugins.entries } : {};
  const existingEntry = isRecord(entries[OPENCLAW_MCP_BUNDLE_ID])
    ? entries[OPENCLAW_MCP_BUNDLE_ID] as Record<string, unknown>
    : {};

  if (existingEntry.enabled === true) {
    return { ok: true, changed: false, path: configPath };
  }

  entries[OPENCLAW_MCP_BUNDLE_ID] = { ...existingEntry, enabled: true };
  plugins.entries = entries;
  rawConfig.plugins = plugins;

  try {
    fs.writeFileSync(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`, 'utf8');
    return { ok: true, changed: true, path: configPath };
  } catch (err) {
    return {
      ok: false,
      changed: false,
      path: configPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function readStringEnvValue(env: unknown, key: string): string | null {
  if (!isRecord(env)) return null;
  const value = env[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function buildDesiredServerConfig(
  row: AgentMcpRow,
  params: {
    db: Database.Database;
    agentId: number;
    existingServer?: Record<string, unknown>;
    resolveAgentApiKey?: (existingApiKey: string | null, name: string) => string;
  },
): Record<string, unknown> | null {
  if (!row.command || !row.command.trim()) return null;

  const baseConfig: Record<string, unknown> = {
    command: row.command.trim(),
  };

  const args = parseJsonStringArray(row.args);
  if (args && args.length > 0) baseConfig.args = args;

  const env = parseJsonStringMap(row.env);
  if (env && Object.keys(env).length > 0) baseConfig.env = env;

  if (row.cwd && row.cwd.trim()) baseConfig.cwd = row.cwd.trim();

  const overrides = parseJsonRecord(row.overrides);
  const merged = { ...baseConfig, ...overrides };

  const baseEnv = isRecord(baseConfig.env) ? baseConfig.env as Record<string, string> : {};
  const overrideEnv = isRecord(overrides.env) ? overrides.env as Record<string, unknown> : {};
  if (Object.keys(baseEnv).length > 0 || Object.keys(overrideEnv).length > 0) {
    merged.env = Object.fromEntries(
      [...Object.entries(baseEnv), ...Object.entries(overrideEnv)]
        .filter(([, value]) => typeof value === 'string')
        .map(([key, value]) => [key, String(value)]),
    );
  }

  if (AGENT_HQ_API_KEY_SERVER_SLUGS.has(row.slug)) {
    const existingEnv = isRecord(params.existingServer?.env) ? params.existingServer?.env : {};
    const existingApiKey = readStringEnvValue(existingEnv, 'AGENT_HQ_MCP_API_KEY');
    const apiKey = params.resolveAgentApiKey
      ? params.resolveAgentApiKey(existingApiKey, 'Agent HQ MCP materialized key')
      : ensureMaterializedMcpApiKeyForAgent({
          db: params.db,
          agentId: params.agentId,
          existingApiKey,
          name: 'Agent HQ MCP materialized key',
        }).apiKey;
    const env = isRecord(merged.env) ? { ...(merged.env as Record<string, unknown>) } : {};
    env.AGENT_HQ_MCP_API_KEY = apiKey;
    merged.env = Object.fromEntries(
      Object.entries(env)
        .filter(([, value]) => typeof value === 'string')
        .map(([envKey, value]) => [envKey, String(value)]),
    );
  }

  return merged;
}

export function fetchAssignedMcpServers(
  db: Database.Database,
  agentId: number,
  existingServers: Record<string, Record<string, unknown>> = {},
): Record<string, Record<string, unknown>> {
  const enforceTenantScope = tableHasColumn(db, 'agents', 'tenant_id') && tableHasColumn(db, 'mcp_servers', 'tenant_id');
  const rows = db.prepare(`
    SELECT s.slug, s.command, s.args, s.env, s.cwd, ama.overrides
    FROM agent_mcp_assignments ama
    JOIN mcp_servers s ON s.id = ama.mcp_server_id
    ${enforceTenantScope ? 'JOIN agents a ON a.id = ama.agent_id AND a.tenant_id = s.tenant_id' : ''}
    WHERE ama.agent_id = ?
      AND ama.enabled = 1
      AND s.enabled = 1
    ORDER BY s.slug ASC
  `).all(agentId) as AgentMcpRow[];

  let sharedAgentApiKey: string | null = null;
  const resolveAgentApiKey = (existingApiKey: string | null, name: string): string => {
    if (existingApiKey) {
      const key = ensureMaterializedMcpApiKeyForAgent({ db, agentId, existingApiKey, name });
      sharedAgentApiKey = key.apiKey;
      return key.apiKey;
    }
    if (sharedAgentApiKey) {
      const key = ensureMaterializedMcpApiKeyForAgent({ db, agentId, existingApiKey: sharedAgentApiKey, name });
      sharedAgentApiKey = key.apiKey;
      return key.apiKey;
    }
    const key = ensureMaterializedMcpApiKeyForAgent({ db, agentId, name });
    sharedAgentApiKey = key.apiKey;
    return key.apiKey;
  };

  return Object.fromEntries(
    rows
      .map((row) => {
        const scopedName = openClawScopedMcpServerName(row.slug, agentId);
        return [scopedName, buildDesiredServerConfig(row, {
          db,
          agentId,
          existingServer: existingServers[scopedName] ?? existingServers[row.slug],
          resolveAgentApiKey,
        })] as const;
      })
      .filter((entry): entry is [string, Record<string, unknown>] => entry[1] !== null),
  );
}

function scopeOpenClawMcpServerToCodexAgent(
  server: Record<string, unknown>,
  agentSlug: string,
): Record<string, unknown> {
  const codex = isRecord(server.codex) ? { ...server.codex } : {};
  codex.agents = [agentSlug];
  return {
    ...server,
    codex,
  };
}

export function materializeOpenClawGlobalMcpConfig(params: {
  agentId: number;
  agentSlug: string;
  desiredServers: Record<string, Record<string, unknown>>;
  configPath?: string;
}): {
  ok: boolean;
  changed: boolean;
  count: number;
  path: string;
  error?: string;
} {
  const configPath = params.configPath ?? resolveOpenClawConfigPath();
  const existing = readJsonRecordFile(configPath);
  if (!existing.ok) {
    return {
      ok: false,
      changed: false,
      count: 0,
      path: configPath,
      error: `could not parse OpenClaw config ${configPath}: ${existing.error}`,
    };
  }

  const rawConfig = existing.value;
  const before = JSON.stringify(rawConfig);
  const mcp = isRecord(rawConfig.mcp) ? { ...rawConfig.mcp } : {};
  const servers = extractOpenClawMcpServers(rawConfig);

  for (const name of Object.keys(servers)) {
    if (
      isAgentHqManagedOpenClawScopedMcpServerNameForAgent(name, params.agentId)
      || AGENT_HQ_API_KEY_SERVER_SLUGS.has(name)
    ) {
      delete servers[name];
    }
  }

  for (const [name, server] of Object.entries(params.desiredServers)) {
    servers[name] = scopeOpenClawMcpServerToCodexAgent(server, params.agentSlug);
  }

  if (Object.keys(servers).length > 0) {
    mcp.servers = servers;
    rawConfig.mcp = mcp;
  } else {
    delete mcp.servers;
    if (Object.keys(mcp).length > 0) rawConfig.mcp = mcp;
    else delete rawConfig.mcp;
  }

  if (JSON.stringify(rawConfig) === before) {
    return {
      ok: true,
      changed: false,
      count: Object.keys(params.desiredServers).length,
      path: configPath,
    };
  }

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`, 'utf8');
    return {
      ok: true,
      changed: true,
      count: Object.keys(params.desiredServers).length,
      path: configPath,
    };
  } catch (err) {
    return {
      ok: false,
      changed: false,
      count: 0,
      path: configPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      if (trimmed.startsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
    }
  }
  return trimmed.replace(/\s+#.*$/, '').trim();
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function yamlKey(value: string): string {
  return yamlQuote(value);
}

function isYamlScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function orderedYamlEntries(value: Record<string, unknown>): Array<[string, unknown]> {
  const preferred = [
    'command',
    'args',
    'env',
    'cwd',
    'url',
    'headers',
    'transport',
    'timeout',
    'connect_timeout',
    'enabled',
  ];
  const seen = new Set(preferred);
  const entries: Array<[string, unknown]> = [];
  for (const key of preferred) {
    if (Object.prototype.hasOwnProperty.call(value, key)) entries.push([key, value[key]]);
  }
  for (const key of Object.keys(value).sort()) {
    if (!seen.has(key)) entries.push([key, value[key]]);
  }
  return entries;
}

function appendYamlValue(lines: string[], key: string, value: unknown, indent: number): void {
  const prefix = ' '.repeat(indent);
  if (isYamlScalar(value)) {
    lines.push(`${prefix}${yamlKey(key)}: ${typeof value === 'string' ? yamlQuote(value) : JSON.stringify(value)}`);
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${prefix}${yamlKey(key)}: []`);
      return;
    }
    lines.push(`${prefix}${yamlKey(key)}:`);
    for (const item of value) {
      if (isYamlScalar(item)) {
        lines.push(`${prefix}  - ${typeof item === 'string' ? yamlQuote(item) : JSON.stringify(item)}`);
      } else if (isRecord(item)) {
        lines.push(`${prefix}  -`);
        for (const [childKey, childValue] of orderedYamlEntries(item)) {
          appendYamlValue(lines, childKey, childValue, indent + 4);
        }
      }
    }
    return;
  }

  if (isRecord(value)) {
    if (Object.keys(value).length === 0) {
      lines.push(`${prefix}${yamlKey(key)}: {}`);
      return;
    }
    lines.push(`${prefix}${yamlKey(key)}:`);
    for (const [childKey, childValue] of orderedYamlEntries(value)) {
      appendYamlValue(lines, childKey, childValue, indent + 2);
    }
  }
}

function buildHermesMcpServersYamlBlock(servers: Record<string, Record<string, unknown>>): string[] {
  const lines = [`${HERMES_MCP_SERVERS_FIELD}:`];
  for (const [name, config] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${yamlKey(name)}:`);
    for (const [key, value] of orderedYamlEntries(config)) {
      appendYamlValue(lines, key, value, 4);
    }
  }
  return lines;
}

function buildHermesManagedKeysYamlBlock(serverNames: string[]): string[] {
  const lines = [`${HERMES_MANAGED_KEYS_FIELD}:`];
  for (const name of serverNames) lines.push(`  - ${yamlQuote(name)}`);
  return lines;
}

function findTopLevelYamlBlock(lines: string[], key: string): { start: number; end: number } | null {
  const keyPattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  for (let index = 0; index < lines.length; index += 1) {
    if (!keyPattern.test(lines[index])) continue;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (/^[A-Za-z0-9_-]+\s*:/.test(line)) {
        end = cursor;
        break;
      }
    }
    return { start: index, end };
  }
  return null;
}

function parseHermesManagedServerNames(rawConfig: string): string[] {
  const lines = rawConfig.split(/\r?\n/);
  const block = findTopLevelYamlBlock(lines, HERMES_MANAGED_KEYS_FIELD);
  if (!block) return [];
  return lines
    .slice(block.start + 1, block.end)
    .map(line => line.match(/^\s*-\s*(.+?)\s*$/)?.[1] ?? '')
    .map(parseYamlScalar)
    .filter(Boolean);
}

function parseYamlMappingChildName(line: string): string | null {
  if (!line.startsWith("  ") || line.startsWith("    ")) return null;
  const match = line.match(/^  (?:"((?:\\.|[^"\\])*)"|'((?:''|[^'])*)'|([^:#]+))\s*:/);
  if (!match) return null;
  if (match[1] != null) {
    try {
      return JSON.parse(`"${match[1]}"`);
    } catch {
      return match[1];
    }
  }
  if (match[2] != null) return match[2].replace(/''/g, "'");
  return match[3]?.trim() || null;
}

function filterHermesMcpServerBlock(
  blockLines: string[],
  shouldRemoveServer: (name: string) => boolean,
): string[] | null {
  if (blockLines.length === 0) return null;
  const firstLine = blockLines[0].trim();
  if (firstLine !== `${HERMES_MCP_SERVERS_FIELD}:`) return null;

  const kept: string[] = [];
  let index = 1;
  while (index < blockLines.length) {
    const childName = parseYamlMappingChildName(blockLines[index]);
    if (!childName) {
      kept.push(blockLines[index]);
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < blockLines.length && parseYamlMappingChildName(blockLines[end]) === null) {
      end += 1;
    }

    if (!shouldRemoveServer(childName)) {
      kept.push(...blockLines.slice(index, end));
    }
    index = end;
  }

  return kept;
}

function removeTopLevelYamlBlock(lines: string[], key: string): string[] {
  const block = findTopLevelYamlBlock(lines, key);
  if (!block) return lines;
  const next = [...lines.slice(0, block.start), ...lines.slice(block.end)];
  while (next.length > 0 && next[next.length - 1] === '') next.pop();
  return next;
}

function readExistingMcpJsonServers(directory: string): Record<string, Record<string, unknown>> {
  const filePath = path.join(directory, '.mcp.json');
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return extractServerMap(parsed);
  } catch {
    return {};
  }
}

// Hermes spawns each MCP server by exec'ing `command` literally — it does NOT chdir
// into the server's `cwd` before resolving relative paths, so a relative command like
// `.venv/bin/dev-env-lease-mcp` fails with ENOENT, and a relative arg like
// `config/environments.json` is resolved from Hermes' own cwd instead of the server cwd.
// Resolve relative path-style entries against their `cwd` to absolute paths. Bare
// executable/argument names (no path separator, e.g. `node` or `stdio`) are left as-is.
function isRelativePathStyleValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || path.isAbsolute(trimmed)) return false;
  return trimmed.includes('/') || trimmed.includes('\\');
}

function resolveHermesServerCommand(
  server: Record<string, unknown>,
): Record<string, unknown> {
  const command = server.command;
  if (typeof command !== 'string') return server;
  const trimmed = command.trim();
  if (!isRelativePathStyleValue(trimmed)) return server;
  const cwd = getHermesServerCwd(server);
  if (!cwd) return server;
  return { ...server, command: path.resolve(cwd, trimmed) };
}

function getHermesServerCwd(server: Record<string, unknown>): string | null {
  return typeof server.cwd === 'string' && server.cwd.trim() ? server.cwd.trim() : null;
}

function resolveHermesServerArgs(
  server: Record<string, unknown>,
): Record<string, unknown> {
  const args = Array.isArray(server.args) ? server.args : null;
  if (!args) return server;
  const cwd = getHermesServerCwd(server);
  if (!cwd) return server;

  let changed = false;
  const nextArgs = args.map(arg => {
    if (typeof arg !== 'string') return arg;
    const trimmed = arg.trim();
    if (!isRelativePathStyleValue(trimmed)) return arg;
    changed = true;
    return path.resolve(cwd, trimmed);
  });

  return changed ? { ...server, args: nextArgs } : server;
}

function resolveHermesServerPaths(
  servers: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      const resolvedCommand = resolveHermesServerCommand(server);
      return [name, resolveHermesServerArgs(resolvedCommand)];
    }),
  );
}

function isNodeBinary(command: string): boolean {
  const base = path.basename(command);
  return base === 'node' || base === 'node.exe';
}

function isMcpServerEntryArg(arg: string): boolean {
  return /(^|[\\/])mcp[\\/]server\.js$/.test(arg);
}

// The Agent HQ MCP server is seeded into the DB with this host's absolute node binary,
// server.js path, and api cwd — none of which are portable to another machine/checkout.
// When we recognize that node + dist/mcp/server.js shape, rewrite those paths to the
// currently-running process (process.execPath) and this build's own dist location, so the
// materialized config always points at a valid local node + entrypoint regardless of host.
function resolveAgentHqServerRuntimePaths(
  server: Record<string, unknown>,
): Record<string, unknown> {
  const command = server.command;
  const args = Array.isArray(server.args) ? server.args : null;
  if (typeof command !== 'string' || !path.isAbsolute(command) || !isNodeBinary(command)) return server;
  if (!args || !args.some(arg => typeof arg === 'string' && isMcpServerEntryArg(arg))) return server;

  const distDir = path.join(__dirname, '..'); // <api>/dist (this file lives in <api>/dist/runtimes)
  const apiDir = path.join(distDir, '..'); // <api>
  const serverEntry = path.join(distDir, 'mcp', 'server.js');

  const next: Record<string, unknown> = {
    ...server,
    command: process.execPath,
    args: args.map(arg => (typeof arg === 'string' && isMcpServerEntryArg(arg) ? serverEntry : arg)),
  };
  if (typeof server.cwd === 'string' && server.cwd.trim()) next.cwd = apiDir;
  return next;
}

function resolveHermesAgentHqServerPaths(
  servers: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [name, resolveAgentHqServerRuntimePaths(server)]),
  );
}

export function materializeHermesMcpConfig(params: {
  db: Database.Database;
  agentId: number;
  hermesHome: string;
}): HermesMcpMaterializationResult {
  const configPath = path.join(params.hermesHome, 'config.yaml');
  const result: HermesMcpMaterializationResult = {
    ok: true,
    count: 0,
    path: configPath,
    serverNames: [],
    warnings: [],
  };

  let rawConfig = '';
  if (fs.existsSync(configPath)) {
    try {
      rawConfig = fs.readFileSync(configPath, 'utf8');
    } catch (err) {
      return {
        ...result,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const existingServers = readExistingMcpJsonServers(params.hermesHome);
  const desiredServers = resolveHermesServerPaths(
    resolveHermesAgentHqServerPaths(
      fetchAssignedMcpServers(params.db, params.agentId, existingServers),
    ),
  );
  const desiredKeys = Object.keys(desiredServers).sort();
  result.count = desiredKeys.length;
  result.serverNames = desiredKeys;

  const previousManagedKeys = new Set(parseHermesManagedServerNames(rawConfig));
  const desiredKeySet = new Set(desiredKeys);
  const lines = rawConfig.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const mcpBlock = findTopLevelYamlBlock(lines, HERMES_MCP_SERVERS_FIELD);
  let nextLines = [...lines];
  let preservedMcpChildren: string[] = [];
  if (mcpBlock) {
    const filtered = filterHermesMcpServerBlock(
      lines.slice(mcpBlock.start, mcpBlock.end),
      name => (
        previousManagedKeys.has(name)
        || desiredKeySet.has(name)
        || isAgentHqManagedOpenClawScopedMcpServerNameForAgent(name, params.agentId)
      ),
    );
    if (filtered === null) {
      result.warnings.push(
        `[mcp-materialization] could not parse existing Hermes ${HERMES_MCP_SERVERS_FIELD} block in ${configPath}; replacing it with Agent HQ-managed MCP servers`,
      );
    } else {
      preservedMcpChildren = filtered.filter(line => line.trim().length > 0);
    }
    nextLines = [...lines.slice(0, mcpBlock.start), ...lines.slice(mcpBlock.end)];
  }

  nextLines = removeTopLevelYamlBlock(nextLines, HERMES_MANAGED_KEYS_FIELD);
  while (nextLines.length > 0 && nextLines[nextLines.length - 1] === '') nextLines.pop();

  const mergedMcpServersBlock = buildHermesMcpServersYamlBlock(desiredServers);
  const hasPreservedMcpChildren = preservedMcpChildren.length > 0;
  if (desiredKeys.length > 0 || hasPreservedMcpChildren) {
    if (nextLines.length > 0) nextLines.push('');
    nextLines.push(`${HERMES_MCP_SERVERS_FIELD}:`);
    if (hasPreservedMcpChildren) nextLines.push(...preservedMcpChildren);
    if (desiredKeys.length > 0) nextLines.push(...mergedMcpServersBlock.slice(1));
  }
  if (desiredKeys.length > 0) {
    nextLines.push('');
    nextLines.push(...buildHermesManagedKeysYamlBlock(desiredKeys));
  }

  const nextConfig = nextLines.length > 0 ? `${nextLines.join('\n')}\n` : '';
  try {
    fs.mkdirSync(params.hermesHome, { recursive: true });
    if (nextConfig) {
      fs.writeFileSync(configPath, nextConfig, 'utf8');
    } else if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
  } catch (err) {
    return {
      ...result,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return result;
}


function writeOpenClawWorkspaceBundleManifest(bundleDirectory: string): void {
  const manifestPath = path.join(bundleDirectory, OPENCLAW_MCP_BUNDLE_MANIFEST_PATH);
  const manifest = {
    name: OPENCLAW_MCP_BUNDLE_ID,
    description: 'Agent HQ workspace-local MCP server bundle. Generated by Agent HQ; do not edit manually.',
    version: '1.0.0',
    mcpServers: ['.mcp.json'],
  };
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export function materializeAgentMcpConfig(params: {
  db: Database.Database;
  agentId: number;
  workingDirectory: string;
  // Shared OpenClaw config writes can interrupt active sessions; dispatch uses workspace-only sync.
  materializeOpenClawGlobalConfig?: boolean;
}): McpMaterializationResult {
  const result: McpMaterializationResult = {
    ok: true,
    count: 0,
    path: path.join(params.workingDirectory, '.mcp.json'),
    bundlePath: path.join(params.workingDirectory, OPENCLAW_MCP_BUNDLE_DIR, '.mcp.json'),
    openClawConfigPath: resolveOpenClawConfigPath(),
    warnings: [],
  };

  const agent = params.db.prepare(`
    SELECT id, name, role, session_key, openclaw_agent_id, runtime_type, workspace_path
    FROM agents
    WHERE id = ?
  `).get(params.agentId) as AgentWorkspaceRow | undefined;
  if (!agent) {
    return {
      ...result,
      ok: false,
      error: `Agent #${params.agentId} not found`,
    };
  }
  const agentSlug = resolveOpenClawAgentSlug(agent);
  const runtimeType = (agent.runtime_type ?? 'openclaw').trim() || 'openclaw';
  const isOpenClawRuntime = runtimeType === 'openclaw';
  const shouldMaterializeOpenClawGlobalConfig = isOpenClawRuntime
    && params.materializeOpenClawGlobalConfig === true;

  let existingRaw: unknown = {};
  if (fs.existsSync(result.path)) {
    try {
      existingRaw = JSON.parse(fs.readFileSync(result.path, 'utf8'));
    } catch (err) {
      result.warnings.push(
        `[mcp-materialization] could not parse existing ${result.path}; replacing it with Agent HQ-managed config (${err instanceof Error ? err.message : String(err)})`,
      );
      existingRaw = {};
    }
  }

  const existingRecord = isRecord(existingRaw) ? existingRaw : {};
  const existingServers = extractServerMap(existingRaw);
  if (isOpenClawRuntime) {
    const existingOpenClaw = readJsonRecordFile(result.openClawConfigPath);
    if (existingOpenClaw.ok) {
      Object.assign(
        existingServers,
        extractOpenClawScopedServersForAgent(existingOpenClaw.value, params.agentId),
      );
    } else {
      result.warnings.push(
        `[mcp-materialization] could not parse existing OpenClaw MCP config ${result.openClawConfigPath}; materialized keys may be rotated (${existingOpenClaw.error})`,
      );
    }
  }
  const desiredServers = fetchAssignedMcpServers(params.db, params.agentId, existingServers);
  const desiredKeys = Object.keys(desiredServers);
  const preservedTopLevel: Record<string, unknown> = {};
  if (isRecord(existingRecord.mcpServers) || isRecord(existingRecord.servers)) {
    for (const [key, value] of Object.entries(existingRecord)) {
      if (key === 'mcpServers' || key === 'servers' || key === MANAGED_KEYS_FIELD) continue;
      preservedTopLevel[key] = value;
    }
  }

  const previouslyManagedKeys = Array.isArray(existingRecord[MANAGED_KEYS_FIELD])
    ? (existingRecord[MANAGED_KEYS_FIELD] as unknown[])
        .filter((entry): entry is string => typeof entry === 'string')
    : [];

  for (const key of previouslyManagedKeys) {
    delete existingServers[key];
  }

  const mergedServers = {
    ...existingServers,
    ...desiredServers,
  };

  try {
    fs.mkdirSync(params.workingDirectory, { recursive: true });

    if (shouldMaterializeOpenClawGlobalConfig) {
      const globalConfig = materializeOpenClawGlobalMcpConfig({
        agentId: params.agentId,
        agentSlug,
        desiredServers,
        configPath: result.openClawConfigPath,
      });
      if (!globalConfig.ok) {
        result.ok = false;
        result.error = globalConfig.error ?? 'OpenClaw MCP config materialization failed';
        return result;
      }
    }

    if (Object.keys(mergedServers).length === 0 && Object.keys(preservedTopLevel).length === 0) {
      if (fs.existsSync(result.path)) fs.unlinkSync(result.path);
      if (fs.existsSync(result.bundlePath)) fs.unlinkSync(result.bundlePath);
      const bundleManifestPath = path.join(path.dirname(result.bundlePath), OPENCLAW_MCP_BUNDLE_MANIFEST_PATH);
      if (fs.existsSync(bundleManifestPath)) fs.unlinkSync(bundleManifestPath);
      return result;
    }

    const nextConfig: Record<string, unknown> = {
      ...preservedTopLevel,
      mcpServers: mergedServers,
    };
    if (desiredKeys.length > 0) nextConfig[MANAGED_KEYS_FIELD] = desiredKeys;

    fs.writeFileSync(result.path, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
    const bundleDirectory = path.dirname(result.bundlePath);
    fs.mkdirSync(bundleDirectory, { recursive: true });
    fs.writeFileSync(result.bundlePath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
    writeOpenClawWorkspaceBundleManifest(bundleDirectory);
    result.count = desiredKeys.length;
    return result;
  } catch (err) {
    result.ok = false;
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }
}

export function syncAssignedMcpForAgent(params: {
  db: Database.Database;
  agentId: number;
  workingDirectory?: string | null;
  /**
   * Routing slug the dispatcher is about to send as `agent:<slug>:run:*`.
   * When provided it is the authoritative OpenClaw agent id for resolving the
   * workspace dir the bundle must land in (OpenClaw bundle discovery scans
   * the workspace of the agent id parsed from the routed session key).
   */
  dispatchAgentSlug?: string | null;
  // Shared OpenClaw config writes can interrupt active sessions; dispatch uses workspace-only sync.
  materializeOpenClawGlobalConfig?: boolean;
  refreshPluginRegistry?: boolean;
  refreshOpenClawPluginRegistry?: OpenClawPluginRegistryRefreshFn;
}): AgentMcpSyncResult {
  const agent = params.db.prepare(`
    SELECT id, name, role, session_key, openclaw_agent_id, runtime_type, workspace_path
    FROM agents
    WHERE id = ?
  `).get(params.agentId) as AgentWorkspaceRow | undefined;

  if (!agent) {
    return {
      agentId: params.agentId,
      runtimeType: 'unknown',
      workingDirectory: params.workingDirectory ?? null,
      ok: false,
      count: 0,
      warnings: [],
      skipped: 'agent_not_found',
      error: `Agent #${params.agentId} not found`,
    };
  }

  const runtimeType = (agent.runtime_type ?? 'openclaw').trim() || 'openclaw';
  const requestedWorkingDirectory = resolveFsPathOrNull(params.workingDirectory);
  const agentWorkspaceDirectory = resolveFsPathOrNull(agent.workspace_path);
  const syncWarnings: string[] = [];

  // OpenClaw discovers the bundle in the workspace dir of the agent id parsed
  // from the routed session key, so that dir (resolved from the live OpenClaw
  // config) outranks the locally stored workspace_path when they disagree.
  let openClawWorkspaceDirectory: string | null = null;
  if (runtimeType === 'openclaw') {
    const slugCandidates = buildOpenClawAgentSlugCandidates(agent, params.dispatchAgentSlug);
    for (const slug of slugCandidates) {
      const resolution = resolveOpenClawWorkspaceForAgentSlug(slug);
      if (!resolution.configAvailable) break;
      if (!resolution.configured) continue;
      openClawWorkspaceDirectory = resolution.workspaceDir;
      if (agentWorkspaceDirectory && resolution.workspaceDir !== agentWorkspaceDirectory) {
        syncWarnings.push(
          `[mcp-materialization] agent #${agent.id} workspace_path (${agentWorkspaceDirectory}) differs from the OpenClaw workspace for agent "${slug}" (${resolution.workspaceDir}); materializing into the OpenClaw workspace so the bundle is discoverable`,
        );
      }
      if (resolution.sharedWithAgentIds.length > 0) {
        syncWarnings.push(
          `[mcp-materialization] OpenClaw config maps additional agent id(s) ${resolution.sharedWithAgentIds.join(', ')} to the same workspace as "${slug}"; sessions for those ids will see agent #${agent.id}'s MCP servers and API key`,
        );
      }
      break;
    }
  }

  const workingDirectory = runtimeType === 'openclaw'
    ? openClawWorkspaceDirectory ?? agentWorkspaceDirectory ?? requestedWorkingDirectory
    : requestedWorkingDirectory ?? agentWorkspaceDirectory;
  const supportsRuntimeMcp = runtimeType === 'openclaw' || runtimeType === 'hermes';

  if (!supportsRuntimeMcp) {
    return {
      agentId: agent.id,
      runtimeType,
      workingDirectory,
      ok: true,
      count: 0,
      warnings: [],
      skipped: 'unsupported_runtime',
    };
  }

  if (!workingDirectory) {
    return {
      agentId: agent.id,
      runtimeType,
      workingDirectory: null,
      ok: false,
      count: 0,
      warnings: [],
      skipped: 'missing_workspace',
      error: `Agent #${agent.id} has no workspace_path`,
    };
  }

  // The bundle channel has no per-agent filter: every server (and its API
  // key) in the workspace bundle is exposed to any session running in that
  // workspace. Fail closed instead of leaking one agent's servers into
  // another agent's sessions.
  if (runtimeType === 'openclaw') {
    const hasEnabledColumn = tableHasColumn(params.db, 'agents', 'enabled');
    const otherAgents = params.db.prepare(`
      SELECT id, name, workspace_path
      FROM agents
      WHERE id != ?
        AND (runtime_type IS NULL OR runtime_type = '' OR runtime_type = 'openclaw')
        ${hasEnabledColumn ? 'AND enabled = 1' : ''}
        AND workspace_path IS NOT NULL
    `).all(agent.id) as Array<{ id: number; name: string | null; workspace_path: string }>;
    const conflicting = otherAgents.filter(
      (other) => resolveFsPathOrNull(other.workspace_path) === workingDirectory,
    );
    if (conflicting.length > 0) {
      const conflictLabel = conflicting
        .map((other) => `#${other.id}${other.name ? ` (${other.name})` : ''}`)
        .join(', ');
      const message = `[mcp-materialization] refusing to materialize MCP bundle for agent #${agent.id}: workspace ${workingDirectory} is shared with agent(s) ${conflictLabel}; a shared workspace would leak this agent's MCP servers and API key into their sessions. Give each agent a unique workspace_path/OpenClaw workspace.`;
      console.warn(message);
      return {
        agentId: agent.id,
        runtimeType,
        workingDirectory,
        ok: false,
        count: 0,
        warnings: [...syncWarnings, message],
        skipped: 'shared_workspace',
        error: message,
      };
    }
  }

  const result = materializeAgentMcpConfig({
    db: params.db,
    agentId: agent.id,
    workingDirectory,
    materializeOpenClawGlobalConfig: params.materializeOpenClawGlobalConfig,
  });

  const shouldRefreshRegistry = runtimeType === 'openclaw'
    && params.materializeOpenClawGlobalConfig === true
    && result.ok
    && result.count > 0
    && params.refreshPluginRegistry !== false;
  if (runtimeType === 'openclaw' && params.materializeOpenClawGlobalConfig === true && result.ok) {
    const configResult = ensureOpenClawMcpWorkspaceBundleEnabled();
    if (!configResult.ok) {
      const message = `[mcp-materialization] could not reconcile OpenClaw global MCP config in ${configResult.path}: ${configResult.error ?? 'unknown error'}`;
      result.ok = false;
      result.error = message;
      result.warnings.push(message);
      console.warn(message);
    }
  }

  if (shouldRefreshRegistry && result.ok) {
    const refresh = params.refreshOpenClawPluginRegistry ?? refreshOpenClawPluginRegistry;
    const refreshResult = refresh({
      agentId: agent.id,
      workingDirectory,
      materializedCount: result.count,
    });
    if (!refreshResult.ok) {
      appendRegistryRefreshFailure(
        result,
        refreshResult,
        `MCP sync for agent #${agent.id} in ${workingDirectory}`,
      );
    }
  }

  return {
    agentId: agent.id,
    runtimeType,
    workingDirectory,
    ok: result.ok,
    count: result.count,
    warnings: [...syncWarnings, ...result.warnings],
    path: result.path,
    bundlePath: result.bundlePath,
    openClawConfigPath: result.openClawConfigPath,
    ...(result.error ? { error: result.error } : {}),
  };
}

export function syncAssignedMcpForServer(params: {
  db: Database.Database;
  mcpServerId: number;
  materializeOpenClawGlobalConfig?: boolean;
  refreshOpenClawPluginRegistry?: OpenClawPluginRegistryRefreshFn;
}): AgentMcpSyncResult[] {
  const agentIds = params.db.prepare(`
    SELECT DISTINCT agent_id
    FROM agent_mcp_assignments
    WHERE mcp_server_id = ?
    ORDER BY agent_id ASC
  `).all(params.mcpServerId) as Array<{ agent_id: number }>;

  const results = agentIds.map(({ agent_id }) => syncAssignedMcpForAgent({
    db: params.db,
    agentId: agent_id,
    refreshPluginRegistry: false,
    materializeOpenClawGlobalConfig: params.materializeOpenClawGlobalConfig,
  }));
  const successfulOpenClawMaterializations = results.filter(result => (
    result.runtimeType === 'openclaw'
    && params.materializeOpenClawGlobalConfig === true
    && result.ok
    && result.count > 0
    && !result.skipped
  ));

  if (successfulOpenClawMaterializations.length > 0) {
    const refresh = params.refreshOpenClawPluginRegistry ?? refreshOpenClawPluginRegistry;
    const refreshResult = refresh({
      mcpServerId: params.mcpServerId,
      materializedCount: successfulOpenClawMaterializations.reduce((sum, result) => sum + result.count, 0),
    });
    if (!refreshResult.ok) {
      for (const result of successfulOpenClawMaterializations) {
        appendRegistryRefreshFailure(
          result,
          refreshResult,
          `MCP sync batch for server #${params.mcpServerId}`,
        );
      }
    }
  }

  return results;
}
