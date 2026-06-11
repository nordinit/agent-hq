import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import agentsRouter from './agents';

let tempDir: string;
let dbPath: string;

function resetDb(): void {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-delete-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');
  process.env.AGENT_HQ_DB_PATH = dbPath;

  const db = getDb();
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      session_key TEXT NOT NULL UNIQUE,
      workspace_path TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'idle',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      openclaw_agent_id TEXT,
      runtime_type TEXT NOT NULL DEFAULT 'openclaw',
      runtime_config TEXT,
      project_id INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      schedule TEXT NOT NULL DEFAULT '',
      skill_names TEXT NOT NULL DEFAULT '[]',
      sort_rules TEXT NOT NULL DEFAULT '[]',
      repo_path TEXT,
      repo_url TEXT,
      repo_access_mode TEXT,
      deleted_at TEXT
    );

    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      review_owner_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL
    );

    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'done'
    );

    CREATE TABLE dispatch_log (
      id INTEGER PRIMARY KEY,
      task_id INTEGER,
      agent_id INTEGER REFERENCES agents(id)
    );

    CREATE TABLE sprint_task_routing_rules (
      id INTEGER PRIMARY KEY,
      sprint_id INTEGER,
      task_type TEXT,
      status TEXT,
      agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL
    );

    CREATE TABLE agent_tool_assignments (
      id INTEGER PRIMARY KEY,
      agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      tool_id INTEGER NOT NULL
    );

    CREATE TABLE agent_mcp_assignments (
      id INTEGER PRIMARY KEY,
      agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      mcp_server_id INTEGER NOT NULL
    );
  `);
}

async function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/agents', agentsRouter);
  const server = await new Promise<Server>((resolve, reject) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
    bound.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('agents delete', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-delete-'));
    dbPath = path.join(tempDir, 'agent-hq-test.db');
    resetDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.AGENT_HQ_DB_PATH;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('archives referenced agents instead of throwing a raw foreign-key error', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO agents (id, name, session_key, status, enabled)
      VALUES (98, 'Repo Mode Smoke Agent', 'agent:repo-mode-smoke:main', 'idle', 0)
    `).run();
    db.prepare(`INSERT INTO tasks (id, title, agent_id) VALUES (394, 'Live clone mode smoke', 98)`).run();
    db.prepare(`INSERT INTO job_instances (id, task_id, agent_id, status) VALUES (1849, 394, 98, 'done')`).run();
    db.prepare(`INSERT INTO dispatch_log (id, task_id, agent_id) VALUES (1, 394, 98)`).run();
    db.prepare(`INSERT INTO sprint_task_routing_rules (id, sprint_id, task_type, status, agent_id) VALUES (1, 1, 'backend', 'ready', 98)`).run();

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents/98`, { method: 'DELETE' });
      const body = await response.json() as {
        ok?: boolean;
        archived?: boolean;
        hard_deleted?: boolean;
        error?: string;
        dependency_counts?: Array<{ table: string; count: number }>;
      };

      if (response.status !== 200) {
        throw new Error(`Expected 200, received ${response.status}: ${JSON.stringify(body)}`);
      }
      expect(body.ok).toBe(true);
      expect(body.archived).toBe(true);
      expect(body.hard_deleted).toBe(false);
      expect(body.error).toBeUndefined();
      expect(body.dependency_counts?.some((entry) => entry.table === 'job_instances' && entry.count === 1)).toBe(true);

      const agent = db.prepare(`SELECT id, enabled, deleted_at, session_key FROM agents WHERE id = 98`).get() as {
        id: number;
        enabled: number;
        deleted_at: string | null;
        session_key: string;
      };
      expect(agent.id).toBe(98);
      expect(agent.enabled).toBe(0);
      expect(agent.deleted_at).toBeTruthy();
      expect(agent.session_key).toMatch(/^deleted:98:/);

      const task = db.prepare(`SELECT agent_id FROM tasks WHERE id = 394`).get() as { agent_id: number };
      const instance = db.prepare(`SELECT agent_id FROM job_instances WHERE id = 1849`).get() as { agent_id: number };
      const routing = db.prepare(`SELECT COUNT(*) AS n FROM sprint_task_routing_rules WHERE agent_id = 98`).get() as { n: number };
      expect(task.agent_id).toBe(98);
      expect(instance.agent_id).toBe(98);
      expect(routing.n).toBe(0);

      const listResponse = await fetch(`${baseUrl}/api/v1/agents`);
      const listBody = await listResponse.json() as Array<{ id: number }>;
      expect(listBody.some((entry) => entry.id === 98)).toBe(false);
    } finally {
      await stopTestServer(server);
    }
  });

  it('hard-deletes agents with no historical references', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO agents (id, name, session_key, status, enabled)
      VALUES (99, 'Disposable Agent', 'agent:disposable:main', 'idle', 1)
    `).run();

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents/99`, { method: 'DELETE' });
      const body = await response.json() as { ok?: boolean; archived?: boolean; hard_deleted?: boolean; error?: string };

      if (response.status !== 200) {
        throw new Error(`Expected 200, received ${response.status}: ${JSON.stringify(body)}`);
      }
      expect(body.ok).toBe(true);
      expect(body.archived).toBe(false);
      expect(body.hard_deleted).toBe(true);
      expect(body.error).toBeUndefined();

      const row = db.prepare(`SELECT id FROM agents WHERE id = 99`).get();
      expect(row).toBeUndefined();
    } finally {
      await stopTestServer(server);
    }
  });
});
