import { setupTestDb, teardownTestDb } from '../db/testDb';
import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../db/client';
import projectsRouter from './projects';
import agentsRouter from './agents';
import { listTasks } from '../domains/tasks/readModel';
import { listWorkflows } from '../domains/workflows/readModel';

jest.mock('../services/dispatchTrigger', () => ({ triggerDispatch: jest.fn() }));

let tempDir: string;
let server: Server;
let baseUrl: string;
const ORIGINAL_OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH;

async function api(method: string, url: string, root = '/api/v1/projects'): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${root}${url}`, { method });
  return { status: response.status, body: await response.json() };
}

const ids = (rows: any): number[] => (rows as Array<{ id: number }>).map((row) => Number(row.id)).sort((a, b) => a - b);

beforeEach(async () => {
  await setupTestDb();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-archive-'));
  process.env.OPENCLAW_CONFIG_PATH = path.join(tempDir, 'openclaw.json');
  const db = getDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1'), ('default_project_id', '1')`);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Keep'), (2, 1, 'Old client')`);
  await db.run(`INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type) VALUES (20, 1, 2, 'Old workflow', 'generic')`);
  await db.run(`INSERT INTO tasks (id, tenant_id, project_id, workflow_id, title, status) VALUES (200, 1, 2, 20, 'Old task', 'todo')`);
  // Agent 21 has run history, so deleting it soft-deletes it; agent 22 has none and is removed.
  await db.run(`INSERT INTO agents (id, tenant_id, project_id, name, session_key, status) VALUES
    (21, 1, 2, 'Veteran', 'agent:veteran:main', 'idle'), (22, 1, 2, 'Newcomer', 'agent:newcomer:main', 'idle')`);
  await db.run(`INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status) VALUES (900, 1, 21, 200, 'done')`);

  const app = express();
  app.use(express.json());
  app.use('/api/v1/projects', projectsRouter);
  app.use('/api/v1/agents', agentsRouter);
  server = await new Promise<Server>((resolve, reject) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
    bound.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await teardownTestDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (ORIGINAL_OPENCLAW_CONFIG_PATH === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
  else process.env.OPENCLAW_CONFIG_PATH = ORIGINAL_OPENCLAW_CONFIG_PATH;
});

