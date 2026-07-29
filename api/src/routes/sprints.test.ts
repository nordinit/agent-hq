import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import { normalizeWorkflowRequestAliases, workflowAliasResponseMiddleware } from '../lib/workflowCompatibility';
import sprintsRouter from './sprints';

let tempDir: string;
let dbPath: string;
const originalContractRoot = process.env.AGENT_CONTRACT_ROOT;
const originalDbPath = process.env.AGENT_HQ_DB_PATH;

async function resetDb(): Promise<void> {
  closeDb();
  jest.resetModules();
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprints-route-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');
  process.env.AGENT_HQ_DB_PATH = dbPath;
  process.env.AGENT_CONTRACT_ROOT = path.join(tempDir, 'agent-contracts');
  fs.mkdirSync(process.env.AGENT_CONTRACT_ROOT, { recursive: true });
  fs.writeFileSync(path.join(process.env.AGENT_CONTRACT_ROOT, 'generic.md'), 'Sprint type: {{sprintType}}\n');

  const db = getDb();
  await db.exec(`
    CREATE TABLE tenants (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER,
      name TEXT NOT NULL
    );
    CREATE TABLE project_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      changes TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sprints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      goal TEXT NOT NULL DEFAULT '',
      sprint_type TEXT NOT NULL DEFAULT 'generic',
      status TEXT NOT NULL DEFAULT 'planning',
      length_kind TEXT NOT NULL DEFAULT 'time',
      length_value TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      ended_at TEXT,
      repo_path TEXT,
      repo_url TEXT,
      repo_access_mode TEXT,
      task_policy_seeded_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sprint_types (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      is_system INTEGER NOT NULL DEFAULT 0,
      status_seeded_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      tenant_id INTEGER,
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
    CREATE TABLE sprint_type_task_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key TEXT NOT NULL,
      task_type TEXT NOT NULL,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(sprint_type_key, task_type)
    );
    CREATE TABLE sprint_task_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      project_id INTEGER,
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
    CREATE TABLE sprint_task_transition_requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      project_id INTEGER,
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
      tenant_id INTEGER,
      project_id INTEGER,
      sprint_id INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL,
      agent_id INTEGER,
      priority INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE external_event_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      source TEXT,
      event_name TEXT NOT NULL,
      task_type TEXT,
      status_includes_json TEXT NOT NULL DEFAULT '[]',
      status_excludes_json TEXT NOT NULL DEFAULT '[]',
      action_kind TEXT NOT NULL DEFAULT 'ignore',
      action_target TEXT,
      apply_review_evidence INTEGER NOT NULL DEFAULT 0,
      apply_failure_detail INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE story_point_model_routing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
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
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER,
      name TEXT NOT NULL,
      role TEXT,
      job_title TEXT,
      system_role TEXT,
      session_key TEXT,
      openclaw_agent_id TEXT,
      model TEXT,
      project_id INTEGER,
      sprint_id INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER,
      status TEXT,
      story_points INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      blocker_id INTEGER NOT NULL,
      blocked_id INTEGER NOT NULL
    );
    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      agent_id INTEGER,
      status TEXT
    );
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      instance_id INTEGER,
      agent_id INTEGER,
      job_title TEXT,
      level TEXT,
      message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await db.run(`
    INSERT INTO task_statuses (name, label, color, terminal, is_system, allowed_transitions)
    VALUES
      ('todo', 'To Do', 'slate', 0, 1, '["ready"]'),
      ('ready', 'Ready', 'blue', 0, 1, '["in_progress","review"]'),
      ('in_progress', 'In Progress', 'yellow', 0, 1, '["review"]'),
      ('review', 'Review', 'purple', 0, 1, '["done"]'),
      ('done', 'Done', 'green', 1, 1, '[]')
  `);
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Company', 'default', 1), (2, 'Tenant Two', 'tenant-two', 0)`);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '2')`);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 2, 'Agent HQ'), (2, 2, 'Other Project')`);
  await db.run(`INSERT INTO sprint_types (key, name, is_system) VALUES ('generic', 'Generic', 1), ('enhancements', 'Enhancements', 1)`);
  await db.run(`INSERT INTO agents (id, tenant_id, name, role, job_title, system_role, session_key, openclaw_agent_id, model, project_id, sprint_id, enabled) VALUES (7, 2, 'Cinder', 'backend engineer', 'Backend', NULL, NULL, NULL, NULL, 1, NULL, 1)`);
  await db.run(`
    INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value, started_at)
    VALUES
      (10, 2, 1, 'Enhancements Source', 'Source goal', 'enhancements', 'active', 'time', '2w', '2026-05-01T00:00:00Z'),
      (20, 2, 2, 'Other Project Source', 'Other goal', 'generic', 'planning', 'time', '1w', NULL)
  `);

  await db.run(`
    INSERT INTO sprint_task_statuses (tenant_id, sprint_id, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json)
    VALUES (99, 10, 'review_ready', 'Review Ready', 'cyan', 0, 0, '["review"]', 0, 1, '{"source":true}')
  `);
  await db.run(`
    INSERT INTO sprint_type_task_statuses (sprint_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json)
    VALUES ('enhancements', 'review_ready', 'Review Ready', 'cyan', 0, 0, '["review"]', 0, 1, '{"emoji":"🧪"}')
  `);
  await db.run(`
    INSERT INTO sprint_task_transitions (tenant_id, project_id, sprint_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected)
    VALUES (99, 91, 10, 'backend', 'in_progress', 'completed_for_review', 'review', 1, 9, 0)
  `);
  await db.run(`
    INSERT INTO sprint_task_transition_requirements (tenant_id, project_id, sprint_id, task_type, outcome, field_name, requirement_type, severity, message, enabled, priority)
    VALUES (99, 91, 10, 'backend', 'completed_for_review', 'review_commit', 'required', 'block', 'Need review commit', 1, 12)
  `);
  await db.run(`
    INSERT INTO sprint_task_routing_rules (tenant_id, project_id, sprint_id, task_type, status, agent_id, priority, is_system)
    VALUES (99, 91, 10, 'backend', 'ready', 7, 50, 0)
  `);
  await db.run(`
    INSERT INTO story_point_model_routing (tenant_id, project_id, sprint_id, max_points, provider, model, fallback_model, max_turns, max_budget_usd, thinking_level, label, updated_at)
    VALUES (99, 91, 10, 5, 'openai-codex', 'openai/gpt-5.5', NULL, 12, 1.5, 'high', 'enhancement clone source', datetime('now'))
  `);
}

