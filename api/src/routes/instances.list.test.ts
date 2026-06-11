import Database from 'better-sqlite3';
import express from 'express';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

let db: Database.Database;

jest.mock('../db/client', () => ({
  getDb: () => db,
}));

import instancesRouter from './instances';

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
      job_title TEXT,
      session_key TEXT
    );

    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      title TEXT,
      status TEXT,
      project_id INTEGER
    );

    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      task_id INTEGER,
      agent_id INTEGER,
      session_key TEXT,
      status TEXT,
      created_at TEXT,
      task_outcome TEXT,
      runtime_ended_at TEXT,
      runtime_completed_at TEXT,
      runtime_end_success INTEGER,
      runtime_end_error TEXT,
      runtime_end_source TEXT,
      lifecycle_handoff_status TEXT,
      semantic_outcome_missing INTEGER,
      lifecycle_outcome_posted_at TEXT
    );

    CREATE TABLE instance_artifacts (
      instance_id INTEGER PRIMARY KEY,
      current_stage TEXT,
      last_agent_heartbeat_at TEXT,
      last_meaningful_output_at TEXT,
      latest_commit_hash TEXT,
      branch_name TEXT,
      changed_files_json TEXT,
      changed_files_count INTEGER,
      summary TEXT,
      blocker_reason TEXT,
      outcome TEXT,
      stale INTEGER,
      stale_at TEXT
    );
  `);
}

describe('GET /api/v1/instances', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    setupDb();
    db.prepare(`INSERT INTO agents (id, name, job_title, session_key) VALUES (1, 'Cinder', 'Backend', 'agent:cinder:main')`).run();
    db.prepare(`INSERT INTO agents (id, name, job_title, session_key) VALUES (2, 'Atlas', 'Assistant', 'agent:atlas:main')`).run();
    db.prepare(`INSERT INTO tasks (id, title, status, project_id) VALUES (10, 'Backend one', 'ready', 7)`).run();
    db.prepare(`INSERT INTO tasks (id, title, status, project_id) VALUES (11, 'Backend two', 'ready', 7)`).run();
    db.prepare(`INSERT INTO tasks (id, title, status, project_id) VALUES (12, 'Mobile', 'ready', 8)`).run();
    db.prepare(`
      INSERT INTO job_instances (id, task_id, agent_id, session_key, status, created_at)
      VALUES
        (101, 10, 1, 'run:101', 'done', '2026-06-01T10:00:00Z'),
        (102, 11, 1, 'run:102', 'running', '2026-06-01T11:00:00Z'),
        (103, 12, 2, 'run:103', 'done', '2026-06-01T12:00:00Z')
    `).run();
  });

  afterEach(() => {
    db.close();
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
