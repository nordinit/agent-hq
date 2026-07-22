import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { closeDb, getDb } from '../db/client';
import { initSchema } from '../db/schema';
import {
  authenticateMcpApiKeyIfPresent,
  authorizeMcpApiRequestIfPresent,
  ensureConfiguredRuntimeMcpApiKey,
  getAgentMcpPermissionPolicy,
  ensureMcpApiKeyTable,
  issueMcpApiKeyForAgent,
  replaceAgentMcpPermissionPolicy,
  resolveMcpApiIdentityForKey,
  resetAgentMcpPermissionPolicy,
} from './mcpApiAuth';
import { handleJsonRequestErrors } from './jsonRequestErrors';
import { resolveTenantIdFromRequest } from './tenantContext';
import projectFilesRouter from '../routes/project-files';

const ORIGINAL_DB_PATH = process.env.AGENT_HQ_DB_PATH;
const ORIGINAL_MCP_API_KEY = process.env.AGENT_HQ_MCP_API_KEY;
const ORIGINAL_MCP_API_KEY_AGENT_ID = process.env.AGENT_HQ_MCP_API_KEY_AGENT_ID;
const ORIGINAL_MCP_API_KEY_AGENT_OPENCLAW_ID = process.env.AGENT_HQ_MCP_API_KEY_AGENT_OPENCLAW_ID;
const ORIGINAL_MCP_API_KEY_AGENT_SESSION_KEY = process.env.AGENT_HQ_MCP_API_KEY_AGENT_SESSION_KEY;
const ORIGINAL_MCP_API_KEY_AGENT_SLUG = process.env.AGENT_HQ_MCP_API_KEY_AGENT_SLUG;
const ORIGINAL_MCP_API_KEY_GLOBAL_ADMIN = process.env.AGENT_HQ_MCP_API_KEY_GLOBAL_ADMIN;

