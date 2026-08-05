import { setupTestDb, teardownTestDb } from '../db/testDb';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import modelRoutingRouter from './model-routing';
import { getDb } from '../db/client';
import { ensureTenantSchema } from '../lib/tenantContext';

let tempDir: string;
let dbPath: string;

async function resetDb(): Promise<void> {
  await setupTestDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-routing-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');

  const db = getDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
  await db.run(`
    INSERT INTO provider_config (tenant_id, slug, display_name, status)
    VALUES
      (1, 'anthropic', 'Anthropic', 'connected'),
      (1, 'openai', 'OpenAI', 'connected'),
      (1, 'openai-codex', 'OpenAI Codex (OAuth)', 'connected'),
      (1, 'minimax', 'MiniMax', 'connected')
  `);
  await db.run(`
    INSERT INTO projects (id, tenant_id, name)
    VALUES (1, 1, 'Agent HQ'), (2, 1, 'Other')
  `);
  await db.run(`
    INSERT INTO sprint_types (tenant_id, key, name)
    VALUES (1, 'dev', 'Development'), (1, 'generic', 'Generic')
  `);
  await db.run(`
    INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type)
    VALUES
      (10, 1, 1, 'Enhancements', 'dev'),
      (11, 1, 1, 'Bugs', 'dev'),
      (20, 1, 2, 'Other Sprint', 'generic')
  `);
}

