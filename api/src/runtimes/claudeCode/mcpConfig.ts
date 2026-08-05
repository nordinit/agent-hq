/**
 * runtimes/claudeCode/mcpConfig.ts — materialize Agent HQ's assigned MCP servers
 * into a run-scoped config file for `claude --mcp-config <file> --strict-mcp-config`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE THING THIS MODULE EXISTS FOR: toolFilter IS FAIL-OPEN ON THIS CLI
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Agent HQ's shared materializer writes a fail-CLOSED allowlist hint into every
 * non-`agent-hq` server entry:
 *
 *     "toolFilter": { "include": ["issue_create", "issue_update"] }
 *
 * and, when an assignment grants nothing, the sentinel
 * `['__agent_hq_no_allowed_mcp_tools__']` meaning "expose no tools at all"
 * (mcpMaterialization.ts, applyAssignmentToolAllowlist).
 *
 * **The Claude Code CLI IGNORES `toolFilter` entirely — verified against 2.1.220.**
 * It is an unknown key inside a server object, and the CLI tolerates unknown keys
 * silently. So a config written with that key and nothing else gives the agent
 * EVERY tool the server exposes: Agent HQ's fail-closed policy becomes fail-OPEN,
 * with no error, no warning, and no observable difference in the transcript.
 *
 * The translation below is the only thing standing between the two. Each
 * `toolFilter.include` entry becomes an explicit `mcp__<server>__<tool>` name in
 * `allowedToolNames`, which the argv builder passes to `--allowedTools`. Delete
 * the translation and the policy silently inverts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECOND HAZARD: API-KEY CARRY-FORWARD
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `fetchAssignedMcpServers` is NOT side-effect-free. For servers whose slug needs
 * Agent HQ API access it calls `ensureMaterializedMcpApiKeyForAgent`, which REUSES
 * the key found in the previous config's `env.AGENT_HQ_MCP_API_KEY` and otherwise
 * INSERTs a fresh `mcp_api_keys` row — without revoking the one it replaces. Call
 * it with an empty `existingServers` on every dispatch and each agent accumulates
 * one live, never-expiring credential per run. Always feed it the previous run's
 * server map (see `readPreviousRunServers`).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { type Db } from '../../db/adapter/types';
import { fetchAssignedMcpServers, resolveMcpServerRuntimePaths } from '../mcpMaterialization';
import { mcpToolName } from './streamJson';
import {
  AGENT_HQ_MCP_SLUG,
  AGENT_TOOLS_MCP_SLUG,
  NO_ALLOWED_MCP_TOOLS_SENTINEL,
  type ClaudeMcpMaterialization,
} from './types';

/** Filename written inside the run state dir and handed to `--mcp-config`. */
export const CLAUDE_CODE_MCP_CONFIG_FILENAME = 'mcp-config.json';

/**
 * Key listing the servers Agent HQ owns in this file. Same field name the OpenClaw
 * and Hermes materializers use, so an operator reading any materialized config sees
 * one convention. The CLI tolerates unknown TOP-LEVEL keys (verified).
 */
const MANAGED_SERVERS_FIELD = 'agentHqManagedMcpServers';

/**
 * Agent HQ bookkeeping the shared materializer stamps onto each server entry.
 * Stripped before writing: `toolFilter` is dead weight here (translated above into
 * --allowedTools), and `agentHqAssignment` carries internal assignment ids into a
 * file the agent process can read.
 */
const AGENT_HQ_ONLY_SERVER_KEYS = ['toolFilter', 'agentHqAssignment'] as const;

/** The `__agent-<id>` suffix `openClawScopedMcpServerName()` appends to every slug. */
const AGENT_SCOPED_SERVER_SUFFIX = /__agent-\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Run state lives under the OS temp dir because it is disposable by definition:
 * a 0600 config that embeds a live API key. A reboot-cleared location is the right
 * default for a secret with no reason to outlive the process that reads it.
 *
 * `AGENT_HQ_RUN_STATE_DIR` overrides the parent for the hosts where that is wrong —
 * a `noexec`/tiny tmpfs, or an operator who wants run state on a durable volume for
 * post-mortems. The `claude-code/agent-<id>` tail is kept either way so runtimes
 * cannot collide inside a shared override.
 *
 * The directory is scoped to the AGENT, not the job instance, and that is
 * deliberate. The materialized config is a pure function of the agent (its
 * assigned servers and its one API key), so per-instance directories would buy no
 * isolation — while guaranteeing that every dispatch starts with an empty
 * `previousServers` and therefore mints a fresh, never-revoked `mcp_api_keys` row.
 * Per-agent scoping is what actually makes the key carry-forward work.
 */
