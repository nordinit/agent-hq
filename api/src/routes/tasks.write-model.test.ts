import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { closeDb, getDb } from '../db/client';
import { initSchema } from '../db/schema';
import * as dispatchTrigger from '../services/dispatchTrigger';
import tasksRouter from './tasks';

const ORIGINAL_DB_PATH = process.env.AGENT_HQ_DB_PATH;

function restoreEnv(name: string, value: string | undefined): void {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/tasks', tasksRouter);
  const server = await new Promise<Server>((resolve, reject) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
    bound.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

function seedFixture(): void {
  const db = getDb();

  db.prepare(`INSERT INTO projects (id, name, description, context_md) VALUES (86, 'Agent HQ', '', '')`).run();
  db.prepare(`INSERT INTO sprints (id, project_id, name, goal, sprint_type, status) VALUES (42, 86, 'Backend Domain Refactor', '', 'generic', 'active')`).run();
  db.prepare(`
    INSERT INTO agents (id, name, role, session_key, workspace_path, status, preferred_provider)
    VALUES (7, 'Cinder', 'Backend Engineer', 'agent:cinder:test', '/tmp/cinder', 'idle', 'openai-codex')
  `).run();
  db.prepare(`
    INSERT INTO tasks (id, title, description, status, priority, project_id, sprint_id, agent_id, task_type, custom_fields_json)
    VALUES
      (101, 'Existing blocker', '', 'todo', 'medium', 86, 42, 7, 'backend', '{}'),
      (102, 'Editable task', '', 'todo', 'medium', 86, 42, 7, 'backend', '{}'),
      (103, 'Failed task', '', 'failed', 'medium', 86, 42, 7, 'backend', '{}'),
      (104, 'Prior origin task', '', 'done', 'medium', 86, 42, 7, 'backend', '{}')
  `).run();
  db.prepare(`UPDATE tasks SET origin_task_id = 104, defect_type = 'qa_miss' WHERE id = 102`).run();
  db.prepare(`INSERT INTO task_outcome_metrics (task_id, spawned_defects) VALUES (104, 1)`).run();
  db.prepare(`UPDATE tasks SET previous_status = 'ready' WHERE id = 103`).run();
}

describe('tasks route write-model handoff', () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;
  let triggerDispatchSpy: jest.SpyInstance;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-write-model-'));
    process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq.db');
    closeDb();
    initSchema();
    seedFixture();
    triggerDispatchSpy = jest.spyOn(dispatchTrigger, 'triggerDispatch').mockImplementation(() => {});
    ({ server, baseUrl } = await startServer());
  });

  afterEach(async () => {
    triggerDispatchSpy.mockRestore();
    await stopServer(server);
    closeDb();
    restoreEnv('AGENT_HQ_DB_PATH', ORIGINAL_DB_PATH);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates tasks through the route and preserves skipped blocker reporting', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Thin route task',
        description: 'Created through tasks route',
        project_id: 86,
        sprint_id: 42,
        agent_id: 7,
        task_type: 'backend',
        blockers: [101, 999],
        changed_by: 'cinder-backend',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      title: 'Thin route task',
      project_id: 86,
      sprint_id: 42,
      agent_id: null,
      assigned_agent_id: 7,
      task_type: 'backend',
      skipped_blocker_ids: [999],
    });

    const blockers = Array.isArray(body.blockers) ? body.blockers as Array<Record<string, unknown>> : [];
    expect(blockers.map((task) => task.id)).toContain(101);
    expect(triggerDispatchSpy).toHaveBeenCalledWith(86);
  });

  it('rejects task creation without a workflow assignment', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Workflowless task',
        description: 'Should not be accepted',
        project_id: 86,
        task_type: 'backend',
        changed_by: 'cinder-backend',
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'sprint_id is required',
    });
    const created = getDb().prepare(`SELECT id FROM tasks WHERE title = 'Workflowless task'`).get();
    expect(created).toBeUndefined();
  });

  it('creates tasks with selected non-blocking relationships in the same create request', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor': 'prism-frontend' },
      body: JSON.stringify({
        title: 'Task with related work',
        description: 'Created with relationship selections from the new task modal',
        project_id: 86,
        sprint_id: 42,
        task_type: 'backend',
        status: 'todo',
        relationships: [
          { target_task_id: 101, relationship_type_key: 'defect_of' },
        ],
      }),
    });

    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(201);
    expect(body).toMatchObject({
      title: 'Task with related work',
      project_id: 86,
      sprint_id: 42,
    });
    const relationships = Array.isArray(body.relationships) ? body.relationships as Array<Record<string, unknown>> : [];
    expect(relationships).toEqual([
      expect.objectContaining({
        source_task_id: body.id,
        target_task_id: 101,
        relationship_type_key: 'defect_of',
        created_by: 'system',
      }),
    ]);

    const persistedRelationship = getDb().prepare(`
      SELECT source_task_id, target_task_id, relationship_type_key, created_by
      FROM task_relationships
      WHERE source_task_id = ? AND target_task_id = 101 AND relationship_type_key = 'defect_of'
    `).get(body.id);
    expect(persistedRelationship).toEqual({
      source_task_id: body.id,
      target_task_id: 101,
      relationship_type_key: 'defect_of',
      created_by: 'system',
    });
  });

  it('rolls back task creation when selected related-task relationships are invalid', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Invalid related task create',
        description: 'Should not persist without relationship validity',
        project_id: 86,
        sprint_id: 42,
        task_type: 'backend',
        status: 'todo',
        relationships: [
          { target_task_id: 101, relationship_type_key: 'not_a_real_relationship' },
        ],
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('Relationship type "not_a_real_relationship" is not defined'),
    });
    const created = getDb().prepare(`SELECT id FROM tasks WHERE title = 'Invalid related task create'`).get();
    expect(created).toBeUndefined();
  });

  it('triggers dispatch when creating a todo task so wildcard todo routing can apply immediately', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Todo routeable task',
        description: 'Created through tasks route',
        project_id: 86,
        sprint_id: 42,
        task_type: 'backend',
        status: 'todo',
        changed_by: 'cinder-backend',
      }),
    });

    expect(res.status).toBe(201);
    expect(triggerDispatchSpy).toHaveBeenCalledWith(86);
  });

  it('triggers dispatch when creating a ready task', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Ready routeable task',
        description: 'Created through tasks route',
        project_id: 86,
        sprint_id: 42,
        task_type: 'backend',
        status: 'ready',
        changed_by: 'cinder-backend',
      }),
    });

    expect(res.status).toBe(201);
    expect(triggerDispatchSpy).toHaveBeenCalledWith(86);
  });

  it('creates tasks with custom workflow-specific task types absent from legacy defaults', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO sprint_types (tenant_id, key, name, description) VALUES (1, 'construction', 'Construction', '')`).run();
    db.prepare(`
      INSERT INTO sprint_type_task_types (tenant_id, sprint_type_key, task_type, is_system)
      VALUES (1, 'construction', 'compliance', 0), (1, 'construction', 'finance', 0)
    `).run();
    db.prepare(`INSERT INTO sprints (id, project_id, name, goal, sprint_type, status) VALUES (43, 86, 'Construction Workflow', '', 'construction', 'active')`).run();

    const res = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Permit review',
        project_id: 86,
        sprint_id: 43,
        task_type: 'compliance',
        status: 'todo',
        changed_by: 'cinder-backend',
      }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      title: 'Permit review',
      sprint_id: 43,
      task_type: 'compliance',
    });
  });

  it('rejects task creation when task_type is not allowed by the selected workflow type', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO sprint_types (tenant_id, key, name, description) VALUES (1, 'construction', 'Construction', '')`).run();
    db.prepare(`
      INSERT INTO sprint_type_task_types (tenant_id, sprint_type_key, task_type, is_system)
      VALUES (1, 'construction', 'compliance', 0), (1, 'construction', 'finance', 0)
    `).run();
    db.prepare(`INSERT INTO sprints (id, project_id, name, goal, sprint_type, status) VALUES (43, 86, 'Construction Workflow', '', 'construction', 'active')`).run();

    const res = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Frontend work in construction workflow',
        project_id: 86,
        sprint_id: 43,
        task_type: 'frontend',
        status: 'todo',
        changed_by: 'cinder-backend',
      }),
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('task_type "frontend" is not allowed for sprint type "construction"'),
    });
  });

  it('updates tasks to custom workflow-specific task types absent from legacy defaults', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO sprint_types (tenant_id, key, name, description) VALUES (1, 'construction', 'Construction', '')`).run();
    db.prepare(`
      INSERT INTO sprint_type_task_types (tenant_id, sprint_type_key, task_type, is_system)
      VALUES (1, 'construction', 'compliance', 0), (1, 'construction', 'finance', 0)
    `).run();
    db.prepare(`INSERT INTO sprints (id, project_id, name, goal, sprint_type, status) VALUES (43, 86, 'Construction Workflow', '', 'construction', 'active')`).run();

    const res = await fetch(`${baseUrl}/api/v1/tasks/102`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sprint_id: 43,
        task_type: 'finance',
        changed_by: 'cinder-backend',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: 102,
      sprint_id: 43,
      task_type: 'finance',
    });
  });

  it('rejects task updates that clear workflow assignment', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks/102`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sprint_id: null,
        changed_by: 'cinder-backend',
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'sprint_id is required and cannot be cleared',
    });
    expect((getDb().prepare(`SELECT sprint_id FROM tasks WHERE id = 102`).get() as { sprint_id: number }).sprint_id).toBe(42);
  });

  it('updates tasks through the route and replaces blockers without changing the response shape', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks/102`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Editable task updated',
        priority: 'high',
        review_branch: 'cinder-backend/task-481',
        review_commit: 'abcdef1234567890abcdef1234567890abcdef12',
        review_url: 'http://127.0.0.1:3510/tasks/102/review',
        blockers: [{ task_id: 101 }],
        changed_by: 'cinder-backend',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      id: 102,
      title: 'Editable task updated',
      priority: 'high',
    });
    const blockers = Array.isArray(body.blockers) ? body.blockers as Array<Record<string, unknown>> : [];
    expect(blockers.map((task) => task.id)).toEqual([101]);
  });

  it('updates and clears defect metadata through the generic task update route', async () => {
    const changeRes = await fetch(`${baseUrl}/api/v1/tasks/102`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        origin_task_id: 101,
        defect_type: 'regression',
        changed_by: 'User',
      }),
    });

    expect(changeRes.status).toBe(200);
    await expect(changeRes.json()).resolves.toMatchObject({
      id: 102,
      origin_task_id: 101,
      origin_task_title: 'Existing blocker',
      defect_type: 'regression',
    });

    const db = getDb();
    expect(db.prepare(`SELECT spawned_defects FROM task_outcome_metrics WHERE task_id = 104`).get()).toMatchObject({ spawned_defects: 0 });
    expect(db.prepare(`SELECT spawned_defects FROM task_outcome_metrics WHERE task_id = 101`).get()).toMatchObject({ spawned_defects: 1 });
    const defectRelationship = db.prepare(`
      SELECT source_task_id, target_task_id, relationship_type_key, metadata_json
      FROM task_relationships
      WHERE source_task_id = 102 AND target_task_id = 101 AND relationship_type_key = 'defect_of'
    `).get() as { metadata_json: string };
    expect(JSON.parse(defectRelationship.metadata_json)).toEqual({ legacy_defect_type: 'regression' });

    const customTypeRes = await fetch(`${baseUrl}/api/v1/tasks/102`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        defect_type: 'customer_reported_escape',
        changed_by: 'User',
      }),
    });
    expect(customTypeRes.status).toBe(200);
    const updatedRelationship = db.prepare(`
      SELECT metadata_json
      FROM task_relationships
      WHERE source_task_id = 102 AND target_task_id = 101 AND relationship_type_key = 'defect_of'
    `).get() as { metadata_json: string };
    expect(JSON.parse(updatedRelationship.metadata_json)).toEqual({ legacy_defect_type: 'customer_reported_escape' });

    const clearRes = await fetch(`${baseUrl}/api/v1/tasks/102`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        origin_task_id: null,
        defect_type: null,
        changed_by: 'User',
      }),
    });

    expect(clearRes.status).toBe(200);
    await expect(clearRes.json()).resolves.toMatchObject({
      id: 102,
      origin_task_id: null,
      origin_task_title: null,
      defect_type: null,
    });
    expect(db.prepare(`SELECT spawned_defects FROM task_outcome_metrics WHERE task_id = 101`).get()).toMatchObject({ spawned_defects: 0 });
    const clearedRelationship = db.prepare(`
      SELECT id FROM task_relationships
      WHERE source_task_id = 102 AND target_task_id = 101 AND relationship_type_key = 'defect_of'
    `).get();
    expect(clearedRelationship).toBeUndefined();
  });

  it('rejects self-referential origin task relationships', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks/102`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        origin_task_id: 102,
        changed_by: 'User',
      }),
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('origin_task_id cannot reference the task being updated'),
    });
  });

  it('allows direct API status overrides when the request explicitly marks Atlas authority', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks/102`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'done',
        changed_by: 'operator-recovery',
        authorized_by: 'Atlas',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ id: 102, status: 'done' });

    const db = getDb();
    expect((db.prepare(`SELECT status FROM tasks WHERE id = 102`).get() as { status: string }).status).toBe('done');
    expect(db.prepare(`SELECT changed_by, field, old_value, new_value FROM task_history WHERE task_id = 102 AND field = 'status' ORDER BY id DESC LIMIT 1`).get()).toMatchObject({
      changed_by: 'operator-recovery',
      field: 'status',
      old_value: 'todo',
      new_value: 'done',
    });
  });

  it('allows status-only updates while preserving retired custom field values', async () => {
    const db = getDb();
    db.prepare(`DELETE FROM task_field_schemas WHERE sprint_type_key = 'generic' AND task_type IS NULL`).run();
    db.prepare(`
      INSERT INTO task_field_schemas (tenant_id, sprint_type_key, task_type, schema_json)
      VALUES (1, 'generic', NULL, ?)
    `).run(JSON.stringify({ fields: [{ key: 'active_text', label: 'Active Text', type: 'text', required: true }] }));
    db.prepare(`UPDATE tasks SET custom_fields_json = ? WHERE id = 102`).run(JSON.stringify({ target_surface: 'api' }));

    const res = await fetch(`${baseUrl}/api/v1/tasks/102`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'ready',
        changed_by: 'operator-recovery',
        authorized_by: 'Atlas',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: 102, status: 'ready' });
    const stored = db.prepare(`SELECT custom_fields_json FROM tasks WHERE id = 102`).get() as { custom_fields_json: string };
    expect(JSON.parse(stored.custom_fields_json)).toEqual({ target_surface: 'api' });
  });

  it('tolerates unchanged retired custom fields when editing active custom fields', async () => {
    const db = getDb();
    db.prepare(`DELETE FROM task_field_schemas WHERE sprint_type_key = 'generic' AND task_type IS NULL`).run();
    db.prepare(`
      INSERT INTO task_field_schemas (tenant_id, sprint_type_key, task_type, schema_json)
      VALUES (1, 'generic', NULL, ?)
    `).run(JSON.stringify({ fields: [{ key: 'active_text', label: 'Active Text', type: 'text', required: true }] }));
    db.prepare(`UPDATE tasks SET custom_fields_json = ? WHERE id = 102`).run(JSON.stringify({ target_surface: 'api', active_text: 'old' }));

    const res = await fetch(`${baseUrl}/api/v1/tasks/102`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        custom_fields: { target_surface: 'api', active_text: 'new' },
        changed_by: 'cinder-backend',
      }),
    });

    expect(res.status).toBe(200);
    const stored = db.prepare(`SELECT custom_fields_json FROM tasks WHERE id = 102`).get() as { custom_fields_json: string };
    expect(JSON.parse(stored.custom_fields_json)).toEqual({ target_surface: 'api', active_text: 'new' });
  });

  it('allows editing workflow default and task-type-specific custom fields together', async () => {
    const db = getDb();
    db.prepare(`DELETE FROM task_field_schemas WHERE sprint_type_key = 'generic'`).run();
    db.prepare(`
      INSERT INTO task_field_schemas (tenant_id, sprint_type_key, task_type, schema_json)
      VALUES
        (1, 'generic', NULL, ?),
        (1, 'generic', 'backend', ?)
    `).run(
      JSON.stringify({ fields: [{ key: 'active_text', label: 'Active Text', type: 'text', required: true }] }),
      JSON.stringify({ fields: [{ key: 'target_surface', label: 'Target Surface', type: 'select', options: ['api', 'ui'] }] }),
    );

    const res = await fetch(`${baseUrl}/api/v1/tasks/102`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        custom_fields: { active_text: 'default value', target_surface: 'api' },
        changed_by: 'cinder-backend',
      }),
    });

    expect(res.status).toBe(200);
    const stored = db.prepare(`SELECT custom_fields_json FROM tasks WHERE id = 102`).get() as { custom_fields_json: string };
    expect(JSON.parse(stored.custom_fields_json)).toEqual({ active_text: 'default value', target_surface: 'api' });
  });

  it('still rejects edits to custom fields outside the active sprint schema', async () => {
    const db = getDb();
    db.prepare(`DELETE FROM task_field_schemas WHERE sprint_type_key = 'generic' AND task_type IS NULL`).run();
    db.prepare(`
      INSERT INTO task_field_schemas (tenant_id, sprint_type_key, task_type, schema_json)
      VALUES (1, 'generic', NULL, ?)
    `).run(JSON.stringify({ fields: [{ key: 'active_text', label: 'Active Text', type: 'text' }] }));
    db.prepare(`UPDATE tasks SET custom_fields_json = ? WHERE id = 102`).run(JSON.stringify({ target_surface: 'api', active_text: 'old' }));

    const res = await fetch(`${baseUrl}/api/v1/tasks/102`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        custom_fields: { target_surface: 'ui', active_text: 'old' },
        changed_by: 'cinder-backend',
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'Unknown custom field "target_surface"',
    });
  });

  it('allows direct API status overrides when Atlas authority is supplied via header', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks/102`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-agenthq-authority-by': 'Atlas',
      },
      body: JSON.stringify({
        status: 'done',
        changed_by: 'operator-recovery',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: 102, status: 'done' });
  });

  it('allows direct API status overrides when user authority is supplied via legacy header spelling', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks/102`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-agent-hq-authority-by': 'user',
      },
      body: JSON.stringify({
        status: 'blocked',
        changed_by: 'operator-recovery',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: 102, status: 'blocked' });
  });

  it('allows direct API status overrides when operator-style authority is supplied via header', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks/102`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-agent-hq-authority-by': 'operator',
      },
      body: JSON.stringify({
        status: 'review',
        changed_by: 'operator-recovery',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: 102, status: 'review' });
  });

  it('allows direct API status overrides when manual-style authority is supplied in the body', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks/102`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        status: 'ready_to_merge',
        changed_by: 'operator-recovery',
        authorized_by: 'manual',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: 102, status: 'ready_to_merge' });
  });

  it('still rejects direct API status edits from automated request actors without manual authority', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks/102`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'done',
        changed_by: 'dispatcher',
      }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('Only Atlas or a human user may change task status through the generic update endpoint'),
    });
  });

  it('keeps task action routes transport-focused while preserving behavior', async () => {
    const pauseRes = await fetch(`${baseUrl}/api/v1/tasks/102/pause`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Waiting on review', changed_by: 'cinder-backend' }),
    });
    expect(pauseRes.status).toBe(200);
    const pauseBody = await pauseRes.json() as Record<string, unknown>;
    expect((pauseBody.task as Record<string, unknown>).pause_reason).toBe('Waiting on review');

    const unpauseRes = await fetch(`${baseUrl}/api/v1/tasks/102/unpause`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changed_by: 'cinder-backend' }),
    });
    expect(unpauseRes.status).toBe(200);
    const unpauseBody = await unpauseRes.json() as Record<string, unknown>;
    expect((unpauseBody.task as Record<string, unknown>).paused_at).toBeNull();

    const reopenRes = await fetch(`${baseUrl}/api/v1/tasks/103/reopen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changed_by: 'cinder-backend' }),
    });
    expect(reopenRes.status).toBe(200);
    const reopenBody = await reopenRes.json() as Record<string, unknown>;
    expect(reopenBody.restored_to).toBe('ready');
    expect((reopenBody.task as Record<string, unknown>).status).toBe('ready');

    const cancelRes = await fetch(`${baseUrl}/api/v1/tasks/101/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changed_by: 'cinder-backend' }),
    });
    expect(cancelRes.status).toBe(200);
    const cancelBody = await cancelRes.json() as Record<string, unknown>;
    expect((cancelBody.task as Record<string, unknown>).status).toBe('cancelled');
  });

  it('keeps note and blocker endpoints intact after the write-model move', async () => {
    const noteRes = await fetch(`${baseUrl}/api/v1/tasks/102/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'cinder-backend', content: 'Durable handoff note.' }),
    });
    expect(noteRes.status).toBe(201);
    const noteBody = await noteRes.json() as Record<string, unknown>;
    expect(noteBody).toMatchObject({ author: 'cinder-backend', content: 'Durable handoff note.' });

    const addBlockerRes = await fetch(`${baseUrl}/api/v1/tasks/102/blockers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blocker_id: 101 }),
    });
    expect(addBlockerRes.status).toBe(200);
    const blockerBody = await addBlockerRes.json() as Record<string, unknown>;
    let blockers = Array.isArray(blockerBody.blockers) ? blockerBody.blockers as Array<Record<string, unknown>> : [];
    expect(blockers.map((task) => task.id)).toContain(101);

    const removeBlockerRes = await fetch(`${baseUrl}/api/v1/tasks/102/blockers/101`, {
      method: 'DELETE',
    });
    expect(removeBlockerRes.status).toBe(200);
    const removeBody = await removeBlockerRes.json() as Record<string, unknown>;
    blockers = Array.isArray(removeBody.blockers) ? removeBody.blockers as Array<Record<string, unknown>> : [];
    expect(blockers).toHaveLength(0);
  });
});
