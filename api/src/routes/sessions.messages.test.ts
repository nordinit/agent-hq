import Database from 'better-sqlite3';
import { SqliteAdapter } from '../db/adapter/SqliteAdapter';
import express from 'express';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

let db: Db;

jest.mock('../db/client', () => ({
  getDb: () => db,
}));

import sessionsRouter from './sessions';
import { type Db } from "../db/adapter/types";

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

async function postJson(app: express.Express, route: string): Promise<{ status: number; body: any }> {
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
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
      name TEXT NOT NULL,
      runtime_type TEXT NOT NULL DEFAULT 'openclaw',
      runtime_config TEXT,
      session_key TEXT NOT NULL DEFAULT '',
      hooks_url TEXT,
      openclaw_agent_id TEXT
    );

    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      project_id INTEGER
    );

    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      session_key TEXT,
      status TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      dispatched_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      run_id TEXT,
      durable_run_id TEXT,
      error TEXT,
      token_input INTEGER,
      token_output INTEGER,
      agent_id INTEGER,
      task_id INTEGER,
      runtime_ended_at TEXT,
      runtime_end_success INTEGER,
      runtime_end_error TEXT,
      runtime_end_source TEXT,
      runtime_completed_at TEXT
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      role TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'text',
      content TEXT NOT NULL DEFAULT '',
      event_meta TEXT NOT NULL DEFAULT '{}',
      raw_payload TEXT,
      timestamp TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_id, ordinal)
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

