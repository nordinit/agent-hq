import { setupTestDb, teardownTestDb } from '../db/testDb';
import express from 'express';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

let db: Db;

jest.mock('../db/client', () => ({
  getDb: () => db,
}));

import chatRouter from './chat';
import { type Db } from "../db/adapter/types";

async function getJson(app: express.Express, route: string): Promise<{ status: number; body: any }> {
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${route}`);
    const body = await res.json();
    return {
      status: res.status,
      body,
    };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function setupDb(): Promise<void> {
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Test', 'test', 1)`);
  await db.run(`
    INSERT INTO app_settings (key, value)
    VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')
  `);
}

async function seedProject(id: number, name: string): Promise<void> {
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (?, 1, ?)`, id, name);
  await db.run(`
    INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type)
    VALUES (?, 1, ?, ?, 'generic')
  `, id, id, `${name} workflow`);
}

describe('GET /api/v1/chat/sessions/:instanceId/messages', () => {
  beforeEach(async () => {
    db = await setupTestDb();
    await setupDb();
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('loads a direct chat conversation by session_key across instance-backed and legacy rows', async () => {
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key) VALUES (1, 1, 'Atlas', 'agent:atlas:web:direct:abc')`);
    await db.run(`INSERT INTO job_instances (id, tenant_id, agent_id, status) VALUES (501, 1, 1, 'done')`);
    // A legacy instance-less row plus rows saved as per-turn job_instances (instance_id set),
    // all sharing the stable chat session_key. The bubble (instanceId=0) must return all of them.
    await db.run(`
      INSERT INTO chat_messages (id, tenant_id, agent_id, instance_id, session_key, role, content, timestamp, event_type)
      VALUES
        ('legacy-1', 1, 1, NULL, 'agent:atlas:web:direct:abc', 'user', 'old hello', '2026-05-01T12:00:00Z', 'text'),
        ('oc-chat-user-501-1', 1, 1, 501, 'agent:atlas:web:direct:abc', 'user', 'new question', '2026-05-01T12:05:00Z', 'text'),
        ('oc-hist-501-3', 1, 1, 501, 'agent:atlas:web:direct:abc', 'assistant', '', '2026-05-01T12:05:01Z', 'tool_call'),
        ('oc-asst-501-0', 1, 1, 501, 'agent:atlas:web:direct:abc', 'assistant', 'the answer', '2026-05-01T12:05:02Z', 'text')
    `);

    const app = express();
    app.use('/api/v1/chat', chatRouter);

    const res = await getJson(app, '/api/v1/chat/sessions/0/messages?session_key=agent%3Aatlas%3Aweb%3Adirect%3Aabc');
    expect(res.status).toBe(200);
    expect(res.body.map((m: any) => m.id)).toEqual([
      'legacy-1',
      'oc-chat-user-501-1',
      'oc-hist-501-3',
      'oc-asst-501-0',
    ]);
    // The structured tool-call row from the instance-backed turn is included.
    expect(res.body.find((m: any) => m.id === 'oc-hist-501-3')?.event_type).toBe('tool_call');
  });
});

