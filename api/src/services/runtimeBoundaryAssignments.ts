import type { Db } from '../db/adapter/types';
import type {
  RuntimeBoundaryV1,
  RuntimeMcpAssignmentV1,
  RuntimeRegistryToolAssignmentV1,
  RuntimeSkillAssignmentV1,
} from '../runtimes/runtimeBoundary';
import { canonicalRuntimeJson } from '../runtimes/runtimeBoundary';
import { columnExists } from '../db/introspection';
import { fetchEffectiveAgentMcpRows, fetchEffectiveAgentToolRows, resolveEffectiveSkillNames } from '../domains/teams/effectiveCapabilities';
import {
  runtimeBoundaryDigest,
  sanitizeRuntimeConfigForRevision,
} from './runtimeBoundaryBuilder';

const TOOL_ALLOWLIST_FIELDS = [
  'allowed_tools',
  'allowedTools',
  'allowed_tool_names',
  'allowedToolNames',
  'tool_allowlist',
  'toolAllowlist',
  'mcp_tool_allowlist',
  'mcpToolAllowlist',
  'include_tools',
  'includeTools',
] as const;

interface McpAssignmentRow {
  assignment_id: number;
  server_id: number;
  slug: string;
  server_updated_at: string | null;
  overrides: string | null;
}

interface SkillRevisionRow {
  name: string;
  updated_at: string | null;
}

/** Must match the server name synthesized in runtimes/claudeCode/mcpConfig.ts. */
export const REGISTRY_TOOL_MCP_SERVER_SLUG = 'agent-hq-tools';

export interface LoadedRuntimeBoundaryAssignments {
  mcpServers: RuntimeMcpAssignmentV1[];
  skills: RuntimeSkillAssignmentV1[];
  registryTools: RuntimeRegistryToolAssignmentV1[];
}

interface RegistryToolRow {
  slug?: unknown;
  permissions?: unknown;
  implementation_type?: unknown;
  implementation_body?: unknown;
  input_schema?: unknown;
}

/**
 * Registry tools granted to the agent, reduced to auditable facts.
 *
 * The implementation body is hashed rather than stored: it is the executable
 * definition, it can carry operator secrets, and the boundary is a durable
 * record. Hashing still makes an edited tool a different boundary, which is the
 * property that lets a resume be trusted.
 */
