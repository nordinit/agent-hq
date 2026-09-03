import express from 'express';
import type { Server } from 'http';
import type { Db } from '../db/adapter/types';
import { getDb } from '../db/client';
import { verifyStartupSchema } from '../db/startupVerifier';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import {
  authenticateMcpApiKeyIfPresent,
  authorizeMcpApiRequestIfPresent,
  ensureConfiguredRuntimeMcpApiKey,
  getAgentMcpPermissionPolicy,
  issueMcpApiKeyForAgent,
  replaceAgentMcpPermissionPolicy,
  resolveMcpApiIdentityForKey,
  resetAgentMcpPermissionPolicy,
} from './mcpApiAuth';
import { handleJsonRequestErrors } from './jsonRequestErrors';
import { getDefaultTenantId, resolveTenantIdFromRequest } from './tenantContext';
import projectFilesRouter from '../routes/project-files';

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

/**
 * The tenants, projects, workflows, agents, tasks and runs every scope assertion below reasons
 * about.
 *
 * This replaces a hand-written 15-table CREATE TABLE fixture, and the real baseline carries the
 * foreign keys that fixture left out. Two consequences are not obvious from the row order alone:
 * every parent must exist before its children, and tasks/job_instances reference each other
 * (tasks.active_instance_id against job_instances.task_id), so that cycle is broken by inserting
 * the tasks first and linking the active instance afterwards.
 */
