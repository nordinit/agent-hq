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

async function resetDb(): Promise<void> {
  await setupTestDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-remote-gateway-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');

  const db = getDb();


  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
  await db.run(`INSERT INTO provider_config (tenant_id, slug, status) VALUES (1, ?, ?)`, 'openai', 'connected');
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

describe('agents Remote Gateway compatibility fields', () => {
  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-remote-gateway-'));
    dbPath = path.join(tempDir, 'agent-hq-test.db');
    await resetDb();
  });

  afterEach(async () => {
    await teardownTestDb();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates and returns Remote Gateway values through compatibility columns', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Remote Gateway Agent',
          role: 'Backend Engineer',
          session_key: 'agent:remote-gateway:main',
          runtime_type: 'webhook',
          provision_openclaw: false,
          hooks_url: 'http://localhost:3711',
          hooks_auth_header: 'Bearer remote-token',
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(201);
      expect(body.hooks_url).toBe('http://localhost:3711');
      expect(body.hooks_auth_header).toBe('Bearer remote-token');

      const db = getDb();
      const row = await db.get(`SELECT hooks_url, hooks_auth_header FROM agents WHERE session_key = ?`, 'agent:remote-gateway:main') as { hooks_url: string | null; hooks_auth_header: string | null };
      expect(row.hooks_url).toBe('http://localhost:3711');
      expect(row.hooks_auth_header).toBe('Bearer remote-token');
    } finally {
      await stopTestServer(server);
    }
  });

  it('updates existing Remote Gateway values without breaking stored agent records', async () => {
    const db = getDb();
    await db.run(`
      INSERT INTO agents (id, tenant_id, name, role, session_key, runtime_type, hooks_url, hooks_auth_header, preferred_provider)
      VALUES (1, 1, 'Existing Gateway Agent', 'Backend Engineer', 'agent:existing-gateway:main', 'webhook', 'http://localhost:3711', 'Bearer old-token', 'openai')
    `);

    const { server, baseUrl } = await startTestServer();
    try {
      const loadResponse = await fetch(`${baseUrl}/api/v1/agents/1`);
      const loaded = await loadResponse.json() as Record<string, unknown>;

      expect(loadResponse.status).toBe(200);
      expect(loaded.hooks_url).toBe('http://localhost:3711');
      expect(loaded.hooks_auth_header).toBe('Bearer old-token');

      const response = await fetch(`${baseUrl}/api/v1/agents/1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hooks_url: 'http://localhost:3712',
          hooks_auth_header: 'Bearer new-token',
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.hooks_url).toBe('http://localhost:3712');
      expect(body.hooks_auth_header).toBe('Bearer new-token');

      const row = await db.get(`SELECT hooks_url, hooks_auth_header FROM agents WHERE id = 1`) as { hooks_url: string | null; hooks_auth_header: string | null };
      expect(row.hooks_url).toBe('http://localhost:3712');
      expect(row.hooks_auth_header).toBe('Bearer new-token');
    } finally {
      await stopTestServer(server);
    }
  });
});
