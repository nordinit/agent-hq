import Database from 'better-sqlite3';
import express from 'express';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

let db: Db;

jest.mock('../db/client', () => ({
  getDb: () => db,
}));

jest.mock('../domains/runs/transcriptProvider', () => ({
  resolveTranscriptProvider: () => ({
    name: 'tenant-scope-test-provider',
    getTranscript: async (instanceId: number) => ({
      sessionKey: `run:${instanceId}`,
      source: 'test-provider',
      in_progress: false,
      messages: [],
    }),
  }),
}));

import chatRouter from './chat';
import logsRouter from './logs';
import sessionsRouter from './sessions';
import telemetryRouter from './telemetry';
import { insertRuntimeLog } from '../lib/runtimeTenantScope';
import { type Db } from "../db/adapter/types";

async function requestJson(app: express.Express, route: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${route}`, init);
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function setActiveTenant(tenantId: number): Promise<void> {
  await db.run(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('active_tenant_id', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `, String(tenantId));
}

async function setupDb(): Promise<void> {
  await db.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE tenants (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER,
      name TEXT,
      job_title TEXT,
      session_key TEXT,
      project_id INTEGER,
      runtime_type TEXT,
      openclaw_agent_id TEXT,
      hooks_url TEXT
    );

    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER,
      name TEXT NOT NULL
    );

    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER,
      title TEXT,
      status TEXT DEFAULT 'todo',
      priority TEXT DEFAULT 'medium',
      project_id INTEGER,
      sprint_id INTEGER,
      agent_id INTEGER,
      retry_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT '2026-06-01T00:00:00Z',
      updated_at TEXT DEFAULT '2026-06-01T00:00:00Z'
    );

    CREATE TABLE sprints (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER,
      project_id INTEGER,
      name TEXT,
      sprint_type TEXT
    );

    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER,
      task_id INTEGER,
      agent_id INTEGER,
      session_key TEXT,
      status TEXT,
      created_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      dispatched_at TEXT,
      durable_run_id TEXT,
      run_id TEXT,
      token_input INTEGER,
      token_output INTEGER
    );

    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER,
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
      id TEXT PRIMARY KEY,
      tenant_id INTEGER,
      agent_id INTEGER NOT NULL,
      instance_id INTEGER,
      session_key TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'text',
      event_meta TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE logs (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER,
      instance_id INTEGER,
      agent_id INTEGER,
      job_title TEXT DEFAULT '',
      level TEXT DEFAULT 'info',
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE task_creation_events (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER,
      task_id INTEGER,
      project_id INTEGER,
      sprint_id INTEGER,
      job_id INTEGER,
      source TEXT,
      routing TEXT,
      confidence TEXT,
      scope_size TEXT,
      assumptions TEXT,
      open_questions TEXT,
      needs_split INTEGER,
      expected_artifact TEXT,
      success_mode TEXT,
      raw_input TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE task_outcome_metrics (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER,
      task_id INTEGER,
      project_id INTEGER,
      sprint_id INTEGER,
      job_id INTEGER,
      first_pass_qa INTEGER DEFAULT 0,
      reopened_count INTEGER DEFAULT 0,
      rerouted_count INTEGER DEFAULT 0,
      split_after_creation INTEGER DEFAULT 0,
      blocked_after_creation INTEGER DEFAULT 0,
      clarification_count INTEGER DEFAULT 0,
      notes_count INTEGER DEFAULT 0,
      cycle_time_hours REAL,
      outcome_quality TEXT,
      failure_reasons TEXT DEFAULT '[]',
      outcome_summary TEXT,
      recorded_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT
    );

    CREATE TABLE task_history (id INTEGER PRIMARY KEY, tenant_id INTEGER, task_id INTEGER, action TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE task_notes (id INTEGER PRIMARY KEY, tenant_id INTEGER, task_id INTEGER, author TEXT, content TEXT, created_at TEXT DEFAULT (datetime('now')));

    INSERT INTO tenants (id, name, slug, is_default)
    VALUES (1, 'Tenant One', 'tenant-one', 1), (2, 'Tenant Two', 'tenant-two', 0);
    INSERT INTO app_settings (key, value) VALUES ('active_tenant_id', '1');

    INSERT INTO projects (id, tenant_id, name) VALUES (11, 1, 'One Project'), (22, 2, 'Two Project');
    INSERT INTO agents (id, tenant_id, name, job_title, session_key, project_id, runtime_type)
    VALUES (101, 1, 'One Agent', 'One Job', 'agent:one', 11, 'openclaw'), (202, 2, 'Two Agent', 'Two Job', 'agent:two', 22, 'openclaw');
    INSERT INTO tasks (id, tenant_id, title, status, project_id, agent_id)
    VALUES (1001, 1, 'Tenant one task', 'done', 11, 101), (2002, 2, 'Tenant two task', 'done', 22, 202);
    INSERT INTO job_instances (id, tenant_id, task_id, agent_id, session_key, status, created_at, started_at)
    VALUES (501, 1, 1001, 101, 'run:501', 'done', '2026-06-01T01:00:00Z', '2026-06-01T01:00:00Z'),
           (602, 2, 2002, 202, 'run:602', 'done', '2026-06-01T02:00:00Z', '2026-06-01T02:00:00Z');
    INSERT INTO sessions (id, tenant_id, external_key, runtime, agent_id, task_id, instance_id, project_id, status, title, started_at, message_count)
    VALUES (1, 1, 'run:501', 'openclaw', 101, 1001, 501, 11, 'completed', 'Tenant one run', '2026-06-01T01:00:00Z', 1),
           (2, 2, 'run:602', 'openclaw', 202, 2002, 602, 22, 'completed', 'Tenant two run', '2026-06-01T02:00:00Z', 1);
    INSERT INTO chat_messages (id, tenant_id, agent_id, instance_id, session_key, role, content, timestamp)
    VALUES ('one-chat', 1, 101, 501, 'run:501', 'user', 'one private prompt', '2026-06-01T01:01:00Z'),
           ('two-chat', 2, 202, 602, 'run:602', 'user', 'two private prompt', '2026-06-01T02:01:00Z');
    INSERT INTO logs (id, tenant_id, instance_id, agent_id, message, created_at)
    VALUES (1, 1, 501, 101, 'one private log', '2026-06-01T01:02:00Z'),
           (2, 2, 602, 202, 'two private log', '2026-06-01T02:02:00Z'),
           (3, 1, NULL, 202, 'conflicting tenant log', '2026-06-01T03:02:00Z');
    INSERT INTO task_creation_events (id, tenant_id, task_id, project_id, job_id, source, confidence, scope_size, assumptions, open_questions, needs_split)
    VALUES (1, 1, 1001, 11, 101, 'manual', 'high', 'small', '[]', '[]', 0),
           (2, 2, 2002, 22, 202, 'manual', 'high', 'small', '[]', '[]', 0);
    INSERT INTO task_outcome_metrics (id, tenant_id, task_id, project_id, job_id, first_pass_qa, failure_reasons, outcome_quality)
    VALUES (1, 1, 1001, 11, 101, 1, '[]', 'good'),
           (2, 2, 2002, 22, 202, 1, '[]', 'good');
  `);
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/chat', chatRouter);
  app.use('/api/v1/logs', logsRouter);
  app.use('/api/v1/sessions', sessionsRouter);
  app.use('/api/v1/telemetry', telemetryRouter);
  return app;
}

describe('runtime tenant scope', () => {
  beforeEach(async () => {
    db = new Database(':memory:');
    await setupDb();
  });

  afterEach(() => {
    db.close();
  });

  it('filters chat sessions, canonical sessions, logs, instance history, and telemetry to the active tenant', async () => {
    await setActiveTenant(2);
    const app = buildApp();

    const chatSessions = await requestJson(app, '/api/v1/chat/sessions');
    expect(chatSessions.status).toBe(200);
    expect(chatSessions.body.map((row: any) => row.session_key)).toEqual(['run:602']);

    const hiddenMessages = await requestJson(app, '/api/v1/chat/sessions/501/messages');
    expect(hiddenMessages.status).toBe(200);
    expect(hiddenMessages.body).toEqual([]);

    const hiddenSession = await requestJson(app, '/api/v1/sessions/1');
    expect(hiddenSession.status).toBe(404);
    const visibleSession = await requestJson(app, '/api/v1/sessions/2');
    expect(visibleSession.status).toBe(200);
    expect(visibleSession.body.title).toBe('Tenant two run');

    const logs = await requestJson(app, '/api/v1/logs');
    expect(logs.body.map((row: any) => row.message)).toEqual(['two private log']);

    const instances = await requestJson(app, '/api/v1/logs/instances');
    expect(instances.body.map((row: any) => row.id)).toEqual([602]);

    const telemetry = await requestJson(app, '/api/v1/telemetry/review');
    expect(telemetry.body.total).toBe(1);
    expect(telemetry.body.tasks.map((row: any) => row.id)).toEqual([2002]);

    const overview = await requestJson(app, '/api/v1/telemetry/overview');
    expect(overview.body.total_created).toBe(1);
    expect(overview.body.total_with_outcome).toBe(1);
  });

  it('imports canonical sessions with tenant ownership derived from the owning task', async () => {
    await setActiveTenant(2);
    await db.run(`DELETE FROM sessions WHERE id = 2`);

    const app = buildApp();
    const imported = await requestJson(app, '/api/v1/sessions/import/instance/602', { method: 'POST' });

    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({
      external_key: 'run:602',
      tenant_id: 2,
      task_id: 2002,
      agent_id: 202,
      project_id: 22,
    });
    const row = await db.get(`SELECT tenant_id FROM sessions WHERE external_key = 'run:602'`) as { tenant_id: number };
    expect(row.tenant_id).toBe(2);
  });

  it('writes runtime logs with tenant ownership derived from the owning instance', async () => {
    await setActiveTenant(1);

    await insertRuntimeLog(db, {
            instanceId: 602,
            agentId: 202,
            jobTitle: 'writer-test',
            level: 'info',
            message: 'tenant two derived runtime log',
          });

    const row = await db.get(`
      SELECT tenant_id, instance_id, agent_id, message
      FROM logs
      WHERE message = 'tenant two derived runtime log'
    `) as { tenant_id: number; instance_id: number; agent_id: number; message: string };
    expect(row).toEqual({
      tenant_id: 2,
      instance_id: 602,
      agent_id: 202,
      message: 'tenant two derived runtime log',
    });
  });
});
