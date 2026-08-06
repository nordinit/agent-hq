import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import {
  fetchEffectiveAgentMcpRows,
  fetchEffectiveAgentToolRows,
  findAgentIdsWithEffectiveMcpServer,
  resolveEffectiveSkillNames,
} from './effectiveCapabilities';

async function resetDb(): Promise<void> {
  await setupTestDb();
  const db = getDb();
  await db.exec(`
    INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Tenant A', 'tenant-a', 1);
    INSERT INTO tenants (id, name, slug, is_default) VALUES (2, 'Tenant B', 'tenant-b', 0);
    INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1');
    INSERT INTO app_settings (key, value) VALUES ('active_tenant_id', '1');
  `);
}

async function createAgent(
  name: string,
  options: { tenantId?: number; skillNames?: string[] } = {},
): Promise<number> {
  const result = await getDb().run(
    `INSERT INTO agents (tenant_id, name, session_key, skill_names) VALUES (?, ?, ?, ?)`,
    options.tenantId ?? 1,
    name,
    `agent:${name.toLowerCase()}`,
    JSON.stringify(options.skillNames ?? []),
  );
  return result.lastInsertId as number;
}

async function createTeam(
  name: string,
  options: { tenantId?: number; skillNames?: string[]; enabled?: number; deletedAt?: string | null } = {},
): Promise<number> {
  const result = await getDb().run(
    `INSERT INTO teams (tenant_id, name, slug, skill_names, enabled, deleted_at) VALUES (?, ?, ?, ?, ?, ?)`,
    options.tenantId ?? 1,
    name,
    name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    JSON.stringify(options.skillNames ?? []),
    options.enabled ?? 1,
    options.deletedAt ?? null,
  );
  return result.lastInsertId as number;
}

async function addMember(teamId: number, agentId: number, enabled = 1): Promise<void> {
  await getDb().run(
    `INSERT INTO team_members (team_id, agent_id, enabled) VALUES (?, ?, ?)`,
    teamId, agentId, enabled,
  );
}

async function createTool(name: string, options: { tenantId?: number; enabled?: number } = {}): Promise<number> {
  const result = await getDb().run(
    `INSERT INTO tools (tenant_id, name, slug, implementation_type, implementation_body, enabled)
     VALUES (?, ?, ?, 'bash', 'echo hi', ?)`,
    options.tenantId ?? 1,
    name,
    name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
    options.enabled ?? 1,
  );
  return result.lastInsertId as number;
}

async function createMcpServer(slug: string, options: { tenantId?: number; enabled?: number } = {}): Promise<number> {
  const result = await getDb().run(
    `INSERT INTO mcp_servers (tenant_id, name, slug, command, enabled) VALUES (?, ?, ?, 'node', ?)`,
    options.tenantId ?? 1,
    slug,
    slug,
    options.enabled ?? 1,
  );
  return result.lastInsertId as number;
}

