import { setupTestDb, teardownTestDb } from '../db/testDb';
import express from 'express';
import { request as httpRequest } from 'http';
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

async function postJson(app: express.Express, route: string): Promise<{ status: number; body: any }> {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return await new Promise<{ status: number; body: any }>((resolve, reject) => {
      // Do not use the process-global fetch/Undici connection pool here. A pooled keep-alive
      // socket can outlive the response and make server.close() wait behind unrelated full-suite
      // activity. This request owns one socket and explicitly closes it with the response.
      const request = httpRequest({
        host: '127.0.0.1',
        port,
        path: route,
        method: 'POST',
        agent: false,
        headers: { connection: 'close' },
      }, (response) => {
        response.setEncoding('utf8');
        let rawBody = '';
        response.on('data', (chunk: string) => { rawBody += chunk; });
        response.on('error', reject);
        response.on('end', () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(rawBody),
            });
          } catch (error) {
            reject(error);
          }
        });
      });
      request.setTimeout(30_000, () => {
        request.destroy(new Error(`POST ${route} timed out waiting for the test server`));
      });
      request.on('error', reject);
      request.end();
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      // close() stops new connections; this closes any socket that raced with shutdown. The
      // response body has already been consumed before this finally block begins.
      server.closeAllConnections();
    });
  }
}

async function setupDb(): Promise<void> {
  await db.run(`
    INSERT INTO tenants (id, name, slug, is_default)
    VALUES (1, 'Default', 'default', 1)
  `);
  await db.run(`
    INSERT INTO app_settings (key, value)
    VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')
  `);
  await db.run(`
    INSERT INTO projects (id, tenant_id, name)
    VALUES (9, 1, 'Backend Bugs')
  `);
  await db.run(`
    INSERT INTO sprints (id, tenant_id, project_id, name)
    VALUES (9, 1, 9, 'Backend Bugs')
  `);
}

describe('POST /api/v1/sessions/import/instance/:instanceId', () => {
  beforeEach(async () => {
    db = await setupTestDb();
    mockTranscriptMessages = [];
    await setupDb();
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('creates a canonical active session and backfills prompt-only chat_messages for a dispatched OpenClaw run', async () => {
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, runtime_type) VALUES (97, 1, 'Cinder', 'agent:cinder:main', 'openclaw')`);
    await db.run(`INSERT INTO tasks (id, tenant_id, title, project_id, sprint_id) VALUES (679, 1, 'Prompt-only run', 9, 9)`);
    await db.run(`
      INSERT INTO job_instances (
        id, tenant_id, task_id, agent_id, session_key, status, started_at, completed_at, dispatched_at, created_at, run_id
      ) VALUES (
        4581, 1, 679, 97, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062',
        'dispatched', NULL, NULL, '2026-05-01T11:59:00Z', '2026-05-01T11:58:00Z', NULL
      )
    `);
    await db.run(`
      INSERT INTO chat_messages (id, tenant_id, agent_id, instance_id, session_key, role, content, timestamp, event_type)
      VALUES
        ('1', 1, 97, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Initial task prompt', '2026-05-01T12:00:00Z', 'text'),
        ('2', 1, 97, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Dispatch contract', '2026-05-01T12:00:01Z', 'text')
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

    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, runtime_type) VALUES (97, 1, 'Cinder', 'agent:cinder:main', 'openclaw')`);
    await db.run(`INSERT INTO tasks (id, tenant_id, title, project_id, sprint_id) VALUES (679, 1, 'Prompt-only run', 9, 9)`);
    await db.run(`
      INSERT INTO job_instances (
        id, tenant_id, task_id, agent_id, session_key, status, started_at, completed_at, dispatched_at, created_at, run_id
      ) VALUES (
        4581, 1, 679, 97, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062',
        'dispatched', NULL, NULL, '2026-05-01T11:59:00Z', '2026-05-01T11:58:00Z', NULL
      )
    `);
    await db.run(`
      INSERT INTO chat_messages (id, tenant_id, agent_id, instance_id, session_key, role, content, timestamp, event_type)
      VALUES
        ('1', 1, 97, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Initial task prompt', '2026-05-01T12:00:00Z', 'text'),
        ('2', 1, 97, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Dispatch contract', '2026-05-01T12:00:01Z', 'text')
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
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, runtime_type) VALUES (97, 1, 'Cinder', 'agent:cinder:main', 'openclaw')`);
    await db.run(`INSERT INTO tasks (id, tenant_id, title, project_id, sprint_id) VALUES (679, 1, 'Prompt-only run', 9, 9)`);
    await db.run(`
      INSERT INTO job_instances (
        id, tenant_id, task_id, agent_id, session_key, status, started_at, completed_at, dispatched_at, created_at, run_id
      ) VALUES (
        4581, 1, 679, 97, NULL,
        'dispatched', NULL, NULL, '2026-05-01T11:59:00Z', '2026-05-01T11:58:00Z', NULL
      )
    `);
    await db.run(`
      INSERT INTO chat_messages (id, tenant_id, agent_id, instance_id, session_key, role, content, timestamp, event_type)
      VALUES
        ('1', 1, 97, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Initial task prompt', '2026-05-01T12:00:00Z', 'text'),
        ('2', 1, 97, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Dispatch contract', '2026-05-01T12:00:01Z', 'text')
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

    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, runtime_type) VALUES (97, 1, 'Cinder', 'agent:cinder:main', 'openclaw')`);
    await db.run(`INSERT INTO tasks (id, tenant_id, title, project_id, sprint_id) VALUES (679, 1, 'Prompt-only run', 9, 9)`);
    await db.run(`
      INSERT INTO job_instances (
        id, tenant_id, task_id, agent_id, session_key, status, started_at, completed_at, dispatched_at, created_at, run_id
      ) VALUES (
        4581, 1, 679, 97, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062',
        'dispatched', NULL, NULL, '2026-05-01T11:59:00Z', '2026-05-01T11:58:00Z', NULL
      )
    `);
    await db.run(`
      INSERT INTO chat_messages (id, tenant_id, agent_id, instance_id, session_key, role, content, timestamp, event_type)
      VALUES
        ('1', 1, 97, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Initial task prompt', '2026-05-01T12:00:00Z', 'text'),
        ('2', 1, 97, 4581, 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062', 'user', 'Dispatch contract', '2026-05-01T12:00:01Z', 'text')
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
