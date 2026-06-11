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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-remote-gateway-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');
  process.env.AGENT_HQ_DB_PATH = dbPath;

  const db = getDb();
  db.exec(`
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      session_key TEXT NOT NULL UNIQUE,
      workspace_path TEXT NOT NULL DEFAULT '',
      repo_path TEXT,
      repo_url TEXT,
      repo_access_mode TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      openclaw_agent_id TEXT,
      model TEXT,
      runtime_type TEXT NOT NULL DEFAULT 'webhook',
      runtime_config TEXT,
      hooks_url TEXT,
      hooks_auth_header TEXT,
      preferred_provider TEXT,
      os_user TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      github_identity_id INTEGER,
      job_title TEXT NOT NULL DEFAULT '',
      schedule TEXT NOT NULL DEFAULT '',
      job_instructions TEXT NOT NULL DEFAULT '',
      skill_names TEXT NOT NULL DEFAULT '[]',
      timeout_seconds INTEGER NOT NULL DEFAULT 900,
      startup_grace_seconds INTEGER,
      heartbeat_stale_seconds INTEGER,
      stall_threshold_min INTEGER NOT NULL DEFAULT 30,
      max_retries INTEGER NOT NULL DEFAULT 3,
      sort_rules TEXT NOT NULL DEFAULT '[]',
      project_id INTEGER,
      system_role TEXT,
      last_active TEXT,
      job_instructions_updated_at TEXT,
      instructions_version INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE provider_config (
      slug TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
  `);

  db.prepare(`INSERT INTO provider_config (slug, status) VALUES (?, ?)`)
    .run('openai', 'connected');
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
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-remote-gateway-'));
    dbPath = path.join(tempDir, 'agent-hq-test.db');
    resetDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.AGENT_HQ_DB_PATH;
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
      const row = db.prepare(`SELECT hooks_url, hooks_auth_header FROM agents WHERE session_key = ?`)
        .get('agent:remote-gateway:main') as { hooks_url: string | null; hooks_auth_header: string | null };
      expect(row.hooks_url).toBe('http://localhost:3711');
      expect(row.hooks_auth_header).toBe('Bearer remote-token');
    } finally {
      await stopTestServer(server);
    }
  });

  it('updates existing Remote Gateway values without breaking stored agent records', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO agents (id, name, role, session_key, runtime_type, hooks_url, hooks_auth_header, preferred_provider)
      VALUES (1, 'Existing Gateway Agent', 'Backend Engineer', 'agent:existing-gateway:main', 'webhook', 'http://localhost:3711', 'Bearer old-token', 'openai')
    `).run();

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

      const row = db.prepare(`SELECT hooks_url, hooks_auth_header FROM agents WHERE id = 1`)
        .get() as { hooks_url: string | null; hooks_auth_header: string | null };
      expect(row.hooks_url).toBe('http://localhost:3712');
      expect(row.hooks_auth_header).toBe('Bearer new-token');
    } finally {
      await stopTestServer(server);
    }
  });
});
