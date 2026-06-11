import express from 'express';
import type { Server } from 'http';
import toolsRouter from './tools';
import { closeDb, getDb } from '../db/client';

function resetDb(): void {
  closeDb();
  getDb().exec(`
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      openclaw_agent_id TEXT
    );

    CREATE TABLE tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      implementation_type TEXT NOT NULL,
      implementation_body TEXT NOT NULL DEFAULT '',
      input_schema TEXT NOT NULL DEFAULT '{}',
      permissions TEXT NOT NULL DEFAULT 'read_only',
      tags TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE agent_tool_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      tool_id INTEGER NOT NULL,
      overrides TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(agent_id, tool_id)
    );
  `);
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
  beforeEach(resetDb);
  afterEach(closeDb);

  it('returns materialized assigned tools with real JSON fields by openclaw_agent_id', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO agents (id, name, openclaw_agent_id) VALUES (1, 'Atlas', 'atlas')`).run();
    db.prepare(`
      INSERT INTO tools (id, name, slug, description, implementation_type, implementation_body, input_schema, permissions, tags, enabled)
      VALUES (10, 'Deploy', 'deploy_dev_worktree', 'Deploy tool', 'shell', ?, ?, 'exec', ?, 1)
    `).run(
      JSON.stringify({ command: 'echo "$repo_path"', timeoutMs: 1000 }),
      JSON.stringify({ type: 'object', properties: { repo_path: { type: 'string' } }, required: ['repo_path'] }),
      JSON.stringify(['deployment']),
    );
    db.prepare(`INSERT INTO agent_tool_assignments (id, agent_id, tool_id, enabled) VALUES (20, 1, 10, 1)`).run();

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
    getDb().prepare(`INSERT INTO agents (id, name, openclaw_agent_id) VALUES (1, 'Atlas', 'atlas')`).run();

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
