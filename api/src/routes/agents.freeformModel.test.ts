import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import agentsRouter from './agents';

let tempDir: string;

function resetDb(): void {
  closeDb();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-freeform-model-'));
  process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
  process.env.AGENT_HQ_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH = '1';

  const db = getDb();
  db.exec(`
    CREATE TABLE tenants (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER DEFAULT 1,
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
      provider_connection_id INTEGER,
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
      deleted_at TEXT,
      job_instructions_updated_at TEXT,
      instructions_version INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE provider_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER DEFAULT 1,
      slug TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `);

  db.prepare(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`).run();
  db.prepare(`INSERT INTO app_settings (key, value) VALUES ('active_tenant_id', '1')`).run();
  db.prepare(`INSERT INTO provider_config (tenant_id, slug, status) VALUES (1, 'openai-codex', 'connected')`).run();
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

describe('agents free-form model validation', () => {
  beforeEach(resetDb);

  afterEach(() => {
    closeDb();
    delete process.env.AGENT_HQ_DB_PATH;
    delete process.env.AGENT_HQ_DISABLE_OPENCLAW_PLUGIN_REGISTRY_REFRESH;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates and updates an agent with a custom model outside the static catalog', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const create = await fetch(`${baseUrl}/api/v1/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Atlas Custom',
          role: 'Backend Engineer',
          session_key: 'agent:atlas-custom:main',
          runtime_type: 'webhook',
          preferred_provider: 'openai-codex',
          model: '  openai-codex/gpt-5.4  ',
        }),
      });
      const created = await create.json() as Record<string, any>;

      expect(create.status).toBe(201);
      expect(created.model).toBe('openai-codex/gpt-5.4');

      const update = await fetch(`${baseUrl}/api/v1/agents/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: created.name,
          role: created.role,
          session_key: created.session_key,
          workspace_path: created.workspace_path,
          status: created.status,
          runtime_type: created.runtime_type,
          preferred_provider: 'openai-codex',
          model: 'openai-codex/gpt-5.4-preview',
        }),
      });
      const updated = await update.json() as Record<string, any>;

      expect(update.status).toBe(200);
      expect(updated.model).toBe('openai-codex/gpt-5.4-preview');
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects empty, non-string, and unsafe-length model payloads', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      for (const model of ['   ', 42, 'x'.repeat(201)]) {
        const response = await fetch(`${baseUrl}/api/v1/agents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: `Invalid ${String(model).length}`,
            role: 'Backend Engineer',
            session_key: `agent:invalid-${String(model).length}:main`,
            runtime_type: 'webhook',
            preferred_provider: 'openai-codex',
            model,
          }),
        });
        const body = await response.json() as Record<string, unknown>;

        expect(response.status).toBe(400);
        expect(String(body.error)).toMatch(/model must/);
      }
    } finally {
      await stopTestServer(server);
    }
  });
});