async function seedScopeFixture(db: Db): Promise<void> {
  // State tenant selection explicitly so this fixture never depends on installation seeding.
  await db.run(
    `INSERT INTO tenants (id, name, slug, is_default) VALUES (?, ?, ?, ?), (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    1, 'Default Tenant', 'default', 1, 2, 'EcoPool', 'ecopool', 0,
  );
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1') ON CONFLICT DO NOTHING`);
  await db.run(
    `INSERT INTO projects (id, tenant_id, name) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
    86, 1, 'Agent HQ', 87, 1, 'Other Tenant One Project', 99, 2, 'EcoPool Project',
  );
  // Sprint 45 sits in the assigned project without being the dispatched one, which is what
  // separates the two workflow-lifecycle scope tiers: sprint 42 is reachable because it is
  // attached to the agent's active task, 45 only because it is inside the assigned project.
  await db.run(`
    INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type, status)
    VALUES (?, ?, ?, ?, 'dev', 'active'), (?, ?, ?, ?, 'dev', 'active'), (?, ?, ?, ?, 'dev', 'active'), (?, ?, ?, ?, 'dev', 'active')
  `, 42, 1, 86, 'Enhancements', 44, 1, 87, 'Other Project Sprint', 43, 2, 99, 'EcoPool Sprint', 45, 1, 86, 'Undispatched Same-Project Sprint');
  // session_key is NOT NULL and unique in the real schema. The admin agent is still named Atlas —
  // that is what makes it trusted — but every fixture agent needs its own key.
  await db.run(`
    INSERT INTO agents (id, tenant_id, project_id, name, session_key, enabled, system_role)
    VALUES (?, ?, ?, ?, ?, 1, NULL),
           (?, ?, ?, ?, ?, 1, 'admin'),
           (?, ?, ?, ?, ?, 1, NULL),
           (?, ?, ?, ?, ?, 1, NULL),
           (?, ?, ?, ?, ?, 1, NULL)
  `,
    7, 1, 86, 'Cinder', 'agent:cinder:main',
    8, 1, 86, 'Atlas', 'agent:atlas-admin:main',
    9, 1, 86, 'QA', 'agent:qa:main',
    10, 2, 99, 'EcoPool Worker', 'agent:ecopool-worker:main',
    11, 1, null, 'No Project Agent', 'agent:no-project:main',
  );
  await db.run(`
    INSERT INTO sprint_task_routing_rules (id, tenant_id, project_id, sprint_id, sprint_type, task_type, status, agent_id, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, 501, 1, 86, null, 'dev', 'backend', 'ready', 7, 10, 502, 1, 86, 42, 'dev', 'qa', 'review', 9, 20, 503, 1, 87, null, 'dev', 'backend', 'ready', 9, 10, 504, 2, 99, null, 'dev', 'backend', 'ready', 10, 10);
  await db.run(`
    INSERT INTO sprint_task_transition_requirements (id, tenant_id, sprint_id, project_id, sprint_type, task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, 601, 1, null, 86, 'dev', null, 'completed_for_review', 'review_commit', 'required', null, 'block', 'Review commit is required', 1, 10, 602, 1, 42, 86, 'dev', 'backend', 'completed_for_review', 'review_branch', 'required', null, 'block', 'Review branch is required', 1, 20, 603, 1, null, 87, 'dev', null, 'completed_for_review', 'review_url', 'required', null, 'block', 'Other project row', 1, 10, 604, 2, null, 99, 'dev', null, 'completed_for_review', 'review_url', 'required', null, 'block', 'Cross tenant row', 1, 10);
  // These three workflow definitions are authoritative: every scope assertion below depends on
  // 'dev' being owned by project 86, so replace any rows left by earlier fixture setup.
  await db.run(`DELETE FROM sprint_types`);
  // sprint_types.project_id is part of the migrated PostgreSQL baseline.
  await db.run(`
    INSERT INTO sprint_types (tenant_id, project_id, key, name, description, is_system)
    VALUES (?, ?, ?, ?, ?, 0), (?, ?, ?, ?, ?, 0), (?, ?, ?, ?, ?, 0)
  `, 1, 86, 'dev', 'Development', 'Agent HQ project development workflow', 1, 87, 'other-project-dev', 'Other project development', 'Other project workflow', 2, 99, 'eco-dev', 'Eco development', 'EcoPool workflow');
  await db.run(`
    INSERT INTO tasks (id, tenant_id, project_id, sprint_id, agent_id, assigned_agent_id, title)
    VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)
  `, 448, 1, 86, 42, 7, 9, 'Dispatched Agent HQ task', 449, 2, 99, 43, 9, 9, 'Cross tenant dispatched task', 450, 2, 99, 43, 10, 10, 'EcoPool worker task', 451, 1, 86, 42, null, null, 'Unassigned Agent HQ task', 452, 1, 87, 44, null, null, 'Other project task');
  await db.run(`
    INSERT INTO job_instances (id, tenant_id, task_id, agent_id, status)
    VALUES (?, ?, ?, ?, 'running'), (?, ?, ?, ?, 'running'), (?, ?, ?, ?, 'running')
  `, 2551, 1, 448, 7, 2552, 2, 449, 9, 2553, 2, 450, 10);
  await db.run(`UPDATE tasks SET active_instance_id = ? WHERE id = ?`, 2551, 448);
  await db.run(`UPDATE tasks SET active_instance_id = ? WHERE id = ?`, 2552, 449);
  await db.run(`UPDATE tasks SET active_instance_id = ? WHERE id = ?`, 2553, 450);
  await db.run(`
    INSERT INTO task_relationships (id, source_task_id, target_task_id, relationship_type_key)
    VALUES (?, ?, ?, ?), (?, ?, ?, ?)
  `, 12, 451, 448, 'relates_to', 13, 451, 452, 'relates_to');
}

describe('mcpApiAuth scoped Agent HQ permissions', () => {
  let server: Server | null = null;
  let baseUrl = '';
  let normalKey = '';
  let adminKey = '';
  let ecoKey = '';
  let noProjectKey = '';

  beforeEach(async () => {
    const db = await setupTestDb();
    await seedScopeFixture(db);

    normalKey = (await issueMcpApiKeyForAgent(db, 7)).apiKey;
    adminKey = (await issueMcpApiKeyForAgent(db, 8)).apiKey;
    ecoKey = (await issueMcpApiKeyForAgent(db, 10)).apiKey;
    noProjectKey = (await issueMcpApiKeyForAgent(db, 11)).apiKey;

    const app = express();
    app.use(express.json());
    app.use(handleJsonRequestErrors);
    app.use('/api/v1', authenticateMcpApiKeyIfPresent);
    app.use('/api/v1', authorizeMcpApiRequestIfPresent);

    app.get('/api/v1/tasks/:id', async (req, res) => res.json({ ok: true, task_id: Number(req.params.id), tenant_id: await resolveTenantIdFromRequest(getDb(), req) }));
    app.get('/api/v1/tasks/:id/context', (req, res) => res.json({ ok: true, task_id: Number(req.params.id), mode: req.query.mode ?? 'summary' }));
    app.get('/api/v1/tasks/:id/notes', (req, res) => res.json({ ok: true, task_id: Number(req.params.id), notes: [] }));
    app.get('/api/v1/tasks/:id/history', (req, res) => res.json({ ok: true, task_id: Number(req.params.id), history: [] }));
    app.get('/api/v1/tasks/:id/instances', (req, res) => res.json({ ok: true, task_id: Number(req.params.id) }));
    app.get('/api/v1/tasks/:id/relationships', (req, res) => res.json({ ok: true, task_id: Number(req.params.id), relationships: [] }));
    app.get('/api/v1/tasks/:id/relationship-types', (req, res) => res.json({ ok: true, task_id: Number(req.params.id), relationship_types: [] }));
    app.get('/api/v1/tasks/:id/active-owner', (req, res) => res.json({ ok: true, task_id: Number(req.params.id) }));
    app.get('/api/v1/agents/:id/mcp-permissions', async (req, res) => res.json(await getAgentMcpPermissionPolicy(getDb(), Number(req.params.id))));
    app.post('/api/v1/agents/:id/mcp-permissions', async (req, res) => res.json(await replaceAgentMcpPermissionPolicy(getDb(), Number(req.params.id), req.body.enabled_capabilities)));
    app.put('/api/v1/agents/:id/mcp-permissions', async (req, res) => res.json(await replaceAgentMcpPermissionPolicy(getDb(), Number(req.params.id), req.body.enabled_capabilities)));
    app.delete('/api/v1/agents/:id/mcp-permissions', async (req, res) => res.json(await resetAgentMcpPermissionPolicy(getDb(), Number(req.params.id))));
    app.post('/api/v1/tasks/project-search', (_req, res) => res.json({ ok: true, tasks: [] }));
    app.post('/api/v1/tasks/:id/relationships', (req, res) => res.status(201).json({ ok: true, task_id: Number(req.params.id), body: req.body }));
    app.delete('/api/v1/tasks/:id/relationships/:relationshipId', (req, res) => res.json({ ok: true, task_id: Number(req.params.id), relationship_id: Number(req.params.relationshipId) }));
    app.post('/api/v1/tasks/:id/notes', (req, res) => res.status(201).json({ ok: true, task_id: Number(req.params.id), body: req.body }));
    app.post('/api/v1/tasks/:id/outcome', (req, res) => res.json({ ok: true, task_id: Number(req.params.id), body: req.body }));
    app.put('/api/v1/instances/:id/start', (req, res) => res.json({ ok: true, instance_id: Number(req.params.id), body: req.body }));
    app.post('/api/v1/projects', (req, res) => res.status(201).json({ ok: true, body: req.body }));
    app.get('/api/v1/projects/:id', (req, res) => res.json({ ok: true, project_id: Number(req.params.id) }));
    app.delete('/api/v1/projects/:id', (req, res) => res.json({ ok: true, project_id: Number(req.params.id) }));
    app.get('/api/v1/agents', (req, res) => res.json({ ok: true, query: req.query }));
    app.post('/api/v1/agents', (req, res) => res.status(201).json({ ok: true, body: req.body }));
    app.get('/api/v1/agents/:id', (req, res) => res.json({ ok: true, agent_id: Number(req.params.id) }));
    app.put('/api/v1/agents/:id', (req, res) => res.json({ ok: true, agent_id: Number(req.params.id), body: req.body }));
    app.delete('/api/v1/agents/:id', (req, res) => res.json({ ok: true, agent_id: Number(req.params.id) }));
    app.get('/api/v1/agents/:id/docs', (req, res) => res.json({ ok: true, agent_id: Number(req.params.id) }));
    app.post('/api/v1/mcp-servers', (_req, res) => res.status(201).json({ ok: true }));
    app.use('/api/v1/projects/:id/files', projectFilesRouter);
    app.get('/api/v1/sprints/workflow-metadata', async (req, res) => res.json({
      ok: true,
      tenant_id: await resolveTenantIdFromRequest(getDb(), req),
      sprint_type: req.query.sprint_type ?? 'generic',
      task_type: req.query.task_type ?? null,
      statuses: [],
      outcomes: [],
      relationship_types: [],
    }));
    app.get('/api/v1/sprints/:id', (req, res) => res.json({ ok: true, sprint_id: Number(req.params.id) }));
    // Both spellings, because req.path is what the policy matches and /api/v1/workflows mounts
    // the same router in the real app without any path rewriting.
    for (const prefix of ['/api/v1/sprints', '/api/v1/workflows']) {
      app.put(`${prefix}/:id`, (req, res) => res.json({ ok: true, sprint_id: Number(req.params.id), body: req.body }));
      app.post(`${prefix}/:id/complete`, (req, res) => res.json({ ok: true, sprint_id: Number(req.params.id), status: 'complete' }));
      app.post(`${prefix}/:id/close`, (req, res) => res.json({ ok: true, sprint_id: Number(req.params.id), status: 'closed' }));
    }
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
    app.get('/api/v1/routing/transition-requirements', (req, res) => res.json({ ok: true, query: req.query }));
    app.post('/api/v1/routing/transition-requirements', (req, res) => res.status(201).json({ ok: true, body: req.body }));
    app.put('/api/v1/routing/transition-requirements/:id', (req, res) => res.json({ ok: true, requirement_id: Number(req.params.id), body: req.body }));
    app.delete('/api/v1/routing/transition-requirements/:id', (req, res) => res.json({ ok: true, requirement_id: Number(req.params.id), query: req.query }));
    app.get('/api/v1/routing/graph', (req, res) => res.json({ ok: true, query: req.query }));
    app.get('/api/v1/routing/trace', (req, res) => res.json({ ok: true, query: req.query }));
    app.post('/api/v1/routing/trace', (req, res) => res.json({ ok: true, body: req.body }));
    app.post('/api/v1/routing/preview', (req, res) => res.json({ ok: true, body: req.body }));
    app.get('/api/v1/routing/audit', (req, res) => res.json({ ok: true, query: req.query }));
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
    // Statuses, outcomes and relationship types across all three spellings. These are child rows
    // of a workflow definition and were unreachable without an admin key until the policy branch
    // learned about them.
    for (const prefix of ['/api/v1/sprints', '/api/v1/workflows', '/api/v1/workflow-definitions']) {
      for (const sub of ['statuses', 'outcomes', 'relationship-types']) {
        app.get(`${prefix}/types/:key/${sub}`, (req, res) => res.json({ ok: true, key: req.params.key, sub, query: req.query }));
        app.get(`${prefix}/types/:key/${sub}/:childId`, (req, res) => res.json({ ok: true, key: req.params.key, sub, child_id: req.params.childId }));
        app.post(`${prefix}/types/:key/${sub}`, (req, res) => res.status(201).json({ ok: true, key: req.params.key, sub, body: req.body }));
        app.put(`${prefix}/types/:key/${sub}/:childId`, (req, res) => res.json({ ok: true, key: req.params.key, sub, child_id: req.params.childId, body: req.body }));
        app.delete(`${prefix}/types/:key/${sub}/:childId`, (req, res) => res.json({ ok: true, key: req.params.key, sub, child_id: req.params.childId }));
      }
    }
    app.post('/api/v1/external/task-events', (_req, res) => res.status(202).json({ ok: true }));
    app.post('/api/v1/tasks', (_req, res) => res.status(201).json({ ok: true }));
    app.put('/api/v1/tasks/:id', (req, res) => res.json({ ok: true, task_id: Number(req.params.id), body: req.body }));
    app.delete('/api/v1/tasks/:id', (req, res) => res.json({ ok: true, task_id: Number(req.params.id) }));
    app.get('/api/v1/tasks', (req, res) => res.json({ ok: true, query: req.query, tasks: [] }));
    app.get('/api/v1/projects', (_req, res) => res.json({ ok: true, projects: [] }));
    app.get('/api/v1/sprints', (req, res) => res.json({ ok: true, query: req.query, sprints: [] }));
    app.get('/api/v1/workflows', (req, res) => res.json({ ok: true, query: req.query, workflows: [] }));
    app.get('/api/v1/workflows/workflow-metadata', (req, res) => res.json({ ok: true, query: req.query }));
    // Registered after every literal /workflows/* path above so it cannot shadow them. The real
    // router is ordered the same way and additionally rejects a non-numeric :id up front.
    app.get('/api/v1/workflows/:id', (req, res) => res.json({ ok: true, sprint_id: Number(req.params.id) }));

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
    await teardownTestDb();
  });

  function authHeaders(apiKey: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-agent-hq-mcp-client': 'agent-hq-mcp',
      authorization: `Bearer ${apiKey}`,
    };
  }

  it('refuses lifecycle writes once the instance has reached a terminal status', async () => {
    // The other half of the contract: a finished run must not still accept lifecycle callbacks.
    // Cleared as the task's active instance too, since that alone would keep it in scope.
    await getDb().run(`UPDATE job_instances SET status = 'done' WHERE id = 2551`);
    await getDb().run(`UPDATE tasks SET active_instance_id = NULL WHERE id = 448`);
    const res = await fetch(`${baseUrl}/api/v1/instances/2551/start`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ session_key: 'run:2551' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as { code?: string }).code).toBe('mcp_scope_denied');
  });

  it('distinguishes a wrong-method lifecycle call from an out-of-scope one', async () => {
    // These two failures used to share one reason string, which made a production denial
    // impossible to attribute. check-in is POST, so PUT must fail on the method, not the scope.
    const res = await fetch(`${baseUrl}/api/v1/instances/2551/check-in`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ note: 'progress' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as { error?: string }).error).toMatch(/not the correct method/i);
  });

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
    expect(routingRes.status).toBe(403);
    await expect(routingRes.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'routing_transitions.manage_project_scope' },
    });
  });

  describe('workflow lifecycle writes', () => {
    const PAUSE = 'sprints.pause_active_sprint';
    const COMPLETE = 'sprints.complete_active_sprint';

    const put = (sprintPath: string, body: Record<string, unknown>) => fetch(`${baseUrl}${sprintPath}`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify(body),
    });
    const post = (sprintPath: string) => fetch(`${baseUrl}${sprintPath}`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({}),
    });

    it('withholds both lifecycle capabilities from a scoped runtime key by default', async () => {
      // Neither is defaultEnabled for scoped_runtime: ending or holding a cycle is an explicit
      // grant, not something every dispatched agent picks up by existing.
      const pauseRes = await put('/api/v1/sprints/42', { status: 'paused' });
      expect(pauseRes.status).toBe(403);
      await expect(pauseRes.json()).resolves.toMatchObject({
        code: 'mcp_scope_denied',
        details: { required_capability: PAUSE },
      });

      const completeRes = await post('/api/v1/sprints/42/complete');
      expect(completeRes.status).toBe(403);
      await expect(completeRes.json()).resolves.toMatchObject({
        code: 'mcp_scope_denied',
        details: { required_capability: COMPLETE },
      });
    });

    it('pauses and resumes the workflow attached to the active dispatched task', async () => {
      await replaceAgentMcpPermissionPolicy(getDb(), 7, [PAUSE]);

      await expect(put('/api/v1/sprints/42', { status: 'paused' }).then((r) => r.status)).resolves.toBe(200);
      await expect(put('/api/v1/sprints/42', { status: 'active' }).then((r) => r.status)).resolves.toBe(200);
      await expect(put('/api/v1/sprints/42', { status: 'planning' }).then((r) => r.status)).resolves.toBe(200);
      // An audit note rides along without turning the patch into a general edit.
      await expect(put('/api/v1/sprints/42', { status: 'paused', note: 'Blocked on review' }).then((r) => r.status)).resolves.toBe(200);
    });

    it('accepts the workflow path spelling as well as the sprint one', async () => {
      // req.path is not alias-normalized, so a policy branch that matched only /sprints would
      // silently refuse every caller using the preferred spelling.
      await replaceAgentMcpPermissionPolicy(getDb(), 7, [PAUSE, COMPLETE]);

      await expect(put('/api/v1/workflows/42', { status: 'paused' }).then((r) => r.status)).resolves.toBe(200);
      await expect(post('/api/v1/workflows/42/complete').then((r) => r.status)).resolves.toBe(200);
      await expect(post('/api/v1/workflows/42/close').then((r) => r.status)).resolves.toBe(200);

      await replaceAgentMcpPermissionPolicy(getDb(), 7, ['sprints.read_active_sprint']);
      const readRes = await fetch(`${baseUrl}/api/v1/workflows/42`, { headers: authHeaders(normalKey) });
      expect(readRes.status).toBe(200);
    });

    it('reaches a workflow inside the assigned project that is not the dispatched one', async () => {
      // The board-scoped tier. Sprint 45 is in project 86 but attached to no task of agent 7.
      await replaceAgentMcpPermissionPolicy(getDb(), 7, [PAUSE, COMPLETE]);

      await expect(put('/api/v1/sprints/45', { status: 'paused' }).then((r) => r.status)).resolves.toBe(200);
      await expect(post('/api/v1/sprints/45/complete').then((r) => r.status)).resolves.toBe(200);
    });

    it('refuses a workflow outside the assigned project or tenant', async () => {
      await replaceAgentMcpPermissionPolicy(getDb(), 7, [PAUSE, COMPLETE]);

      const otherProject = await put('/api/v1/sprints/44', { status: 'paused' });
      expect(otherProject.status).toBe(403);
      await expect(otherProject.json()).resolves.toMatchObject({
        code: 'mcp_scope_denied',
        details: { required_capability: PAUSE },
      });

      const crossTenant = await post('/api/v1/sprints/43/complete');
      expect(crossTenant.status).toBe(403);
    });

    it('separates holding a cycle from ending one', async () => {
      // Pausing must not imply completing: the first is reversible, the second stamps the end
      // date and stands the workflow's agents down.
      await replaceAgentMcpPermissionPolicy(getDb(), 7, [PAUSE]);

      const completeRes = await post('/api/v1/sprints/42/complete');
      expect(completeRes.status).toBe(403);
      await expect(completeRes.json()).resolves.toMatchObject({
        code: 'mcp_scope_denied',
        details: { required_capability: COMPLETE },
      });

      const closeRes = await post('/api/v1/sprints/42/close');
      expect(closeRes.status).toBe(403);

      await replaceAgentMcpPermissionPolicy(getDb(), 7, [COMPLETE]);
      await expect(post('/api/v1/sprints/42/complete').then((r) => r.status)).resolves.toBe(200);
      await expect(post('/api/v1/sprints/42/close').then((r) => r.status)).resolves.toBe(200);
      // ...and completing must not imply pausing.
      const pauseRes = await put('/api/v1/sprints/42', { status: 'paused' });
      expect(pauseRes.status).toBe(403);
      await expect(pauseRes.json()).resolves.toMatchObject({
        details: { required_capability: PAUSE },
      });
    });

    it('refuses a status patch that smuggles in any other workflow field', async () => {
      // This is the whole reason the body guard exists. Without it the pause grant would also
      // rename workflows, rewrite repo configuration, and — via project_id — move a workflow
      // into another project.
      await replaceAgentMcpPermissionPolicy(getDb(), 7, [PAUSE, COMPLETE]);

      for (const body of [
        { status: 'paused', project_id: 87 },
        { status: 'paused', name: 'Renamed' },
        { status: 'paused', repo_url: 'git@github.com:attacker/repo.git' },
        { status: 'paused', ended_at: '2026-01-01' },
        { name: 'Renamed' },
      ]) {
        const res = await put('/api/v1/sprints/42', body);
        expect({ body, status: res.status }).toEqual({ body, status: 403 });
        await expect(res.json()).resolves.toMatchObject({
          details: { required_capability: 'admin.full_access' },
        });
      }
    });

    it('refuses to reach a terminal status through the status field write', async () => {
      // complete and closed have their own endpoints, which stamp ended_at. A field write to
      // 'complete' would leave a workflow that reads as finished but never ended, so it falls
      // through to the administrative deny rather than riding in on the pause grant.
      await replaceAgentMcpPermissionPolicy(getDb(), 7, [PAUSE, COMPLETE]);

      for (const status of ['complete', 'closed']) {
        const res = await put('/api/v1/sprints/42', { status });
        expect({ status, code: res.status }).toEqual({ status, code: 403 });
        await expect(res.json()).resolves.toMatchObject({
          details: { required_capability: 'admin.full_access' },
        });
      }
    });

    it('leaves general workflow editing to administrative keys', async () => {
      await replaceAgentMcpPermissionPolicy(getDb(), 7, [PAUSE, COMPLETE]);
      await expect(put('/api/v1/sprints/42', { goal: 'Rewritten goal' }).then((r) => r.status)).resolves.toBe(403);

      const adminRes = await fetch(`${baseUrl}/api/v1/sprints/42`, {
        method: 'PUT',
        headers: authHeaders(adminKey),
        body: JSON.stringify({ goal: 'Rewritten goal' }),
      });
      expect(adminRes.status).toBe(200);
    });

    it('refuses a key with no assigned project and no dispatched workflow', async () => {
      await replaceAgentMcpPermissionPolicy(getDb(), 11, [PAUSE, COMPLETE]);

      const res = await fetch(`${baseUrl}/api/v1/sprints/42`, {
        method: 'PUT',
        headers: authHeaders(noProjectKey),
        body: JSON.stringify({ status: 'paused' }),
      });
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        code: 'mcp_scope_denied',
        details: { required_capability: PAUSE },
      });
    });
  });


  describe('project agent management', () => {
    const MANAGE = 'agents.manage_project_agents';

    const put = (id: number, body: Record<string, unknown>, key = normalKey) => fetch(`${baseUrl}/api/v1/agents/${id}`, {
      method: 'PUT', headers: authHeaders(key), body: JSON.stringify(body),
    });

    it('is withheld from a scoped runtime key by default', async () => {
      const res = await fetch(`${baseUrl}/api/v1/agents?project_id=86`, { headers: authHeaders(normalKey) });
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ details: { required_capability: MANAGE } });
    });

    it('manages agents inside the assigned project', async () => {
      await replaceAgentMcpPermissionPolicy(getDb(), 7, [MANAGE]);

      await expect(fetch(`${baseUrl}/api/v1/agents?project_id=86`, { headers: authHeaders(normalKey) }).then(r => r.status)).resolves.toBe(200);
      // Agent 9 (QA) is in project 86, the assigned one.
      await expect(fetch(`${baseUrl}/api/v1/agents/9`, { headers: authHeaders(normalKey) }).then(r => r.status)).resolves.toBe(200);
      await expect(fetch(`${baseUrl}/api/v1/agents/9/docs`, { headers: authHeaders(normalKey) }).then(r => r.status)).resolves.toBe(200);
      await expect(put(9, { job_instructions: 'Review every backend PR against the workflow gates.' }).then(r => r.status)).resolves.toBe(200);
      await expect(fetch(`${baseUrl}/api/v1/agents/9`, { method: 'DELETE', headers: authHeaders(normalKey) }).then(r => r.status)).resolves.toBe(200);

      const created = await fetch(`${baseUrl}/api/v1/agents`, {
        method: 'POST', headers: authHeaders(normalKey),
        body: JSON.stringify({ name: 'Reviewer', project_id: 86, job_instructions: 'Review work.' }),
      });
      expect(created.status).toBe(201);
    });

    it('refuses every field agent trust is derived from', async () => {
      // Each of these would turn a scoped agent into a trusted_admin one, under which nearly
      // every capability including admin.full_access is enabled. Without this guard the grant
      // would be a total privilege escalation: the connector could promote its own row.
      await replaceAgentMcpPermissionPolicy(getDb(), 7, [MANAGE]);

      for (const body of [
        { system_role: 'admin' },
        { system_role: 'atlas' },
        { global_mcp_admin: 1 },
        { key_global_admin: 1 },
        { tenant_id: 2 },
        { session_key: 'agent:atlas-admin:main' },
        { job_instructions: 'fine', system_role: 'admin' },
      ]) {
        const res = await put(9, body);
        expect({ body, status: res.status }).toEqual({ body, status: 403 });
        await expect(res.json()).resolves.toMatchObject({ details: { required_capability: MANAGE } });
      }
    });

    it('refuses to name an agent after the Atlas identity', async () => {
      // resolveAgentIdentityFields treats the Atlas name or slug as trusted, so a rename is an
      // escalation that never mentions a role.
      await replaceAgentMcpPermissionPolicy(getDb(), 7, [MANAGE]);

      for (const body of [{ name: 'Atlas' }, { name: 'atlas' }, { slug: 'atlas' }]) {
        const res = await put(9, body);
        expect({ body, status: res.status }).toEqual({ body, status: 403 });
      }
      // A different name is ordinary.
      await expect(put(9, { name: 'Atlas Copco Reviewer' }).then(r => r.status)).resolves.toBe(200);
    });

    it('cannot reach or move an agent outside the assigned project', async () => {
      await replaceAgentMcpPermissionPolicy(getDb(), 7, [MANAGE]);

      // Agent 10 is tenant 2 / project 99.
      await expect(fetch(`${baseUrl}/api/v1/agents/10`, { headers: authHeaders(normalKey) }).then(r => r.status)).resolves.toBe(403);
      // Agent 11 has no project at all.
      await expect(fetch(`${baseUrl}/api/v1/agents/11`, { headers: authHeaders(normalKey) }).then(r => r.status)).resolves.toBe(403);
      // Reassigning an in-project agent out of it.
      await expect(put(9, { project_id: 87 }).then(r => r.status)).resolves.toBe(403);
      // Listing another project's roster.
      await expect(fetch(`${baseUrl}/api/v1/agents?project_id=87`, { headers: authHeaders(normalKey) }).then(r => r.status)).resolves.toBe(403);
      // Creating into another project, and creating without naming one.
      const intoOther = await fetch(`${baseUrl}/api/v1/agents`, {
        method: 'POST', headers: authHeaders(normalKey), body: JSON.stringify({ name: 'X', project_id: 87 }),
      });
      expect(intoOther.status).toBe(403);
      const unscoped = await fetch(`${baseUrl}/api/v1/agents`, {
        method: 'POST', headers: authHeaders(normalKey), body: JSON.stringify({ name: 'X' }),
      });
      expect(unscoped.status).toBe(403);
    });

    it('does not open provisioning or capability-policy routes', async () => {
      // The grant edits what an agent is told to do, not what it may do or where it runs.
      await replaceAgentMcpPermissionPolicy(getDb(), 7, [MANAGE]);

      const policy = await fetch(`${baseUrl}/api/v1/agents/9/mcp-permissions`, { headers: authHeaders(normalKey) });
      expect(policy.status).toBe(403);
      const body = await policy.json() as { details?: { required_capability?: string } };
      // Whichever of the policy keys it asks for, it must not be satisfied by this grant.
      expect(body.details?.required_capability).toMatch(/^mcp_capability_policies\./);
    });

    it('refuses a key with no assigned project', async () => {
      await replaceAgentMcpPermissionPolicy(getDb(), 11, [MANAGE]);
      const res = await fetch(`${baseUrl}/api/v1/agents?project_id=86`, { headers: authHeaders(noProjectKey) });
      expect(res.status).toBe(403);
    });
  });

  it('defaults MCP requests to the key tenant instead of the UI active tenant', async () => {
    await getDb().run(`UPDATE app_settings SET value = '2' WHERE key = 'active_tenant_id'`);

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

  it('persists explicit per-agent MCP capability policy snapshots', async () => {
    const db = getDb();

    const defaultSnapshot = await getAgentMcpPermissionPolicy(db, 7);
    expect(defaultSnapshot.policy_mode).toBe('default');
    expect(defaultSnapshot.default_policy).toBe('scoped_runtime');
    expect(defaultSnapshot.capabilities.find((capability) => capability.key === 'tasks.create')).toMatchObject({
      group: 'Task lifecycle',
      label: 'Create Tasks',
      enabled: false,
      default_enabled: false,
      explicit_enabled: null,
    });
    expect(defaultSnapshot.capabilities.find((capability) => capability.key === 'tasks.manage_project_tasks')).toMatchObject({
      group: 'Task lifecycle',
      label: 'Project task CRUD',
      enabled: false,
      default_enabled: false,
      explicit_enabled: null,
      description: expect.stringContaining('assigned project'),
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
    expect(defaultSnapshot.capabilities.find((capability) => capability.key === 'transition_requirements.manage_project_scope')).toMatchObject({
      group: 'Workflow',
      label: 'Project transition requirement CRUD',
      enabled: false,
      default_enabled: false,
      explicit_enabled: null,
      description: expect.stringContaining('assigned project'),
    });
    expect(defaultSnapshot.capabilities.find((capability) => capability.key === 'admin.full_access')?.enabled).toBe(false);
    expect(defaultSnapshot.capabilities.find((capability) => capability.key === 'admin.cross_tenant')?.enabled).toBe(false);

    const explicitSnapshot = await replaceAgentMcpPermissionPolicy(db, 7, [
          'discovery.read_catalog',
          'tasks.read_active_context',
        ]);
    expect(explicitSnapshot.policy_mode).toBe('explicit');
    expect(explicitSnapshot.capabilities.find((capability) => capability.key === 'tasks.read_active_context')?.enabled).toBe(true);
    expect(explicitSnapshot.capabilities.find((capability) => capability.key === 'tasks.create')?.enabled).toBe(false);
    expect(explicitSnapshot.capabilities.find((capability) => capability.key === 'tasks.manage_project_tasks')?.enabled).toBe(false);
    expect(explicitSnapshot.capabilities.find((capability) => capability.key === 'routing_rules.manage_project_scope')?.enabled).toBe(false);
    expect(explicitSnapshot.capabilities.find((capability) => capability.key === 'transition_requirements.manage_project_scope')?.enabled).toBe(false);
    expect(explicitSnapshot.capabilities.find((capability) => capability.key === 'tasks.write_active_lifecycle')?.enabled).toBe(false);

    const resetSnapshot = await resetAgentMcpPermissionPolicy(db, 7);
    expect(resetSnapshot.policy_mode).toBe('default');
    expect(resetSnapshot.capabilities.find((capability) => capability.key === 'tasks.write_active_lifecycle')?.enabled).toBe(true);
  });

  it('allows scoped MCP capability policy edits for another same-project agent', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
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

  describe('workflow definition child resources', () => {
    const READ = 'workflow_definitions.read_project_scope';
    const MANAGE = 'workflow_definitions.manage_project_scope';
    const SUBS = ['statuses', 'outcomes', 'relationship-types'] as const;
    const SPELLINGS = ['/api/v1/sprints', '/api/v1/workflows', '/api/v1/workflow-definitions'] as const;

    const call = (method: string, path: string, key = normalKey) => fetch(`${baseUrl}${path}`, {
      method,
      headers: authHeaders(key),
      body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({ label: 'Probe' }),
    });

    it('reads statuses, outcomes and relationship types on the assigned project', async () => {
      await replaceAgentMcpPermissionPolicy(getDb(), 7, [READ]);

      for (const prefix of SPELLINGS) {
        for (const sub of SUBS) {
          const list = await call('GET', `${prefix}/types/dev/${sub}`);
          expect({ prefix, sub, status: list.status }).toEqual({ prefix, sub, status: 200 });

          const one = await call('GET', `${prefix}/types/dev/${sub}/child-1`);
          expect({ prefix, sub, status: one.status }).toEqual({ prefix, sub, status: 200 });
        }
      }
    });

    it('creates, updates and deletes them with the manage capability', async () => {
      await replaceAgentMcpPermissionPolicy(getDb(), 7, [MANAGE]);

      for (const prefix of SPELLINGS) {
        for (const sub of SUBS) {
          const created = await call('POST', `${prefix}/types/dev/${sub}`);
          expect({ prefix, sub, status: created.status }).toEqual({ prefix, sub, status: 201 });

          const updated = await call('PUT', `${prefix}/types/dev/${sub}/child-1`);
          expect({ prefix, sub, status: updated.status }).toEqual({ prefix, sub, status: 200 });

          const deleted = await call('DELETE', `${prefix}/types/dev/${sub}/child-1`);
          expect({ prefix, sub, status: deleted.status }).toEqual({ prefix, sub, status: 200 });
        }
      }
    });

    it('creates a child row without an explicit project_id in the body', async () => {
      // A child inherits the scope of the type in its path; only POST /types, which brings a
      // definition into being, has to name its project.
      await replaceAgentMcpPermissionPolicy(getDb(), 7, [MANAGE]);

      const child = await fetch(`${baseUrl}/api/v1/sprints/types/dev/statuses`, {
        method: 'POST',
        headers: authHeaders(normalKey),
        body: JSON.stringify({ name: 'uat_review', label: 'UAT Review', metadata: { emoji: '🧪' } }),
      });
      expect(child.status).toBe(201);

      const keylessCreate = await fetch(`${baseUrl}/api/v1/sprints/types`, {
        method: 'POST',
        headers: authHeaders(normalKey),
        body: JSON.stringify({ key: 'new-type', name: 'New Type' }),
      });
      expect(keylessCreate.status).toBe(403);
      await expect(keylessCreate.json()).resolves.toMatchObject({
        details: { required_capability: MANAGE },
      });
    });

    it('separates reading a definition from editing one', async () => {
      await replaceAgentMcpPermissionPolicy(getDb(), 7, [READ]);

      for (const sub of SUBS) {
        const created = await call('POST', `/api/v1/sprints/types/dev/${sub}`);
        expect({ sub, status: created.status }).toEqual({ sub, status: 403 });
        await expect(created.json()).resolves.toMatchObject({
          details: { required_capability: MANAGE },
        });
      }
    });

    it('refuses a definition outside the assigned project or tenant', async () => {
      await replaceAgentMcpPermissionPolicy(getDb(), 7, [READ, MANAGE]);

      // Same tenant, project 87.
      const otherProject = await call('PUT', '/api/v1/sprints/types/other-project-dev/statuses/review');
      expect(otherProject.status).toBe(403);
      await expect(otherProject.json()).resolves.toMatchObject({
        details: { required_capability: MANAGE },
      });

      // Tenant 2 — must read as "does not exist here", never as an edit on another tenant.
      const crossTenant = await call('POST', '/api/v1/sprints/types/eco-dev/outcomes');
      expect(crossTenant.status).toBe(403);

      // A keyed POST used to skip the existence check and could pass on a request-supplied
      // scope alone; it must report the definition as absent instead.
      const unknown = await call('POST', '/api/v1/sprints/types/no-such-type/statuses');
      expect(unknown.status).toBe(403);
      await expect(unknown.json()).resolves.toMatchObject({
        error: expect.stringContaining('does not exist'),
        details: { required_capability: MANAGE },
      });
    });

    it('withholds definition editing from a scoped runtime key by default', async () => {
      const res = await call('POST', '/api/v1/sprints/types/dev/statuses');
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        details: { required_capability: MANAGE },
      });
    });
  });

  it('allows project-scoped workflow definition read and mutation with explicit capabilities', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
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
    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
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
    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
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
    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
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

    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
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
    await replaceAgentMcpPermissionPolicy(getDb(), 11, [
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

  async function seedRecurringTaskSeries(seriesId: number, projectId: number, sprintId: number): Promise<void> {
    const db = getDb();
    // The cross-project case deliberately names a project no agent here is assigned to. The real
    // schema has a recurring_task_series -> projects foreign key, so that project has to exist as
    // a row rather than only as an id; the gate still sees a project outside the caller's scope,
    // which is the whole point of the case.
    await db.run(
      `INSERT INTO projects (id, tenant_id, name) VALUES (?, 1, 'Recurring Series Project') ON CONFLICT DO NOTHING`,
      projectId,
    );
    await db.run(`
      INSERT INTO recurring_task_series (
        id, tenant_id, project_id, sprint_id, title_template, description_template, task_type,
        priority, story_points, status_on_create, schedule_expression, timezone,
        enabled, overlap_policy, created_by, updated_by, created_at, updated_at
      ) VALUES (?, 1, ?, ?, 'Series', 'Series body', 'ops', 'high', 2, 'ready',
        'every monday 09:00', 'America/New_York', 0, 'skip_if_active', 'test', 'test',
        '2026-07-01 00:00:00', '2026-07-01 00:00:00')
    `, seriesId, projectId, sprintId);
  }

  it('allows an owning agent to persist custom fields on its own active task', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
            'discovery.read_catalog',
            'tasks.read_active_context',
            'tasks.write_active_custom_fields',
          ]);

    const res = await fetch(`${baseUrl}/api/v1/tasks/448`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ custom_fields: { source_platform: 'freelancer' }, changed_by: 'agent' }),
    });
    expect(res.status).not.toBe(403);
  });

  it('refuses non-custom-field task edits under the active custom-field capability', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
            'discovery.read_catalog',
            'tasks.read_active_context',
            'tasks.write_active_custom_fields',
          ]);

    // Status changes, retitles, and reassignment are task-column edits and must
    // still require the broad project task management capability.
    for (const body of [
      { status: 'done' },
      { title: 'renamed' },
      { agent_id: 9 },
      { custom_fields: { source_platform: 'freelancer' }, status: 'done' },
    ]) {
      const res = await fetch(`${baseUrl}/api/v1/tasks/448`, {
        method: 'PUT',
        headers: authHeaders(normalKey),
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
    }
  });

  it('refuses active custom-field writes to a task the agent does not actively own', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
            'discovery.read_catalog',
            'tasks.read_active_context',
            'tasks.write_active_custom_fields',
          ]);

    const res = await fetch(`${baseUrl}/api/v1/tasks/449`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ custom_fields: { source_platform: 'freelancer' } }),
    });
    expect(res.status).toBe(403);
  });

  it('refuses active custom-field writes without the capability', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
            'discovery.read_catalog',
            'tasks.read_active_context',
            'tasks.write_active_lifecycle',
          ]);

    const res = await fetch(`${baseUrl}/api/v1/tasks/448`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ custom_fields: { source_platform: 'freelancer' } }),
    });
    expect(res.status).toBe(403);
  });

  it('allows project-scoped recurring task series reads and management with explicit capabilities', async () => {
    await seedRecurringTaskSeries(9001, 86, 42);
    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
            'discovery.read_catalog',
            'recurring_task_series.read_project_scope',
            'recurring_task_series.manage_project_scope',
          ]);

    // These assert the authorization boundary only. The auth fixture does not
    // stand up the recurring-series service, so an authorized request may still
    // 404 at the handler; what matters is that it is never refused with 403.
    const listRes = await fetch(`${baseUrl}/api/v1/recurring-task-series?project_id=86`, {
      headers: authHeaders(normalKey),
    });
    expect(listRes.status).not.toBe(403);

    const getRes = await fetch(`${baseUrl}/api/v1/recurring-task-series/9001`, {
      headers: authHeaders(normalKey),
    });
    expect(getRes.status).not.toBe(403);

    const historyRes = await fetch(`${baseUrl}/api/v1/recurring-task-series/9001/history`, {
      headers: authHeaders(normalKey),
    });
    expect(historyRes.status).not.toBe(403);

    const disableRes = await fetch(`${baseUrl}/api/v1/recurring-task-series/9001/disable`, {
      method: 'POST',
      headers: authHeaders(normalKey),
    });
    expect(disableRes.status).not.toBe(403);
  });

  it('denies recurring task series access without the matching capability', async () => {
    await seedRecurringTaskSeries(9002, 86, 42);
    // Read capability only: reads pass, management must still be refused.
    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
            'discovery.read_catalog',
            'recurring_task_series.read_project_scope',
          ]);

    const getRes = await fetch(`${baseUrl}/api/v1/recurring-task-series/9002`, {
      headers: authHeaders(normalKey),
    });
    expect(getRes.status).not.toBe(403);

    const enableRes = await fetch(`${baseUrl}/api/v1/recurring-task-series/9002/enable`, {
      method: 'POST',
      headers: authHeaders(normalKey),
    });
    expect(enableRes.status).toBe(403);

    const runNowRes = await fetch(`${baseUrl}/api/v1/recurring-task-series/9002/run-now`, {
      method: 'POST',
      headers: authHeaders(normalKey),
    });
    expect(runNowRes.status).toBe(403);

    // No recurring capabilities at all: even reads are refused.
    await replaceAgentMcpPermissionPolicy(getDb(), 7, ['discovery.read_catalog']);
    const deniedReadRes = await fetch(`${baseUrl}/api/v1/recurring-task-series/9002`, {
      headers: authHeaders(normalKey),
    });
    expect(deniedReadRes.status).toBe(403);
  });

  it('denies recurring task series outside the assigned project and for unknown series', async () => {
    await seedRecurringTaskSeries(9003, 999, 42);
    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
            'discovery.read_catalog',
            'recurring_task_series.read_project_scope',
            'recurring_task_series.manage_project_scope',
          ]);

    const crossProjectRes = await fetch(`${baseUrl}/api/v1/recurring-task-series/9003`, {
      headers: authHeaders(normalKey),
    });
    expect(crossProjectRes.status).toBe(403);

    const crossProjectListRes = await fetch(`${baseUrl}/api/v1/recurring-task-series?project_id=999`, {
      headers: authHeaders(normalKey),
    });
    expect(crossProjectListRes.status).toBe(403);

    // An unscoped list would otherwise enumerate every project.
    const unscopedListRes = await fetch(`${baseUrl}/api/v1/recurring-task-series`, {
      headers: authHeaders(normalKey),
    });
    expect(unscopedListRes.status).toBe(403);

    const missingSeriesRes = await fetch(`${baseUrl}/api/v1/recurring-task-series/987654`, {
      headers: authHeaders(normalKey),
    });
    expect(missingSeriesRes.status).toBe(403);
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
    const deniedNote = await db.get(`SELECT tenant_id, author, content FROM task_notes WHERE task_id = ? ORDER BY id DESC LIMIT 1`, 449) as {
      tenant_id: number;
      author: string;
      content: string;
    } | undefined;
    expect(deniedNote).toMatchObject({
      tenant_id: 2,
      author: 'agent-hq-mcp-auth',
      content: expect.stringContaining('Scoped MCP write refused'),
    });
  });

  it('allows task creation when the Create Tasks capability is explicitly enabled', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
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

  it('allows generic project task CRUD only inside the assigned project', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
            'discovery.read_catalog',
            'tasks.manage_project_tasks',
          ]);

    const createTaskRes = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({
        title: 'Scoped follow-up',
        project_id: 86,
        sprint_id: 42,
        agent_id: 9,
      }),
    });
    expect(createTaskRes.status).toBe(201);

    const readTaskRes = await fetch(`${baseUrl}/api/v1/tasks/451`, { headers: authHeaders(normalKey) });
    expect(readTaskRes.status).toBe(200);

    const updateTaskRes = await fetch(`${baseUrl}/api/v1/tasks/451`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({
        title: 'Scoped update',
        project_id: 86,
        sprint_id: 42,
        agent_id: 9,
      }),
    });
    expect(updateTaskRes.status).toBe(200);
    await expect(updateTaskRes.json()).resolves.toMatchObject({
      ok: true,
      task_id: 451,
      body: {
        project_id: 86,
        sprint_id: 42,
        agent_id: 9,
      },
    });

    const deleteTaskRes = await fetch(`${baseUrl}/api/v1/tasks/451`, {
      method: 'DELETE',
      headers: authHeaders(normalKey),
    });
    expect(deleteTaskRes.status).toBe(200);

    const createRelationshipRes = await fetch(`${baseUrl}/api/v1/tasks/451/relationships`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ target_task_id: 448, relationship_type_key: 'blocked_by' }),
    });
    expect(createRelationshipRes.status).toBe(201);
    await expect(createRelationshipRes.json()).resolves.toMatchObject({
      ok: true,
      task_id: 451,
      body: {
        target_task_id: 448,
        relationship_type_key: 'blocked_by',
      },
    });

    const deleteRelationshipRes = await fetch(`${baseUrl}/api/v1/tasks/451/relationships/12`, {
      method: 'DELETE',
      headers: authHeaders(normalKey),
    });
    expect(deleteRelationshipRes.status).toBe(200);
    await expect(deleteRelationshipRes.json()).resolves.toMatchObject({
      ok: true,
      task_id: 451,
      relationship_id: 12,
    });

    const crossProjectRead = await fetch(`${baseUrl}/api/v1/tasks/452`, { headers: authHeaders(normalKey) });
    expect(crossProjectRead.status).toBe(403);
    await expect(crossProjectRead.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'tasks.manage_project_tasks', task_id: 452 },
    });

    const crossTenantRead = await fetch(`${baseUrl}/api/v1/tasks/449`, { headers: authHeaders(normalKey) });
    expect(crossTenantRead.status).toBe(403);
    await expect(crossTenantRead.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'tasks.manage_project_tasks', task_id: 449 },
    });

    const crossProjectCreate = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ title: 'Wrong project', project_id: 87, sprint_id: 44 }),
    });
    expect(crossProjectCreate.status).toBe(403);
    await expect(crossProjectCreate.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      error: expect.stringContaining('project_id 87'),
      details: { required_capability: 'tasks.manage_project_tasks' },
    });

    const crossProjectUpdate = await fetch(`${baseUrl}/api/v1/tasks/451`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ sprint_id: 44 }),
    });
    expect(crossProjectUpdate.status).toBe(403);
    await expect(crossProjectUpdate.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      error: expect.stringContaining('sprint/workflow #44'),
      details: { required_capability: 'tasks.manage_project_tasks', task_id: 451 },
    });

    const crossTenantAgentUpdate = await fetch(`${baseUrl}/api/v1/tasks/451`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ agent_id: 10 }),
    });
    expect(crossTenantAgentUpdate.status).toBe(403);
    await expect(crossTenantAgentUpdate.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'tasks.manage_project_tasks', task_id: 451 },
    });

    const crossProjectRelationshipCreate = await fetch(`${baseUrl}/api/v1/tasks/451/relationships`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ target_task_id: 452, relationship_type_key: 'blocked_by' }),
    });
    expect(crossProjectRelationshipCreate.status).toBe(403);
    await expect(crossProjectRelationshipCreate.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      error: expect.stringContaining('Relationship target task #452'),
      details: { required_capability: 'tasks.manage_project_tasks', task_id: 451 },
    });

    const crossProjectRelationshipDelete = await fetch(`${baseUrl}/api/v1/tasks/451/relationships/13`, {
      method: 'DELETE',
      headers: authHeaders(normalKey),
    });
    expect(crossProjectRelationshipDelete.status).toBe(403);
    await expect(crossProjectRelationshipDelete.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      error: expect.stringContaining('Relationship #13'),
      details: { required_capability: 'tasks.manage_project_tasks', task_id: 451 },
    });
  });

  it('keeps project task CRUD separate from active lifecycle routes', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
            'discovery.read_catalog',
            'tasks.manage_project_tasks',
          ]);

    const lifecycleNoteRes = await fetch(`${baseUrl}/api/v1/tasks/448/notes`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ content: 'Not a generic CRUD write' }),
    });
    expect(lifecycleNoteRes.status).toBe(403);
    await expect(lifecycleNoteRes.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'tasks.write_active_lifecycle', task_id: 448 },
    });

    const relationshipRes = await fetch(`${baseUrl}/api/v1/tasks/451/relationships`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ target_task_id: 448, relationship_type_key: 'relates_to' }),
    });
    expect(relationshipRes.status).toBe(201);
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

    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
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
    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
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

    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
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
    await replaceAgentMcpPermissionPolicy(getDb(), 11, [
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


  it('lets a key with no dispatched run reach the routing graph for its assigned project', async () => {
    // scopedProjectIds/scopedSprintIds are built from queued, dispatched or running work, so they
    // are empty whenever the agent is between runs. Before the assigned-project tier this denied
    // an agent the graph for the very project it routes through, and denied a board-scoped client
    // — which never owns a dispatched task — every time.
    await getDb().run(`UPDATE tasks SET active_instance_id = NULL WHERE id = 448`);
    await getDb().run(`UPDATE job_instances SET status = 'done' WHERE agent_id = 7`);

    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
      'workflow.analyze_routing_graph',
      'workflow.edit_routing_config',
    ]);

    const byProject = await fetch(`${baseUrl}/api/v1/routing/graph?project_id=86`, { headers: authHeaders(normalKey) });
    expect(byProject.status).toBe(200);

    // Named by workflow rather than project: resolves through the workflow's owning project.
    const byWorkflow = await fetch(`${baseUrl}/api/v1/routing/graph?workflow_id=42`, { headers: authHeaders(normalKey) });
    expect(byWorkflow.status).toBe(200);

    const preview = await fetch(`${baseUrl}/api/v1/routing/preview`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ project_id: 86, sprint_type: 'dev', operations: [] }),
    });
    expect(preview.status).toBe(200);

    const audit = await fetch(`${baseUrl}/api/v1/routing/audit?project_id=86`, { headers: authHeaders(normalKey) });
    expect(audit.status).toBe(200);
  });

  it('still confines graph and preview to the assigned project when there is no dispatched run', async () => {
    await getDb().run(`UPDATE tasks SET active_instance_id = NULL WHERE id = 448`);
    await getDb().run(`UPDATE job_instances SET status = 'done' WHERE agent_id = 7`);

    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
      'workflow.analyze_routing_graph',
      'workflow.edit_routing_config',
    ]);

    // Project 87 and workflow 44 are the same tenant, a different project.
    const otherProject = await fetch(`${baseUrl}/api/v1/routing/graph?project_id=87`, { headers: authHeaders(normalKey) });
    expect(otherProject.status).toBe(403);
    await expect(otherProject.json()).resolves.toMatchObject({
      details: { required_capability: 'workflow.analyze_routing_graph' },
    });

    const otherWorkflow = await fetch(`${baseUrl}/api/v1/routing/graph?workflow_id=44`, { headers: authHeaders(normalKey) });
    expect(otherWorkflow.status).toBe(403);

    const otherPreview = await fetch(`${baseUrl}/api/v1/routing/preview`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ project_id: 87, sprint_type: 'dev', operations: [] }),
    });
    expect(otherPreview.status).toBe(403);

    // Naming nothing at all stays a denial: the branch has no scope to check.
    const unscoped = await fetch(`${baseUrl}/api/v1/routing/graph`, { headers: authHeaders(normalKey) });
    expect(unscoped.status).toBe(403);
  });

  it('refuses graph analysis to a key with neither a dispatched run nor an assigned project', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 11, ['workflow.analyze_routing_graph']);

    const res = await fetch(`${baseUrl}/api/v1/routing/graph?project_id=86`, { headers: authHeaders(noProjectKey) });
    expect(res.status).toBe(403);
  });

  it('gates routing preview and audit on workflow.edit_routing_config', async () => {
    // Without the capability the write endpoints are still reachable, so an agent could change
    // shared routing config having never seen its blast radius. That is the half of the canvas
    // contract this capability exists to close.
    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
      'discovery.read_catalog',
      'transition_requirements.manage_project_scope',
    ]);

    const denied = await fetch(`${baseUrl}/api/v1/routing/preview`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ project_id: 86, sprint_type: 'dev', operations: [] }),
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'workflow.edit_routing_config' },
    });

    const deniedAudit = await fetch(`${baseUrl}/api/v1/routing/audit?project_id=86`, {
      headers: authHeaders(normalKey),
    });
    expect(deniedAudit.status).toBe(403);

    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
      'discovery.read_catalog',
      'transition_requirements.manage_project_scope',
      'workflow.edit_routing_config',
    ]);

    const allowedAudit = await fetch(`${baseUrl}/api/v1/routing/audit?project_id=86`, {
      headers: authHeaders(normalKey),
    });
    expect(allowedAudit.status).toBe(200);
  });

  it('confines routing preview to the key\'s own project', async () => {
    // Preview runs the real mutation, so an unscoped one would let a key measure — and by
    // measuring, briefly apply — a change to a project it cannot otherwise touch.
    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
      'discovery.read_catalog',
      'workflow.edit_routing_config',
    ]);

    const otherProject = await fetch(`${baseUrl}/api/v1/routing/preview`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ project_id: 87, sprint_type: 'dev', operations: [] }),
    });
    expect(otherProject.status).toBe(403);

    const unscoped = await fetch(`${baseUrl}/api/v1/routing/preview`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ sprint_type: 'dev', operations: [] }),
    });
    expect(unscoped.status).toBe(403);
  });

  it('allows scoped transition requirement CRUD for project defaults and workflow overrides', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
            'discovery.read_catalog',
            'transition_requirements.manage_project_scope',
          ]);

    const listDefault = await fetch(`${baseUrl}/api/v1/routing/transition-requirements?project_id=86&sprint_type=dev`, {
      headers: authHeaders(normalKey),
    });
    expect(listDefault.status).toBe(200);

    const listOverride = await fetch(`${baseUrl}/api/v1/routing/transition-requirements?sprint_id=42`, {
      headers: authHeaders(normalKey),
    });
    expect(listOverride.status).toBe(200);

    const createDefault = await fetch(`${baseUrl}/api/v1/routing/transition-requirements`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({
        project_id: 86,
        sprint_type: 'dev',
        outcome: 'completed_for_review',
        field_name: 'review_commit',
      }),
    });
    expect(createDefault.status).toBe(201);

    const createOverride = await fetch(`${baseUrl}/api/v1/routing/transition-requirements`, {
      method: 'POST',
      headers: authHeaders(normalKey),
      body: JSON.stringify({
        sprint_id: 42,
        outcome: 'qa_pass',
        field_name: 'qa_verified_commit',
      }),
    });
    expect(createOverride.status).toBe(201);

    const updateDefault = await fetch(`${baseUrl}/api/v1/routing/transition-requirements/601`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({
        project_id: 86,
        sprint_type: 'dev',
        message: 'Updated scoped default',
      }),
    });
    expect(updateDefault.status).toBe(200);

    const updateOverride = await fetch(`${baseUrl}/api/v1/routing/transition-requirements/602`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({
        sprint_id: 42,
        message: 'Updated scoped override',
      }),
    });
    expect(updateOverride.status).toBe(200);

    const deleteDefault = await fetch(`${baseUrl}/api/v1/routing/transition-requirements/601?project_id=86&sprint_type=dev`, {
      method: 'DELETE',
      headers: authHeaders(normalKey),
    });
    expect(deleteDefault.status).toBe(200);

    const deleteOverride = await fetch(`${baseUrl}/api/v1/routing/transition-requirements/602?sprint_id=42`, {
      method: 'DELETE',
      headers: authHeaders(normalKey),
    });
    expect(deleteOverride.status).toBe(200);
  });

  it('denies scoped transition requirement CRUD without capability or outside assigned project scope', async () => {
    const missingCapability = await fetch(`${baseUrl}/api/v1/routing/transition-requirements?project_id=86&sprint_type=dev`, {
      headers: authHeaders(normalKey),
    });
    expect(missingCapability.status).toBe(403);
    await expect(missingCapability.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'workflow.read_active_configuration' },
    });

    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
            'discovery.read_catalog',
            'transition_requirements.manage_project_scope',
          ]);

    const unscopedList = await fetch(`${baseUrl}/api/v1/routing/transition-requirements`, {
      headers: authHeaders(normalKey),
    });
    expect(unscopedList.status).toBe(403);
    await expect(unscopedList.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'transition_requirements.manage_project_scope' },
    });

    const allProjectDefault = await fetch(`${baseUrl}/api/v1/routing/transition-requirements?sprint_type=dev`, {
      headers: authHeaders(normalKey),
    });
    expect(allProjectDefault.status).toBe(403);

    const otherProjectRow = await fetch(`${baseUrl}/api/v1/routing/transition-requirements/603`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ project_id: 87, sprint_type: 'dev', message: 'Nope' }),
    });
    expect(otherProjectRow.status).toBe(403);
    await expect(otherProjectRow.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'transition_requirements.manage_project_scope' },
    });

    const moveOutOfScope = await fetch(`${baseUrl}/api/v1/routing/transition-requirements/601`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ project_id: 87, sprint_type: 'dev' }),
    });
    expect(moveOutOfScope.status).toBe(403);

    const missingExplicitUpdateScope = await fetch(`${baseUrl}/api/v1/routing/transition-requirements/601`, {
      method: 'PUT',
      headers: authHeaders(normalKey),
      body: JSON.stringify({ message: 'No explicit scope' }),
    });
    expect(missingExplicitUpdateScope.status).toBe(403);

    const crossTenantSelector = await fetch(`${baseUrl}/api/v1/routing/transition-requirements?tenant_id=2&project_id=99&sprint_type=dev`, {
      headers: authHeaders(normalKey),
    });
    expect(crossTenantSelector.status).toBe(403);
    await expect(crossTenantSelector.json()).resolves.toMatchObject({
      code: 'mcp_tenant_scope_denied',
      details: { required_capability: 'admin.cross_tenant' },
    });
  });

  it('fails closed for transition requirement CRUD when the agent has no canonical project', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 11, [
            'discovery.read_catalog',
            'transition_requirements.manage_project_scope',
          ]);

    const response = await fetch(`${baseUrl}/api/v1/routing/transition-requirements?project_id=86&sprint_type=dev`, {
      headers: authHeaders(noProjectKey),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'mcp_scope_denied',
      details: { required_capability: 'transition_requirements.manage_project_scope' },
    });
  });

  it('allows read-only access to project task context when Read project task context is enabled', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
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
    await replaceAgentMcpPermissionPolicy(getDb(), 11, [
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
    await replaceAgentMcpPermissionPolicy(getDb(), 11, [
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
    await getAgentMcpPermissionPolicy(getDb(), 7);
    await getDb().run(`
      INSERT INTO agent_mcp_capability_policies (agent_id, capability_key, enabled)
      VALUES (?, ?, ?)
    `, 7, 'tasks.read_any_context', 1);

    const snapshot = await getAgentMcpPermissionPolicy(getDb(), 7);
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
    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
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

    await replaceAgentMcpPermissionPolicy(getDb(), 7, [
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
    await replaceAgentMcpPermissionPolicy(getDb(), 7, ['admin.full_access']);

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

    const adminIdentity = await resolveMcpApiIdentityForKey(getDb(), adminKey, { updateLastUsed: false });
    await getDb().run(`UPDATE mcp_api_keys SET global_admin = 1 WHERE id = ?`, adminIdentity.keyId);

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
    await replaceAgentMcpPermissionPolicy(getDb(), 7, ['admin.full_access', 'admin.cross_tenant']);

    const allowed = await fetch(`${baseUrl}/api/v1/projects/99?tenant_id=2`, {
      method: 'DELETE',
      headers: authHeaders(normalKey),
    });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({ ok: true, project_id: 99 });

    const identity = await resolveMcpApiIdentityForKey(getDb(), normalKey, { updateLastUsed: false });
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

  describe('projects.read_project_board', () => {
    // The collection reads a board view needs. Every other read capability resolves to a single
    // record or to the agent's own dispatched task, which is right for a runtime agent and leaves
    // a remote client unable to answer "what is on my board" without an admin key.

    it('is off for scoped runtime agents by default', async () => {
      const res = await fetch(`${baseUrl}/api/v1/tasks?project_id=86`, { headers: authHeaders(normalKey) });
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        code: 'mcp_scope_denied',
        details: { required_capability: 'projects.read_project_board' },
      });
    });

    it('allows board collections inside the assigned project once granted', async () => {
      await replaceAgentMcpPermissionPolicy(getDb(), 7, ['projects.read_project_board']);

      const tasks = await fetch(`${baseUrl}/api/v1/tasks?project_id=86`, { headers: authHeaders(normalKey) });
      expect(tasks.status).toBe(200);

      const sprints = await fetch(`${baseUrl}/api/v1/sprints?project_id=86`, { headers: authHeaders(normalKey) });
      expect(sprints.status).toBe(200);

      const workflows = await fetch(`${baseUrl}/api/v1/workflows?project_id=86`, { headers: authHeaders(normalKey) });
      expect(workflows.status).toBe(200);

      // The project list is tenant-filtered downstream and carries no task content.
      const projects = await fetch(`${baseUrl}/api/v1/projects`, { headers: authHeaders(normalKey) });
      expect(projects.status).toBe(200);
    });

    it('refuses a board collection that names another project', async () => {
      await replaceAgentMcpPermissionPolicy(getDb(), 7, ['projects.read_project_board']);

      const tasks = await fetch(`${baseUrl}/api/v1/tasks?project_id=87`, { headers: authHeaders(normalKey) });
      expect(tasks.status).toBe(403);
      await expect(tasks.json()).resolves.toMatchObject({ code: 'mcp_scope_denied' });

      const sprints = await fetch(`${baseUrl}/api/v1/sprints?project_id=99`, { headers: authHeaders(normalKey) });
      expect(sprints.status).toBe(403);
    });

    it('refuses a board collection that names no project at all', async () => {
      // Without this the grant would be a tenant-wide task read, which is not what it says.
      await replaceAgentMcpPermissionPolicy(getDb(), 7, ['projects.read_project_board']);

      const res = await fetch(`${baseUrl}/api/v1/tasks`, { headers: authHeaders(normalKey) });
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ error: expect.stringMatching(/explicit project_id/i) });
    });

    it('scopes workflow metadata by the workflow it names', async () => {
      await replaceAgentMcpPermissionPolicy(getDb(), 7, ['projects.read_project_board']);

      const own = await fetch(`${baseUrl}/api/v1/sprints/workflow-metadata?sprint_id=42`, { headers: authHeaders(normalKey) });
      expect(own.status).toBe(200);

      // Workflow 44 belongs to project 87.
      const other = await fetch(`${baseUrl}/api/v1/workflows/workflow-metadata?sprint_id=44`, { headers: authHeaders(normalKey) });
      expect(other.status).toBe(403);

      // With no workflow selector the response is tenant-level workflow-type configuration.
      const unscoped = await fetch(`${baseUrl}/api/v1/sprints/workflow-metadata?sprint_type=dev`, { headers: authHeaders(normalKey) });
      expect(unscoped.status).toBe(200);
    });

    it('leaves full administrative access unaffected', async () => {
      const res = await fetch(`${baseUrl}/api/v1/tasks`, { headers: authHeaders(adminKey) });
      expect(res.status).toBe(200);
    });

    it('refuses board collections for an agent with no assigned project', async () => {
      await replaceAgentMcpPermissionPolicy(getDb(), 11, ['projects.read_project_board']);

      const res = await fetch(`${baseUrl}/api/v1/tasks?project_id=86`, { headers: authHeaders(noProjectKey) });
      expect(res.status).toBe(403);
    });
  });

  describe('tasks.write_project_notes', () => {
    it('notes any task in the assigned project without owning a run on it', async () => {
      // Task 451 is in project 86 but dispatched to nobody, so the active-task path cannot reach it.
      await replaceAgentMcpPermissionPolicy(getDb(), 7, ['tasks.write_project_notes']);

      const res = await fetch(`${baseUrl}/api/v1/tasks/451/notes`, {
        method: 'POST',
        headers: authHeaders(normalKey),
        body: JSON.stringify({ note: 'Filed from a phone' }),
      });
      expect(res.status).toBe(201);
    });

    it('still refuses a note on a task outside the assigned project', async () => {
      await replaceAgentMcpPermissionPolicy(getDb(), 7, ['tasks.write_project_notes']);

      const res = await fetch(`${baseUrl}/api/v1/tasks/452/notes`, {
        method: 'POST',
        headers: authHeaders(normalKey),
        body: JSON.stringify({ note: 'Wrong project' }),
      });
      expect(res.status).toBe(403);
    });

    it('keeps evidence and outcomes dispatch-scoped even alongside project note writes', async () => {
      // The distinction this capability exists for: a note is additive and moves nothing, while an
      // outcome drives a workflow transition and belongs to the agent executing the run. Granting
      // both capabilities must not merge the two scopes.
      await replaceAgentMcpPermissionPolicy(getDb(), 7, [
        'tasks.write_project_notes',
        'tasks.write_active_lifecycle',
      ]);

      const note = await fetch(`${baseUrl}/api/v1/tasks/451/notes`, {
        method: 'POST',
        headers: authHeaders(normalKey),
        body: JSON.stringify({ note: 'ok' }),
      });
      expect(note.status).toBe(201);

      const outcome = await fetch(`${baseUrl}/api/v1/tasks/451/outcome`, {
        method: 'POST',
        headers: authHeaders(normalKey),
        body: JSON.stringify({ outcome: 'completed_for_review', summary: 'not my run' }),
      });
      expect(outcome.status).toBe(403);
    });

    it('leaves the active-task note path intact for agents without the project note grant', async () => {
      // Default scoped-runtime policy: note the dispatched task, nothing else.
      const dispatched = await fetch(`${baseUrl}/api/v1/tasks/448/notes`, {
        method: 'POST',
        headers: authHeaders(normalKey),
        body: JSON.stringify({ note: 'progress' }),
      });
      expect(dispatched.status).toBe(201);

      const other = await fetch(`${baseUrl}/api/v1/tasks/451/notes`, {
        method: 'POST',
        headers: authHeaders(normalKey),
        body: JSON.stringify({ note: 'not mine' }),
      });
      expect(other.status).toBe(403);
    });
  });
});

/** Establishes the Atlas identity required by these authentication cases. */
async function ensureAtlasAgent(): Promise<void> {
  const db = getDb();
  const tenantId = await getDefaultTenantId(db);
  const existing = await db.get(`
    SELECT id FROM agents
    WHERE system_role = 'atlas' OR openclaw_agent_id = 'atlas' OR name = 'Atlas'
    ORDER BY id ASC
    LIMIT 1
  `);
  if (existing) return;
  await db.run(`
    INSERT INTO agents (name, role, session_key, workspace_path, status, openclaw_agent_id, slug, system_role, tenant_id)
    VALUES ('Atlas', 'Built-in assistant', 'agent:atlas:main', '', 'idle', 'atlas', 'atlas', 'atlas', ?)
  `, tenantId);
}

describe('ensureConfiguredRuntimeMcpApiKey', () => {
  beforeEach(async () => {
    const db = await setupTestDb();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
    await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
    delete process.env.AGENT_HQ_MCP_API_KEY;
    delete process.env.AGENT_HQ_MCP_API_KEY_AGENT_ID;
    delete process.env.AGENT_HQ_MCP_API_KEY_AGENT_OPENCLAW_ID;
    delete process.env.AGENT_HQ_MCP_API_KEY_AGENT_SESSION_KEY;
    delete process.env.AGENT_HQ_MCP_API_KEY_AGENT_SLUG;
    delete process.env.AGENT_HQ_MCP_API_KEY_GLOBAL_ADMIN;
    await ensureAtlasAgent();
  });

  afterEach(async () => {
    restoreEnv('AGENT_HQ_MCP_API_KEY', ORIGINAL_MCP_API_KEY);
    restoreEnv('AGENT_HQ_MCP_API_KEY_AGENT_ID', ORIGINAL_MCP_API_KEY_AGENT_ID);
    restoreEnv('AGENT_HQ_MCP_API_KEY_AGENT_OPENCLAW_ID', ORIGINAL_MCP_API_KEY_AGENT_OPENCLAW_ID);
    restoreEnv('AGENT_HQ_MCP_API_KEY_AGENT_SESSION_KEY', ORIGINAL_MCP_API_KEY_AGENT_SESSION_KEY);
    restoreEnv('AGENT_HQ_MCP_API_KEY_AGENT_SLUG', ORIGINAL_MCP_API_KEY_AGENT_SLUG);
    restoreEnv('AGENT_HQ_MCP_API_KEY_GLOBAL_ADMIN', ORIGINAL_MCP_API_KEY_GLOBAL_ADMIN);
    await teardownTestDb();
  });

  it('does not materialize configured runtime keys during schema startup', async () => {
    process.env.AGENT_HQ_MCP_API_KEY = 'ahq_mcp_runtime_bootstrap_test';

    // The read-only PostgreSQL boot gate must not mint configured runtime credentials. The next
    // test's explicit ensureConfiguredRuntimeMcpApiKey() call is the sanctioned install action.
    await verifyStartupSchema();

    expect(await getDb().get(`SELECT COUNT(*) AS count FROM mcp_api_keys`)).toEqual({ count: 0 });
  });

  it('materializes a configured runtime key against Atlas when the key is missing from the current DB', async () => {
    process.env.AGENT_HQ_MCP_API_KEY = 'ahq_mcp_runtime_bootstrap_test';

    const result = await ensureConfiguredRuntimeMcpApiKey();
    const identity = await resolveMcpApiIdentityForKey(getDb(), process.env.AGENT_HQ_MCP_API_KEY!, { updateLastUsed: false });

    expect(result).toMatchObject({
      status: 'created',
      agentId: identity.agentId,
      keyPrefix: 'ahq_mcp_runtime_',
    });
    expect(identity.agentSlug).toBe('atlas');
    expect(identity.tenantId).toBe(1);
    expect(identity.globalAdminAccess).toBe(false);
  });

  it('materializes configured runtime keys as global only when explicitly requested', async () => {
    process.env.AGENT_HQ_MCP_API_KEY = 'ahq_mcp_runtime_global_bootstrap_test';
    process.env.AGENT_HQ_MCP_API_KEY_GLOBAL_ADMIN = 'true';

    const result = await ensureConfiguredRuntimeMcpApiKey();
    const identity = await resolveMcpApiIdentityForKey(getDb(), process.env.AGENT_HQ_MCP_API_KEY!, { updateLastUsed: false });

    expect(result).toMatchObject({ status: 'created', agentId: identity.agentId });
    expect(identity.agentSlug).toBe('atlas');
    expect(identity.tenantId).toBe(1);
    expect(identity.globalAdminAccess).toBe(true);
  });

  it('uses the configured runtime agent selector and reuses the same key on later boots', async () => {
    const db = getDb();
    await db.run(`
      INSERT INTO agents (id, tenant_id, name, role, session_key, workspace_path, openclaw_agent_id, status)
      VALUES (410, 1, 'Cinder (Backend)', 'Backend Engineer', 'agent:agent-hq:cinder-backend:backend-engineer:main', '', 'cinder-backend', 'idle')
    `);

    process.env.AGENT_HQ_MCP_API_KEY = 'ahq_mcp_runtime_cinder_test';
    process.env.AGENT_HQ_MCP_API_KEY_AGENT_OPENCLAW_ID = 'cinder-backend';

    const first = await ensureConfiguredRuntimeMcpApiKey();
    const second = await ensureConfiguredRuntimeMcpApiKey();
    const identity = await resolveMcpApiIdentityForKey(getDb(), process.env.AGENT_HQ_MCP_API_KEY!, { updateLastUsed: false });

    expect(first).toMatchObject({ status: 'created', agentId: 410, keyPrefix: 'ahq_mcp_runtime_' });
    expect(second).toMatchObject({ status: 'reused', agentId: 410, keyId: first.keyId, keyPrefix: 'ahq_mcp_runtime_' });
    expect(identity.agentId).toBe(410);
    expect(identity.agentSlug).toBe('cinder-backend');
  });
});
