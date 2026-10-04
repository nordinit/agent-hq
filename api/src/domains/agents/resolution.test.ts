import { agentMcpPolicyRevision, getAgentMcpPermissionPolicy, replaceAgentMcpPermissionPolicy } from '../../lib/mcpApiAuth';
import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { getAgentResolution } from './resolution';
import { fetchEffectiveAgentToolRows, fetchEffectiveAgentMcpRows } from '../teams/effectiveCapabilities';

describe('agent resolution', () => {
  beforeEach(async () => {
    await setupTestDb();
    await getDb().exec(`
      INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'A', 'a', 1), (2, 'B', 'b', 0);
      INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1');
      INSERT INTO agents (id, tenant_id, name, session_key, skill_names) VALUES (1, 1, 'Nova', 'agent:nova', '["own"]');
      INSERT INTO teams (id, tenant_id, name, slug, skill_names) VALUES (1, 1, 'Team A', 'team-a', '["shared"]'), (2, 1, 'Team B', 'team-b', '["shared"]'), (3, 2, 'Foreign', 'foreign', '["secret"]');
      INSERT INTO team_members (team_id, agent_id) VALUES (1, 1), (2, 1), (3, 1);
      INSERT INTO tools (id, tenant_id, name, slug, implementation_type, implementation_body) VALUES (1, 1, 'Build', 'build', 'bash', 'secret body'), (2, 2, 'Foreign tool', 'foreign', 'bash', 'secret foreign');
      INSERT INTO team_tool_assignments (team_id, tool_id) VALUES (1, 1), (2, 1), (3, 2);
      INSERT INTO mcp_servers (id, tenant_id, name, slug, command, env) VALUES (1, 1, 'Git', 'git', 'secret-command', '{"TOKEN":"secret-token"}');
      INSERT INTO team_mcp_assignments (team_id, mcp_server_id) VALUES (1, 1);
    `);
  });
  afterEach(teardownTestDb);
  it('matches dispatch winners, explains competing grants and hides secrets', async () => {
    const result = await getAgentResolution(getDb(), 1, 1);
    expect(result.entries.filter(e => e.kind === 'tool' && e.effective).map(e => Number(e.id.split(':')[1])))
      .toEqual((await fetchEffectiveAgentToolRows(getDb(), 1)).map(r => Number(r.id)));
    expect(result.entries.filter(e => e.kind === 'mcp' && e.effective).map(e => Number(e.id.split(':')[1])))
      .toEqual((await fetchEffectiveAgentMcpRows(getDb(), 1)).map(r => Number(r.mcp_server_id)));
    expect(result.entries.find(e => e.id === 'tool:1')?.sources.map(s => s.state)).toEqual(['active', 'overridden']);
    expect(result.entries.find(e => e.id === 'skill:shared')?.sources).toHaveLength(2);
    expect(result.findings.some(f => f.code === 'ambiguous_team_context')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/secret-token|secret-command|secret body|skill:secret|Foreign/);
  });
  it('explains agent overrides and explicit opt-outs', async () => {
    await getDb().run(`INSERT INTO agent_tool_assignments (agent_id, tool_id, enabled) VALUES (1, 1, 1)`);
    let result = await getAgentResolution(getDb(), 1, 1);
    expect(result.entries.find(e => e.id === 'tool:1')?.sources.map(s => s.state)).toEqual(['overridden', 'overridden', 'active']);
    await getDb().run(`UPDATE agent_tool_assignments SET enabled = 0 WHERE agent_id = 1`);
    result = await getAgentResolution(getDb(), 1, 1);
    expect(result.entries.find(e => e.id === 'tool:1')?.effective).toBe(false);
    expect(result.entries.find(e => e.id === 'tool:1')?.sources.every(s => s.state === 'opted_out')).toBe(true);
  });
  it('shows global disable and excludes disabled memberships', async () => {
    await getDb().run(`UPDATE tools SET enabled = 0 WHERE id = 1`);
    await getDb().run(`UPDATE team_members SET enabled = 0 WHERE team_id = 2`);
    const result = await getAgentResolution(getDb(), 1, 1);
    expect(result.entries.find(e => e.id === 'tool:1')).toMatchObject({ effective: false, sources: [{ state: 'disabled' }] });
    expect(result.sources.some(s => s.id === 'team:2')).toBe(false);
    expect(result.context.team_id).toBe(1);
  });
  it('explicit policy replaces rather than merges defaults', async () => {
    await getDb().run(`INSERT INTO agent_mcp_capability_policies (agent_id, capability_key, enabled) VALUES (1, 'tasks.write_active_lifecycle', 0)`);
    const result = await getAgentResolution(getDb(), 1, 1);
    expect(result.policy_mode).toBe('explicit');
    expect(result.entries.filter(e => e.kind === 'permission').every(e => !e.effective)).toBe(true);
    expect(result.findings.some(f => f.code === 'defaults_replaced')).toBe(true);
  });
  it('rejects stale permission drafts without overwriting a newer policy', async () => {
    const before = await getAgentResolution(getDb(), 1, 1);
    const saved = await replaceAgentMcpPermissionPolicy(getDb(), 1, ['discovery.read_catalog'], before.policy_revision);
    expect(agentMcpPolicyRevision(saved)).not.toBe(before.policy_revision);
    await expect(replaceAgentMcpPermissionPolicy(getDb(), 1, [], before.policy_revision)).rejects.toMatchObject({ status: 409 });
    expect((await getAgentMcpPermissionPolicy(getDb(), 1)).capabilities.find(c => c.key === 'discovery.read_catalog')?.enabled).toBe(true);
  });
  it('uses the workflow owner team ahead of the primary team and scopes routing', async () => {
    await getDb().exec(`
      INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Project');
      UPDATE agents SET project_id = 1 WHERE id = 1;
      UPDATE team_members SET is_primary = 1 WHERE agent_id = 1 AND team_id = 1;
      INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type, status, team_id) VALUES (1, 1, 1, 'Workflow', 'dev', 'active', 2);
    `);
    expect((await getAgentResolution(getDb(), 1, 1)).context.team_id).toBe(1);
    const result = await getAgentResolution(getDb(), 1, 1, 1);
    expect(result.context.team_id).toBe(2);
    expect(result.workflows).toEqual([{ id: 1, name: 'Workflow' }]);
  });
  it('rejects foreign tenants, deleted agents and invalid workflow scope', async () => {
    await expect(getAgentResolution(getDb(), 1, 2)).rejects.toMatchObject({ status: 404 });
    await expect(getAgentResolution(getDb(), 1, 1, 999)).rejects.toMatchObject({ status: 404 });
    await getDb().run(`UPDATE agents SET deleted_at = '2026-01-01' WHERE id = 1`);
    await expect(getAgentResolution(getDb(), 1, 1)).rejects.toMatchObject({ status: 404 });
  });
});
