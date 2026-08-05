import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { setupTestDb, teardownTestDb } from '../../db/testDb';

let db: Db;

import { resolveSessionContext } from './sessionContext';
import { type Db } from "../../db/adapter/types";

describe('resolveSessionContext', () => {
  beforeEach(async () => {
    db = await setupTestDb();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Test', 'test', 1)`);
    await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Test')`);
    await db.run(`INSERT INTO sprints (id, tenant_id, project_id, name) VALUES (1, 1, 1, 'Test')`);
    await db.run(`INSERT INTO tasks (id, tenant_id, project_id, sprint_id, title) VALUES (867, 1, 1, 1, 'Test task')`);
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('resolves a direct chat key as instance-less when a chat-stage job_instance already exists', async () => {
    const sessionKey = 'agent:atlas:web:direct:8fa72628-c1d7-401c-a106-9190b2b623d6';
    await db.run(`
      INSERT INTO agents (id, name, session_key, openclaw_agent_id)
      VALUES (1, 'Atlas', 'agent:atlas:main', 'atlas')
    `);
    await db.run(`
      INSERT INTO job_instances (id, agent_id, task_id, session_key, status, run_stage, durable_run_id)
      VALUES (99974585, 1, NULL, ?, 'done', 'chat', 'chat-existing')
    `, sessionKey);

    expect(await resolveSessionContext(sessionKey)).toMatchObject({
      instanceId: null,
      durableRunId: null,
      agentId: 1,
      sessionKey,
    });
  });

  it('still resolves real run-backed session keys to their job_instance', async () => {
    await db.run(`
      INSERT INTO agents (id, name, session_key, openclaw_agent_id)
      VALUES (2, 'Cinder', 'agent:cinder:main', 'cinder')
    `);
    await db.run(`
      INSERT INTO job_instances (id, agent_id, task_id, session_key, status, run_stage, durable_run_id)
      VALUES (42, 2, 867, 'run:42:durable-run', 'running', 'execute', 'durable-run')
    `);

    expect(await resolveSessionContext('run:42:durable-run')).toMatchObject({
      instanceId: 42,
      durableRunId: 'durable-run',
      agentId: 2,
      sessionKey: 'run:42:durable-run',
    });
  });
});
