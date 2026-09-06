import { setupTestDb, teardownTestDb } from '../../db/testDb';
import type { Db } from '../../db/adapter/types';
import type { McpApiIdentity } from '../../lib/mcpApiAuth';
import { postTaskOutcome } from './release';
import { loadSprintTaskTransitionRequirements } from '../routing/policy/statuses';

jest.mock('./readModel', () => ({ ...jest.requireActual('./readModel'), enrichTask: jest.fn(task => task) }));
jest.mock('./mutations', () => ({ ...jest.requireActual('./mutations'), maybeTriggerDispatch: jest.fn() }));
jest.mock('../../integrations/telegram', () => ({ notifyTelegram: jest.fn() }));

const proof = 'https://www.freelancer.com/projects/40691397#bid_493880589';
const payload = { submission_proof_url: proof, platform_bid_id: '493880589' };
let db: Db;

beforeEach(async () => {
  db = await setupTestDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Test', 'test', 1)`);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Agency')`);
  await db.run(`INSERT INTO sprint_types (tenant_id, key, name) VALUES (1, 'lead_generation', 'Lead Generation')`);
  await db.run(`INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type) VALUES (10, 1, 1, 'Leads', 'lead_generation')`);
  await db.run(`INSERT INTO sprint_task_statuses (sprint_id, status_key, label, terminal, stage_order)
    VALUES (10, 'approved', 'Approved', 0, 0), (10, 'submitted', 'Submitted', 0, 1)`);
  await db.run(`INSERT INTO agents (id, tenant_id, name, session_key) VALUES (7, 1, 'Sales', 'sales')`);
  await db.run(`INSERT INTO tasks (id, tenant_id, title, status, project_id, sprint_id, task_type, agent_id, custom_fields_json)
    VALUES (417, 1, 'Proposal', 'approved', 1, 10, 'proposal', 7, ?)`, JSON.stringify({ retired_field: 'preserve', memo: 'old' }));
  await db.run(`INSERT INTO task_field_schemas (tenant_id, sprint_type_key, task_type, schema_json) VALUES (1, 'lead_generation', NULL, ?)`, JSON.stringify({ fields: [
    { key: 'submission_proof_url', type: 'url' }, { key: 'platform_bid_id', type: 'text' },
    { key: 'amount', type: 'number' }, { key: 'checked', type: 'checkbox' },
    { key: 'outcome', type: 'select', options: ['Won', 'Lost'] }, { key: 'memo', type: 'textarea' },
    // Even a malformed schema cannot give a payload authority over task state.
    { key: 'status', type: 'text' },
  ] }));
  await db.run(`INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled)
    VALUES (1, 10, 'proposal', 'approved', 'submit_external', 'submitted', 1)`);
  await db.run(`INSERT INTO sprint_task_transition_requirements
    (tenant_id, project_id, sprint_id, sprint_type, task_type, outcome, field_name, requirement_type, severity, enabled)
    VALUES (1, 1, 10, 'lead_generation', 'proposal', 'submit_external', 'submission_proof_url', 'required', 'block', 1)`);
  expect(await loadSprintTaskTransitionRequirements(db, 10, 'submit_external', 'proposal')).toHaveLength(1);
});

afterEach(async () => { jest.restoreAllMocks(); await teardownTestDb(); });

async function record() {
  const task = await db.get(`SELECT status, custom_fields_json, active_instance_id FROM tasks WHERE id = 417`) as { status: string; custom_fields_json: string };
  return { ...task, fields: JSON.parse(task.custom_fields_json) };
}

async function auditSnapshot() {
  return {
    task: await record(),
    history: await db.all(`SELECT * FROM task_history WHERE task_id = 417 ORDER BY id`),
    notes: await db.all(`SELECT * FROM task_notes WHERE task_id = 417 ORDER BY id`),
    instances: await db.all(`SELECT * FROM job_instances WHERE task_id = 417 ORDER BY id`),
  };
}

function submit(extra: Record<string, unknown> = {}) {
  return postTaskOutcome(db, 417, { outcome: 'submit_external', payload, ...extra }, 'operator');
}

it('persists payload-only proof, scalar values and the outcome field with the transition', async () => {
  const result = await submit({ payload: { ...payload, amount: 0, checked: false, outcome: 'Won', memo: null } });
  expect(result).toMatchObject({ applied: true, next_status: 'submitted', evidence_written: true, outcome: 'submit_external' });
  expect((await record()).fields).toEqual({ ...payload, amount: 0, checked: false, outcome: 'Won', memo: null, retired_field: 'preserve' });
  const history = await db.all(`SELECT field, new_value FROM task_history WHERE task_id = 417`);
  expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'submission_proof_url', new_value: proof })]));
});

it('uses task-type field overrides rather than only the workflow default', async () => {
  await db.run(`INSERT INTO task_field_schemas (tenant_id, sprint_type_key, task_type, schema_json) VALUES (1, 'lead_generation', 'proposal', ?)`, JSON.stringify({ fields: [
    { key: 'amount', type: 'select', options: ['negotiated'] }, { key: 'proposal_only', type: 'text' },
  ] }));
  await expect(submit({ payload: { ...payload, amount: 0 } })).rejects.toMatchObject({ status: 400 });
  await submit({ payload: { ...payload, amount: 'negotiated', proposal_only: 'yes' } });
  expect((await record()).fields).toMatchObject({ amount: 'negotiated', proposal_only: 'yes' });
});

it.each([
  ['unknown', 'value'], ['retired_field', 'changed'], ['status', 'submitted'], ['project_id', 99],
  ['active_instance_id', 999], ['instance_id', 999], ['changed_by', 'admin'], ['dry_run', false], ['sprint_type', 'dev'],
  ['constructor', 'bad'], ['__proto__', 'bad'], ['amount', '0'], ['amount', Infinity],
  ['checked', 'true'], ['outcome', 'submit_external'], ['submission_proof_url', 'not a url'],
  ['platform_bid_id', { id: 123 }], ['failure_detail', 123],
])('rejects invalid/protected field %s without any task or audit writes', async (field, value) => {
  const before = await auditSnapshot();
  await expect(submit({ payload: { ...payload, [field]: value } })).rejects.toMatchObject({ status: 400 });
  expect(await auditSnapshot()).toEqual(before);
});

it.each([[], 'not an object', 12])('rejects malformed payload %j', async value => {
  await expect(submit({ payload: value })).rejects.toMatchObject({ status: 400 });
  expect((await record()).status).toBe('approved');
});

it('rejects a payload-only lifecycle command rather than letting evidence choose the transition', async () => {
  await expect(postTaskOutcome(db, 417, { payload: { ...payload, outcome: 'submit_external' } }, 'operator')).rejects.toMatchObject({ status: 400 });
  expect((await record()).status).toBe('approved');
});

it('requires actual proof but recognizes previously persisted proof', async () => {
  const before = await record();
  await expect(submit({ payload: { amount: 12 } })).rejects.toMatchObject({ status: 400 });
  expect(await record()).toEqual(before);
  await db.run(`UPDATE tasks SET custom_fields_json = ? WHERE id = 417`, JSON.stringify(payload));
  await submit({ payload: { amount: 12 } });
  expect((await record()).fields).toEqual({ ...payload, amount: 12 });
});

it('does not clear required proof or persist other fields when a null fails the gate', async () => {
  await db.run(`UPDATE tasks SET custom_fields_json = ? WHERE id = 417`, JSON.stringify(payload));
  const before = await record();
  await expect(submit({ payload: { submission_proof_url: null, amount: 12 } })).rejects.toMatchObject({ status: 400 });
  expect(await record()).toEqual(before);
});

it('accepts zero and false for required scalar fields in both preflight and release gates', async () => {
  await db.run(`INSERT INTO sprint_task_transition_requirements
    (tenant_id, project_id, sprint_id, sprint_type, task_type, outcome, field_name, requirement_type, severity, enabled)
    VALUES (1, 1, 10, 'lead_generation', 'proposal', 'submit_external', 'amount', 'required', 'block', 1),
           (1, 1, 10, 'lead_generation', 'proposal', 'submit_external', 'checked', 'required', 'block', 1)`);
  await submit({ payload: { ...payload, amount: 0, checked: false } });
  expect((await record()).status).toBe('submitted');
});

it('rolls back evidence and its audit when no transition is allowed', async () => {
  await db.run(`UPDATE tasks SET status = 'in_progress' WHERE id = 417`);
  const before = await auditSnapshot();
  await expect(submit()).rejects.toThrow('Cannot apply outcome');
  expect(await auditSnapshot()).toEqual(before);
});

it('previews payload-only proof without changing task, history, notes or run', async () => {
  const before = await auditSnapshot();
  const result = await submit({ dry_run: true });
  expect(result).toMatchObject({ ok: true, applied: true, evidence_written: false, evidence_would_write: true, next_status: 'submitted', proposed_changes: { evidence: payload } });
  expect(await auditSnapshot()).toEqual(before);
});

it('does not save evidence on an ignored terminal outcome', async () => {
  await db.run(`UPDATE tasks SET status = 'done' WHERE id = 417`);
  const before = await auditSnapshot();
  expect(await submit()).toMatchObject({ applied: false, ignored: true, evidence_written: false });
  expect(await auditSnapshot()).toEqual(before);
});

it('keeps active-run ownership enforcement for dynamic evidence', async () => {
  await db.run(`INSERT INTO job_instances (id, tenant_id, task_id, agent_id, status) VALUES (93, 1, 417, 7, 'running')`);
  await db.run(`UPDATE tasks SET active_instance_id = 93 WHERE id = 417`);
  const identity: McpApiIdentity = { keyId: 1, agentId: 8, tenantId: 1, agentName: 'Other', agentSlug: 'other', systemRole: null, keyRole: 'scoped', globalAdminAccess: false, auditActor: 'other', authorityActor: 'other' };
  const before = await auditSnapshot();
  await expect(postTaskOutcome(db, 417, { outcome: 'submit_external', payload }, 'other', { mcpIdentity: identity })).rejects.toMatchObject({ status: 403 });
  expect(await auditSnapshot()).toEqual(before);
  identity.agentId = 7;
  expect(await postTaskOutcome(db, 417, { outcome: 'submit_external', payload }, 'sales', { mcpIdentity: identity })).toMatchObject({ applied: true, instance_closed: true });
  expect(await db.get(`SELECT task_outcome FROM job_instances WHERE id = 93`)).toMatchObject({ task_outcome: 'submit_external' });
});

it('revalidates a changed task state after obtaining the transaction lock', async () => {
  const transaction = db.withTransaction.bind(db);
  jest.spyOn(db, 'withTransaction').mockImplementationOnce(async fn => {
    await db.run(`UPDATE tasks SET status = 'in_progress' WHERE id = 417`);
    return transaction(fn);
  });
  await expect(submit()).rejects.toThrow('Cannot apply outcome');
  expect((await record()).fields).toEqual({ retired_field: 'preserve', memo: 'old' });
});

it('serializes concurrent outcomes so only one transition and evidence write commit', async () => {
  const results = await Promise.allSettled([submit(), submit()]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect((await record()).fields).toMatchObject(payload);
  expect(await db.all(`SELECT id FROM task_history WHERE task_id = 417 AND field = 'submission_proof_url'`)).toHaveLength(1);
  expect(await db.all(`SELECT id FROM task_history WHERE task_id = 417 AND field = 'status' AND new_value = 'submitted'`)).toHaveLength(1);
});
