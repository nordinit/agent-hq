/**
 * Effective capability resolution: what an agent actually gets once its team memberships are
 * taken into account.
 *
 * THE RULE
 * The effective set is the union of team grants and agent grants. An agent-level row overrides
 * the team's configuration for the same tool or server, and an agent-level row with
 * `enabled = 0` is an explicit opt-out from a team grant. That last case is why these helpers
 * select disabled agent rows rather than filtering them in SQL the way the pre-team queries
 * did: a disabled row is a signal, not an absence.
 *
 * WHY ONE MODULE
 * Five call sites read these assignments, and one of them — src/bin/agent-tool-mcp.ts — is the
 * standalone MCP server that actually exposes registry tools to a running agent. If it resolved
 * a different set than the dispatcher materialized, an agent would see tools it was not granted
 * or lose tools it was. They agree because they all call the same function.
 *
 * TENANT SCOPE
 * Every query here re-asserts `tenant_id = agents.tenant_id` for the team and for the granted
 * resource. Teams are a new path into `tools` and `mcp_servers`, so they need the same guard
 * fetchAgentTools already applied — a team in one tenant must never hand a resource to an agent
 * in another.
 */

import type { Db } from '../../db/adapter/types';

/** Provenance attached to every effective row, so the UI and logs can explain where a grant came from. */
export interface EffectiveAssignmentProvenance {
  source: 'agent' | 'team';
  source_team_id: number | null;
  source_team_name: string | null;
}

type Row = Record<string, unknown>;

/**
 * Teams whose grants reach this agent: enabled, undeleted, same tenant, membership enabled.
 * Ordered by id so that when two teams grant the same resource the winner is deterministic.
 */
const AGENT_TEAM_SCOPE = `
  FROM team_members tm
  JOIN teams te ON te.id = tm.team_id
  JOIN agents a ON a.id = tm.agent_id AND a.tenant_id = te.tenant_id
  WHERE tm.agent_id = ?
    AND tm.enabled = 1
    AND te.enabled = 1
    AND te.deleted_at IS NULL
`;

/**
 * Merges team-sourced and agent-sourced rows under the precedence rule.
 *
 * `keyOf` identifies the granted resource (tool id, server id). Team rows are applied first in
 * team order, then agent rows override or delete.
 */
function mergeByPrecedence(
  teamRows: Row[],
  agentRows: Row[],
  keyOf: (row: Row) => unknown,
): Row[] {
  const merged = new Map<unknown, Row>();
  for (const row of teamRows) {
    // First team wins; teamRows arrive ordered by team id.
    if (!merged.has(keyOf(row))) merged.set(keyOf(row), row);
  }
  for (const row of agentRows) {
    if (Number(row.assignment_enabled ?? 0) === 0) {
      merged.delete(keyOf(row));
      continue;
    }
    merged.set(keyOf(row), row);
  }
  return Array.from(merged.values());
}

/**
 * Registry tools an agent can run, from its own assignments and every team it belongs to.
 *
 * Returns the same row shape as the pre-team `fetchAgentTools` query — `assignment_id`,
 * `overrides`, `assignment_enabled`, `agent_tenant_id` and all of `tools.*` — plus provenance,
 * so callers can keep their existing types.
 */
export async function fetchEffectiveAgentToolRows(db: Db, agentId: number): Promise<Row[]> {
  const agentRows = await db.all(`
    SELECT 'agent' AS source,
           NULL::bigint AS source_team_id,
           NULL::text AS source_team_name,
           ata.id AS assignment_id,
           ata.overrides,
           ata.enabled AS assignment_enabled,
           a.tenant_id AS agent_tenant_id,
           t.*
    FROM agent_tool_assignments ata
    JOIN agents a ON a.id = ata.agent_id
    JOIN tools t ON t.id = ata.tool_id AND t.tenant_id = a.tenant_id
    WHERE ata.agent_id = ?
  `, agentId) as Row[];

  const teamRows = await db.all(`
    SELECT 'team' AS source,
           te.id AS source_team_id,
           te.name AS source_team_name,
           tta.id AS assignment_id,
           tta.overrides,
           tta.enabled AS assignment_enabled,
           a.tenant_id AS agent_tenant_id,
           t.*
    FROM team_members tm
    JOIN teams te ON te.id = tm.team_id
    JOIN agents a ON a.id = tm.agent_id AND a.tenant_id = te.tenant_id
    JOIN team_tool_assignments tta ON tta.team_id = te.id
    JOIN tools t ON t.id = tta.tool_id AND t.tenant_id = te.tenant_id
    WHERE tm.agent_id = ?
      AND tm.enabled = 1
      AND te.enabled = 1
      AND te.deleted_at IS NULL
      AND tta.enabled = 1
    ORDER BY te.id ASC, t.name ASC
  `, agentId) as Row[];

  return mergeByPrecedence(teamRows, agentRows, (row) => row.id)
    // The tool itself being disabled removes it regardless of who granted it.
    .filter((row) => Number(row.enabled ?? 0) === 1)
    .sort((left, right) => String(left.name ?? '').localeCompare(String(right.name ?? '')));
}

