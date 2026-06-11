import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { closeDb, getDb } from '../db/client';
import {
  authenticateMcpApiKeyIfPresent,
  authorizeMcpApiRequestIfPresent,
  ensureMcpApiKeyTable,
  issueMcpApiKeyForAgent,
} from '../lib/mcpApiAuth';
import tasksRouter from './tasks';

const ORIGINAL_DB_PATH = process.env.AGENT_HQ_DB_PATH;

function restoreDbPath(): void {
  if (ORIGINAL_DB_PATH == null) delete process.env.AGENT_HQ_DB_PATH;
  else process.env.AGENT_HQ_DB_PATH = ORIGINAL_DB_PATH;
}

describe('task active-owner endpoint', () => {
  let tempDir = '';
  let server: Server | null = null;
  let baseUrl = '';
  let cinderKey = '';
  let prismKey = '';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-active-owner-'));
    process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq.db');
    closeDb();

    const db = getDb();
    db.exec(`
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        system_role TEXT,
        deleted_at TEXT
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        title TEXT,
        status TEXT,
        project_id INTEGER,
        sprint_id INTEGER,
        agent_id INTEGER,
        active_instance_id INTEGER
      );
      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        agent_id INTEGER,
        status TEXT
      );
      CREATE TABLE task_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        author TEXT,
        content TEXT
      );
    `);
    ensureMcpApiKeyTable(db);

    db.prepare(`
      INSERT INTO agents (id, name, slug, enabled, system_role)
      VALUES
        (94, 'Cinder', 'cinder-backend', 1, NULL),
        (95, 'Prism', 'prism-qa', 1, NULL)
    `).run();
    db.prepare(`
      INSERT INTO tasks (id, title, status, project_id, sprint_id, agent_id, active_instance_id)
      VALUES
        (398, 'Wrong task', 'review', 86, 57, 94, NULL),
        (551, 'Routing rule fix', 'in_progress', 86, 57, 94, 7001),
        (552, 'Other agent task', 'in_progress', 86, 57, 95, 7002),
        (553, 'Finished run task', 'review', 86, 57, 94, 7003)
    `).run();
    db.prepare(`
      INSERT INTO job_instances (id, task_id, agent_id, status)
      VALUES
        (7001, 551, 94, 'running'),
        (7002, 552, 95, 'running'),
        (7003, 553, 94, 'done')
    `).run();

    cinderKey = issueMcpApiKeyForAgent(db, 94, 'cinder test key').apiKey;
    prismKey = issueMcpApiKeyForAgent(db, 95, 'prism test key').apiKey;

    const app = express();
    app.use(express.json());
    app.use('/api/v1', authenticateMcpApiKeyIfPresent);
    app.use('/api/v1', authorizeMcpApiRequestIfPresent);
    app.use('/api/v1/tasks', tasksRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close((err) => err ? reject(err) : resolve());
    });
    server = null;
    closeDb();
    restoreDbPath();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function apiKeyHeaders(apiKey: string): Record<string, string> {
    return { 'x-api-key': apiKey };
  }

  it('requires an authenticated MCP API key', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tasks/551/active-owner`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: 'mcp_api_key_missing',
    });
  });

  it('reports true when the authenticated agent owns the active task instance', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tasks/551/active-owner`, {
      headers: apiKeyHeaders(cinderKey),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      task_id: 551,
      authenticated_agent_id: 94,
      active_instance_id: 7001,
      active_instance_agent_id: 94,
      active_instance_status: 'running',
      is_active_owner: true,
      reason: 'active_instance_owned_by_authenticated_agent',
    });
  });

  it('reports false when the task has no active instance', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tasks/398/active-owner`, {
      headers: apiKeyHeaders(cinderKey),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      task_id: 398,
      authenticated_agent_id: 94,
      active_instance_id: null,
      is_active_owner: false,
      reason: 'task_has_no_active_instance',
    });
  });

  it('reports false when another agent owns the active instance', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tasks/552/active-owner`, {
      headers: apiKeyHeaders(cinderKey),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      task_id: 552,
      authenticated_agent_id: 94,
      active_instance_agent_id: 95,
      is_active_owner: false,
      reason: 'active_instance_agent_mismatch',
    });
  });

  it('reports false when the active instance reference is terminal', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tasks/553/active-owner`, {
      headers: apiKeyHeaders(cinderKey),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      task_id: 553,
      active_instance_status: 'done',
      is_active_owner: false,
      reason: 'active_instance_not_active',
    });
  });

  it('still lets a different agent check ownership without passing scoped task auth', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tasks/551/active-owner`, {
      headers: apiKeyHeaders(prismKey),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      task_id: 551,
      authenticated_agent_id: 95,
      active_instance_agent_id: 94,
      is_active_owner: false,
      reason: 'active_instance_agent_mismatch',
    });
  });
});