async function loadRegistryTools(
  db: Db,
  agentId: number,
  failClosed: boolean,
): Promise<RuntimeRegistryToolAssignmentV1[]> {
  let rows: RegistryToolRow[];
  try {
    rows = (await fetchEffectiveAgentToolRows(db, agentId)) as unknown as RegistryToolRow[];
  } catch (err) {
    // A swallowed registry error must never read as "this agent has no tools" on
    // a hardened runtime — that is precisely an unrecorded-capability grant.
    if (failClosed) throw err;
    return [];
  }

  return rows
    .map((row) => ({
      slug: String(row.slug ?? '').trim(),
      permissions: String(row.permissions ?? '').trim() || 'read_only',
      definitionFingerprint: runtimeBoundaryDigest('runtime-registry-tool-v1', {
        implementationType: String(row.implementation_type ?? ''),
        implementationBody: String(row.implementation_body ?? ''),
        inputSchema: String(row.input_schema ?? ''),
      }),
    }))
    .filter((tool) => tool.slug.length > 0)
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRecord(value: unknown, failClosed = false): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed)) return parsed;
    if (failClosed) throw new Error('assignment overrides must be a JSON object');
    return {};
  } catch (error) {
    if (failClosed) {
      throw new Error(
        `Runtime boundary MCP assignment overrides are invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {};
  }
}

export function parseRuntimeBoundarySkillNames(value: unknown): string[] {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return Array.from(new Set(
    parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.trim())
      .filter(Boolean),
  )).sort((left, right) => left.localeCompare(right));
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.some(entry => typeof entry !== 'string')) return null;
  return Array.from(new Set(
    value.map(entry => String(entry).trim()).filter(Boolean),
  )).sort((left, right) => left.localeCompare(right));
}

function assignmentToolNames(overrides: Record<string, unknown>): string[] | null {
  for (const field of TOOL_ALLOWLIST_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(overrides, field)) return stringList(overrides[field]) ?? [];
  }
  const filter = isRecord(overrides.toolFilter) ? overrides.toolFilter : null;
  if (filter && Object.prototype.hasOwnProperty.call(filter, 'include')) {
    return stringList(filter.include) ?? [];
  }
  return null;
}

async function loadMcpAssignments(
  db: Db,
  tenantId: number,
  agentId: number,
  requiredLifecycleTools: string[],
  failClosed: boolean,
): Promise<RuntimeMcpAssignmentV1[]> {
  let rows: McpAssignmentRow[];
  try {
    const agentsHaveTenant = await columnExists(db, 'agents', 'tenant_id');
    const serversHaveTenant = await columnExists(db, 'mcp_servers', 'tenant_id');
    const enforceTenantScope = agentsHaveTenant && serversHaveTenant;
    if (failClosed && !enforceTenantScope) {
      throw new Error('tenant-scoped agents and MCP server columns are required');
    }
    // The EFFECTIVE set — the agent's own assignments plus every team it belongs to — because
    // materialization uses that same resolver. If the boundary counted only direct assignments,
    // assertRuntimeBoundaryAssignmentsCurrent would see a materialized team server that the
    // boundary never claimed and refuse to launch. Tenant scoping lives in the resolver's join
    // conditions, which are unconditional there.
    rows = (await fetchEffectiveAgentMcpRows(db, agentId)) as unknown as McpAssignmentRow[];
  } catch (error) {
    if (failClosed) {
      throw new Error(
        `Runtime boundary MCP assignment lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Older/minimal databases without the MCP registry are valid dispatch inputs.
    return [];
  }

  return rows.map(row => {
    const overrides = parseRecord(row.overrides, failClosed);
    const allowlist = assignmentToolNames(overrides);
    const requiredToolNames = row.slug === 'agent-hq'
      ? requiredLifecycleTools
      : allowlist ?? [];
    return {
      name: `${row.slug}__agent-${agentId}`,
      configFingerprint: runtimeBoundaryDigest('runtime-mcp-assignment-v1', {
        assignmentId: row.assignment_id,
        serverId: row.server_id,
        slug: row.slug,
        serverUpdatedAt: row.server_updated_at,
        overrides: sanitizeRuntimeConfigForRevision(overrides),
      }),
      requiredToolNames: [...requiredToolNames],
    };
  });
}

async function resolveSkillNames(
  db: Db,
  agentId: number,
  suppliedSkillNames: string[] | undefined,
  failClosed: boolean,
): Promise<string[]> {
  if (suppliedSkillNames) return parseRuntimeBoundarySkillNames(suppliedSkillNames);
  try {
    // Effective set: the agent's own skill_names plus those of every team it belongs to. The
    // boundary is what skill materialization reads back, so a team skill omitted here would
    // never reach the workspace.
    return parseRuntimeBoundarySkillNames(await resolveEffectiveSkillNames(db, agentId));
  } catch (error) {
    if (failClosed) {
      throw new Error(
        `Runtime boundary skill assignment lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return [];
  }
}

async function loadSkills(
  db: Db,
  tenantId: number,
  agentId: number,
  suppliedSkillNames?: string[],
  failClosed = false,
): Promise<RuntimeSkillAssignmentV1[]> {
  const skillNames = await resolveSkillNames(db, agentId, suppliedSkillNames, failClosed);
  if (skillNames.length === 0) return [];
  const revisions = new Map<string, string | null>();
  try {
    const rows = await db.all<SkillRevisionRow>(`
      SELECT name, updated_at
      FROM skills
      WHERE tenant_id = ?
        AND name IN (${skillNames.map(() => '?').join(', ')})
    `, tenantId, ...skillNames);
    for (const row of rows) revisions.set(row.name, row.updated_at);
    if (failClosed) {
      const missing = skillNames.filter((name) => !revisions.has(name));
      if (missing.length > 0) {
        throw new Error(`assigned skill records are missing: ${missing.join(', ')}`);
      }
    }
  } catch (error) {
    if (failClosed) {
      throw new Error(
        `Runtime boundary skill revision lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Pre-registry/system skills remain auditable by name with an unknown revision.
  }
  return skillNames.map(name => ({ name, revision: revisions.get(name) ?? null }));
}

/** Load only assignment identities/revisions and tool policy. Server commands,
 * environment values, and credential material never leave the registry query. */
export async function loadRuntimeBoundaryAssignments(params: {
  db: Db;
  tenantId: number;
  agentId: number;
  skillNames?: string[];
  requiredLifecycleTools?: string[];
  /** Hardened local runtimes must never turn a registry read failure into no tools. */
  failClosed?: boolean;
}): Promise<LoadedRuntimeBoundaryAssignments> {
  const requiredLifecycleTools = Array.from(new Set(params.requiredLifecycleTools ?? []))
    .sort((left, right) => left.localeCompare(right));
  const [mcpServers, skills, registryTools] = await Promise.all([
    loadMcpAssignments(
      params.db,
      params.tenantId,
      params.agentId,
      requiredLifecycleTools,
      params.failClosed === true,
    ),
    loadSkills(
      params.db,
      params.tenantId,
      params.agentId,
      params.skillNames,
      params.failClosed === true,
    ),
    loadRegistryTools(params.db, params.agentId, params.failClosed === true),
  ]);

  // Registry tools reach a runtime as an MCP server, so the boundary has to
  // record that server too — `registryTools` says which capabilities were
  // granted, `mcpServers` says how they are carried. Without this entry the
  // materialized server set is "extra" relative to the boundary and the
  // pre-spawn assignment check correctly refuses the launch.
  const withRegistryBridge = registryTools.length > 0
    ? [
        ...mcpServers,
        {
          name: `${REGISTRY_TOOL_MCP_SERVER_SLUG}__agent-${params.agentId}`,
          configFingerprint: runtimeBoundaryDigest('runtime-registry-tool-bridge-v1', registryTools),
          requiredToolNames: [] as string[],
        },
      ].sort((left, right) => left.name.localeCompare(right.name))
    : mcpServers;

  return { mcpServers: withRegistryBridge, skills, registryTools };
}

function sortedServerNames(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Re-read the secret-free assignment facts and compare them with the immutable
 * dispatch boundary after materialization, immediately before process launch.
 * This prevents an independent adapter query (or a swallowed registry error)
 * from silently changing the tools that the durable boundary claims were used.
 */
export async function assertRuntimeBoundaryAssignmentsCurrent(params: {
  db: Db;
  boundary: RuntimeBoundaryV1;
  materializedMcpServerNames: readonly string[];
}): Promise<void> {
  const expectedMcp = [...params.boundary.tools.mcpServers]
    .sort((left, right) => left.name.localeCompare(right.name));
  const expectedSkills = [...params.boundary.tools.skills]
    .sort((left, right) => left.name.localeCompare(right.name));
  const current = await loadRuntimeBoundaryAssignments({
    db: params.db,
    tenantId: params.boundary.identity.tenantId,
    agentId: params.boundary.identity.agentId,
    // Read the live assignment set from agents.skill_names. Supplying the
    // boundary's names here would verify only record revisions and miss a
    // concurrent add/remove after the immutable boundary was created.
    requiredLifecycleTools: params.boundary.tools.requiredLifecycleTools,
    failClosed: true,
  });
  const currentMcp = [...current.mcpServers]
    .sort((left, right) => left.name.localeCompare(right.name));
  const currentSkills = [...current.skills]
    .sort((left, right) => left.name.localeCompare(right.name));

  if (canonicalRuntimeJson(currentMcp) !== canonicalRuntimeJson(expectedMcp)) {
    throw new Error('Runtime MCP assignments changed after the dispatch boundary was created.');
  }
  if (canonicalRuntimeJson(currentSkills) !== canonicalRuntimeJson(expectedSkills)) {
    throw new Error('Runtime skill assignments changed after the dispatch boundary was created.');
  }

  const expectedNames = sortedServerNames(expectedMcp.map((assignment) => assignment.name));
  const materializedNames = sortedServerNames(params.materializedMcpServerNames);
  if (canonicalRuntimeJson(materializedNames) !== canonicalRuntimeJson(expectedNames)) {
    throw new Error(
      `Materialized MCP servers do not match the runtime boundary (expected ${expectedNames.join(', ') || 'none'}; got ${materializedNames.join(', ') || 'none'}).`,
    );
  }
}
