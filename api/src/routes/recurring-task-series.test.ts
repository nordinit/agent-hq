import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { closeDb, getDb } from '../db/client';
import { initSchema } from '../db/schema';
import * as dispatchTrigger from '../services/dispatchTrigger';
import recurringTaskSeriesRouter from './recurring-task-series';
import tasksRouter from './tasks';
import { getDefaultTenantId, setActiveTenantId } from '../lib/tenantContext';

const ORIGINAL_DB_PATH = process.env.AGENT_HQ_DB_PATH;

function restoreEnv(name: string, value: string | undefined): void {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/recurring-task-series', recurringTaskSeriesRouter);
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
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
}

async function seedFixture(): Promise<void> {
  const db = getDb();
  const tenantId = await getDefaultTenantId(db);
  await db.run(`INSERT INTO projects (id, tenant_id, name, description, context_md) VALUES (614, ?, 'Recurring API', '', '')`, tenantId);
  await db.run(`INSERT INTO projects (id, tenant_id, name, description, context_md) VALUES (615, ?, 'Other Project', '', '')`, tenantId);
  await db.run(`
    INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value)
    VALUES
      (6141, ?, 614, 'Fixed Workflow', '', 'recurring_api', 'active', 'time', '2w'),
      (6142, ?, 614, 'Closed Workflow', '', 'recurring_api', 'closed', 'time', '2w'),
      (6151, ?, 615, 'Other Workflow', '', 'recurring_api', 'active', 'time', '2w')
  `, tenantId, tenantId, tenantId);
  await db.run(`
    INSERT INTO agents (id, tenant_id, name, role, session_key, workspace_path, status, preferred_provider)
    VALUES (6143, ?, 'Pinned Cinder', 'Backend Engineer', 'agent:pinned-cinder:test', '/tmp/cinder', 'idle', 'openai-codex')
  `, tenantId);
  await db.run(`INSERT OR IGNORE INTO sprint_types (tenant_id, key, name, is_system) VALUES (?, 'recurring_api', 'Recurring API', 1)`, tenantId);
  await db.run(`DELETE FROM sprint_type_task_types WHERE tenant_id = ? AND sprint_type_key = 'recurring_api'`, tenantId);
  await db.run(`INSERT INTO sprint_type_task_types (tenant_id, sprint_type_key, task_type, is_system) VALUES (?, 'recurring_api', 'backend', 1)`, tenantId);
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project_id: 614,
    sprint_id: 6141,
    title_template: 'Weekly backend maintenance',
    description_template: 'Run maintenance checks.',
    task_type: 'backend',
    priority: 'high',
    story_points: 3,
    status_on_create: 'ready',
    schedule: 'every monday 09:00',
    timezone: 'America/New_York',
    enabled: true,
    overlap_policy: 'skip_if_active',
    agent_id: 6143,
    ...overrides,
  };
}