// Deliberately no `agentHasEffectiveRegistryTools` convenience wrapper here. The one caller that
// would want it — the claude-code RuntimeBoundaryV1 guard — treats a database inspection error as
// fatal, because silently reporting "no tools" would make an assigned capability vanish from the
// launched runtime. A helper that swallowed errors would quietly defeat that guard, so callers
// use fetchEffectiveAgentToolRows directly and let failures propagate.

/**
 * MCP servers assigned to an agent, from its own assignments and every team it belongs to.
 *
 * Row shape matches the pre-team `fetchAssignedMcpServers` query: `assignment_id`, `slug`,
 * `command`, `args`, `env`, `cwd`, `overrides`.
 */
export async function fetchEffectiveAgentMcpRows(db: Db, agentId: number): Promise<Row[]> {
  const agentRows = await db.all(`
    SELECT 'agent' AS source,
           NULL::bigint AS source_team_id,
           NULL::text AS source_team_name,
           ama.id AS assignment_id,
           s.id AS mcp_server_id,
           s.id AS server_id,
           s.slug, s.command, s.args, s.env, s.cwd,
           s.updated_at AS server_updated_at,
           ama.overrides,
           ama.enabled AS assignment_enabled,
           s.enabled AS server_enabled
    FROM agent_mcp_assignments ama
    JOIN mcp_servers s ON s.id = ama.mcp_server_id
    JOIN agents a ON a.id = ama.agent_id AND a.tenant_id = s.tenant_id
    WHERE ama.agent_id = ?
  `, agentId) as Row[];

  const teamRows = await db.all(`
    SELECT 'team' AS source,
           te.id AS source_team_id,
           te.name AS source_team_name,
           tma.id AS assignment_id,
           s.id AS mcp_server_id,
           s.id AS server_id,
           s.slug, s.command, s.args, s.env, s.cwd,
           s.updated_at AS server_updated_at,
           tma.overrides,
           tma.enabled AS assignment_enabled,
           s.enabled AS server_enabled
    FROM team_members tm
    JOIN teams te ON te.id = tm.team_id
    JOIN agents a ON a.id = tm.agent_id AND a.tenant_id = te.tenant_id
    JOIN team_mcp_assignments tma ON tma.team_id = te.id
    JOIN mcp_servers s ON s.id = tma.mcp_server_id AND s.tenant_id = te.tenant_id
    WHERE tm.agent_id = ?
      AND tm.enabled = 1
      AND te.enabled = 1
      AND te.deleted_at IS NULL
      AND tma.enabled = 1
    ORDER BY te.id ASC, s.slug ASC
  `, agentId) as Row[];

  return mergeByPrecedence(teamRows, agentRows, (row) => row.mcp_server_id)
    .filter((row) => Number(row.server_enabled ?? 0) === 1)
    .sort((left, right) => String(left.slug ?? '').localeCompare(String(right.slug ?? '')));
}

/** Agents whose effective MCP set includes this server, directly or through a team. */
export async function findAgentIdsWithEffectiveMcpServer(db: Db, mcpServerId: number): Promise<number[]> {
  const rows = await db.all(`
    SELECT DISTINCT agent_id FROM (
      SELECT ama.agent_id AS agent_id
      FROM agent_mcp_assignments ama
      WHERE ama.mcp_server_id = ?
      UNION
      SELECT tm.agent_id AS agent_id
      FROM team_mcp_assignments tma
      JOIN teams te ON te.id = tma.team_id
      JOIN team_members tm ON tm.team_id = te.id
      WHERE tma.mcp_server_id = ?
        AND tma.enabled = 1
        AND tm.enabled = 1
        AND te.enabled = 1
        AND te.deleted_at IS NULL
    ) reachable
    ORDER BY agent_id ASC
  `, mcpServerId, mcpServerId) as Array<{ agent_id: number }>;
  return rows.map((row) => Number(row.agent_id));
}

function parseSkillNames(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Skills an agent should have materialized: its own, then its teams', deduplicated.
 *
 * Unlike tools and MCP servers, skills are a flat JSON array with no per-entry enabled flag, so
 * there is no opt-out here — a team skill cannot be individually suppressed on one member. If
 * that becomes necessary it wants a real assignment table rather than a sentinel in the array.
 */
export async function resolveEffectiveSkillNames(
  db: Db,
  agentId: number,
  agentSkillNames?: unknown,
): Promise<string[]> {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    ordered.push(name);
  };

  // The dispatcher already holds the agent row, so let it pass skill_names rather than re-read.
  if (agentSkillNames === undefined) {
    const agent = await db.get(`SELECT skill_names FROM agents WHERE id = ?`, agentId) as { skill_names?: unknown } | undefined;
    for (const name of parseSkillNames(agent?.skill_names)) push(name);
  } else {
    for (const name of parseSkillNames(agentSkillNames)) push(name);
  }

  const teamRows = await db.all(`
    SELECT te.skill_names AS skill_names
    ${AGENT_TEAM_SCOPE}
    ORDER BY te.id ASC
  `, agentId) as Array<{ skill_names?: unknown }>;
  for (const row of teamRows) {
    for (const name of parseSkillNames(row.skill_names)) push(name);
  }

  return ordered;
}
