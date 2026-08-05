import express from 'express';
import type { Server } from 'http';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import router from './routing';

/**
 * The preview endpoint applies real mutations inside a transaction that never commits, then
 * reports the lint delta. Two things have to hold or it is worse than useless: it must not
 * persist anything, and its row counts must reflect what a real write would actually do —
 * including every row written by the requested routing operation.
 */

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/routing', router);
  const server = await new Promise<Server>((resolve) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function seedScope(): Promise<{ projectId: number; sprintId: number; agentId: number }> {
  const db = getDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Preview Tenant', 'preview', 1)`);
  await db.run(`
    INSERT INTO app_settings (key, value)
    VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')
  `);
  await db.run(`
    INSERT INTO task_statuses (name, label, terminal, is_system)
    VALUES ('ready', 'Ready', 0, 1)
  `);
  await db.run(`
    INSERT INTO sprint_types (tenant_id, key, name, status_seeded_at, repo_required)
    VALUES (1, 'dev', 'Development', '2026-08-05T00:00:00.000Z', 0)
  `);
  await db.run(`
    INSERT INTO sprint_type_task_statuses
      (tenant_id, sprint_type_key, status_key, label, terminal, is_system, stage_order, is_default_entry)
    VALUES (1, 'dev', 'ready', 'Ready', 0, 1, 0, 1)
  `);
  const project = await db.run(`INSERT INTO projects (tenant_id, name, description, context_md) VALUES (1, 'Preview Project', '', '')`);
  const projectId = Number(project.lastInsertId);
  const sprint = await db.run(
    `INSERT INTO sprints (tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value)
     VALUES (1, ?, 'Preview Workflow', '', 'dev', 'active', 'time', '2w')`,
    projectId,
  );
  const sprintId = Number(sprint.lastInsertId);
  await db.run(`
    INSERT INTO sprint_task_statuses
      (sprint_id, status_key, label, terminal, is_system, stage_order, is_default_entry)
    VALUES (?, 'ready', 'Ready', 0, 1, 0, 1)
  `, sprintId);
  const agent = await db.run(
    `INSERT INTO agents (tenant_id, name, session_key, enabled, project_id) VALUES (1, 'Preview Agent', 'preview-agent', 1, ?)`,
    projectId,
  );
  return { projectId, sprintId, agentId: Number(agent.lastInsertId) };
}

async function countRules(): Promise<number> {
  const row = await getDb().get(`SELECT COUNT(*) AS n FROM sprint_task_routing_rules`) as { n: number | string };
  return Number(row.n);
}

/** Primes the read endpoint before measuring the preview transaction. */
async function primeRoutingRead(baseUrl: string, projectId: number): Promise<void> {
  const response = await fetch(`${baseUrl}/api/v1/routing/rules?project_id=${projectId}&workflow_type=dev`);
  if (!response.ok) throw new Error(`routing read failed: ${response.status} ${await response.text()}`);
}

type PreviewBody = {
  error?: string;
  operations?: Array<{ entity: string; action: string; affected: unknown }>;
  introduced?: Array<{ code: string; node?: string; edge?: string }>;
  resolved?: Array<{ code: string }>;
  before?: { warn_count: number; error_count: number };
  after?: { warn_count: number; error_count: number };
  rows_written?: Array<{ table: string; delta: number }>;
  affects_workflows?: { total: number; scope: string };
};

const preview = async (baseUrl: string, body: unknown): Promise<{ status: number; body: PreviewBody }> => {
  const response = await fetch(`${baseUrl}/api/v1/routing/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as PreviewBody };
};

describe('routing preview', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    await setupTestDb();
    ({ server, baseUrl } = await startServer());
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await teardownTestDb();
  });

  it('does not persist the change it previews', async () => {
    const { projectId, sprintId, agentId } = await seedScope();
    await primeRoutingRead(baseUrl, projectId);
    const before = await countRules();

    const { status, body } = await preview(baseUrl, {
      project_id: projectId,
      workflow_id: sprintId,
      workflow_type: 'dev',
      operations: [{
        entity: 'rule',
        action: 'create',
        payload: { project_id: projectId, sprint_id: sprintId, sprint_type: 'dev', task_type: null, status: 'ready', agent_id: agentId },
      }],
    });

    expect({ status, error: body.error }).toEqual({ status: 200, error: undefined });
    expect(body.operations).toHaveLength(1);
    expect(await countRules()).toBe(before);
  });

  it('reports the rows a write would actually touch, not just the operation count', async () => {
    // Report actual table deltas rather than equating one requested operation with one row.
    const { projectId, sprintId, agentId } = await seedScope();
    await primeRoutingRead(baseUrl, projectId);

    const { body } = await preview(baseUrl, {
      project_id: projectId,
      workflow_id: sprintId,
      workflow_type: 'dev',
      operations: [{
        entity: 'rule',
        action: 'create',
        payload: { project_id: projectId, sprint_id: sprintId, sprint_type: 'dev', task_type: null, status: 'ready', agent_id: agentId },
      }],
    });

    const written = body.rows_written ?? [];
    const rules = written.find((entry) => entry.table === 'sprint_task_routing_rules');
    expect(rules?.delta).toBeGreaterThanOrEqual(1);
    expect(written.every((entry) => entry.delta !== 0)).toBe(true);
  });

  it('reports how many workflows a workflow-type default reaches', async () => {
    const { projectId, agentId } = await seedScope();
    await primeRoutingRead(baseUrl, projectId);
    // A second workflow of the same type, so the count is meaningfully greater than one.
    await getDb().run(
      `INSERT INTO sprints (tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value)
       VALUES (1, ?, 'Second Workflow', '', 'dev', 'active', 'time', '2w')`,
      projectId,
    );

    const { body } = await preview(baseUrl, {
      project_id: projectId,
      workflow_type: 'dev',
      operations: [{
        entity: 'rule',
        action: 'create',
        payload: { project_id: projectId, sprint_type: 'dev', scope_kind: 'sprint_type_default', task_type: null, status: 'ready', agent_id: agentId },
      }],
    });

    expect(body.affects_workflows?.scope).toBe('workflow_type');
    expect(body.affects_workflows?.total).toBe(2);
  });

  it('surfaces a validation failure as an error, not an empty preview', async () => {
    const { projectId, sprintId } = await seedScope();
    await primeRoutingRead(baseUrl, projectId);
    const before = await countRules();

    const { status, body } = await preview(baseUrl, {
      project_id: projectId,
      workflow_id: sprintId,
      workflow_type: 'dev',
      operations: [{
        entity: 'rule',
        action: 'create',
        payload: { project_id: projectId, sprint_id: sprintId, sprint_type: 'dev', task_type: null, status: 'ready', agent_id: 999999 },
      }],
    });

    expect(status).toBeGreaterThanOrEqual(400);
    expect(typeof body.error).toBe('string');
    expect(await countRules()).toBe(before);
  });

  it('rejects an unknown operation rather than silently ignoring it', async () => {
    const { projectId, sprintId } = await seedScope();
    await primeRoutingRead(baseUrl, projectId);
    const { status, body } = await preview(baseUrl, {
      project_id: projectId,
      workflow_id: sprintId,
      workflow_type: 'dev',
      operations: [{ entity: 'status', action: 'delete', payload: {} }],
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/Unsupported operation/);
  });

  it('requires at least one operation', async () => {
    const { projectId, sprintId } = await seedScope();
    await primeRoutingRead(baseUrl, projectId);
    const { status } = await preview(baseUrl, {
      project_id: projectId, workflow_id: sprintId, workflow_type: 'dev', operations: [],
    });
    expect(status).toBe(400);
  });

  it('leaves the connection usable afterwards', async () => {
    // A botched rollback leaves a PostgreSQL connection in the aborted-transaction state,
    // where the symptom is the NEXT request failing rather than this one.
    const { projectId, sprintId, agentId } = await seedScope();
    await primeRoutingRead(baseUrl, projectId);

    await preview(baseUrl, {
      project_id: projectId,
      workflow_id: sprintId,
      workflow_type: 'dev',
      operations: [{
        entity: 'rule',
        action: 'create',
        payload: { project_id: projectId, sprint_id: sprintId, sprint_type: 'dev', task_type: null, status: 'ready', agent_id: agentId },
      }],
    });

    const after = await fetch(`${baseUrl}/api/v1/routing/graph?project_id=${projectId}&workflow_type=dev`);
    expect(after.status).toBe(200);
  });
});
