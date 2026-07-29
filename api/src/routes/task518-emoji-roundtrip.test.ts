import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import sprintsRouter from './sprints';

let tempDir: string;
let dbPath: string;
const originalContractRoot = process.env.AGENT_CONTRACT_ROOT;
const originalDbPath = process.env.AGENT_HQ_DB_PATH;

async function resetDb(): Promise<void> {
  closeDb();
  jest.resetModules();
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task518-emoji-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');
  process.env.AGENT_HQ_DB_PATH = dbPath;
  process.env.AGENT_CONTRACT_ROOT = path.join(tempDir, 'agent-contracts');
  fs.mkdirSync(process.env.AGENT_CONTRACT_ROOT, { recursive: true });
  fs.writeFileSync(path.join(process.env.AGENT_CONTRACT_ROOT, 'generic.md'), 'Sprint type: {{sprintType}}\n');

  const db = getDb();
  await db.exec(`
    CREATE TABLE sprint_types (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      is_system INTEGER NOT NULL DEFAULT 0,
      status_seeded_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sprints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sprint_type TEXT NOT NULL DEFAULT 'generic',
      status TEXT NOT NULL DEFAULT 'planning'
    );
    CREATE TABLE task_statuses (
      name TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'slate',
      terminal INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      allowed_transitions TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE sprint_task_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
      status_key TEXT NOT NULL,
      label TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'slate',
      terminal INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      allowed_transitions_json TEXT NOT NULL DEFAULT '[]',
      stage_order INTEGER NOT NULL DEFAULT 0,
      is_default_entry INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sprint_type_task_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key TEXT NOT NULL,
      status_key TEXT NOT NULL,
      label TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'slate',
      terminal INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      allowed_transitions_json TEXT NOT NULL DEFAULT '[]',
      stage_order INTEGER NOT NULL DEFAULT 0,
      is_default_entry INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(sprint_type_key, status_key)
    );
    CREATE TABLE sprint_task_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
      task_type TEXT,
      from_status TEXT NOT NULL,
      outcome TEXT NOT NULL,
      to_status TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      is_protected INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_field_schemas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key TEXT NOT NULL,
      task_type TEXT,
      schema_json TEXT NOT NULL DEFAULT '{}',
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sprint_type_task_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key TEXT NOT NULL,
      task_type TEXT NOT NULL,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sprint_type_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key TEXT NOT NULL,
      task_type TEXT,
      outcome_key TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      behavior TEXT NOT NULL DEFAULT 'advance',
      badge_variant TEXT NOT NULL DEFAULT 'default',
      stage_order INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sprint_task_transition_requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
      task_type TEXT,
      outcome TEXT NOT NULL,
      field_name TEXT NOT NULL,
      requirement_type TEXT NOT NULL DEFAULT 'required',
      match_field TEXT,
      severity TEXT NOT NULL DEFAULT 'block',
      message TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sprint_task_routing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL,
      agent_id INTEGER,
      priority INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE story_point_model_routing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      sprint_id INTEGER,
      max_points INTEGER NOT NULL,
      provider TEXT,
      model TEXT NOT NULL,
      fallback_model TEXT,
      max_turns INTEGER,
      max_budget_usd REAL,
      thinking_level TEXT,
      label TEXT,
      updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE project_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, changes TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT NOT NULL, project_id INTEGER, enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, sprint_id INTEGER, status TEXT, story_points INTEGER);
  `);

  await db.run(`INSERT INTO projects (id, name) VALUES (1, 'Agent HQ')`);
  await db.run(`INSERT INTO sprint_types (key, name, is_system) VALUES ('enhancements', 'Enhancements', 1)`);
  await db.run(`INSERT INTO sprints (id, project_id, name, sprint_type, status) VALUES (10, 1, 'Enhancements', 'enhancements', 'active')`);
  await db.run(`INSERT INTO task_statuses (name, label, color, terminal, is_system, allowed_transitions) VALUES ('review', 'Review', 'purple', 0, 1, '[]')`);
  await db.run(`INSERT INTO sprint_type_task_statuses (sprint_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json) VALUES ('enhancements', 'review', 'Review', 'purple', 0, 1, '[]', 0, 1, '{}')`);
  await db.run(`INSERT INTO sprint_task_statuses (sprint_id, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json) VALUES (10, 'review', 'Review', 'purple', 0, 1, '[]', 0, 1, '{}')`);
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task518-emoji-bootstrap-'));
  await resetDb();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  if (originalDbPath === undefined) delete process.env.AGENT_HQ_DB_PATH;
  else process.env.AGENT_HQ_DB_PATH = originalDbPath;
  if (originalContractRoot === undefined) delete process.env.AGENT_CONTRACT_ROOT;
  else process.env.AGENT_CONTRACT_ROOT = originalContractRoot;
});

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/sprints', sprintsRouter);
  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

