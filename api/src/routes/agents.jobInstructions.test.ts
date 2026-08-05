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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-job-instructions-'));
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

describe('agents job_instructions canonical paths', () => {
  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-job-instructions-'));
    dbPath = path.join(tempDir, 'agent-hq-test.db');
    await resetDb();
  });

  afterEach(async () => {
    await teardownTestDb();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates agents with canonical job_instructions when the legacy pre_instructions column is absent', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Created Agent',
          role: 'Backend Engineer',
          session_key: 'agent:created:main',
          runtime_type: 'webhook',
          provision_openclaw: false,
          job_title: 'Created Agent',
          job_instructions: 'Created canonical instructions',
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(201);
      expect(body.job_instructions).toBe('Created canonical instructions');
      expect(body).not.toHaveProperty('pre_instructions');

      const db = getDb();
      const row = await db.get(`SELECT job_instructions FROM agents WHERE session_key = 'agent:created:main'`) as { job_instructions: string };
      expect(row.job_instructions).toBe('Created canonical instructions');
    } finally {
      await stopTestServer(server);
    }
  });

  it('creates agents without requiring or exposing legacy job_title lane metadata', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'No Legacy Label Agent',
          role: 'Backend Engineer',
          session_key: 'agent:no-lane:main',
          runtime_type: 'webhook',
          provision_openclaw: false,
          job_instructions: 'Created without lane metadata',
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(201);
      expect(body).not.toHaveProperty('job_title');
      expect(body.job_instructions).toBe('Created without lane metadata');

      const db = getDb();
      const row = await db.get(`SELECT job_title FROM agents WHERE session_key = 'agent:no-lane:main'`) as { job_title: string };
      expect(row.job_title).toBe('');
    } finally {
      await stopTestServer(server);
    }
  });

  it('ignores legacy job_title on create and update while keeping old stored labels internal', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const createResponse = await fetch(`${baseUrl}/api/v1/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Legacy Label Payload Agent',
          role: 'Backend Engineer',
          session_key: 'agent:legacy-lane-payload:main',
          runtime_type: 'webhook',
          provision_openclaw: false,
          job_title: 'Deprecated Label Payload',
        }),
      });
      const createBody = await createResponse.json() as Record<string, unknown>;

      expect(createResponse.status).toBe(201);
      expect(createBody).not.toHaveProperty('job_title');

      const db = getDb();
      const created = await db.get(`SELECT id, job_title FROM agents WHERE session_key = 'agent:legacy-lane-payload:main'`) as { id: number; job_title: string };
      expect(created.job_title).toBe('');

      await db.run(`UPDATE agents SET job_title = 'Historical Label' WHERE id = ?`, created.id);

      const updateResponse = await fetch(`${baseUrl}/api/v1/agents/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_title: 'Updated Deprecated Label Payload', role: 'Backend Engineer' }),
      });
      const updateBody = await updateResponse.json() as Record<string, unknown>;

      expect(updateResponse.status).toBe(200);
      expect(updateBody).not.toHaveProperty('job_title');

      const updated = await db.get(`SELECT job_title FROM agents WHERE id = ?`, created.id) as { job_title: string };
      expect(updated.job_title).toBe('Historical Label');
    } finally {
      await stopTestServer(server);
    }
  });

  it('ignores legacy schedule payloads on create and update', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const createResponse = await fetch(`${baseUrl}/api/v1/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Legacy Schedule Payload Agent',
          role: 'Backend Engineer',
          session_key: 'agent:legacy-schedule-payload:main',
          runtime_type: 'webhook',
          provision_openclaw: false,
          schedule: '0 9 * * 1-5',
        }),
      });
      const createBody = await createResponse.json() as Record<string, unknown>;

      expect(createResponse.status).toBe(201);
      expect(createBody.schedule).toBe('');

      const db = getDb();
      const created = await db.get(`SELECT id, schedule FROM agents WHERE session_key = 'agent:legacy-schedule-payload:main'`) as { id: number; schedule: string };
      expect(created.schedule).toBe('');

      await db.run(`UPDATE agents SET schedule = '*/5 * * * *' WHERE id = ?`, created.id);

      const updateResponse = await fetch(`${baseUrl}/api/v1/agents/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'Backend Engineer', schedule: '0 10 * * 1' }),
      });
      const updateBody = await updateResponse.json() as Record<string, unknown>;

      expect(updateResponse.status).toBe(200);
      expect(updateBody.schedule).toBe('');

      const updated = await db.get(`SELECT schedule FROM agents WHERE id = ?`, created.id) as { schedule: string };
      expect(updated.schedule).toBe('');
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects pre_instructions on create and tells callers to use job_instructions', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Legacy Alias Create Agent',
          role: 'Backend Engineer',
          session_key: 'agent:legacy-create:main',
          runtime_type: 'webhook',
          provision_openclaw: false,
          job_title: 'Legacy Alias Create Agent',
          pre_instructions: 'Legacy alias create instructions',
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(body.error).toBe('pre_instructions has been renamed to job_instructions');
      expect(body.field).toBe('job_instructions');

      const db = getDb();
      const row = await db.get(`SELECT COUNT(*) AS count FROM agents WHERE session_key = 'agent:legacy-create:main'`) as { count: number };
      expect(row.count).toBe(0);
    } finally {
      await stopTestServer(server);
    }
  });

  it('updates canonical job_instructions when the legacy pre_instructions column is absent', async () => {
    const db = getDb();
    await db.run(`
      INSERT INTO agents (id, tenant_id, name, role, session_key, runtime_type, preferred_provider, job_title, job_instructions)
      VALUES (41, 1, 'Cinder', 'Backend Engineer', 'agent:cinder:main', 'webhook', 'openai', 'Backend Engineer', 'Initial instructions')
    `);

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents/41`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_instructions: 'Updated canonical instructions' }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.job_instructions).toBe('Updated canonical instructions');
      expect(body).not.toHaveProperty('pre_instructions');

      const row = await db.get(`
        SELECT job_instructions, job_instructions_updated_at, instructions_version
        FROM agents
        WHERE id = 41
      `) as {
        job_instructions: string;
        job_instructions_updated_at: string | null;
        instructions_version: number;
      };
      expect(row.job_instructions).toBe('Updated canonical instructions');
      expect(row.job_instructions_updated_at).toBeTruthy();
      expect(row.instructions_version).toBe(1);
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects pre_instructions on update and preserves the canonical stored value', async () => {
    const db = getDb();
    await db.run(`
      INSERT INTO agents (id, tenant_id, name, role, session_key, runtime_type, preferred_provider, job_title, job_instructions)
      VALUES (42, 1, 'Cinder', 'Backend Engineer', 'agent:cinder:main-2', 'webhook', 'openai', 'Backend Engineer', 'Initial instructions')
    `);

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents/42`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pre_instructions: 'Legacy alias instructions' }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(body.error).toBe('pre_instructions has been renamed to job_instructions');
      expect(body.field).toBe('job_instructions');

      const row = await db.get(`SELECT job_instructions FROM agents WHERE id = 42`) as { job_instructions: string };
      expect(row.job_instructions).toBe('Initial instructions');
    } finally {
      await stopTestServer(server);
    }
  });
});