function restoreEnv(name: string, value: string | undefined): void {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

function redirectPreservingQuery(req: express.Request, path: string): string {
  const queryStart = req.originalUrl.indexOf('?');
  return queryStart === -1 ? path : `${path}${req.originalUrl.slice(queryStart)}`;
}

describe('mcpApiAuth scoped Agent HQ permissions', () => {
  let tempDir: string;
  let server: Server | null = null;
  let baseUrl = '';
  let normalKey = '';
  let adminKey = '';
  let ecoKey = '';
  let noProjectKey = '';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-api-auth-'));
    process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq.db');
    closeDb();

    const db = getDb();
    db.exec(`
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
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        tenant_id INTEGER,
        project_id INTEGER,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        system_role TEXT,
        deleted_at TEXT
      );
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        tenant_id INTEGER,
        name TEXT NOT NULL
      );
      CREATE TABLE sprints (
        id INTEGER PRIMARY KEY,
        tenant_id INTEGER,
        project_id INTEGER,
        name TEXT NOT NULL,
        sprint_type TEXT
      );
      CREATE TABLE sprint_task_routing_rules (
        id INTEGER PRIMARY KEY,
        tenant_id INTEGER,
        project_id INTEGER,
        sprint_id INTEGER,
        sprint_type TEXT,
        task_type TEXT,
        status TEXT,
        agent_id INTEGER,
        priority INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE sprint_types (
        key TEXT PRIMARY KEY,
        tenant_id INTEGER,
        project_id INTEGER,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        is_system INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        tenant_id INTEGER,
        project_id INTEGER,
        sprint_id INTEGER,
        agent_id INTEGER,
        assigned_agent_id INTEGER,
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
      CREATE TABLE project_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        file_path TEXT NOT NULL,
        uploaded_by TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_by TEXT NOT NULL DEFAULT 'manual',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        current_version INTEGER NOT NULL DEFAULT 1,
        current_version_id INTEGER
      );
      CREATE TABLE project_file_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        project_id INTEGER NOT NULL,
        file_id INTEGER NOT NULL,
        version_number INTEGER NOT NULL,
        filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        file_path TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        change_source TEXT NOT NULL DEFAULT 'api',
        UNIQUE(file_id, version_number)
      );
    `);

    ensureMcpApiKeyTable(db);

    db.prepare(`INSERT INTO tenants (id, name, slug, is_default) VALUES (?, ?, ?, ?), (?, ?, ?, ?)`)
      .run(1, 'Default Tenant', 'default', 1, 2, 'EcoPool', 'ecopool', 0);
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`).run();
    db.prepare(`INSERT INTO agents (id, tenant_id, project_id, name, enabled, system_role) VALUES (?, ?, ?, ?, 1, NULL), (?, ?, ?, ?, 1, 'admin'), (?, ?, ?, ?, 1, NULL), (?, ?, ?, ?, 1, NULL), (?, ?, ?, ?, 1, NULL)`)
      .run(7, 1, 86, 'Cinder', 8, 1, 86, 'Atlas', 9, 1, 86, 'QA', 10, 2, 99, 'EcoPool Worker', 11, 1, null, 'No Project Agent');
    db.prepare(`INSERT INTO projects (id, tenant_id, name) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)`)
      .run(86, 1, 'Agent HQ', 87, 1, 'Other Tenant One Project', 99, 2, 'EcoPool Project');
    db.prepare(`INSERT INTO sprints (id, tenant_id, project_id, name) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`)
      .run(42, 1, 86, 'Enhancements', 44, 1, 87, 'Other Project Sprint', 43, 2, 99, 'EcoPool Sprint');
    db.prepare(`UPDATE sprints SET sprint_type = ? WHERE id = ?`).run('dev', 42);
    db.prepare(`UPDATE sprints SET sprint_type = ? WHERE id = ?`).run('dev', 44);
    db.prepare(`UPDATE sprints SET sprint_type = ? WHERE id = ?`).run('dev', 43);
    db.prepare(`
      INSERT INTO sprint_task_routing_rules (id, tenant_id, project_id, sprint_id, sprint_type, task_type, status, agent_id, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      501, 1, 86, null, 'dev', 'backend', 'ready', 7, 10,
      502, 1, 86, 42, 'dev', 'qa', 'review', 9, 20,
      503, 1, 87, null, 'dev', 'backend', 'ready', 9, 10,
      504, 2, 99, null, 'dev', 'backend', 'ready', 10, 10,
    );
    db.prepare(`
      INSERT INTO sprint_types (key, tenant_id, project_id, name, description, is_system)
      VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)
    `).run(
      'dev', 1, 86, 'Development', 'Agent HQ project development workflow', 0,
      'other-project-dev', 1, 87, 'Other project development', 'Other project workflow', 0,
      'eco-dev', 2, 99, 'Eco development', 'EcoPool workflow', 0,
    );
    db.prepare(`INSERT INTO job_instances (id, task_id, agent_id, status) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`)
      .run(2551, 448, 7, 'running', 2552, 449, 9, 'running', 2553, 450, 10, 'running');
    db.prepare(`INSERT INTO tasks (id, tenant_id, project_id, sprint_id, agent_id, assigned_agent_id, active_instance_id) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`)
      .run(448, 1, 86, 42, 7, 9, 2551, 449, 2, 99, 43, 9, 9, 2552, 450, 2, 99, 43, 10, 10, 2553, 451, 1, 86, 42, null, null, null, 452, 1, 87, 44, null, null, null);

    normalKey = issueMcpApiKeyForAgent(db, 7).apiKey;
    adminKey = issueMcpApiKeyForAgent(db, 8).apiKey;
    ecoKey = issueMcpApiKeyForAgent(db, 10).apiKey;
    noProjectKey = issueMcpApiKeyForAgent(db, 11).apiKey;

    const app = express();
    app.use(express.json());
    app.use(handleJsonRequestErrors);
    app.use('/api/v1', authenticateMcpApiKeyIfPresent);
    app.use('/api/v1', authorizeMcpApiRequestIfPresent);

    app.get('/api/v1/tasks/:id', (req, res) => res.json({ ok: true, task_id: Number(req.params.id), tenant_id: resolveTenantIdFromRequest(getDb(), req) }));
    app.get('/api/v1/tasks/:id/context', (req, res) => res.json({ ok: true, task_id: Number(req.params.id), mode: req.query.mode ?? 'summary' }));
    app.get('/api/v1/tasks/:id/notes', (req, res) => res.json({ ok: true, task_id: Number(req.params.id), notes: [] }));
    app.get('/api/v1/tasks/:id/history', (req, res) => res.json({ ok: true, task_id: Number(req.params.id), history: [] }));
    app.get('/api/v1/tasks/:id/instances', (req, res) => res.json({ ok: true, task_id: Number(req.params.id) }));
    app.get('/api/v1/tasks/:id/relationships', (req, res) => res.json({ ok: true, task_id: Number(req.params.id), relationships: [] }));
    app.get('/api/v1/tasks/:id/relationship-types', (req, res) => res.json({ ok: true, task_id: Number(req.params.id), relationship_types: [] }));
    app.get('/api/v1/tasks/:id/active-owner', (req, res) => res.json({ ok: true, task_id: Number(req.params.id) }));
    app.get('/api/v1/agents/:id/mcp-permissions', (req, res) => res.json(getAgentMcpPermissionPolicy(getDb(), Number(req.params.id))));
    app.post('/api/v1/agents/:id/mcp-permissions', (req, res) => res.json(replaceAgentMcpPermissionPolicy(getDb(), Number(req.params.id), req.body.enabled_capabilities)));
    app.put('/api/v1/agents/:id/mcp-permissions', (req, res) => res.json(replaceAgentMcpPermissionPolicy(getDb(), Number(req.params.id), req.body.enabled_capabilities)));
    app.delete('/api/v1/agents/:id/mcp-permissions', (req, res) => res.json(resetAgentMcpPermissionPolicy(getDb(), Number(req.params.id))));
    app.post('/api/v1/tasks/project-search', (_req, res) => res.json({ ok: true, tasks: [] }));
    app.post('/api/v1/tasks/:id/relationships', (req, res) => res.status(201).json({ ok: true, task_id: Number(req.params.id), body: req.body }));
    app.delete('/api/v1/tasks/:id/relationships/:relationshipId', (req, res) => res.json({ ok: true, task_id: Number(req.params.id), relationship_id: Number(req.params.relationshipId) }));
    app.post('/api/v1/tasks/:id/notes', (req, res) => res.status(201).json({ ok: true, task_id: Number(req.params.id), body: req.body }));
    app.post('/api/v1/tasks/:id/outcome', (req, res) => res.json({ ok: true, task_id: Number(req.params.id), body: req.body }));
    app.put('/api/v1/instances/:id/start', (req, res) => res.json({ ok: true, instance_id: Number(req.params.id), body: req.body }));
    app.post('/api/v1/projects', (req, res) => res.status(201).json({ ok: true, body: req.body }));
    app.get('/api/v1/projects/:id', (req, res) => res.json({ ok: true, project_id: Number(req.params.id) }));
    app.delete('/api/v1/projects/:id', (req, res) => res.json({ ok: true, project_id: Number(req.params.id) }));
    app.post('/api/v1/mcp-servers', (_req, res) => res.status(201).json({ ok: true }));
    app.use('/api/v1/projects/:id/files', projectFilesRouter);
    app.get('/api/v1/sprints/workflow-metadata', (req, res) => res.json({
      ok: true,
      tenant_id: resolveTenantIdFromRequest(getDb(), req),
      sprint_type: req.query.sprint_type ?? 'generic',
      task_type: req.query.task_type ?? null,
      statuses: [],
      outcomes: [],
      relationship_types: [],
    }));
    app.get('/api/v1/sprints/:id', (req, res) => res.json({ ok: true, sprint_id: Number(req.params.id) }));
    const listAssignmentRules = (req: express.Request, res: express.Response) => res.json({ ok: true, query: req.query });
    const createAssignmentRule = (req: express.Request, res: express.Response) => res.status(201).json({ ok: true, body: req.body });
    const getAssignmentRule = (req: express.Request, res: express.Response) => res.json({ ok: true, rule_id: Number(req.params.id), query: req.query });
    const updateAssignmentRule = (req: express.Request, res: express.Response) => res.json({ ok: true, rule_id: Number(req.params.id), body: req.body });
    const deleteAssignmentRule = (req: express.Request, res: express.Response) => res.json({ ok: true, rule_id: Number(req.params.id), query: req.query });
    for (const prefix of ['/api/v1/routing/rules', '/api/v1/routing/assignment-rules', '/api/v1/routing-rules', '/api/v1/assignment-rules']) {
      app.get(prefix, listAssignmentRules);
      app.post(prefix, createAssignmentRule);
      app.get(`${prefix}/:id`, getAssignmentRule);
      app.put(`${prefix}/:id`, updateAssignmentRule);
      app.delete(`${prefix}/:id`, deleteAssignmentRule);
    }
    app.get('/api/v1/routing/transitions', (req, res) => res.json({ ok: true, query: req.query }));
    app.put('/api/v1/routing/transition-requirements/:id', (req, res) => res.json({ ok: true, requirement_id: Number(req.params.id), body: req.body }));
    app.get('/api/v1/sprints/config', (req, res) => res.json({ ok: true, project_id: req.query.project_id ? Number(req.query.project_id) : null }));
    app.get('/api/v1/sprints/types/list', (req, res) => res.json({ ok: true, query: req.query }));
    app.get('/api/v1/sprints/types/:key', (req, res) => res.json({ ok: true, key: req.params.key, query: req.query }));
    app.post('/api/v1/sprints/types', (req, res) => res.status(201).json({ ok: true, body: req.body }));
    app.put('/api/v1/sprints/types/:key', (req, res) => res.json({ ok: true, key: req.params.key, body: req.body }));
    app.delete('/api/v1/sprints/types/:key', (req, res) => res.json({ ok: true, key: req.params.key, query: req.query }));
    app.get('/api/v1/sprints/types/:key/task-types', (req, res) => res.json({ ok: true, key: req.params.key, query: req.query, task_types: [] }));
    app.put('/api/v1/sprints/types/:key/task-types', (req, res) => res.json({ ok: true, key: req.params.key, body: req.body }));
    app.get('/api/v1/sprints/types/:key/field-schemas', (req, res) => res.json({ ok: true, key: req.params.key, query: req.query, field_schemas: [] }));
    app.post('/api/v1/sprints/types/:key/field-schemas', (req, res) => res.status(201).json({ ok: true, key: req.params.key, body: req.body }));
    app.get('/api/v1/sprints/types/:key/field-schemas/:schemaId', (req, res) => res.json({ ok: true, key: req.params.key, schema_id: Number(req.params.schemaId), query: req.query }));
    app.put('/api/v1/sprints/types/:key/field-schemas/:schemaId', (req, res) => res.json({ ok: true, key: req.params.key, schema_id: Number(req.params.schemaId), body: req.body }));
    app.delete('/api/v1/sprints/types/:key/field-schemas/:schemaId', (req, res) => res.json({ ok: true, key: req.params.key, schema_id: Number(req.params.schemaId), query: req.query }));
    app.get('/api/v1/workflows/config', (req, res) => res.json({ ok: true, project_id: req.query.project_id ? Number(req.query.project_id) : null }));
    app.get('/api/v1/workflows/types/list', (req, res) => res.json({ ok: true, query: req.query }));
    app.get('/api/v1/workflows/types/:key/task-types', (req, res) => res.json({ ok: true, key: req.params.key, query: req.query, task_types: [] }));
    app.put('/api/v1/workflows/types/:key/task-types', (req, res) => res.json({ ok: true, key: req.params.key, body: req.body }));
    app.get('/api/v1/workflows/types/:key/field-schemas', (req, res) => res.json({ ok: true, key: req.params.key, query: req.query, field_schemas: [] }));
    app.post('/api/v1/workflows/types/:key/field-schemas', (req, res) => res.status(201).json({ ok: true, key: req.params.key, body: req.body }));
    app.get('/api/v1/workflows/types/:key/field-schemas/:schemaId', (req, res) => res.json({ ok: true, key: req.params.key, schema_id: Number(req.params.schemaId), query: req.query }));
    app.put('/api/v1/workflows/types/:key/field-schemas/:schemaId', (req, res) => res.json({ ok: true, key: req.params.key, schema_id: Number(req.params.schemaId), body: req.body }));
    app.delete('/api/v1/workflows/types/:key/field-schemas/:schemaId', (req, res) => res.json({ ok: true, key: req.params.key, schema_id: Number(req.params.schemaId), query: req.query }));
    app.get('/api/v1/workflow-definitions/config', (req, res) => {
      res.redirect(307, redirectPreservingQuery(req, '/api/v1/workflows/config'));
    });
    app.get('/api/v1/workflow-definitions/types', (req, res) => {
      res.redirect(307, redirectPreservingQuery(req, '/api/v1/workflows/types/list'));
    });
    app.get('/api/v1/workflow-definitions/types/:key', (req, res) => res.json({ ok: true, key: req.params.key, query: req.query }));
    app.post('/api/v1/workflow-definitions/types', (req, res) => res.status(201).json({ ok: true, body: req.body }));
    app.put('/api/v1/workflow-definitions/types/:key', (req, res) => res.json({ ok: true, key: req.params.key, body: req.body }));
    app.delete('/api/v1/workflow-definitions/types/:key', (req, res) => res.json({ ok: true, key: req.params.key, query: req.query }));
    app.get('/api/v1/workflow-definitions/types/:key/task-types', (req, res) => res.json({ ok: true, key: req.params.key, query: req.query, task_types: [] }));
    app.put('/api/v1/workflow-definitions/types/:key/task-types', (req, res) => res.json({ ok: true, key: req.params.key, body: req.body }));
    app.get('/api/v1/workflow-definitions/types/:key/field-schemas', (req, res) => res.json({ ok: true, key: req.params.key, query: req.query, field_schemas: [] }));
    app.post('/api/v1/workflow-definitions/types/:key/field-schemas', (req, res) => res.status(201).json({ ok: true, key: req.params.key, body: req.body }));
    app.get('/api/v1/workflow-definitions/types/:key/field-schemas/:schemaId', (req, res) => res.json({ ok: true, key: req.params.key, schema_id: Number(req.params.schemaId), query: req.query }));
    app.put('/api/v1/workflow-definitions/types/:key/field-schemas/:schemaId', (req, res) => res.json({ ok: true, key: req.params.key, schema_id: Number(req.params.schemaId), body: req.body }));
    app.delete('/api/v1/workflow-definitions/types/:key/field-schemas/:schemaId', (req, res) => res.json({ ok: true, key: req.params.key, schema_id: Number(req.params.schemaId), query: req.query }));
    app.post('/api/v1/external/task-events', (_req, res) => res.status(202).json({ ok: true }));
    app.post('/api/v1/tasks', (_req, res) => res.status(201).json({ ok: true }));

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
    restoreEnv('AGENT_HQ_DB_PATH', ORIGINAL_DB_PATH);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function authHeaders(apiKey: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-agent-hq-mcp-client': 'agent-hq-mcp',
      authorization: `Bearer ${apiKey}`,
    };
  }

  it('allows scoped lifecycle writes and context reads for the active dispatched task', async () => {
    const taskRes = await fetch(`${baseUrl}/api/v1/tasks/448`, { headers: authHeaders(normalKey) });
    expect(taskRes.status).toBe(200);

    const taskContextRes = await fetch(`${baseUrl}/api/v1/tasks/448/context?mode=summary`, { headers: authHeaders(normalKey) });
    expect(taskContextRes.status).toBe(200);

    const instancesRes = await fetch(`${baseUrl}/api/v1/tasks/448/instances`, { headers: authHeaders(normalKey) });
    expect(instancesRes.status).toBe(200);

    const relationshipsRes = await fetch(`${baseUrl}/api/v1/tasks/448/relationships`, { headers: authHeaders(normalKey) });
    expect(relationshipsRes.status).toBe(200);

    const relationshipTypesRes = await fetch(`${baseUrl}/api/v1/tasks/448/relationship-types`, { headers: authHeaders(normalKey) });
    expect(relationshipTypesRes.status).toBe(200);

    const noteRes = await fetch(`${baseUrl}/api/v1/tasks/448/notes`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ content: 'Lifecycle note' }),
    });
    expect(noteRes.status).toBe(201);

    const startRes = await fetch(`${baseUrl}/api/v1/instances/2551/start`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ session_key: 'run:2551' }),
    });
    expect(startRes.status).toBe(200);

    const projectRes = await fetch(`${baseUrl}/api/v1/projects/86`, { headers: authHeaders(normalKey) });
    expect(projectRes.status).toBe(200);

    const projectFilesRes = await fetch(`${baseUrl}/api/v1/projects/86/files`, { headers: authHeaders(normalKey) });
    expect(projectFilesRes.status).toBe(200);

    const sprintRes = await fetch(`${baseUrl}/api/v1/sprints/42`, { headers: authHeaders(normalKey) });
    expect(sprintRes.status).toBe(200);

    const routingRes = await fetch(`${baseUrl}/api/v1/routing/transitions?sprint_id=42&project_id=86`, {
      headers: authHeaders(normalKey),
    });
    expect(routingRes.status).toBe(200);
  });

  it('defaults MCP requests to the key tenant instead of the UI active tenant', async () => {
    getDb().prepare(`UPDATE app_settings SET value = '2' WHERE key = 'active_tenant_id'`).run();

    const taskRes = await fetch(`${baseUrl}/api/v1/tasks/448`, { headers: authHeaders(normalKey) });
    expect(taskRes.status).toBe(200);
    await expect(taskRes.json()).resolves.toMatchObject({
      ok: true,
      task_id: 448,
      tenant_id: 1,
    });
  });

  it('allows active-owner checks for active tasks without granting normal unrelated task reads', async () => {
    const activeOwnerRes = await fetch(`${baseUrl}/api/v1/tasks/448/active-owner`, { headers: authHeaders(normalKey) });
    expect(activeOwnerRes.status).toBe(200);

    const otherTaskRes = await fetch(`${baseUrl}/api/v1/tasks/451`, { headers: authHeaders(normalKey) });
    expect(otherTaskRes.status).toBe(403);

    const unscopedSameProjectActiveOwnerRes = await fetch(`${baseUrl}/api/v1/tasks/451/active-owner`, { headers: authHeaders(normalKey) });
    expect(unscopedSameProjectActiveOwnerRes.status).toBe(403);
  });

  it('persists explicit per-agent MCP capability policy snapshots', () => {
    const db = getDb();

    const defaultSnapshot = getAgentMcpPermissionPolicy(db, 7);
    expect(defaultSnapshot.policy_mode).toBe('default');
    expect(defaultSnapshot.default_policy).toBe('scoped_runtime');
    expect(defaultSnapshot.capabilities.find((capability) => capability.key === 'tasks.create')).toMatchObject({
      group: 'Task lifecycle',
      label: 'Create Tasks',
      enabled: false,
      default_enabled: false,
      explicit_enabled: null,
    });
    expect(defaultSnapshot.capabilities.find((capability) => capability.key === 'routing_rules.manage_project_scope')).toMatchObject({
      group: 'Workflow',
      label: 'Manage project assignment rules',
      enabled: false,
      default_enabled: false,
      explicit_enabled: null,
    });
    expect(defaultSnapshot.capabilities.find((capability) => capability.key === 'workflow_definitions.read_project_scope')).toMatchObject({
      group: 'Workflow',
      label: 'Read project workflow definitions',
      enabled: false,
      default_enabled: false,
      explicit_enabled: null,
    });
    expect(defaultSnapshot.capabilities.find((capability) => capability.key === 'workflow_definitions.manage_project_scope')).toMatchObject({
      group: 'Workflow',
      label: 'Edit project workflow definitions',
      enabled: false,
      default_enabled: false,
      explicit_enabled: null,
    });
    expect(defaultSnapshot.capabilities.find((capability) => capability.key === 'admin.full_access')?.enabled).toBe(false);
    expect(defaultSnapshot.capabilities.find((capability) => capability.key === 'admin.cross_tenant')?.enabled).toBe(false);

    const explicitSnapshot = replaceAgentMcpPermissionPolicy(db, 7, [
      'discovery.read_catalog',
      'tasks.read_active_context',
    ]);
    expect(explicitSnapshot.policy_mode).toBe('explicit');
    expect(explicitSnapshot.capabilities.find((capability) => capability.key === 'tasks.read_active_context')?.enabled).toBe(true);
    expect(explicitSnapshot.capabilities.find((capability) => capability.key === 'tasks.create')?.enabled).toBe(false);
    expect(explicitSnapshot.capabilities.find((capability) => capability.key === 'routing_rules.manage_project_scope')?.enabled).toBe(false);
    expect(explicitSnapshot.capabilities.find((capability) => capability.key === 'tasks.write_active_lifecycle')?.enabled).toBe(false);

    const resetSnapshot = resetAgentMcpPermissionPolicy(db, 7);
    expect(resetSnapshot.policy_mode).toBe('default');
    expect(resetSnapshot.capabilities.find((capability) => capability.key === 'tasks.write_active_lifecycle')?.enabled).toBe(true);
  });

  it('allows scoped MCP capability policy edits for another same-project agent', async () => {
    replaceAgentMcpPermissionPolicy(getDb(), 7, [
      'discovery.read_catalog',
      'mcp_capability_policies.read',
      'mcp_capability_policies.write',
    ]);

    const createResponse = await fetch(`${baseUrl}/api/v1/agents/9/mcp-permissions`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({
        enabled_capabilities: [
          'discovery.read_catalog',
          'tasks.read_project_context',
          'tasks.search_project_tasks',
          'mcp_capability_policies.read',
        ],
      }),
    });
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json() as {
      policy_mode: string;
      capabilities: Array<{ key: string; enabled: boolean; explicit_enabled: boolean | null }>;
    };
    expect(created.policy_mode).toBe('explicit');
    expect(created.capabilities.find((capability) => capability.key === 'tasks.read_project_context')).toMatchObject({
      enabled: true,
      explicit_enabled: true,
    });
    expect(created.capabilities.find((capability) => capability.key === 'admin.full_access')).toMatchObject({
      enabled: false,
      explicit_enabled: false,
    });

    const readResponse = await fetch(`${baseUrl}/api/v1/agents/9/mcp-permissions`, {
      headers: authHeaders(normalKey),
    });
    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toMatchObject({
      agent_id: 9,
      policy_mode: 'explicit',
    });

    const updateResponse = await fetch(`${baseUrl}/api/v1/agents/9/mcp-permissions`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({
        enabled_capabilities: [
          'discovery.read_catalog',
          'tasks.create',
        ],
      }),
    });
    expect(updateResponse.status).toBe(200);
    const updated = await updateResponse.json() as {
      capabilities: Array<{ key: string; enabled: boolean; explicit_enabled: boolean | null }>;
    };
    expect(updated.capabilities.find((capability) => capability.key === 'tasks.create')).toMatchObject({
      enabled: true,
      explicit_enabled: true,
    });
    expect(updated.capabilities.find((capability) => capability.key === 'tasks.read_project_context')).toMatchObject({
      enabled: false,
      explicit_enabled: false,
    });

    const deleteResponse = await fetch(`${baseUrl}/api/v1/agents/9/mcp-permissions`, {
      method: 'DELETE',
      headers: authHeaders(normalKey),
    });
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toMatchObject({
      agent_id: 9,
      policy_mode: 'default',
    });
  });

  it('allows project-scoped workflow definition read and mutation with explicit capabilities', async () => {
    replaceAgentMcpPermissionPolicy(getDb(), 7, [
      'discovery.read_catalog',
      'workflow_definitions.read_project_scope',
      'workflow_definitions.manage_project_scope',
    ]);

    const configResponse = await fetch(`${baseUrl}/api/v1/sprints/config?project_id=86`, {
      headers: authHeaders(normalKey),
    });
    expect(configResponse.status).toBe(200);

    const listResponse = await fetch(`${baseUrl}/api/v1/sprints/types/list?project_id=86`, {
      headers: authHeaders(normalKey),
    });
    expect(listResponse.status).toBe(200);

    const getResponse = await fetch(`${baseUrl}/api/v1/sprints/types/dev?project_id=86`, {
      headers: authHeaders(normalKey),
    });
    expect(getResponse.status).toBe(200);

    const createResponse = await fetch(`${baseUrl}/api/v1/sprints/types`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({
        key: 'agent-hq-custom',
        project_id: 86,
        name: 'Agent HQ custom',
        description: 'Project-scoped workflow definition',
      }),
    });
    expect(createResponse.status).toBe(201);

    const updateResponse = await fetch(`${baseUrl}/api/v1/sprints/types/dev`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ project_id: 86, name: 'Development updated' }),
    });
    expect(updateResponse.status).toBe(200);

    const deleteResponse = await fetch(`${baseUrl}/api/v1/sprints/types/dev?project_id=86`, {
      method: 'DELETE',
      headers: authHeaders(normalKey),
    });
    expect(deleteResponse.status).toBe(200);

    const definitionConfigResponse = await fetch(`${baseUrl}/api/v1/workflow-definitions/config?project_id=86`, {
      headers: authHeaders(normalKey),
    });
    expect(definitionConfigResponse.status).toBe(200);
    await expect(definitionConfigResponse.json()).resolves.toMatchObject({ project_id: 86 });

    const definitionListResponse = await fetch(`${baseUrl}/api/v1/workflow-definitions/types?project_id=86`, {
      headers: authHeaders(normalKey),
    });
    expect(definitionListResponse.status).toBe(200);
    await expect(definitionListResponse.json()).resolves.toMatchObject({ query: { project_id: '86' } });

    const definitionGetResponse = await fetch(`${baseUrl}/api/v1/workflow-definitions/types/dev?project_id=86`, {
      headers: authHeaders(normalKey),
    });
    expect(definitionGetResponse.status).toBe(200);

    const definitionTaskTypesResponse = await fetch(`${baseUrl}/api/v1/workflow-definitions/types/dev/task-types?project_id=86`, {
      headers: authHeaders(normalKey),
    });
    expect(definitionTaskTypesResponse.status).toBe(200);

    const canonicalWorkflowTaskTypesResponse = await fetch(`${baseUrl}/api/v1/workflows/types/dev/task-types?project_id=86`, {
      headers: authHeaders(normalKey),
    });
    expect(canonicalWorkflowTaskTypesResponse.status).toBe(200);

    const canonicalSprintTaskTypesResponse = await fetch(`${baseUrl}/api/v1/sprints/types/dev/task-types?project_id=86`, {
      headers: authHeaders(normalKey),
    });
    expect(canonicalSprintTaskTypesResponse.status).toBe(200);

    const updateDefinitionTaskTypesResponse = await fetch(`${baseUrl}/api/v1/workflow-definitions/types/dev/task-types`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ project_id: 86, task_types: [{ key: 'backend', label: 'Backend' }] }),
    });
    expect(updateDefinitionTaskTypesResponse.status).toBe(200);

    const listDefinitionFieldSchemasResponse = await fetch(`${baseUrl}/api/v1/workflow-definitions/types/dev/field-schemas?project_id=86`, {
      headers: authHeaders(normalKey),
    });
    expect(listDefinitionFieldSchemasResponse.status).toBe(200);

    const getDefinitionFieldSchemaResponse = await fetch(`${baseUrl}/api/v1/workflow-definitions/types/dev/field-schemas/5?project_id=86`, {
      headers: authHeaders(normalKey),
    });
    expect(getDefinitionFieldSchemaResponse.status).toBe(200);

    const createDefinitionFieldSchemaResponse = await fetch(`${baseUrl}/api/v1/workflow-definitions/types/dev/field-schemas`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ project_id: 86, task_type: 'backend', fields: [] }),
    });
    expect(createDefinitionFieldSchemaResponse.status).toBe(201);

    const updateDefinitionFieldSchemaResponse = await fetch(`${baseUrl}/api/v1/workflow-definitions/types/dev/field-schemas/5`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ project_id: 86, fields: [{ key: 'risk', type: 'text' }] }),
    });
    expect(updateDefinitionFieldSchemaResponse.status).toBe(200);

    const deleteDefinitionFieldSchemaResponse = await fetch(`${baseUrl}/api/v1/workflow-definitions/types/dev/field-schemas/5?project_id=86`, {
      method: 'DELETE',
      headers: authHeaders(normalKey),
    });
    expect(deleteDefinitionFieldSchemaResponse.status).toBe(200);

    const definitionCreateResponse = await fetch(`${baseUrl}/api/v1/workflow-definitions/types`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({
        key: 'agent-hq-definition-custom',
        project_id: 86,
        name: 'Agent HQ definition custom',
      }),
    });
    expect(definitionCreateResponse.status).toBe(201);

    const definitionUpdateResponse = await fetch(`${baseUrl}/api/v1/workflow-definitions/types/dev`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ project_id: 86, name: 'Development definition updated' }),
    });
    expect(definitionUpdateResponse.status).toBe(200);

    const definitionDeleteResponse = await fetch(`${baseUrl}/api/v1/workflow-definitions/types/dev?project_id=86`, {
      method: 'DELETE',
      headers: authHeaders(normalKey),
    });
    expect(definitionDeleteResponse.status).toBe(200);
  });

  it('denies scoped MCP capability policy self-escalation and unsafe grants', async () => {
    replaceAgentMcpPermissionPolicy(getDb(), 7, [
      'discovery.read_catalog',
      'mcp_capability_policies.write',
    ]);

    const selfResponse = await fetch(`${baseUrl}/api/v1/agents/7/mcp-permissions`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({
        enabled_capabilities: [
          'discovery.read_catalog',
          'admin.full_access',
        ],
      }),
    });
    expect(selfResponse.status).toBe(403);
    await expect(selfResponse.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'mcp_capability_policies.write' },
    });

    const adminGrantResponse = await fetch(`${baseUrl}/api/v1/agents/9/mcp-permissions`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({
        enabled_capabilities: [
          'discovery.read_catalog',
          'admin.full_access',
        ],
      }),
    });
    expect(adminGrantResponse.status).toBe(403);
    await expect(adminGrantResponse.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      error: expect.stringContaining('admin.full_access'),
      details: { required_capability: 'mcp_capability_policies.write' },
    });

    const delegateWriterResponse = await fetch(`${baseUrl}/api/v1/agents/9/mcp-permissions`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({
        enabled_capabilities: [
          'discovery.read_catalog',
          'mcp_capability_policies.write',
        ],
      }),
    });
    expect(delegateWriterResponse.status).toBe(403);
    await expect(delegateWriterResponse.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      error: expect.stringContaining('mcp_capability_policies.write'),
      details: { required_capability: 'mcp_capability_policies.write' },
    });
  });

  it('denies scoped MCP capability policy access outside the caller project and tenant', async () => {
    replaceAgentMcpPermissionPolicy(getDb(), 7, [
      'discovery.read_catalog',
      'mcp_capability_policies.read',
      'mcp_capability_policies.write',
    ]);

    const noProjectTargetResponse = await fetch(`${baseUrl}/api/v1/agents/11/mcp-permissions`, {
      headers: authHeaders(normalKey),
    });
    expect(noProjectTargetResponse.status).toBe(403);
    await expect(noProjectTargetResponse.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'mcp_capability_policies.read' },
    });

    const crossTenantResponse = await fetch(`${baseUrl}/api/v1/agents/10/mcp-permissions`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ enabled_capabilities: ['discovery.read_catalog'] }),
    });
    expect(crossTenantResponse.status).toBe(403);
    await expect(crossTenantResponse.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'mcp_capability_policies.write' },
    });
  });

  it('keeps secret-bearing and unrelated admin MCP routes denied for scoped policy editors', async () => {
    replaceAgentMcpPermissionPolicy(getDb(), 7, [
      'discovery.read_catalog',
      'mcp_capability_policies.write',
    ]);

    const response = await fetch(`${baseUrl}/api/v1/mcp-servers`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({
        name: 'Secret server',
        slug: 'secret-server',
        command: 'node',
        env: { SECRET_TOKEN: 'not-allowed' },
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'admin.full_access' },
    });
  });

  it('denies workflow definition reads and edits without capability or outside assigned project scope', async () => {
    const missingCapability = await fetch(`${baseUrl}/api/v1/sprints/types/list?project_id=86`, {
      headers: authHeaders(normalKey),
    });
    expect(missingCapability.status).toBe(403);
    await expect(missingCapability.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'workflow_definitions.read_project_scope' },
    });

    const missingDefinitionAliasCapability = await fetch(`${baseUrl}/api/v1/workflow-definitions/types?project_id=86`, {
      headers: authHeaders(normalKey),
    });
    expect(missingDefinitionAliasCapability.status).toBe(403);
    await expect(missingDefinitionAliasCapability.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'workflow_definitions.read_project_scope' },
    });

    replaceAgentMcpPermissionPolicy(getDb(), 7, [
      'discovery.read_catalog',
      'workflow_definitions.read_project_scope',
      'workflow_definitions.manage_project_scope',
    ]);

    const unscopedList = await fetch(`${baseUrl}/api/v1/sprints/types/list`, {
      headers: authHeaders(normalKey),
    });
    expect(unscopedList.status).toBe(403);
    await expect(unscopedList.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'workflow_definitions.read_project_scope' },
    });

    const unscopedDefinitionAliasList = await fetch(`${baseUrl}/api/v1/workflow-definitions/types`, {
      headers: authHeaders(normalKey),
    });
    expect(unscopedDefinitionAliasList.status).toBe(403);
    await expect(unscopedDefinitionAliasList.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'workflow_definitions.read_project_scope' },
    });

    const otherProjectRead = await fetch(`${baseUrl}/api/v1/sprints/types/other-project-dev?project_id=87`, {
      headers: authHeaders(normalKey),
    });
    expect(otherProjectRead.status).toBe(403);

    const otherProjectCreate = await fetch(`${baseUrl}/api/v1/sprints/types`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ key: 'wrong-project', project_id: 87, name: 'Wrong project' }),
    });
    expect(otherProjectCreate.status).toBe(403);
    await expect(otherProjectCreate.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'workflow_definitions.manage_project_scope' },
    });

    const otherProjectDefinitionAliasCreate = await fetch(`${baseUrl}/api/v1/workflow-definitions/types`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ key: 'wrong-project-definition', project_id: 87, name: 'Wrong project definition' }),
    });
    expect(otherProjectDefinitionAliasCreate.status).toBe(403);
    await expect(otherProjectDefinitionAliasCreate.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'workflow_definitions.manage_project_scope' },
    });

    const otherProjectDefinitionTaskTypesRead = await fetch(`${baseUrl}/api/v1/workflow-definitions/types/other-project-dev/task-types?project_id=87`, {
      headers: authHeaders(normalKey),
    });
    expect(otherProjectDefinitionTaskTypesRead.status).toBe(403);
    await expect(otherProjectDefinitionTaskTypesRead.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'workflow_definitions.read_project_scope' },
    });

    const otherProjectDefinitionTaskTypesWrite = await fetch(`${baseUrl}/api/v1/workflow-definitions/types/other-project-dev/task-types`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ project_id: 87, task_types: [{ key: 'qa', label: 'QA' }] }),
    });
    expect(otherProjectDefinitionTaskTypesWrite.status).toBe(403);
    await expect(otherProjectDefinitionTaskTypesWrite.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'workflow_definitions.manage_project_scope' },
    });

    const otherProjectDefinitionFieldSchemaCreate = await fetch(`${baseUrl}/api/v1/workflow-definitions/types/other-project-dev/field-schemas`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ project_id: 87, task_type: 'backend', fields: [] }),
    });
    expect(otherProjectDefinitionFieldSchemaCreate.status).toBe(403);
    await expect(otherProjectDefinitionFieldSchemaCreate.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'workflow_definitions.manage_project_scope' },
    });

    const moveOutOfScope = await fetch(`${baseUrl}/api/v1/sprints/types/dev`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ project_id: 87, name: 'Move elsewhere' }),
    });
    expect(moveOutOfScope.status).toBe(403);

    const crossTenantSelector = await fetch(`${baseUrl}/api/v1/sprints/types/eco-dev?tenant_id=2&project_id=99`, {
      headers: authHeaders(normalKey),
    });
    expect(crossTenantSelector.status).toBe(403);
    await expect(crossTenantSelector.json()).resolves.toMatchObject({
      code: 'mcp_tenant_scope_denied',
      details: { required_capability: 'admin.cross_tenant' },
    });
  });

  it('fails closed for workflow definition management when the agent has no canonical project', async () => {
    replaceAgentMcpPermissionPolicy(getDb(), 11, [
      'discovery.read_catalog',
      'workflow_definitions.read_project_scope',
      'workflow_definitions.manage_project_scope',
    ]);

    const response = await fetch(`${baseUrl}/api/v1/sprints/types/list?project_id=86`, {
      headers: authHeaders(noProjectKey),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'workflow_definitions.read_project_scope' },
    });
  });

  it('refuses unrelated task access and admin-style writes for normal task-agent keys', async () => {
    const createTaskRes = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ title: 'Nope' }),
    });
    expect(createTaskRes.status).toBe(403);
    await expect(createTaskRes.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: {
        required_capability: 'tasks.create',
      },
    });

    const otherProjectRes = await fetch(`${baseUrl}/api/v1/projects/99`, { headers: authHeaders(normalKey) });
    expect(otherProjectRes.status).toBe(403);

    const otherProjectFilesRes = await fetch(`${baseUrl}/api/v1/projects/99/files`, { headers: authHeaders(normalKey) });
    expect(otherProjectFilesRes.status).toBe(403);

    const otherTaskNoteRes = await fetch(`${baseUrl}/api/v1/tasks/449/notes`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ content: 'Should be denied' }),
    });
    expect(otherTaskNoteRes.status).toBe(403);

    const createProjectRes = await fetch(`${baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ name: 'Should fail' }),
    });
    expect(createProjectRes.status).toBe(403);

    const deleteProjectRes = await fetch(`${baseUrl}/api/v1/projects/86`, {
      method: 'DELETE',
      headers: authHeaders(normalKey),
    });
    expect(deleteProjectRes.status).toBe(403);

    const updateWorkflowRes = await fetch(`${baseUrl}/api/v1/routing/transition-requirements/12`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ field_name: 'review_commit' }),
    });
    expect(updateWorkflowRes.status).toBe(403);

    const otherTaskRelationshipsRes = await fetch(`${baseUrl}/api/v1/tasks/449/relationships`, { headers: authHeaders(normalKey) });
    expect(otherTaskRelationshipsRes.status).toBe(403);
    await expect(otherTaskRelationshipsRes.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: {
        required_capability: 'tasks.read_active_context',
        task_id: 449,
      },
    });

    const otherTaskRelationshipTypesRes = await fetch(`${baseUrl}/api/v1/tasks/449/relationship-types`, { headers: authHeaders(normalKey) });
    expect(otherTaskRelationshipTypesRes.status).toBe(403);
    await expect(otherTaskRelationshipTypesRes.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: {
        required_capability: 'tasks.read_active_context',
        task_id: 449,
      },
    });

    const createRelationshipRes = await fetch(`${baseUrl}/api/v1/tasks/448/relationships`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ target_task_id: 449, relationship_type_key: 'relates_to' }),
    });
    expect(createRelationshipRes.status).toBe(403);
    await expect(createRelationshipRes.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: {
        required_capability: 'admin.full_access',
        task_id: 448,
      },
    });

    const deleteRelationshipRes = await fetch(`${baseUrl}/api/v1/tasks/448/relationships/12`, {
      method: 'DELETE',
      headers: authHeaders(normalKey),
    });
    expect(deleteRelationshipRes.status).toBe(403);
    await expect(deleteRelationshipRes.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: {
        required_capability: 'admin.full_access',
      },
    });

    const db = getDb();
    const deniedNote = db.prepare(`SELECT author, content FROM task_notes WHERE task_id = ? ORDER BY id DESC LIMIT 1`).get(449) as {
      author: string;
      content: string;
    } | undefined;
    expect(deniedNote).toMatchObject({
      author: 'agent-hq-mcp-auth',
      content: expect.stringContaining('Scoped MCP write refused'),
    });
  });

  it('allows task creation when the Create Tasks capability is explicitly enabled', async () => {
    replaceAgentMcpPermissionPolicy(getDb(), 7, [
      'discovery.read_catalog',
      'tasks.read_active_context',
      'tasks.write_active_lifecycle',
      'tasks.create',
    ]);

    const createTaskRes = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({
        title: 'Runtime follow-up',
        project_id: 86,
        sprint_id: 42,
        task_type: 'dev',
      }),
    });

    expect(createTaskRes.status).toBe(201);
    await expect(createTaskRes.json()).resolves.toMatchObject({ ok: true });
  });

  it('requires explicit project task search capability for scoped runtime agents', async () => {
    const denied = await fetch(`${baseUrl}/api/v1/tasks/project-search`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ custom_fields: { crm_lead_id: 'lead-123' }, nonterminal_only: true }),
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'tasks.search_project_tasks' },
    });

    replaceAgentMcpPermissionPolicy(getDb(), 7, [
      'discovery.read_catalog',
      'tasks.search_project_tasks',
    ]);

    const allowed = await fetch(`${baseUrl}/api/v1/tasks/project-search`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ custom_fields: { crm_lead_id: 'lead-123' }, nonterminal_only: true }),
    });
    expect(allowed.status).toBe(200);
  });

  it('allows scoped routing rule read/create/update/delete when the assigned-project capability is enabled', async () => {
    replaceAgentMcpPermissionPolicy(getDb(), 7, [
      'discovery.read_catalog',
      'routing_rules.manage_project_scope',
    ]);

    const listResponse = await fetch(`${baseUrl}/api/v1/routing/assignment-rules?project_id=86&sprint_type=dev`, {
      headers: authHeaders(normalKey),
    });
    expect(listResponse.status).toBe(200);

    const getResponse = await fetch(`${baseUrl}/api/v1/routing/rules/501`, {
      headers: authHeaders(normalKey),
    });
    expect(getResponse.status).toBe(200);

    const createResponse = await fetch(`${baseUrl}/api/v1/routing/assignment-rules`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({
        project_id: 86,
        sprint_type: 'dev',
        task_type: 'backend',
        status: 'ready',
        agent_id: 7,
      }),
    });
    expect(createResponse.status).toBe(201);

    const sprintCreateResponse = await fetch(`${baseUrl}/api/v1/routing/rules`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({
        project_id: 86,
        sprint_id: 42,
        task_type: 'qa',
        status: 'review',
        agent_id: 9,
      }),
    });
    expect(sprintCreateResponse.status).toBe(201);

    const updateResponse = await fetch(`${baseUrl}/api/v1/routing/assignment-rules/501`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ project_id: 86, sprint_type: 'dev', enabled: false }),
    });
    expect(updateResponse.status).toBe(200);

    const deleteResponse = await fetch(`${baseUrl}/api/v1/routing-rules/501`, {
      method: 'DELETE',
      headers: authHeaders(normalKey),
    });
    expect(deleteResponse.status).toBe(200);
  });

  it('denies routing rule edits without capability and outside the assigned project scope', async () => {
    const missingCapability = await fetch(`${baseUrl}/api/v1/routing/assignment-rules?project_id=86&sprint_type=dev`, {
      headers: authHeaders(normalKey),
    });
    expect(missingCapability.status).toBe(403);
    await expect(missingCapability.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'routing_rules.manage_project_scope' },
    });

    replaceAgentMcpPermissionPolicy(getDb(), 7, [
      'discovery.read_catalog',
      'routing_rules.manage_project_scope',
    ]);

    const unscopedList = await fetch(`${baseUrl}/api/v1/routing/assignment-rules`, {
      headers: authHeaders(normalKey),
    });
    expect(unscopedList.status).toBe(403);
    await expect(unscopedList.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'routing_rules.manage_project_scope' },
    });

    const allProjectDefault = await fetch(`${baseUrl}/api/v1/routing/assignment-rules?sprint_type=dev`, {
      headers: authHeaders(normalKey),
    });
    expect(allProjectDefault.status).toBe(403);

    const otherProjectRule = await fetch(`${baseUrl}/api/v1/routing/assignment-rules/503`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ enabled: false }),
    });
    expect(otherProjectRule.status).toBe(403);
    await expect(otherProjectRule.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'routing_rules.manage_project_scope' },
    });

    const moveOutOfScope = await fetch(`${baseUrl}/api/v1/routing/assignment-rules/501`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ project_id: 87, sprint_type: 'dev' }),
    });
    expect(moveOutOfScope.status).toBe(403);

    const crossTenantByBody = await fetch(`${baseUrl}/api/v1/routing/assignment-rules`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ project_id: 99, sprint_type: 'dev', task_type: 'backend', status: 'ready', agent_id: 10 }),
    });
    expect(crossTenantByBody.status).toBe(403);
    await expect(crossTenantByBody.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'routing_rules.manage_project_scope' },
    });

    const crossTenantSelector = await fetch(`${baseUrl}/api/v1/routing/assignment-rules?tenant_id=2&project_id=99&sprint_type=dev`, {
      headers: authHeaders(normalKey),
    });
    expect(crossTenantSelector.status).toBe(403);
    await expect(crossTenantSelector.json()).resolves.toMatchObject({
      code: 'mcp_tenant_scope_denied',
      details: { required_capability: 'admin.cross_tenant' },
    });
  });

  it('fails closed for routing rule management when the agent has no canonical project', async () => {
    replaceAgentMcpPermissionPolicy(getDb(), 11, [
      'discovery.read_catalog',
      'routing_rules.manage_project_scope',
    ]);

    const response = await fetch(`${baseUrl}/api/v1/routing/assignment-rules?project_id=86&sprint_type=dev`, {
      headers: authHeaders(noProjectKey),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'routing_rules.manage_project_scope' },
    });
  });

  it('allows read-only access to project task context when Read project task context is enabled', async () => {
    replaceAgentMcpPermissionPolicy(getDb(), 7, [
      'discovery.read_catalog',
      'tasks.read_project_context',
      'tasks.create',
    ]);

    for (const suffix of ['', '/context', '/notes', '/history', '/instances', '/relationships', '/relationship-types', '/active-owner']) {
      const response = await fetch(`${baseUrl}/api/v1/tasks/451${suffix}`, { headers: authHeaders(normalKey) });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true, task_id: 451 });
    }

    const createdTaskRes = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({
        title: 'Agency defect follow-up',
        project_id: 86,
        sprint_id: 42,
        task_type: 'dev',
      }),
    });
    expect(createdTaskRes.status).toBe(201);

    const sameTenantOtherProjectTaskRes = await fetch(`${baseUrl}/api/v1/tasks/452`, { headers: authHeaders(normalKey) });
    expect(sameTenantOtherProjectTaskRes.status).toBe(403);
    await expect(sameTenantOtherProjectTaskRes.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: {
        required_capability: 'tasks.read_project_context',
        task_id: 452,
      },
    });

    const crossTenantTaskRes = await fetch(`${baseUrl}/api/v1/tasks/449`, { headers: authHeaders(normalKey) });
    expect(crossTenantTaskRes.status).toBe(403);
    await expect(crossTenantTaskRes.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: {
        required_capability: 'tasks.read_project_context',
        task_id: 449,
      },
    });

    const noteWriteRes = await fetch(`${baseUrl}/api/v1/tasks/451/notes`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ content: 'Should not be allowed by read_any_context' }),
    });
    expect(noteWriteRes.status).toBe(403);
    await expect(noteWriteRes.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: {
        required_capability: 'tasks.write_active_lifecycle',
        task_id: 451,
      },
    });

    const createRelationshipRes = await fetch(`${baseUrl}/api/v1/tasks/451/relationships`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ target_task_id: 448, relationship_type_key: 'relates_to' }),
    });
    expect(createRelationshipRes.status).toBe(403);
    await expect(createRelationshipRes.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: {
        required_capability: 'admin.full_access',
        task_id: 451,
      },
    });
  });

  it('fails closed for project task context reads when the agent has no canonical project', async () => {
    replaceAgentMcpPermissionPolicy(getDb(), 11, [
      'discovery.read_catalog',
      'tasks.read_project_context',
    ]);

    const response = await fetch(`${baseUrl}/api/v1/tasks/451`, { headers: authHeaders(noProjectKey) });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: {
        required_capability: 'tasks.read_project_context',
        task_id: 451,
      },
    });
  });

  it('fails closed for project task search when the agent has no canonical project', async () => {
    replaceAgentMcpPermissionPolicy(getDb(), 11, [
      'discovery.read_catalog',
      'tasks.search_project_tasks',
    ]);

    const response = await fetch(`${baseUrl}/api/v1/tasks/project-search`, {
      method: 'POST',
      headers: authHeaders(noProjectKey),
      body: JSON.stringify({ custom_fields: { external_project_id: 'ext-1' } }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'tasks.search_project_tasks' },
    });
  });

  it('invalidates legacy tenant-wide read_any_context assignments', async () => {
    getAgentMcpPermissionPolicy(getDb(), 7);
    getDb().prepare(`
      INSERT INTO agent_mcp_capability_policies (agent_id, capability_key, enabled)
      VALUES (?, ?, ?)
    `).run(7, 'tasks.read_any_context', 1);

    const snapshot = getAgentMcpPermissionPolicy(getDb(), 7);
    expect(snapshot.policy_mode).toBe('explicit');
    expect(snapshot.capabilities.some((capability) => capability.key === 'tasks.read_any_context')).toBe(false);
    expect(snapshot.capabilities.find((capability) => capability.key === 'tasks.read_project_context')).toMatchObject({
      enabled: false,
      explicit_enabled: null,
    });

    const response = await fetch(`${baseUrl}/api/v1/tasks/451`, { headers: authHeaders(normalKey) });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: {
        required_capability: 'tasks.read_active_context',
        task_id: 451,
      },
    });
  });

  it('enforces explicit capability denies even for otherwise scoped routes', async () => {
    replaceAgentMcpPermissionPolicy(getDb(), 7, [
      'discovery.read_catalog',
      'tasks.read_active_context',
      'tasks.write_active_lifecycle',
      'sprints.read_active_sprint',
      'workflow.read_active_configuration',
      'external.write_task_events',
    ]);

    const projectRes = await fetch(`${baseUrl}/api/v1/projects/86`, { headers: authHeaders(normalKey) });
    expect(projectRes.status).toBe(403);
    await expect(projectRes.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: {
        required_capability: 'projects.read_active_project',
        policy_mode: 'explicit',
      },
    });

    const projectFilesRes = await fetch(`${baseUrl}/api/v1/projects/86/files`, { headers: authHeaders(normalKey) });
    expect(projectFilesRes.status).toBe(403);
    await expect(projectFilesRes.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: {
        required_capability: 'projects.manage_active_files',
        policy_mode: 'explicit',
      },
    });

    const relationshipsRes = await fetch(`${baseUrl}/api/v1/tasks/448/relationships`, { headers: authHeaders(normalKey) });
    expect(relationshipsRes.status).toBe(200);

    replaceAgentMcpPermissionPolicy(getDb(), 7, [
      'discovery.read_catalog',
      'tasks.write_active_lifecycle',
      'sprints.read_active_sprint',
      'workflow.read_active_configuration',
      'external.write_task_events',
    ]);

    const disabledRelationshipsRes = await fetch(`${baseUrl}/api/v1/tasks/448/relationships`, { headers: authHeaders(normalKey) });
    expect(disabledRelationshipsRes.status).toBe(403);
    await expect(disabledRelationshipsRes.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: {
        required_capability: 'tasks.read_active_context',
        policy_mode: 'explicit',
      },
    });

    const disabledRelationshipTypesRes = await fetch(`${baseUrl}/api/v1/tasks/448/relationship-types`, { headers: authHeaders(normalKey) });
    expect(disabledRelationshipTypesRes.status).toBe(403);
    await expect(disabledRelationshipTypesRes.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: {
        required_capability: 'tasks.read_active_context',
        policy_mode: 'explicit',
      },
    });
  });

  it('allows explicit full administrative MCP access for a non-admin agent when granted inside its own tenant', async () => {
    replaceAgentMcpPermissionPolicy(getDb(), 7, ['admin.full_access']);

    const createProjectRes = await fetch(`${baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ name: 'Explicit admin access' }),
    });

    expect(createProjectRes.status).toBe(201);
    await expect(createProjectRes.json()).resolves.toMatchObject({ ok: true });

    const crossTenantRes = await fetch(`${baseUrl}/api/v1/projects?tenant_id=2`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ name: 'Cross tenant should fail' }),
    });
    expect(crossTenantRes.status).toBe(403);
    await expect(crossTenantRes.json()).resolves.toMatchObject({
      code: 'mcp_tenant_scope_denied',
      details: {
        key_tenant_id: 1,
        requested_tenant_id: 2,
        global_admin: false,
        required_capability: 'admin.cross_tenant',
        super_admin_mcp_access: false,
      },
    });
  });

  it('rejects tenant query/header manipulation for default and EcoPool MCP keys', async () => {
    const workflowMetadataTenantSelectorRes = await fetch(`${baseUrl}/api/v1/sprints/workflow-metadata?tenant_id=1&sprint_type=dev`, { headers: authHeaders(normalKey) });
    expect(workflowMetadataTenantSelectorRes.status).toBe(403);
    await expect(workflowMetadataTenantSelectorRes.json()).resolves.toMatchObject({
      code: 'mcp_tenant_scope_denied',
      details: { key_tenant_id: 1, requested_tenant_id: 1, required_capability: 'admin.cross_tenant' },
    });

    const defaultOwnTenantQueryRes = await fetch(`${baseUrl}/api/v1/tasks/448?tenant_id=1`, { headers: authHeaders(normalKey) });
    expect(defaultOwnTenantQueryRes.status).toBe(403);
    await expect(defaultOwnTenantQueryRes.json()).resolves.toMatchObject({
      code: 'mcp_tenant_scope_denied',
      details: { key_tenant_id: 1, requested_tenant_id: 1, required_capability: 'admin.cross_tenant' },
    });

    const defaultQueryRes = await fetch(`${baseUrl}/api/v1/tasks/450?tenant_id=2`, { headers: authHeaders(normalKey) });
    expect(defaultQueryRes.status).toBe(403);
    await expect(defaultQueryRes.json()).resolves.toMatchObject({
      code: 'mcp_tenant_scope_denied',
      details: { key_tenant_id: 1, requested_tenant_id: 2, required_capability: 'admin.cross_tenant' },
    });

    const defaultCompanyAliasRes = await fetch(`${baseUrl}/api/v1/projects/99?company_id=2`, { headers: authHeaders(adminKey) });
    expect(defaultCompanyAliasRes.status).toBe(403);
    await expect(defaultCompanyAliasRes.json()).resolves.toMatchObject({
      code: 'mcp_tenant_scope_denied',
      details: { key_tenant_id: 1, requested_tenant_id: 2, required_capability: 'admin.cross_tenant' },
    });

    const defaultHeaderRes = await fetch(`${baseUrl}/api/v1/projects/99`, {
      headers: { ...authHeaders(adminKey), 'x-agent-hq-tenant-id': '2' },
    });
    expect(defaultHeaderRes.status).toBe(403);

    const ecoToDefaultRes = await fetch(`${baseUrl}/api/v1/tasks/448?tenant_id=1`, { headers: authHeaders(ecoKey) });
    expect(ecoToDefaultRes.status).toBe(403);
    await expect(ecoToDefaultRes.json()).resolves.toMatchObject({
      code: 'mcp_tenant_scope_denied',
      details: { key_tenant_id: 2, requested_tenant_id: 1, required_capability: 'admin.cross_tenant' },
    });

    // Info-leak guard: an explicit selector for a non-existent tenant must return the
    // same 403 as one for an existing tenant, so an ordinary key cannot probe which
    // tenant IDs exist (403 vs 404). Tenant 999999 does not exist.
    const nonexistentTenantRes = await fetch(`${baseUrl}/api/v1/tasks/451?tenant_id=999999`, { headers: authHeaders(normalKey) });
    expect(nonexistentTenantRes.status).toBe(403);
    await expect(nonexistentTenantRes.json()).resolves.toMatchObject({
      code: 'mcp_tenant_scope_denied',
      details: { key_tenant_id: 1, requested_tenant_id: 999999, required_capability: 'admin.cross_tenant' },
    });
  });

  it('requires explicit super-admin MCP access for cross-tenant admin access', async () => {
    const denied = await fetch(`${baseUrl}/api/v1/projects/99?tenant_id=2`, {
      method: 'DELETE',
      headers: authHeaders(adminKey),
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      code: 'mcp_tenant_scope_denied',
      details: {
        key_tenant_id: 1,
        requested_tenant_id: 2,
        global_admin: false,
        required_capability: 'admin.cross_tenant',
        super_admin_mcp_access: false,
      },
    });

    const adminIdentity = resolveMcpApiIdentityForKey(getDb(), adminKey, { updateLastUsed: false });
    getDb().prepare(`UPDATE mcp_api_keys SET global_admin = 1 WHERE id = ?`).run(adminIdentity.keyId);

    const allowed = await fetch(`${baseUrl}/api/v1/projects/99?tenant_id=2`, {
      method: 'DELETE',
      headers: authHeaders(adminKey),
    });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({ ok: true, project_id: 99 });

    const selectedTenantMetadata = await fetch(`${baseUrl}/api/v1/sprints/workflow-metadata?tenant_id=2&sprint_type=dev&task_type=backend`, {
      headers: authHeaders(adminKey),
    });
    expect(selectedTenantMetadata.status).toBe(200);
    await expect(selectedTenantMetadata.json()).resolves.toMatchObject({
      ok: true,
      tenant_id: 2,
      sprint_type: 'dev',
      task_type: 'backend',
    });
  });

  it('allows explicit super-admin capability policy to operate across tenants', async () => {
    replaceAgentMcpPermissionPolicy(getDb(), 7, ['admin.full_access', 'admin.cross_tenant']);

    const allowed = await fetch(`${baseUrl}/api/v1/projects/99?tenant_id=2`, {
      method: 'DELETE',
      headers: authHeaders(normalKey),
    });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({ ok: true, project_id: 99 });

    const identity = resolveMcpApiIdentityForKey(getDb(), normalKey, { updateLastUsed: false });
    expect(identity.globalAdminAccess).toBe(true);
  });

  it('preserves admin capability for trusted Atlas-style MCP keys', async () => {
    const createTaskRes = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: authHeaders(adminKey),
      body: JSON.stringify({ title: 'Allowed for admin' }),
    });

    expect(createTaskRes.status).toBe(201);
    await expect(createTaskRes.json()).resolves.toMatchObject({ ok: true });

    const createProjectRes = await fetch(`${baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: authHeaders(adminKey),
      body: JSON.stringify({ name: 'Allowed project' }),
    });
    expect(createProjectRes.status).toBe(201);

    const updateWorkflowRes = await fetch(`${baseUrl}/api/v1/routing/transition-requirements/12`, {
      method: 'PUT',
      headers: authHeaders(adminKey),
      body: JSON.stringify({ field_name: 'review_commit' }),
    });
    expect(updateWorkflowRes.status).toBe(200);

    const updateRoutingRuleRes = await fetch(`${baseUrl}/api/v1/routing/assignment-rules/503`, {
      method: 'PUT',
      headers: authHeaders(adminKey),
      body: JSON.stringify({ project_id: 87, sprint_type: 'dev', enabled: false }),
    });
    expect(updateRoutingRuleRes.status).toBe(200);
  });

  it('passes external task events through to route-level source validation', async () => {
    const response = await fetch(`${baseUrl}/api/v1/external/task-events`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({
        source: 'dev_environment_lease_manager',
        event: 'deployed_for_qa',
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it('returns structured malformed_json errors for invalid lifecycle callback bodies', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tasks/448/outcome`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: '{"outcome":"completed_for_review","summary":"Quotes break here: "oops""}',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'malformed_json',
      error: 'Malformed JSON request body',
      path: '/api/v1/tasks/448/outcome',
    });
  });
});

