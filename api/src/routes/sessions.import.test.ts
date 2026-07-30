import Database from 'better-sqlite3';
import express from 'express';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

let db: Db;
let mockTranscriptMessages: Array<{
  id: string;
  role: string;
  content: string;
  timestamp: string;
  event_type?: string;
  event_meta?: Record<string, unknown>;
}> = [];

jest.mock('../db/client', () => ({
  getDb: () => db,
}));

jest.mock('../domains/runs/transcriptProvider', () => ({
  resolveTranscriptProvider: () => ({
    name: 'test-empty-provider',
    getTranscript: async (instanceId: number) => ({
      sessionKey: `run:${instanceId}:244f30ff-cf5d-4c86-96f9-273787cf8062`,
      source: 'empty-test-provider',
      in_progress: true,
      messages: mockTranscriptMessages,
    }),
  }),
}));

import sessionsRouter from './sessions';
import { type Db } from "../db/adapter/types";
import { SqliteAdapter } from "../db/adapter/SqliteAdapter";

async function postJson(app: express.Express, route: string): Promise<{ status: number; body: any }> {
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST' });
    return {
      status: res.status,
      body: await res.json(),
    };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function setupDb(): Promise<void> {
  await db.exec(`
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT,
      session_key TEXT,
      runtime_type TEXT
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
      started_at TEXT,
      completed_at TEXT,
      dispatched_at TEXT,
      created_at TEXT,
      run_id TEXT,
      token_input INTEGER,
      token_output INTEGER
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

    CREATE TABLE session_messages (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      role TEXT NOT NULL,
      event_type TEXT NOT NULL,
      content TEXT NOT NULL,
      event_meta TEXT NOT NULL DEFAULT '{}',
      raw_payload TEXT,
      timestamp TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_id, ordinal)
    );

    CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY,
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

describe('POST /api/v1/sessions/import/instance/:instanceId', () => {
  beforeEach(async () => {
    db = new SqliteAdapter(new Database(':memory:'));
    mockTranscriptMessages = [];
    await setupDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('creates a canonical active session and backfills prompt-only chat_messages for a dispatched OpenClaw run', async () => {
    await db.run(`INSERT INTO agents (id, name, session_key, runtime_type) VALUES (97, 'Cinder', 'agent:cinder:main', 'openclaw')`);
    await db.run(`INSERT INTO projects (id, name) VALUES (9, 'Backend Bugs')`);
    await db.run(`INSERT INTO tasks (id, title, project_id) VALUES (679, 'Prompt-only run', 9)`);
    await db.run(`
      INSERT INTO job_instances (
        id, task_id, agent_id, session_key, status, started_at, completed_at, dispatched_at, created_at, run_id
      ) VALUES (
        4581, 679, 97, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062',
        'dispatched', NULL, NULL, '2026-05-01T11:59:00Z', '2026-05-01T11:58:00Z', NULL
      )
    `);
    await db.run(`
      INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp, event_type)
      VALUES
        (1, 97, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Initial task prompt', '2026-05-01T12:00:00Z', 'text'),
        (2, 97, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Dispatch contract', '2026-05-01T12:00:01Z', 'text')
    `);

    const app = express();
    app.use(express.json());
    app.use('/api/v1/sessions', sessionsRouter);

    const res = await postJson(app, '/api/v1/sessions/import/instance/4581');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      external_key: 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062',
      runtime: 'openclaw',
      agent_id: 97,
      task_id: 679,
      instance_id: 4581,
      project_id: 9,
      status: 'active',
      title: 'Prompt-only run',
      started_at: '2026-05-01 11:59:00',
      message_count: 2,
    });

    const rows = await db.all(`
      SELECT ordinal, role, event_type, content
      FROM session_messages
      WHERE session_id = ?
      ORDER BY ordinal ASC
    `, res.body.id);

    expect(rows).toEqual([
      { ordinal: 0, role: 'user', event_type: 'text', content: 'Initial task prompt' },
      { ordinal: 1, role: 'user', event_type: 'text', content: 'Dispatch contract' },
    ]);
  });

  it('does not duplicate prompt-only chat_messages when the provider transcript is chat_messages-backed', async () => {
    mockTranscriptMessages = [
      {
        id: '1',
        role: 'user',
        content: 'Initial task prompt',
        timestamp: '2026-05-01T12:00:00Z',
        event_type: 'text',
      },
      {
        id: '2',
        role: 'user',
        content: 'Dispatch contract',
        timestamp: '2026-05-01T12:00:01Z',
        event_type: 'text',
      },
    ];

    await db.run(`INSERT INTO agents (id, name, session_key, runtime_type) VALUES (97, 'Cinder', 'agent:cinder:main', 'openclaw')`);
    await db.run(`INSERT INTO projects (id, name) VALUES (9, 'Backend Bugs')`);
    await db.run(`INSERT INTO tasks (id, title, project_id) VALUES (679, 'Prompt-only run', 9)`);
    await db.run(`
      INSERT INTO job_instances (
        id, task_id, agent_id, session_key, status, started_at, completed_at, dispatched_at, created_at, run_id
      ) VALUES (
        4581, 679, 97, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062',
        'dispatched', NULL, NULL, '2026-05-01T11:59:00Z', '2026-05-01T11:58:00Z', NULL
      )
    `);
    await db.run(`
      INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp, event_type)
      VALUES
        (1, 97, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Initial task prompt', '2026-05-01T12:00:00Z', 'text'),
        (2, 97, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Dispatch contract', '2026-05-01T12:00:01Z', 'text')
    `);

    const app = express();
    app.use(express.json());
    app.use('/api/v1/sessions', sessionsRouter);

    const res = await postJson(app, '/api/v1/sessions/import/instance/4581');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message_count: 2 });

    const rows = await db.all(`
      SELECT ordinal, role, event_type, content, raw_payload
      FROM session_messages
      WHERE session_id = ?
      ORDER BY ordinal ASC
    `, res.body.id);

    expect(rows).toEqual([
      { ordinal: 0, role: 'user', event_type: 'text', content: 'Initial task prompt', raw_payload: '1' },
      { ordinal: 1, role: 'user', event_type: 'text', content: 'Dispatch contract', raw_payload: '2' },
    ]);
  });

  it('imports a dispatched prompt-only run from chat_messages when job_instances has no session_key yet', async () => {
    await db.run(`INSERT INTO agents (id, name, session_key, runtime_type) VALUES (97, 'Cinder', 'agent:cinder:main', 'openclaw')`);
    await db.run(`INSERT INTO projects (id, name) VALUES (9, 'Backend Bugs')`);
    await db.run(`INSERT INTO tasks (id, title, project_id) VALUES (679, 'Prompt-only run', 9)`);
    await db.run(`
      INSERT INTO job_instances (
        id, task_id, agent_id, session_key, status, started_at, completed_at, dispatched_at, created_at, run_id
      ) VALUES (
        4581, 679, 97, NULL,
        'dispatched', NULL, NULL, '2026-05-01T11:59:00Z', '2026-05-01T11:58:00Z', NULL
      )
    `);
    await db.run(`
      INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp, event_type)
      VALUES
        (1, 97, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Initial task prompt', '2026-05-01T12:00:00Z', 'text'),
        (2, 97, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Dispatch contract', '2026-05-01T12:00:01Z', 'text')
    `);

    const app = express();
    app.use(express.json());
    app.use('/api/v1/sessions', sessionsRouter);

    const res = await postJson(app, '/api/v1/sessions/import/instance/4581');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      external_key: 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062',
      runtime: 'openclaw',
      agent_id: 97,
      task_id: 679,
      instance_id: 4581,
      project_id: 9,
      status: 'active',
      message_count: 2,
    });

    const rows = await db.all(`
      SELECT ordinal, role, event_type, content, raw_payload
      FROM session_messages
      WHERE session_id = ?
      ORDER BY ordinal ASC
    `, res.body.id);

    expect(rows).toEqual([
      { ordinal: 0, role: 'user', event_type: 'text', content: 'Initial task prompt', raw_payload: '1' },
      { ordinal: 1, role: 'user', event_type: 'text', content: 'Dispatch contract', raw_payload: '2' },
    ]);
  });

  it('keeps prompt chat_messages when the provider returns a partial non-empty transcript', async () => {
    mockTranscriptMessages = [{
      id: 'provider-1',
      role: 'system',
      content: 'Runtime initialized',
      timestamp: '2026-05-01T12:00:02Z',
      event_type: 'turn_start',
      event_meta: { source: 'provider' },
    }];

    await db.run(`INSERT INTO agents (id, name, session_key, runtime_type) VALUES (97, 'Cinder', 'agent:cinder:main', 'openclaw')`);
    await db.run(`INSERT INTO projects (id, name) VALUES (9, 'Backend Bugs')`);
    await db.run(`INSERT INTO tasks (id, title, project_id) VALUES (679, 'Prompt-only run', 9)`);
    await db.run(`
      INSERT INTO job_instances (
        id, task_id, agent_id, session_key, status, started_at, completed_at, dispatched_at, created_at, run_id
      ) VALUES (
        4581, 679, 97, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062',
        'dispatched', NULL, NULL, '2026-05-01T11:59:00Z', '2026-05-01T11:58:00Z', NULL
      )
    `);
    await db.run(`
      INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp, event_type)
      VALUES
        (1, 97, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Initial task prompt', '2026-05-01T12:00:00Z', 'text'),
        (2, 97, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Dispatch contract', '2026-05-01T12:00:01Z', 'text')
    `);

    const app = express();
    app.use(express.json());
    app.use('/api/v1/sessions', sessionsRouter);

    const res = await postJson(app, '/api/v1/sessions/import/instance/4581');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message_count: 3 });

    const rows = await db.all(`
      SELECT ordinal, role, event_type, content, raw_payload
      FROM session_messages
      WHERE session_id = ?
      ORDER BY ordinal ASC
    `, res.body.id);

    expect(rows).toEqual([
      { ordinal: 0, role: 'system', event_type: 'turn_start', content: 'Runtime initialized', raw_payload: null },
      { ordinal: 1, role: 'user', event_type: 'text', content: 'Initial task prompt', raw_payload: '1' },
      { ordinal: 2, role: 'user', event_type: 'text', content: 'Dispatch contract', raw_payload: '2' },
    ]);
  });
});