describe('GET /api/v1/sessions/:id/messages active live sync', () => {
  beforeEach(async () => {
    db = new SqliteAdapter(new Database(':memory:'));
    await setupDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('updates rolling assistant stream rows and appends tool events without duplicates', async () => {
    await db.run(`
      INSERT INTO sessions (id, external_key, runtime, agent_id, instance_id, status, title, message_count)
      VALUES (1, 'run:42', 'openclaw', 7, 42, 'active', 'Active run', 1)
    `);
    await db.run(`
      INSERT INTO session_messages (session_id, ordinal, role, event_type, content, event_meta, raw_payload, timestamp)
      VALUES (1, 0, 'assistant', 'text', 'partial', '{}', 'oc-stream-42', '2026-06-02T12:00:00.000Z')
    `);
    await db.run(`
      INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp, event_type, event_meta)
      VALUES
        ('oc-stream-42', 7, 42, 'run:42', 'assistant', 'partial answer', '2026-06-02T12:00:00.000Z', 'text', '{}'),
        ('oc-tool-42-1', 7, 42, 'run:42', 'assistant', 'exec_command', '2026-06-02T12:00:01.000Z', 'tool_call', '{"name":"exec_command"}')
    `);

    const app = express();
    app.use('/api/v1/sessions', sessionsRouter);

    const first = await getJson(app, '/api/v1/sessions/1/messages');
    expect(first.status).toBe(200);
    expect(first.body).toHaveLength(2);
    expect(first.body[0]).toMatchObject({
      ordinal: 0,
      raw_payload: 'oc-stream-42',
      content: 'partial answer',
      event_type: 'text',
    });
    expect(first.body[1]).toMatchObject({
      ordinal: 1,
      raw_payload: 'oc-tool-42-1',
      event_type: 'tool_call',
      content: 'exec_command',
    });

    await db.run(`UPDATE chat_messages SET content = ? WHERE id = ?`, 'partial answer continued', 'oc-stream-42');

    const second = await getJson(app, '/api/v1/sessions/1/messages');
    expect(second.status).toBe(200);
    expect(second.body).toHaveLength(2);
    expect(second.body[0]).toMatchObject({
      ordinal: 0,
      raw_payload: 'oc-stream-42',
      content: 'partial answer continued',
    });
  });
});

describe('POST /api/v1/sessions/import/instance/:instanceId completed reimport', () => {
  beforeEach(async () => {
    db = new SqliteAdapter(new Database(':memory:'));
    await setupDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('refreshes stale partial canonical rows from completed chat_messages without force', async () => {
    await db.run(`
      INSERT INTO agents (id, name, runtime_type, session_key)
      VALUES (7, 'Cinder', 'openclaw', 'agent:cinder')
    `);
    await db.run(`
      INSERT INTO tasks (id, title, project_id)
      VALUES (719, 'Stream Agent Run chat events live', 1)
    `);
    await db.run(`
      INSERT INTO job_instances (
        id, session_key, status, started_at, completed_at, dispatched_at, created_at,
        run_id, agent_id, task_id
      )
      VALUES (
        42, 'run:42', 'done', '2026-06-02T12:00:00.000Z',
        '2026-06-02T12:05:00.000Z', '2026-06-02T11:59:00.000Z',
        '2026-06-02T11:58:00.000Z', 'durable-42', 7, 719
      )
    `);
    await db.run(`
      INSERT INTO sessions (id, external_key, runtime, agent_id, task_id, instance_id, project_id, status, title, message_count)
      VALUES (1, 'run:42', 'openclaw', 7, 719, 42, 1, 'active', 'Stream Agent Run chat events live', 2)
    `);
    await db.run(`
      INSERT INTO session_messages (session_id, ordinal, role, event_type, content, event_meta, raw_payload, timestamp)
      VALUES
        (1, 0, 'user', 'text', 'QA prompt for live stream', '{}', 'qa-user', '2026-06-02T12:00:00.000Z'),
        (1, 1, 'assistant', 'text', 'QA streaming start', '{}', 'oc-stream-42', '2026-06-02T12:00:01.000Z')
    `);
    await db.run(`
      INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp, event_type, event_meta)
      VALUES
        ('qa-user', 7, 42, 'run:42', 'user', 'QA prompt for live stream', '2026-06-02T12:00:00.000Z', 'text', '{}'),
        ('oc-stream-42', 7, 42, 'run:42', 'assistant', 'QA streaming start and live continuation', '2026-06-02T12:00:01.000Z', 'text', '{}'),
        ('qa-tool-call', 7, 42, 'run:42', 'assistant', 'exec_command', '2026-06-02T12:00:02.000Z', 'tool_call', '{"name":"exec_command"}'),
        ('qa-tool-result', 7, 42, 'run:42', 'tool', 'command output', '2026-06-02T12:00:03.000Z', 'tool_result', '{"output":"command output"}')
    `);

    const app = express();
    app.use('/api/v1/sessions', sessionsRouter);

    const imported = await postJson(app, '/api/v1/sessions/import/instance/42');
    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({
      id: 1,
      status: 'completed',
      message_count: 4,
    });

    const refreshed = await getJson(app, '/api/v1/sessions/1/messages');
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toHaveLength(4);
    expect(refreshed.body.map((row: any) => row.content)).toEqual([
      'QA prompt for live stream',
      'QA streaming start and live continuation',
      'exec_command',
      'command output',
    ]);
    expect(refreshed.body.map((row: any) => row.event_type)).toEqual([
      'text',
      'text',
      'tool_call',
      'tool_result',
    ]);
  });

  it('imports Hermes tool_call and tool_result rows from chat_messages through the canonical session route', async () => {
    await db.run(`
      INSERT INTO agents (id, name, runtime_type, session_key)
      VALUES (17, 'Hermes Cinder', 'hermes', 'agent:hermes-cinder')
    `);
    await db.run(`
      INSERT INTO tasks (id, title, project_id)
      VALUES (741, 'Add Hermes live tool-call transcript capture', 86)
    `);
    await db.run(`
      INSERT INTO job_instances (
        id, session_key, status, started_at, completed_at, dispatched_at, created_at,
        run_id, durable_run_id, agent_id, task_id
      )
      VALUES (
        4806,
        'run:4806:c0b69cdf-a734-4faf-bf8e-9515d47c3640',
        'done',
        '2026-06-03T06:40:00.000Z',
        '2026-06-03T06:45:00.000Z',
        '2026-06-03T06:39:00.000Z',
        '2026-06-03T06:38:00.000Z',
        'hermes:4806',
        'c0b69cdf-a734-4faf-bf8e-9515d47c3640',
        17,
        741
      )
    `);
    await db.run(`
      INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp, event_type, event_meta)
      VALUES
        ('hermes-json-4806-0-0', 17, 4806, 'run:4806:c0b69cdf-a734-4faf-bf8e-9515d47c3640', 'user', 'Inspect Hermes transcript', '2026-06-03T06:40:01.000Z', 'text', '{}'),
        ('hermes-json-4806-1-0', 17, 4806, 'run:4806:c0b69cdf-a734-4faf-bf8e-9515d47c3640', 'assistant', 'exec_command', '2026-06-03T06:40:02.000Z', 'tool_call', '{"name":"exec_command"}'),
        ('hermes-json-4806-2-0', 17, 4806, 'run:4806:c0b69cdf-a734-4faf-bf8e-9515d47c3640', 'tool', 'HermesRuntime.ts', '2026-06-03T06:40:03.000Z', 'tool_result', '{"output":"HermesRuntime.ts"}')
    `);

    const app = express();
    app.use('/api/v1/sessions', sessionsRouter);

    const imported = await postJson(app, '/api/v1/sessions/import/instance/4806');
    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({
      runtime: 'hermes',
      status: 'completed',
      message_count: 3,
    });

    const messages = await getJson(app, `/api/v1/sessions/${imported.body.id}/messages`);
    expect(messages.status).toBe(200);
    expect(messages.body.map((row: any) => [row.role, row.event_type, row.content])).toEqual([
      ['user', 'text', 'Inspect Hermes transcript'],
      ['assistant', 'tool_call', 'exec_command'],
      ['tool', 'tool_result', 'HermesRuntime.ts'],
    ]);
  });
});
