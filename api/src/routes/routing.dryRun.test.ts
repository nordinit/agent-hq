import express from 'express';
import type { Server } from 'http';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb, usingPostgres } from '../db/testDb';
import router from './routing';

/**
 * dry_run must not persist. This file exists because the previous implementation issued
 * SAVEPOINT / ROLLBACK TO / RELEASE as three separate statements on the POOLED handle,
 * which PostgreSQL rejects outright ("SAVEPOINT can only be used in transaction blocks")
 * and which could not have worked anyway, since each statement on a pooled handle may
 * land on a different connection.
 *
 * That bug shipped and stayed green: routing.test.ts hand-builds an in-memory SQLite
 * database and asserts `dry_run === true`, and SQLite auto-begins a transaction so the
 * savepoint is legal there. The whole class of defect is invisible to a SQLite-only
 * suite, which is why this file goes through setupTestDb() — run it with
 * AGENT_HQ_TEST_PG_URL set and it exercises the engine production actually uses.
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
  const project = await db.run(
    `INSERT INTO projects (name, description, context_md) VALUES ('DryRun Project', '', '')`,
  );
  const projectId = Number(project.lastInsertId);
  const sprint = await db.run(
    `INSERT INTO sprints (project_id, name, goal, sprint_type, status, length_kind, length_value)
     VALUES (?, 'DryRun Workflow', '', 'dev', 'active', 'time', '2w')`,
    projectId,
  );
  const sprintId = Number(sprint.lastInsertId);
  const agent = await db.run(
    `INSERT INTO agents (name, session_key, enabled, project_id) VALUES ('DryRun Agent', 'dryrun-agent', 1, ?)`,
    projectId,
  );
  return { projectId, sprintId, agentId: Number(agent.lastInsertId) };
}

async function countRules(): Promise<number> {
  const row = await getDb().get(`SELECT COUNT(*) AS n FROM sprint_task_routing_rules`) as { n: number | string };
  return Number(row.n);
}

/**
 * The first request of a process triggers tenant bootstrap via resolveTenantIdFromRequest
 * -> ensureTenantSchema, which seeds default policy rows on the POOLED handle, outside any
 * transaction the handler later opens. Baselining before that runs attributes ~37 seeded
 * rows to the dry run and reports a leak that is not there. Warm it with a read first.
 */
async function warmTenantBootstrap(baseUrl: string, projectId: number): Promise<void> {
  const response = await fetch(`${baseUrl}/api/v1/routing/rules?project_id=${projectId}&workflow_type=dev`);
  if (!response.ok) throw new Error(`tenant warm-up failed: ${response.status}`);
}

describe('routing dry_run does not persist', () => {
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

  it(`rolls a previewed assignment rule back on ${usingPostgres() ? 'postgres' : 'sqlite'}`, async () => {
    const { projectId, sprintId, agentId } = await seedScope();
    await warmTenantBootstrap(baseUrl, projectId);
    const before = await countRules();

    const response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dry_run: true,
        project_id: projectId,
        sprint_id: sprintId,
        sprint_type: 'dev',
        task_type: null,
        status: 'ready',
        agent_id: agentId,
      }),
    });

    // A 500 here is the original bug: SAVEPOINT outside a transaction block.
    const body = await response.json() as { dry_run?: boolean; error?: string; preview?: { action?: string; affected?: unknown } };
    expect({ status: response.status, error: body.error }).toEqual({ status: 200, error: undefined });
    expect(body.dry_run).toBe(true);
    expect(body.preview?.action).toBe('create');
    expect(body.preview?.affected).toBeTruthy();

    // The actual invariant. Everything above can pass while the row is committed.
    expect(await countRules()).toBe(before);
  });

  it('still persists when dry_run is absent, so the rollback is not swallowing real writes', async () => {
    const { projectId, sprintId, agentId } = await seedScope();
    await warmTenantBootstrap(baseUrl, projectId);
    const before = await countRules();

    const response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: projectId,
        sprint_id: sprintId,
        sprint_type: 'dev',
        task_type: null,
        status: 'ready',
        agent_id: agentId,
      }),
    });

    expect(response.status).toBe(201);
    expect(await countRules()).toBeGreaterThan(before);
  });

  it('surfaces a validation failure as an error rather than a successful preview', async () => {
    const { projectId, sprintId } = await seedScope();
    await warmTenantBootstrap(baseUrl, projectId);
    const before = await countRules();

    // agent_id 999999 does not exist. The sentinel that carries a preview out of the
    // transaction is caught by instanceof; a shape-based catch would turn this into a 200.
    const response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dry_run: true,
        project_id: projectId,
        sprint_id: sprintId,
        sprint_type: 'dev',
        task_type: null,
        status: 'ready',
        agent_id: 999999,
      }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = await response.json() as { dry_run?: boolean; error?: string };
    expect(body.dry_run).toBeUndefined();
    expect(typeof body.error).toBe('string');
    expect(await countRules()).toBe(before);
  });

  it('leaves the connection usable after a preview, so a later write still works', async () => {
    // A botched rollback can leave a PostgreSQL connection in the aborted-transaction
    // state (25P02), where every subsequent statement fails. The symptom is the NEXT
    // request failing, not this one.
    const { projectId, sprintId, agentId } = await seedScope();
    await warmTenantBootstrap(baseUrl, projectId);
    const before = await countRules();

    await fetch(`${baseUrl}/api/v1/routing/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dry_run: true, project_id: projectId, sprint_id: sprintId, sprint_type: 'dev',
        task_type: null, status: 'ready', agent_id: agentId,
      }),
    });

    const after = await fetch(`${baseUrl}/api/v1/routing/rules?project_id=${projectId}&workflow_type=dev`);
    expect(after.status).toBe(200);
    expect(await countRules()).toBe(before);
  });
});