export function resolveClaudeCodeAgentStateDir(agentId: number): string {
  const override = process.env.AGENT_HQ_RUN_STATE_DIR?.trim();
  const root = override ? override : path.join(os.tmpdir(), 'agent-hq');
  return path.join(root, 'claude-code', `agent-${agentId}`);
}

/**
 * Read the server map out of a config this module previously wrote.
 *
 * Never throws: a missing, truncated, or hand-edited file simply means "no previous
 * key", which costs one extra `mcp_api_keys` row rather than a failed dispatch.
 */
export function readPreviousRunServers(configPath: string): Record<string, Record<string, unknown>> {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!isRecord(parsed)) return {};
  const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed;
  return Object.fromEntries(
    Object.entries(servers)
      .filter(([, value]) => isRecord(value))
      .map(([name, value]) => [name, { ...(value as Record<string, unknown>) }]),
  );
}

/** Slug the server was materialized from, e.g. `agent-hq__agent-42` -> `agent-hq`. */
function mcpServerSlug(serverName: string): string {
  return serverName.replace(AGENT_SCOPED_SERVER_SUFFIX, '');
}

interface ToolFilterInclude {
  /** True when the entry carries a `toolFilter.include` at all. */
  configured: boolean;
  include: string[];
}

/**
 * A `toolFilter` whose `include` is present but not an array counts as CONFIGURED
 * with zero tools, not as absent. Treating malformed input as "unrestricted" would
 * turn a typo in an assignment override into a silent grant of every tool.
 */
function readToolFilterInclude(server: Record<string, unknown>): ToolFilterInclude {
  const filter = server.toolFilter;
  if (!isRecord(filter) || !Object.prototype.hasOwnProperty.call(filter, 'include')) {
    return { configured: false, include: [] };
  }
  const include = Array.isArray(filter.include) ? filter.include : [];
  return {
    configured: true,
    include: include.filter((entry): entry is string => typeof entry === 'string'),
  };
}

function translateToolFilters(servers: Record<string, Record<string, unknown>>): {
  allowedToolNames: string[];
  warnings: string[];
} {
  const allowedToolNames: string[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];

  for (const [serverName, server] of Object.entries(servers)) {
    const { configured, include } = readToolFilterInclude(server);

    if (!configured) {
      // Recorded rather than silent: the caller needs to know which servers are
      // reachable in full. Expected for the `agent-hq` lifecycle server, which must
      // expose its whole tool surface; anything else here is an unallowlisted grant.
      warnings.push(
        `MCP server "${serverName}" has no toolFilter.include and is unrestricted: every tool it exposes can be called.`,
      );
      continue;
    }

    const tools = include.filter((tool) => tool !== NO_ALLOWED_MCP_TOOLS_SENTINEL);
    if (tools.length === 0) {
      warnings.push(
        `MCP server "${serverName}" grants no MCP tools; it will be started but none of its tools are allowlisted.`,
      );
      continue;
    }

    for (const tool of tools) {
      const qualified = mcpToolName(serverName, tool);
      if (seen.has(qualified)) continue;
      seen.add(qualified);
      allowedToolNames.push(qualified);
    }
  }

  return { allowedToolNames, warnings };
}

function stripAgentHqBookkeeping(server: Record<string, unknown>): Record<string, unknown> {
  const next = { ...server };
  for (const key of AGENT_HQ_ONLY_SERVER_KEYS) delete next[key];
  return next;
}

/** Server name for the registry-tool shim, matching the `<slug>__agent-<id>` convention. */
export function agentToolServerName(agentId: number): string {
  return `${AGENT_TOOLS_MCP_SLUG}__agent-${agentId}`;
}

/**
 * Absolute path to the compiled registry-tool MCP shim, or null when it is not
 * on disk.
 *
 * Resolved from `__dirname`, which is `<api>/dist/runtimes/claudeCode` in a built
 * install. Running from source under tsx/jest resolves to a `.js` that was never
 * emitted, so the existsSync guard degrades to "no registry tools" rather than
 * materializing a server whose command cannot start. That mirrors how
 * `resolveAgentHqServerRuntimePaths` already behaves for the lifecycle server.
 */
