import { setupTestDb, teardownTestDb } from '../db/testDb';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { getDb } from '../db/client';
import {
  authenticateMcpApiKeyIfPresent,
  authorizeMcpApiRequestIfPresent,
  issueMcpApiKeyForAgent,
  replaceAgentMcpPermissionPolicy,
} from '../lib/mcpApiAuth';
import tasksRouter from './tasks';


function restoreDbPath(): void {
}

describe('task active-owner endpoint', () => {
  let tempDir = '';
  let server: Server | null = null;
  let baseUrl = '';
  let cinderKey = '';
  let prismKey = '';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-active-owner-'));
    await setupTestDb();

    const db = getDb();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
    await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
    await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (86, 1, 'Agent HQ')`);
    await db.run(`INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type) VALUES (57, 1, 86, 'Development', 'dev')`);

    await db.run(`
      INSERT INTO agents (id, tenant_id, project_id, name, session_key, slug, enabled, system_role)
      VALUES
        (94, 1, 86, 'Cinder', 'agent:cinder:main', 'cinder-backend', 1, NULL),
        (95, 1, 86, 'Prism', 'agent:prism:main', 'prism-qa', 1, NULL)
    `);
    await db.run(`
      INSERT INTO tasks (id, tenant_id, title, status, project_id, sprint_id, agent_id, active_instance_id)
      VALUES
        (398, 1, 'Wrong task', 'review', 86, 57, 94, NULL),
        (551, 1, 'Routing rule fix', 'in_progress', 86, 57, 94, NULL),
        (552, 1, 'Other agent task', 'in_progress', 86, 57, 95, NULL),
        (553, 1, 'Finished run task', 'review', 86, 57, 94, NULL)
    `);
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, task_id, agent_id, status)
      VALUES
        (7001, 1, 551, 94, 'running'),
        (7002, 1, 552, 95, 'running'),
        (7003, 1, 553, 94, 'done')
    `);
    await db.run(`
      UPDATE tasks
      SET active_instance_id = CASE id WHEN 551 THEN 7001 WHEN 552 THEN 7002 WHEN 553 THEN 7003 END
      WHERE id IN (551, 552, 553)
    `);

    cinderKey = (await issueMcpApiKeyForAgent(db, 94, 'cinder test key')).apiKey;
    prismKey = (await issueMcpApiKeyForAgent(db, 95, 'prism test key')).apiKey;

    const app = express();
    app.use(express.json());
    app.use('/api/v1', authenticateMcpApiKeyIfPresent);
    app.use('/api/v1', authorizeMcpApiRequestIfPresent);
    app.use('/api/v1/tasks', tasksRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close((err) => err ? reject(err) : resolve());
    });
    server = null;
    await teardownTestDb();
    restoreDbPath();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function apiKeyHeaders(apiKey: string): Record<string, string> {
    return { 'x-api-key': apiKey };
  }

  it('requires an authenticated MCP API key', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tasks/551/active-owner`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: 'mcp_api_key_missing',
    });
  });

  it('reports true when the authenticated agent owns the active task instance', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tasks/551/active-owner`, {
      headers: apiKeyHeaders(cinderKey),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      task_id: 551,
      authenticated_agent_id: 94,
      active_instance_id: 7001,
      active_instance_agent_id: 94,
      active_instance_status: 'running',
      is_active_owner: true,
      reason: 'active_instance_owned_by_authenticated_agent',
    });
  });

  it('reports false when the task has no active instance', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 94, [
            'discovery.read_catalog',
            'tasks.read_active_context',
            'tasks.read_project_context',
            'tasks.write_active_lifecycle',
          ]);

    const response = await fetch(`${baseUrl}/api/v1/tasks/398/active-owner`, {
      headers: apiKeyHeaders(cinderKey),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      task_id: 398,
      authenticated_agent_id: 94,
      active_instance_id: null,
      is_active_owner: false,
      reason: 'task_has_no_active_instance',
    });
  });

  it('reports false when another agent owns the active instance', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 94, [
            'discovery.read_catalog',
            'tasks.read_active_context',
            'tasks.read_project_context',
            'tasks.write_active_lifecycle',
          ]);

    const response = await fetch(`${baseUrl}/api/v1/tasks/552/active-owner`, {
      headers: apiKeyHeaders(cinderKey),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      task_id: 552,
      authenticated_agent_id: 94,
      active_instance_agent_id: 95,
      is_active_owner: false,
      reason: 'active_instance_agent_mismatch',
    });
  });

  it('reports false when the active instance reference is terminal', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tasks/553/active-owner`, {
      headers: apiKeyHeaders(cinderKey),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      task_id: 553,
      active_instance_status: 'done',
      is_active_owner: false,
      reason: 'active_instance_not_active',
    });
  });

  it('lets a project-scoped different agent check ownership without passing active task auth', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 95, [
            'discovery.read_catalog',
            'tasks.read_active_context',
            'tasks.read_project_context',
            'tasks.write_active_lifecycle',
          ]);

    const response = await fetch(`${baseUrl}/api/v1/tasks/551/active-owner`, {
      headers: apiKeyHeaders(prismKey),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      task_id: 551,
      authenticated_agent_id: 95,
      active_instance_agent_id: 94,
      is_active_owner: false,
      reason: 'active_instance_agent_mismatch',
    });
  });
});
