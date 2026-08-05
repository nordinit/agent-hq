import express from 'express';
import type { Server } from 'http';
import toolsRouter, { agentToolsRouter } from './tools';
import skillsRouter from './skills';
import agentsRouter from './agents';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { fetchAgentTools } from '../runtimes/toolInjection';

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

async function setActiveTenant(tenantId: number): Promise<void> {
  await getDb().run(`UPDATE app_settings SET value = ? WHERE key = 'active_tenant_id'`, String(tenantId));
}

function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/tools', toolsRouter);
  app.use('/api/v1/agents/:agentId/tools', agentToolsRouter);
  app.use('/api/v1/agents', agentsRouter);
  app.use('/api/v1/skills', skillsRouter);
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

describe('tenant-owned skills and tools capability inventory', () => {
  beforeEach(resetDb);
  afterEach(teardownTestDb);

  it('allows duplicate tool slugs across tenants while preserving per-tenant uniqueness', async () => {
    const db = getDb();
    await db.run(`INSERT INTO tools (tenant_id, name, slug, implementation_type, implementation_body) VALUES (1, 'A Search', 'repo_search', 'bash', 'echo a')`);
    await expect(db.run(`INSERT INTO tools (tenant_id, name, slug, implementation_type, implementation_body) VALUES (2, 'B Search', 'repo_search', 'bash', 'echo b')`)).resolves.toBeDefined();
    await expect(
      db.run(`INSERT INTO tools (tenant_id, name, slug, implementation_type, implementation_body) VALUES (1, 'A Duplicate', 'repo_search', 'bash', 'echo dup')`)
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('does not materialize stale cross-tenant tool assignments', async () => {
    const db = getDb();
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, openclaw_agent_id) VALUES (10, 1, 'Agent A', 'agent:agent-a:main', 'agent-a')`);
    await db.run(`INSERT INTO tools (id, tenant_id, name, slug, implementation_type, implementation_body) VALUES (20, 1, 'Tenant A Tool', 'tenant_tool', 'bash', 'echo a')`);
    await db.run(`INSERT INTO tools (id, tenant_id, name, slug, implementation_type, implementation_body) VALUES (21, 2, 'Tenant B Tool', 'tenant_tool', 'bash', 'echo b')`);
    await db.run(`INSERT INTO agent_tool_assignments (agent_id, tool_id) VALUES (10, 20)`);
    await db.run(`INSERT INTO agent_tool_assignments (agent_id, tool_id) VALUES (10, 21)`);

    const materialized = await fetchAgentTools(db, 10);
    expect(materialized.map((tool) => tool.id)).toEqual([20]);
    expect(materialized[0]).toMatchObject({ tenant_id: 1, agent_tenant_id: 1, slug: 'tenant_tool' });
  });

  it('keeps tool list/read/assign/materialized behavior scoped to the active tenant', async () => {
    const db = getDb();
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, openclaw_agent_id) VALUES (10, 1, 'Agent A', 'agent:agent-a:main', 'agent-a')`);
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, openclaw_agent_id) VALUES (11, 2, 'Agent B', 'agent:agent-b:main', 'agent-b')`);

    const { server, baseUrl } = await startTestServer();
    try {
      await setActiveTenant(1);
      const createA = await fetch(`${baseUrl}/api/v1/tools`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Tenant A Shared Slug', slug: 'shared_slug', implementation_type: 'bash', implementation_body: 'echo a' }),
      });
      expect(createA.status).toBe(201);
      const toolA = await createA.json() as { id: number; tenant_id: number; slug: string };
      expect(toolA).toMatchObject({ tenant_id: 1, slug: 'shared_slug' });

      await setActiveTenant(2);
      const createB = await fetch(`${baseUrl}/api/v1/tools`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Tenant B Shared Slug', slug: 'shared_slug', implementation_type: 'bash', implementation_body: 'echo b' }),
      });
      expect(createB.status).toBe(201);
      const toolB = await createB.json() as { id: number; tenant_id: number; slug: string };
      expect(toolB).toMatchObject({ tenant_id: 2, slug: 'shared_slug' });

      const readTenantAFromTenantB = await fetch(`${baseUrl}/api/v1/tools/${toolA.id}`);
      expect(readTenantAFromTenantB.status).toBe(404);

      const assignTenantBToolToTenantB = await fetch(`${baseUrl}/api/v1/agents/11/tools`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool_id: toolB.id }),
      });
      expect(assignTenantBToolToTenantB.status).toBe(201);

      await setActiveTenant(1);
      const assignTenantBToolToTenantA = await fetch(`${baseUrl}/api/v1/agents/10/tools`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool_id: toolB.id }),
      });
      expect(assignTenantBToolToTenantA.status).toBe(404);

      const assignTenantATool = await fetch(`${baseUrl}/api/v1/agents/10/tools`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool_id: toolA.id }),
      });
      expect(assignTenantATool.status).toBe(201);

      const materializedA = await fetch(`${baseUrl}/api/v1/agents/10/tools/materialized`);
      expect(materializedA.status).toBe(200);
      const materializedABody = await materializedA.json() as { tools: Array<{ name: string }> };
      expect(materializedABody.tools.map((tool) => tool.name)).toEqual(['Tenant A Shared Slug']);

      await setActiveTenant(2);
      const listB = await fetch(`${baseUrl}/api/v1/tools`);
      expect(listB.status).toBe(200);
      const listBBody = await listB.json() as Array<{ id: number; tenant_id: number }>;
      expect(listBBody.some((tool) => tool.id === toolA.id)).toBe(false);
      expect(listBBody.some((tool) => tool.id === toolB.id && tool.tenant_id === 2)).toBe(true);
    } finally {
      await stopTestServer(server);
    }
  });

  it('lists and reads only skills for the active tenant', async () => {
    const db = getDb();
    await db.run(`INSERT INTO skills (tenant_id, name, description, content) VALUES (1, 'shared-name', 'Tenant A skill', '# A')`);
    await db.run(`INSERT INTO skills (tenant_id, name, description, content) VALUES (2, 'shared-name', 'Tenant B skill', '# B')`);
    await db.run(`INSERT INTO skills (tenant_id, name, description, content) VALUES (2, 'tenant-b-only', 'Tenant B only', '# B only')`);

    const { server, baseUrl } = await startTestServer();
    try {
      await setActiveTenant(1);
      const listA = await fetch(`${baseUrl}/api/v1/skills`);
      expect(listA.status).toBe(200);
      await expect(listA.json()).resolves.toEqual([
        expect.objectContaining({ tenant_id: 1, name: 'shared-name', description: 'Tenant A skill' }),
      ]);
      const readA = await fetch(`${baseUrl}/api/v1/skills/shared-name`);
      expect(readA.status).toBe(200);
      await expect(readA.json()).resolves.toMatchObject({ tenant_id: 1, name: 'shared-name', content: '# A' });

      await setActiveTenant(2);
      const listB = await fetch(`${baseUrl}/api/v1/skills`);
      expect(listB.status).toBe(200);
      const listBBody = await listB.json() as Array<{ tenant_id: number; name: string }>;
      expect(listBBody.map((skill) => `${skill.tenant_id}:${skill.name}`)).toEqual(['2:shared-name', '2:tenant-b-only']);
      const readB = await fetch(`${baseUrl}/api/v1/skills/shared-name`);
      expect(readB.status).toBe(200);
      await expect(readB.json()).resolves.toMatchObject({ tenant_id: 2, name: 'shared-name', content: '# B' });
    } finally {
      await stopTestServer(server);
    }
  });

  it('keeps tenant-local create/read/delete behavior for skills with reused names', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      await setActiveTenant(1);
      const createA = await fetch(`${baseUrl}/api/v1/skills`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'reusable', description: 'A', content: '# A' }),
      });
      expect(createA.status).toBe(201);

      await setActiveTenant(2);
      const createB = await fetch(`${baseUrl}/api/v1/skills`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'reusable', description: 'B', content: '# B' }),
      });
      expect(createB.status).toBe(201);
      await expect(createB.json()).resolves.toMatchObject({ tenant_id: 2, name: 'reusable', content: '# B' });

      const deleteB = await fetch(`${baseUrl}/api/v1/skills/reusable`, { method: 'DELETE' });
      expect(deleteB.status).toBe(200);

      await setActiveTenant(1);
      const readA = await fetch(`${baseUrl}/api/v1/skills/reusable`);
      expect(readA.status).toBe(200);
      await expect(readA.json()).resolves.toMatchObject({ tenant_id: 1, name: 'reusable', content: '# A' });
    } finally {
      await stopTestServer(server);
    }
  });

  it('keeps agent skill assignment scoped to tenant-local skill records', async () => {
    const db = getDb();
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, skill_names, openclaw_agent_id) VALUES (10, 1, 'Agent A', 'agent:agent-a:main', '[]', 'agent-a')`);
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, skill_names, openclaw_agent_id) VALUES (11, 2, 'Agent B', 'agent:agent-b:main', '[]', 'agent-b')`);
    await db.run(`INSERT INTO skills (id, tenant_id, name, description, content) VALUES (100, 1, 'shared-name', 'Tenant A skill', '# A')`);
    await db.run(`INSERT INTO skills (id, tenant_id, name, description, content) VALUES (200, 2, 'shared-name', 'Tenant B skill', '# B')`);
    await db.run(`INSERT INTO skills (id, tenant_id, name, description, content) VALUES (201, 2, 'tenant-b-only', 'Tenant B only', '# B only')`);

    const { server, baseUrl } = await startTestServer();
    try {
      await setActiveTenant(1);
      const assignTenantBOnlyById = await fetch(`${baseUrl}/api/v1/agents/10/skills`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skill_id: 201 }),
      });
      expect(assignTenantBOnlyById.status).toBe(404);

      const assignTenantAShared = await fetch(`${baseUrl}/api/v1/agents/10/skills`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skill_id: 100 }),
      });
      expect(assignTenantAShared.status).toBe(201);
      await expect(assignTenantAShared.json()).resolves.toMatchObject({
        agent_id: 10,
        skill: { id: 100, name: 'shared-name' },
      });

      const listA = await fetch(`${baseUrl}/api/v1/agents/10/skills`);
      expect(listA.status).toBe(200);
      await expect(listA.json()).resolves.toMatchObject({
        agent_id: 10,
        skills: [{ id: 100, name: 'shared-name' }],
        skill_names: ['shared-name'],
      });

      await setActiveTenant(2);
      const assignTenantBShared = await fetch(`${baseUrl}/api/v1/agents/11/skills`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skill_id: 200 }),
      });
      expect(assignTenantBShared.status).toBe(201);
      await expect(assignTenantBShared.json()).resolves.toMatchObject({
        agent_id: 11,
        skill: { id: 200, name: 'shared-name' },
      });
    } finally {
      await stopTestServer(server);
    }
  });
});
