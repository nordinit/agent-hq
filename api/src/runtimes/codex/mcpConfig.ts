import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Db } from '../../db/adapter/types';
import { fetchAssignedMcpServers, resolveMcpServerRuntimePaths } from '../mcpMaterialization';
import {
  AGENT_HQ_MCP_SLUG,
  NO_ALLOWED_MCP_TOOLS_SENTINEL,
  type CodexMcpMaterialization,
} from './types';

export const CODEX_CONFIG_FILENAME = 'config.toml';
export const CODEX_MCP_SNAPSHOT_FILENAME = 'agent-hq-mcp-servers.json';
const MANAGED_BLOCK_BEGIN = '# BEGIN AGENT HQ MANAGED MCP';
const MANAGED_BLOCK_END = '# END AGENT HQ MANAGED MCP';
const AGENT_SUFFIX = /__agent-\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serverSlug(name: string): string {
  return name.replace(AGENT_SUFFIX, '');
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function renderServer(name: string, server: Record<string, unknown>): string {
  const command = String(server.command);
  const lines = [`[mcp_servers.${tomlString(name)}]`, `command = ${tomlString(command)}`];
  const args = readStringArray(server.args);
  if (args) lines.push(`args = ${tomlStringArray(args)}`);
  if (typeof server.cwd === 'string' && server.cwd.trim()) {
    lines.push(`cwd = ${tomlString(server.cwd)}`);
  }
  if (isRecord(server.env)) {
    const values = Object.entries(server.env)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`);
    if (values.length > 0) lines.push(`env = { ${values.join(', ')} }`);
  }

  const filter = isRecord(server.toolFilter) ? server.toolFilter : null;
  if (filter && Object.prototype.hasOwnProperty.call(filter, 'include')) {
    const include = (readStringArray(filter.include) ?? []).filter(
      (tool) => tool !== NO_ALLOWED_MCP_TOOLS_SENTINEL,
    );
    // Codex applies enabled_tools inside the named MCP server, so tool names are
    // intentionally unqualified here.
    lines.push(`enabled_tools = ${tomlStringArray(include)}`);
  }

  for (const field of ['startup_timeout_sec', 'tool_timeout_sec'] as const) {
    const value = server[field];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      lines.push(`${field} = ${value}`);
    }
  }
  return lines.join('\n');
}

function writeAtomic(filePath: string, content: string, instanceId: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  const tempPath = `${filePath}.${instanceId}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tempPath, 0o600);
  fs.renameSync(tempPath, filePath);
}

function managedConfigContent(
  configPath: string,
  renderedServers: string,
  preserveExistingConfig: boolean,
): string {
  const managedBlock = `${MANAGED_BLOCK_BEGIN}\n${renderedServers.trim()}\n${MANAGED_BLOCK_END}`;
  if (!preserveExistingConfig) {
    return `# Managed by Agent HQ. Manual edits are replaced on the next dispatch.\n\n${managedBlock}\n`;
  }

  let existing = '';
  try {
    existing = fs.readFileSync(configPath, 'utf8');
  } catch {
    // A CLI-owned profile may legitimately have auth/keyring state but no config.
  }
  const start = existing.indexOf(MANAGED_BLOCK_BEGIN);
  const end = existing.indexOf(MANAGED_BLOCK_END);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) {
    throw new Error(`Codex config ${configPath} has a malformed Agent HQ managed MCP block`);
  }
  const unmanaged = start >= 0
    ? `${existing.slice(0, start)}${existing.slice(end + MANAGED_BLOCK_END.length)}`
    : existing;
  if (/^\s*\[mcp_servers(?:\.|\])/m.test(unmanaged)) {
    throw new Error(
      `Codex config ${configPath} contains unmanaged MCP servers; use a dedicated provider profile before assigning it to Agent HQ`,
    );
  }
  return `${unmanaged.trimEnd()}${unmanaged.trim() ? '\n\n' : ''}${managedBlock}\n`;
}

/** Create a strict, empty managed config when dispatch has no database context. */
export function materializeEmptyCodexConfig(
  codexHome: string,
  instanceId = 0,
  preserveExistingConfig = false,
  explicitConfigPath?: string,
): string {
  const configPath = explicitConfigPath ?? path.join(codexHome, CODEX_CONFIG_FILENAME);
  writeAtomic(
    configPath,
    managedConfigContent(configPath, '# No MCP servers were available for this dispatch.', preserveExistingConfig),
    instanceId,
  );
  return configPath;
}

