import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import { resolveWorkflowEventMapping, type ExternalEventMapping } from '../domains/routing/externalEventMappings';
import { listSprintTaskRoutingRules, loadSprintTaskTransitionRequirements, resolveSprintTaskRoutingAssignment, resolveSprintTaskTransition, seedSprintTaskPolicy, seedSprintTypeTaskStatuses } from '../domains/routing/policy';
import { authenticateMcpApiKeyIfPresent, authorizeMcpApiRequestIfPresent, issueMcpApiKeyForAgent, replaceAgentMcpPermissionPolicy } from '../lib/mcpApiAuth';
import routingRouter from './routing';

let tempDir: string;
let dbPath: string;
const originalContractRoot = process.env.AGENT_CONTRACT_ROOT;
const originalDbPath = process.env.AGENT_HQ_DB_PATH;

async function resetDb(): Promise<void> {
  closeDb();
  jest.resetModules();
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-rules-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');
  process.env.AGENT_HQ_DB_PATH = dbPath;
  process.env.AGENT_CONTRACT_ROOT = path.join(tempDir, 'agent-contracts');
  fs.mkdirSync(process.env.AGENT_CONTRACT_ROOT, { recursive: true });
  fs.writeFileSync(path.join(process.env.AGENT_CONTRACT_ROOT, 'generic.md'), 'Sprint type: {{sprintType}}\n');
  fs.writeFileSync(path.join(process.env.AGENT_CONTRACT_ROOT, 'bugs.md'), '## Agent HQ bug-fix contract for this dispatched instance\nREQUIRED OUTPUTS FOR BUGS\n');
  fs.writeFileSync(path.join(process.env.AGENT_CONTRACT_ROOT, 'enhancements.md'), '## Agent HQ enhancement contract for this dispatched instance\nREQUIRED OUTPUTS FOR ENHANCEMENTS\n');

  const db = getDb();
  await db.exec(`
    CREATE TABLE task_statuses (
      name TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'slate',
      terminal INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      allowed_transitions TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE sprints (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sprint_type TEXT NOT NULL DEFAULT 'generic',
      task_policy_seeded_at TEXT
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
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      job_title TEXT,
      project_id INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER,
      project_id INTEGER,
      status TEXT,
      task_type TEXT,
      story_points INTEGER,
      active_instance_id INTEGER
    );
    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER,
      task_id INTEGER,
      agent_id INTEGER,
      status TEXT
    );
    CREATE TABLE sprint_type_task_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key TEXT NOT NULL,
      task_type TEXT NOT NULL,
      is_system INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(sprint_type_key, task_type)
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
    CREATE TABLE task_field_schemas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key TEXT NOT NULL,
      task_type TEXT,
      schema_json TEXT NOT NULL DEFAULT '{}',
      is_system INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sprint_task_routing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER,
      project_id INTEGER,
      sprint_type TEXT,
      task_type TEXT,
      status TEXT NOT NULL,
      agent_id INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    CREATE TABLE sprint_task_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER,
      project_id INTEGER,
      sprint_type TEXT,
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
      sprint_id INTEGER,
      project_id INTEGER,
      sprint_type TEXT,
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
    CREATE TABLE sprint_task_transition_requirement_tombstones (
      sprint_id INTEGER NOT NULL,
      task_type_key TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL,
      field_name TEXT NOT NULL,
      requirement_type TEXT NOT NULL,
      match_field_key TEXT NOT NULL DEFAULT '',
      deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (sprint_id, task_type_key, outcome, field_name, requirement_type, match_field_key)
    );
    CREATE TABLE routing_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      task_type TEXT,
      from_status TEXT NOT NULL,
      outcome TEXT NOT NULL,
      to_status TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      is_protected INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE external_event_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      source TEXT,
      event_name TEXT NOT NULL,
      task_type TEXT,
      status_includes_json TEXT NOT NULL DEFAULT '[]',
      status_excludes_json TEXT NOT NULL DEFAULT '[]',
      action_kind TEXT NOT NULL,
      action_target TEXT,
      apply_review_evidence INTEGER NOT NULL DEFAULT 0,
      apply_failure_detail INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await db.run(`
    INSERT INTO task_statuses (name, label, color, terminal, is_system, allowed_transitions)
    VALUES
      ('todo', 'To Do', 'slate', 0, 1, '["ready","cancelled"]'),
      ('ready', 'Ready', 'blue', 0, 1, '["in_progress","cancelled"]'),
      ('in_progress', 'In Progress', 'yellow', 0, 1, '["dev_deploy_queued","review","stalled","cancelled"]'),
      ('dev_deploy_queued', 'Dev Deploy Queued', 'amber', 0, 1, '["dev_deploying","review","blocked","failed","cancelled"]'),
      ('dev_deploying', 'Dev Deploying', 'cyan', 0, 1, '["review","dev_deploy_queued","blocked","failed","cancelled"]'),
      ('blocked', 'Blocked', 'rose', 0, 1, '["ready","in_progress","dev_deploy_queued","review","cancelled","failed"]'),
      ('review', 'Review', 'purple', 0, 1, '["ready_to_merge","ready","stalled","failed","cancelled"]'),
      ('ready_to_merge', 'Ready to Merge', 'cyan', 0, 1, '["deployed","ready","failed"]'),
      ('deployed', 'Deployed', 'green', 0, 1, '["done","ready","failed"]'),
      ('stalled', 'Stalled', 'orange', 0, 1, '["ready","cancelled"]'),
      ('needs_attention', 'Needs Attention', 'amber', 0, 1, '["todo","ready","in_progress","dev_deploy_queued","dev_deploying","review","ready_to_merge","deployed","done","cancelled","failed","stalled","blocked"]'),
      ('done', 'Done', 'green', 1, 1, '["todo"]'),
      ('cancelled', 'Cancelled', 'red', 1, 1, '["todo"]'),
      ('failed', 'Failed', 'red', 1, 1, '["todo","ready"]')
  `);
  await db.run(`INSERT INTO projects (id, name) VALUES (1, 'Agent HQ'), (2, 'Other Project')`);
  await db.run(`INSERT INTO sprint_types (key, name, is_system) VALUES ('generic', 'Generic', 1), ('bugs', 'Bugs', 1), ('enhancements', 'Enhancements', 1), ('dev', 'Development', 1)`);
  await db.run(`INSERT INTO sprints (id, project_id, name, sprint_type) VALUES (10, 1, 'Bugs', 'bugs')`);
  await db.run(`INSERT INTO sprint_type_task_types (sprint_type_key, task_type) VALUES ('bugs', 'backend'), ('bugs', 'qa')`);
  await db.run(`
    INSERT INTO task_field_schemas (sprint_type_key, task_type, schema_json)
    VALUES ('bugs', NULL, ?)
  `, JSON.stringify({
        fields: [
          { key: 'review_branch', label: 'Review Branch', type: 'text', source: 'task_column', gate_requirement: true },
          { key: 'review_commit', label: 'Review Commit', type: 'text', source: 'task_column', gate_requirement: true },
          { key: 'status', label: 'Status', type: 'text', source: 'task_column', gate_requirement: true },
          { key: 'reproduction_steps', label: 'Reproduction Steps', type: 'textarea', source: 'custom_fields', gate_requirement: false },
        ],
      }));
  await db.run(`INSERT INTO agents (id, name, job_title, project_id, enabled) VALUES (7, 'Cinder', 'Backend Engineer', 1, 1), (8, 'Other', 'Other Engineer', 2, 1)`);
  await db.exec(`
    CREATE TABLE system_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_key TEXT NOT NULL UNIQUE,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      trigger_event TEXT NOT NULL,
      classification TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      threshold_seconds INTEGER,
      description TEXT,
      source_file TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}


function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', authenticateMcpApiKeyIfPresent);
  app.use('/api/v1', authorizeMcpApiRequestIfPresent);
  app.use('/api/v1/routing', routingRouter);

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

describe('routing rules API', () => {
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

  it('keeps task routing rules, transitions, and requirements scoped to the active tenant', async () => {
    const tenantContext = await import('../lib/tenantContext');
    const db = getDb();
    const defaultTenantId = tenantContext.ensureTenantSchema(db);
    const betaTenantId = Number((await db.run(`
      INSERT INTO tenants (name, slug, is_default)
      VALUES ('Beta Company', 'beta-company', 0)
    `)).lastInsertId);
    await db.run(`UPDATE projects SET tenant_id = ? WHERE id = 2`, betaTenantId);
    await db.run(`UPDATE sprints SET tenant_id = ? WHERE id = 10`, defaultTenantId);
    await db.run(`INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type) VALUES (20, ?, 2, 'Beta Bugs', 'bugs')`, betaTenantId);
    await db.run(`UPDATE agents SET tenant_id = ? WHERE id = 8`, betaTenantId);

    await db.run(`
      INSERT INTO sprint_task_routing_rules (tenant_id, project_id, sprint_type, sprint_id, task_type, status, agent_id, priority)
      VALUES (?, 2, 'bugs', NULL, 'backend', 'ready', 8, 50)
    `, betaTenantId);
    const betaRuleId = Number((await db.get(`SELECT id FROM sprint_task_routing_rules WHERE tenant_id = ?`, betaTenantId) as { id: number }).id);
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, project_id, sprint_type, sprint_id, task_type, from_status, outcome, to_status, priority)
      VALUES (?, 2, 'bugs', NULL, 'backend', 'ready', 'start_beta', 'in_progress', 10)
    `, betaTenantId);
    const betaTransitionId = Number((await db.get(`SELECT id FROM sprint_task_transitions WHERE tenant_id = ?`, betaTenantId) as { id: number }).id);
    await db.run(`
      INSERT INTO sprint_task_transition_requirements (tenant_id, project_id, sprint_type, sprint_id, task_type, outcome, field_name, requirement_type, severity, message, priority)
      VALUES (?, 2, 'bugs', NULL, 'backend', 'start_beta', 'review_commit', 'required', 'block', 'Beta only', 10)
    `, betaTenantId);
    const betaRequirementId = Number((await db.get(`SELECT id FROM sprint_task_transition_requirements WHERE tenant_id = ?`, betaTenantId) as { id: number }).id);

    const { server, baseUrl } = await startTestServer();
    try {
      await db.run(`UPDATE app_settings SET value = ? WHERE key = 'active_tenant_id'`, String(defaultTenantId));

      const alphaRules = await fetch(`${baseUrl}/api/v1/routing/rules?project_id=1&sprint_id=10`);
      expect(alphaRules.status).toBe(200);
      await expect(alphaRules.json()).resolves.toEqual(expect.objectContaining({ rules: [] }));

      await expect(fetch(`${baseUrl}/api/v1/routing/rules/${betaRuleId}?project_id=1&sprint_id=10`)).resolves.toMatchObject({ status: 404 });
      await expect(fetch(`${baseUrl}/api/v1/routing/rules/${betaRuleId}?project_id=1&sprint_id=20`)).resolves.toMatchObject({ status: 404 });
      await expect(fetch(`${baseUrl}/api/v1/routing/transitions/${betaTransitionId}?project_id=1&sprint_id=10`)).resolves.toMatchObject({ status: 404 });
      await expect(fetch(`${baseUrl}/api/v1/routing/transition-requirements/${betaRequirementId}?project_id=1&sprint_id=10`)).resolves.toMatchObject({ status: 404 });

      const alphaResolve = await fetch(`${baseUrl}/api/v1/routing/rules/resolve?sprint_id=10&task_type=backend&status=ready`);
      expect(alphaResolve.status).toBe(200);
      await expect(alphaResolve.json()).resolves.toEqual(expect.objectContaining({ matched: false }));
      expect(await resolveSprintTaskRoutingAssignment(db, 10, 'backend', 'ready')).toEqual({ agent_id: null });

      const alphaCreateForeign = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 2, sprint_id: 20, sprint_type: 'bugs', task_type: 'backend', status: 'ready', agent_id: 8 }),
      });
      expect(alphaCreateForeign.status).toBe(404);

      await db.run(`UPDATE app_settings SET value = ? WHERE key = 'active_tenant_id'`, String(betaTenantId));
      const betaRules = await fetch(`${baseUrl}/api/v1/routing/rules?project_id=2&sprint_id=20`);
      expect(betaRules.status).toBe(200);
      const betaRulesBody = await betaRules.json() as { rules: Array<{ id: number; tenant_id: number; agent_id: number }> };
      expect(betaRulesBody.rules).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: betaRuleId, tenant_id: betaTenantId, agent_id: 8 }),
      ]));

      const betaRequirements = await fetch(`${baseUrl}/api/v1/routing/transition-requirements?project_id=2&sprint_id=20&outcome=start_beta`);
      expect(betaRequirements.status).toBe(200);
      await expect(betaRequirements.json()).resolves.toEqual(expect.objectContaining({
        transition_requirements: [expect.objectContaining({ id: betaRequirementId, tenant_id: betaTenantId })],
      }));
      expect(await resolveSprintTaskRoutingAssignment(db, 20, 'backend', 'ready')).toEqual({ agent_id: 8 });
    } finally {
      await stopTestServer(server);
    }
  });

  it('allows only super-admin MCP keys to select tenant-scoped routing admin config', async () => {
    const tenantContext = await import('../lib/tenantContext');
    const db = getDb();
    const defaultTenantId = tenantContext.ensureTenantSchema(db);
    const betaTenantId = Number((await db.run(`
      INSERT INTO tenants (name, slug, is_default)
      VALUES ('Beta Company', 'beta-company', 0)
    `)).lastInsertId);
    await db.run(`UPDATE projects SET tenant_id = ? WHERE id = 2`, betaTenantId);
    await db.run(`INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type) VALUES (20, ?, 2, 'Beta Bugs', 'bugs')`, betaTenantId);
    await db.run(`UPDATE agents SET tenant_id = ? WHERE id = 8`, betaTenantId);

    await db.run(`
      INSERT INTO sprint_task_routing_rules (tenant_id, project_id, sprint_type, sprint_id, task_type, status, agent_id, priority)
      VALUES (?, 2, 'bugs', NULL, 'backend', 'ready', 8, 50)
    `, betaTenantId);
    const betaRuleId = Number((await db.get(`SELECT id FROM sprint_task_routing_rules WHERE tenant_id = ?`, betaTenantId) as { id: number }).id);
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, project_id, sprint_type, sprint_id, task_type, from_status, outcome, to_status, priority)
      VALUES (?, 2, 'bugs', NULL, 'backend', 'ready', 'start_beta', 'in_progress', 10)
    `, betaTenantId);
    const betaTransitionId = Number((await db.get(`SELECT id FROM sprint_task_transitions WHERE tenant_id = ?`, betaTenantId) as { id: number }).id);
    await db.run(`
      INSERT INTO sprint_task_transition_requirements (tenant_id, project_id, sprint_type, sprint_id, task_type, outcome, field_name, requirement_type, severity, message, priority)
      VALUES (?, 2, 'bugs', NULL, 'backend', 'start_beta', 'review_commit', 'required', 'block', 'Beta only', 10)
    `, betaTenantId);
    const betaRequirementId = Number((await db.get(`SELECT id FROM sprint_task_transition_requirements WHERE tenant_id = ?`, betaTenantId) as { id: number }).id);

    await db.run(`INSERT INTO agents (id, tenant_id, name, job_title, project_id, enabled) VALUES (9, ?, 'Super Admin', 'Backend Engineer', 1, 1)`, defaultTenantId);
    const regularKey = (await issueMcpApiKeyForAgent(db, 7, 'regular tenant key')).apiKey;
    const superAdminKey = (await issueMcpApiKeyForAgent(db, 9, 'super-admin tenant selector key')).apiKey;
    await replaceAgentMcpPermissionPolicy(db, 9, ['admin.full_access', 'admin.cross_tenant']);
    await db.run(`UPDATE app_settings SET value = ? WHERE key = 'active_tenant_id'`, String(defaultTenantId));

    const { server, baseUrl } = await startTestServer();
    try {
      const browserSelector = await fetch(`${baseUrl}/api/v1/routing/rules?tenant_id=${betaTenantId}&project_id=2&sprint_id=20`);
      expect(browserSelector.status).toBe(400);
      await expect(browserSelector.json()).resolves.toMatchObject({
        error: 'Explicit tenant selectors are not allowed for this request context',
      });

      const regularSelector = await fetch(`${baseUrl}/api/v1/routing/rules?tenant_id=${betaTenantId}&project_id=2&sprint_id=20`, {
        headers: { Authorization: `Bearer ${regularKey}`, 'x-agent-hq-mcp-client': 'agent-hq-mcp' },
      });
      expect(regularSelector.status).toBe(403);
      await expect(regularSelector.json()).resolves.toMatchObject({
        code: 'mcp_tenant_scope_denied',
        details: {
          key_tenant_id: defaultTenantId,
          requested_tenant_id: betaTenantId,
          required_capability: 'admin.cross_tenant',
        },
      });

      const authHeaders = { Authorization: `Bearer ${superAdminKey}`, 'x-agent-hq-mcp-client': 'agent-hq-mcp' };
      const rules = await fetch(`${baseUrl}/api/v1/routing/rules?tenant_id=${betaTenantId}&project_id=2&sprint_id=20`, { headers: authHeaders });
      const rulesBody = await rules.json();
      expect({ status: rules.status, body: rulesBody }).toEqual({
        status: 200,
        body: expect.objectContaining({
          rules: expect.arrayContaining([expect.objectContaining({ id: betaRuleId, tenant_id: betaTenantId })]),
        }),
      });

      const transitions = await fetch(`${baseUrl}/api/v1/routing/transitions?tenant_id=${betaTenantId}&project_id=2&sprint_id=20`, { headers: authHeaders });
      expect(transitions.status).toBe(200);
      await expect(transitions.json()).resolves.toEqual(expect.objectContaining({
        transitions: expect.arrayContaining([expect.objectContaining({ id: betaTransitionId, project_id: 2, sprint_type: 'bugs' })]),
      }));

      const requirements = await fetch(`${baseUrl}/api/v1/routing/transition-requirements?tenant_id=${betaTenantId}&project_id=2&sprint_id=20&outcome=start_beta`, { headers: authHeaders });
      expect(requirements.status).toBe(200);
      await expect(requirements.json()).resolves.toEqual(expect.objectContaining({
        transition_requirements: expect.arrayContaining([expect.objectContaining({ id: betaRequirementId, tenant_id: betaTenantId })]),
      }));
    } finally {
      await stopTestServer(server);
    }
  });


  it('creates sprint-type default routing rules without requiring sprint_id', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_type: 'backend', status: 'ready', agent_id: 7, project_id: 1, sprint_type: 'bugs' }),
      });

      const body = await response.json() as { id: number };
      if (response.status !== 201) {
        throw new Error(`Expected 201, received ${response.status}: ${JSON.stringify(body)}`);
      }
      expect(body).toEqual(expect.objectContaining({
        project_id: 1,
        sprint_type: 'bugs',
        sprint_id: null,
        scope_kind: 'sprint_type_default',
        task_type: 'backend',
        status: 'ready',
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('creates, lists, reads, updates, resolves, and deletes assignment rules through alias routes', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const createResponse = await fetch(`${baseUrl}/api/v1/routing/assignment-rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_type: 'backend', status: 'ready', agent_id: 7, project_id: 1, sprint_type: 'bugs' }),
      });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as { id: number; agent_id: number; task_type: string; status: string };
      expect(created).toEqual(expect.objectContaining({
        agent_id: 7,
        task_type: 'backend',
        status: 'ready',
      }));

      const listResponse = await fetch(`${baseUrl}/api/v1/routing/assignment-rules?project_id=1&sprint_type=bugs`);
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toEqual(expect.objectContaining({
        rules: expect.arrayContaining([expect.objectContaining({ id: created.id, agent_id: 7 })]),
      }));

      const readResponse = await fetch(`${baseUrl}/api/v1/routing/assignment-rules/${created.id}?project_id=1&sprint_type=bugs`);
      expect(readResponse.status).toBe(200);
      await expect(readResponse.json()).resolves.toEqual(expect.objectContaining({ id: created.id, agent_id: 7 }));

      const updateResponse = await fetch(`${baseUrl}/api/v1/routing/assignment-rules/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', task_type: 'backend', status: 'ready', agent_id: 7, priority: 42 }),
      });
      expect(updateResponse.status).toBe(200);
      await expect(updateResponse.json()).resolves.toEqual(expect.objectContaining({ id: created.id, priority: 42 }));

      const resolveResponse = await fetch(`${baseUrl}/api/v1/routing/assignment-rules/resolve?sprint_id=10&task_type=backend&status=ready`);
      expect(resolveResponse.status).toBe(200);
      await expect(resolveResponse.json()).resolves.toEqual(expect.objectContaining({ rule: expect.objectContaining({ id: created.id, priority: 42 }) }));

      const deleteResponse = await fetch(`${baseUrl}/api/v1/routing/assignment-rules/${created.id}?project_id=1&sprint_type=bugs`, { method: 'DELETE' });
      expect(deleteResponse.status).toBe(200);
      await expect(deleteResponse.json()).resolves.toEqual(expect.objectContaining({ ok: true }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('previews high-blast-radius config writes without persisting rows', async () => {
    const db = getDb();
    const before = {
      rules: (await db.get('SELECT COUNT(*) AS count FROM sprint_task_routing_rules') as { count: number }).count,
      transitions: (await db.get('SELECT COUNT(*) AS count FROM sprint_task_transitions') as { count: number }).count,
      requirements: (await db.get('SELECT COUNT(*) AS count FROM sprint_task_transition_requirements') as { count: number }).count,
      mappings: (await db.get('SELECT COUNT(*) AS count FROM external_event_mappings') as { count: number }).count,
    };
    const { server, baseUrl } = await startTestServer();
    try {
      const requests = [
        fetch(`${baseUrl}/api/v1/routing/rules`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dry_run: true, task_type: 'backend', status: 'ready', agent_id: 7, project_id: 1, sprint_type: 'bugs' }),
        }),
        fetch(`${baseUrl}/api/v1/routing/transitions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dry_run: true, project_id: 1, sprint_type: 'bugs', from_status: 'ready', outcome: 'start_work', to_status: 'in_progress' }),
        }),
        fetch(`${baseUrl}/api/v1/routing/transition-requirements`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dry_run: true, project_id: 1, sprint_type: 'bugs', outcome: 'completed_for_review', field_name: 'review_commit' }),
        }),
        fetch(`${baseUrl}/api/v1/routing/workflow-event-mappings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dry_run: true, project_id: 1, source: 'agent_hq_runtime', event_name: 'agent_started', task_type: 'backend', action_kind: 'status', action_target: 'in_progress' }),
        }),
      ];

      const responses = await Promise.all(requests);
      for (const response of responses) {
        expect(response.status).toBe(200);
        const body = await response.json() as { dry_run?: boolean; preview?: { affected?: unknown } };
        expect(body.dry_run).toBe(true);
        expect(body.preview?.affected).toBeTruthy();
      }

      expect((await db.get('SELECT COUNT(*) AS count FROM sprint_task_routing_rules') as { count: number }).count).toBe(before.rules);
      expect((await db.get('SELECT COUNT(*) AS count FROM sprint_task_transitions') as { count: number }).count).toBe(before.transitions);
      expect((await db.get('SELECT COUNT(*) AS count FROM sprint_task_transition_requirements') as { count: number }).count).toBe(before.requirements);
      expect((await db.get('SELECT COUNT(*) AS count FROM external_event_mappings') as { count: number }).count).toBe(before.mappings);
    } finally {
      await stopTestServer(server);
    }
  });

  it('creates and lists all-project sprint-type default routing rules', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_type: 'backend', status: 'ready', agent_id: 7, sprint_type: 'bugs' }),
      });

      const body = await response.json() as { id: number };
      if (response.status !== 201) {
        throw new Error(`Expected 201, received ${response.status}: ${JSON.stringify(body)}`);
      }
      expect(body).toEqual(expect.objectContaining({
        project_id: null,
        sprint_type: 'bugs',
        sprint_id: null,
        scope_kind: 'sprint_type_default',
        task_type: 'backend',
        status: 'ready',
      }));

      const scopedProjectResponse = await fetch(`${baseUrl}/api/v1/routing/rules?project_id=1&sprint_type=bugs`);
      expect(scopedProjectResponse.status).toBe(200);
      const scopedProjectBody = await scopedProjectResponse.json() as { rules: Array<{ id: number }> };
      expect(scopedProjectBody.rules.some(rule => rule.id === body.id)).toBe(false);

      const allProjectsResponse = await fetch(`${baseUrl}/api/v1/routing/rules?sprint_type=bugs`);
      expect(allProjectsResponse.status).toBe(200);
      await expect(allProjectsResponse.json()).resolves.toEqual(expect.objectContaining({
        rules: expect.arrayContaining([expect.objectContaining({ id: body.id, project_id: null, sprint_type: 'bugs', scope_kind: 'sprint_type_default' })]),
        scope: expect.objectContaining({ project_id: null, sprint_type: 'bugs', sprint_id: null }),
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('accepts workflow_type aliases for workflow-type default routing rules', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_type: 'backend', status: 'ready', agent_id: 7, workflow_type: 'bugs' }),
      });

      const body = await response.json() as { id: number };
      if (response.status !== 201) {
        throw new Error(`Expected 201, received ${response.status}: ${JSON.stringify(body)}`);
      }
      expect(body).toEqual(expect.objectContaining({
        project_id: null,
        sprint_type: 'bugs',
        sprint_id: null,
        scope_kind: 'sprint_type_default',
      }));

      const listResponse = await fetch(`${baseUrl}/api/v1/routing/rules?workflow_type=bugs`);
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toEqual(expect.objectContaining({
        rules: expect.arrayContaining([expect.objectContaining({ id: body.id, sprint_type: 'bugs', scope_kind: 'sprint_type_default' })]),
        scope: expect.objectContaining({ project_id: null, sprint_type: 'bugs', sprint_id: null }),
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('resolves all-project routing defaults when a project-specific rule is not configured', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`INSERT INTO sprints (id, project_id, name, sprint_type) VALUES (56, 2, 'Other Bugs', 'bugs')`);

      await db.run(`
        INSERT INTO sprint_task_routing_rules (project_id, sprint_type, sprint_id, task_type, status, agent_id, priority, is_system)
        VALUES (NULL, 'bugs', NULL, 'backend', 'ready', 7, 0, 0)
      `);

      const resolveResponse = await fetch(`${baseUrl}/api/v1/routing/rules/resolve?sprint_id=56&task_type=backend&status=ready`);
      expect(resolveResponse.status).toBe(200);
      await expect(resolveResponse.json()).resolves.toEqual(expect.objectContaining({
        matched: true,
        rule: expect.objectContaining({ project_id: null, sprint_id: null, sprint_type: 'bugs', agent_id: 7, scope_kind: 'sprint_type_default' }),
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('creates Development sprint-type defaults without any existing sprint_id and resolves them for later matching sprints', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`INSERT INTO sprint_type_task_types (sprint_type_key, task_type) VALUES ('dev', 'backend')`);

      const response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'dev', task_type: 'backend', status: 'ready', agent_id: 7, scope_kind: 'sprint_type_default' }),
      });

      const body = await response.json();
      if (response.status !== 201) {
        throw new Error(`Expected 201, received ${response.status}: ${JSON.stringify(body)}`);
      }
      expect(body).toEqual(expect.objectContaining({
        project_id: 1,
        sprint_type: 'dev',
        sprint_id: null,
        scope_kind: 'sprint_type_default',
        task_type: 'backend',
        status: 'ready',
      }));

      const listResponse = await fetch(`${baseUrl}/api/v1/routing/rules?project_id=1&sprint_type=dev`);
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toEqual(expect.objectContaining({
        rules: expect.arrayContaining([expect.objectContaining({ sprint_id: null, sprint_type: 'dev', scope_kind: 'sprint_type_default' })]),
        scope: expect.objectContaining({ project_id: 1, sprint_type: 'dev', sprint_id: null }),
      }));

      await db.run(`INSERT INTO sprints (id, project_id, name, sprint_type) VALUES (56, 1, 'Development', 'dev')`);
      const resolveResponse = await fetch(`${baseUrl}/api/v1/routing/rules/resolve?sprint_id=56&task_type=backend&status=ready`);
      expect(resolveResponse.status).toBe(200);
      await expect(resolveResponse.json()).resolves.toEqual(expect.objectContaining({
        matched: true,
        rule: expect.objectContaining({ sprint_id: null, sprint_type: 'dev', agent_id: 7, scope_kind: 'sprint_type_default' }),
        candidates: [expect.objectContaining({ sprint_id: null, sprint_type: 'dev', agent_id: 7, scope_kind: 'sprint_type_default' })],
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('requires sprint_id when creating an explicit sprint override routing rule', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', task_type: 'backend', status: 'ready', agent_id: 7, scope_kind: 'sprint_override' }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'sprint_id is required for sprint-specific routing rules' });
    } finally {
      await stopTestServer(server);
    }
  });


  it('creates all-task-types routing rules with null task_type scope', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_type: null, status: 'ready', agent_id: 7, project_id: 1, sprint_type: 'bugs' }),
      });

      const body = await response.json();
      if (response.status !== 201) {
        throw new Error(`Expected 201, received ${response.status}: ${JSON.stringify(body)}`);
      }
      expect(body).toEqual(expect.objectContaining({
        project_id: 1,
        sprint_type: 'bugs',
        sprint_id: null,
        scope_kind: 'sprint_type_default',
        task_type: null,
        status: 'ready',
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('prefers specific task-type routing over all-task-types routing at the same scope', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      let response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', task_type: null, status: 'ready', agent_id: 7, priority: 5 }),
      });
      expect(response.status).toBe(201);

      const db = getDb();
      await db.run(`INSERT INTO agents (id, name, job_title, project_id, enabled) VALUES (9, 'Specific Agent', 'Backend Engineer', 1, 1)`);
      response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', task_type: 'backend', status: 'ready', agent_id: 9, priority: 1 }),
      });
      expect(response.status).toBe(201);

      const resolveResponse = await fetch(`${baseUrl}/api/v1/routing/rules/resolve?sprint_id=10&task_type=backend&status=ready`);
      expect(resolveResponse.status).toBe(200);
      await expect(resolveResponse.json()).resolves.toEqual(expect.objectContaining({
        matched: true,
        rule: expect.objectContaining({ sprint_id: null, task_type: 'backend', agent_id: 9, scope_kind: 'sprint_type_default' }),
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('prefers sprint overrides over sprint-type defaults even when both are all-task-types rules', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      let response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', task_type: null, status: 'ready', agent_id: 7, priority: 5 }),
      });
      expect(response.status).toBe(201);

      const db = getDb();
      await db.run(`INSERT INTO agents (id, name, job_title, project_id, enabled) VALUES (9, 'Override Agent', 'Backend Engineer', 1, 1)`);
      response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', sprint_id: 10, task_type: null, status: 'ready', agent_id: 9, priority: 10 }),
      });
      expect(response.status).toBe(201);

      const resolveResponse = await fetch(`${baseUrl}/api/v1/routing/rules/resolve?sprint_id=10&task_type=qa&status=ready`);
      expect(resolveResponse.status).toBe(200);
      await expect(resolveResponse.json()).resolves.toEqual(expect.objectContaining({
        matched: true,
        rule: expect.objectContaining({ sprint_id: 10, task_type: null, agent_id: 9, scope_kind: 'sprint_override' }),
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('accepts workflow_id aliases for workflow override routing rules and resolution', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`INSERT INTO agents (id, name, job_title, project_id, enabled) VALUES (9, 'Override Agent', 'Backend Engineer', 1, 1)`);
      const response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, workflow_type: 'bugs', workflow_id: 10, task_type: null, status: 'ready', agent_id: 9, priority: 10 }),
      });
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual(expect.objectContaining({
        sprint_id: 10,
        sprint_type: 'bugs',
        scope_kind: 'sprint_override',
      }));

      const resolveResponse = await fetch(`${baseUrl}/api/v1/routing/rules/resolve?workflow_id=10&task_type=qa&status=ready`);
      expect(resolveResponse.status).toBe(200);
      await expect(resolveResponse.json()).resolves.toEqual(expect.objectContaining({
        matched: true,
        rule: expect.objectContaining({ sprint_id: 10, task_type: null, agent_id: 9, scope_kind: 'sprint_override' }),
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('lists all-task-types routing rules with an explicit null task_type scope', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', task_type: null, status: 'ready', agent_id: 7, priority: 5 }),
      });
      expect(response.status).toBe(201);

      const listResponse = await fetch(`${baseUrl}/api/v1/routing/rules?project_id=1&sprint_type=bugs`);
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toEqual({
        rules: expect.arrayContaining([
          expect.objectContaining({
            project_id: 1,
            sprint_type: 'bugs',
            sprint_id: null,
            task_type: null,
            status: 'ready',
            scope_kind: 'sprint_type_default',
          }),
        ]),
        scope: expect.objectContaining({ project_id: 1, sprint_type: 'bugs', sprint_id: null }),
      });
    } finally {
      await stopTestServer(server);
    }
  });

  it('accepts wildcard task_type aliases when creating all-task-types routing rules', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', task_type: 'all-task-types', status: 'ready', agent_id: 7, priority: 5 }),
      });

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual(expect.objectContaining({
        project_id: 1,
        sprint_type: 'bugs',
        sprint_id: null,
        task_type: null,
        status: 'ready',
        scope_kind: 'sprint_type_default',
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects creating a routing rule without sprint scope metadata', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_type: 'backend', status: 'ready', agent_id: 7, project_id: 1 }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'sprint_type is required when sprint_id is not provided' });
    } finally {
      await stopTestServer(server);
    }
  });

  it('lists transition requirement fields from the sprint field schema', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/routing/transition-requirement-fields?sprint_id=10`);
      expect(response.status).toBe(200);
      const body = await response.json() as { field_names: string[] };
      expect(body.field_names).toEqual(['review_branch', 'review_commit', 'status', 'reproduction_steps']);
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects sprint transition requirements for fields outside the sprint schema gate fields', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/routing/transition-requirements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sprint_id: 10,
          outcome: 'completed_for_review',
          field_name: 'qa_verified_commit',
          requirement_type: 'required',
        }),
      });
      expect(response.status).toBe(400);
      const body = await response.json() as { error: string };
      expect(body.error).toContain('not defined for sprint type "bugs"');
    } finally {
      await stopTestServer(server);
    }
  });

  it('does not restore a deleted seeded sprint transition requirement on the next list read', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`INSERT INTO sprints (id, project_id, name, sprint_type) VALUES (11, 1, 'Dev', 'dev')`);

      const createResponse = await fetch(`${baseUrl}/api/v1/routing/transition-requirements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: 1,
          sprint_type: 'dev',
          sprint_id: 11,
          outcome: 'completed_for_review',
          field_name: 'review_branch',
          requirement_type: 'required',
          severity: 'block',
          message: 'review_branch is required',
          enabled: true,
          priority: 100,
        }),
      });
      expect(createResponse.status).toBe(201);
      const seeded = await createResponse.json() as { id: number };

      const updateResponse = await fetch(`${baseUrl}/api/v1/routing/transition-requirements/${seeded.id}?project_id=1&sprint_type=dev&sprint_id=11`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      expect(updateResponse.status).toBe(200);

      const afterDeleteResponse = await fetch(`${baseUrl}/api/v1/routing/transition-requirements?project_id=1&sprint_type=dev&sprint_id=11`);
      expect(afterDeleteResponse.status).toBe(200);
      const afterDeleteBody = await afterDeleteResponse.json() as {
        transition_requirements: Array<{
          id: number;
          sprint_id?: number | null;
          outcome: string;
          field_name: string;
          requirement_type: string;
          enabled: number;
        }>;
        scope?: { project_id: number; sprint_type: string; sprint_id: number | null };
      };

      expect(afterDeleteBody.transition_requirements.find((row) => row.id === seeded.id)).toEqual(
        expect.objectContaining({ enabled: 0 })
      );
    } finally {
      await stopTestServer(server);
    }
  });

  it('does not re-seed deleted starter gate requirements after all sprint requirements are removed', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`INSERT INTO sprints (id, project_id, name, sprint_type) VALUES (11, 1, 'Dev', 'dev')`);

      for (const field_name of ['review_branch', 'review_commit']) {
        const createResponse = await fetch(`${baseUrl}/api/v1/routing/transition-requirements`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: 1,
            sprint_type: 'dev',
            sprint_id: 11,
            outcome: 'completed_for_review',
            field_name,
            requirement_type: 'required',
            severity: 'block',
            message: `${field_name} is required`,
            enabled: true,
            priority: 100,
          }),
        });
        expect(createResponse.status).toBe(201);
      }

      const initialResponse = await fetch(`${baseUrl}/api/v1/routing/transition-requirements?project_id=1&sprint_type=dev&sprint_id=11`);
      expect(initialResponse.status).toBe(200);
      const initialBody = await initialResponse.json() as {
        transition_requirements: Array<{ id: number; sprint_id?: number | null }>;
        scope?: { project_id: number; sprint_type: string; sprint_id: number | null };
      };
      const sprintScopedRequirements = initialBody.transition_requirements.filter((requirement) => requirement.sprint_id === 11);
      expect(sprintScopedRequirements.length).toBeGreaterThanOrEqual(2);

      for (const requirement of sprintScopedRequirements) {
        const deleteResponse = await fetch(`${baseUrl}/api/v1/routing/transition-requirements/${requirement.id}?project_id=1&sprint_type=dev&sprint_id=11`, {
          method: 'DELETE',
        });
        expect(deleteResponse.status).toBe(200);
      }

      const afterDeleteResponse = await fetch(`${baseUrl}/api/v1/routing/transition-requirements?project_id=1&sprint_type=dev&sprint_id=11`);
      expect(afterDeleteResponse.status).toBe(200);
      await expect(afterDeleteResponse.json()).resolves.toEqual({
        transition_requirements: [],
        scope: { project_id: 1, sprint_type: 'dev', sprint_id: 11 },
      });
    } finally {
      await stopTestServer(server);
    }
  });

  it('lists only sprint-owned automatic transitions for the selected sprint when sibling same-type sprints exist', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`INSERT INTO sprints (id, project_id, name, sprint_type) VALUES (56, 1, 'Bugs 56', 'dev'), (57, 1, 'Bugs 57', 'dev'), (65, 1, 'Bugs 65', 'dev')`);
      await db.run(`
        INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected)
        VALUES
          (56, 'backend', 'ready', 'start_work', 'in_progress', 1, 100, 0),
          (56, NULL, 'review', 'qa_pass', 'ready_to_merge', 1, 90, 0),
          (57, 'backend', 'ready', 'start_work', 'blocked', 1, 80, 0),
          (65, NULL, 'review', 'ship_it', 'done', 1, 70, 0)
      `);

      const response = await fetch(`${baseUrl}/api/v1/routing/transitions?project_id=1&sprint_type=dev&sprint_id=56`);
      expect(response.status).toBe(200);
      const body = await response.json() as {
        transitions: Array<{ sprint_id: number | null; outcome: string; scope_kind: string; is_inherited: boolean; is_override: boolean }>;
        scope: { project_id: number; sprint_type: string; sprint_id: number | null };
      };

      expect(body.scope).toEqual({ project_id: 1, sprint_type: 'dev', sprint_id: 56 });
      expect(body.transitions).toHaveLength(2);
      expect(body.transitions).toEqual(expect.arrayContaining([
        expect.objectContaining({ sprint_id: 56, outcome: 'start_work', scope_kind: 'sprint_override', is_inherited: false, is_override: true }),
        expect.objectContaining({ sprint_id: 56, outcome: 'qa_pass', scope_kind: 'sprint_override', is_inherited: false, is_override: true }),
      ]));
      expect(body.transitions.some((row) => row.sprint_id === 57 || row.sprint_id === 65)).toBe(false);
    } finally {
      await stopTestServer(server);
    }
  });

  it('lists only sprint-owned transition requirements for the selected sprint when sibling same-type sprints exist', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`INSERT INTO sprints (id, project_id, name, sprint_type) VALUES (56, 1, 'Bugs 56', 'dev'), (57, 1, 'Bugs 57', 'dev'), (65, 1, 'Bugs 65', 'dev')`);
      await db.run(`INSERT INTO sprint_type_task_types (sprint_type_key, task_type) VALUES ('dev', 'backend')`);
      await db.run(`
        INSERT INTO task_field_schemas (sprint_type_key, task_type, schema_json)
        VALUES ('dev', NULL, ?)
      `, JSON.stringify({
                fields: [
                  { key: 'review_branch', label: 'Review Branch', type: 'text', source: 'task_column', gate_requirement: true },
                  { key: 'review_commit', label: 'Review Commit', type: 'text', source: 'task_column', gate_requirement: true },
                  { key: 'qa_verified_commit', label: 'QA Verified Commit', type: 'text', source: 'task_column', gate_requirement: true },
                ],
              }));
      await db.run(`
        INSERT INTO sprint_task_transition_requirements (sprint_id, task_type, outcome, field_name, requirement_type, severity, message, enabled, priority)
        VALUES
          (56, NULL, 'completed_for_review', 'review_branch', 'required', 'block', 'review branch required', 1, 100),
          (56, NULL, 'completed_for_review', 'review_commit', 'required', 'block', 'review commit required', 1, 90),
          (57, NULL, 'completed_for_review', 'review_branch', 'required', 'block', 'wrong sibling row', 1, 80),
          (65, NULL, 'qa_pass', 'qa_verified_commit', 'required', 'block', 'wrong sibling row 2', 1, 70)
      `);

      const response = await fetch(`${baseUrl}/api/v1/routing/transition-requirements?project_id=1&sprint_type=dev&sprint_id=56`);
      expect(response.status).toBe(200);
      const body = await response.json() as {
        transition_requirements: Array<{ sprint_id: number | null; field_name: string; outcome: string; scope_kind: string; is_inherited: boolean; is_override: boolean }>;
        scope: { project_id: number; sprint_type: string; sprint_id: number | null };
      };

      expect(body.scope).toEqual({ project_id: 1, sprint_type: 'dev', sprint_id: 56 });
      expect(body.transition_requirements).toHaveLength(2);
      expect(body.transition_requirements).toEqual(expect.arrayContaining([
        expect.objectContaining({ sprint_id: 56, field_name: 'review_branch', outcome: 'completed_for_review', scope_kind: 'sprint_override', is_inherited: false, is_override: true }),
        expect.objectContaining({ sprint_id: 56, field_name: 'review_commit', outcome: 'completed_for_review', scope_kind: 'sprint_override', is_inherited: false, is_override: true }),
      ]));
      expect(body.transition_requirements.some((row) => row.sprint_id === 57 || row.sprint_id === 65)).toBe(false);
    } finally {
      await stopTestServer(server);
    }
  });

  it('creates and lists sprint-type default transition requirements with concrete sprint overrides only', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`INSERT INTO sprints (id, project_id, name, sprint_type, task_policy_seeded_at) VALUES (56, 1, 'Bugs 56', 'dev', datetime('now')), (57, 1, 'Bugs 57', 'dev', datetime('now'))`);
      await db.run(`INSERT INTO sprint_type_task_types (sprint_type_key, task_type) VALUES ('dev', 'backend')`);
      await db.run(`
        INSERT INTO task_field_schemas (sprint_type_key, task_type, schema_json)
        VALUES ('dev', NULL, ?)
      `, JSON.stringify({
                fields: [
                  { key: 'review_branch', label: 'Review Branch', type: 'text', source: 'task_column', gate_requirement: true },
                  { key: 'review_commit', label: 'Review Commit', type: 'text', source: 'task_column', gate_requirement: true },
                  { key: 'qa_verified_commit', label: 'QA Verified Commit', type: 'text', source: 'task_column', gate_requirement: true },
                ],
              }));

      const createDefault = await fetch(`${baseUrl}/api/v1/routing/transition-requirements?project_id=1&sprint_type=dev`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome: 'completed_for_review', field_name: 'review_branch', requirement_type: 'required', severity: 'block', message: 'default branch required', priority: 100 }),
      });
      expect(createDefault.status).toBe(201);
      const defaultRow = await createDefault.json() as { id: number; sprint_id: number | null; project_id: number; sprint_type: string; field_name: string };
      expect(defaultRow).toEqual(expect.objectContaining({ sprint_id: null, project_id: 1, sprint_type: 'dev', field_name: 'review_branch' }));

      await db.run(`
        INSERT INTO sprint_task_transition_requirements (sprint_id, project_id, sprint_type, task_type, outcome, field_name, requirement_type, severity, message, enabled, priority)
        VALUES
          (56, 1, 'dev', NULL, 'completed_for_review', 'review_commit', 'required', 'block', 'sprint commit required', 1, 90),
          (57, 1, 'dev', NULL, 'completed_for_review', 'qa_verified_commit', 'required', 'block', 'sibling should not leak', 1, 80)
      `);

      const response = await fetch(`${baseUrl}/api/v1/routing/transition-requirements?project_id=1&sprint_type=dev&sprint_id=56`);
      expect(response.status).toBe(200);
      const body = await response.json() as {
        transition_requirements: Array<{ sprint_id: number | null; field_name: string; scope_kind: string; is_inherited: boolean; is_override: boolean; effective_for_sprint: boolean }>;
      };

      expect(body.transition_requirements).toEqual(expect.arrayContaining([
        expect.objectContaining({ sprint_id: null, field_name: 'review_branch', scope_kind: 'sprint_type_default', is_inherited: true, is_override: false, effective_for_sprint: true }),
        expect.objectContaining({ sprint_id: 56, field_name: 'review_commit', scope_kind: 'sprint_override', is_inherited: false, is_override: true, effective_for_sprint: true }),
      ]));
      expect(body.transition_requirements.some((row) => row.field_name === 'qa_verified_commit')).toBe(false);
    } finally {
      await stopTestServer(server);
    }
  });

  it('uses sprint-type default transition requirements for outcome gates when a sprint has no override', async () => {
    const { server } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`INSERT INTO sprints (id, project_id, name, sprint_type, task_policy_seeded_at) VALUES (56, 1, 'Bugs 56', 'dev', datetime('now')), (57, 1, 'Bugs 57', 'dev', datetime('now'))`);
      await db.run(`
        INSERT INTO sprint_task_transition_requirements (sprint_id, project_id, sprint_type, task_type, outcome, field_name, requirement_type, severity, message, enabled, priority)
        VALUES
          (NULL, 1, 'dev', NULL, 'completed_for_review', 'review_branch', 'required', 'block', 'default branch required', 1, 100),
          (57, 1, 'dev', NULL, 'completed_for_review', 'review_commit', 'required', 'block', 'sibling should not leak', 1, 90)
      `);

      const requirements = await loadSprintTaskTransitionRequirements(db, 56, 'completed_for_review', 'backend');
      expect(requirements.map((row) => row.field_name)).toEqual(['review_branch']);
      expect(requirements.every((row) => row.sprint_id === null)).toBe(true);
    } finally {
      await stopTestServer(server);
    }
  });

  it('excludes disabled automatic transitions and gate requirements from runtime policy reads', async () => {
    const { server } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`INSERT INTO sprints (id, project_id, name, sprint_type, task_policy_seeded_at) VALUES (56, 1, 'Bugs 56', 'dev', datetime('now'))`);
      await db.run(`
        INSERT INTO sprint_task_transitions (sprint_id, project_id, sprint_type, task_type, from_status, outcome, to_status, enabled, priority)
        VALUES
          (56, 1, 'dev', NULL, 'in_progress', 'completed_for_review', 'review', 0, 100),
          (56, 1, 'dev', NULL, 'in_progress', 'completed_for_review', 'dev_deploy_queued', 1, 50)
      `);
      await db.run(`
        INSERT INTO sprint_task_transition_requirements (sprint_id, project_id, sprint_type, task_type, outcome, field_name, requirement_type, severity, message, enabled, priority)
        VALUES
          (56, 1, 'dev', NULL, 'completed_for_review', 'disabled_field', 'required', 'block', '', 0, 100),
          (56, 1, 'dev', NULL, 'completed_for_review', 'enabled_field', 'required', 'block', '', 1, 50)
      `);

      expect(await resolveSprintTaskTransition(db, 56, 'in_progress', 'completed_for_review', null)).toEqual(expect.objectContaining({
        to_status: 'dev_deploy_queued',
        enabled: 1,
      }));
      expect((await loadSprintTaskTransitionRequirements(db, 56, 'completed_for_review', null)).map((row) => row.field_name)).toEqual(['enabled_field']);
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects creating a routing rule for an unknown sprint agent', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', sprint_id: 10, task_type: 'backend', status: 'ready', agent_id: 999, priority: 5 }),
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'Agent 999 not found' });
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects creating a routing rule for an agent outside the sprint project', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', sprint_id: 10, task_type: 'backend', status: 'ready', agent_id: 8, priority: 5 }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'Agent 8 is not assigned to project 1' });
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects creating a routing rule for a task type not allowed by the sprint type', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_id: 10, task_type: 'frontend', status: 'ready', agent_id: 7, priority: 5 }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'task_type "frontend" is not allowed for sprint type "bugs". Allowed: backend, qa' });
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects creating a routing rule for a status not configured on the sprint', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_id: 10, task_type: 'backend', status: 'not_real', agent_id: 7, priority: 5 }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'Status "not_real" is not configured for sprint 10' });
    } finally {
      await stopTestServer(server);
    }
  });

  it('accepts canonical task_status alias when creating a routing rule', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_id: 10, task_type: 'backend', task_status: 'ready', agent_id: 7, priority: 5 }),
      });

      const body = await response.json();
      if (response.status !== 201) {
        throw new Error(`Expected 201, received ${response.status}: ${JSON.stringify(body)}`);
      }
      expect(body).toEqual(expect.objectContaining({ sprint_id: 10, agent_id: 7, task_type: 'backend', status: 'ready' }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('creates sprint-type defaults, overlays sprint overrides, and resolves the effective sprint rule', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      const defaultResponse = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', task_type: 'backend', status: 'ready', agent_id: 7, priority: 5 }),
      });
      expect(defaultResponse.status).toBe(201);

      await db.run(`INSERT INTO agents (id, name, job_title, project_id, enabled) VALUES (9, 'Override Agent', 'Backend Engineer', 1, 1)`);
      const overrideResponse = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', sprint_id: 10, task_type: 'backend', status: 'ready', agent_id: 9, priority: 10 }),
      });

      const overrideBody = await overrideResponse.json();
      if (overrideResponse.status !== 201) {
        throw new Error(`Expected 201, received ${overrideResponse.status}: ${JSON.stringify(overrideBody)}`);
      }
      expect(overrideBody).toEqual(expect.objectContaining({ sprint_id: 10, agent_id: 9, task_type: 'backend', status: 'ready', scope_kind: 'sprint_override' }));

      const readResponse = await fetch(`${baseUrl}/api/v1/routing/rules?project_id=1&sprint_type=bugs&sprint_id=10`);
      expect(readResponse.status).toBe(200);
      const body = await readResponse.json() as { rules: Array<{ sprint_id: number | null; agent_id: number; scope_kind: string; effective_for_sprint: boolean }>; scope?: { project_id: number; sprint_type: string; sprint_id: number | null } };
      expect(body.rules).toEqual([
        expect.objectContaining({ sprint_id: 10, agent_id: 9, scope_kind: 'sprint_override', effective_for_sprint: true }),
        expect.objectContaining({ sprint_id: null, agent_id: 7, scope_kind: 'sprint_type_default', effective_for_sprint: false }),
      ]);

      const resolveResponse = await fetch(`${baseUrl}/api/v1/routing/rules/resolve?sprint_id=10&task_type=backend&status=ready`);
      expect(resolveResponse.status).toBe(200);
      const resolveBody = await resolveResponse.json() as { matched: boolean; rule: { sprint_id: number | null; agent_id: number; scope_kind: string } };
      expect(resolveBody).toEqual(expect.objectContaining({
        matched: true,
        rule: expect.objectContaining({ sprint_id: 10, agent_id: 9, scope_kind: 'sprint_override' }),
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('filters sprint-type defaults separately from sprint overrides', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      const defaultResponse = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', task_type: 'backend', status: 'ready', agent_id: 7, priority: 5 }),
      });
      expect(defaultResponse.status).toBe(201);

      await db.run(`INSERT INTO agents (id, name, job_title, project_id, enabled) VALUES (9, 'Override Agent', 'Backend Engineer', 1, 1)`);
      const overrideResponse = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', sprint_id: 10, task_type: 'backend', status: 'ready', agent_id: 9, priority: 10 }),
      });
      expect(overrideResponse.status).toBe(201);

      const defaultsResponse = await fetch(`${baseUrl}/api/v1/routing/rules?project_id=1&sprint_type=bugs&sprint_id=10&scope=defaults`);
      expect(defaultsResponse.status).toBe(200);
      const defaultsBody = await defaultsResponse.json() as { rules: Array<{ sprint_id: number | null; scope_kind: string; effective_for_sprint: boolean }> };
      expect(defaultsBody.rules).toEqual([
        expect.objectContaining({ sprint_id: null, scope_kind: 'sprint_type_default', effective_for_sprint: true }),
      ]);

      const overridesResponse = await fetch(`${baseUrl}/api/v1/routing/rules?project_id=1&sprint_type=bugs&sprint_id=10&scope=overrides`);
      expect(overridesResponse.status).toBe(200);
      const overridesBody = await overridesResponse.json() as { rules: Array<{ sprint_id: number | null; scope_kind: string; effective_for_sprint: boolean }> };
      expect(overridesBody.rules).toEqual([
        expect.objectContaining({ sprint_id: 10, scope_kind: 'sprint_override', effective_for_sprint: true }),
      ]);
    } finally {
      await stopTestServer(server);
    }
  });

  it('falls back to sprint-type defaults after deleting a sprint override', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      const defaultResponse = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', task_type: 'backend', status: 'ready', agent_id: 7, priority: 5 }),
      });
      expect(defaultResponse.status).toBe(201);

      await db.run(`INSERT INTO agents (id, name, job_title, project_id, enabled) VALUES (9, 'Override Agent', 'Backend Engineer', 1, 1)`);
      const overrideResponse = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', sprint_id: 10, task_type: 'backend', status: 'ready', agent_id: 9, priority: 10 }),
      });
      const override = await overrideResponse.json() as { id: number };
      expect(overrideResponse.status).toBe(201);

      const deleteResponse = await fetch(`${baseUrl}/api/v1/routing/rules/${override.id}?sprint_id=10`, {
        method: 'DELETE',
      });
      expect(deleteResponse.status).toBe(200);

      const readResponse = await fetch(`${baseUrl}/api/v1/routing/rules?project_id=1&sprint_type=bugs&sprint_id=10`);
      expect(readResponse.status).toBe(200);
      const body = await readResponse.json() as { rules: Array<{ sprint_id: number | null; agent_id: number; scope_kind: string; effective_for_sprint: boolean }> };
      expect(body.rules).toEqual([
        expect.objectContaining({ sprint_id: null, agent_id: 7, scope_kind: 'sprint_type_default', effective_for_sprint: true }),
      ]);

      const resolveResponse = await fetch(`${baseUrl}/api/v1/routing/rules/resolve?sprint_id=10&task_type=backend&status=ready`);
      expect(resolveResponse.status).toBe(200);
      const resolveBody = await resolveResponse.json() as { matched: boolean; rule: { sprint_id: number | null; agent_id: number; scope_kind: string } };
      expect(resolveBody).toEqual(expect.objectContaining({
        matched: true,
        rule: expect.objectContaining({ sprint_id: null, agent_id: 7, scope_kind: 'sprint_type_default' }),
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects creating exact duplicate sprint-type default routing candidates', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const createFirst = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', task_type: 'backend', status: 'ready', agent_id: 7, priority: 5 }),
      });
      const firstBody = await createFirst.json();
      if (createFirst.status !== 201) {
        throw new Error(`Expected 201, received ${createFirst.status}: ${JSON.stringify(firstBody)}`);
      }

      const createSecond = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', task_type: 'backend', status: 'ready', agent_id: 7, priority: 5 }),
      });
      expect(createSecond.status).toBe(409);
      await expect(createSecond.json()).resolves.toEqual({
        error: 'Routing rule already exists for bugs default scope backend/ready agent 7 priority 5',
      });
    } finally {
      await stopTestServer(server);
    }
  });

  it('allows multiple sprint-type default candidates for the same scope and orders them by priority then id', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`INSERT INTO sprint_type_task_types (sprint_type_key, task_type) VALUES ('dev', 'backend')`);
      await db.run(`INSERT INTO sprints (id, project_id, name, sprint_type) VALUES (56, 1, 'Development', 'dev')`);
      await db.run(`INSERT INTO agents (id, name, job_title, project_id, enabled) VALUES (108, 'Vulcan', 'Backend Engineer', 1, 1)`);

      const createPrimary = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'dev', task_type: 'backend', status: 'ready', agent_id: 7, priority: 0 }),
      });
      expect(createPrimary.status).toBe(201);

      const createFallback = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'dev', task_type: 'backend', status: 'ready', agent_id: 108, priority: -10 }),
      });
      expect(createFallback.status).toBe(201);

      const resolveResponse = await fetch(`${baseUrl}/api/v1/routing/rules/resolve?sprint_id=56&task_type=backend&status=ready`);
      expect(resolveResponse.status).toBe(200);
      const resolveBody = await resolveResponse.json() as {
        matched: boolean;
        rule: { agent_id: number; priority: number };
        candidates: Array<{ agent_id: number; priority: number; scope_kind: string }>;
      };
      expect(resolveBody.rule).toEqual(expect.objectContaining({ agent_id: 7, priority: 0 }));
      expect(resolveBody.candidates.map((candidate) => ({ agent_id: candidate.agent_id, priority: candidate.priority }))).toEqual([
        { agent_id: 7, priority: 0 },
        { agent_id: 108, priority: -10 },
      ]);
      expect(await resolveSprintTaskRoutingAssignment(db, 56, 'backend', 'ready')).toEqual({ agent_id: 7 });
    } finally {
      await stopTestServer(server);
    }
  });

  it('allows multiple sprint override candidates for the same scope and keeps overrides above defaults', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`INSERT INTO agents (id, name, job_title, project_id, enabled) VALUES (9, 'Override Primary', 'Backend Engineer', 1, 1), (108, 'Vulcan', 'Backend Engineer', 1, 1)`);
      await db.run(`INSERT INTO sprint_task_routing_rules (project_id, sprint_type, sprint_id, task_type, status, agent_id, priority, is_system)
        VALUES (1, 'bugs', NULL, 'backend', 'ready', 7, 100, 0)`);

      const createPrimary = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', sprint_id: 10, scope_kind: 'sprint_override', task_type: 'backend', status: 'ready', agent_id: 9, priority: 0 }),
      });
      expect(createPrimary.status).toBe(201);

      const createFallback = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', sprint_id: 10, scope_kind: 'sprint_override', task_type: 'backend', status: 'ready', agent_id: 108, priority: -10 }),
      });
      expect(createFallback.status).toBe(201);

      const resolveResponse = await fetch(`${baseUrl}/api/v1/routing/rules/resolve?sprint_id=10&task_type=backend&status=ready`);
      expect(resolveResponse.status).toBe(200);
      const resolveBody = await resolveResponse.json() as {
        rule: { agent_id: number; priority: number; scope_kind: string };
        candidates: Array<{ agent_id: number; priority: number; scope_kind: string }>;
      };
      expect(resolveBody.rule).toEqual(expect.objectContaining({ agent_id: 9, priority: 0, scope_kind: 'sprint_override' }));
      expect(resolveBody.candidates.map((candidate) => ({ agent_id: candidate.agent_id, priority: candidate.priority, scope_kind: candidate.scope_kind }))).toEqual([
        { agent_id: 9, priority: 0, scope_kind: 'sprint_override' },
        { agent_id: 108, priority: -10, scope_kind: 'sprint_override' },
        { agent_id: 7, priority: 100, scope_kind: 'sprint_type_default' },
      ]);
    } finally {
      await stopTestServer(server);
    }
  });

  it('keeps one effective default row after duplicate legacy defaults exist and a new duplicate create is attempted', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`INSERT INTO sprint_task_routing_rules (project_id, sprint_type, sprint_id, task_type, status, agent_id, priority, is_system)
        VALUES (1, 'bugs', NULL, 'backend', 'ready', 7, 5, 0)`);
      await db.run(`INSERT INTO sprint_task_routing_rules (project_id, sprint_type, sprint_id, task_type, status, agent_id, priority, is_system)
        VALUES (1, 'bugs', NULL, 'backend', 'ready', 7, 5, 0)`);

      const response = await fetch(`${baseUrl}/api/v1/routing/rules?project_id=1&sprint_id=10&include_effective=1`);
      expect(response.status).toBe(200);
      const body = await response.json() as { rules: Array<{ sprint_id: number | null; task_type: string; status: string; scope_kind: string }> };
      expect(body.rules.filter((rule) => rule.sprint_id == null && rule.task_type === 'backend' && rule.status === 'ready' && rule.scope_kind === 'sprint_type_default')).toHaveLength(2);

      const createDuplicate = await fetch(`${baseUrl}/api/v1/routing/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', task_type: 'backend', status: 'ready', agent_id: 7, priority: 5 }),
      });
      expect(createDuplicate.status).toBe(409);
      await expect(createDuplicate.json()).resolves.toEqual({
        error: 'Routing rule already exists for bugs default scope backend/ready agent 7 priority 5',
      });
    } finally {
      await stopTestServer(server);
    }
  });

  it('policy helpers resolve sprint-type defaults for runtime routing decisions', async () => {
    const db = getDb();
    await db.run(`INSERT INTO sprint_task_routing_rules (project_id, sprint_type, sprint_id, task_type, status, agent_id, priority, is_system)
      VALUES (1, 'bugs', NULL, 'backend', 'ready', 7, 5, 0)`);

    expect(await resolveSprintTaskRoutingAssignment(db, 10, 'backend', 'ready')).toEqual({ agent_id: 7 });

    const listed = await listSprintTaskRoutingRules(db, 10);
    expect(listed[0]).toEqual(expect.objectContaining({ sprint_id: null, task_type: 'backend', status: 'ready', agent_id: 7 }));

    await db.run(`INSERT INTO agents (id, name, job_title, project_id, enabled) VALUES (9, 'Override Agent', 'Backend Engineer', 1, 1)`);
    await db.run(`INSERT INTO sprint_task_routing_rules (project_id, sprint_type, sprint_id, task_type, status, agent_id, priority, is_system)
      VALUES (1, 'bugs', 10, 'backend', 'ready', 9, 10, 0)`);

    expect(await resolveSprintTaskRoutingAssignment(db, 10, 'backend', 'ready')).toEqual({ agent_id: 9 });
  });

  it('keeps disabled routing rules visible but excludes them from runtime assignment', async () => {
    const db = getDb();
    await db.run(`INSERT INTO agents (id, name, job_title, project_id, enabled) VALUES (9, 'Disabled Route Agent', 'Backend Engineer', 1, 1)`);
    await db.run(`INSERT INTO sprint_task_routing_rules (project_id, sprint_type, sprint_id, task_type, status, agent_id, enabled, priority, is_system)
      VALUES (1, 'bugs', NULL, 'backend', 'ready', 9, 0, 50, 0)`);

    expect(await resolveSprintTaskRoutingAssignment(db, 10, 'backend', 'ready')).toEqual({ agent_id: null });

    const listed = await listSprintTaskRoutingRules(db, 10);
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ task_type: 'backend', status: 'ready', agent_id: 9, enabled: 0 }),
    ]));
  });

  it('dispatcher runtime prefers sprint overrides but falls back to sprint-type defaults', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`INSERT INTO sprint_task_routing_rules (project_id, sprint_type, sprint_id, task_type, status, agent_id, priority, is_system)
        VALUES (1, 'bugs', NULL, 'backend', 'ready', 7, 5, 0)`);

      let response = await fetch(`${baseUrl}/api/v1/routing/rules/resolve?sprint_id=10&task_type=backend&status=ready`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(expect.objectContaining({
        matched: true,
        rule: expect.objectContaining({ sprint_id: null, agent_id: 7, scope_kind: 'sprint_type_default' }),
      }));

      await db.run(`INSERT INTO agents (id, name, job_title, project_id, enabled) VALUES (9, 'Override Agent', 'Backend Engineer', 1, 1)`);
      await db.run(`INSERT INTO sprint_task_routing_rules (project_id, sprint_type, sprint_id, task_type, status, agent_id, priority, is_system)
        VALUES (1, 'bugs', 10, 'backend', 'ready', 9, 10, 0)`);

      response = await fetch(`${baseUrl}/api/v1/routing/rules/resolve?sprint_id=10&task_type=backend&status=ready`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(expect.objectContaining({
        matched: true,
        rule: expect.objectContaining({ sprint_id: 10, agent_id: 9, scope_kind: 'sprint_override' }),
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('supports sprint-type default and sprint override transition reads and writes', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const missingProjectList = await fetch(`${baseUrl}/api/v1/routing/transitions?sprint_id=10`);
      expect(missingProjectList.status).toBe(400);

      const defaultCreate = await fetch(`${baseUrl}/api/v1/routing/transitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_type: 'bugs', from_status: 'in_progress', outcome: 'completed_for_review', to_status: 'review' }),
      });
      expect(defaultCreate.status).toBe(201);
      const defaultCreated = await defaultCreate.json() as { id: number; sprint_id: number | null; project_id: number; sprint_type: string; scope_kind: string };
      expect(defaultCreated).toEqual(expect.objectContaining({ sprint_id: null, project_id: 1, sprint_type: 'bugs', scope_kind: 'sprint_type_default' }));

      const defaultUpdate = await fetch(`${baseUrl}/api/v1/routing/transitions/${defaultCreated.id}?project_id=1&sprint_type=bugs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: 12 }),
      });
      expect(defaultUpdate.status).toBe(200);
      await expect(defaultUpdate.json()).resolves.toEqual(expect.objectContaining({ id: defaultCreated.id, priority: 12, sprint_id: null, project_id: 1, sprint_type: 'bugs' }));

      const defaultList = await fetch(`${baseUrl}/api/v1/routing/transitions?project_id=1&sprint_type=bugs&sprint_id=10`);
      expect(defaultList.status).toBe(200);
      const defaultListBody = await defaultList.json() as { transitions: Array<{ id: number; sprint_id: number | null; scope_kind: string; is_inherited: boolean; effective_for_sprint: boolean }> };
      expect(defaultListBody.transitions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: defaultCreated.id, sprint_id: null, scope_kind: 'sprint_type_default', is_inherited: true, effective_for_sprint: true }),
      ]));

      const createResponse = await fetch(`${baseUrl}/api/v1/routing/transitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 1, sprint_id: 10, from_status: 'in_progress', outcome: 'completed_for_review', to_status: 'review' }),
      });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as { id: number; sprint_id: number; project_id: number };
      expect(created).toEqual(expect.objectContaining({ sprint_id: 10, project_id: 1 }));

      const updateResponse = await fetch(`${baseUrl}/api/v1/routing/transitions/${created.id}?project_id=1&sprint_id=10`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: 0 }),
      });
      expect(updateResponse.status).toBe(200);
      await expect(updateResponse.json()).resolves.toEqual(expect.objectContaining({ id: created.id, enabled: 0, sprint_id: 10, project_id: 1 }));

      const deleteResponse = await fetch(`${baseUrl}/api/v1/routing/transitions/${created.id}?project_id=1&sprint_id=10`, {
        method: 'DELETE',
      });
      expect(deleteResponse.status).toBe(200);
      await expect(deleteResponse.json()).resolves.toEqual({ ok: true });

      const defaultDelete = await fetch(`${baseUrl}/api/v1/routing/transitions/${defaultCreated.id}?project_id=1&sprint_type=bugs`, {
        method: 'DELETE',
      });
      expect(defaultDelete.status).toBe(200);
      await expect(defaultDelete.json()).resolves.toEqual({ ok: true });
    } finally {
      await stopTestServer(server);
    }
  });

  it('allows non-admin MCP keys to CRUD project-scoped workflow transitions only in their assigned project', async () => {
    const tenantContext = await import('../lib/tenantContext');
    const db = getDb();
    tenantContext.ensureTenantSchema(db);
    const apiKey = (await issueMcpApiKeyForAgent(db, 7, 'transition manager key')).apiKey;
    await replaceAgentMcpPermissionPolicy(db, 7, ['discovery.read_catalog', 'routing_transitions.manage_project_scope']);
    const authHeaders = {
      Authorization: `Bearer ${apiKey}`,
      'x-agent-hq-mcp-client': 'agent-hq-mcp',
    };

    const { server, baseUrl } = await startTestServer();
    try {
      const defaultCreate = await fetch(`${baseUrl}/api/v1/routing/transitions`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: 1,
          sprint_type: 'bugs',
          task_type: 'backend',
          from_status: 'in_progress',
          outcome: 'completed_for_review',
          to_status: 'review',
        }),
      });
      expect(defaultCreate.status).toBe(201);
      const defaultCreated = await defaultCreate.json() as { id: number; project_id: number; sprint_id: number | null; scope_kind: string };
      expect(defaultCreated).toEqual(expect.objectContaining({ project_id: 1, sprint_id: null, scope_kind: 'sprint_type_default' }));

      const defaultGet = await fetch(`${baseUrl}/api/v1/routing/transitions/${defaultCreated.id}?project_id=1&sprint_type=bugs`, { headers: authHeaders });
      expect(defaultGet.status).toBe(200);
      await expect(defaultGet.json()).resolves.toEqual(expect.objectContaining({ id: defaultCreated.id, project_id: 1, sprint_id: null }));

      const defaultUpdate = await fetch(`${baseUrl}/api/v1/routing/transitions/${defaultCreated.id}?project_id=1&sprint_type=bugs`, {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: 14 }),
      });
      expect(defaultUpdate.status).toBe(200);
      await expect(defaultUpdate.json()).resolves.toEqual(expect.objectContaining({ id: defaultCreated.id, priority: 14 }));

      const overrideCreate = await fetch(`${baseUrl}/api/v1/routing/transitions`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: 1,
          sprint_id: 10,
          from_status: 'in_progress',
          outcome: 'blocked',
          to_status: 'blocked',
        }),
      });
      expect(overrideCreate.status).toBe(201);
      const overrideCreated = await overrideCreate.json() as { id: number; project_id: number; sprint_id: number; scope_kind: string };
      expect(overrideCreated).toEqual(expect.objectContaining({ project_id: 1, sprint_id: 10, scope_kind: 'sprint_override' }));

      const overrideUpdate = await fetch(`${baseUrl}/api/v1/routing/transitions/${overrideCreated.id}?project_id=1&sprint_id=10`, {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      expect(overrideUpdate.status).toBe(200);
      await expect(overrideUpdate.json()).resolves.toEqual(expect.objectContaining({ id: overrideCreated.id, enabled: 0 }));

      const list = await fetch(`${baseUrl}/api/v1/routing/transitions?project_id=1&sprint_type=bugs&sprint_id=10`, { headers: authHeaders });
      expect(list.status).toBe(200);
      const listBody = await list.json() as { transitions: Array<{ id: number; project_id: number; sprint_id: number | null }> };
      expect(listBody.transitions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: defaultCreated.id, project_id: 1, sprint_id: null }),
        expect.objectContaining({ id: overrideCreated.id, project_id: 1, sprint_id: 10 }),
      ]));

      const overrideDelete = await fetch(`${baseUrl}/api/v1/routing/transitions/${overrideCreated.id}?project_id=1&sprint_id=10`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(overrideDelete.status).toBe(200);
      await expect(overrideDelete.json()).resolves.toEqual({ ok: true });

      const defaultDelete = await fetch(`${baseUrl}/api/v1/routing/transitions/${defaultCreated.id}?project_id=1&sprint_type=bugs`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(defaultDelete.status).toBe(200);
      await expect(defaultDelete.json()).resolves.toEqual({ ok: true });
    } finally {
      await stopTestServer(server);
    }
  });

  it('denies scoped MCP workflow transition CRUD outside the caller project or tenant', async () => {
    const tenantContext = await import('../lib/tenantContext');
    const db = getDb();
    const defaultTenantId = tenantContext.ensureTenantSchema(db);
    const betaTenantId = Number((await db.run(`
      INSERT INTO tenants (name, slug, is_default)
      VALUES ('Beta Company', 'beta-company', 0)
    `)).lastInsertId);
    await db.run(`UPDATE projects SET tenant_id = ? WHERE id = 2`, betaTenantId);
    await db.run(`INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type) VALUES (20, ?, 2, 'Beta Bugs', 'bugs')`, betaTenantId);
    await db.run(`UPDATE agents SET tenant_id = ? WHERE id = 8`, betaTenantId);
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, project_id, sprint_type, sprint_id, task_type, from_status, outcome, to_status)
      VALUES (?, 2, 'bugs', NULL, 'backend', 'in_progress', 'completed_for_review', 'review')
    `, betaTenantId);
    const betaTransitionId = Number((await db.get(`SELECT id FROM sprint_task_transitions WHERE tenant_id = ?`, betaTenantId) as { id: number }).id);

    await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (3, ?, 'Same Tenant Other Project')`, defaultTenantId);
    await db.run(`INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type) VALUES (30, ?, 3, 'Other Bugs', 'bugs')`, defaultTenantId);
    await db.run(`
      INSERT INTO sprint_task_transitions (tenant_id, project_id, sprint_type, sprint_id, task_type, from_status, outcome, to_status)
      VALUES (?, 3, 'bugs', NULL, 'backend', 'in_progress', 'completed_for_review', 'review')
    `, defaultTenantId);
    const otherProjectTransitionId = Number((await db.get(`SELECT id FROM sprint_task_transitions WHERE project_id = 3`) as { id: number }).id);

    const apiKey = (await issueMcpApiKeyForAgent(db, 7, 'transition manager key')).apiKey;
    await replaceAgentMcpPermissionPolicy(db, 7, ['routing_transitions.manage_project_scope']);
    const authHeaders = {
      Authorization: `Bearer ${apiKey}`,
      'x-agent-hq-mcp-client': 'agent-hq-mcp',
    };
    await db.run(`UPDATE app_settings SET value = ? WHERE key = 'active_tenant_id'`, String(defaultTenantId));

    const { server, baseUrl } = await startTestServer();
    try {
      const crossProjectCreate = await fetch(`${baseUrl}/api/v1/routing/transitions`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: 3,
          sprint_type: 'bugs',
          from_status: 'in_progress',
          outcome: 'blocked',
          to_status: 'blocked',
        }),
      });
      expect(crossProjectCreate.status).toBe(403);
      await expect(crossProjectCreate.json()).resolves.toMatchObject({
        code: 'mcp_scope_denied',
        details: { required_capability: 'routing_transitions.manage_project_scope' },
      });

      const crossProjectUpdate = await fetch(`${baseUrl}/api/v1/routing/transitions/${otherProjectTransitionId}?project_id=3&sprint_type=bugs`, {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: 99 }),
      });
      expect(crossProjectUpdate.status).toBe(403);
      await expect(crossProjectUpdate.json()).resolves.toMatchObject({
        code: 'mcp_scope_denied',
        details: { required_capability: 'routing_transitions.manage_project_scope' },
      });

      const crossTenantRead = await fetch(`${baseUrl}/api/v1/routing/transitions/${betaTransitionId}?tenant_id=${betaTenantId}&project_id=2&sprint_type=bugs`, {
        headers: authHeaders,
      });
      expect(crossTenantRead.status).toBe(403);
      await expect(crossTenantRead.json()).resolves.toMatchObject({
        code: 'mcp_tenant_scope_denied',
        details: {
          key_tenant_id: defaultTenantId,
          requested_tenant_id: betaTenantId,
          required_capability: 'admin.cross_tenant',
        },
      });
    } finally {
      await stopTestServer(server);
    }
  });

  it('allows sprint transition rows to be disabled and deleted even when legacy protected flags exist', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`
        INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected)
        VALUES (10, NULL, 'in_progress', 'completed_for_review', 'review', 1, 0, 1)
      `);
      const id = Number((await db.get(`SELECT id FROM sprint_task_transitions WHERE sprint_id = 10 LIMIT 1`) as { id: number }).id);

      const updateResponse = await fetch(`${baseUrl}/api/v1/routing/transitions/${id}?project_id=1&sprint_id=10`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: 0 }),
      });
      expect(updateResponse.status).toBe(200);
      await expect(updateResponse.json()).resolves.toEqual(expect.objectContaining({ id, enabled: 0, sprint_id: 10, project_id: 1 }));

      const deleteResponse = await fetch(`${baseUrl}/api/v1/routing/transitions/${id}?project_id=1&sprint_id=10`, {
        method: 'DELETE',
      });
      expect(deleteResponse.status).toBe(200);
      await expect(deleteResponse.json()).resolves.toEqual({ ok: true });

      const listResponse = await fetch(`${baseUrl}/api/v1/routing/transitions?project_id=1&sprint_id=10`);
      expect(listResponse.status).toBe(200);
      const listBody = await listResponse.json() as { transitions: Array<{ id: number; from_status: string; outcome: string; to_status: string }> };
      expect(listBody.transitions.find((row) => row.id === id)).toBeUndefined();
      expect(listBody.transitions.find((row) => row.from_status === 'in_progress' && row.outcome === 'completed_for_review' && row.to_status === 'review')).toBeUndefined();
    } finally {
      await stopTestServer(server);
    }
  });

  it('does not seed legacy lifecycle transition rows when listing a sprint', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`INSERT INTO sprints (id, project_id, name, sprint_type) VALUES (11, 1, 'Dev', 'dev')`);

      const listResponse = await fetch(`${baseUrl}/api/v1/routing/transitions?project_id=1&sprint_id=11`);
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toEqual({
        transitions: [],
        scope: { project_id: 1, sprint_type: 'dev', sprint_id: 11 },
      });
    } finally {
      await stopTestServer(server);
    }
  });

  it('persists sprint-scoped status emoji updates and returns them in the API response', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const updateResponse = await fetch(`${baseUrl}/api/v1/routing/statuses/blocked`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sprint_id: 10, emoji: '🟡' }),
      });

      if (updateResponse.status !== 200) {
        throw new Error(`Expected 200, received ${updateResponse.status}: ${JSON.stringify(await updateResponse.json())}`);
      }
      await expect(updateResponse.json()).resolves.toEqual(expect.objectContaining({
        name: 'blocked',
        emoji: '🟡',
      }));

      const db = getDb();
      const row = await db.get(`
        SELECT metadata_json
        FROM sprint_task_statuses
        WHERE sprint_id = ? AND status_key = ?
      `, 10, 'blocked') as { metadata_json: string } | undefined;
      expect(row).toBeDefined();
      expect(JSON.parse(row?.metadata_json ?? '{}')).toEqual(expect.objectContaining({ emoji: '🟡' }));

      const listResponse = await fetch(`${baseUrl}/api/v1/routing/statuses?sprint_id=10`);
      expect(listResponse.status).toBe(200);
      const listBody = await listResponse.json() as { statuses: Array<{ name: string; emoji: string | null }> };
      expect(listBody.statuses.find((status) => status.name === 'blocked')).toEqual(expect.objectContaining({
        name: 'blocked',
        emoji: '🟡',
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects unscoped status policy operations that omit sprint_id', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const listResponse = await fetch(`${baseUrl}/api/v1/routing/statuses`);
      expect(listResponse.status).toBe(400);
      await expect(listResponse.json()).resolves.toEqual({ error: 'sprint_id is required for sprint task status policy operations' });

      const createResponse = await fetch(`${baseUrl}/api/v1/routing/statuses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'custom_waiting', label: 'Custom Waiting' }),
      });
      expect(createResponse.status).toBe(400);
      await expect(createResponse.json()).resolves.toEqual({ error: 'sprint_id is required for sprint task status policy operations' });

      const updateResponse = await fetch(`${baseUrl}/api/v1/routing/statuses/blocked`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Blocked-ish' }),
      });
      expect(updateResponse.status).toBe(400);
      await expect(updateResponse.json()).resolves.toEqual({ error: 'sprint_id is required for sprint task status policy operations' });

      const deleteResponse = await fetch(`${baseUrl}/api/v1/routing/statuses/blocked`, {
        method: 'DELETE',
      });
      expect(deleteResponse.status).toBe(400);
      await expect(deleteResponse.json()).resolves.toEqual({ error: 'sprint_id is required for sprint task status policy operations' });
    } finally {
      await stopTestServer(server);
    }
  });

  it('allows deleting seeded sprint-scoped statuses without recreating them on later reads', async () => {
    await seedSprintTaskPolicy(getDb(), 10);
    const { server, baseUrl } = await startTestServer();
    try {
      const initialListResponse = await fetch(`${baseUrl}/api/v1/routing/statuses?sprint_id=10`);
      expect(initialListResponse.status).toBe(200);
      const initialListBody = await initialListResponse.json() as { statuses: Array<{ name: string }> };
      expect(initialListBody.statuses.find((status) => status.name === 'review')).toBeDefined();

      const deleteResponse = await fetch(`${baseUrl}/api/v1/routing/statuses/review?sprint_id=10`, {
        method: 'DELETE',
      });
      expect(deleteResponse.status).toBe(200);
      await expect(deleteResponse.json()).resolves.toEqual(expect.objectContaining({ ok: true, deleted: 'review', sprint_id: 10 }));

      const db = getDb();
      const deletedRow = await db.get(`
        SELECT id
        FROM sprint_task_statuses
        WHERE sprint_id = ? AND status_key = ?
      `, 10, 'review');
      expect(deletedRow).toBeUndefined();

      const listResponse = await fetch(`${baseUrl}/api/v1/routing/statuses?sprint_id=10`);
      expect(listResponse.status).toBe(200);
      const listBody = await listResponse.json() as { statuses: Array<{ name: string }> };
      expect(listBody.statuses.find((status) => status.name === 'review')).toBeUndefined();
    } finally {
      await stopTestServer(server);
    }
  });

  it('does not seed sprint status policy while listing statuses', async () => {
    const db = getDb();
    await db.run(`
      INSERT INTO task_statuses (name, label, color, terminal, is_system, allowed_transitions)
      VALUES ('legacy_global_only', 'Legacy Global Only', 'pink', 0, 0, '[]')
    `);
    await db.run(`INSERT INTO sprints (id, project_id, name, sprint_type) VALUES (11, 1, 'Fresh Generic', 'generic')`);

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/routing/statuses?sprint_id=11`);
      expect(response.status).toBe(200);
      const body = await response.json() as { statuses: Array<{ name: string }> };

      expect(body.statuses.some((status) => status.name === 'legacy_global_only')).toBe(false);
      expect(body.statuses).toEqual([]);

      const sprintRows = await db.all(`SELECT status_key FROM sprint_task_statuses WHERE sprint_id = ? ORDER BY stage_order ASC`, 11) as Array<{ status_key: string }>;
      expect(sprintRows).toEqual([]);
    } finally {
      await stopTestServer(server);
    }
  });

  it('preserves custom workflow definition statuses during status backfill', async () => {
    const db = getDb();
    await db.run(`INSERT INTO sprint_types (key, name, is_system, status_seeded_at) VALUES ('custom_workflow', 'Custom Workflow', 0, datetime('now'))`);
    await db.run(`
      INSERT INTO sprint_type_task_statuses (
        sprint_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json
      ) VALUES
        ('custom_workflow', 'intake', 'Intake', 'slate', 0, 0, '["done"]', 0, 1, '{}'),
        ('custom_workflow', 'done', 'Done', 'green', 1, 0, '[]', 1, 0, '{}')
    `);

    await seedSprintTypeTaskStatuses(db, 'custom_workflow');

    const rows = await db.all(`
      SELECT status_key
      FROM sprint_type_task_statuses
      WHERE sprint_type_key = ?
      ORDER BY stage_order ASC
    `, 'custom_workflow') as Array<{ status_key: string }>;
    expect(rows.map((row) => row.status_key)).toEqual(['intake', 'done']);
  });

  it('keeps an initialized sprint empty after deleting its last sprint-scoped status', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`
        INSERT INTO sprints (id, project_id, name, sprint_type, task_policy_seeded_at)
        VALUES (12, 1, 'Custom Sprint', 'generic', datetime('now'))
      `);
      await db.run(`
        INSERT INTO sprint_task_statuses (
          sprint_id, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json
        ) VALUES (12, 'only_status', 'Only Status', 'amber', 0, 1, '[]', 0, 1, '{}')
      `);

      const deleteResponse = await fetch(`${baseUrl}/api/v1/routing/statuses/only_status?sprint_id=12`, {
        method: 'DELETE',
      });
      expect(deleteResponse.status).toBe(200);

      const listResponse = await fetch(`${baseUrl}/api/v1/routing/statuses?sprint_id=12`);
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toEqual({ statuses: [] });
    } finally {
      await stopTestServer(server);
    }
  });

  it('lists the default agent_started workflow event mapping, removes dispatched from seeded dev sprint statuses, and excludes approved_for_merge visible transitions', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const db = getDb();
      await db.run(`INSERT INTO projects (id, name) VALUES (86, 'Agent HQ')`);
      await db.run(`INSERT OR IGNORE INTO sprint_types (key, name, is_system) VALUES ('dev', 'Development', 1)`);

      const policy = require('../domains/routing/policy') as typeof import('../domains/routing/policy');
      const externalEvents = require('../domains/routing/externalEventMappings') as typeof import('../domains/routing/externalEventMappings');
      policy.seedSprintTypeTaskStatuses(db, 'dev', { force: true });
      externalEvents.seedDefaultExternalEventMappings(db);

      const mappingResponse = await fetch(`${baseUrl}/api/v1/routing/workflow-event-mappings?project_id=86`);
      expect(mappingResponse.status).toBe(200);
      const mappingBody = await mappingResponse.json() as { mappings: ExternalEventMapping[] };
      expect(mappingBody.mappings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event_name: 'agent_started',
          source: 'agent_hq_runtime',
          event_model: 'workflow_event',
          source_kind: 'agent_hq_internal',
          source_label: 'Agent HQ runtime',
          action_kind: 'status',
          action_target: 'in_progress',
          status_excludes: expect.arrayContaining(['blocked']),
          enabled: 1,
        }),
        expect.objectContaining({
          event_name: 'no_semantic_handoff_posted',
          source: 'agent_hq_runtime',
          action_kind: 'ignore',
          action_target: null,
          enabled: 1,
        }),
        expect.objectContaining({
          event_name: 'missing_outcome',
          source: 'agent_hq_runtime',
          action_kind: 'ignore',
          action_target: null,
          enabled: 1,
        }),
        expect.objectContaining({
          event_name: 'unknown_outcome',
          source: 'agent_hq_runtime',
          action_kind: 'ignore',
          action_target: null,
          enabled: 1,
        }),
        expect.objectContaining({
          event_name: 'dispatch_startup_failed',
          source: 'agent_hq_dispatcher',
          event_model: 'workflow_event',
          source_kind: 'agent_hq_internal',
          source_label: 'Agent HQ dispatcher',
          action_kind: 'status',
          action_target: 'stalled',
          apply_failure_detail: 1,
          enabled: 1,
        }),
      ]));

      const statusesBody = await policy.listSprintTypeTaskStatuses(db, 'dev') as Array<{ name: string; allowed_transitions: string[] }>;
      expect(statusesBody.map((status) => status.name)).not.toContain('dispatched');
      expect(statusesBody.find((status) => status.name === 'ready')).toEqual(expect.objectContaining({
        allowed_transitions: expect.not.arrayContaining(['dispatched']),
      }));
      expect(statusesBody.find((status) => status.name === 'needs_attention')).toEqual(expect.objectContaining({
        allowed_transitions: expect.not.arrayContaining(['dispatched']),
      }));
      expect(statusesBody.find((status) => status.name === 'ready_to_merge')).toEqual(expect.objectContaining({
        allowed_transitions: expect.arrayContaining(['blocked', 'failed']),
      }));

      policy.seedSprintTaskPolicy(db, 57, { force: true });

      const sprintRows = await db.all(`SELECT status_key FROM sprint_task_statuses WHERE sprint_id = ? ORDER BY stage_order ASC`, 57) as Array<{ status_key: string }>;
      expect(sprintRows.map((row) => row.status_key)).not.toContain('dispatched');

      const rawTransitionRows = await db.all(`SELECT outcome FROM sprint_task_transitions WHERE sprint_id = ? ORDER BY id ASC`, 57) as Array<{ outcome: string }>;
      expect(rawTransitionRows.map((row) => row.outcome)).not.toContain('approved_for_merge');
    } finally {
      await stopTestServer(server);
    }
  });

  it('creates, updates, and deletes workflow event mappings through the routing API', async () => {
    const { server, baseUrl } = await startTestServer();

    try {
      const createResponse = await fetch(`${baseUrl}/api/v1/routing/workflow-event-mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: 1,
          source: 'dev_environment_lease_manager',
          event_name: 'review_ready',
          task_type: 'backend',
          status_includes: ['in_progress'],
          status_excludes: ['done'],
          action_kind: 'outcome',
          action_target: 'completed_for_review',
          apply_review_evidence: true,
          enabled: true,
          priority: 80,
        }),
      });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as ExternalEventMapping;
      expect(created.event_name).toBe('review_ready');
      expect(created.project_id).toBe(1);
      expect(created.apply_review_evidence).toBe(1);

      const listResponse = await fetch(`${baseUrl}/api/v1/routing/workflow-event-mappings?project_id=1`);
      expect(listResponse.status).toBe(200);
      const listBody = await listResponse.json() as { mappings: ExternalEventMapping[] };
      expect(listBody.mappings).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: created.id, event_name: 'review_ready', event_model: 'workflow_event', source_kind: 'external_integration' }),
      ]));

      const compatibilityListResponse = await fetch(`${baseUrl}/api/v1/routing/external-event-mappings?project_id=1`);
      expect(compatibilityListResponse.status).toBe(200);
      await expect(compatibilityListResponse.json()).resolves.toEqual(expect.objectContaining({
        mappings: expect.arrayContaining([expect.objectContaining({ id: created.id, event_name: 'review_ready' })]),
      }));

      const updateResponse = await fetch(`${baseUrl}/api/v1/routing/workflow-event-mappings/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action_kind: 'status',
          action_target: 'dev_deploying',
          apply_review_evidence: false,
          apply_failure_detail: true,
          enabled: false,
          priority: 40,
        }),
      });
      expect(updateResponse.status).toBe(200);
      const updated = await updateResponse.json() as ExternalEventMapping;
      expect(updated.action_kind).toBe('status');
      expect(updated.action_target).toBe('dev_deploying');
      expect(updated.apply_failure_detail).toBe(1);
      expect(updated.enabled).toBe(0);
      expect(await resolveWorkflowEventMapping(getDb(), {
                  source: 'dev_environment_lease_manager',
                  eventName: 'review_ready',
                  projectId: 1,
                  taskType: 'backend',
                  currentStatus: 'in_progress',
                })).toBeNull();

      const deleteResponse = await fetch(`${baseUrl}/api/v1/routing/workflow-event-mappings/${created.id}`, {
        method: 'DELETE',
      });
      expect(deleteResponse.status).toBe(200);
      await expect(deleteResponse.json()).resolves.toEqual(expect.objectContaining({ ok: true, deleted: true, id: created.id }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('filters workflow event mappings by tenant including global rows', async () => {
    const { server, baseUrl } = await startTestServer();

    try {
      const db = getDb();
      const tenantContext = require('../lib/tenantContext') as typeof import('../lib/tenantContext');
      tenantContext.ensureTenantSchema(db);
      await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (2, 'EcoPool', 'ecopool', 0)`);
      await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (91, 2, 'Pool Client Import')`);
      await db.run(`
        INSERT INTO external_event_mappings (
          tenant_id, project_id, source, event_name, task_type, status_includes_json, status_excludes_json,
          action_kind, action_target, enabled, priority
        )
        VALUES
          (1, NULL, 'agent_hq_runtime', 'default_only_event', NULL, '[]', '[]', 'status', 'in_progress', 1, 50),
          (2, NULL, 'agent_hq_runtime', 'ecopool_global_event', NULL, '[]', '[]', 'status', 'ready', 1, 50),
          (2, 91, 'agent_hq_runtime', 'ecopool_project_event', NULL, '[]', '[]', 'outcome', 'completed_for_review', 1, 60)
      `);

      await db.run(`UPDATE app_settings SET value = '2' WHERE key = 'active_tenant_id'`);
      const response = await fetch(`${baseUrl}/api/v1/routing/workflow-event-mappings?project_id=91`);
      expect(response.status).toBe(200);
      const body = await response.json() as { mappings: ExternalEventMapping[] };
      expect(body.mappings.map((mapping) => mapping.event_name)).toEqual(expect.arrayContaining([
        'ecopool_global_event',
        'ecopool_project_event',
      ]));
      expect(body.mappings.map((mapping) => mapping.event_name)).not.toContain('default_only_event');

      const defaultMapping = await db.get(`SELECT id FROM external_event_mappings WHERE event_name = 'default_only_event'`) as { id: number };
      await expect(fetch(`${baseUrl}/api/v1/routing/workflow-event-mappings/${defaultMapping.id}`)).resolves.toMatchObject({ status: 404 });
    } finally {
      await stopTestServer(server);
    }
  });

  it('surfaces conflicting enabled workflow event mappings with a 409 response', async () => {
    const { server, baseUrl } = await startTestServer();

    try {
      const firstResponse = await fetch(`${baseUrl}/api/v1/routing/workflow-event-mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: 1,
          source: 'dev_environment_lease_manager',
          event_name: 'deploy_failed',
          task_type: 'backend',
          action_kind: 'outcome',
          action_target: 'env_blocked',
          enabled: true,
          priority: 90,
        }),
      });
      expect(firstResponse.status).toBe(201);

      const conflictResponse = await fetch(`${baseUrl}/api/v1/routing/workflow-event-mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: 1,
          source: 'dev_environment_lease_manager',
          event_name: 'deploy_failed',
          task_type: 'backend',
          action_kind: 'status',
          action_target: 'blocked',
          enabled: true,
          priority: 90,
        }),
      });
      expect(conflictResponse.status).toBe(409);
      await expect(conflictResponse.json()).resolves.toEqual(expect.objectContaining({
        error: expect.stringContaining('Conflicting enabled mapping already exists'),
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects unknown status and outcome targets for workflow event mappings', async () => {
    const { server, baseUrl } = await startTestServer();

    try {
      const invalidStatusResponse = await fetch(`${baseUrl}/api/v1/routing/workflow-event-mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'dev_environment_lease_manager',
          event_name: 'custom_progress',
          action_kind: 'status',
          action_target: 'not_a_real_status',
        }),
      });
      expect(invalidStatusResponse.status).toBe(400);
      await expect(invalidStatusResponse.json()).resolves.toEqual(expect.objectContaining({
        error: expect.stringContaining('Unknown status action_target'),
      }));

      const invalidOutcomeResponse = await fetch(`${baseUrl}/api/v1/routing/workflow-event-mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'dev_environment_lease_manager',
          event_name: 'custom_complete',
          action_kind: 'outcome',
          action_target: 'not_a_real_outcome',
        }),
      });
      expect(invalidOutcomeResponse.status).toBe(400);
      await expect(invalidOutcomeResponse.json()).resolves.toEqual(expect.objectContaining({
        error: expect.stringContaining('Unknown outcome action_target'),
      }));

      const invalidGuardResponse = await fetch(`${baseUrl}/api/v1/routing/workflow-event-mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'dev_environment_lease_manager',
          event_name: 'custom_guard',
          status_includes: ['ghost_status'],
          action_kind: 'status',
          action_target: 'dev_deploying',
        }),
      });
      expect(invalidGuardResponse.status).toBe(400);
      await expect(invalidGuardResponse.json()).resolves.toEqual(expect.objectContaining({
        error: expect.stringContaining('Unknown status guard'),
      }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('validates workflow event status targets against the selected workflow type context', async () => {
    const { server, baseUrl } = await startTestServer();

    try {
      const db = getDb();
      await db.run(`INSERT INTO sprint_types (key, name, is_system, status_seeded_at) VALUES ('elevation_build', 'Elevation Build', 0, datetime('now'))`);
      await db.run(`
        INSERT INTO sprint_type_task_statuses (
          sprint_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json
        )
        VALUES
          ('elevation_build', 'intake', 'Intake', 'cyan', 0, 0, '["framing"]', 0, 1, '{}'),
          ('elevation_build', 'framing', 'Framing', 'amber', 0, 0, '["complete"]', 1, 0, '{}'),
          ('elevation_build', 'complete', 'Complete', 'green', 1, 0, '[]', 2, 0, '{}')
      `);

      const validResponse = await fetch(`${baseUrl}/api/v1/routing/workflow-event-mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sprint_type: 'elevation_build',
          source: 'construction_events',
          event_name: 'estimate_received',
          status_includes: ['intake'],
          action_kind: 'status',
          action_target: 'framing',
        }),
      });
      expect(validResponse.status).toBe(201);
      await expect(validResponse.json()).resolves.toEqual(expect.objectContaining({
        event_name: 'estimate_received',
        action_kind: 'status',
        action_target: 'framing',
        status_includes: ['intake'],
      }));

      const invalidResponse = await fetch(`${baseUrl}/api/v1/routing/workflow-event-mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sprint_type: 'elevation_build',
          source: 'construction_events',
          event_name: 'legacy_dev_status',
          action_kind: 'status',
          action_target: 'dev_deploying',
        }),
      });
      expect(invalidResponse.status).toBe(400);
      await expect(invalidResponse.json()).resolves.toEqual(expect.objectContaining({
        error: expect.stringContaining('not valid for the selected workflow context'),
      }));

      const invalidGuardResponse = await fetch(`${baseUrl}/api/v1/routing/workflow-event-mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sprint_type: 'elevation_build',
          source: 'construction_events',
          event_name: 'bad_guard',
          status_excludes: ['dev_deploying'],
          action_kind: 'status',
          action_target: 'intake',
        }),
      });
      expect(invalidGuardResponse.status).toBe(400);
      await expect(invalidGuardResponse.json()).resolves.toEqual(expect.objectContaining({
        error: expect.stringContaining('not valid for the selected workflow context'),
      }));

      const legacyResponse = await fetch(`${baseUrl}/api/v1/routing/workflow-event-mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'dev_environment_lease_manager',
          event_name: 'legacy_contextless',
          action_kind: 'status',
          action_target: 'dev_deploying',
        }),
      });
      expect(legacyResponse.status).toBe(201);
    } finally {
      await stopTestServer(server);
    }
  });

  it('lists and resolves workflow event default and override scopes with task-type matching', async () => {
    const { server, baseUrl } = await startTestServer();

    try {
      const db = getDb();
      await db.exec(`
        ALTER TABLE external_event_mappings ADD COLUMN sprint_id INTEGER;
        ALTER TABLE external_event_mappings ADD COLUMN sprint_type TEXT;
      `);
      await db.run(`INSERT INTO sprints (id, name, project_id, sprint_type) VALUES (501, 'Scoped Workflow', 1, 'generic')`);
      await seedSprintTaskPolicy(db, 501);

      const defaultResponse = await fetch(`${baseUrl}/api/v1/routing/workflow-event-mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: 1,
          sprint_type: 'generic',
          source: 'construction_events',
          event_name: 'vendor_ready',
          task_type: null,
          status_includes: ['ready'],
          action_kind: 'status',
          action_target: 'in_progress',
          priority: 70,
        }),
      });
      expect(defaultResponse.status).toBe(201);
      const defaultMapping = await defaultResponse.json() as ExternalEventMapping;
      expect(defaultMapping.scope_kind).toBe('sprint_type_default');
      expect(defaultMapping.sprint_id).toBeNull();
      expect(defaultMapping.sprint_type).toBe('generic');

      const overrideResponse = await fetch(`${baseUrl}/api/v1/routing/workflow-event-mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: 1,
          workflow_id: 501,
          source: 'construction_events',
          event_name: 'vendor_ready',
          task_type: 'backend',
          status_includes: ['ready'],
          action_kind: 'outcome',
          action_target: 'completed_for_review',
          priority: 70,
        }),
      });
      const overrideBody = await overrideResponse.json() as ExternalEventMapping | { error?: string };
      expect({ status: overrideResponse.status, body: overrideBody }).toEqual(expect.objectContaining({ status: 201 }));
      const overrideMapping = overrideBody as ExternalEventMapping;
      expect(overrideMapping.scope_kind).toBe('sprint_override');
      expect(overrideMapping.sprint_id).toBe(501);
      expect(overrideMapping.sprint_type).toBe('generic');

      const listResponse = await fetch(`${baseUrl}/api/v1/routing/workflow-event-mappings?project_id=1&workflow_id=501&workflow_type=generic`);
      expect(listResponse.status).toBe(200);
      const listBody = await listResponse.json() as { mappings: ExternalEventMapping[] };
      expect(listBody.mappings).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: defaultMapping.id, scope_kind: 'sprint_type_default', is_inherited: true, is_override: false }),
        expect.objectContaining({ id: overrideMapping.id, scope_kind: 'sprint_override', is_inherited: false, is_override: true }),
      ]));

      const backendMatch = await resolveWorkflowEventMapping(db, {
              source: 'construction_events',
              eventName: 'vendor_ready',
              tenantId: null,
              projectId: 1,
              sprintId: 501,
              sprintType: 'generic',
              taskType: 'backend',
              currentStatus: 'ready',
            });
      expect(backendMatch).toEqual(expect.objectContaining({ id: overrideMapping.id, action_kind: 'outcome' }));

      const frontendMatch = await resolveWorkflowEventMapping(db, {
              source: 'construction_events',
              eventName: 'vendor_ready',
              tenantId: null,
              projectId: 1,
              sprintId: 501,
              sprintType: 'generic',
              taskType: 'frontend',
              currentStatus: 'ready',
            });
      expect(frontendMatch).toEqual(expect.objectContaining({ id: defaultMapping.id, action_kind: 'status' }));
    } finally {
      await stopTestServer(server);
    }
  });

  it('reads and writes sprint-type-specific contract templates with fallback', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const genericResponse = await fetch(`${baseUrl}/api/v1/routing/agent-contract?sprint_type=generic`);
      expect(genericResponse.status).toBe(200);
      const genericBody = await genericResponse.json() as { sprint_type: string; content: string; inherited_from: string | null; placeholders: string[]; format: string };
      expect(genericBody.sprint_type).toBe('generic');
      expect(genericBody.inherited_from).toBeNull();
      expect(genericBody.content).toContain('Sprint type: {{sprintType}}');
      expect(genericBody.placeholders).toEqual(expect.arrayContaining(['sprintType', 'taskId', 'validOutcomes', 'evidenceFieldsBulleted']));
      expect(genericBody.format).toBe('plain_text_v1');

      const bugsResponse = await fetch(`${baseUrl}/api/v1/routing/agent-contract?sprint_type=bugs`);
      expect(bugsResponse.status).toBe(200);
      const bugsBody = await bugsResponse.json() as { sprint_type: string; content: string; inherited_from: string | null };
      expect(bugsBody.sprint_type).toBe('bugs');
      expect(bugsBody.inherited_from).toBeNull();
      expect(bugsBody.content).toContain('## Agent HQ bug-fix contract for this dispatched instance');
      expect(bugsBody.content).toContain('REQUIRED OUTPUTS FOR BUGS');

      const sprintSpecificResponse = await fetch(`${baseUrl}/api/v1/routing/agent-contract?sprint_type=enhancements`);
      expect(sprintSpecificResponse.status).toBe(200);
      const sprintSpecificBody = await sprintSpecificResponse.json() as { sprint_type: string; content: string; inherited_from: string | null };
      expect(sprintSpecificBody.sprint_type).toBe('enhancements');
      expect(sprintSpecificBody.inherited_from).toBeNull();
      expect(sprintSpecificBody.content.trim()).not.toHaveLength(0);

      const savedContent = 'enhancements only {{taskId}}';
      const saveResponse = await fetch(`${baseUrl}/api/v1/routing/agent-contract`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sprint_type: 'enhancements', content: savedContent }),
      });
      expect(saveResponse.status).toBe(200);

      const directResponse = await fetch(`${baseUrl}/api/v1/routing/agent-contract?sprint_type=enhancements`);
      expect(directResponse.status).toBe(200);
      await expect(directResponse.json()).resolves.toEqual(expect.objectContaining({
        sprint_type: 'enhancements',
        content: savedContent,
        inherited_from: null,
        format: 'plain_text_v1',
        placeholders: expect.arrayContaining(['agentSlug', 'taskStatus']),
      }));

      const qaResponse = await fetch(`${baseUrl}/api/v1/routing/agent-contract?sprint_type=qa`);
      expect(qaResponse.status).toBe(404);
    } finally {
      await stopTestServer(server);
    }
  });
});
