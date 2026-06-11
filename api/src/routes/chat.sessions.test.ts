import Database from 'better-sqlite3';
import express from 'express';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

let db: Database.Database;

jest.mock('../db/client', () => ({
  getDb: () => db,
}));

import chatRouter from './chat';

async function getJson(app: express.Express, route: string): Promise<{ status: number; body: any }> {
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${route}`);
    return {
      status: res.status,
      body: await res.json(),
    };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

function setupDb(): void {
  db.exec(`
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT,
      session_key TEXT,
      project_id INTEGER,
      openclaw_agent_id TEXT,
      hooks_url TEXT
    );

    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      title TEXT,
      project_id INTEGER
    );

    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      task_id INTEGER,
      agent_id INTEGER,
      session_key TEXT,
      status TEXT,
      created_at TEXT
    );

    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY,
      external_key TEXT UNIQUE,
      runtime TEXT NOT NULL,
      agent_id INTEGER,
      task_id INTEGER,
      instance_id INTEGER,
      project_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      title TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      ended_at TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      token_input INTEGER,
      token_output INTEGER,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      instance_id INTEGER,
      session_key TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'text',
      event_meta TEXT NOT NULL DEFAULT '{}'
    );
  `);
}

describe('GET /api/v1/chat/sessions/:instanceId/messages', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    setupDb();
  });

  afterEach(() => {
    db.close();
  });

  it('loads a direct chat conversation by session_key across instance-backed and legacy rows', async () => {
    db.prepare(`INSERT INTO agents (id, name, session_key) VALUES (1, 'Atlas', 'agent:atlas:web:direct:abc')`).run();
    // A legacy instance-less row plus rows saved as per-turn job_instances (instance_id set),
    // all sharing the stable chat session_key. The bubble (instanceId=0) must return all of them.
    db.prepare(`
      INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp, event_type)
      VALUES
        ('legacy-1', 1, NULL, 'agent:atlas:web:direct:abc', 'user', 'old hello', '2026-05-01T12:00:00Z', 'text'),
        ('oc-chat-user-501-1', 1, 501, 'agent:atlas:web:direct:abc', 'user', 'new question', '2026-05-01T12:05:00Z', 'text'),
        ('oc-hist-501-3', 1, 501, 'agent:atlas:web:direct:abc', 'assistant', '', '2026-05-01T12:05:01Z', 'tool_call'),
        ('oc-asst-501-0', 1, 501, 'agent:atlas:web:direct:abc', 'assistant', 'the answer', '2026-05-01T12:05:02Z', 'text')
    `).run();

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
  beforeEach(() => {
    db = new Database(':memory:');
    setupDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns canonical session project metadata when present', async () => {
    db.prepare(`INSERT INTO agents (id, name, session_key) VALUES (1, 'Atlas', 'agent:atlas:main')`).run();
    db.prepare(`INSERT INTO projects (id, name) VALUES (7, 'Agent HQ Product')`).run();
    db.prepare(`
      INSERT INTO sessions (id, external_key, runtime, agent_id, project_id, status, title)
      VALUES (1, 'direct:atlas:web', 'openclaw', 1, 7, 'active', 'Atlas session')
    `).run();
    db.prepare(`
      INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp)
      VALUES
        ('m1', 1, NULL, 'direct:atlas:web', 'user', 'hello', '2026-05-01T12:00:00Z'),
        ('m2', 1, NULL, 'direct:atlas:web', 'assistant', 'hi', '2026-05-01T12:01:00Z')
    `).run();

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
    db.prepare(`INSERT INTO agents (id, name, session_key, project_id) VALUES (1, 'Cinder', 'agent:cinder:main', 99)`).run();
    db.prepare(`INSERT INTO projects (id, name) VALUES (9, 'Backend Bugs')`).run();
    db.prepare(`INSERT INTO projects (id, name) VALUES (99, 'Wrong Agent Project')`).run();
    db.prepare(`INSERT INTO tasks (id, title, project_id) VALUES (22, 'Fix chats API', 9)`).run();
    db.prepare(`
      INSERT INTO job_instances (id, task_id, agent_id, session_key, status, created_at)
      VALUES (33, 22, 1, 'run:33', 'done', '2026-05-01T11:59:00Z')
    `).run();
    db.prepare(`
      INSERT INTO sessions (id, external_key, runtime, agent_id, task_id, instance_id, project_id, status, title)
      VALUES (1, 'run:33', 'openclaw', 1, 22, 33, 9, 'completed', 'Cinder run')
    `).run();
    db.prepare(`
      INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp)
      VALUES
        ('m1', 1, 33, 'run:33', 'user', 'start', '2026-05-01T12:00:00Z'),
        ('m2', 1, 33, 'run:33', 'assistant', 'done', '2026-05-01T12:03:00Z')
    `).run();

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
    db.prepare(`INSERT INTO agents (id, name, session_key) VALUES (1, 'Atlas', 'agent:atlas:main')`).run();
    db.prepare(`INSERT INTO projects (id, name) VALUES (9, 'Backend Bugs')`).run();
    db.prepare(`INSERT INTO tasks (id, title, project_id) VALUES (22, 'Fix chats API', 9)`).run();
    db.prepare(`
      INSERT INTO job_instances (id, task_id, agent_id, session_key, status, created_at)
      VALUES (33, 22, 1, 'run:33', 'done', '2026-05-01T11:59:00Z')
    `).run();
    db.prepare(`
      INSERT INTO sessions (id, external_key, runtime, agent_id, task_id, instance_id, project_id, status, title)
      VALUES (1, 'run:33', 'openclaw', 1, 22, 33, NULL, 'completed', 'Unassigned run')
    `).run();
    db.prepare(`
      INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp)
      VALUES ('m1', 1, 33, 'run:33', 'user', 'hello', '2026-05-01T12:00:00Z')
    `).run();

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
    db.prepare(`INSERT INTO agents (id, name, session_key) VALUES (1, 'Cinder', 'agent:cinder:main')`).run();
    db.prepare(`INSERT INTO agents (id, name, session_key) VALUES (2, 'Atlas', 'agent:atlas:main')`).run();
    db.prepare(`INSERT INTO projects (id, name) VALUES (9, 'Backend Bugs')`).run();
    db.prepare(`INSERT INTO tasks (id, title, project_id) VALUES (22, 'Show starting chat', 9)`).run();
    db.prepare(`
      INSERT INTO sessions (id, external_key, runtime, agent_id, project_id, status, title, message_count)
      VALUES (1, 'direct:atlas:web', 'openclaw', 2, NULL, 'active', 'Atlas direct', 1)
    `).run();
    db.prepare(`
      INSERT INTO job_instances (id, task_id, agent_id, session_key, status, created_at)
      VALUES (4581, 22, 1, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'dispatched', '2026-05-01T11:59:00Z')
    `).run();
    db.prepare(`
      INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp)
      VALUES
        ('prompt-1', 1, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Initial task prompt', '2026-05-01T12:00:00Z'),
        ('prompt-2', 1, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Dispatch contract', '2026-05-01T12:00:01Z')
    `).run();

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
    db.prepare(`INSERT INTO agents (id, name, session_key) VALUES (1, 'Cinder', 'agent:cinder:main')`).run();
    db.prepare(`INSERT INTO agents (id, name, session_key) VALUES (2, 'Atlas', 'agent:atlas:main')`).run();
    db.prepare(`INSERT INTO projects (id, name) VALUES (9, 'Backend Bugs')`).run();
    db.prepare(`INSERT INTO tasks (id, title, project_id) VALUES (22, 'Show starting chat', 9)`).run();
    db.prepare(`
      INSERT INTO sessions (id, external_key, runtime, agent_id, project_id, status, title, message_count)
      VALUES (1, 'direct:atlas:web', 'openclaw', 2, NULL, 'active', 'Atlas direct', 1)
    `).run();
    db.prepare(`
      INSERT INTO job_instances (id, task_id, agent_id, session_key, status, created_at)
      VALUES (4581, 22, 1, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'dispatched', '2026-05-01T11:59:00Z')
    `).run();
    db.prepare(`
      INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp)
      VALUES
        ('prompt-1', 1, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Initial task prompt', '2026-05-01T12:00:00Z'),
        ('prompt-2', 1, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Dispatch contract', '2026-05-01T12:00:01Z')
    `).run();

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
    db.prepare(`INSERT INTO agents (id, name, session_key) VALUES (1, 'Cinder', 'agent:cinder:main')`).run();
    db.prepare(`INSERT INTO projects (id, name) VALUES (9, 'Backend Bugs')`).run();
    db.prepare(`INSERT INTO projects (id, name) VALUES (10, 'Mobile UX')`).run();
    db.prepare(`INSERT INTO tasks (id, title, project_id) VALUES (22, 'Backend run', 9)`).run();
    db.prepare(`INSERT INTO tasks (id, title, project_id) VALUES (23, 'Mobile run', 10)`).run();
    db.prepare(`
      INSERT INTO job_instances (id, task_id, agent_id, session_key, status, created_at)
      VALUES
        (33, 22, 1, 'run:33', 'done', '2026-05-01T11:59:00Z'),
        (44, 23, 1, 'run:44', 'done', '2026-05-01T12:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO sessions (id, external_key, runtime, agent_id, task_id, instance_id, project_id, status, title, message_count)
      VALUES (1, 'run:33', 'openclaw', 1, 22, 33, 9, 'completed', 'Backend canonical', 1)
    `).run();
    db.prepare(`
      INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp)
      VALUES
        ('m1', 1, 33, 'run:33', 'assistant', 'backend canonical', '2026-05-01T12:01:00Z'),
        ('m2', 1, 44, 'run:44', 'assistant', 'mobile raw', '2026-05-01T12:02:00Z')
    `).run();

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