function resolveAgentToolShimPath(): string | null {
  const candidate = path.join(__dirname, '..', '..', 'bin', 'agent-tool-mcp.js');
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Does this agent have any enabled registry tools?
 *
 * Mirrors the join in toolInjection.fetchAgentTools (including the tenant-scoping
 * condition) so the shim is only materialized when it would actually serve
 * something. Returns false on any error: a missing table in a minimal test
 * database must not fail a dispatch.
 */
async function agentHasRegistryTools(db: Db, agentId: number): Promise<boolean> {
  try {
    const row = (await db.get(
      `SELECT COUNT(*) AS count
       FROM agent_tool_assignments ata
       JOIN agents a ON a.id = ata.agent_id
       JOIN tools t ON t.id = ata.tool_id AND t.tenant_id = a.tenant_id
       WHERE ata.agent_id = ?
         AND ata.enabled = 1
         AND t.enabled = 1`,
      agentId,
    )) as { count?: number } | undefined;
    return Number(row?.count ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Registry tools (Agent HQ's `tools` table) used to reach a claude-code run
 * through the Agent SDK's in-process `createSdkMcpServer`. The CLI runtime has no
 * in-process hook, so they are served by a stdio shim instead — which also runs
 * them in the run's own cwd rather than inside the API process.
 *
 * The shim is deliberately materialized WITHOUT a `toolFilter`: it only ever
 * serves the tools already assigned to this agent, so the assignment table is the
 * allowlist and a second one at the MCP layer would be redundant.
 */
async function buildAgentToolShimServer(
  db: Db,
  agentId: number,
): Promise<Record<string, unknown> | null> {
  const shimPath = resolveAgentToolShimPath();
  if (!shimPath) return null;
  if (!(await agentHasRegistryTools(db, agentId))) return null;

  const env: Record<string, string> = { AGENT_HQ_TOOL_AGENT_ID: String(agentId) };
  // The shim opens its own pool, so pass the exact PostgreSQL URL selected by
  // the API. Normalize the namespaced alias to the canonical child variable.
  const databaseUrl = (process.env.AGENT_HQ_DATABASE_URL ?? process.env.DATABASE_URL)?.trim();
  if (databaseUrl) env.DATABASE_URL = databaseUrl;

  return { command: process.execPath, args: [shimPath], env };
}

export async function materializeClaudeCodeMcpConfig(params: {
  db: Db;
  agentId: number;
  instanceId: number;
  /** Run-scoped directory; created here. See resolveClaudeCodeAgentStateDir. */
  stateDir: string;
  /** Previous run's server map, so an existing API key is reused rather than reminted. */
  previousServers?: Record<string, Record<string, unknown>>;
}): Promise<ClaudeMcpMaterialization> {
  const configPath = path.join(params.stateDir, CLAUDE_CODE_MCP_CONFIG_FILENAME);
  const previousServers = params.previousServers ?? readPreviousRunServers(configPath);

  const servers = resolveMcpServerRuntimePaths(
    await fetchAssignedMcpServers(params.db, params.agentId, previousServers),
  );

  // Registry tools are not part of the MCP-server registry, so they are appended
  // rather than fetched. Without this the CLI migration would silently drop the
  // agent-tool capability the SDK runtime used to provide in-process.
  const toolShim = await buildAgentToolShimServer(params.db, params.agentId);
  if (toolShim) servers[agentToolServerName(params.agentId)] = toolShim;

  const serverNames = Object.keys(servers);
  if (serverNames.length === 0) {
    // No file at all rather than an empty one: `--mcp-config` is only passed when
    // configPath is non-null, and an empty config would still cost a CLI parse and
    // an extra `system/init` round trip.
    return {
      configPath: null,
      serverNames: [],
      requiredServerNames: [],
      allowedToolNames: [],
      warnings: [],
    };
  }

  const { allowedToolNames, warnings } = translateToolFilters(servers);

  const payload = {
    mcpServers: Object.fromEntries(
      Object.entries(servers).map(([name, server]) => [name, stripAgentHqBookkeeping(server)]),
    ),
    [MANAGED_SERVERS_FIELD]: serverNames,
  };

  try {
    fs.mkdirSync(params.stateDir, { recursive: true, mode: 0o700 });

    // Written via temp + rename because the state dir is per-AGENT: two concurrent
    // dispatches of the same agent write here at the same time, and a reader
    // (readPreviousRunServers on a third dispatch) must never observe a half-written
    // file. rename(2) is atomic within a directory, so a reader sees either the old
    // config or the new one. The temp name carries the instance id so the two
    // writers cannot collide on the temp file either.
    const tmpPath = `${configPath}.${params.instanceId}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    // writeFileSync honours `mode` only when it CREATES the file. The temp name is
    // fresh each time so that holds here, but chmod is kept as a belt-and-braces
    // guarantee for a file that embeds AGENT_HQ_MCP_API_KEY.
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    throw new Error(
      `claude-code instance ${params.instanceId}: failed to write MCP config at ${configPath}: `
        + `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    configPath,
    serverNames,
    requiredServerNames: serverNames.filter((name) => mcpServerSlug(name) === AGENT_HQ_MCP_SLUG),
    allowedToolNames,
    warnings,
  };
}
