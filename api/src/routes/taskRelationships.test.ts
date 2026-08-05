import express from 'express';
import type { Server } from 'http';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import tasksRouter from './tasks';
import sprintsRouter from './sprints';

interface Fixture {
  tenantId: number;
  projectId: number;
  sprintId: number;
  sourceTaskId: number;
  targetTaskId: number;
  otherTaskId: number;
}

/** The three tasks these tests relate to each other, plus their installed tenant workflow. */
async function seedFixture(): Promise<Fixture> {
  const db = getDb();
  const tenantId = Number((await db.run(`
    INSERT INTO tenants (name, slug, is_default)
    VALUES ('Agent HQ', 'agent-hq', 1)
  `)).lastInsertId);
  await db.run(`
    INSERT INTO app_settings (key, value)
    VALUES ('default_tenant_id', ?), ('active_tenant_id', ?)
  `, String(tenantId), String(tenantId));
  await db.run(`
    INSERT INTO sprint_types (tenant_id, key, name, description, is_system)
    VALUES (?, 'generic', 'Generic', '', 1)
  `, tenantId);
  await db.run(`
    INSERT INTO sprint_type_task_types (tenant_id, sprint_type_key, task_type, is_system)
    VALUES (?, 'generic', 'backend', 1)
  `, tenantId);
  await db.run(`
    INSERT INTO sprint_type_relationship_types (
      tenant_id, sprint_type_key, key, label, inverse_label, category,
      affects_dispatch_eligibility, direction_semantics, active_statuses_json,
      resolved_statuses_json, is_system, metadata_json
    ) VALUES (?, 'generic', 'blocked_by', 'Blocked by', 'Blocks', 'dependency',
      1, 'target_blocks_source', '["todo","ready","in_progress","review"]', '["done"]', 1, '{}')
  `, tenantId);

  const project = await db.run(
    `INSERT INTO projects (tenant_id, name, description, context_md) VALUES (?, 'Agent HQ', '', '')`,
    tenantId,
  );
  const projectId = Number(project.lastInsertId);

  const sprint = await db.run(`
    INSERT INTO sprints (tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value)
    VALUES (?, ?, 'Enhancements', '', 'generic', 'active', 'time', '2w')
  `, tenantId, projectId);
  const sprintId = Number(sprint.lastInsertId);

  const insertTask = async (title: string, status: string): Promise<number> => Number((await db.run(`
    INSERT INTO tasks (tenant_id, title, description, status, priority, project_id, sprint_id, task_type)
    VALUES (?, ?, '', ?, 'medium', ?, ?, 'backend')
  `, tenantId, title, status, projectId, sprintId)).lastInsertId);

  return {
    tenantId,
    projectId,
    sprintId,
    sourceTaskId: await insertTask('Source task', 'ready'),
    targetTaskId: await insertTask('Target task', 'ready'),
    otherTaskId: await insertTask('Other task', 'done'),
  };
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
  let fixture: Fixture;

  beforeEach(async () => {
    await setupTestDb();
    fixture = await seedFixture();
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('creates, lists, and deletes generic relationships with sprint-defined type validation', async () => {
    const { sourceTaskId, targetTaskId } = fixture;
    const { server, baseUrl } = await startTestServer();
    try {
      const invalidResponse = await fetch(`${baseUrl}/api/v1/tasks/${sourceTaskId}/relationships`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_task_id: targetTaskId, relationship_type_key: 'causes' }),
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

      const createResponse = await fetch(`${baseUrl}/api/v1/tasks/${sourceTaskId}/relationships`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-actor': 'test-suite' },
        body: JSON.stringify({ target_task_id: targetTaskId, relationship_type_key: 'causes', metadata: { reason: 'upstream work' } }),
      });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as { id: number; relationship_type_key: string; metadata: Record<string, unknown>; type: { label: string } };
      expect(created).toEqual(expect.objectContaining({
        source_task_id: sourceTaskId,
        target_task_id: targetTaskId,
        relationship_type_key: 'causes',
        metadata: { reason: 'upstream work' },
        type: expect.objectContaining({ label: 'Causes' }),
      }));

      const dependency = await getDb().get(
        `SELECT blocker_id, blocked_id FROM task_dependencies WHERE blocker_id = ? AND blocked_id = ?`,
        sourceTaskId, targetTaskId,
      );
      expect(dependency).toEqual({ blocker_id: sourceTaskId, blocked_id: targetTaskId });

      const listResponse = await fetch(`${baseUrl}/api/v1/tasks/${targetTaskId}/relationships`);
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toEqual({
        relationships: [expect.objectContaining({ id: created.id, source_task_id: sourceTaskId, target_task_id: targetTaskId, relationship_type_key: 'causes' })],
      });

      const deleteResponse = await fetch(`${baseUrl}/api/v1/tasks/${sourceTaskId}/relationships/${created.id}`, { method: 'DELETE' });
      expect(deleteResponse.status).toBe(200);
      await expect(deleteResponse.json()).resolves.toEqual({ ok: true, deleted_id: created.id });
      const deletedDependency = await getDb().get(
        `SELECT blocker_id, blocked_id FROM task_dependencies WHERE blocker_id = ? AND blocked_id = ?`,
        sourceTaskId, targetTaskId,
      );
      expect(deletedDependency).toBeUndefined();
    } finally {
      await stopTestServer(server);
    }
  });

  it('resolves task-scoped relationship types with dispatch semantics', async () => {
    const { sourceTaskId } = fixture;
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/tasks/${sourceTaskId}/relationship-types`);
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
      expect(body.task_id).toBe(sourceTaskId);
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
    const { sourceTaskId, targetTaskId } = fixture;
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/tasks/${sourceTaskId}/relationships`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_task_id: targetTaskId, relationship_type_key: 'blocked_by' }),
      });
      expect(response.status).toBe(201);

      const taskResponse = await fetch(`${baseUrl}/api/v1/tasks/${sourceTaskId}`);
      expect(taskResponse.status).toBe(200);
      const task = await taskResponse.json() as { blockers: Array<{ id: number }>; relationships: Array<{ relationship_type_key: string }> };
      expect(task.blockers.map((blocker) => blocker.id)).toContain(targetTaskId);
      expect(task.relationships).toEqual([expect.objectContaining({ relationship_type_key: 'blocked_by', source_task_id: sourceTaskId, target_task_id: targetTaskId })]);

      const dependency = await getDb().get(
        `SELECT blocker_id, blocked_id FROM task_dependencies WHERE blocker_id = ? AND blocked_id = ?`,
        targetTaskId, sourceTaskId,
      );
      expect(dependency).toEqual({ blocker_id: targetTaskId, blocked_id: sourceTaskId });
    } finally {
      await stopTestServer(server);
    }
  });

  it('does not create hidden dispatch dependencies for legacy blockers when blocked_by is not configured', async () => {
    const { sourceTaskId, targetTaskId } = fixture;
    const db = getDb();
    await db.run(`DELETE FROM sprint_type_relationship_types WHERE key = 'blocked_by'`);
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/tasks/${sourceTaskId}/blockers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocker_id: targetTaskId }),
      });
      expect(response.status).toBe(200);
      const task = await response.json() as { legacy_blocker_warning?: string; blockers: Array<{ id: number }> };
      expect(task.legacy_blocker_warning).toContain('Legacy blocker writes are compatibility-only');
      expect(task.legacy_blocker_warning).toContain('blocked_by is not configured');
      expect(task.blockers.map((blocker) => blocker.id)).not.toContain(targetTaskId);

      const dependency = await getDb().get(
        `SELECT blocker_id, blocked_id FROM task_dependencies WHERE blocker_id = ? AND blocked_id = ?`,
        targetTaskId, sourceTaskId,
      );
      expect(dependency).toBeUndefined();
      const relationship = await getDb().get(`
        SELECT id FROM task_relationships
        WHERE source_task_id = ? AND target_task_id = ? AND relationship_type_key = 'blocked_by'
      `, sourceTaskId, targetTaskId);
      expect(relationship).toBeUndefined();
    } finally {
      await stopTestServer(server);
    }
  });

  it('keeps task relationship target tasks tenant-isolated', async () => {
    const { sourceTaskId } = fixture;
    const db = getDb();
    const otherTenantId = Number((await db.run(
      `INSERT INTO tenants (slug, name) VALUES ('other', 'Other Tenant')`,
    )).lastInsertId);
    const otherProjectId = Number((await db.run(
      `INSERT INTO projects (tenant_id, name) VALUES (?, 'Other Project')`,
      otherTenantId,
    )).lastInsertId);
    const otherSprintId = Number((await db.run(`
      INSERT INTO sprints (tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value)
      VALUES (?, ?, 'Other Enhancements', '', 'generic', 'active', 'time', '2w')
    `, otherTenantId, otherProjectId)).lastInsertId);
    const otherTenantTaskId = Number((await db.run(`
      INSERT INTO tasks (tenant_id, title, description, status, priority, project_id, sprint_id, task_type)
      VALUES (?, 'Other tenant task', '', 'ready', 'medium', ?, ?, 'backend')
    `, otherTenantId, otherProjectId, otherSprintId)).lastInsertId);

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/tasks/${sourceTaskId}/relationships`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_task_id: otherTenantTaskId, relationship_type_key: 'blocked_by' }),
      });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual(expect.objectContaining({ error: 'Target task not found' }));
      const relationship = await getDb().get(
        `SELECT id FROM task_relationships WHERE source_task_id = ? AND target_task_id = ?`,
        sourceTaskId, otherTenantTaskId,
      );
      expect(relationship).toBeUndefined();
    } finally {
      await stopTestServer(server);
    }
  });
});
