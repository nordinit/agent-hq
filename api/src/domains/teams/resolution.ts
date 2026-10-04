import type { Db } from '../../db/adapter/types';
import { fetchEffectiveAgentToolRows, fetchEffectiveAgentMcpRows, resolveEffectiveSkillNames } from './effectiveCapabilities';

export interface TeamResolution {
  team_id: number;
  context_version: number;
  skill_names: string[];
  members: Array<{
    id: number; name: string; enabled: boolean;
    capabilities: Array<{ id: string; label: string; kind: 'tool' | 'mcp' | 'skill'; source: string }>;
  }>;
}

export async function getTeamResolution(db: Db, teamId: number, tenantId: number): Promise<TeamResolution> {
  const team = await db.get<{ context_version: number; skill_names: string }>(`SELECT context_version, skill_names FROM teams WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`, teamId, tenantId);
  if (!team) throw Object.assign(new Error('Team not found'), { status: 404 });
  const rows = await db.all<{ id: number; name: string; enabled: number }>(`SELECT a.id, a.name, a.enabled FROM agents a JOIN team_members tm ON tm.agent_id = a.id WHERE tm.team_id = ? AND tm.enabled = 1 AND a.tenant_id = ? AND a.deleted_at IS NULL ORDER BY tm.sort_order, a.id`, teamId, tenantId);
  const members: TeamResolution['members'] = [];
  // Bound database concurrency independently of roster size.
  for (const row of rows) {
    const tools = await fetchEffectiveAgentToolRows(db, row.id);
    const servers = await fetchEffectiveAgentMcpRows(db, row.id);
    const skills = await resolveEffectiveSkillNames(db, row.id);
    members.push({ id: Number(row.id), name: row.name, enabled: Number(row.enabled) === 1, capabilities: [
      ...tools.map(t => ({ id: `tool:${t.id}`, kind: 'tool' as const, label: String(t.name), source: t.source === 'team' ? String(t.source_team_name) : 'Agent' })),
      ...servers.map(t => ({ id: `mcp:${t.mcp_server_id}`, kind: 'mcp' as const, label: String(t.slug), source: t.source === 'team' ? String(t.source_team_name) : 'Agent' })),
      ...skills.map(name => ({ id: `skill:${name}`, kind: 'skill' as const, label: name, source: 'Combined agent and team skills' })),
    ] });
  }
  let skills: unknown;
  try { skills = JSON.parse(team.skill_names); } catch { skills = []; }
  return { team_id: teamId, context_version: Number(team.context_version), skill_names: Array.isArray(skills) ? skills.filter((s): s is string => typeof s === 'string') : [], members };
}

/** Run the real resolver against a draft, then roll back. No materialization or dispatch. */
export async function previewTeamSkills(db: Db, teamId: number, tenantId: number, skills: string[]): Promise<{ before: TeamResolution; after: TeamResolution }> {
  const rollback = new Error('Rollback team capability preview');
  let result: { before: TeamResolution; after: TeamResolution } | undefined;
  try {
    await db.withTransaction(async tx => {
      await tx.get(`SELECT id FROM teams WHERE id = ? AND tenant_id = ? FOR UPDATE`, teamId, tenantId);
      const before = await getTeamResolution(tx, teamId, tenantId);
      await tx.run(`UPDATE teams SET skill_names = ? WHERE id = ? AND tenant_id = ?`, JSON.stringify([...new Set(skills)]), teamId, tenantId);
      result = { before, after: await getTeamResolution(tx, teamId, tenantId) };
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  if (!result) throw new Error('Team preview did not complete');
  return result;
}