describe('project archive', () => {
  it('moves a project between the active and archived lists', async () => {
    const archived = await api('POST', '/2/archive');
    expect(archived.status).toBe(200);
    expect(archived.body.project.archived_at).toBeTruthy();
    expect(archived.body.running_instances).toBe(0);

    expect((await api('GET', '')).body.map((p: any) => p.id)).toEqual([1]);
    expect((await api('GET', '?archived=true')).body.map((p: any) => p.id)).toEqual([2]);
    expect((await api('GET', '?include_archived=true')).body.map((p: any) => p.id).sort()).toEqual([1, 2]);
    // Opening an archived project directly still works, so the archive page can show it.
    expect((await api('GET', '/2')).status).toBe(200);

    // Archiving twice is harmless and keeps the original time.
    expect((await api('POST', '/2/archive')).body.project.archived_at).toEqual(archived.body.project.archived_at);

    const restored = await api('POST', '/2/unarchive');
    expect(restored.status).toBe(200);
    expect(restored.body.project.archived_at).toBeNull();
    expect((await api('GET', '')).body.map((p: any) => p.id).sort()).toEqual([1, 2]);
  });

  it('keeps the default project active', async () => {
    expect(await api('POST', '/1/archive')).toMatchObject({ status: 409, body: { code: 'project_is_default' } });
    await api('POST', '/2/archive');
    expect(await api('PUT', '/2/default')).toMatchObject({ status: 409, body: { code: 'project_archived' } });
  });

  it('deletes only archived projects', async () => {
    expect(await api('DELETE', '/2')).toMatchObject({ status: 409, body: { code: 'project_not_archived' } });
    expect(await getDb().value('SELECT count(*) FROM projects WHERE id = 2')).toBe(1);
  });

  it('refuses to delete while a run is in flight', async () => {
    await api('POST', '/2/archive');
    await getDb().run(`UPDATE job_instances SET status = 'running' WHERE id = 900`);
    expect(await api('DELETE', '/2')).toMatchObject({ status: 409, body: { code: 'project_has_running_instances', running_instances: 1 } });
  });

  it('deletes an archived project with its workflows, tasks and agents', async () => {
    await api('POST', '/2/archive');
    const deleted = await api('DELETE', '/2');
    expect(deleted).toMatchObject({ status: 200, body: { deleted: true, agents_deleted: 1, agents_archived: 1 } });

    const db = getDb();
    expect(await db.value('SELECT count(*) FROM projects WHERE id = 2')).toBe(0);
    expect(await db.value('SELECT count(*) FROM workflows WHERE project_id = 2')).toBe(0);
    expect(await db.value('SELECT count(*) FROM tasks WHERE id = 200')).toBe(0);
    expect(await db.value('SELECT count(*) FROM agents WHERE id = 22')).toBe(0);
    // The agent with run history stays as a soft-deleted row, so its runs keep their agent.
    expect(await db.get('SELECT enabled, deleted_at IS NOT NULL AS deleted FROM agents WHERE id = 21'))
      .toEqual({ enabled: 0, deleted: true });
    expect(await db.value('SELECT agent_id FROM job_instances WHERE id = 900')).toBe(21);
    // The other project is untouched.
    expect(await db.value('SELECT count(*) FROM projects WHERE id = 1')).toBe(1);
  });

  it('hides archived contents from all-projects lists, but not from the project itself', async () => {
    const db = getDb();
    await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (3, 1, 'Active')`);
    await db.run(`INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type) VALUES (30, 1, 3, 'Active workflow', 'generic')`);
    await db.run(`INSERT INTO tasks (id, tenant_id, project_id, workflow_id, title, status) VALUES (300, 1, 3, 30, 'Active task', 'todo')`);
    await db.run(`INSERT INTO agents (id, tenant_id, project_id, name, session_key, status) VALUES (31, 1, 3, 'Active agent', 'agent:active:main', 'idle')`);
    await db.run(`INSERT INTO agents (id, tenant_id, project_id, name, session_key, status, system_role)
      VALUES (23, 1, 2, 'Atlas', 'agent:atlas:main', 'idle', 'atlas')`);
    await api('POST', '/2/archive');

    expect(ids(await listTasks(db, { tenant_id: 1 }))).toEqual([300]);
    expect(ids(await listTasks(db, { tenant_id: 1, project_id: 2 }))).toEqual([200]);
    expect(ids(await listTasks(db, { tenant_id: 1, workflow_id: 20 }))).toEqual([200]);
    expect(ids(await listTasks(db, { tenant_id: 1, include_archived: 'true' }))).toEqual([200, 300]);
    expect(ids(await listWorkflows(db, { tenant_id: 1 }))).toEqual([30]);
    expect(ids(await listWorkflows(db, { tenant_id: 1, project_id: 2 }))).toEqual([20]);

    // Atlas stays in the all-projects agent list, which the chat surfaces search for it.
    expect(ids((await api('GET', '', '/api/v1/agents')).body)).toEqual([23, 31]);
    expect(ids((await api('GET', '?project_id=2', '/api/v1/agents')).body)).toEqual([21, 22, 23]);
  });

  it('keeps Atlas when its project is deleted, moving it out of the project', async () => {
    const db = getDb();
    await db.run(`INSERT INTO agents (id, tenant_id, project_id, name, session_key, status, system_role)
      VALUES (23, 1, 2, 'Atlas', 'agent:atlas:main', 'idle', 'atlas')`);
    await api('POST', '/2/archive');
    expect(await api('DELETE', '/2')).toMatchObject({ status: 200, body: { agents_kept: ['Atlas'], agents_deleted: 1, agents_archived: 1 } });
    expect(await db.get('SELECT project_id, deleted_at FROM agents WHERE id = 23')).toEqual({ project_id: null, deleted_at: null });
  });
});
