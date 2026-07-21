import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import agentsRouter from './agents';

let tempDir: string;
let dbPath: string;

function resetDb(): void {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mcp-permissions-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');
  process.env.AGENT_HQ_DB_PATH = dbPath;

  const db = getDb();
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      system_role TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT
    );
  `);
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

describe('agent MCP permissions routes', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mcp-permissions-'));
    dbPath = path.join(tempDir, 'agent-hq-test.db');
    resetDb();

    const db = getDb();
    db.prepare(`
      INSERT INTO agents (id, name, system_role, enabled)
      VALUES (?, ?, NULL, 1), (?, ?, 'admin', 1)
    `).run(7, 'Cinder', 8, 'Atlas');
  });

  afterEach(() => {
    closeDb();
    delete process.env.AGENT_HQ_DB_PATH;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns the rollout-safe default snapshot for a normal agent', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents/7/mcp-permissions`);
      const body = await response.json() as {
        policy_mode: string;
        default_policy: string;
        capabilities: Array<{ key: string; enabled: boolean; explicit_enabled: boolean | null; description: string; endpoints: string[] }>;
      };

      expect(response.status).toBe(200);
      expect(body.policy_mode).toBe('default');
      expect(body.default_policy).toBe('scoped_runtime');
      expect(body.capabilities.find((capability) => capability.key === 'tasks.read_active_context')).toMatchObject({
        enabled: true,
        explicit_enabled: null,
        description: expect.stringContaining('relationship inspection'),
        endpoints: expect.arrayContaining([
          'GET /api/v1/tasks/:id/relationships',
          'GET /api/v1/tasks/:id/relationship-types',
        ]),
      });
      expect(body.capabilities.find((capability) => capability.key === 'tasks.read_project_context')).toMatchObject({
        group: 'Task lifecycle',
        label: 'Read project task context',
        enabled: false,
        explicit_enabled: null,
        description: expect.stringContaining('tasks in the agent\'s assigned project'),
        endpoints: expect.arrayContaining([
          'GET /api/v1/tasks/:id',
          'GET /api/v1/tasks/:id/context',
          'GET /api/v1/tasks/:id/notes',
          'GET /api/v1/tasks/:id/history',
          'GET /api/v1/tasks/:id/instances',
          'GET /api/v1/tasks/:id/relationships',
          'GET /api/v1/tasks/:id/relationship-types',
          'GET /api/v1/tasks/:id/active-owner',
        ]),
      });
      expect(body.capabilities.find((capability) => capability.key === 'tasks.search_project_tasks')).toMatchObject({
        group: 'Task lifecycle',
        label: 'Search project tasks',
        enabled: false,
        explicit_enabled: null,
        description: expect.stringContaining('bounded read-only task search'),
        endpoints: ['POST /api/v1/tasks/project-search'],
      });
      expect(body.capabilities.find((capability) => capability.key === 'tasks.create')).toMatchObject({
        group: 'Task lifecycle',
        label: 'Create Tasks',
        enabled: false,
        explicit_enabled: null,
      });
      expect(body.capabilities.find((capability) => capability.key === 'mcp_capability_policies.read')).toMatchObject({
        group: 'MCP capability policy',
        label: 'Read MCP capability policy',
        enabled: false,
        explicit_enabled: null,
        description: expect.stringContaining('assigned project'),
        endpoints: ['GET /api/v1/agents/:id/mcp-permissions'],
      });
      expect(body.capabilities.find((capability) => capability.key === 'mcp_capability_policies.write')).toMatchObject({
        group: 'MCP capability policy',
        label: 'Edit MCP capability policy',
        enabled: false,
        explicit_enabled: null,
        description: expect.stringContaining('Self-edits'),
        endpoints: expect.arrayContaining([
          'POST /api/v1/agents/:id/mcp-permissions',
          'PUT /api/v1/agents/:id/mcp-permissions',
          'DELETE /api/v1/agents/:id/mcp-permissions',
        ]),
      });
      expect(body.capabilities.find((capability) => capability.key === 'admin.full_access')).toMatchObject({
        enabled: false,
        explicit_enabled: null,
      });
      expect(body.capabilities.find((capability) => capability.key === 'admin.cross_tenant')).toMatchObject({
        enabled: false,
        explicit_enabled: null,
      });
    } finally {
      await stopTestServer(server);
    }
  });

  it('persists and resets explicit capability selections', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const createResponse = await fetch(`${baseUrl}/api/v1/agents/7/mcp-permissions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled_capabilities: ['discovery.read_catalog', 'admin.full_access'] }),
      });
      expect(createResponse.status).toBe(200);

      const updateResponse = await fetch(`${baseUrl}/api/v1/agents/7/mcp-permissions`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled_capabilities: ['discovery.read_catalog', 'admin.full_access', 'mcp_capability_policies.read'] }),
      });
      const updated = await updateResponse.json() as {
        policy_mode: string;
        capabilities: Array<{ key: string; enabled: boolean; explicit_enabled: boolean | null }>;
      };

      expect(updateResponse.status).toBe(200);
      expect(updated.policy_mode).toBe('explicit');
      expect(updated.capabilities.find((capability) => capability.key === 'admin.full_access')).toMatchObject({
        enabled: true,
        explicit_enabled: true,
      });
      expect(updated.capabilities.find((capability) => capability.key === 'tasks.create')).toMatchObject({
        enabled: false,
        explicit_enabled: false,
      });
      expect(updated.capabilities.find((capability) => capability.key === 'tasks.read_active_context')).toMatchObject({
        enabled: false,
        explicit_enabled: false,
      });
      expect(updated.capabilities.find((capability) => capability.key === 'tasks.read_project_context')).toMatchObject({
        enabled: false,
        explicit_enabled: false,
      });
      expect(updated.capabilities.find((capability) => capability.key === 'tasks.search_project_tasks')).toMatchObject({
        enabled: false,
        explicit_enabled: false,
      });
      expect(updated.capabilities.find((capability) => capability.key === 'mcp_capability_policies.read')).toMatchObject({
        enabled: true,
        explicit_enabled: true,
      });
      expect(updated.capabilities.find((capability) => capability.key === 'mcp_capability_policies.write')).toMatchObject({
        enabled: false,
        explicit_enabled: false,
      });

      const resetResponse = await fetch(`${baseUrl}/api/v1/agents/7/mcp-permissions`, {
        method: 'DELETE',
      });
      const reset = await resetResponse.json() as {
        policy_mode: string;
        default_policy: string;
        capabilities: Array<{ key: string; enabled: boolean; explicit_enabled: boolean | null }>;
      };

      expect(resetResponse.status).toBe(200);
      expect(reset.policy_mode).toBe('default');
      expect(reset.default_policy).toBe('scoped_runtime');
      expect(reset.capabilities.find((capability) => capability.key === 'admin.full_access')).toMatchObject({
        enabled: false,
        explicit_enabled: null,
      });
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects unknown capability keys', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents/7/mcp-permissions`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled_capabilities: ['nope.fake_capability'] }),
      });
      const body = await response.json() as { error?: string };

      expect(response.status).toBe(400);
      expect(body.error).toContain('Unknown Agent HQ MCP capability');
    } finally {
      await stopTestServer(server);
    }
  });

  it('preserves trusted-admin defaults for admin agents', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents/8/mcp-permissions`);
      const body = await response.json() as {
        default_policy: string;
        capabilities: Array<{ key: string; enabled: boolean }>;
      };

      expect(response.status).toBe(200);
      expect(body.default_policy).toBe('trusted_admin');
      expect(body.capabilities.find((capability) => capability.key === 'admin.full_access')).toMatchObject({
        enabled: true,
      });
      expect(body.capabilities.find((capability) => capability.key === 'tasks.create')).toMatchObject({
        enabled: true,
      });
      expect(body.capabilities.find((capability) => capability.key === 'tasks.read_project_context')).toMatchObject({
        enabled: true,
      });
      expect(body.capabilities.find((capability) => capability.key === 'tasks.search_project_tasks')).toMatchObject({
        enabled: true,
      });
      expect(body.capabilities.find((capability) => capability.key === 'mcp_capability_policies.read')).toMatchObject({
        enabled: true,
      });
      expect(body.capabilities.find((capability) => capability.key === 'mcp_capability_policies.write')).toMatchObject({
        enabled: true,
      });
      expect(body.capabilities.find((capability) => capability.key === 'admin.cross_tenant')).toMatchObject({
        enabled: false,
      });
    } finally {
      await stopTestServer(server);
    }
  });
});
