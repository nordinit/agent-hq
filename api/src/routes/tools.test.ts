import express from 'express';
import type { Server } from 'http';
import toolsRouter from './tools';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';

async function seedFixture(): Promise<void> {
  const db = await setupTestDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Agent HQ', 'agent-hq', 1)`);
  await db.run(`
    INSERT INTO app_settings (key, value)
    VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')
  `);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (86, 1, 'Agent HQ')`);
}

function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/tools', toolsRouter);

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

describe('OpenClaw materialized tools route', () => {
  beforeEach(seedFixture);
  afterEach(teardownTestDb);

  it('returns materialized assigned tools with real JSON fields by openclaw_agent_id', async () => {
    const db = getDb();
    await db.run(`
      INSERT INTO agents (id, tenant_id, project_id, name, role, session_key, openclaw_agent_id)
      VALUES (1, 1, 86, 'Atlas', 'Project manager', 'agent:atlas:test', 'atlas')
    `);
    await db.run(`
      INSERT INTO tools (id, tenant_id, name, slug, description, implementation_type, implementation_body, input_schema, permissions, tags, enabled)
      VALUES (10, 1, 'Deploy', 'deploy_dev_worktree', 'Deploy tool', 'shell', ?, ?, 'exec', ?, 1)
    `, JSON.stringify({ command: 'echo "$repo_path"', timeoutMs: 1000 }), JSON.stringify({ type: 'object', properties: { repo_path: { type: 'string' } }, required: ['repo_path'] }), JSON.stringify(['deployment']));
    await db.run(`INSERT INTO agent_tool_assignments (id, agent_id, tool_id, enabled) VALUES (20, 1, 10, 1)`);

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/tools/materialized/agents/atlas`);
      expect(response.status).toBe(200);
      const body = await response.json() as { agent: unknown; tools: unknown[] };

      expect(body.agent).toEqual({ id: 1, openclaw_agent_id: 'atlas' });
      expect(body.tools).toEqual([
        expect.objectContaining({
          tool_id: 10,
          assignment_id: 20,
          slug: 'deploy_dev_worktree',
          input_schema: { type: 'object', properties: { repo_path: { type: 'string' } }, required: ['repo_path'] },
          tags: ['deployment'],
          permissions: 'exec',
          enabled: true,
          assignment_enabled: true,
          execution_type: 'shell',
          execution_payload: {
            type: 'shell',
            command: 'echo "$repo_path"',
            timeoutMs: 1000,
          },
        }),
      ]);
    } finally {
      await stopTestServer(server);
    }
  });

  it('returns an empty tools array for a mapped OpenClaw agent with no assignments', async () => {
    await getDb().run(`
      INSERT INTO agents (id, tenant_id, project_id, name, role, session_key, openclaw_agent_id)
      VALUES (1, 1, 86, 'Atlas', 'Project manager', 'agent:atlas:test', 'atlas')
    `);

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/tools/materialized/agents/atlas`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        agent: { id: 1, openclaw_agent_id: 'atlas' },
        tools: [],
      });
    } finally {
      await stopTestServer(server);
    }
  });
});
