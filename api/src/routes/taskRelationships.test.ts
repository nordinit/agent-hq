import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import { initSchema } from '../db/schema';
import tasksRouter from './tasks';
import sprintsRouter from './sprints';

let tempDir: string;
const originalDbPath = process.env.AGENT_HQ_DB_PATH;

function resetDb(): void {
  closeDb();
  jest.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-relationships-'));
  process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
  initSchema();
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO projects (id, name) VALUES (1, 'Agent HQ')`).run();
  db.prepare(`
    INSERT INTO sprints (id, project_id, name, goal, sprint_type, status, length_kind, length_value)
    VALUES (10, 1, 'Enhancements', '', 'generic', 'active', 'time', '2w')
  `).run();
  db.prepare(`
    INSERT INTO tasks (id, title, description, status, priority, project_id, sprint_id, task_type)
    VALUES
      (1, 'Source task', '', 'ready', 'medium', 1, 10, 'backend'),
      (2, 'Target task', '', 'ready', 'medium', 1, 10, 'backend'),
      (3, 'Other task', '', 'done', 'medium', 1, 10, 'backend')
  `).run();
}

async function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/tasks', tasksRouter);
  app.use('/api/v1/sprints', sprintsRouter);

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

describe('task relationships API', () => {
  beforeEach(() => resetDb());

  afterEach(() => {
    closeDb();
    if (originalDbPath == null) delete process.env.AGENT_HQ_DB_PATH;
    else process.env.AGENT_HQ_DB_PATH = originalDbPath;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates, lists, and deletes generic relationships with sprint-defined type validation', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const invalidResponse = await fetch(`${baseUrl}/api/v1/tasks/1/relationships`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_task_id: 2, relationship_type_key: 'causes' }),
      });
      expect(invalidResponse.status).toBe(400);
      await expect(invalidResponse.json()).resolves.toEqual(expect.objectContaining({
        error: expect.stringContaining('Relationship type "causes" is not defined'),
      }));

      const typeResponse = await fetch(`${baseUrl}/api/v1/sprints/types/generic/relationship-types`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'causes',
          label: 'Causes',
          inverse_label: 'Caused by',
          category: 'dependency',
          affects_dispatch_eligibility: true,
          direction_semantics: 'source_blocks_target',
          active_statuses: ['ready', 'in_progress'],
          resolved_statuses: ['done'],
          metadata: { configured_by: 'test' },
        }),
      });
      expect(typeResponse.status).toBe(201);
      await expect(typeResponse.json()).resolves.toEqual(expect.objectContaining({
        key: 'causes',
        label: 'Causes',
        affects_dispatch_eligibility: 1,
        direction_semantics: 'source_blocks_target',
        active_statuses: ['ready', 'in_progress'],
      }));

      const createResponse = await fetch(`${baseUrl}/api/v1/tasks/1/relationships`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-actor': 'test-suite' },
        body: JSON.stringify({ target_task_id: 2, relationship_type_key: 'causes', metadata: { reason: 'upstream work' } }),
      });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as { id: number; relationship_type_key: string; metadata: Record<string, unknown>; type: { label: string } };
      expect(created).toEqual(expect.objectContaining({
        source_task_id: 1,
        target_task_id: 2,
        relationship_type_key: 'causes',
        metadata: { reason: 'upstream work' },
        type: expect.objectContaining({ label: 'Causes' }),
      }));

      const dependency = getDb().prepare(`SELECT blocker_id, blocked_id FROM task_dependencies WHERE blocker_id = 1 AND blocked_id = 2`).get();
      expect(dependency).toEqual({ blocker_id: 1, blocked_id: 2 });

      const listResponse = await fetch(`${baseUrl}/api/v1/tasks/2/relationships`);
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toEqual({
        relationships: [expect.objectContaining({ id: created.id, source_task_id: 1, target_task_id: 2, relationship_type_key: 'causes' })],
      });

      const deleteResponse = await fetch(`${baseUrl}/api/v1/tasks/1/relationships/${created.id}`, { method: 'DELETE' });
      expect(deleteResponse.status).toBe(200);
      await expect(deleteResponse.json()).resolves.toEqual({ ok: true, deleted_id: created.id });
      const deletedDependency = getDb().prepare(`SELECT blocker_id, blocked_id FROM task_dependencies WHERE blocker_id = 1 AND blocked_id = 2`).get();
      expect(deletedDependency).toBeUndefined();
    } finally {
      await stopTestServer(server);
    }
  });

  it('resolves task-scoped relationship types with dispatch semantics', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/tasks/1/relationship-types`);
      expect(response.status).toBe(200);
      const body = await response.json() as {
        task_id: number;
        relationship_types: Array<{
          key: string;
          label: string;
          direction_semantics: string;
          affects_dispatch_eligibility: number;
        }>;
      };
      expect(body.task_id).toBe(1);
      expect(body.relationship_types).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: 'blocked_by',
          label: expect.any(String),
          direction_semantics: 'target_blocks_source',
          affects_dispatch_eligibility: 1,
        }),
      ]));
    } finally {
      await stopTestServer(server);
    }
  });

  it('preserves blocker compatibility through relationship rows and task reads', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/tasks/1/relationships`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_task_id: 2, relationship_type_key: 'blocked_by' }),
      });
      expect(response.status).toBe(201);

      const taskResponse = await fetch(`${baseUrl}/api/v1/tasks/1`);
      expect(taskResponse.status).toBe(200);
      const task = await taskResponse.json() as { blockers: Array<{ id: number }>; relationships: Array<{ relationship_type_key: string }> };
      expect(task.blockers.map((blocker) => blocker.id)).toContain(2);
      expect(task.relationships).toEqual([expect.objectContaining({ relationship_type_key: 'blocked_by', source_task_id: 1, target_task_id: 2 })]);

      const dependency = getDb().prepare(`SELECT blocker_id, blocked_id FROM task_dependencies WHERE blocker_id = 2 AND blocked_id = 1`).get();
      expect(dependency).toEqual({ blocker_id: 2, blocked_id: 1 });
    } finally {
      await stopTestServer(server);
    }
  });

  it('does not create hidden dispatch dependencies for legacy blockers when blocked_by is not configured', async () => {
    const db = getDb();
    db.prepare(`DELETE FROM sprint_type_relationship_types WHERE key = 'blocked_by'`).run();
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/tasks/1/blockers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocker_id: 2 }),
      });
      expect(response.status).toBe(200);
      const task = await response.json() as { legacy_blocker_warning?: string; blockers: Array<{ id: number }> };
      expect(task.legacy_blocker_warning).toContain('Legacy blocker writes are compatibility-only');
      expect(task.legacy_blocker_warning).toContain('blocked_by is not configured');
      expect(task.blockers.map((blocker) => blocker.id)).not.toContain(2);

      const dependency = getDb().prepare(`SELECT blocker_id, blocked_id FROM task_dependencies WHERE blocker_id = 2 AND blocked_id = 1`).get();
      expect(dependency).toBeUndefined();
      const relationship = getDb().prepare(`
        SELECT id FROM task_relationships
        WHERE source_task_id = 1 AND target_task_id = 2 AND relationship_type_key = 'blocked_by'
      `).get();
      expect(relationship).toBeUndefined();
    } finally {
      await stopTestServer(server);
    }
  });

  it('keeps task relationship target tasks tenant-isolated', async () => {
    const db = getDb();
    db.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (2, 'other', 'Other Tenant')`).run();
    db.prepare(`INSERT INTO projects (id, tenant_id, name) VALUES (2, 2, 'Other Project')`).run();
    db.prepare(`
      INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value)
      VALUES (20, 2, 2, 'Other Enhancements', '', 'generic', 'active', 'time', '2w')
    `).run();
    db.prepare(`
      INSERT INTO tasks (id, tenant_id, title, description, status, priority, project_id, sprint_id, task_type)
      VALUES (20, 2, 'Other tenant task', '', 'ready', 'medium', 2, 20, 'backend')
    `).run();

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/tasks/1/relationships`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_task_id: 20, relationship_type_key: 'blocked_by' }),
      });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual(expect.objectContaining({ error: 'Target task not found' }));
      const relationship = getDb().prepare(`SELECT id FROM task_relationships WHERE source_task_id = 1 AND target_task_id = 20`).get();
      expect(relationship).toBeUndefined();
    } finally {
      await stopTestServer(server);
    }
  });

  it('backfills legacy blockers and defects into idempotent relationship rows', () => {
    const db = getDb();
    db.prepare(`INSERT INTO task_dependencies (blocker_id, blocked_id) VALUES (2, 1)`).run();
    db.prepare(`UPDATE tasks SET origin_task_id = 3, defect_type = 'historic-custom-defect' WHERE id = 1`).run();

    initSchema();
    initSchema();

    const blockers = db.prepare(`
      SELECT source_task_id, target_task_id, relationship_type_key, metadata_json, created_by
      FROM task_relationships
      WHERE source_task_id = 1 AND target_task_id = 2 AND relationship_type_key = 'blocked_by'
    `).all();
    expect(blockers).toEqual([{ source_task_id: 1, target_task_id: 2, relationship_type_key: 'blocked_by', metadata_json: '{}', created_by: 'legacy-task_dependencies' }]);

    const defects = db.prepare(`
      SELECT source_task_id, target_task_id, relationship_type_key, metadata_json, created_by
      FROM task_relationships
      WHERE source_task_id = 1 AND target_task_id = 3 AND relationship_type_key = 'defect_of'
    `).all() as Array<{ metadata_json: string }>;
    expect(defects).toHaveLength(1);
    expect(JSON.parse(defects[0].metadata_json)).toEqual({ legacy_defect_type: 'historic-custom-defect' });
  });
});