describe('effective capability resolution across teams', () => {
  beforeEach(resetDb);
  afterEach(teardownTestDb);

  describe('tools', () => {
    it('unions the agent\'s own grants with every team it belongs to', async () => {
      const agentId = await createAgent('Nova');
      const ownTool = await createTool('Own Tool');
      const teamOneTool = await createTool('Team One Tool');
      const teamTwoTool = await createTool('Team Two Tool');
      const teamOne = await createTeam('Team One');
      const teamTwo = await createTeam('Team Two');
      await addMember(teamOne, agentId);
      await addMember(teamTwo, agentId);

      const db = getDb();
      await db.run(`INSERT INTO agent_tool_assignments (agent_id, tool_id) VALUES (?, ?)`, agentId, ownTool);
      await db.run(`INSERT INTO team_tool_assignments (team_id, tool_id) VALUES (?, ?)`, teamOne, teamOneTool);
      await db.run(`INSERT INTO team_tool_assignments (team_id, tool_id) VALUES (?, ?)`, teamTwo, teamTwoTool);

      const rows = await fetchEffectiveAgentToolRows(db, agentId);
      expect(rows.map((row) => row.name)).toEqual(['Own Tool', 'Team One Tool', 'Team Two Tool']);
    });

    it('lets an agent-level row override the team\'s configuration for the same tool', async () => {
      const agentId = await createAgent('Nova');
      const toolId = await createTool('Shared Tool');
      const teamId = await createTeam('Team One');
      await addMember(teamId, agentId);

      const db = getDb();
      await db.run(
        `INSERT INTO team_tool_assignments (team_id, tool_id, overrides) VALUES (?, ?, ?)`,
        teamId, toolId, JSON.stringify({ timeout_ms: 1000 }),
      );
      await db.run(
        `INSERT INTO agent_tool_assignments (agent_id, tool_id, overrides) VALUES (?, ?, ?)`,
        agentId, toolId, JSON.stringify({ timeout_ms: 9000 }),
      );

      const rows = await fetchEffectiveAgentToolRows(db, agentId);
      expect(rows).toHaveLength(1);
      expect(rows[0].source).toBe('agent');
      expect(JSON.parse(String(rows[0].overrides))).toEqual({ timeout_ms: 9000 });
    });

    it('treats a disabled agent-level row as an explicit opt-out from the team grant', async () => {
      const agentId = await createAgent('Nova');
      const toolId = await createTool('Shared Tool');
      const teamId = await createTeam('Team One');
      await addMember(teamId, agentId);

      const db = getDb();
      await db.run(`INSERT INTO team_tool_assignments (team_id, tool_id) VALUES (?, ?)`, teamId, toolId);
      await db.run(`INSERT INTO agent_tool_assignments (agent_id, tool_id, enabled) VALUES (?, ?, 0)`, agentId, toolId);

      expect(await fetchEffectiveAgentToolRows(db, agentId)).toEqual([]);
    });

    it('carries team provenance so the UI can say where a grant came from', async () => {
      const agentId = await createAgent('Nova');
      const toolId = await createTool('Team Tool');
      const teamId = await createTeam('Delivery Squad');
      await addMember(teamId, agentId);
      await getDb().run(`INSERT INTO team_tool_assignments (team_id, tool_id) VALUES (?, ?)`, teamId, toolId);

      const [row] = await fetchEffectiveAgentToolRows(getDb(), agentId);
      expect(row.source).toBe('team');
      expect(Number(row.source_team_id)).toBe(teamId);
      expect(row.source_team_name).toBe('Delivery Squad');
    });

    it('drops team grants from a disabled, soft-deleted team or a disabled membership', async () => {
      const agentId = await createAgent('Nova');
      const db = getDb();

      const disabledTeam = await createTeam('Disabled', { enabled: 0 });
      const deletedTeam = await createTeam('Deleted', { deletedAt: '2026-08-01 00:00:00' });
      const leftTeam = await createTeam('Left');
      await addMember(disabledTeam, agentId);
      await addMember(deletedTeam, agentId);
      await addMember(leftTeam, agentId, 0);

      for (const teamId of [disabledTeam, deletedTeam, leftTeam]) {
        const toolId = await createTool(`Tool ${teamId}`);
        await db.run(`INSERT INTO team_tool_assignments (team_id, tool_id) VALUES (?, ?)`, teamId, toolId);
      }

      expect(await fetchEffectiveAgentToolRows(db, agentId)).toEqual([]);
    });

    it('never lets a team hand a tool across a tenant boundary', async () => {
      // The team and the agent are in tenant 1; the tool belongs to tenant 2.
      const agentId = await createAgent('Nova', { tenantId: 1 });
      const foreignTool = await createTool('Foreign Tool', { tenantId: 2 });
      const teamId = await createTeam('Team One', { tenantId: 1 });
      await addMember(teamId, agentId);
      await getDb().run(`INSERT INTO team_tool_assignments (team_id, tool_id) VALUES (?, ?)`, teamId, foreignTool);

      expect(await fetchEffectiveAgentToolRows(getDb(), agentId)).toEqual([]);
    });

    it('never lets a team in another tenant reach an agent', async () => {
      const agentId = await createAgent('Nova', { tenantId: 1 });
      const toolId = await createTool('Foreign Tool', { tenantId: 2 });
      const foreignTeam = await createTeam('Foreign Team', { tenantId: 2 });
      await addMember(foreignTeam, agentId);
      await getDb().run(`INSERT INTO team_tool_assignments (team_id, tool_id) VALUES (?, ?)`, foreignTeam, toolId);

      expect(await fetchEffectiveAgentToolRows(getDb(), agentId)).toEqual([]);
    });

    it('drops a tool that is itself disabled, whoever granted it', async () => {
      const agentId = await createAgent('Nova');
      const toolId = await createTool('Retired Tool', { enabled: 0 });
      const teamId = await createTeam('Team One');
      await addMember(teamId, agentId);
      await getDb().run(`INSERT INTO team_tool_assignments (team_id, tool_id) VALUES (?, ?)`, teamId, toolId);

      expect(await fetchEffectiveAgentToolRows(getDb(), agentId)).toEqual([]);
    });

    it('resolves a tool granted by two teams to the lower team id, deterministically', async () => {
      const agentId = await createAgent('Nova');
      const toolId = await createTool('Shared Tool');
      const firstTeam = await createTeam('First');
      const secondTeam = await createTeam('Second');
      await addMember(firstTeam, agentId);
      await addMember(secondTeam, agentId);

      const db = getDb();
      await db.run(`INSERT INTO team_tool_assignments (team_id, tool_id) VALUES (?, ?)`, firstTeam, toolId);
      await db.run(`INSERT INTO team_tool_assignments (team_id, tool_id) VALUES (?, ?)`, secondTeam, toolId);

      const rows = await fetchEffectiveAgentToolRows(db, agentId);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].source_team_id)).toBe(firstTeam);
    });
  });

  describe('mcp servers', () => {
    it('unions agent and team assignments and honours the agent opt-out', async () => {
      const agentId = await createAgent('Nova');
      const ownServer = await createMcpServer('own-server');
      const teamServer = await createMcpServer('team-server');
      const optedOut = await createMcpServer('opted-out');
      const teamId = await createTeam('Team One');
      await addMember(teamId, agentId);

      const db = getDb();
      await db.run(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (?, ?)`, agentId, ownServer);
      await db.run(`INSERT INTO team_mcp_assignments (team_id, mcp_server_id) VALUES (?, ?)`, teamId, teamServer);
      await db.run(`INSERT INTO team_mcp_assignments (team_id, mcp_server_id) VALUES (?, ?)`, teamId, optedOut);
      await db.run(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id, enabled) VALUES (?, ?, 0)`, agentId, optedOut);

      const rows = await fetchEffectiveAgentMcpRows(db, agentId);
      expect(rows.map((row) => row.slug)).toEqual(['own-server', 'team-server']);
    });

    it('finds agents reachable through a team when a server changes', async () => {
      const directAgent = await createAgent('Direct');
      const teamAgent = await createAgent('ViaTeam');
      const unrelated = await createAgent('Unrelated');
      const serverId = await createMcpServer('shared-server');
      const teamId = await createTeam('Team One');
      await addMember(teamId, teamAgent);

      const db = getDb();
      await db.run(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (?, ?)`, directAgent, serverId);
      await db.run(`INSERT INTO team_mcp_assignments (team_id, mcp_server_id) VALUES (?, ?)`, teamId, serverId);

      const reachable = await findAgentIdsWithEffectiveMcpServer(db, serverId);
      expect(reachable).toEqual([directAgent, teamAgent].sort((a, b) => a - b));
      expect(reachable).not.toContain(unrelated);
    });
  });

  describe('skills', () => {
    it('appends team skills after the agent\'s own, deduplicated and order-stable', async () => {
      const agentId = await createAgent('Nova', { skillNames: ['create-task', 'shared-skill'] });
      const teamOne = await createTeam('Team One', { skillNames: ['shared-skill', 'task-routing-rules'] });
      const teamTwo = await createTeam('Team Two', { skillNames: ['release-notes'] });
      await addMember(teamOne, agentId);
      await addMember(teamTwo, agentId);

      expect(await resolveEffectiveSkillNames(getDb(), agentId)).toEqual([
        'create-task',
        'shared-skill',
        'task-routing-rules',
        'release-notes',
      ]);
    });

    it('accepts the agent row the dispatcher already holds instead of re-reading it', async () => {
      const agentId = await createAgent('Nova', { skillNames: ['stored'] });
      const teamId = await createTeam('Team One', { skillNames: ['from-team'] });
      await addMember(teamId, agentId);

      expect(await resolveEffectiveSkillNames(getDb(), agentId, JSON.stringify(['passed-in'])))
        .toEqual(['passed-in', 'from-team']);
    });

    it('tolerates malformed skill_names rather than failing a dispatch', async () => {
      const agentId = await createAgent('Nova');
      await getDb().run(`UPDATE agents SET skill_names = 'not json' WHERE id = ?`, agentId);
      expect(await resolveEffectiveSkillNames(getDb(), agentId)).toEqual([]);
    });
  });
});
