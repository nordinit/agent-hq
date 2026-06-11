import express from 'express';
import type { Server } from 'http';
import { closeDb, getDb } from '../db/client';
import { initSchema } from '../db/schema';
import { authenticateMcpApiKeyIfPresent, authorizeMcpApiRequestIfPresent, ensureMcpApiKeyTable, issueMcpApiKeyForAgent } from '../lib/mcpApiAuth';
import { getDefaultTenantId } from '../lib/tenantContext';
import tasksRouter from './tasks';

describe('manual MCP/admin task moves', () => {
  beforeEach(() => {
    initSchema();
    const db = getDb();
    db.exec(`
      DELETE FROM sprint_task_transitions;
      DELETE FROM sprint_type_task_types;
      DELETE FROM sprint_type_outcomes;
      DELETE FROM sprint_types;
      DELETE FROM sprints;
      DELETE FROM tasks;
      DELETE FROM projects;
      DELETE FROM agents;
    `);

    const tenantId = getDefaultTenantId(db);
    db.prepare(`INSERT INTO projects (id, tenant_id, name, description, context_md, created_at) VALUES (1, ?, 'Agent HQ', '', '', datetime('now'))`).run(tenantId);
    db.prepare(`INSERT INTO sprint_types (tenant_id, key, name, description, is_system, created_at, updated_at) VALUES (?, 'bugs', 'Bugs', '', 0, datetime('now'), datetime('now'))`).run(tenantId);
    db.prepare(`INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value, created_at) VALUES (56, ?, 1, 'Bugs', '', 'bugs', 'active', 'time', '2w', datetime('now'))`).run(tenantId);
    db.prepare(`INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at) VALUES
      (?, 56, NULL, 'dev_deploy_queued', 'completed_for_review', 'review', 1, 30, 0, datetime('now'), datetime('now')),
      (?, 56, NULL, 'dev_deploy_queued', 'blocked', 'blocked', 1, 20, 0, datetime('now'), datetime('now')),
      (?, 56, NULL, 'dev_deploy_queued', 'failed', 'failed', 1, 10, 0, datetime('now'), datetime('now'))
    `).run(tenantId, tenantId, tenantId);
    db.prepare(`INSERT INTO sprint_type_outcomes (tenant_id, sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, badge_variant, stage_order, is_system, metadata_json, created_at, updated_at) VALUES
      (?, 'bugs', NULL, 'completed_for_review', 'Completed for Review', '', 1, 'base', NULL, 0, 0, '{}', datetime('now'), datetime('now')),
      (?, 'bugs', NULL, 'blocked', 'Blocked', '', 1, 'base', NULL, 1, 0, '{}', datetime('now'), datetime('now')),
      (?, 'bugs', NULL, 'failed', 'Failed', '', 1, 'base', NULL, 2, 0, '{}', datetime('now'), datetime('now'))
    `).run(tenantId, tenantId, tenantId);
    db.prepare(`INSERT INTO tasks (id, tenant_id, title, status, sprint_id, task_type, created_at, updated_at) VALUES
      (455, ?, 'Queued task', 'dev_deploy_queued', 56, 'backend', datetime('now'), datetime('now')),
      (456, ?, 'Blocked task', 'blocked', 56, 'backend', datetime('now'), datetime('now'))
    `).run(tenantId, tenantId);
    db.prepare(`INSERT INTO agents (id, tenant_id, name, enabled, system_role, session_key, created_at) VALUES
      (8, ?, 'Atlas', 1, 'admin', 'session:test-atlas', datetime('now'))
    `).run(tenantId);
    ensureMcpApiKeyTable(db);
  });

  afterEach(() => {
    closeDb();
  });

  async function withApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', authenticateMcpApiKeyIfPresent);
    app.use('/api/v1', authorizeMcpApiRequestIfPresent);
    app.use('/api/v1/tasks', tasksRouter);

    const server: Server = await new Promise((resolve) => {
      const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
      return await fn(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  }

  it('allows manual MCP move from dev_deploy_queued to ready', async () => {
    const db = getDb();
    const adminKey = issueMcpApiKeyForAgent(db, 8).apiKey;

    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/tasks/455`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-agent-hq-mcp-client': 'agent-hq-mcp',
          authorization: `Bearer ${adminKey}`,
        },
        body: JSON.stringify({ status: 'ready' }),
      });

      expect(response.status).toBe(200);
    });

    expect((db.prepare(`SELECT status FROM tasks WHERE id = 455`).get() as { status: string }).status).toBe('ready');
  });

  it('allows manual MCP move from another constrained status to a normally disallowed target', async () => {
    const db = getDb();
    const adminKey = issueMcpApiKeyForAgent(db, 8).apiKey;

    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/tasks/456`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-agent-hq-mcp-client': 'agent-hq-mcp',
          authorization: `Bearer ${adminKey}`,
        },
        body: JSON.stringify({ status: 'done' }),
      });

      expect(response.status).toBe(200);
    });

    expect((db.prepare(`SELECT status FROM tasks WHERE id = 456`).get() as { status: string }).status).toBe('done');
  });

  it('keeps automatic/non-manual direct move path rejected when no explicit override authority is present', async () => {
    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/tasks/455`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ status: 'ready', changed_by: 'dispatcher' }),
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining('Only Atlas or a human user may change task status through the generic update endpoint'),
      });
    });
  });
});
