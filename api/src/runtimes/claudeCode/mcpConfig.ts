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
 * a supplied `env.AGENT_HQ_MCP_API_KEY` and otherwise inserts a fresh key row.
 * Reusing an entire prior config would also retain third-party credentials, so this
 * module persists a separate tenant/agent-scoped snapshot containing only that one
 * Agent HQ key and reconstructs the minimal `existingServers` input from it.
 */

import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { type Db } from '../../db/adapter/types';
import { fetchAssignedMcpServers, resolveMcpServerRuntimePaths } from '../mcpMaterialization';
import { fetchEffectiveAgentToolRows } from '../../domains/teams/effectiveCapabilities';
import { mcpToolName } from './streamJson';
import {
  AGENT_HQ_MCP_SLUG,
  NO_ALLOWED_MCP_TOOLS_SENTINEL,
  type ClaudeMcpMaterialization,
} from './types';

/** Prefix for an immutable, per-dispatch file handed to `--mcp-config`. */
export const CLAUDE_CODE_MCP_RUN_CONFIG_PREFIX = 'mcp-config-instance-';

/** The only reusable secret persisted between Claude runs. */
export const CLAUDE_CODE_MCP_CREDENTIAL_SNAPSHOT_FILENAME = 'mcp-api-key-snapshot.json';

/** Short crash-race grace; durable active instance ids provide long-run protection. */
export const DEFAULT_CLAUDE_CODE_MCP_STALE_CONFIG_TTL_MS = 15 * 60 * 1_000;

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
const RUN_CONFIG_FILENAME_PATTERN = /^mcp-config-instance-(\d+)-([a-f0-9]{24})\.json$/;
const CREDENTIAL_SERVER_SLUGS = ['agent-hq', 'dev-environment-lease-manager'] as const;
const activeRunConfigPaths = new Set<string>();
const stateLocks = new Map<string, Promise<void>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Run state lives under the OS temp dir because per-run configs are disposable.
 * The tenant/agent-scoped snapshot is deliberately minimal and contains only the
 * Agent HQ MCP API key needed to avoid minting an unbounded key per dispatch.
 *
 * `AGENT_HQ_RUN_STATE_DIR` overrides the parent for the hosts where that is wrong —
 * a `noexec`/tiny tmpfs, or an operator who wants run state on a durable volume for
 * post-mortems. The `claude-code/tenant-<id>/agent-<id>` tail is kept either way
 * so runtimes cannot collide inside a shared override.
 *
 * Immutable numeric tenant and agent ids are storage authority. Slugs and names
 * can change and must never merge credentials between tenants.
 */
export function resolveClaudeCodeAgentStateDir(tenantId: number, agentId: number): string {
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) {
    throw new Error('Claude MCP state requires a trusted positive tenant id.');
  }
  if (!Number.isSafeInteger(agentId) || agentId <= 0) {
    throw new Error('Claude MCP state requires a trusted positive agent id.');
  }
  const override = process.env.AGENT_HQ_RUN_STATE_DIR?.trim();
  const root = override ? override : path.join(os.tmpdir(), 'agent-hq');
  return path.join(root, 'claude-code', `tenant-${tenantId}`, `agent-${agentId}`);
}

export function resolveClaudeCodeMcpCredentialSnapshotPath(stateDir: string): string {
  return path.join(stateDir, CLAUDE_CODE_MCP_CREDENTIAL_SNAPSHOT_FILENAME);
}

export function resolveClaudeCodeMcpRunConfigPath(params: {
  stateDir: string;
  instanceId: number;
  runKey: string;
}): string {
  if (!Number.isSafeInteger(params.instanceId) || params.instanceId <= 0) {
    throw new Error('Claude MCP run config requires a positive instance id.');
  }
  const runKey = params.runKey.trim();
  if (!runKey) throw new Error('Claude MCP run config requires a non-empty run key.');
  const digest = createHash('sha256').update(runKey).digest('hex').slice(0, 24);
  return path.join(
    params.stateDir,
    `${CLAUDE_CODE_MCP_RUN_CONFIG_PREFIX}${params.instanceId}-${digest}.json`,
  );
}

interface ClaudeMcpCredentialSnapshotV1 {
  version: 1;
  tenantId: number;
  agentId: number;
  AGENT_HQ_MCP_API_KEY: string;
}

