/**
 * Deciding which team speaks for a dispatch, and rendering its context block.
 *
 * An agent may belong to several teams, so "the agent's team" is not a well-defined thing at
 * dispatch time — it has to be resolved against the work being dispatched. The order below is
 * the whole of that decision, and it is deliberately conservative: when it cannot tell, it
 * injects nothing rather than guessing, because a prompt that describes the wrong team is worse
 * than one that describes no team.
 *
 *   1. The workflow's owning team, if the agent is a member of it.
 *   2. The agent's only enabled membership.
 *   3. The membership flagged is_primary.
 *   4. Nothing.
 *
 * Step 1 requires membership on purpose. An agent pulled in as a one-off on a team-owned
 * workflow should not be told it is on a team it is not on: it would be told to hand work to
 * teammates through routes that do not exist for it.
 */

import type { Db } from '../../db/adapter/types';
import { buildTeamContextSection, type TeamContextMember } from '../../services/dispatch/prompt/teamContext';

/** Membership rows that can speak for an agent: enabled, undeleted team, same tenant. */
const AGENT_TEAM_SCOPE = `
  FROM team_members tm
  JOIN teams te ON te.id = tm.team_id
  JOIN agents a ON a.id = tm.agent_id AND a.tenant_id = te.tenant_id
  WHERE tm.agent_id = ?
    AND tm.enabled = 1
    AND te.enabled = 1
    AND te.deleted_at IS NULL
`;

export interface ResolvedTeamContext {
  teamId: number;
  teamName: string;
  contextVersion: number;
  /** The rendered block, or '' when the team had nothing worth saying. */
  section: string;
}

interface TeamCandidateRow {
  team_id: number;
  name: string;
  is_primary: number;
}

/** Teams that could speak for this agent, in id order. */
async function loadCandidateTeams(db: Db, agentId: number): Promise<TeamCandidateRow[]> {
  return await db.all(`
    SELECT te.id AS team_id, te.name AS name, tm.is_primary AS is_primary
    ${AGENT_TEAM_SCOPE}
    ORDER BY te.id ASC
  `, agentId) as TeamCandidateRow[];
}

/**
 * resolveDispatchTeamId — which team, if any, should appear in this agent's prompt.
 *
 * Exported for the preview endpoint and for tests, which assert the precedence directly rather
 * than through rendered prose.
 */
export async function resolveDispatchTeamId(
  db: Db,
  params: { agentId: number; sprintId?: number | null },
): Promise<number | null> {
  const candidates = await loadCandidateTeams(db, params.agentId);
  if (candidates.length === 0) return null;

  if (params.sprintId != null) {
    const workflow = await db.get(
      `SELECT team_id FROM sprints WHERE id = ?`,
      params.sprintId,
    ) as { team_id?: number | null } | undefined;
    const owningTeamId = workflow?.team_id ?? null;
    if (owningTeamId != null) {
      const match = candidates.find((candidate) => Number(candidate.team_id) === Number(owningTeamId));
      if (match) return Number(match.team_id);
      // The workflow has an owner and this agent is not on it. Fall through rather than
      // claiming a different team owns work it does not.
    }
  }

  if (candidates.length === 1) return Number(candidates[0].team_id);

  const primary = candidates.filter((candidate) => Number(candidate.is_primary) === 1);
  if (primary.length === 1) return Number(primary[0].team_id);

  console.warn(
    `[teams] agent #${params.agentId} belongs to ${candidates.length} teams with no workflow owner ` +
    `and no primary membership; injecting no team context`,
  );
  return null;
}

/**
 * Renders the context block for a specific agent on a specific team.
 *
 * Members are ordered by (sort_order, id) — the same order the index is built on — so the block
 * is byte-identical across dispatches for unchanged team state.
 */
export async function renderTeamContextForAgent(
  db: Db,
  params: { teamId: number; agentId: number },
): Promise<ResolvedTeamContext | null> {
  const team = await db.get(`
    SELECT id, name, goal, charter, context_version
    FROM teams
    WHERE id = ? AND enabled = 1 AND deleted_at IS NULL
  `, params.teamId) as
    { id: number; name: string; goal: string; charter: string; context_version: number } | undefined;
  if (!team) return null;

  const memberRows = await db.all(`
    SELECT tm.agent_id AS agent_id,
           tm.member_role AS member_role,
           tm.responsibilities AS responsibilities,
           tm.is_lead AS is_lead,
           COALESCE(NULLIF(ag.name, ''), NULLIF(ag.job_title, ''), 'Agent #' || ag.id) AS display_name
    FROM team_members tm
    JOIN agents ag ON ag.id = tm.agent_id
    WHERE tm.team_id = ?
      AND tm.enabled = 1
      AND ag.enabled = 1
      AND ag.deleted_at IS NULL
    ORDER BY tm.sort_order ASC, tm.id ASC
  `, params.teamId) as Array<{
    agent_id: number;
    member_role: string;
    responsibilities: string;
    is_lead: number;
    display_name: string;
  }>;

  const members: TeamContextMember[] = memberRows.map((row) => ({
    name: String(row.display_name ?? ''),
    memberRole: String(row.member_role ?? ''),
    responsibilities: String(row.responsibilities ?? ''),
    isSelf: Number(row.agent_id) === Number(params.agentId),
    isLead: Number(row.is_lead) === 1,
  }));

  return {
    teamId: Number(team.id),
    teamName: String(team.name),
    contextVersion: Number(team.context_version ?? 1),
    section: buildTeamContextSection({
      teamName: String(team.name),
      goal: String(team.goal ?? ''),
      charter: String(team.charter ?? ''),
      members,
    }),
  };
}

/**
 * resolveTeamContextForDispatch — the one call the dispatch paths make.
 *
 * Returns null when no team applies, when the resolved team is ambiguous, or when the team had
 * nothing worth injecting. Never throws: a team lookup problem must not fail a dispatch, so
 * failures degrade to "no team context" and are logged.
 */
export async function resolveTeamContextForDispatch(
  db: Db,
  params: { agentId: number | null | undefined; sprintId?: number | null },
): Promise<ResolvedTeamContext | null> {
  if (params.agentId == null) return null;
  try {
    const teamId = await resolveDispatchTeamId(db, { agentId: params.agentId, sprintId: params.sprintId ?? null });
    if (teamId == null) return null;
    const resolved = await renderTeamContextForAgent(db, { teamId, agentId: params.agentId });
    if (!resolved || !resolved.section) return null;
    return resolved;
  } catch (err) {
    console.warn(
      `[teams] failed to resolve team context for agent #${params.agentId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
