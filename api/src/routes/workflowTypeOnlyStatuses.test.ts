import { setupTestDb, teardownTestDb } from '../db/testDb';
import express from 'express';
import type { Server } from 'http';
import { getDb } from '../db/client';
import workflowsRouter from './workflows';
import routingRouter from './routing';
import { resolveWorkflowTaskRoutingAssignment, resolveWorkflowTaskTransition } from '../domains/routing/policy/statuses';

let server: Server;
let base: string;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
  await setupTestDb();
  const db = getDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Agency')`);
  await db.run(`INSERT INTO agents (id, tenant_id, name, role, session_key, project_id, enabled) VALUES (7, 1, 'Kepler', 'developer', 'agent:kepler:main', 1, 1)`);
  await db.run(`INSERT INTO workflow_types (tenant_id, key, name, is_system, repo_required, keep_same_agent) VALUES (1, 'devx', 'Dev', 1, 1, 1), (1, 'thin', 'Thin', 0, 0, 0)`);
  for (const [order, key, terminal] of [[0, 'todo', 0], [1, 'in_progress', 0], [2, 'review', 0], [3, 'done', 1]] as const) {
    await db.run(`
      INSERT INTO workflow_type_task_statuses (tenant_id, workflow_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json)
      VALUES (1, 'devx', ?, ?, 'slate', ?, 1, '[]', ?, ?, '{"emoji":"🧪"}')
    `, key, key.toUpperCase(), terminal, order, order === 0 ? 1 : 0);
  }
  await db.run(`
    INSERT INTO workflow_type_task_statuses (tenant_id, workflow_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json)
    VALUES (1, 'thin', 'todo', 'To Do', 'slate', 0, 0, '[]', 0, 1, '{}'), (1, 'thin', 'done', 'Done', 'green', 1, 0, '[]', 1, 0, '{}')
  `);
  await db.run(`INSERT INTO workflow_type_task_types (tenant_id, workflow_type_key, task_type, is_system) VALUES (1, 'devx', 'backend', 1), (1, 'thin', 'backend', 0)`);
  await db.run(`INSERT INTO workflow_type_outcomes (tenant_id, workflow_type_key, task_type, outcome_key, label) VALUES (1, 'devx', NULL, 'approve', 'Approve')`);
  await db.run(`INSERT INTO workflow_type_relationship_types (tenant_id, workflow_type_key, key, label) VALUES (1, 'devx', 'defect_of', 'Defect of')`);
  await db.run(`INSERT INTO task_field_schemas (tenant_id, workflow_type_key, task_type, schema_json) VALUES (1, 'devx', 'backend', '{"fields":[]}')`);
  await db.run(`INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type, status) VALUES (10, 1, 1, 'Internal Tools', 'devx', 'active')`);
  // A type-wide transition (no workflow_id), plus the workflow's own transition and rule.
  await db.run(`
    INSERT INTO workflow_task_transitions (tenant_id, project_id, workflow_id, workflow_type, task_type, from_status, outcome, to_status, enabled, priority, is_protected)
    VALUES (1, 1, NULL, 'devx', 'backend', 'in_progress', 'completed_for_review', 'review', 1, 0, 0),
           (1, 1, 10, 'devx', 'backend', 'review', 'approve', 'done', 1, 5, 0)
  `);
  await db.run(`
    INSERT INTO workflow_task_routing_rules (tenant_id, project_id, workflow_id, workflow_type, task_type, status, agent_id, priority)
    VALUES (1, 1, 10, 'devx', 'backend', 'review', 7, 10)
  `);
  await db.run(`INSERT INTO tasks (id, tenant_id, project_id, workflow_id, title, status, task_type) VALUES (100, 1, 1, 10, 'Fix the CRM', 'review', 'backend')`);

  const app = express();
  app.use(express.json());
  app.use('/api/v1/workflows', workflowsRouter);
  app.use('/api/v1/routing', routingRouter);
  server = await new Promise<Server>(resolve => { const instance = app.listen(0, () => resolve(instance)); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  base = `http://127.0.0.1:${address.port}/api/v1`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  await teardownTestDb();
});

test('a workflow has exactly its type statuses and cannot be given statuses of its own', async () => {
  const listed = await call('GET', '/routing/statuses?workflow_id=10');
  expect(listed.status).toBe(200);
  expect(listed.body.statuses.map((status: { name: string }) => status.name)).toEqual(['todo', 'in_progress', 'review', 'done']);

  const created = await call('POST', '/routing/statuses', { workflow_id: 10, name: 'nda_required', label: 'NDA Required' });
  expect(created.status).toBe(409);
  expect(created.body.error).toContain('/api/v1/workflows/types/devx/statuses');

  // Adding the status to the type gives it to the workflow, everywhere.
  const onType = await call('POST', '/workflows/types/devx/statuses', { name: 'nda_required', label: 'NDA Required' });
  expect(onType.status).toBe(201);
  const metadata = await call('GET', '/workflows/workflow-metadata?workflow_id=10');
  expect(metadata.body.statuses.map((status: { name: string }) => status.name)).toContain('nda_required');
});

