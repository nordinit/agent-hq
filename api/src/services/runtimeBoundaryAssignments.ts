import type { Db } from '../db/adapter/types';
import type {
  RuntimeBoundaryV1,
  RuntimeMcpAssignmentV1,
  RuntimeSkillAssignmentV1,
} from '../runtimes/runtimeBoundary';
import { canonicalRuntimeJson } from '../runtimes/runtimeBoundary';
import { columnExists } from '../db/introspection';
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

export interface LoadedRuntimeBoundaryAssignments {
  mcpServers: RuntimeMcpAssignmentV1[];
  skills: RuntimeSkillAssignmentV1[];
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
    rows = await db.all<McpAssignmentRow>(`
      SELECT ama.id AS assignment_id,
             s.id AS server_id,
             s.slug,
             s.updated_at AS server_updated_at,
             ama.overrides
      FROM agent_mcp_assignments ama
      JOIN mcp_servers s ON s.id = ama.mcp_server_id
      ${enforceTenantScope ? 'JOIN agents a ON a.id = ama.agent_id AND a.tenant_id = s.tenant_id' : ''}
      WHERE ama.agent_id = ?
        ${enforceTenantScope ? 'AND a.tenant_id = ?' : ''}
        AND ama.enabled = 1
        AND s.enabled = 1
      ORDER BY s.slug ASC
    `, agentId, ...(enforceTenantScope ? [tenantId] : []));
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
    const row = await db.get<{ skill_names?: unknown }>(
      'SELECT skill_names FROM agents WHERE id = ?',
      agentId,
    );
    return parseRuntimeBoundarySkillNames(row?.skill_names);
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
  const [mcpServers, skills] = await Promise.all([
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
  ]);
  return { mcpServers, skills };
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
