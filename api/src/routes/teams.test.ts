import express from 'express';
import type { Server } from 'http';
import teamsRouter, {
  agentEffectiveCapabilitiesRouter,
  agentTeamsRouter,
  workflowTeamRouter,
} from './teams';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';

async function resetDb(): Promise<void> {
  await setupTestDb();
  const db = getDb();
  await db.exec(`
    INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Tenant A', 'tenant-a', 1);
    INSERT INTO tenants (id, name, slug, is_default) VALUES (2, 'Tenant B', 'tenant-b', 0);
    INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1');
    INSERT INTO app_settings (key, value) VALUES ('active_tenant_id', '1');
    INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Platform');
  `);
}

function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/teams', teamsRouter);
  app.use('/api/v1/agents/:id/teams', agentTeamsRouter);
  app.use('/api/v1/agents/:id/effective-capabilities', agentEffectiveCapabilitiesRouter);
  app.use('/api/v1/workflows/:workflowId/team', workflowTeamRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function stopTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function createAgent(name: string, tenantId = 1): Promise<number> {
  const result = await getDb().run(
    `INSERT INTO agents (tenant_id, name, session_key) VALUES (?, ?, ?)`,
    tenantId, name, `agent:${name.toLowerCase()}`,
  );
  return result.lastInsertId as number;
}

describe('teams API', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    await resetDb();
    ({ server, baseUrl } = await startTestServer());
  });

  afterEach(async () => {
    await stopTestServer(server);
    await teardownTestDb();
  });

  const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const patch = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const put = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  it('creates a team, deriving the slug from the name', async () => {
    const res = await post('/api/v1/teams', { name: 'Delivery Squad', goal: 'Ship billing.' });
    expect(res.status).toBe(201);
    const team = await res.json() as any;
    expect(team).toMatchObject({ name: 'Delivery Squad', slug: 'delivery-squad', goal: 'Ship billing.' });
  });

  it('rejects a duplicate slug within a tenant', async () => {
    await post('/api/v1/teams', { name: 'Delivery Squad' });
    const res = await post('/api/v1/teams', { name: 'Delivery Squad' });
    expect(res.status).toBe(409);
  });

  it('allows the same slug to be reused after a soft delete', async () => {
    const created = await (await post('/api/v1/teams', { name: 'Delivery Squad' })).json() as any;
    await fetch(`${baseUrl}/api/v1/teams/${created.id}`, { method: 'DELETE' });
    expect((await post('/api/v1/teams', { name: 'Delivery Squad' })).status).toBe(201);
  });

  it('hides soft-deleted teams from the list', async () => {
    const created = await (await post('/api/v1/teams', { name: 'Delivery Squad' })).json() as any;
    await fetch(`${baseUrl}/api/v1/teams/${created.id}`, { method: 'DELETE' });
    expect(await (await fetch(`${baseUrl}/api/v1/teams`)).json() as any).toEqual([]);
  });

  it('bumps context_version when an edit changes what members will read', async () => {
    const created = await (await post('/api/v1/teams', { name: 'Delivery Squad' })).json() as any;
    expect(Number(created.context_version)).toBe(1);

    const updated = await (await patch(`/api/v1/teams/${created.id}`, { goal: 'New goal.' })).json() as any;
    expect(Number(updated.context_version)).toBe(2);
  });

  it('adds a member and refuses an agent from another tenant', async () => {
    const team = await (await post('/api/v1/teams', { name: 'Delivery Squad' })).json() as any;
    const nova = await createAgent('Nova');
    const foreign = await createAgent('Foreign', 2);

    const ok = await post(`/api/v1/teams/${team.id}/members`, {
      agent_id: nova, member_role: 'Implementer', responsibilities: 'Writes code',
    });
    expect(ok.status).toBe(201);
    expect(await ok.json() as any).toMatchObject({ member_role: 'Implementer' });

    expect((await post(`/api/v1/teams/${team.id}/members`, { agent_id: foreign })).status).toBe(404);
  });

  it('refuses to add the same agent to a team twice', async () => {
    const team = await (await post('/api/v1/teams', { name: 'Delivery Squad' })).json() as any;
    const nova = await createAgent('Nova');
    await post(`/api/v1/teams/${team.id}/members`, { agent_id: nova });
    expect((await post(`/api/v1/teams/${team.id}/members`, { agent_id: nova })).status).toBe(409);
  });

  it('lets an agent join several teams but hold only one primary membership', async () => {
    const first = await (await post('/api/v1/teams', { name: 'First' })).json() as any;
    const second = await (await post('/api/v1/teams', { name: 'Second' })).json() as any;
    const nova = await createAgent('Nova');

    expect((await post(`/api/v1/teams/${first.id}/members`, { agent_id: nova, is_primary: true })).status).toBe(201);
    expect((await post(`/api/v1/teams/${second.id}/members`, { agent_id: nova })).status).toBe(201);
    expect((await patch(`/api/v1/teams/${second.id}/members/${nova}`, { is_primary: true })).status).toBe(409);
  });

  it('previews the exact context block a member will receive', async () => {
    const team = await (await post('/api/v1/teams', { name: 'Delivery Squad', goal: 'Ship billing.' })).json() as any;
    const nova = await createAgent('Nova');
    const casper = await createAgent('Casper');
    await post(`/api/v1/teams/${team.id}/members`, { agent_id: nova, member_role: 'Implementer' });
    await post(`/api/v1/teams/${team.id}/members`, { agent_id: casper, member_role: 'Reviewer' });

    const preview = await (await fetch(`${baseUrl}/api/v1/teams/${team.id}/context-preview?agent_id=${nova}`)).json() as any;
    expect(preview.injected).toBe(true);
    expect(preview.section).toContain('You are Nova, Implementer on this team.');
    expect(preview.section).toContain('- Casper — Reviewer');
  });

  it('reports injected=false when the block would be omitted', async () => {
    const team = await (await post('/api/v1/teams', { name: 'Solo' })).json() as any;
    const nova = await createAgent('Nova');
    await post(`/api/v1/teams/${team.id}/members`, { agent_id: nova });

    const preview = await (await fetch(`${baseUrl}/api/v1/teams/${team.id}/context-preview?agent_id=${nova}`)).json() as any;
    expect(preview.injected).toBe(false);
    expect(preview.section).toBe('');
  });

  it('requires agent_id on the context preview', async () => {
    const team = await (await post('/api/v1/teams', { name: 'Delivery Squad' })).json() as any;
    expect((await fetch(`${baseUrl}/api/v1/teams/${team.id}/context-preview`)).status).toBe(400);
  });

  it('refuses a routing rule targeting an agent that is not a member', async () => {
    const team = await (await post('/api/v1/teams', { name: 'Delivery Squad' })).json() as any;
    const stranger = await createAgent('Stranger');
    const res = await post(`/api/v1/teams/${team.id}/routing-rules`, { status: 'ready', agent_id: stranger });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toContain('must be a member');
  });

  it('requires a routing rule to target either an agent or a role', async () => {
    const team = await (await post('/api/v1/teams', { name: 'Delivery Squad' })).json() as any;
    expect((await post(`/api/v1/teams/${team.id}/routing-rules`, { status: 'ready' })).status).toBe(400);
  });

  it('lists an agent\'s team memberships', async () => {
    const team = await (await post('/api/v1/teams', { name: 'Delivery Squad' })).json() as any;
    const nova = await createAgent('Nova');
    await post(`/api/v1/teams/${team.id}/members`, { agent_id: nova, member_role: 'Implementer' });

    const memberships = await (await fetch(`${baseUrl}/api/v1/agents/${nova}/teams`)).json() as any;
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ name: 'Delivery Squad', member_role: 'Implementer' });
  });

  it('labels effective capabilities as own or inherited', async () => {
    const db = getDb();
    const team = await (await post('/api/v1/teams', { name: 'Delivery Squad' })).json() as any;
    const nova = await createAgent('Nova');
    await post(`/api/v1/teams/${team.id}/members`, { agent_id: nova });

    const ownTool = (await db.run(
      `INSERT INTO tools (tenant_id, name, slug, implementation_type, implementation_body) VALUES (1, 'Own', 'own', 'bash', 'x')`,
    )).lastInsertId;
    const teamTool = (await db.run(
      `INSERT INTO tools (tenant_id, name, slug, implementation_type, implementation_body) VALUES (1, 'Shared', 'shared', 'bash', 'x')`,
    )).lastInsertId;
    await db.run(`INSERT INTO agent_tool_assignments (agent_id, tool_id) VALUES (?, ?)`, nova, ownTool);
    await post(`/api/v1/teams/${team.id}/tools`, { tool_id: teamTool });

    const effective = await (await fetch(`${baseUrl}/api/v1/agents/${nova}/effective-capabilities`)).json() as any;
    expect(effective.dispatch_team_id).toBe(team.id);
    expect(effective.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Own', source: 'agent' }),
      expect.objectContaining({ name: 'Shared', source: 'team', source_team_name: 'Delivery Squad' }),
    ]));
  });

  describe('workflow ownership', () => {
    async function createWorkflow(): Promise<number> {
      const result = await getDb().run(
        `INSERT INTO sprints (tenant_id, project_id, name, sprint_type) VALUES (1, 1, 'Billing', 'delivery')`,
      );
      return result.lastInsertId as number;
    }

    it('assigns a team without touching routing', async () => {
      const team = await (await post('/api/v1/teams', { name: 'Delivery Squad' })).json() as any;
      const nova = await createAgent('Nova');
      await post(`/api/v1/teams/${team.id}/members`, { agent_id: nova, member_role: 'Implementer' });
      await post(`/api/v1/teams/${team.id}/routing-rules`, { status: 'ready', agent_id: nova });
      const workflowId = await createWorkflow();

      const res = await put(`/api/v1/workflows/${workflowId}/team`, { team_id: team.id });
      expect(res.status).toBe(200);

      // Assignment alone must not have written routing configuration.
      const rules = await getDb().all(`SELECT * FROM sprint_task_routing_rules WHERE sprint_id = ?`, workflowId);
      expect(rules).toEqual([]);
    });

    it('dry-runs the routing template without writing', async () => {
      const team = await (await post('/api/v1/teams', { name: 'Delivery Squad' })).json() as any;
      const nova = await createAgent('Nova');
      await post(`/api/v1/teams/${team.id}/members`, { agent_id: nova, member_role: 'Implementer' });
      await post(`/api/v1/teams/${team.id}/routing-rules`, { status: 'ready', member_role: 'Implementer' });
      const workflowId = await createWorkflow();
      await put(`/api/v1/workflows/${workflowId}/team`, { team_id: team.id });

      const plan = await (await post(`/api/v1/workflows/${workflowId}/team/apply-routing?dry_run=1`, {})).json() as any;
      expect(plan.applied).toBe(false);
      expect(plan.summary.create).toBe(1);
      expect(await getDb().all(`SELECT * FROM sprint_task_routing_rules WHERE sprint_id = ?`, workflowId)).toEqual([]);
    });

    it('applies the routing template and records the actor', async () => {
      const team = await (await post('/api/v1/teams', { name: 'Delivery Squad' })).json() as any;
      const nova = await createAgent('Nova');
      await post(`/api/v1/teams/${team.id}/members`, { agent_id: nova, member_role: 'Implementer' });
      await post(`/api/v1/teams/${team.id}/routing-rules`, { status: 'ready', member_role: 'Implementer' });
      const workflowId = await createWorkflow();
      await put(`/api/v1/workflows/${workflowId}/team`, { team_id: team.id });

      const res = await fetch(`${baseUrl}/api/v1/workflows/${workflowId}/team/apply-routing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-actor': 'nordini' },
        body: '{}',
      });
      const plan = await res.json() as any;
      expect(plan.applied).toBe(true);
      expect(plan.summary.create).toBe(1);

      const rules = await getDb().all(`SELECT * FROM sprint_task_routing_rules WHERE sprint_id = ?`, workflowId);
      expect(rules).toHaveLength(1);
      expect(Number(rules[0].agent_id)).toBe(nova);

      const audits = await getDb().all(`SELECT * FROM routing_config_audit_log ORDER BY id ASC`);
      expect(audits[0]).toMatchObject({ actor: 'nordini', actor_kind: 'user' });
    });

    it('refuses to apply routing for a workflow with no team', async () => {
      const workflowId = await createWorkflow();
      expect((await post(`/api/v1/workflows/${workflowId}/team/apply-routing`, {})).status).toBe(409);
    });

    it('clears the assignment when team_id is null', async () => {
      const team = await (await post('/api/v1/teams', { name: 'Delivery Squad' })).json() as any;
      const workflowId = await createWorkflow();
      await put(`/api/v1/workflows/${workflowId}/team`, { team_id: team.id });
      await put(`/api/v1/workflows/${workflowId}/team`, { team_id: null });

      const workflow = await getDb().get(`SELECT team_id FROM sprints WHERE id = ?`, workflowId);
      expect(workflow?.team_id).toBeNull();
    });
  });
});
