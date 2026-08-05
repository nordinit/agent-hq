import { setupTestDb, teardownTestDb } from '../db/testDb';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../db/client';
import agentsRouter from './agents';

let tempDir: string;
let dbPath: string;
const ORIGINAL_OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH;

async function resetDb(): Promise<void> {
  await setupTestDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-delete-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');
  process.env.OPENCLAW_CONFIG_PATH = path.join(tempDir, 'openclaw.json');

  const db = getDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Agent HQ')`);
  await db.run(`INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type) VALUES (1, 1, 1, 'Default Workflow', 'generic')`);
  await db.run(`INSERT INTO mcp_servers (id, tenant_id, name, slug, command) VALUES (30, 1, 'Agent HQ', 'agent-hq', 'node')`);
}

async function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/agents', agentsRouter);
  const server = await new Promise<Server>((resolve, reject) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
    bound.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('agents delete', () => {
  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-delete-'));
    dbPath = path.join(tempDir, 'agent-hq-test.db');
    await resetDb();
  });

  afterEach(async () => {
    await teardownTestDb();
    if (ORIGINAL_OPENCLAW_CONFIG_PATH === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
    else process.env.OPENCLAW_CONFIG_PATH = ORIGINAL_OPENCLAW_CONFIG_PATH;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('archives referenced agents instead of throwing a raw foreign-key error', async () => {
    const db = getDb();
    await db.run(`
      INSERT INTO agents (id, tenant_id, name, session_key, status, enabled)
      VALUES (98, 1, 'Repo Mode Smoke Agent', 'agent:repo-mode-smoke:main', 'idle', 0)
    `);
    await db.run(`INSERT INTO tasks (id, tenant_id, project_id, sprint_id, title, agent_id) VALUES (394, 1, 1, 1, 'Live clone mode smoke', 98)`);
    await db.run(`INSERT INTO job_instances (id, tenant_id, task_id, agent_id, status) VALUES (1849, 1, 394, 98, 'done')`);
    await db.run(`INSERT INTO dispatch_log (id, task_id, agent_id) VALUES (1, 394, 98)`);
    await db.run(`INSERT INTO sprint_task_routing_rules (id, tenant_id, project_id, sprint_id, task_type, status, agent_id) VALUES (1, 1, 1, 1, 'backend', 'ready', 98)`);
    await db.run(`INSERT INTO agent_mcp_assignments (id, agent_id, mcp_server_id) VALUES (1, 98, 30)`);
    fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify({
      mcp: {
        servers: {
          'agent-hq__agent-98': {
            command: 'node',
            args: ['server.js'],
            env: { AGENT_HQ_MCP_API_KEY: 'stale-archived-agent-key' },
            codex: { agents: ['repo-mode-smoke'] },
          },
          'dev-environment-lease-manager__agent-98': {
            command: 'lease-mcp',
            env: { AGENT_HQ_MCP_API_KEY: 'stale-archived-agent-key' },
            codex: { agents: ['repo-mode-smoke'] },
          },
          'agent-hq__agent-94': {
            command: 'node',
            args: ['server.js'],
            env: { AGENT_HQ_MCP_API_KEY: 'other-agent-key' },
            codex: { agents: ['cinder-backend'] },
          },
          operator: { command: 'node', args: ['operator.js'] },
        },
      },
    }), 'utf8');

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents/98`, { method: 'DELETE' });
      const body = await response.json() as {
        ok?: boolean;
        archived?: boolean;
        hard_deleted?: boolean;
        error?: string;
        dependency_counts?: Array<{ table: string; count: number }>;
      };

      if (response.status !== 200) {
        throw new Error(`Expected 200, received ${response.status}: ${JSON.stringify(body)}`);
      }
      expect(body.ok).toBe(true);
      expect(body.archived).toBe(true);
      expect(body.hard_deleted).toBe(false);
      expect(body.error).toBeUndefined();
      expect(body.dependency_counts?.some((entry) => entry.table === 'job_instances' && entry.count === 1)).toBe(true);

      const agent = await db.get(`SELECT id, enabled, deleted_at, session_key FROM agents WHERE id = 98`) as {
        id: number;
        enabled: number;
        deleted_at: string | null;
        session_key: string;
      };
      expect(agent.id).toBe(98);
      expect(agent.enabled).toBe(0);
      expect(agent.deleted_at).toBeTruthy();
      expect(agent.session_key).toMatch(/^deleted:98:/);

      const task = await db.get(`SELECT agent_id FROM tasks WHERE id = 394`) as { agent_id: number };
      const instance = await db.get(`SELECT agent_id FROM job_instances WHERE id = 1849`) as { agent_id: number };
      const routing = await db.get(`SELECT COUNT(*) AS n FROM sprint_task_routing_rules WHERE agent_id = 98`) as { n: number };
      const mcpAssignments = await db.get(`SELECT COUNT(*) AS n FROM agent_mcp_assignments WHERE agent_id = 98`) as { n: number };
      const openClawConfig = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH!, 'utf8'));
      expect(task.agent_id).toBe(98);
      expect(instance.agent_id).toBe(98);
      expect(routing.n).toBe(0);
      expect(mcpAssignments.n).toBe(0);
      expect(openClawConfig.mcp.servers['agent-hq__agent-98']).toBeUndefined();
      expect(openClawConfig.mcp.servers['dev-environment-lease-manager__agent-98']).toBeUndefined();
      expect(openClawConfig.mcp.servers['agent-hq__agent-94']).toBeDefined();
      expect(openClawConfig.mcp.servers.operator).toBeDefined();

      const listResponse = await fetch(`${baseUrl}/api/v1/agents`);
      const listBody = await listResponse.json() as Array<{ id: number }>;
      expect(listBody.some((entry) => entry.id === 98)).toBe(false);
    } finally {
      await stopTestServer(server);
    }
  });

  it('hard-deletes agents with no historical references', async () => {
    const db = getDb();
    await db.run(`
      INSERT INTO agents (id, tenant_id, name, session_key, status, enabled)
      VALUES (99, 1, 'Disposable Agent', 'agent:disposable:main', 'idle', 1)
    `);
    await db.run(`INSERT INTO agent_mcp_assignments (id, agent_id, mcp_server_id) VALUES (1, 99, 30)`);
    fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify({
      mcp: {
        servers: {
          'agent-hq__agent-99': {
            command: 'node',
            args: ['server.js'],
            env: { AGENT_HQ_MCP_API_KEY: 'stale-hard-delete-key' },
            codex: { agents: ['disposable'] },
          },
          'agent-hq__agent-94': {
            command: 'node',
            args: ['server.js'],
            env: { AGENT_HQ_MCP_API_KEY: 'other-agent-key' },
            codex: { agents: ['cinder-backend'] },
          },
        },
      },
    }), 'utf8');

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents/99`, { method: 'DELETE' });
      const body = await response.json() as { ok?: boolean; archived?: boolean; hard_deleted?: boolean; error?: string };

      if (response.status !== 200) {
        throw new Error(`Expected 200, received ${response.status}: ${JSON.stringify(body)}`);
      }
      expect(body.ok).toBe(true);
      expect(body.archived).toBe(false);
      expect(body.hard_deleted).toBe(true);
      expect(body.error).toBeUndefined();

      const row = await db.get(`SELECT id FROM agents WHERE id = 99`);
      expect(row).toBeUndefined();
      const openClawConfig = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH!, 'utf8'));
      expect(openClawConfig.mcp.servers['agent-hq__agent-99']).toBeUndefined();
      expect(openClawConfig.mcp.servers['agent-hq__agent-94']).toBeDefined();
    } finally {
      await stopTestServer(server);
    }
  });
});
