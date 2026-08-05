import express from 'express';
import type { Server } from 'http';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import router from './routing';

/**
 * Routing config changes are recorded, and previews are not.
 *
 * The second half is the subtle one: the audit write runs inside the same transaction as the
 * mutation, so a dry run rolls it back too. Writing the audit row outside that transaction
 * would leave a permanent record claiming a change happened that never did — an audit log
 * that lies is worse than none.
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
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
  await db.run(`INSERT INTO sprint_types (tenant_id, key, name) VALUES (1, 'dev', 'Development')`);
  await db.run(`
    INSERT INTO sprint_type_task_statuses (tenant_id, sprint_type_key, status_key, label, stage_order, is_default_entry)
    VALUES
      (1, 'dev', 'todo', 'To Do', 0, 1),
      (1, 'dev', 'ready', 'Ready', 1, 0)
  `);
  const project = await db.run(`INSERT INTO projects (tenant_id, name, description, context_md) VALUES (1, 'Audit Project', '', '')`);
  const projectId = Number(project.lastInsertId);
  const sprint = await db.run(
    `INSERT INTO sprints (tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value)
     VALUES (1, ?, 'Audit Workflow', '', 'dev', 'active', 'time', '2w')`,
    projectId,
  );
  const sprintId = Number(sprint.lastInsertId);
  await db.run(`
    INSERT INTO sprint_task_statuses (sprint_id, status_key, label, stage_order, is_default_entry)
    VALUES (?, 'todo', 'To Do', 0, 1), (?, 'ready', 'Ready', 1, 0)
  `, sprintId, sprintId);
  const agent = await db.run(
    `INSERT INTO agents (tenant_id, name, session_key, enabled, project_id) VALUES (1, 'Audit Agent', 'audit-agent', 1, ?)`,
    projectId,
  );
  return { projectId, sprintId, agentId: Number(agent.lastInsertId) };
}

interface AuditRow {
  entity_table: string;
  entity_id: number | null;
  action: string;
  actor: string;
  actor_kind: string;
  before_json: string;
  after_json: string;
  changes: string;
  project_id: number | null;
  workflow_type: string;
  workflow_id: number | null;
}

const auditRows = async (): Promise<AuditRow[]> =>
  await getDb().all(`SELECT * FROM routing_config_audit_log ORDER BY id ASC`) as AuditRow[];

const createRule = async (baseUrl: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  await fetch(`${baseUrl}/api/v1/routing/rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('routing config audit', () => {
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

  it('records a created assignment rule with its scope and after-image', async () => {
    const { projectId, sprintId, agentId } = await seedScope();
    const response = await createRule(baseUrl, {
      project_id: projectId, sprint_id: sprintId, sprint_type: 'dev',
      task_type: null, status: 'ready', agent_id: agentId,
    });
    expect(response.status).toBe(201);

    const rows = (await auditRows()).filter((row) => row.entity_table === 'sprint_task_routing_rules');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'created',
      project_id: projectId,
      workflow_type: 'dev',
      workflow_id: sprintId,
    });
    expect(rows[0].entity_id).toBeGreaterThan(0);
    expect(JSON.parse(rows[0].before_json)).toBeNull();
    expect(JSON.parse(rows[0].after_json)).toMatchObject({ status: 'ready', agent_id: agentId });
  });

  it('writes NO audit row for a dry run', async () => {
    const { projectId, sprintId, agentId } = await seedScope();
    await createRule(baseUrl, {
      dry_run: true,
      project_id: projectId, sprint_id: sprintId, sprint_type: 'dev',
      task_type: null, status: 'ready', agent_id: agentId,
    });
    // The audit write is inside the dry run's transaction, so it rolls back with the change.
    expect(await auditRows()).toHaveLength(0);
  });

  it('records the before-image and a field diff on an update', async () => {
    const { projectId, sprintId, agentId } = await seedScope();
    const created = await (await createRule(baseUrl, {
      project_id: projectId, sprint_id: sprintId, sprint_type: 'dev',
      task_type: null, status: 'ready', agent_id: agentId,
    })).json() as { id: number };

    const updated = await fetch(`${baseUrl}/api/v1/routing/rules/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, sprint_id: sprintId, sprint_type: 'dev', priority: 55 }),
    });
    expect(updated.status).toBe(200);

    const rows = (await auditRows()).filter((row) => row.action === 'updated');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].before_json)).toMatchObject({ priority: 0 });
    expect(JSON.parse(rows[0].after_json)).toMatchObject({ priority: 55 });
    expect(Object.keys(JSON.parse(rows[0].changes))).toContain('priority');
  });

  it('keeps the before-image on a delete, where the row is gone by the time it returns', async () => {
    const { projectId, sprintId, agentId } = await seedScope();
    const created = await (await createRule(baseUrl, {
      project_id: projectId, sprint_id: sprintId, sprint_type: 'dev',
      task_type: null, status: 'ready', agent_id: agentId,
    })).json() as { id: number };

    const deleted = await fetch(
      `${baseUrl}/api/v1/routing/rules/${created.id}?project_id=${projectId}&workflow_id=${sprintId}`,
      { method: 'DELETE' },
    );
    expect(deleted.status).toBe(200);

    const rows = (await auditRows()).filter((row) => row.action === 'deleted');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].before_json)).toMatchObject({ status: 'ready' });
    expect(JSON.parse(rows[0].after_json)).toBeNull();
  });

  it('attributes a browser request honestly rather than calling it "api"', async () => {
    const { projectId, sprintId, agentId } = await seedScope();
    await createRule(baseUrl, {
      project_id: projectId, sprint_id: sprintId, sprint_type: 'dev',
      task_type: null, status: 'ready', agent_id: agentId,
    });
    const [row] = await auditRows();
    // There is no user table and no session, so claiming a specific actor would be fiction.
    expect(row.actor).toBe('anonymous_ui');
    expect(row.actor_kind).toBe('unknown');
  });

  it('records an X-Actor header as a user when one is supplied', async () => {
    const { projectId, sprintId, agentId } = await seedScope();
    await createRule(baseUrl, {
      project_id: projectId, sprint_id: sprintId, sprint_type: 'dev',
      task_type: null, status: 'ready', agent_id: agentId,
    }, { 'X-Actor': 'masiah' });
    const [row] = await auditRows();
    expect(row).toMatchObject({ actor: 'masiah', actor_kind: 'user' });
  });

  it('does not record a change that failed validation', async () => {
    const { projectId, sprintId } = await seedScope();
    const response = await createRule(baseUrl, {
      project_id: projectId, sprint_id: sprintId, sprint_type: 'dev',
      task_type: null, status: 'ready', agent_id: 999999,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await auditRows()).toHaveLength(0);
  });
});