async function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/model-routing', modelRoutingRouter);
  const server = await new Promise<Server>((resolve) => {
    const bound = app.listen(0, () => resolve(bound));
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind test server');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('model-routing aliases', () => {
  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-routing-'));
    dbPath = path.join(tempDir, 'agent-hq-test.db');
    await resetDb();
  });

  afterEach(async () => {
    await teardownTestDb();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('accepts max_story_points alias on create and returns canonical story point fields', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/model-routing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, min_story_points: 1, max_story_points: 2, provider: 'openai', model: 'gpt-5.4', thinking_level: 'medium', fast_mode: true, priority: 5 }),
      });
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body).toEqual(expect.objectContaining({ max_points: 2, max_story_points: 2, min_story_points: 1, provider: 'openai', model: 'gpt-5.4', thinking_level: 'medium', fast_mode: true }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('lists serialized story point aliases for existing rules', async () => {
    const db = getDb();
    await db.run(`
      INSERT INTO story_point_model_routing (tenant_id, project_id, sprint_id, max_points, provider, model, fallback_model, thinking_level, fast_mode, label)
      VALUES (1, 1, NULL, 3, 'anthropic', 'claude-sonnet-4-5', NULL, 'low', 0, 'small')
    `);

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/model-routing`);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toEqual([
        expect.objectContaining({ project_id: 1, sprint_id: null, max_points: 3, max_story_points: 3, min_story_points: 1, provider: 'anthropic', thinking_level: 'low', fast_mode: false, scope: 'project' }),
      ]);
    } finally {
      await stopTestServer(server);
    }
  });

  it('creates, lists, and updates enabled state for model routing rules', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const create = await fetch(`${baseUrl}/api/v1/model-routing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, max_points: 3, provider: 'openai', model: 'openai/gpt-5.4', enabled: false }),
      });
      expect(create.status).toBe(201);
      const created = await create.json() as { id: number; enabled: boolean };
      expect(created.enabled).toBe(false);

      const list = await fetch(`${baseUrl}/api/v1/model-routing?project_id=1`);
      expect(list.status).toBe(200);
      await expect(list.json()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: created.id, enabled: false }),
      ]));

      const update = await fetch(`${baseUrl}/api/v1/model-routing/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      expect(update.status).toBe(200);
      await expect(update.json()).resolves.toEqual(expect.objectContaining({ id: created.id, enabled: true }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects unsupported thinking_level values', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/model-routing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, max_points: 2, provider: 'openai', model: 'gpt-5.4', thinking_level: 'turbo' }),
      });
      const body = await response.json() as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toContain('thinking_level must be one of');
    } finally {
      await stopTestServer(server);
    }
  });

  it('accepts configured provider slugs including openai-codex', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/model-routing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, max_points: 4, provider: 'openai-codex', model: 'openai/gpt-5.5', thinking_level: 'high' }),
      });
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body).toEqual(expect.objectContaining({
        max_points: 4,
        provider: 'openai-codex',
        model: 'openai/gpt-5.5',
        thinking_level: 'high',
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects legacy openai-codex model prefixes', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/model-routing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, max_points: 4, provider: 'openai-codex', model: 'openai-codex/gpt-5.5' }),
      });
      const body = await response.json() as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toContain('must use OpenClaw model IDs');
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects provider slugs that are not configured', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/model-routing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, max_points: 2, provider: 'legacy-openai', model: 'gpt-5.4' }),
      });
      const body = await response.json() as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toContain('provider must be a configured provider slug or null');
    } finally {
      await stopTestServer(server);
    }
  });

  it('allows provider-agnostic routing rules with null provider', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/model-routing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, max_points: 8, provider: null, model: 'openai/gpt-5.5' }),
      });
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body).toEqual(expect.objectContaining({
        max_points: 8,
        provider: null,
        model: 'openai/gpt-5.5',
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('creates and lists model routing rules in a project sprint scope', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const create = await fetch(`${baseUrl}/api/v1/model-routing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: 1,
          sprint_id: 10,
          max_points: 5,
          provider: 'openai-codex',
          model: 'openai/gpt-5.5',
          thinking_level: 'high',
        }),
      });
      expect(create.status).toBe(201);

      const scoped = await fetch(`${baseUrl}/api/v1/model-routing?project_id=1&sprint_id=10`);
      const scopedBody = await scoped.json();
      expect(scoped.status).toBe(200);
      expect(scopedBody).toEqual([
        expect.objectContaining({
          project_id: 1,
          sprint_id: 10,
          max_points: 5,
          model: 'openai/gpt-5.5',
        }),
      ]);

      const other = await fetch(`${baseUrl}/api/v1/model-routing?project_id=2&sprint_id=20`);
      expect(await other.json()).toEqual([]);
    } finally {
      await stopTestServer(server);
    }
  });

  it('accepts workflow_id as a model routing alias for specific workflow scopes', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const create = await fetch(`${baseUrl}/api/v1/model-routing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: 1,
          workflow_id: 10,
          max_points: 5,
          provider: 'openai-codex',
          model: 'openai/gpt-5.5',
        }),
      });
      expect(create.status).toBe(201);
      await expect(create.json()).resolves.toEqual(expect.objectContaining({
        sprint_id: 10,
        workflow_id: 10,
        sprint_type: null,
        workflow_type: null,
        scope: 'project_sprint',
      }));

      const scoped = await fetch(`${baseUrl}/api/v1/model-routing?project_id=1&workflow_id=10`);
      expect(scoped.status).toBe(200);
      await expect(scoped.json()).resolves.toEqual([
        expect.objectContaining({ project_id: 1, sprint_id: 10, workflow_id: 10, max_points: 5 }),
      ]);
    } finally {
      await stopTestServer(server);
    }
  });

  it('creates, updates, and lists model routing rules in a project sprint-type scope', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const create = await fetch(`${baseUrl}/api/v1/model-routing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: 1,
          sprint_type: 'dev',
          max_points: 8,
          provider: null,
          model: 'openai/gpt-5.5',
          label: 'Dev default',
        }),
      });
      const created = await create.json() as { id: number };
      expect(create.status).toBe(201);
      expect(created).toEqual(expect.objectContaining({
        project_id: 1,
        sprint_id: null,
        sprint_type: 'dev',
        scope: 'project_sprint_type',
      }));

      const update = await fetch(`${baseUrl}/api/v1/model-routing/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_points: 13, sprint_type: 'dev' }),
      });
      expect(update.status).toBe(200);
      await expect(update.json()).resolves.toEqual(expect.objectContaining({ max_points: 13, sprint_type: 'dev' }));

      const scoped = await fetch(`${baseUrl}/api/v1/model-routing?project_id=1&sprint_type=dev`);
      expect(scoped.status).toBe(200);
      await expect(scoped.json()).resolves.toEqual([
        expect.objectContaining({ project_id: 1, sprint_id: null, sprint_type: 'dev', max_points: 13 }),
      ]);
    } finally {
      await stopTestServer(server);
    }
  });

  it('accepts workflow_type as a model routing alias for workflow-type scopes', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const create = await fetch(`${baseUrl}/api/v1/model-routing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: 1,
          workflow_type: 'dev',
          max_points: 8,
          provider: null,
          model: 'openai/gpt-5.5',
        }),
      });
      const created = await create.json() as { id: number };
      expect(create.status).toBe(201);
      expect(created).toEqual(expect.objectContaining({
        project_id: 1,
        sprint_id: null,
        workflow_id: null,
        sprint_type: 'dev',
        workflow_type: 'dev',
        scope: 'project_sprint_type',
      }));

      const update = await fetch(`${baseUrl}/api/v1/model-routing/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_points: 13, workflow_type: 'dev' }),
      });
      expect(update.status).toBe(200);
      await expect(update.json()).resolves.toEqual(expect.objectContaining({ max_points: 13, workflow_type: 'dev' }));

      const scoped = await fetch(`${baseUrl}/api/v1/model-routing?project_id=1&workflow_type=dev`);
      expect(scoped.status).toBe(200);
      await expect(scoped.json()).resolves.toEqual([
        expect.objectContaining({ project_id: 1, sprint_id: null, workflow_id: null, sprint_type: 'dev', workflow_type: 'dev', max_points: 13 }),
      ]);
    } finally {
      await stopTestServer(server);
    }
  });

  it('creates and lists model routing rules in an all-project sprint-type scope', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const create = await fetch(`${baseUrl}/api/v1/model-routing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sprint_type: 'dev',
          max_points: 8,
          provider: null,
          model: 'openai/gpt-5.5',
          label: 'All dev default',
        }),
      });
      const created = await create.json() as { id: number };
      expect(create.status).toBe(201);
      expect(created).toEqual(expect.objectContaining({
        project_id: null,
        sprint_id: null,
        sprint_type: 'dev',
        scope: 'sprint_type',
      }));

      const scoped = await fetch(`${baseUrl}/api/v1/model-routing?sprint_type=dev`);
      expect(scoped.status).toBe(200);
      await expect(scoped.json()).resolves.toEqual([
        expect.objectContaining({ project_id: null, sprint_id: null, sprint_type: 'dev', max_points: 8, scope: 'sprint_type' }),
      ]);
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects unknown sprint_type scopes', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/model-routing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'missing', max_points: 5, model: 'openai/gpt-5.5' }),
      });
      const body = await response.json() as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toContain('workflow_type must reference an existing workflow type');
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects legacy unscoped model routing rule creation', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/model-routing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_points: 5, provider: 'openai-codex', model: 'openai/gpt-5.5' }),
      });
      const body = await response.json() as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toContain('Explicit project_id, workflow_id, or workflow_type scope is required');
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects include_fallback on list requests', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/model-routing?project_id=1&sprint_id=10&include_fallback=true`);
      const body = await response.json() as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toContain('include_fallback is no longer supported');
    } finally {
      await stopTestServer(server);
    }
  });

  it('preserves nullable fields when updating only the provider', async () => {
    const db = getDb();
    const inserted = await db.run(`
      INSERT INTO story_point_model_routing (tenant_id, project_id, sprint_id, max_points, provider, model, fallback_model, thinking_level, label)
      VALUES (1, 1, NULL, 4, 'openai', 'openai/gpt-5.5', 'openai/gpt-5.4', 'high', 'Medium - OpenAI GPT-5.5')
    `);

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/model-routing/${inserted.lastInsertId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'openai-codex' }),
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual(expect.objectContaining({
        provider: 'openai-codex',
        fallback_model: 'openai/gpt-5.4',
        label: 'Medium - OpenAI GPT-5.5',
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('blocks cross-tenant by-id reads, updates, deletes, and foreign scopes', async () => {
    const db = getDb();
    const defaultTenantId = await ensureTenantSchema(db);
    const betaTenantId = 2;
    await db.run(`
      INSERT INTO tenants (id, name, slug, is_default)
      VALUES (2, 'Beta Tenant', 'beta-tenant', 0)
    `);
    await db.run(`UPDATE projects SET tenant_id = ? WHERE id = 2`, betaTenantId);
    await db.run(`UPDATE sprints SET tenant_id = ? WHERE id = 20`, betaTenantId);
    const inserted = await db.run(`
      INSERT INTO story_point_model_routing
        (tenant_id, project_id, sprint_id, max_points, provider, model, label)
      VALUES (?, 2, 20, 8, 'openai', 'openai/gpt-5.5', 'Beta private rule')
    `, betaTenantId);
    const betaRuleId = Number(inserted.lastInsertId);

    const { server, baseUrl } = await startTestServer();
    try {
      await db.run(`UPDATE app_settings SET value = ? WHERE key = 'active_tenant_id'`, String(defaultTenantId));
      const alphaGet = await fetch(`${baseUrl}/api/v1/model-routing/${betaRuleId}`);
      expect(alphaGet.status).toBe(404);

      const alphaPut = await fetch(`${baseUrl}/api/v1/model-routing/${betaRuleId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'cross-tenant mutation' }),
      });
      expect(alphaPut.status).toBe(404);

      const alphaDelete = await fetch(`${baseUrl}/api/v1/model-routing/${betaRuleId}`, {
        method: 'DELETE',
      });
      expect(alphaDelete.status).toBe(404);

      await db.run(`UPDATE app_settings SET value = ? WHERE key = 'active_tenant_id'`, String(betaTenantId));
      const betaGet = await fetch(`${baseUrl}/api/v1/model-routing/${betaRuleId}`);
      const betaBody = await betaGet.json();
      expect(betaGet.status).toBe(200);
      expect(betaBody).toEqual(expect.objectContaining({
        id: betaRuleId,
        tenant_id: betaTenantId,
        label: 'Beta private rule',
      }));

      await db.run(`UPDATE app_settings SET value = ? WHERE key = 'active_tenant_id'`, String(defaultTenantId));
      const alphaForeignScope = await fetch(`${baseUrl}/api/v1/model-routing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 2, workflow_id: 20, max_story_points: 13, provider: 'openai', model: 'openai/gpt-5.5' }),
      });
      const alphaForeignScopeBody = await alphaForeignScope.json() as { error: string };
      expect(alphaForeignScope.status).toBe(400);
      expect(alphaForeignScopeBody.error).toContain('project_id must reference an existing project');
    } finally {
      await stopTestServer(server);
    }
  });
});
