import type { Request, Response } from 'express';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import type { Db } from '../../db/adapter/types';
import { recordAgentActivity, recordInboundAgentActivity } from './agentActivity';

let db: Db;
const identity = { agentId: 10, tenantId: 1 };
const run = { instanceId: 42, durableRunId: 'run-42' };
beforeEach(async () => {
  db = await setupTestDb();
  await db.run(`INSERT INTO tenants (id, name, slug) VALUES (1, 'T', 't')`);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'P')`);
  await db.run(`INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type) VALUES (1, 1, 1, 'W', 'generic')`);
  await db.run(`INSERT INTO agents (id, tenant_id, name, session_key) VALUES (10, 1, 'A', 'agent:a:main')`);
  await db.run(`INSERT INTO tasks (id, tenant_id, project_id, workflow_id, title) VALUES (7, 1, 1, 1, 'T')`);
  await db.run(`INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status, durable_run_id)
    VALUES (42, 1, 10, 7, 'running', 'run-42')`);
  await db.run(`UPDATE tasks SET active_instance_id = 42 WHERE id = 7`);
});
afterEach(async () => { await teardownTestDb(); });

async function inbound(path: string, method: string, agent = true, headers = true) {
  await new Promise<void>((resolve, reject) => recordInboundAgentActivity({
    path, method, mcpIdentity: agent ? identity : undefined,
    get: (name: string) => headers ? ({ 'x-agent-hq-instance-id': '42', 'x-agent-hq-durable-run-id': 'run-42' }[name]) : undefined,
  } as Request, {} as Response, error => error ? reject(error) : resolve()));
}

it.each([['/tasks/7', 'GET'], ['/tasks/7/context', 'GET'], ['/tasks/7/notes', 'POST'], ['/instances/42/check-in', 'POST']])(
  'counts authorized agent %s %s calls', async (path, method) => {
    await inbound(path, method);
    expect(await db.value('SELECT last_agent_call_at FROM job_instances WHERE id = 42')).toEqual(expect.any(String));
  },
);

it('ignores operator requests, unbound clients and discovery/preflight', async () => {
  await inbound('/tasks/7', 'GET', false);
  await inbound('/tasks/7', 'GET', true, false);
  await inbound('/mcp/access', 'GET');
  expect(await db.value('SELECT last_agent_call_at FROM job_instances WHERE id = 42')).toBeNull();
});

it('rejects another agent, tenant, instance or stale durable identity', async () => {
  expect(await recordAgentActivity(db, { ...identity, agentId: 11 }, run)).toBe(false);
  expect(await recordAgentActivity(db, { ...identity, tenantId: 2 }, run)).toBe(false);
  expect(await recordAgentActivity(db, identity, { ...run, instanceId: 43 })).toBe(false);
  expect(await recordAgentActivity(db, identity, { ...run, durableRunId: 'old-run' })).toBe(false);
  expect(await db.value('SELECT last_agent_call_at FROM job_instances WHERE id = 42')).toBeNull();
});

it('requires live ownership and refuses stopped or terminal runs', async () => {
  await db.run('UPDATE tasks SET active_instance_id = NULL WHERE id = 7');
  expect(await recordAgentActivity(db, identity, run)).toBe(false);
  await db.run('UPDATE tasks SET active_instance_id = 42 WHERE id = 7');
  await db.run("UPDATE job_instances SET stop_requested_at = '2026-10-16 12:00:00' WHERE id = 42");
  expect(await recordAgentActivity(db, identity, run)).toBe(false);
  await db.run("UPDATE job_instances SET stop_requested_at = NULL, status = 'failed' WHERE id = 42");
  expect(await recordAgentActivity(db, identity, run)).toBe(false);
});

it('renews activity without moving the first-call execution baseline', async () => {
  await recordAgentActivity(db, identity, run);
  const first = await db.value('SELECT first_agent_call_at FROM job_instances WHERE id = 42');
  await recordAgentActivity(db, identity, run);
  expect(await db.value('SELECT first_agent_call_at FROM job_instances WHERE id = 42')).toBe(first);
});
