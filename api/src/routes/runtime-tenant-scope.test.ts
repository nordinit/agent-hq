import { setupTestDb, teardownTestDb } from '../db/testDb';
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
import {
  chatMessageTenantScope,
  insertRuntimeLog,
  instanceTenantScope,
  logTenantScope,
  sessionTenantScope,
} from '../lib/runtimeTenantScope';
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
    VALUES ('active_tenant_id', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `, String(tenantId));
}

async function setupDb(): Promise<void> {
  await db.exec(`
    INSERT INTO tenants (id, name, slug, is_default)
    VALUES (1, 'Tenant One', 'tenant-one', 1), (2, 'Tenant Two', 'tenant-two', 0);

    INSERT INTO app_settings (key, value)
    VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1');

    INSERT INTO projects (id, tenant_id, name)
    VALUES (11, 1, 'One Project'), (22, 2, 'Two Project');

    INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type)
    VALUES (111, 1, 11, 'One Workflow', 'generic'), (222, 2, 22, 'Two Workflow', 'generic');

    INSERT INTO agents (id, tenant_id, name, job_title, session_key, project_id, runtime_type)
    VALUES
      (101, 1, 'One Agent', 'One Job', 'agent:one', 11, 'openclaw'),
      (202, 2, 'Two Agent', 'Two Job', 'agent:two', 22, 'openclaw');

    INSERT INTO tasks (id, tenant_id, title, status, project_id, sprint_id, agent_id)
    VALUES
      (1001, 1, 'Tenant one task', 'done', 11, 111, 101),
      (2002, 2, 'Tenant two task', 'done', 22, 222, 202);

    INSERT INTO job_instances (id, tenant_id, task_id, agent_id, session_key, status, created_at, started_at)
    VALUES
      (501, 1, 1001, 101, 'run:501', 'done', '2026-06-01T01:00:00Z', '2026-06-01T01:00:00Z'),
      (602, 2, 2002, 202, 'run:602', 'done', '2026-06-01T02:00:00Z', '2026-06-01T02:00:00Z');

    INSERT INTO sessions (id, tenant_id, external_key, runtime, agent_id, task_id, instance_id, project_id, status, title, started_at, message_count)
    VALUES
      (1, 1, 'run:501', 'openclaw', 101, 1001, 501, 11, 'completed', 'Tenant one run', '2026-06-01T01:00:00Z', 1),
      (2, 2, 'run:602', 'openclaw', 202, 2002, 602, 22, 'completed', 'Tenant two run', '2026-06-01T02:00:00Z', 1);

    INSERT INTO chat_messages (id, tenant_id, agent_id, instance_id, session_key, role, content, timestamp)
    VALUES
      ('one-chat', 1, 101, 501, 'run:501', 'user', 'one private prompt', '2026-06-01T01:01:00Z'),
      ('two-chat', 2, 202, 602, 'run:602', 'user', 'two private prompt', '2026-06-01T02:01:00Z');

    INSERT INTO logs (id, tenant_id, instance_id, agent_id, message, created_at)
    VALUES
      (1, 1, 501, 101, 'one private log', '2026-06-01T01:02:00Z'),
      (2, 2, 602, 202, 'two private log', '2026-06-01T02:02:00Z'),
      (3, 1, NULL, 202, 'conflicting tenant log', '2026-06-01T03:02:00Z');

    INSERT INTO task_creation_events (id, tenant_id, task_id, project_id, sprint_id, job_id, agent_id, source, confidence, scope_size, assumptions, open_questions, needs_split)
    VALUES
      (1, 1, 1001, 11, 111, 101, 101, 'manual', 'high', 'small', '[]', '[]', 0),
      (2, 2, 2002, 22, 222, 202, 202, 'manual', 'high', 'small', '[]', '[]', 0);

    INSERT INTO task_outcome_metrics (id, tenant_id, task_id, project_id, sprint_id, job_id, agent_id, first_pass_qa, failure_reasons, outcome_quality)
    VALUES
      (1, 1, 1001, 11, 111, 101, 101, 1, '[]', 'good'),
      (2, 2, 2002, 22, 222, 202, 202, 1, '[]', 'good');

    SELECT setval(pg_get_serial_sequence('sessions', 'id'), 2, true);
    SELECT setval(pg_get_serial_sequence('logs', 'id'), 3, true);
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
    db = await setupTestDb();
    await setupDb();
  });

  afterEach(async () => {
    await teardownTestDb();
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

  it('refuses runtime log writes with conflicting parent ownership', async () => {
    await expect(insertRuntimeLog(db, {
      instanceId: 602,
      agentId: 101,
      jobTitle: 'writer-test',
      level: 'error',
      message: 'conflicting runtime log must not persist',
    })).rejects.toThrow('Conflicting runtime tenant ownership');

    const row = await db.get(`
      SELECT COUNT(*)::int AS count
      FROM logs
      WHERE message = 'conflicting runtime log must not persist'
    `) as { count: number };
    expect(row.count).toBe(0);
  });

  it('refuses an explicit tenant that conflicts with resolved runtime ownership', async () => {
    await expect(insertRuntimeLog(db, {
      tenantId: 1,
      instanceId: 602,
      agentId: 202,
      jobTitle: 'writer-test',
      level: 'error',
      message: 'explicit cross-tenant runtime log must not persist',
    })).rejects.toThrow('Conflicting runtime tenant ownership: explicit=1, resolved=2');

    const row = await db.get(`
      SELECT COUNT(*)::int AS count
      FROM logs
      WHERE message = 'explicit cross-tenant runtime log must not persist'
    `) as { count: number };
    expect(row.count).toBe(0);
  });

  it('refuses runtime log writes when tenant ownership cannot be resolved', async () => {
    await expect(insertRuntimeLog(db, {
      instanceId: 999999,
      jobTitle: 'writer-test',
      level: 'error',
      message: 'unowned runtime log must not persist',
    })).rejects.toThrow('Runtime tenant ownership could not be resolved (instanceId=999999)');

    const row = await db.get(`
      SELECT COUNT(*)::int AS count
      FROM logs
      WHERE message = 'unowned runtime log must not persist'
    `) as { count: number };
    expect(row.count).toBe(0);
  });

  // Regression guard for a defect class the type system cannot see, and which the tenant
  // isolation tests above did NOT catch.
  //
  // Each scope builder assembles `conditions` and `params` partly through an async helper
  // (pushTenantSubquery). Dropping the `await` on such a call is valid TypeScript and
  // produces no diagnostic, but the append then happens on a later microtask — after
  // `conditions.join(' OR ')` has already frozen the SQL string. That yields two distinct
  // symptoms depending on how the builder returns its params, so both are asserted:
  //
  //   1. Builders that return `params` BY REFERENCE keep growing the array the caller is
  //      already holding, so the bind count drifts past the placeholder count — PostgreSQL
  //      rejects that bind outright.
  //   2. Builders that COPY their params on return (logTenantScope) stay aligned but emit
  //      SQL missing an OR-branch, silently narrowing or widening tenant scope instead.
  //
  // Verified by deleting the awaits and re-running: only instanceTenantScope failed. The
  // other three await a tableExists() query after their pushTenantSubquery calls, and that
  // round trip is long enough for the pending appends to land, so they were correct purely by
  // accident. These assertions therefore pin down intent as much as behaviour — they are what
  // makes a future reordering of those awaits fail loudly instead of quietly unscoping a
  // tenant query.
  describe('scope builders emit SQL and params that agree', () => {
    const builders = [
      { name: 'sessionTenantScope', build: sessionTenantScope, alias: 's', branches: ['task_id', 'agent_id', 'project_id'] },
      { name: 'chatMessageTenantScope', build: chatMessageTenantScope, alias: 'c', branches: ['agent_id'] },
      { name: 'instanceTenantScope', build: instanceTenantScope, alias: 'ji', branches: ['task_id', 'agent_id'] },
      { name: 'logTenantScope', build: logTenantScope, alias: 'l', branches: ['agent_id'] },
    ];

    for (const { name, build, alias, branches } of builders) {
      it(`${name} binds exactly one param per placeholder`, async () => {
        const { sql, params } = await build(db, alias, 1);
        // Draining the microtask queue is what gives this assertion teeth: comparing the
        // counts on return would pass even with the await missing, because the extra
        // appends have not run yet.
        await new Promise((resolve) => setImmediate(resolve));
        expect(sql.match(/\?/g)?.length ?? 0).toBe(params.length);
      });

      it(`${name} includes every relationship branch it can resolve`, async () => {
        // The fixture gives every referenced table a tenant_id column, so no branch is
        // legitimately skippable here — anything missing was dropped, not filtered out.
        const { sql } = await build(db, alias, 1);
        for (const column of branches) {
          expect(sql).toContain(`${alias}.${column} IN (SELECT id FROM`);
        }
      });
    }
  });
});
