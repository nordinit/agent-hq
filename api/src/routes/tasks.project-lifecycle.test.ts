import express from 'express';
import type { Server } from 'http';
import type { Db } from '../db/adapter/types';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { authorizeMcpApiRequestIfPresent, issueMcpApiKeyForAgent, replaceAgentMcpPermissionPolicy, resolveMcpApiIdentityForKey } from '../lib/mcpApiAuth';
// Requests authenticate as the operator unless they carry an MCP key of their own.
import { authenticateTestApiRequest, operatorFetch as fetch } from '../lib/testApiAuth';
import { postTaskOutcome } from '../domains/tasks/release';
import * as taskReadModel from '../domains/tasks/readModel';
import tasksRouter from './tasks';

jest.mock('../domains/tasks/mutations', () => ({ ...jest.requireActual('../domains/tasks/mutations'), maybeTriggerDispatch: jest.fn() }));
jest.mock('../integrations/telegram', () => ({ notifyTelegram: jest.fn() }));

let db: Db;
let server: Server | undefined;
let baseUrl: string;
let apiKey: string;
const summary = 'Closed stuck occurrence after validating CRM evidence';
const proof = 'https://crm.example.com/leads/123';

beforeEach(async () => {
  server = undefined;
  db = await setupTestDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Test', 'test', 1), (2, 'Other', 'other', 0)`);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Agency'), (2, 1, 'Other project'), (3, 2, 'Other tenant')`);
  await db.run(`INSERT INTO workflow_types (tenant_id, key, name) VALUES (1, 'lead_generation', 'Lead Generation')`);
  await db.run(`INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type)
    VALUES (10, 1, 1, 'Leads', 'lead_generation'), (11, 1, 2, 'Other leads', 'lead_generation'), (12, 2, 3, 'Tenant leads', 'lead_generation')`);
  await db.run(`INSERT INTO workflow_task_statuses (workflow_id, status_key, label, terminal, stage_order)
    VALUES (10, 'in_progress', 'In Progress', 0, 0), (10, 'done', 'Done', 1, 1)`);
  await db.run(`INSERT INTO agents (id, tenant_id, project_id, name, session_key)
    VALUES (7, 1, 1, 'Supervisor', 'supervisor'), (8, 1, 1, 'Worker', 'worker')`);
  await db.run(`INSERT INTO tasks (id, tenant_id, project_id, workflow_id, title, status, task_type, assigned_agent_id)
    VALUES (101, 1, 1, 10, 'Stuck occurrence', 'in_progress', 'proposal', 8),
           (102, 1, 2, 11, 'Other project task', 'in_progress', NULL, NULL),
           (103, 2, 3, 12, 'Other tenant task', 'in_progress', NULL, NULL)`);
  await db.run(`INSERT INTO task_field_schemas (tenant_id, workflow_type_key, task_type, schema_json) VALUES (1, 'lead_generation', NULL, ?)`,
    JSON.stringify({ fields: [{ key: 'crm_evidence', type: 'url' }] }));
  await db.run(`INSERT INTO workflow_task_transitions (tenant_id, workflow_id, task_type, from_status, outcome, to_status, enabled)
    VALUES (1, 10, 'proposal', 'in_progress', 'closed_completed', 'done', 1)`);
  await db.run(`INSERT INTO workflow_task_transition_requirements
    (tenant_id, project_id, workflow_id, workflow_type, task_type, outcome, field_name, requirement_type, severity, enabled)
    VALUES (1, 1, 10, 'lead_generation', 'proposal', 'closed_completed', 'crm_evidence', 'required', 'block', 1)`);
  apiKey = (await issueMcpApiKeyForAgent(db, 7)).apiKey;
  await replaceAgentMcpPermissionPolicy(db, 7, ['tasks.write_project_lifecycle', 'tasks.manage_project_tasks']);
  const app = express();
  app.use(express.json());
  app.use('/api/v1', authenticateTestApiRequest());
  app.use('/api/v1', authorizeMcpApiRequestIfPresent);
  app.use('/api/v1/tasks', tasksRouter);
  server = await new Promise<Server>(resolve => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
});

afterEach(async () => {
  jest.restoreAllMocks();
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  await teardownTestDb();
});

async function request(path: string, body: Record<string, unknown>, method = 'POST') {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-api-key': apiKey }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

function outcome(extra: Record<string, unknown> = {}, taskId = 101) {
  return request(`/tasks/${taskId}/outcome`, { outcome: 'closed_completed', summary, payload: { crm_evidence: proof }, ...extra });
}

async function snapshot() {
  return {
    task: await db.get(`SELECT * FROM tasks WHERE id = 101`),
    history: await db.all(`SELECT * FROM task_history WHERE task_id = 101 ORDER BY id`),
    notes: await db.all(`SELECT * FROM task_notes WHERE task_id = 101 ORDER BY id`),
    instances: await db.all(`SELECT * FROM job_instances ORDER BY id`),
  };
}

async function audit() {
  const row = await db.get(`SELECT changed_by, new_value FROM task_history WHERE task_id = 101 AND field = 'project_lifecycle_outcome' ORDER BY id DESC LIMIT 1`) as { changed_by: string; new_value: string };
  return { actor: row.changed_by, ...JSON.parse(row.new_value) };
}

// Use the domain handle for transaction fault injection; HTTP requests use a
// separate handle over the same database.
async function projectOutcomeDirect() {
  return postTaskOutcome(db, 101, { outcome: 'closed_completed', summary, payload: { crm_evidence: proof } }, 'supervisor', {
    mcpIdentity: await resolveMcpApiIdentityForKey(db, apiKey),
    projectLifecycle: { capability: 'tasks.write_project_lifecycle', projectId: 1 },
  });
}

it.each([8, null])('posts a gated project outcome without a run, assigned_agent_id=%s', async assigned => {
  await db.run(`UPDATE tasks SET assigned_agent_id = ? WHERE id = 101`, assigned);
  const res = await outcome({ changed_by: 'spoofed-admin', capability: 'admin.full_access' });
  expect(res).toMatchObject({ status: 200, body: { applied: true, next_status: 'done', evidence_written: true } });
  const history = await audit();
  expect(history).toMatchObject({ agent_id: 7, key_id: expect.any(Number), capability: 'tasks.write_project_lifecycle', project_id: 1,
    outcome: 'closed_completed', summary, result: 'applied', prior_status: 'in_progress', next_status: 'done', instance_id: null });
  expect(history.actor).not.toBe('spoofed-admin');
  const statusHistory = await db.get(`SELECT changed_by FROM task_history WHERE task_id = 101 AND field = 'status'`);
  expect(statusHistory).toEqual({ changed_by: history.actor });
});

it('uses the actual active instance owned by another agent and ignores caller instance IDs', async () => {
  await db.run(`INSERT INTO job_instances (id, tenant_id, task_id, agent_id, status)
    VALUES (201, 1, 101, 8, 'running'), (202, 1, 102, 7, 'running')`);
  await db.run(`UPDATE tasks SET active_instance_id = 201, agent_id = 8 WHERE id = 101`);
  const res = await outcome({ instance_id: 202, instanceId: 202 });
  expect(res).toMatchObject({ status: 200, body: { applied: true, instance_closed: true } });
  expect(await db.get(`SELECT status, task_outcome FROM job_instances WHERE id = 201`)).toEqual({ status: 'done', task_outcome: 'closed_completed' });
  expect(await db.get(`SELECT status, task_outcome FROM job_instances WHERE id = 202`)).toEqual({ status: 'running', task_outcome: null });
  expect(await audit()).toMatchObject({ instance_id: 201 });
});

it.each([undefined, '', '  \n ', 123])('requires a nonblank project outcome reason (%s)', async value => {
  const before = await snapshot();
  expect(await outcome({ summary: value })).toMatchObject({ status: 400, body: { code: 'project_outcome_summary_required' } });
  expect(await snapshot()).toEqual(before);
});

it('previews a supervisory outcome without changing task, history, notes, or instances', async () => {
  const before = await snapshot();
  expect(await outcome({ dry_run: true })).toMatchObject({ status: 200, body: { dry_run: true, next_status: 'done' } });
  expect(await snapshot()).toEqual(before);
});

it('preserves evidence gates and audits a refused supervisory outcome', async () => {
  const before = await snapshot();
  expect(await outcome({ payload: {} })).toMatchObject({ status: 400 });
  const after = await snapshot();
  expect(after.task).toEqual(before.task);
  expect(after.instances).toEqual(before.instances);
  expect(await audit()).toMatchObject({ result: 'refused', summary, capability: 'tasks.write_project_lifecycle' });
});

it('requires a configured transition and rolls back inline evidence on refusal', async () => {
  await db.run(`DELETE FROM workflow_task_transitions WHERE workflow_id = 10`);
  const before = await snapshot();
  expect(await outcome()).toMatchObject({ status: 400, body: { code: 'task_outcome_not_allowed_for_workflow' } });
  expect((await snapshot()).task).toEqual(before.task);
  expect(await audit()).toMatchObject({ result: 'refused' });
});

it('audits an ignored terminal outcome without changing evidence', async () => {
  await db.run(`UPDATE tasks SET status = 'done' WHERE id = 101`);
  const before = await snapshot();
  expect(await outcome()).toMatchObject({ status: 200, body: { applied: false, ignored: true, reason: 'task_terminal' } });
  expect((await snapshot()).task).toEqual(before.task);
  expect(await audit()).toMatchObject({ result: 'ignored', reason: 'task_terminal' });
});

it('denies cross-project and cross-tenant writes even with spoofed project controls', async () => {
  for (const taskId of [102, 103]) {
    expect(await outcome({ project_id: 1, projectLifecycle: { capability: 'tasks.write_project_lifecycle', projectId: 1 } }, taskId)).toMatchObject({ status: 403 });
    expect(await db.get(`SELECT status FROM tasks WHERE id = ?`, taskId)).toEqual({ status: 'in_progress' });
  }
  await db.run(`UPDATE agents SET project_id = NULL WHERE id = 7`);
  expect(await outcome()).toMatchObject({ status: 403 });
});

it('keeps CRUD, active lifecycle, and project lifecycle capabilities separate', async () => {
  for (const capability of ['tasks.manage_project_tasks', 'tasks.write_active_lifecycle', 'tasks.write_project_notes']) {
    await replaceAgentMcpPermissionPolicy(db, 7, [capability]);
    expect(await outcome({ projectLifecycle: { capability: 'tasks.write_project_lifecycle', projectId: 1 } })).toMatchObject({ status: 403 });
  }
  await replaceAgentMcpPermissionPolicy(db, 7, ['tasks.manage_project_tasks', 'tasks.write_project_lifecycle']);
  expect(await request('/tasks/101', { status: 'done' }, 'PUT')).toMatchObject({ status: 403 });
  expect(await request('/tasks/101/admin-outcome', { outcome: 'closed_completed', summary })).toMatchObject({ status: 403 });
  await db.run(`INSERT INTO job_instances (id, tenant_id, task_id, agent_id, status) VALUES (201, 1, 101, 8, 'running')`);
  await db.run(`UPDATE tasks SET active_instance_id = 201 WHERE id = 101`);
  expect(await request('/instances/201/start', {}, 'PUT')).toMatchObject({ status: 403 });
});

it('allows project notes and evidence without owning a run', async () => {
  expect(await request('/tasks/101/notes', { content: summary, author: 'spoofed' })).toMatchObject({ status: 201 });
  expect(await request('/tasks/101/live-verification', { live_verified_by: 'CRM supervisor', summary }, 'PUT')).toMatchObject({ status: 200 });
  expect(await request('/tasks/102/live-verification', { live_verified_by: 'CRM supervisor' }, 'PUT')).toMatchObject({ status: 403 });
});

it('keeps the narrower active-run path when both lifecycle capabilities are granted', async () => {
  await replaceAgentMcpPermissionPolicy(db, 7, ['tasks.write_active_lifecycle', 'tasks.write_project_lifecycle']);
  await db.run(`INSERT INTO job_instances (id, tenant_id, task_id, agent_id, status) VALUES (201, 1, 101, 7, 'running')`);
  await db.run(`UPDATE tasks SET active_instance_id = 201, agent_id = 7 WHERE id = 101`);
  expect(await outcome({ summary: undefined })).toMatchObject({ status: 200, body: { applied: true } });
  expect(await db.all(`SELECT id FROM task_history WHERE field = 'project_lifecycle_outcome'`)).toEqual([]);
});

it('rechecks project scope under the task lock without leaving audit writes in a different project', async () => {
  const transaction = db.withTransaction.bind(db);
  jest.spyOn(db, 'withTransaction').mockImplementationOnce(async fn => {
    await db.run(`UPDATE tasks SET project_id = 2, workflow_id = 11 WHERE id = 101`);
    return transaction(fn);
  });
  await expect(projectOutcomeDirect()).rejects.toMatchObject({ status: 403 });
  expect(await db.get(`SELECT status, custom_fields_json FROM tasks WHERE id = 101`)).toMatchObject({ status: 'in_progress', custom_fields_json: '{}' });
  expect(await db.all(`SELECT id FROM task_history WHERE task_id = 101`)).toEqual([]);
});

it('refuses an outcome if a new active instance appears before the write', async () => {
  await db.run(`INSERT INTO job_instances (id, tenant_id, task_id, agent_id, status) VALUES (201, 1, 101, 8, 'running')`);
  const transaction = db.withTransaction.bind(db);
  jest.spyOn(db, 'withTransaction').mockImplementationOnce(async fn => {
    await db.run(`UPDATE tasks SET active_instance_id = 201, agent_id = 8 WHERE id = 101`);
    return transaction(fn);
  });
  await expect(projectOutcomeDirect()).rejects.toMatchObject({ status: 409, body: { reason: 'active_instance_changed' } });
  expect(await db.get(`SELECT status, task_outcome FROM job_instances WHERE id = 201`)).toEqual({ status: 'running', task_outcome: null });
  expect(await audit()).toMatchObject({ result: 'refused' });
});

it('rolls back the outcome and evidence when its required audit entry fails', async () => {
  const before = await snapshot();
  const transaction = db.withTransaction.bind(db);
  jest.spyOn(db, 'withTransaction').mockImplementationOnce(fn => transaction(async tx => {
    const run = tx.run.bind(tx);
    jest.spyOn(tx, 'run').mockImplementation(async (sql, ...params) => {
      if (sql.includes('INSERT INTO task_history') && sql.includes("'project_lifecycle_outcome'")) {
        throw new Error('Audit storage unavailable');
      }
      return run(sql, ...params);
    });
    return fn(tx);
  }));
  await expect(projectOutcomeDirect()).rejects.toThrow('Audit storage unavailable');
  const after = await snapshot();
  expect(after.task).toEqual(before.task);
  expect(after.notes).toEqual(before.notes);
  expect(await audit()).toMatchObject({ result: 'refused' });
});

it('keeps the applied audit result if response enrichment fails after commit', async () => {
  jest.spyOn(taskReadModel, 'enrichTask').mockRejectedValueOnce(new Error('Task read unavailable'));
  await expect(projectOutcomeDirect()).rejects.toThrow('Task read unavailable');
  expect(await db.get(`SELECT status FROM tasks WHERE id = 101`)).toEqual({ status: 'done' });
  expect(await audit()).toMatchObject({ result: 'applied' });
  expect(await db.all(`SELECT id FROM task_history WHERE field = 'project_lifecycle_outcome'`)).toHaveLength(1);
});
