import express from 'express';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

let db: Db;

import instancesRouter from './instances';
import { type Db } from "../db/adapter/types";
import { setupTestDb, teardownTestDb } from '../db/testDb';

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

describe('GET /api/v1/instances', () => {
  beforeEach(async () => {
    db = await setupTestDb();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Test', 'test', 1)`);
    await db.run(`
      INSERT INTO app_settings (key, value)
      VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')
    `);
    await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (7, 1, 'Seven'), (8, 1, 'Eight')`);
    await db.run(`
      INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type)
      VALUES (70, 1, 7, 'Seven workflow', 'generic'), (80, 1, 8, 'Eight workflow', 'generic')
    `);
    await db.run(`INSERT INTO agents (id, tenant_id, name, job_title, session_key) VALUES (1, 1, 'Cinder', 'Backend', 'agent:cinder:main')`);
    await db.run(`INSERT INTO agents (id, tenant_id, name, job_title, session_key) VALUES (2, 1, 'Atlas', 'Assistant', 'agent:atlas:main')`);
    await db.run(`INSERT INTO tasks (id, tenant_id, title, status, project_id, sprint_id) VALUES (10, 1, 'Backend one', 'ready', 7, 70)`);
    await db.run(`INSERT INTO tasks (id, tenant_id, title, status, project_id, sprint_id) VALUES (11, 1, 'Backend two', 'ready', 7, 70)`);
    await db.run(`INSERT INTO tasks (id, tenant_id, title, status, project_id, sprint_id) VALUES (12, 1, 'Mobile', 'ready', 8, 80)`);
    await db.run(`
      INSERT INTO job_instances (id, task_id, agent_id, session_key, status, created_at)
      VALUES
        (101, 10, 1, 'run:101', 'done', '2026-06-01T10:00:00Z'),
        (102, 11, 1, 'run:102', 'running', '2026-06-01T11:00:00Z'),
        (103, 12, 2, 'run:103', 'done', '2026-06-01T12:00:00Z')
    `);
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('filters server-side by agent_id and project_id', async () => {
    const app = express();
    app.use('/api/v1/instances', instancesRouter);

    const res = await getJson(app, '/api/v1/instances?agent_id=1&project_id=7');

    expect(res.status).toBe(200);
    expect(res.body.map((row: { id: number }) => row.id)).toEqual([102, 101]);
    expect(res.body.every((row: { agent_id: number; project_id: number }) => row.agent_id === 1 && row.project_id === 7)).toBe(true);
  });

  it('keeps unfiltered all-project results bounded and paginated', async () => {
    const app = express();
    app.use('/api/v1/instances', instancesRouter);

    const res = await getJson(app, '/api/v1/instances?limit=1&offset=1');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: 102 });
  });
});