export function readCodexMcpSnapshot(
  snapshotPath: string,
): Record<string, Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    if (!isRecord(parsed)) return {};
    const servers = isRecord(parsed.servers) ? parsed.servers : parsed;
    return Object.fromEntries(
      Object.entries(servers)
        .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
        .map(([name, server]) => [name, { ...server }]),
    );
  } catch {
    return {};
  }
}

/**
 * The shared materializer only reads AGENT_HQ_MCP_API_KEY from previous server
 * state in order to reuse a still-valid per-agent key. Persisting the complete
 * server map here duplicated every third-party token from config.toml for no
 * functional benefit. Keep only the minimum plaintext needed by that legacy
 * reuse contract until credential issuance can move to opaque, leased refs.
 */
function reusableCredentialSnapshot(
  servers: Record<string, Record<string, unknown>>,
): Record<string, { env: { AGENT_HQ_MCP_API_KEY: string } }> {
  const snapshot: Record<string, { env: { AGENT_HQ_MCP_API_KEY: string } }> = {};
  for (const [name, server] of Object.entries(servers)) {
    const env = isRecord(server.env) ? server.env : null;
    const apiKey = env?.AGENT_HQ_MCP_API_KEY;
    if (typeof apiKey !== 'string' || !apiKey.trim()) continue;
    snapshot[name] = { env: { AGENT_HQ_MCP_API_KEY: apiKey } };
  }
  return snapshot;
}

export async function materializeCodexMcpConfig(params: {
  db: Db;
  agentId: number;
  instanceId: number;
  codexHome: string;
  /** Explicit run-profile path; defaults to the legacy home config. */
  configPath?: string;
  /** Agent-scoped reusable credential state outside a provider home. */
  snapshotPath?: string;
  previousServers?: Record<string, Record<string, unknown>>;
  /** Preserve non-MCP settings in a CLI-owned provider profile. */
  preserveExistingConfig?: boolean;
}): Promise<CodexMcpMaterialization> {
  const configPath = params.configPath ?? path.join(params.codexHome, CODEX_CONFIG_FILENAME);
  const snapshotPath = params.snapshotPath ?? path.join(params.codexHome, CODEX_MCP_SNAPSHOT_FILENAME);
  const previousServers = params.previousServers ?? readCodexMcpSnapshot(snapshotPath);
  const assigned = resolveMcpServerRuntimePaths(
    await fetchAssignedMcpServers(params.db, params.agentId, previousServers),
  );
  const warnings: string[] = [];
  const servers: Record<string, Record<string, unknown>> = {};

  for (const [name, server] of Object.entries(assigned)) {
    if (typeof server.command !== 'string' || !server.command.trim()) {
      warnings.push(`MCP server "${name}" is not stdio-backed and was not materialized for Codex.`);
      continue;
    }
    if (server.args != null && !Array.isArray(server.args)) {
      warnings.push(`MCP server "${name}" has malformed args and was not materialized for Codex.`);
      continue;
    }
    servers[name] = server;
  }

  const missingRequired = Object.keys(assigned).filter(
    (name) => serverSlug(name) === AGENT_HQ_MCP_SLUG && !servers[name],
  );
  if (missingRequired.length > 0) {
    throw new Error(
      `Required Agent HQ MCP server is not a valid stdio server: ${missingRequired.join(', ')}`,
    );
  }

  const serverNames = Object.keys(servers).sort();
  const rendered = serverNames.map((name) => renderServer(name, servers[name])).join('\n\n');

  try {
    writeAtomic(
      configPath,
      managedConfigContent(
        configPath,
        rendered || '# No assigned MCP servers.',
        params.preserveExistingConfig === true,
      ),
      params.instanceId,
    );
    writeAtomic(
      snapshotPath,
      `${JSON.stringify({ servers: reusableCredentialSnapshot(servers) }, null, 2)}\n`,
      params.instanceId,
    );
  } catch (error) {
    throw new Error(
      `codex instance ${params.instanceId}: failed to materialize CODEX_HOME at ${params.codexHome}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return {
    codexHome: params.codexHome,
    configPath,
    snapshotPath,
    serverNames,
    requiredServerNames: serverNames.filter((name) => serverSlug(name) === AGENT_HQ_MCP_SLUG),
    servers,
    warnings,
  };
}