test('sprint type status emoji persists and round-trips on repeated reload fetches', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const updateResponse = await fetch(`${baseUrl}/api/v1/sprints/types/enhancements/statuses/review`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: '🚦' }),
    });
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toEqual(expect.objectContaining({
      name: 'review',
      emoji: '🚦',
      metadata: expect.objectContaining({ emoji: '🚦' }),
    }));

    for (let i = 0; i < 3; i += 1) {
      const listResponse = await fetch(`${baseUrl}/api/v1/sprints/types/enhancements/statuses`);
      expect(listResponse.status).toBe(200);
      const listBody = await listResponse.json() as { statuses: Array<{ name: string; emoji?: string | null; metadata?: Record<string, unknown> }> };
      expect(listBody.statuses.find((status) => status.name === 'review')).toEqual(expect.objectContaining({
        name: 'review',
        emoji: '🚦',
        metadata: expect.objectContaining({ emoji: '🚦' }),
      }));
    }

    const db = getDb();
    const sprintTypeRow = await db.get(`SELECT metadata_json FROM sprint_type_task_statuses WHERE sprint_type_key = ? AND status_key = ?`, 'enhancements', 'review') as { metadata_json: string } | undefined;
    const sprintRow = await db.get(`SELECT metadata_json FROM sprint_task_statuses WHERE sprint_id = ? AND status_key = ?`, 10, 'review') as { metadata_json: string } | undefined;
    expect(JSON.parse(sprintTypeRow?.metadata_json ?? '{}')).toEqual(expect.objectContaining({ emoji: '🚦' }));
    expect(JSON.parse(sprintRow?.metadata_json ?? '{}')).toEqual(expect.objectContaining({ emoji: '🚦' }));

    const workflowResponse = await fetch(`${baseUrl}/api/v1/sprints/workflow-metadata?sprint_type=enhancements`);
    expect(workflowResponse.status).toBe(200);
    const workflowBody = await workflowResponse.json() as { statuses: Array<{ name: string; emoji?: string | null; metadata?: Record<string, unknown> }> };
    expect(workflowBody.statuses.find((status) => status.name === 'review')).toEqual(expect.objectContaining({
      name: 'review',
      emoji: '🚦',
      metadata: expect.objectContaining({ emoji: '🚦' }),
    }));
  } finally {
    await stopServer(server);
  }
});

test('seedSprintTaskPolicy preserves sprint-type metadata when cloning statuses into a sprint', async () => {
  const db = getDb();
  await db.run(`UPDATE sprint_type_task_statuses SET metadata_json = ? WHERE sprint_type_key = ? AND status_key = ?`, '{"source":"legacy-seed"}', 'enhancements', 'review');
  await db.run(`DELETE FROM sprint_task_statuses WHERE sprint_id = ? AND status_key = ?`, 10, 'review');

  const { seedSprintTaskPolicy } = require('../domains/routing/policy');
  seedSprintTaskPolicy(db, 10, { force: true });

  const sprintSeedRow = await db.get(`SELECT metadata_json FROM sprint_task_statuses WHERE sprint_id = ? AND status_key = ?`, 10, 'review') as { metadata_json: string } | undefined;
  expect(JSON.parse(sprintSeedRow?.metadata_json ?? '{}')).toEqual(expect.objectContaining({ source: 'legacy-seed' }));
});