describe('GET /api/v1/chat/sessions', () => {
  beforeEach(async () => {
    db = await setupTestDb();
    await setupDb();
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('returns canonical session project metadata when present', async () => {
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key) VALUES (1, 1, 'Atlas', 'agent:atlas:main')`);
    await seedProject(7, 'Agent HQ Product');
    await db.run(`
      INSERT INTO sessions (id, tenant_id, external_key, runtime, agent_id, project_id, status, title)
      VALUES (1, 1, 'direct:atlas:web', 'openclaw', 1, 7, 'active', 'Atlas session')
    `);
    await db.run(`
      INSERT INTO chat_messages (id, tenant_id, agent_id, instance_id, session_key, role, content, timestamp)
      VALUES
        ('m1', 1, 1, NULL, 'direct:atlas:web', 'user', 'hello', '2026-05-01T12:00:00Z'),
        ('m2', 1, 1, NULL, 'direct:atlas:web', 'assistant', 'hi', '2026-05-01T12:01:00Z')
    `);

    const app = express();
    app.use('/api/v1/chat', chatRouter);

    const res = await getJson(app, '/api/v1/chat/sessions');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      session_key: 'direct:atlas:web',
      project_id: 7,
      project_name: 'Agent HQ Product',
      project_slug: 'agent-hq-product',
      project_source: 'task',
    });
  });

  it('returns canonical session project metadata for run-backed chats and ignores agent project', async () => {
    await seedProject(9, 'Backend Bugs');
    await seedProject(99, 'Wrong Agent Project');
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, project_id) VALUES (1, 1, 'Cinder', 'agent:cinder:main', 99)`);
    await db.run(`INSERT INTO tasks (id, tenant_id, title, project_id, sprint_id) VALUES (22, 1, 'Fix chats API', 9, 9)`);
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, task_id, agent_id, session_key, status, created_at)
      VALUES (33, 1, 22, 1, 'run:33', 'done', '2026-05-01T11:59:00Z')
    `);
    await db.run(`
      INSERT INTO sessions (id, tenant_id, external_key, runtime, agent_id, task_id, instance_id, project_id, status, title)
      VALUES (1, 1, 'run:33', 'openclaw', 1, 22, 33, 9, 'completed', 'Cinder run')
    `);
    await db.run(`
      INSERT INTO chat_messages (id, tenant_id, agent_id, instance_id, session_key, role, content, timestamp)
      VALUES
        ('m1', 1, 1, 33, 'run:33', 'user', 'start', '2026-05-01T12:00:00Z'),
        ('m2', 1, 1, 33, 'run:33', 'assistant', 'done', '2026-05-01T12:03:00Z')
    `);

    const app = express();
    app.use('/api/v1/chat', chatRouter);

    const res = await getJson(app, '/api/v1/chat/sessions');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      instance_id: 33,
      project_id: 9,
      project_name: 'Backend Bugs',
      project_slug: 'backend-bugs',
      project_source: 'task',
    });
  });

  it('does not infer project metadata from a task when the canonical session is unassigned', async () => {
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key) VALUES (1, 1, 'Atlas', 'agent:atlas:main')`);
    await seedProject(9, 'Backend Bugs');
    await db.run(`INSERT INTO tasks (id, tenant_id, title, project_id, sprint_id) VALUES (22, 1, 'Fix chats API', 9, 9)`);
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, task_id, agent_id, session_key, status, created_at)
      VALUES (33, 1, 22, 1, 'run:33', 'done', '2026-05-01T11:59:00Z')
    `);
    await db.run(`
      INSERT INTO sessions (id, tenant_id, external_key, runtime, agent_id, task_id, instance_id, project_id, status, title)
      VALUES (1, 1, 'run:33', 'openclaw', 1, 22, 33, NULL, 'completed', 'Unassigned run')
    `);
    await db.run(`
      INSERT INTO chat_messages (id, tenant_id, agent_id, instance_id, session_key, role, content, timestamp)
      VALUES ('m1', 1, 1, 33, 'run:33', 'user', 'hello', '2026-05-01T12:00:00Z')
    `);

    const app = express();
    app.use('/api/v1/chat', chatRouter);

    const res = await getJson(app, '/api/v1/chat/sessions');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      session_key: 'run:33',
      project_id: null,
      project_name: null,
      project_slug: null,
      project_source: 'none',
    });
  });

  it('includes dispatched prompt-only OpenClaw runs before a canonical sessions row exists', async () => {
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key) VALUES (1, 1, 'Cinder', 'agent:cinder:main')`);
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key) VALUES (2, 1, 'Atlas', 'agent:atlas:main')`);
    await seedProject(9, 'Backend Bugs');
    await db.run(`INSERT INTO tasks (id, tenant_id, title, project_id, sprint_id) VALUES (22, 1, 'Show starting chat', 9, 9)`);
    await db.run(`
      INSERT INTO sessions (id, tenant_id, external_key, runtime, agent_id, project_id, status, title, message_count)
      VALUES (1, 1, 'direct:atlas:web', 'openclaw', 2, NULL, 'active', 'Atlas direct', 1)
    `);
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, task_id, agent_id, session_key, status, created_at)
      VALUES (4581, 1, 22, 1, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'dispatched', '2026-05-01T11:59:00Z')
    `);
    await db.run(`
      INSERT INTO chat_messages (id, tenant_id, agent_id, instance_id, session_key, role, content, timestamp)
      VALUES
        ('prompt-1', 1, 1, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Initial task prompt', '2026-05-01T12:00:00Z'),
        ('prompt-2', 1, 1, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Dispatch contract', '2026-05-01T12:00:01Z')
    `);

    const app = express();
    app.use('/api/v1/chat', chatRouter);

    const res = await getJson(app, '/api/v1/chat/sessions?agent_id=1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      instance_id: 4581,
      session_key: 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062',
      agent_id: 1,
      message_count: 2,
      project_id: 9,
      project_name: 'Backend Bugs',
      project_slug: 'backend-bugs',
      project_source: 'task',
      last_message: 'Dispatch contract',
      last_role: 'user',
    });
  });

  it('honors instance_id for a pre-import dispatched prompt-only run', async () => {
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key) VALUES (1, 1, 'Cinder', 'agent:cinder:main')`);
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key) VALUES (2, 1, 'Atlas', 'agent:atlas:main')`);
    await seedProject(9, 'Backend Bugs');
    await db.run(`INSERT INTO tasks (id, tenant_id, title, project_id, sprint_id) VALUES (22, 1, 'Show starting chat', 9, 9)`);
    await db.run(`
      INSERT INTO sessions (id, tenant_id, external_key, runtime, agent_id, project_id, status, title, message_count)
      VALUES (1, 1, 'direct:atlas:web', 'openclaw', 2, NULL, 'active', 'Atlas direct', 1)
    `);
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, task_id, agent_id, session_key, status, created_at)
      VALUES (4581, 1, 22, 1, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'dispatched', '2026-05-01T11:59:00Z')
    `);
    await db.run(`
      INSERT INTO chat_messages (id, tenant_id, agent_id, instance_id, session_key, role, content, timestamp)
      VALUES
        ('prompt-1', 1, 1, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Initial task prompt', '2026-05-01T12:00:00Z'),
        ('prompt-2', 1, 1, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Dispatch contract', '2026-05-01T12:00:01Z')
    `);

    const app = express();
    app.use('/api/v1/chat', chatRouter);

    const res = await getJson(app, '/api/v1/chat/sessions?instance_id=4581&limit=1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      instance_id: 4581,
      session_key: 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062',
      agent_id: 1,
      message_count: 2,
      project_id: 9,
      project_name: 'Backend Bugs',
      last_message: 'Dispatch contract',
      last_role: 'user',
    });
  });

  it('filters canonical and raw chat sessions by project_id', async () => {
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key) VALUES (1, 1, 'Cinder', 'agent:cinder:main')`);
    await seedProject(9, 'Backend Bugs');
    await seedProject(10, 'Mobile UX');
    await db.run(`INSERT INTO tasks (id, tenant_id, title, project_id, sprint_id) VALUES (22, 1, 'Backend run', 9, 9)`);
    await db.run(`INSERT INTO tasks (id, tenant_id, title, project_id, sprint_id) VALUES (23, 1, 'Mobile run', 10, 10)`);
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, task_id, agent_id, session_key, status, created_at)
      VALUES
        (33, 1, 22, 1, 'run:33', 'done', '2026-05-01T11:59:00Z'),
        (44, 1, 23, 1, 'run:44', 'done', '2026-05-01T12:00:00Z')
    `);
    await db.run(`
      INSERT INTO sessions (id, tenant_id, external_key, runtime, agent_id, task_id, instance_id, project_id, status, title, message_count)
      VALUES (1, 1, 'run:33', 'openclaw', 1, 22, 33, 9, 'completed', 'Backend canonical', 1)
    `);
    await db.run(`
      INSERT INTO chat_messages (id, tenant_id, agent_id, instance_id, session_key, role, content, timestamp)
      VALUES
        ('m1', 1, 1, 33, 'run:33', 'assistant', 'backend canonical', '2026-05-01T12:01:00Z'),
        ('m2', 1, 1, 44, 'run:44', 'assistant', 'mobile raw', '2026-05-01T12:02:00Z')
    `);

    const app = express();
    app.use('/api/v1/chat', chatRouter);

    const backend = await getJson(app, '/api/v1/chat/sessions?project_id=9');
    expect(backend.status).toBe(200);
    expect(backend.body).toHaveLength(1);
    expect(backend.body[0]).toMatchObject({ instance_id: 33, project_id: 9 });

    const mobile = await getJson(app, '/api/v1/chat/sessions?project_id=10');
    expect(mobile.status).toBe(200);
    expect(mobile.body).toHaveLength(1);
    expect(mobile.body[0]).toMatchObject({ instance_id: 44, project_id: 10 });
  });
});