function readCredentialSnapshot(params: {
  snapshotPath: string;
  tenantId: number;
  agentId: number;
}): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(params.snapshotPath, 'utf8')) as unknown;
    if (!isRecord(parsed)) return null;
    if (parsed.version !== 1 || parsed.tenantId !== params.tenantId || parsed.agentId !== params.agentId) {
      return null;
    }
    return typeof parsed.AGENT_HQ_MCP_API_KEY === 'string' && parsed.AGENT_HQ_MCP_API_KEY.trim()
      ? parsed.AGENT_HQ_MCP_API_KEY.trim()
      : null;
  } catch {
    return null;
  }
}

function writeCredentialSnapshot(
  snapshotPath: string,
  snapshot: ClaudeMcpCredentialSnapshotV1,
): void {
  const tmpPath = `${snapshotPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, snapshotPath);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function existingServersFromCredentialSnapshot(agentId: number, apiKey: string | null): Record<string, Record<string, unknown>> {
  if (!apiKey) return {};
  return Object.fromEntries(CREDENTIAL_SERVER_SLUGS.map((slug) => [
    `${slug}__agent-${agentId}`,
    { env: { AGENT_HQ_MCP_API_KEY: apiKey } },
  ]));
}

function reusableApiKeyFromServers(servers: Record<string, Record<string, unknown>>): string | null {
  const keys = new Set<string>();
  for (const [serverName, server] of Object.entries(servers)) {
    if (!CREDENTIAL_SERVER_SLUGS.includes(mcpServerSlug(serverName) as typeof CREDENTIAL_SERVER_SLUGS[number])) {
      continue;
    }
    const env = isRecord(server.env) ? server.env : {};
    const apiKey = typeof env.AGENT_HQ_MCP_API_KEY === 'string'
      ? env.AGENT_HQ_MCP_API_KEY.trim()
      : '';
    if (apiKey) keys.add(apiKey);
  }
  if (keys.size > 1) throw new Error('Claude MCP servers resolved inconsistent Agent HQ API keys.');
  return [...keys][0] ?? null;
}

async function withStateLock<T>(stateDir: string, operation: () => Promise<T>): Promise<T> {
  const predecessor = stateLocks.get(stateDir) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = predecessor.then(() => gate);
  stateLocks.set(stateDir, queued);
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
    if (stateLocks.get(stateDir) === queued) stateLocks.delete(stateDir);
  }
}

/**
 * Read the server map out of one immutable run config this module wrote.
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

/** Remove exactly one adapter-owned run config after its complete process tree is gone. */
export function cleanupClaudeCodeMcpRunConfig(configPath: string | null): void {
  if (!configPath) return;
  const resolved = path.resolve(configPath);
  if (!RUN_CONFIG_FILENAME_PATTERN.test(path.basename(resolved))) {
    throw new Error(`Refusing to remove non-Claude-run MCP config path ${resolved}.`);
  }
  try {
    fs.unlinkSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    activeRunConfigPaths.delete(resolved);
  }
}

export interface ClaudeMcpStaleConfigCleanupResult {
  removed: string[];
  failures: Array<{ path: string; error: string }>;
}

/**
 * Conservatively remove crash-left run configs. In-process active profiles are
 * always protected, even when a run exceeds the age threshold.
 */
export function scavengeStaleClaudeCodeMcpRunConfigs(
  stateDir: string,
  options: {
    protectedInstanceIds: ReadonlySet<number>;
    now?: number;
    ttlMs?: number;
  },
): ClaudeMcpStaleConfigCleanupResult {
  const result: ClaudeMcpStaleConfigCleanupResult = { removed: [], failures: [] };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(stateDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    return {
      removed: [],
      failures: [{ path: stateDir, error: error instanceof Error ? error.message : String(error) }],
    };
  }
  const now = options.now ?? Date.now();
  const ttlMs = Math.max(60_000, options.ttlMs ?? DEFAULT_CLAUDE_CODE_MCP_STALE_CONFIG_TTL_MS);
  for (const entry of entries) {
    const match = entry.isFile() ? entry.name.match(RUN_CONFIG_FILENAME_PATTERN) : null;
    if (!match) continue;
    const instanceId = Number(match[1]);
    if (options.protectedInstanceIds.has(instanceId)) continue;
    const candidate = path.resolve(stateDir, entry.name);
    if (activeRunConfigPaths.has(candidate)) continue;
    try {
      const stat = fs.statSync(candidate);
      if (now - stat.mtimeMs < ttlMs) continue;
      fs.unlinkSync(candidate);
      result.removed.push(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      result.failures.push({
        path: candidate,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
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
      // Claude ignores toolFilter itself. Its documented MCP wildcard is the
      // explicit argv representation of an assignment that intentionally did
      // not narrow the server's tool surface.
      const wildcard = mcpToolName(serverName, '*');
      if (!seen.has(wildcard)) {
        seen.add(wildcard);
        allowedToolNames.push(wildcard);
      }
      warnings.push(
        `MCP server "${serverName}" has no toolFilter.include; its assigned tool surface is granted with ${wildcard}.`,
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

/**
 * Does this agent have any enabled registry tools?
 *
 * Counts the EFFECTIVE set — the agent's own assignments plus those of every team it belongs
 * to — because a team-granted tool is just as much an assigned registry capability as a direct
 * one. Asking only about direct assignments would let a team-only grant slip past the boundary
 * check below and launch unrecorded, which is exactly the fail-open this module exists to stop.
 *
 * Database inspection errors are fatal: silently returning false would make an assigned
 * capability disappear from the launched runtime.
 */
async function agentHasRegistryTools(db: Db, agentId: number): Promise<boolean> {
  return (await fetchEffectiveAgentToolRows(db, agentId)).length > 0;
}

async function assertNoUnboundedRegistryTools(db: Db, agentId: number): Promise<void> {
  if (!(await agentHasRegistryTools(db, agentId))) return;
  throw new Error(
    'Claude Code has assigned registry tools that are absent from RuntimeBoundaryV1; refusing to launch an unrecorded MCP capability.',
  );
}

export async function materializeClaudeCodeMcpConfig(params: {
  db: Db;
  tenantId: number;
  agentId: number;
  instanceId: number;
  /** Unique dispatch/session identity; hashed into the per-run filename. */
  runKey: string;
  /** Null means durable state could not be inspected, so stale cleanup is skipped. */
  protectedInstanceIds: ReadonlySet<number> | null;
}): Promise<ClaudeMcpMaterialization> {
  const stateDir = resolveClaudeCodeAgentStateDir(params.tenantId, params.agentId);
  const configPath = resolveClaudeCodeMcpRunConfigPath({
    stateDir,
    instanceId: params.instanceId,
    runKey: params.runKey,
  });
  const snapshotPath = resolveClaudeCodeMcpCredentialSnapshotPath(stateDir);

  return withStateLock(stateDir, async () => {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateDir, 0o700);

    if (params.protectedInstanceIds) {
      const stale = scavengeStaleClaudeCodeMcpRunConfigs(stateDir, {
        protectedInstanceIds: params.protectedInstanceIds,
      });
      if (stale.failures.length > 0) {
        throw new Error(
          `Claude MCP stale run-config cleanup failed: ${stale.failures.map((failure) => path.basename(failure.path)).join(', ')}`,
        );
      }
    }

    // Check the separate registry assignment system before fetching MCP servers,
    // which may mint a reusable API key as a side effect.
    await assertNoUnboundedRegistryTools(params.db, params.agentId);

    const apiKey = readCredentialSnapshot({
      snapshotPath,
      tenantId: params.tenantId,
      agentId: params.agentId,
    });
    const previousServers = existingServersFromCredentialSnapshot(params.agentId, apiKey);
    const servers = resolveMcpServerRuntimePaths(
      await fetchAssignedMcpServers(params.db, params.agentId, previousServers),
    );

    const reusableApiKey = reusableApiKeyFromServers(servers);
    if (reusableApiKey) {
      writeCredentialSnapshot(snapshotPath, {
        version: 1,
        tenantId: params.tenantId,
        agentId: params.agentId,
        AGENT_HQ_MCP_API_KEY: reusableApiKey,
      });
    }

    const serverNames = Object.keys(servers);
    if (serverNames.length === 0) {
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
    const tmpPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.chmodSync(tmpPath, 0o600);
      fs.renameSync(tmpPath, configPath);
      activeRunConfigPaths.add(path.resolve(configPath));
    } catch (err) {
      try { fs.unlinkSync(configPath); } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError;
      }
      throw new Error(
        `claude-code instance ${params.instanceId}: failed to write MCP config at ${configPath}: `
          + `${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    return {
      configPath,
      serverNames,
      requiredServerNames: serverNames.filter((name) => mcpServerSlug(name) === AGENT_HQ_MCP_SLUG),
      allowedToolNames,
      warnings,
    };
  });
}