describe('recurring task series API', () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;
  let triggerDispatchSpy: jest.SpyInstance;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recurring-task-series-route-'));
    process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq.db');
    closeDb();
    await initSchema();
    await seedFixture();
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

  async function createSeries(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const res = await fetch(`${baseUrl}/api/v1/recurring-task-series`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validPayload(overrides)),
    });
    expect(res.status).toBe(201);
    return await res.json() as Record<string, unknown>;
  }

  it('creates, reads, updates, disables, enables, previews, and deletes a fixed-workflow recurring series', async () => {
    const created = await createSeries();
    expect(created).toMatchObject({
      project_id: 614,
      sprint_id: 6141,
      task_type: 'backend',
      status_on_create: 'ready',
      enabled: true,
      schedule: 'every monday 09:00',
      project_name: 'Recurring API',
      sprint_name: 'Fixed Workflow',
      workflow_id: 6141,
      workflow_name: 'Fixed Workflow',
      agent_id: 6143,
      agent_pin: expect.objectContaining({ behavior: 'optional_pinned_assignment' }),
    });
    expect(typeof created.next_run_at).toBe('string');

    const id = created.id;
    const detailRes = await fetch(`${baseUrl}/api/v1/recurring-task-series/${id}`);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json() as Record<string, unknown>;
    expect(detail.runs).toEqual([]);

    const updateRes = await fetch(`${baseUrl}/api/v1/recurring-task-series/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title_template: 'Daily backend maintenance', schedule: 'every day 10:30', updated_by: 'test' }),
    });
    expect(updateRes.status).toBe(200);
    await expect(updateRes.json()).resolves.toMatchObject({
      title_template: 'Daily backend maintenance',
      schedule: 'every day 10:30',
    });

    const disableRes = await fetch(`${baseUrl}/api/v1/recurring-task-series/${id}/disable`, { method: 'POST' });
    expect(disableRes.status).toBe(200);
    await expect(disableRes.json()).resolves.toMatchObject({ enabled: false, next_run_at: null });

    const enableRes = await fetch(`${baseUrl}/api/v1/recurring-task-series/${id}/enable`, { method: 'POST' });
    expect(enableRes.status).toBe(200);
    const enabled = await enableRes.json() as Record<string, unknown>;
    expect(enabled.enabled).toBe(true);
    expect(typeof enabled.next_run_at).toBe('string');

    const previewRes = await fetch(`${baseUrl}/api/v1/recurring-task-series/${id}/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: 3 }),
    });
    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json() as { occurrences: string[] };
    expect(preview.occurrences).toHaveLength(3);

    const deleteRes = await fetch(`${baseUrl}/api/v1/recurring-task-series/${id}`, { method: 'DELETE' });
    expect(deleteRes.status).toBe(200);
    await expect(deleteRes.json()).resolves.toEqual({ ok: true, deleted_id: id });
  });

  it('accepts workflow_id as the fixed workflow alias while preserving sprint fields', async () => {
    const created = await createSeries({ workflow_id: 6141, sprint_id: undefined });
    expect(created).toMatchObject({
      project_id: 614,
      sprint_id: 6141,
      workflow_id: 6141,
      workflow_name: 'Fixed Workflow',
      task_type: 'backend',
      status_on_create: 'ready',
    });

    const res = await fetch(`${baseUrl}/api/v1/recurring-task-series?project_id=614&workflow_id=6141`);
    expect(res.status).toBe(200);
    const body = await res.json() as { total: number; series: Array<Record<string, unknown>> };
    expect(body.total).toBe(1);
    expect(body.series[0]).toMatchObject({ id: created.id, sprint_id: 6141, workflow_id: 6141 });
  });

  it('lists and filters by project, workflow, enabled state, and next_run_at window', async () => {
    const enabled = await createSeries({ schedule: 'every day 09:00' });
    await createSeries({ title_template: 'Disabled daily', enabled: false, schedule: 'every day 12:00' });

    const nextRun = String(enabled.next_run_at);
    const from = new Date(new Date(nextRun).getTime() - 60_000).toISOString();
    const to = new Date(new Date(nextRun).getTime() + 60_000).toISOString();
    const res = await fetch(`${baseUrl}/api/v1/recurring-task-series?project_id=614&sprint_id=6141&enabled=true&next_run_from=${encodeURIComponent(from)}&next_run_to=${encodeURIComponent(to)}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { series: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    expect(body.series[0]).toMatchObject({ id: enabled.id, enabled: true });
  });

  it('creates and updates minute-level recurring schedules', async () => {
    const created = await createSeries({ schedule: 'every 15 minutes' });
    expect(created).toMatchObject({
      schedule: 'every 15 minutes',
      schedule_expression: 'every 15 minutes',
    });
    expect(typeof created.next_run_at).toBe('string');

    const updateRes = await fetch(`${baseUrl}/api/v1/recurring-task-series/${created.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedule_expression: 'every 30 minutes', updated_by: 'test' }),
    });
    expect(updateRes.status).toBe(200);
    await expect(updateRes.json()).resolves.toMatchObject({
      schedule: 'every 30 minutes',
      schedule_expression: 'every 30 minutes',
    });
  });

  it('rejects unsupported minute schedule intervals', async () => {
    for (const schedule of ['every 0 minutes', 'every -5 minutes', 'every 4 minutes', 'every 1441 minutes']) {
      const res = await fetch(`${baseUrl}/api/v1/recurring-task-series`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validPayload({ schedule })),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      expect(['schedule_invalid', 'schedule_interval_invalid']).toContain(body.code);
    }
  });

  it('rejects generated-task story points that normal task creation cannot use', async () => {
    for (const storyPoints of [0, 4]) {
      const createRes = await fetch(`${baseUrl}/api/v1/recurring-task-series`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validPayload({ story_points: storyPoints })),
      });
      expect(createRes.status).toBe(400);
      await expect(createRes.json()).resolves.toMatchObject({
        code: 'story_points_invalid',
        error: expect.stringContaining(`Invalid story_points "${storyPoints}"`),
      });

      const series = await createSeries();
      const updateRes = await fetch(`${baseUrl}/api/v1/recurring-task-series/${series.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ story_points: storyPoints }),
      });
      expect(updateRes.status).toBe(400);
      await expect(updateRes.json()).resolves.toMatchObject({
        code: 'story_points_invalid',
        error: expect.stringContaining(`Invalid story_points "${storyPoints}"`),
      });
    }
  });

  it('rejects invalid project/workflow, schedule, timezone, status, and task type combinations', async () => {
    for (const [override, code] of [
      [{ sprint_id: 6151 }, 'workflow_project_mismatch'],
      [{ sprint_id: 6142 }, 'fixed_workflow_unavailable'],
      [{ schedule: 'weekly on monday' }, 'schedule_invalid'],
      [{ timezone: 'Mars/Olympus' }, 'timezone_invalid'],
      [{ status_on_create: 'not_real' }, 'status_on_create_unsupported'],
      [{ task_type: 'qa' }, 'task_type_not_allowed_for_sprint_type'],
    ] as Array<[Record<string, unknown>, string]>) {
      const res = await fetch(`${baseUrl}/api/v1/recurring-task-series`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validPayload(override)),
      });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ code });
    }
  });

  it('runs now through normal task creation, records history, and does not directly create an agent run', async () => {
    const series = await createSeries({ status_on_create: 'ready' });
    const res = await fetch(`${baseUrl}/api/v1/recurring-task-series/${series.id}/run-now`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changed_by: 'route-test' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, Record<string, unknown>>;
    expect(body.run).toMatchObject({ series_id: series.id, status: 'created' });
    expect(body.task).toMatchObject({
      title: 'Weekly backend maintenance',
      project_id: 614,
      sprint_id: 6141,
      agent_id: null,
      assigned_agent_id: 6143,
      status: 'ready',
      recurring_series_id: series.id,
      generated_from: 'recurring_task_series',
      url: `/tasks/${body.task.id}`,
    });
    expect(triggerDispatchSpy).toHaveBeenCalledWith(614);
    expect(await getDb().get(`SELECT COUNT(*) AS count FROM job_instances`)).toEqual({ count: 0 });

    const historyRes = await fetch(`${baseUrl}/api/v1/recurring-task-series/${series.id}/history`);
    expect(historyRes.status).toBe(200);
    const history = await historyRes.json() as { runs: Array<Record<string, unknown>> };
    expect(history.runs[0]).toMatchObject({
      status: 'created',
      generated_task: expect.objectContaining({ id: body.task.id, url: `/tasks/${body.task.id}` }),
    });
  });

  it('isolates recurring series and generated task history by tenant context', async () => {
    const db = getDb();
    const defaultTenantId = await getDefaultTenantId(db);
    const ecoPoolTenantId = Number((await db.run(`
      INSERT INTO tenants (name, slug, is_default)
      VALUES ('EcoPool', 'ecopool', 0)
    `)).lastInsertRowid);
    await db.run(`
      INSERT INTO projects (id, tenant_id, name, description, context_md)
      VALUES (714, ?, 'EcoPool', '', '')
    `, ecoPoolTenantId);
    await db.run(`
      INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value)
      VALUES (7141, ?, 714, 'EcoPool Workflow', '', 'recurring_api', 'active', 'time', '2w')
    `, ecoPoolTenantId);
    await db.run(`
      INSERT INTO agents (id, tenant_id, name, role, session_key, workspace_path, status, preferred_provider)
      VALUES (7143, ?, 'EcoPool Agent', 'Backend Engineer', 'agent:ecopool:test', '/tmp/ecopool', 'idle', 'openai-codex')
    `, ecoPoolTenantId);
    await db.run(`INSERT OR IGNORE INTO sprint_types (tenant_id, key, name, is_system) VALUES (?, 'recurring_api', 'Recurring API', 1)`, ecoPoolTenantId);
    await db.run(`INSERT INTO sprint_type_task_types (tenant_id, sprint_type_key, task_type, is_system) VALUES (?, 'recurring_api', 'backend', 1)`, ecoPoolTenantId);

    const defaultSeries = await createSeries({ title_template: 'Default weekly maintenance' });
    await setActiveTenantId(db, ecoPoolTenantId);
    const ecoRes = await fetch(`${baseUrl}/api/v1/recurring-task-series`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validPayload({
        project_id: 714,
        sprint_id: 7141,
        title_template: 'EcoPool weekly maintenance',
        agent_id: 7143,
      })),
    });
    expect(ecoRes.status).toBe(201);
    const ecoSeries = await ecoRes.json() as Record<string, unknown>;

    await setActiveTenantId(db, defaultTenantId);
    const defaultRunRes = await fetch(`${baseUrl}/api/v1/recurring-task-series/${defaultSeries.id}/run-now`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changed_by: 'route-test' }),
    });
    expect(defaultRunRes.status).toBe(201);

    await setActiveTenantId(db, ecoPoolTenantId);
    const ecoList = await fetch(`${baseUrl}/api/v1/recurring-task-series`);
    expect(ecoList.status).toBe(200);
    const ecoListBody = await ecoList.json() as { series: Array<Record<string, unknown>>; total: number };
    expect(ecoListBody.series.map(series => series.title_template)).toEqual(['EcoPool weekly maintenance']);
    expect(ecoListBody.series.map(series => series.title_template)).not.toContain('Default weekly maintenance');

    await expect(fetch(`${baseUrl}/api/v1/recurring-task-series/${defaultSeries.id}`)).resolves.toMatchObject({ status: 404 });
    await expect(fetch(`${baseUrl}/api/v1/recurring-task-series/${defaultSeries.id}/history`)).resolves.toMatchObject({ status: 404 });
    const ecoTasks = await fetch(`${baseUrl}/api/v1/tasks?include_closed=true`);
    expect(ecoTasks.status).toBe(200);
    const ecoTaskBody = await ecoTasks.json() as Array<Record<string, unknown>>;
    expect(ecoTaskBody.map(task => task.title)).not.toContain('Default weekly maintenance');

    await setActiveTenantId(db, defaultTenantId);
    const defaultList = await fetch(`${baseUrl}/api/v1/recurring-task-series`);
    expect(defaultList.status).toBe(200);
    const defaultListBody = await defaultList.json() as { series: Array<Record<string, unknown>>; total: number };
    expect(defaultListBody.series.map(series => series.title_template)).toContain('Default weekly maintenance');
    expect(defaultListBody.series.map(series => series.title_template)).not.toContain('EcoPool weekly maintenance');

    await expect(fetch(`${baseUrl}/api/v1/recurring-task-series/${ecoSeries.id}/run-now`, {
      method: 'POST',
    })).resolves.toMatchObject({ status: 404 });
  });
});