async function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', normalizeWorkflowRequestAliases);
  app.use('/api/v1/sprints', sprintsRouter);
  app.use('/api/v1/workflows', workflowAliasResponseMiddleware, sprintsRouter);

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function stopTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('sprints API create clone support', () => {
  beforeEach(async () => {
    tempDir = '';
    dbPath = '';
    await resetDb();
  });

  afterEach(() => {
    closeDb();
    if (originalDbPath == null) delete process.env.AGENT_HQ_DB_PATH;
    else process.env.AGENT_HQ_DB_PATH = originalDbPath;
    if (originalContractRoot == null) delete process.env.AGENT_CONTRACT_ROOT;
    else process.env.AGENT_CONTRACT_ROOT = originalContractRoot;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates a sprint and clones sprint-scoped workflow, routing, and model routing setup from a source sprint', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/sprints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-actor': 'test-suite' },
        body: JSON.stringify({
          project_id: 1,
          name: 'Enhancements Clone',
          goal: 'Cloned goal',
          source_sprint_id: 10,
          status: 'planning',
          length_kind: 'time',
          length_value: '2w',
        }),
      });
      const body = await response.json() as { id: number; sprint_type: string; project_id: number; error?: string };
      if (response.status !== 201) console.log('debug create clone body', body);

      expect(response.status).toBe(201);
      expect(body.sprint_type).toBe('enhancements');
      expect(body.project_id).toBe(1);

      const db = getDb();
      const createdSprint = await db.get(`SELECT * FROM sprints WHERE id = ?`, body.id) as { tenant_id: number; project_id: number; sprint_type: string; name: string };
      expect(createdSprint).toEqual(expect.objectContaining({ tenant_id: 2, project_id: 1, sprint_type: 'enhancements', name: 'Enhancements Clone' }));

      const clonedStatus = await db.get(`SELECT status_key, label, metadata_json FROM sprint_task_statuses WHERE sprint_id = ?`, body.id) as { status_key: string; label: string; metadata_json: string };
      expect(clonedStatus).toEqual(expect.objectContaining({ status_key: 'review_ready', label: 'Review Ready', metadata_json: '{"source":true}' }));
      expect((await db.get(`SELECT COUNT(*) AS n FROM sprint_task_statuses WHERE sprint_id = ?`, body.id) as { n: number }).n).toBe(1);

      const clonedTransition = await db.get(`SELECT tenant_id, project_id, task_type, from_status, outcome, to_status, priority FROM sprint_task_transitions WHERE sprint_id = ?`, body.id) as { tenant_id: number; project_id: number; task_type: string; from_status: string; outcome: string; to_status: string; priority: number };
      expect(clonedTransition).toEqual(expect.objectContaining({ tenant_id: 2, project_id: 1, task_type: 'backend', from_status: 'in_progress', outcome: 'completed_for_review', to_status: 'review', priority: 9 }));
      expect((await db.get(`SELECT COUNT(*) AS n FROM sprint_task_transitions WHERE sprint_id = ?`, body.id) as { n: number }).n).toBe(1);

      const clonedRequirement = await db.get(`SELECT tenant_id, project_id, task_type, outcome, field_name, priority FROM sprint_task_transition_requirements WHERE sprint_id = ?`, body.id) as { tenant_id: number; project_id: number; task_type: string; outcome: string; field_name: string; priority: number };
      expect(clonedRequirement).toEqual(expect.objectContaining({ tenant_id: 2, project_id: 1, task_type: 'backend', outcome: 'completed_for_review', field_name: 'review_commit', priority: 12 }));
      expect((await db.get(`SELECT COUNT(*) AS n FROM sprint_task_transition_requirements WHERE sprint_id = ?`, body.id) as { n: number }).n).toBe(1);

      const clonedRoutingRule = await db.get(`SELECT tenant_id, project_id, task_type, status, agent_id, priority FROM sprint_task_routing_rules WHERE sprint_id = ?`, body.id) as { tenant_id: number; project_id: number; task_type: string; status: string; agent_id: number; priority: number };
      expect(clonedRoutingRule).toEqual(expect.objectContaining({ tenant_id: 2, project_id: 1, task_type: 'backend', status: 'ready', agent_id: 7, priority: 50 }));

      const clonedModelRule = await db.get(`SELECT tenant_id, project_id, sprint_id, max_points, provider, model, label FROM story_point_model_routing WHERE sprint_id = ?`, body.id) as { tenant_id: number; project_id: number; sprint_id: number; max_points: number; provider: string; model: string; label: string };
      expect(clonedModelRule).toEqual(expect.objectContaining({ tenant_id: 2, project_id: 1, sprint_id: body.id, max_points: 5, provider: 'openai-codex', model: 'openai/gpt-5.5', label: 'enhancement clone source' }));

      const audit = await db.get(`SELECT actor, changes FROM project_audit_log WHERE entity_type = 'sprint' AND entity_id = ?`, body.id) as { actor: string; changes: string };
      expect(audit.actor).toBe('test-suite');
      expect(JSON.parse(audit.changes)).toEqual(expect.objectContaining({ source_sprint_id: 10, cloned_setup: true, sprint_type: 'enhancements' }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('creates and updates workflow-owned repository config', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const createResponse = await fetch(`${baseUrl}/api/v1/sprints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-actor': 'test-suite' },
        body: JSON.stringify({
          project_id: 1,
          name: 'Repo Workflow',
          sprint_type: 'generic',
          repo_access_mode: 'worktree',
          repo_path: '  /repos/workflow-a  ',
        }),
      });
      const created = await createResponse.json() as { id: number; repo_path: string | null; repo_url: string | null; repo_access_mode: string | null; error?: string };
      expect(createResponse.status).toBe(201);
      expect(created).toEqual(expect.objectContaining({
        repo_path: '/repos/workflow-a',
        repo_url: null,
        repo_access_mode: 'worktree',
      }));

      const updateResponse = await fetch(`${baseUrl}/api/v1/sprints/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-actor': 'test-suite' },
        body: JSON.stringify({
          repo_access_mode: 'clone',
          repo_url: 'git@github.com:owner/workflow-b.git',
        }),
      });
      const updated = await updateResponse.json() as { repo_path: string | null; repo_url: string | null; repo_access_mode: string | null };
      expect(updateResponse.status).toBe(200);
      expect(updated).toEqual(expect.objectContaining({
        repo_path: null,
        repo_url: 'git@github.com:owner/workflow-b.git',
        repo_access_mode: 'clone',
      }));

      const invalidResponse = await fetch(`${baseUrl}/api/v1/sprints/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-actor': 'test-suite' },
        body: JSON.stringify({ repo_access_mode: 'worktree', repo_path: '' }),
      });
      const invalid = await invalidResponse.json() as { error: string };
      expect(invalidResponse.status).toBe(400);
      expect(invalid.error).toContain('repo_access_mode=worktree requires repo_path');
    } finally {
      await stopTestServer(server);
    }
  });

  it('does not create workflow-scoped task policy overrides when no source_sprint_id is provided', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/sprints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: 1,
          name: 'Generic Sprint',
          sprint_type: 'generic',
          status: 'planning',
          length_kind: 'time',
          length_value: '1w',
        }),
      });
      const body = await response.json() as { id: number; sprint_type: string };

      expect(response.status).toBe(201);
      expect(body.sprint_type).toBe('generic');

      const db = getDb();
      const statusCount = (await db.get(`SELECT COUNT(*) AS n FROM sprint_task_statuses WHERE sprint_id = ?`, body.id) as { n: number }).n;
      const transitionCount = (await db.get(`SELECT COUNT(*) AS n FROM sprint_task_transitions WHERE sprint_id = ?`, body.id) as { n: number }).n;
      const requirementCount = (await db.get(`SELECT COUNT(*) AS n FROM sprint_task_transition_requirements WHERE sprint_id = ?`, body.id) as { n: number }).n;
      const modelRuleCount = (await db.get(`SELECT COUNT(*) AS n FROM story_point_model_routing WHERE sprint_id = ?`, body.id) as { n: number }).n;
      expect(statusCount).toBe(0);
      expect(transitionCount).toBe(0);
      expect(requirementCount).toBe(0);
      expect(modelRuleCount).toBe(0);
    } finally {
      await stopTestServer(server);
    }
  });

  it('clones only explicit source workflow-scoped task policy rows without adding starter rows', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`DELETE FROM sprint_task_statuses WHERE sprint_id = 10`);
      await db.run(`DELETE FROM sprint_task_transitions WHERE sprint_id = 10`);
      await db.run(`DELETE FROM sprint_task_transition_requirements WHERE sprint_id = 10`);

      const response = await fetch(`${baseUrl}/api/v1/sprints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: 1,
          name: 'Empty Policy Clone',
          source_sprint_id: 10,
          status: 'planning',
        }),
      });
      const body = await response.json() as { id: number; sprint_type: string };

      expect(response.status).toBe(201);
      expect(body.sprint_type).toBe('enhancements');
      expect((await db.get(`SELECT COUNT(*) AS n FROM sprint_task_statuses WHERE sprint_id = ?`, body.id) as { n: number }).n).toBe(0);
      expect((await db.get(`SELECT COUNT(*) AS n FROM sprint_task_transitions WHERE sprint_id = ?`, body.id) as { n: number }).n).toBe(0);
      expect((await db.get(`SELECT COUNT(*) AS n FROM sprint_task_transition_requirements WHERE sprint_id = ?`, body.id) as { n: number }).n).toBe(0);
    } finally {
      await stopTestServer(server);
    }
  });

  it('supports workflow CRUD aliases with workflow request and response compatibility fields', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const createResponse = await fetch(`${baseUrl}/api/v1/workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: 1,
          name: 'Workflow Alias',
          workflow_type: 'enhancements',
          source_workflow_id: 10,
          status: 'planning',
          length_kind: 'time',
          length_value: '1w',
        }),
      });
      const created = await createResponse.json() as {
        id: number;
        workflow_id: number;
        sprint_type: string;
        workflow_type: string;
      };

      expect(createResponse.status).toBe(201);
      expect(created.workflow_id).toBe(created.id);
      expect(created.sprint_type).toBe('enhancements');
      expect(created.workflow_type).toBe('enhancements');

      const listResponse = await fetch(`${baseUrl}/api/v1/workflows?project_id=1`);
      expect(listResponse.status).toBe(200);
      const listBody = await listResponse.json() as Array<{ id: number; workflow_id: number; workflow_type: string }>;
      expect(listBody.find((workflow) => workflow.id === created.id)).toEqual(expect.objectContaining({
        workflow_id: created.id,
        workflow_type: 'enhancements',
      }));

      const detailResponse = await fetch(`${baseUrl}/api/v1/workflows/${created.id}`);
      expect(detailResponse.status).toBe(200);
      await expect(detailResponse.json()).resolves.toEqual(expect.objectContaining({
        id: created.id,
        workflow_id: created.id,
        workflow_type: 'enhancements',
      }));

      const updateResponse = await fetch(`${baseUrl}/api/v1/workflows/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow_type: 'generic', goal: 'Updated via workflow alias' }),
      });
      expect(updateResponse.status).toBe(200);
      await expect(updateResponse.json()).resolves.toEqual(expect.objectContaining({
        id: created.id,
        workflow_id: created.id,
        sprint_type: 'generic',
        workflow_type: 'generic',
        goal: 'Updated via workflow alias',
      }));

      const deleteResponse = await fetch(`${baseUrl}/api/v1/workflows/${created.id}`, { method: 'DELETE' });
      expect(deleteResponse.status).toBe(200);
      await expect(deleteResponse.json()).resolves.toEqual({ ok: true });

      const legacyResponse = await fetch(`${baseUrl}/api/v1/sprints/10`);
      expect(legacyResponse.status).toBe(200);
      const legacyBody = await legacyResponse.json() as Record<string, unknown>;
      expect(legacyBody.sprint_type).toBe('enhancements');
      expect(legacyBody.workflow_id).toBeUndefined();
      expect(legacyBody.workflow_type).toBeUndefined();
    } finally {
      await stopTestServer(server);
    }
  });

  it('deletes tasks that belong to a deleted workflow', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`INSERT INTO tasks (id, sprint_id, status, story_points) VALUES (120, 10, 'ready', 3), (121, 20, 'ready', 5)`);

      const deleteResponse = await fetch(`${baseUrl}/api/v1/workflows/10`, { method: 'DELETE' });
      expect(deleteResponse.status).toBe(200);
      await expect(deleteResponse.json()).resolves.toEqual({ ok: true });

      expect(await db.get(`SELECT id FROM tasks WHERE id = 120`)).toBeUndefined();
      expect(await db.get(`SELECT id, sprint_id FROM tasks WHERE id = 121`)).toEqual({ id: 121, sprint_id: 20 });
    } finally {
      await stopTestServer(server);
    }
  });

  it('supports workflow metrics, close, and complete endpoint aliases', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`INSERT INTO tasks (id, sprint_id, status, story_points) VALUES (100, 10, 'done', 3), (101, 10, 'ready', 5), (102, NULL, 'ready', 2)`);
      await db.run(`INSERT INTO task_dependencies (blocker_id, blocked_id) VALUES (101, 100)`);
      await db.run(`INSERT INTO job_instances (task_id, agent_id, status) VALUES (100, 7, 'done'), (101, 7, 'failed')`);

      const metricsResponse = await fetch(`${baseUrl}/api/v1/workflows/10/metrics`);
      expect(metricsResponse.status).toBe(200);
      await expect(metricsResponse.json()).resolves.toEqual(expect.objectContaining({
        sprint_id: 10,
        workflow_id: 10,
        tasks_total: 2,
        tasks_done: 1,
        job_runs_total: 2,
      }));

      const closeResponse = await fetch(`${baseUrl}/api/v1/workflows/10/close`, { method: 'POST' });
      expect(closeResponse.status).toBe(200);
      await expect(closeResponse.json()).resolves.toEqual(expect.objectContaining({
        id: 10,
        workflow_id: 10,
        status: 'closed',
        workflow_type: 'enhancements',
      }));

      await db.run(`UPDATE sprints SET status = 'active', ended_at = NULL WHERE id = 10`);

      const completeResponse = await fetch(`${baseUrl}/api/v1/workflows/10/complete`, { method: 'POST' });
      const completeBody = await completeResponse.json();
      expect(completeResponse.status).toBe(200);
      expect(completeBody).toEqual(expect.objectContaining({
        id: 10,
        workflow_id: 10,
        status: 'complete',
        workflow_type: 'enhancements',
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('supports workflow definition aliases with workflow_type request and response fields', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const typeResponse = await fetch(`${baseUrl}/api/v1/workflows/types/enhancements/task-types`);
      expect(typeResponse.status).toBe(200);
      await expect(typeResponse.json()).resolves.toEqual(expect.objectContaining({
        sprint_type: expect.objectContaining({ key: 'enhancements' }),
        workflow_type: expect.objectContaining({ key: 'enhancements' }),
        task_types: [],
      }));

      const metadataResponse = await fetch(`${baseUrl}/api/v1/workflows/workflow-metadata?workflow_type=enhancements&task_type=backend`);
      expect(metadataResponse.status).toBe(200);
      await expect(metadataResponse.json()).resolves.toEqual(expect.objectContaining({
        sprint_type: 'enhancements',
        workflow_type: 'enhancements',
        task_type: 'backend',
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects an unknown source sprint', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/sprints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, name: 'Broken Clone', source_sprint_id: 999 }),
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'Source sprint 999 not found' });
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects cloning from a sprint in another project', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/sprints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, name: 'Cross Project Clone', source_sprint_id: 20 }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'source_sprint_id must belong to project 1' });
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects conflicting sprint_type when source_sprint_id is provided', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/sprints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, name: 'Conflict Clone', source_sprint_id: 10, sprint_type: 'generic' }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'sprint_type must match source sprint type "enhancements" when source_sprint_id is provided',
      });
    } finally {
      await stopTestServer(server);
    }
  });

  it('creates, updates, clears, and exposes sprint type status emoji through sprint definitions endpoints', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`
        INSERT INTO sprint_type_task_statuses (sprint_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json)
        VALUES ('enhancements', 'metadata_only', 'Metadata Only', 'violet', 0, 0, '[]', 9, 0, '{"emoji":"🧬","source":"legacy"}')
      `);

      const metadataOnlyListResponse = await fetch(`${baseUrl}/api/v1/sprints/types/enhancements/statuses`);
      expect(metadataOnlyListResponse.status).toBe(200);
      const metadataOnlyListBody = await metadataOnlyListResponse.json() as {
        statuses: Array<{ name: string; emoji?: string | null; metadata?: Record<string, unknown> }>;
      };
      expect(metadataOnlyListBody.statuses.find((status) => status.name === 'metadata_only')).toEqual(expect.objectContaining({
        name: 'metadata_only',
        emoji: '🧬',
        metadata: expect.objectContaining({ emoji: '🧬', source: 'legacy' }),
      }));

      const createResponse = await fetch(`${baseUrl}/api/v1/sprints/types/enhancements/statuses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'handoff',
          label: 'Handoff',
          color: 'cyan',
          emoji: '🤝',
          metadata: { source: true },
        }),
      });

      expect(createResponse.status).toBe(201);
      await expect(createResponse.json()).resolves.toEqual(expect.objectContaining({
        name: 'handoff',
        emoji: '🤝',
        metadata: expect.objectContaining({ emoji: '🤝' }),
      }));

      const workflowResponse = await fetch(`${baseUrl}/api/v1/sprints/workflow-metadata?sprint_type=enhancements`);
      expect(workflowResponse.status).toBe(200);
      const workflowBody = await workflowResponse.json() as {
        statuses: Array<{ name: string; emoji?: string | null; metadata?: Record<string, unknown> }>;
      };
      expect(workflowBody.statuses.find((status) => status.name === 'handoff')).toEqual(expect.objectContaining({
        name: 'handoff',
        emoji: '🤝',
        metadata: expect.objectContaining({ emoji: '🤝' }),
      }));

      const updateResponse = await fetch(`${baseUrl}/api/v1/sprints/types/enhancements/statuses/review_ready`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji: '' }),
      });

      expect(updateResponse.status).toBe(200);
      await expect(updateResponse.json()).resolves.toEqual(expect.objectContaining({
        name: 'review_ready',
        emoji: null,
        metadata: {},
      }));

      const clearCreatedEmojiResponse = await fetch(`${baseUrl}/api/v1/sprints/types/enhancements/statuses/handoff`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji: '' }),
      });

      expect(clearCreatedEmojiResponse.status).toBe(200);
      await expect(clearCreatedEmojiResponse.json()).resolves.toEqual(expect.objectContaining({
        name: 'handoff',
        emoji: null,
        metadata: expect.objectContaining({ source: true }),
      }));

      const typeRow = await db.get(`
        SELECT metadata_json
        FROM sprint_type_task_statuses
        WHERE sprint_type_key = ? AND status_key = ?
      `, 'enhancements', 'review_ready') as { metadata_json: string } | undefined;
      expect(typeRow).toBeDefined();
      expect(JSON.parse(typeRow?.metadata_json ?? '{}')).toEqual({});

      const sprintRow = await db.get(`
        SELECT metadata_json
        FROM sprint_task_statuses
        WHERE sprint_id = ? AND status_key = ?
      `, 10, 'handoff') as { metadata_json: string } | undefined;
      expect(sprintRow).toBeDefined();
      expect(JSON.parse(sprintRow?.metadata_json ?? '{}')).toEqual(expect.objectContaining({ source: true }));

      const typeCreatedRow = await db.get(`
        SELECT metadata_json
        FROM sprint_type_task_statuses
        WHERE sprint_type_key = ? AND status_key = ?
      `, 'enhancements', 'handoff') as { metadata_json: string } | undefined;
      expect(typeCreatedRow).toBeDefined();
      expect(JSON.parse(typeCreatedRow?.metadata_json ?? '{}')).toEqual(expect.objectContaining({ source: true }));

      const listResponse = await fetch(`${baseUrl}/api/v1/sprints/types/enhancements/statuses`);
      expect(listResponse.status).toBe(200);
      const listBody = await listResponse.json() as {
        statuses: Array<{ name: string; emoji?: string | null; metadata?: Record<string, unknown> }>;
      };
      expect(listBody.statuses.find((status) => status.name === 'review_ready')).toEqual(expect.objectContaining({
        name: 'review_ready',
        emoji: null,
        metadata: {},
      }));
      expect(listBody.statuses.find((status) => status.name === 'handoff')).toEqual(expect.objectContaining({
        name: 'handoff',
        emoji: null,
        metadata: expect.objectContaining({ source: true }),
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('allows deleting seeded sprint-type statuses when no tasks or transitions still reference them', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`
        INSERT INTO sprint_type_task_statuses (sprint_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json)
        VALUES ('enhancements', 'seeded_default', 'Seeded Default', 'amber', 0, 1, '[]', 10, 0, '{}')
      `);

      const deleteResponse = await fetch(`${baseUrl}/api/v1/sprints/types/enhancements/statuses/seeded_default`, {
        method: 'DELETE',
      });

      expect(deleteResponse.status).toBe(200);
      await expect(deleteResponse.json()).resolves.toEqual({ ok: true });

      const listResponse = await fetch(`${baseUrl}/api/v1/sprints/types/enhancements/statuses`);
      expect(listResponse.status).toBe(200);
      const listBody = await listResponse.json() as { statuses: Array<{ name: string }> };
      expect(listBody.statuses.find((status) => status.name === 'seeded_default')).toBeUndefined();

      const deletedRow = await db.get(`
        SELECT id
        FROM sprint_type_task_statuses
        WHERE sprint_type_key = ? AND status_key = ?
      `, 'enhancements', 'seeded_default');
      expect(deletedRow).toBeUndefined();
    } finally {
      await stopTestServer(server);
    }
  });

  it('keeps an initialized sprint type empty after deleting its last starter status', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`
        INSERT INTO sprint_types (key, name, description, is_system, status_seeded_at)
        VALUES ('custom', 'Custom', '', 1, datetime('now'))
      `);
      await db.run(`
        INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value, started_at)
        VALUES (30, 2, 1, 'Custom Closed', 'Custom goal', 'custom', 'closed', 'time', '1w', NULL)
      `);
      await db.run(`
        INSERT INTO sprint_type_task_statuses (sprint_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json)
        VALUES ('custom', 'only_status', 'Only Status', 'amber', 0, 1, '[]', 0, 1, '{}')
      `);

      const deleteResponse = await fetch(`${baseUrl}/api/v1/sprints/types/custom/statuses/only_status`, {
        method: 'DELETE',
      });
      expect(deleteResponse.status).toBe(200);

      const listResponse = await fetch(`${baseUrl}/api/v1/sprints/types/custom/statuses`);
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toEqual(expect.objectContaining({
        sprint_type: expect.objectContaining({ key: 'custom' }),
        statuses: [],
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('keeps sprint-type status conflict checks even for seeded statuses', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`
        INSERT INTO sprint_type_task_statuses (sprint_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json)
        VALUES
          ('enhancements', 'seeded_in_use', 'Seeded In Use', 'amber', 0, 1, '[]', 10, 0, '{}'),
          ('enhancements', 'seeded_transition', 'Seeded Transition', 'amber', 0, 1, '[]', 11, 0, '{}'),
          ('enhancements', 'seeded_hint', 'Seeded Hint', 'amber', 0, 1, '[]', 12, 0, '{}'),
          ('enhancements', 'hint_source', 'Hint Source', 'amber', 0, 0, '["seeded_hint"]', 13, 0, '{}')
      `);
      await db.run(`INSERT INTO tasks (sprint_id, status, story_points) VALUES (10, 'seeded_in_use', 3)`);
      await db.run(`
        INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected)
        VALUES (10, 'backend', 'seeded_transition', 'ship_it', 'review', 1, 1, 0)
      `);

      const inUseResponse = await fetch(`${baseUrl}/api/v1/sprints/types/enhancements/statuses/seeded_in_use`, {
        method: 'DELETE',
      });
      expect(inUseResponse.status).toBe(409);
      await expect(inUseResponse.json()).resolves.toEqual(expect.objectContaining({
        reason: 'tasks_in_use',
        task_count: 1,
      }));

      const transitionResponse = await fetch(`${baseUrl}/api/v1/sprints/types/enhancements/statuses/seeded_transition`, {
        method: 'DELETE',
      });
      expect(transitionResponse.status).toBe(409);
      await expect(transitionResponse.json()).resolves.toEqual(expect.objectContaining({
        reason: 'transitions_in_use',
        transitions: expect.arrayContaining([
          expect.objectContaining({ from_status: 'seeded_transition', outcome: 'ship_it', to_status: 'review' }),
        ]),
      }));

      const hintResponse = await fetch(`${baseUrl}/api/v1/sprints/types/enhancements/statuses/seeded_hint`, {
        method: 'DELETE',
      });
      expect(hintResponse.status).toBe(409);
      await expect(hintResponse.json()).resolves.toEqual(expect.objectContaining({
        reason: 'referenced_by_statuses',
        referencing_statuses: ['hint_source'],
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('exposes workflow warnings when a routed sprint status has no configured workflow-event or outcome transitions', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`
        INSERT INTO sprint_task_routing_rules (sprint_id, task_type, status, agent_id, priority, is_system)
        VALUES (10, 'backend', 'needs_attention', 1, 0, 0)
      `);

      const workflowResponse = await fetch(`${baseUrl}/api/v1/sprints/workflow-metadata?sprint_id=10`);
      expect(workflowResponse.status).toBe(200);
      const workflowBody = await workflowResponse.json() as {
        routing_warnings: Array<{ kind: string; status: string; task_types: string[]; message: string }>;
      };

      expect(workflowBody.routing_warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'routed_status_missing_external_event_or_outcome_transitions',
          status: 'needs_attention',
          task_types: ['backend'],
          message: expect.stringContaining('no configured workflow-event or outcome transitions'),
        }),
      ]));
    } finally {
      await stopTestServer(server);
    }
  });

  it('treats matching workflow-event mappings as an explicit exit path for dispatchable statuses', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`INSERT INTO projects (id, name) VALUES (86, 'Agent HQ')`);
      await db.run(`INSERT INTO sprint_types (key, name, is_system) VALUES ('dev', 'Development', 1)`);

      const policy = require('../domains/routing/policy') as typeof import('../domains/routing/policy');
      const externalEvents = require('../domains/routing/externalEventMappings') as typeof import('../domains/routing/externalEventMappings');
      await policy.seedSprintTypeTaskStatuses(db, 'dev', { force: true });
      await policy.seedSprintTaskPolicy(db, 57, { force: true });
      await externalEvents.seedDefaultExternalEventMappings(db);
      await db.run(`
        INSERT INTO sprint_task_routing_rules (sprint_id, task_type, status, agent_id, priority, is_system)
        VALUES (57, 'backend', 'ready', 1, 0, 0)
      `);

      const workflowResponse = await fetch(`${baseUrl}/api/v1/sprints/workflow-metadata?sprint_id=57`);
      expect(workflowResponse.status).toBe(200);
      const workflowBody = await workflowResponse.json() as {
        routing_warnings: Array<{ status: string }>;
      };

      expect(workflowBody.routing_warnings.some((warning) => warning.status === 'ready')).toBe(false);
    } finally {
      await stopTestServer(server);
    }
  });
});