test('copy_from creates a full copy of a workflow type', async () => {
  const created = await call('POST', '/workflows/types', { key: 'agency_dev', name: 'Agency Dev', copy_from: 'devx' });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ key: 'agency_dev', name: 'Agency Dev', keep_same_agent: 1 });

  const db = getDb();
  expect(await db.get(`SELECT repo_required, is_system FROM workflow_types WHERE key = 'agency_dev'`)).toEqual({ repo_required: 1, is_system: 0 });
  const statuses = await db.all(`SELECT status_key, terminal, metadata_json, is_system FROM workflow_type_task_statuses WHERE workflow_type_key = 'agency_dev' ORDER BY stage_order`) as Array<Record<string, unknown>>;
  expect(statuses.map((row) => row.status_key)).toEqual(['todo', 'in_progress', 'review', 'done']);
  expect(statuses.find((row) => row.status_key === 'done')).toMatchObject({ terminal: 1, metadata_json: '{"emoji":"🧪"}', is_system: 0 });
  for (const table of ['workflow_type_task_types', 'workflow_type_outcomes', 'workflow_type_relationship_types', 'task_field_schemas']) {
    const n = (await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE workflow_type_key = 'agency_dev'`) as { n: number }).n;
    expect([table, Number(n)]).toEqual([table, 1]);
  }
  // Type-wide routing comes along; the workflow's own rows stay on the workflow.
  expect(await db.all(`SELECT workflow_id, from_status, to_status FROM workflow_task_transitions WHERE workflow_type = 'agency_dev'`))
    .toEqual([{ workflow_id: null, from_status: 'in_progress', to_status: 'review' }]);
  // The source is untouched.
  expect(Number((await db.get(`SELECT COUNT(*) AS n FROM workflow_type_task_statuses WHERE workflow_type_key = 'devx'`) as { n: number }).n)).toBe(4);
});

test('changing a workflow to a compatible type moves its own routing so it keeps working', async () => {
  expect((await call('POST', '/workflows/types', { key: 'agency_dev', name: 'Agency Dev', copy_from: 'devx' })).status).toBe(201);
  const db = getDb();
  expect(await resolveWorkflowTaskTransition(db, 10, 'review', 'approve', 'backend')).toMatchObject({ to_status: 'done' });

  const changed = await call('PUT', '/workflows/10', { workflow_type: 'agency_dev' });
  expect(changed.status).toBe(200);
  expect(changed.body.workflow_type).toBe('agency_dev');

  expect(await db.all(`SELECT workflow_type FROM workflow_task_transitions WHERE workflow_id = 10`)).toEqual([{ workflow_type: 'agency_dev' }]);
  expect(await db.all(`SELECT workflow_type FROM workflow_task_routing_rules WHERE workflow_id = 10`)).toEqual([{ workflow_type: 'agency_dev' }]);
  expect(await resolveWorkflowTaskTransition(db, 10, 'review', 'approve', 'backend')).toMatchObject({ to_status: 'done' });
  expect(await resolveWorkflowTaskTransition(db, 10, 'in_progress', 'completed_for_review', 'backend')).toMatchObject({ to_status: 'review' });
  expect(await resolveWorkflowTaskRoutingAssignment(db, 10, 'backend', 'review')).toEqual({ agent_id: 7 });
  const statuses = await call('GET', '/routing/statuses?workflow_id=10');
  expect(statuses.body.statuses.map((status: { name: string }) => status.name)).toEqual(['todo', 'in_progress', 'review', 'done']);
});

test('changing a workflow to a type that lacks what it uses is refused and changes nothing', async () => {
  const changed = await call('PUT', '/workflows/10', { workflow_type: 'thin' });
  expect(changed.status).toBe(409);
  expect(changed.body).toMatchObject({
    code: 'workflow_type_change_unsafe',
    missing_statuses: ['review'],
    missing_task_types: [],
    inherited_routing: { workflow_task_transitions: 1 },
  });

  const db = getDb();
  expect(await db.get(`SELECT workflow_type FROM workflows WHERE id = 10`)).toEqual({ workflow_type: 'devx' });
  expect(await db.all(`SELECT workflow_type FROM workflow_task_transitions WHERE workflow_id = 10`)).toEqual([{ workflow_type: 'devx' }]);
  expect(await resolveWorkflowTaskRoutingAssignment(db, 10, 'backend', 'review')).toEqual({ agent_id: 7 });
});