describe('ensureConfiguredRuntimeMcpApiKey', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-api-auth-'));
    dbPath = path.join(tempDir, 'agent-hq-test.db');
    closeDb();
    process.env.AGENT_HQ_DB_PATH = dbPath;
    delete process.env.AGENT_HQ_MCP_API_KEY;
    delete process.env.AGENT_HQ_MCP_API_KEY_AGENT_ID;
    delete process.env.AGENT_HQ_MCP_API_KEY_AGENT_OPENCLAW_ID;
    delete process.env.AGENT_HQ_MCP_API_KEY_AGENT_SESSION_KEY;
    delete process.env.AGENT_HQ_MCP_API_KEY_AGENT_SLUG;
    delete process.env.AGENT_HQ_MCP_API_KEY_GLOBAL_ADMIN;
    initSchema();
  });

  afterEach(() => {
    closeDb();
    restoreEnv('AGENT_HQ_DB_PATH', ORIGINAL_DB_PATH);
    restoreEnv('AGENT_HQ_MCP_API_KEY', ORIGINAL_MCP_API_KEY);
    restoreEnv('AGENT_HQ_MCP_API_KEY_AGENT_ID', ORIGINAL_MCP_API_KEY_AGENT_ID);
    restoreEnv('AGENT_HQ_MCP_API_KEY_AGENT_OPENCLAW_ID', ORIGINAL_MCP_API_KEY_AGENT_OPENCLAW_ID);
    restoreEnv('AGENT_HQ_MCP_API_KEY_AGENT_SESSION_KEY', ORIGINAL_MCP_API_KEY_AGENT_SESSION_KEY);
    restoreEnv('AGENT_HQ_MCP_API_KEY_AGENT_SLUG', ORIGINAL_MCP_API_KEY_AGENT_SLUG);
    restoreEnv('AGENT_HQ_MCP_API_KEY_GLOBAL_ADMIN', ORIGINAL_MCP_API_KEY_GLOBAL_ADMIN);
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not materialize configured runtime keys during schema startup', () => {
    process.env.AGENT_HQ_MCP_API_KEY = 'ahq_mcp_runtime_bootstrap_test';

    initSchema();

    expect(getDb().prepare(`SELECT COUNT(*) AS count FROM mcp_api_keys`).get()).toEqual({ count: 0 });
  });

  it('materializes a configured runtime key against Atlas when the key is missing from the current DB', () => {
    process.env.AGENT_HQ_MCP_API_KEY = 'ahq_mcp_runtime_bootstrap_test';

    const result = ensureConfiguredRuntimeMcpApiKey();
    const identity = resolveMcpApiIdentityForKey(getDb(), process.env.AGENT_HQ_MCP_API_KEY!, { updateLastUsed: false });

    expect(result).toMatchObject({
      status: 'created',
      agentId: identity.agentId,
      keyPrefix: 'ahq_mcp_runtime_',
    });
    expect(identity.agentSlug).toBe('atlas');
    expect(identity.tenantId).toBe(1);
    expect(identity.globalAdminAccess).toBe(false);
  });

  it('materializes configured runtime keys as global only when explicitly requested', () => {
    process.env.AGENT_HQ_MCP_API_KEY = 'ahq_mcp_runtime_global_bootstrap_test';
    process.env.AGENT_HQ_MCP_API_KEY_GLOBAL_ADMIN = 'true';

    const result = ensureConfiguredRuntimeMcpApiKey();
    const identity = resolveMcpApiIdentityForKey(getDb(), process.env.AGENT_HQ_MCP_API_KEY!, { updateLastUsed: false });

    expect(result).toMatchObject({ status: 'created', agentId: identity.agentId });
    expect(identity.agentSlug).toBe('atlas');
    expect(identity.tenantId).toBe(1);
    expect(identity.globalAdminAccess).toBe(true);
  });

  it('uses the configured runtime agent selector and reuses the same key on later boots', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO agents (id, tenant_id, name, role, session_key, workspace_path, openclaw_agent_id, status)
      VALUES (410, 1, 'Cinder (Backend)', 'Backend Engineer', 'agent:agent-hq:cinder-backend:backend-engineer:main', '', 'cinder-backend', 'idle')
    `).run();

    process.env.AGENT_HQ_MCP_API_KEY = 'ahq_mcp_runtime_cinder_test';
    process.env.AGENT_HQ_MCP_API_KEY_AGENT_OPENCLAW_ID = 'cinder-backend';

    const first = ensureConfiguredRuntimeMcpApiKey();
    const second = ensureConfiguredRuntimeMcpApiKey();
    const identity = resolveMcpApiIdentityForKey(getDb(), process.env.AGENT_HQ_MCP_API_KEY!, { updateLastUsed: false });

    expect(first).toMatchObject({ status: 'created', agentId: 410, keyPrefix: 'ahq_mcp_runtime_' });
    expect(second).toMatchObject({ status: 'reused', agentId: 410, keyId: first.keyId, keyPrefix: 'ahq_mcp_runtime_' });
    expect(identity.agentId).toBe(410);
    expect(identity.agentSlug).toBe('cinder-backend');
  });
});
