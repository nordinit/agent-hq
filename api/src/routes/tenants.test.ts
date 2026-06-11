import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import tenantsRouter from './tenants';
import projectsRouter from './projects';
import tasksRouter from './tasks';
import agentsRouter from './agents';
import artifactsRouter from './artifacts';
import sprintsRouter from './sprints';
import toolsRouter, { agentToolsRouter } from './tools';
import mcpServersRouter, { agentMcpServersRouter } from './mcp-servers';
import { closeDb, getDb } from '../db/client';
import { initSchema } from '../db/schema';
import { ensureTenantSchema } from '../lib/tenantContext';
import { ATLAS_AGENT_NAME, ATLAS_SYSTEM_ROLE } from '../lib/atlasAgent';
import { DEFAULT_PROJECT_NAME, STARTER_AGENT_DEFINITIONS } from '../lib/starterCatalog';
import {
  AGENT_HQ_DISPATCHER_SOURCE,
  AGENT_HQ_RUNTIME_SOURCE,
  DEV_ENV_LEASE_MANAGER_SOURCE,
  removeDevEnvironmentLeaseManagerWorkflowEventDefaultsForTenant,
} from '../domains/routing/externalEventMappings';
import { materializeAgentMcpConfig } from '../runtimes/mcpMaterialization';

const originalDbPath = process.env.AGENT_HQ_DB_PATH;
const originalWorkspaceParent = process.env.WORKSPACE_PARENT;
let tempDir = '';

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/tenants', tenantsRouter);
  app.use('/api/v1/companies', tenantsRouter);
  app.use('/api/v1/projects', projectsRouter);
  app.use('/api/v1/tasks', tasksRouter);
  app.use('/api/v1/agents', agentsRouter);
  app.use('/api/v1/artifacts', artifactsRouter);
  app.use('/api/v1/tools', toolsRouter);
  app.use('/api/v1/agents/:id/tools', agentToolsRouter);
  app.use('/api/v1/mcp-servers', mcpServersRouter);
  app.use('/api/v1/agents/:id/mcp-servers', agentMcpServersRouter);
  app.use('/api/v1/sprints', sprintsRouter);
  const server = await new Promise<Server>((resolve) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

function resetFullDb(): void {
  closeDb();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-tenants-'));
  process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
  process.env.WORKSPACE_PARENT = path.join(tempDir, 'openclaw');
  initSchema();
}

function cleanup(): void {
  closeDb();
  if (originalDbPath == null) delete process.env.AGENT_HQ_DB_PATH;
  else process.env.AGENT_HQ_DB_PATH = originalDbPath;
  if (originalWorkspaceParent == null) delete process.env.WORKSPACE_PARENT;
  else process.env.WORKSPACE_PARENT = originalWorkspaceParent;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
}

async function json<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
  });
  const body = await res.json() as T;
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body;
}

async function setActiveTenant(baseUrl: string, tenantId: number): Promise<void> {
  await json(`${baseUrl}/api/v1/tenants/active`, {
    method: 'PUT',
    body: JSON.stringify({ tenant_id: tenantId }),
  });
}

describe('tenant workspace isolation', () => {
  afterEach(cleanup);

  it('backfills legacy tenant-owned rows into the default tenant', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-tenant-backfill-'));
    const db = new Database(path.join(tempDir, 'legacy.db'));
    db.exec(`
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
      CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);
      CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
      INSERT INTO projects (name) VALUES ('Legacy Project');
      INSERT INTO tasks (title) VALUES ('Legacy Task');
      INSERT INTO agents (name) VALUES ('Legacy Agent');
    `);

    const defaultTenantId = ensureTenantSchema(db);

    expect(defaultTenantId).toBeGreaterThan(0);
    expect((db.prepare(`SELECT tenant_id FROM projects LIMIT 1`).get() as { tenant_id: number }).tenant_id).toBe(defaultTenantId);
    expect((db.prepare(`SELECT tenant_id FROM tasks LIMIT 1`).get() as { tenant_id: number }).tenant_id).toBe(defaultTenantId);
    expect((db.prepare(`SELECT tenant_id FROM agents LIMIT 1`).get() as { tenant_id: number }).tenant_id).toBe(defaultTenantId);
    db.close();
  });

  it('renames the legacy default company tenant label during tenant schema repair', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-tenant-name-repair-'));
    const db = new Database(path.join(tempDir, 'legacy-name.db'));
    db.exec(`
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE tenants (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        slug       TEXT NOT NULL UNIQUE,
        is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO tenants (id, name, slug, is_default)
      VALUES
        (1, 'Default Company', 'default', 1),
        (2, 'Acme Company', 'acme-company', 0);
    `);

    const defaultTenantId = ensureTenantSchema(db);

    expect(defaultTenantId).toBe(1);
    expect((db.prepare(`SELECT name FROM tenants WHERE id = 1`).get() as { name: string }).name).toBe('Default Tenant');
    expect((db.prepare(`SELECT name FROM tenants WHERE id = 2`).get() as { name: string }).name).toBe('Acme Company');
    db.close();
  });

  it('creates tenants with default starter data idempotently by slug', async () => {
    resetFullDb();
    const { server, baseUrl } = await startServer();
    try {
      const first = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Acme', slug: 'acme', set_active: true }),
      });
      const retry = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Acme', slug: 'acme', set_active: true }),
      });

      expect(retry.tenant.id).toBe(first.tenant.id);
      const db = getDb();
      expect((db.prepare(`SELECT COUNT(*) AS n FROM tenants WHERE slug = 'acme'`).get() as { n: number }).n).toBe(1);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE tenant_id = ?`).get(first.tenant.id) as { n: number }).n).toBe(1);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE tenant_id = ? AND name = ?`).get(first.tenant.id, DEFAULT_PROJECT_NAME) as { n: number }).n).toBe(1);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM sprints WHERE tenant_id = ?`).get(first.tenant.id) as { n: number }).n).toBe(3);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE tenant_id = ? AND system_role = ?`).get(first.tenant.id, ATLAS_SYSTEM_ROLE) as { n: number }).n).toBe(1);
      const atlasAgent = db.prepare(`
        SELECT id, workspace_path
        FROM agents
        WHERE tenant_id = ? AND system_role = ?
      `).get(first.tenant.id, ATLAS_SYSTEM_ROLE) as { id: number; workspace_path: string };
      expect(atlasAgent.workspace_path).toContain(path.join('openclaw', 'workspace-atlas-acme'));
      expect(fs.existsSync(atlasAgent.workspace_path)).toBe(true);
      const atlasSync = materializeAgentMcpConfig({
        db,
        agentId: atlasAgent.id,
        workingDirectory: atlasAgent.workspace_path,
      });
      expect(atlasSync.ok).toBe(true);
      expect(atlasSync.count).toBe(1);
      const atlasMcpConfig = JSON.parse(fs.readFileSync(path.join(atlasAgent.workspace_path, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
      expect(Object.keys(atlasMcpConfig.mcpServers).filter((key) => key.startsWith('agent-hq__agent-'))).toEqual([`agent-hq__agent-${atlasAgent.id}`]);
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM agents
        WHERE tenant_id = ?
          AND system_role IN (${STARTER_AGENT_DEFINITIONS.map(() => '?').join(', ')})
      `).get(first.tenant.id, ...STARTER_AGENT_DEFINITIONS.map((definition) => definition.systemRole)) as { n: number }).n).toBe(4);
      const starterAgents = db.prepare(`
        SELECT id, name, enabled, workspace_path, openclaw_agent_id, runtime_type, runtime_config, preferred_provider, model, job_instructions, skill_names
        FROM agents
        WHERE tenant_id = ?
          AND system_role IN (${STARTER_AGENT_DEFINITIONS.map(() => '?').join(', ')})
        ORDER BY name ASC
      `).all(first.tenant.id, ...STARTER_AGENT_DEFINITIONS.map((definition) => definition.systemRole)) as Array<{
        id: number;
        name: string;
        enabled: number;
        workspace_path: string;
        openclaw_agent_id: string | null;
        runtime_type: string;
        runtime_config: string;
        preferred_provider: string;
        model: string | null;
        job_instructions: string;
        skill_names: string;
      }>;
      expect(starterAgents.map((agent) => agent.name).sort()).toEqual(['Developer Agent', 'Ops Agent', 'PM Agent', 'Review Agent']);
      for (const agent of starterAgents) {
        const definition = STARTER_AGENT_DEFINITIONS.find((entry) => entry.name === agent.name);
        if (!definition) throw new Error(`missing starter definition for ${agent.name}`);
        const skillNames = JSON.parse(agent.skill_names) as string[];
        const runtimeConfig = JSON.parse(agent.runtime_config) as {
          provisioning_state?: string;
          provisioning_template?: {
            identity_doc_model?: string;
            identity_docs?: Record<string, string>;
            workspace_path?: string | null;
            openclaw_agent_id?: string | null;
            workflow_assignments?: string[];
            contract_assignments?: string[];
            mcp_capabilities?: string[];
            mcp_server_slugs?: string[];
            tool_slugs?: string[];
            skill_names?: string[];
          };
        };
        expect(skillNames).toEqual(definition.skillNames);
        expect(skillNames).not.toEqual(expect.arrayContaining(['atlas-agent-hq-admin', 'cover-agent']));
        expect(agent.enabled).toBe(0);
        expect(agent.workspace_path).toContain(path.join('openclaw', `workspace-acme-${definition.systemRole.split('.').pop()}`));
        expect(fs.existsSync(agent.workspace_path)).toBe(true);
        expect(agent.openclaw_agent_id).toBe(`acme-${definition.systemRole.split('.').pop()}`);
        expect(agent.runtime_type).toBe('openclaw');
        expect(agent.preferred_provider).toBe('anthropic');
        expect(agent.model).toBeNull();
        expect(agent.job_instructions.length).toBeGreaterThan(0);
        expect(runtimeConfig.provisioning_state).toBe('provisioned');
        expect(runtimeConfig.provisioning_template?.identity_doc_model).toBe('inline_runtime_config_documents');
        expect(runtimeConfig.provisioning_template?.identity_docs?.['IDENTITY.md']).toContain(agent.name);
        expect(runtimeConfig.provisioning_template?.workspace_path).toBe(agent.workspace_path);
        expect(runtimeConfig.provisioning_template?.openclaw_agent_id).toBe(agent.openclaw_agent_id);
        expect(runtimeConfig.provisioning_template?.workflow_assignments).toEqual(expect.arrayContaining(['generic']));
        expect(runtimeConfig.provisioning_template?.contract_assignments?.length).toBeGreaterThan(0);
        expect(runtimeConfig.provisioning_template?.mcp_capabilities).toEqual(expect.arrayContaining(['tasks.write_active_lifecycle']));
        expect(runtimeConfig.provisioning_template?.mcp_server_slugs).toEqual(['agent-hq']);
        expect(runtimeConfig.provisioning_template?.tool_slugs).toEqual(definition.toolSlugs);
        expect(runtimeConfig.provisioning_template?.skill_names).toEqual(definition.skillNames);
        const agentSync = materializeAgentMcpConfig({
          db,
          agentId: agent.id,
          workingDirectory: agent.workspace_path,
        });
        expect(agentSync.ok).toBe(true);
        expect(agentSync.count).toBe(1);
        const mcpConfig = JSON.parse(fs.readFileSync(path.join(agent.workspace_path, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
        expect(Object.keys(mcpConfig.mcpServers).filter((key) => key.startsWith('agent-hq__agent-'))).toEqual([`agent-hq__agent-${agent.id}`]);
        const assignedToolSlugs = db.prepare(`
          SELECT t.slug
          FROM agent_tool_assignments ata
          JOIN tools t ON t.id = ata.tool_id
          WHERE ata.agent_id = ? AND ata.enabled = 1
          ORDER BY t.slug ASC
        `).all(agent.id).map((row: any) => row.slug);
        expect(assignedToolSlugs).toEqual([...definition.toolSlugs].sort());
      }
      const pmAgent = db.prepare(`
        SELECT id
        FROM agents
        WHERE tenant_id = ? AND system_role = ?
      `).get(first.tenant.id, STARTER_AGENT_DEFINITIONS[0].systemRole) as { id: number };
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM agent_mcp_capability_policies
        WHERE agent_id = ? AND enabled = 1
      `).get(pmAgent.id) as { n: number }).n).toBeGreaterThan(0);
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM agent_mcp_assignments ama
        JOIN agents a ON a.id = ama.agent_id
        JOIN mcp_servers s ON s.id = ama.mcp_server_id
        WHERE a.tenant_id = ?
          AND s.slug = 'agent-hq'
          AND s.tenant_id = a.tenant_id
          AND ama.enabled = 1
      `).get(first.tenant.id) as { n: number }).n).toBe(STARTER_AGENT_DEFINITIONS.length + 1);
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM agent_mcp_assignments ama
        JOIN agents a ON a.id = ama.agent_id
        JOIN mcp_servers s ON s.id = ama.mcp_server_id
        WHERE s.slug = 'agent-hq'
          AND a.tenant_id != s.tenant_id
      `).get() as { n: number }).n).toBe(0);
      const starterSprint = db.prepare(`SELECT id FROM sprints WHERE tenant_id = ? LIMIT 1`).get(first.tenant.id) as { id: number };
      expect((db.prepare(`SELECT COUNT(*) AS n FROM sprint_task_statuses WHERE sprint_id = ?`).get(starterSprint.id) as { n: number }).n).toBeGreaterThan(0);
      const expectedRelationshipCounts: Record<string, number> = { dev: 5, generic: 1, ops: 1 };
      for (const sprintType of ['dev', 'generic', 'ops']) {
        const starterSprint = db.prepare(`SELECT id FROM sprints WHERE tenant_id = ? AND sprint_type = ? LIMIT 1`).get(first.tenant.id, sprintType) as { id: number };
        expect(starterSprint).toBeTruthy();
        expect((db.prepare(`SELECT COUNT(*) AS n FROM sprint_task_statuses WHERE sprint_id = ?`).get(starterSprint.id) as { n: number }).n).toBeGreaterThan(0);
        expect((db.prepare(`SELECT COUNT(*) AS n FROM sprint_task_transitions WHERE sprint_id = ?`).get(starterSprint.id) as { n: number }).n).toBeGreaterThan(0);
        expect((db.prepare(`SELECT COUNT(*) AS n FROM sprint_type_task_statuses WHERE sprint_type_key = ?`).get(sprintType) as { n: number }).n).toBeGreaterThan(0);
        expect((db.prepare(`
          SELECT COUNT(*) AS n
          FROM sprint_type_relationship_types
          WHERE tenant_id = ? AND sprint_type_key = ?
        `).get(first.tenant.id, sprintType) as { n: number }).n).toBe(expectedRelationshipCounts[sprintType]);
      }
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM sprint_task_routing_rules rr
        JOIN agents a ON a.id = rr.agent_id
        JOIN projects p ON p.id = rr.project_id
        WHERE rr.tenant_id = ?
          AND p.name = ?
          AND rr.sprint_type = 'dev'
          AND rr.task_type = 'backend'
          AND rr.status = 'ready'
          AND a.system_role = ?
      `).get(first.tenant.id, DEFAULT_PROJECT_NAME, STARTER_AGENT_DEFINITIONS.find((definition) => definition.name === 'Developer Agent')?.systemRole) as { n: number }).n).toBe(1);
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM sprint_task_routing_rules rr
        JOIN agents a ON a.id = rr.agent_id
        JOIN projects p ON p.id = rr.project_id
        WHERE rr.tenant_id = ?
          AND p.name = ?
          AND rr.sprint_type = 'dev'
          AND rr.task_type = 'backend'
          AND rr.status = 'review'
          AND a.system_role = ?
      `).get(first.tenant.id, DEFAULT_PROJECT_NAME, STARTER_AGENT_DEFINITIONS.find((definition) => definition.name === 'Review Agent')?.systemRole) as { n: number }).n).toBe(1);
      const defaultProject = db.prepare(`SELECT id FROM projects WHERE tenant_id = ? AND name = ?`).get(first.tenant.id, DEFAULT_PROJECT_NAME) as { id: number };
      const devWorkflow = db.prepare(`SELECT id FROM sprints WHERE tenant_id = ? AND project_id = ? AND sprint_type = 'dev'`).get(first.tenant.id, defaultProject.id) as { id: number };
      const sampleTaskId = Number(db.prepare(`
        INSERT INTO tasks (tenant_id, project_id, sprint_id, title, description, status, priority, task_type, story_points)
        VALUES (?, ?, ?, 'Sample backend task', '', 'ready', 'medium', 'backend', 3)
      `).run(first.tenant.id, defaultProject.id, devWorkflow.id).lastInsertRowid);
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM tasks t
        JOIN sprints s ON s.id = t.sprint_id
        JOIN sprint_task_routing_rules rr
          ON rr.tenant_id = t.tenant_id
         AND rr.project_id = t.project_id
         AND rr.sprint_type = s.sprint_type
         AND (rr.sprint_id = t.sprint_id OR rr.sprint_id IS NULL)
         AND rr.status = t.status
         AND rr.task_type = t.task_type
        JOIN agents a ON a.id = rr.agent_id AND a.enabled = 0
        WHERE t.id = ?
          AND a.system_role = ?
      `).get(sampleTaskId, STARTER_AGENT_DEFINITIONS.find((definition) => definition.name === 'Developer Agent')?.systemRole) as { n: number }).n).toBeGreaterThan(0);
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM story_point_model_routing mr
        JOIN projects p ON p.id = mr.project_id
        WHERE mr.tenant_id = ?
          AND p.name = ?
          AND mr.provider = 'anthropic'
      `).get(first.tenant.id, DEFAULT_PROJECT_NAME) as { n: number }).n).toBe(3);
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM sprint_type_relationship_types
        WHERE tenant_id != ? AND sprint_type_key IN ('dev', 'generic', 'ops')
      `).get(first.tenant.id) as { n: number }).n).toBeGreaterThan(0);
    } finally {
      await stopServer(server);
    }
  });

  it('does not restore a deleted starter workflow during ordinary tenant and startup paths', async () => {
    resetFullDb();
    const { server, baseUrl } = await startServer();
    try {
      const created = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'No Reseed', slug: 'no-reseed', set_active: true }),
      });
      const db = getDb();
      const opsWorkflow = db.prepare(`
        SELECT id
        FROM sprints
        WHERE tenant_id = ? AND sprint_type = 'ops'
        LIMIT 1
      `).get(created.tenant.id) as { id: number };
      expect(opsWorkflow).toBeTruthy();
      const defaultTenantId = (db.prepare(`SELECT id FROM tenants WHERE slug = 'default'`).get() as { id: number }).id;
      const defaultServer = db.prepare(`
        SELECT id
        FROM mcp_servers
        WHERE tenant_id = ? AND slug = 'agent-hq'
      `).get(defaultTenantId) as { id: number };
      const localServer = db.prepare(`
        SELECT id
        FROM mcp_servers
        WHERE tenant_id = ? AND slug = 'agent-hq'
      `).get(created.tenant.id) as { id: number };
      const developer = db.prepare(`
        SELECT id
        FROM agents
        WHERE tenant_id = ? AND name = 'Developer Agent'
        ORDER BY id ASC
        LIMIT 1
      `).get(created.tenant.id) as { id: number } | undefined;
      expect(developer).toBeTruthy();
      db.prepare(`
        DELETE FROM agent_mcp_assignments
        WHERE agent_id = ? AND mcp_server_id = ?
      `).run(developer!.id, localServer.id);
      db.prepare(`
        INSERT OR IGNORE INTO agent_mcp_assignments (agent_id, mcp_server_id, overrides, enabled)
        VALUES (?, ?, '{"repair":"preserve"}', 1)
      `).run(developer!.id, defaultServer.id);

      db.prepare(`DELETE FROM sprints WHERE id = ?`).run(opsWorkflow.id);
      const ledgerCountBefore = (db.prepare(`
        SELECT COUNT(*) AS n
        FROM default_package_applications
        WHERE tenant_id = ?
      `).get(created.tenant.id) as { n: number }).n;
      const installLedgerCountBefore = (db.prepare(`
        SELECT COUNT(*) AS n
        FROM default_package_applications
        WHERE tenant_id = ? AND mode = 'install'
      `).get(created.tenant.id) as { n: number }).n;

      await json(`${baseUrl}/api/v1/tenants`);
      await json(`${baseUrl}/api/v1/tenants/active`);
      await setActiveTenant(baseUrl, created.tenant.id);
      await json(`${baseUrl}/api/v1/tasks`);
      const retry = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'No Reseed', slug: 'no-reseed', set_active: true }),
      });
      expect(retry.tenant.id).toBe(created.tenant.id);
      ensureTenantSchema(db);
      initSchema();

      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM sprints
        WHERE tenant_id = ? AND sprint_type = 'ops'
      `).get(created.tenant.id) as { n: number }).n).toBe(0);
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM sprints
        WHERE tenant_id = ? AND name = 'Operations'
      `).get(created.tenant.id) as { n: number }).n).toBe(0);
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM default_package_applications
        WHERE tenant_id = ?
      `).get(created.tenant.id) as { n: number }).n).toBe(ledgerCountBefore);
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM default_package_applications
        WHERE tenant_id = ? AND mode = 'install'
      `).get(created.tenant.id) as { n: number }).n).toBe(installLedgerCountBefore);
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM agent_mcp_assignments
        WHERE agent_id = ? AND mcp_server_id = ?
      `).get(developer!.id, defaultServer.id) as { n: number }).n).toBe(0);
      expect(db.prepare(`
        SELECT overrides, enabled
        FROM agent_mcp_assignments
        WHERE agent_id = ? AND mcp_server_id = ?
      `).get(developer!.id, localServer.id)).toMatchObject({ overrides: '{"repair":"preserve"}', enabled: 1 });
    } finally {
      await stopServer(server);
    }
  });

  it('restores deleted starter workflows when default package reinstall is explicitly requested', async () => {
    resetFullDb();
    const { server, baseUrl } = await startServer();
    try {
      const created = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Repair Co', slug: 'repair-co', set_active: true }),
      });
      const db = getDb();
      const opsWorkflow = db.prepare(`
        SELECT id
        FROM sprints
        WHERE tenant_id = ? AND sprint_type = 'ops'
        LIMIT 1
      `).get(created.tenant.id) as { id: number };
      expect(opsWorkflow).toBeTruthy();
      db.prepare(`DELETE FROM sprints WHERE id = ?`).run(opsWorkflow.id);

      const reinstall = await json<{ ok: boolean; result: { mode: string; created: Record<string, number> } }>(`${baseUrl}/api/v1/tenants/${created.tenant.id}/default-package/reinstall`, {
        method: 'POST',
      });

      expect(reinstall).toMatchObject({ ok: true, result: { mode: 'reinstall' } });
      expect(reinstall.result.created.workflows).toBeGreaterThanOrEqual(1);
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM sprints
        WHERE tenant_id = ? AND sprint_type = 'ops' AND name = 'Operations'
      `).get(created.tenant.id) as { n: number }).n).toBe(1);
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM default_package_applications
        WHERE tenant_id = ? AND mode = 'reinstall'
      `).get(created.tenant.id) as { n: number }).n).toBe(1);
    } finally {
      await stopServer(server);
    }
  });

  it('creates a tenant when migrated starter workflow status config exists for multiple tenants', async () => {
    resetFullDb();
    const { server, baseUrl } = await startServer();
    try {
      const acme = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
      });
      const beta = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Beta', slug: 'beta' }),
      });

      const db = getDb();
      const defaultTenant = db.prepare(`SELECT id FROM tenants WHERE is_default = 1 LIMIT 1`).get() as { id: number };
      const insertStatus = db.prepare(`
        INSERT OR IGNORE INTO sprint_type_task_statuses (
          tenant_id, sprint_type_key, status_key, label, color, terminal, is_system,
          allowed_transitions_json, stage_order, is_default_entry, metadata_json,
          created_at, updated_at
        ) VALUES (?, 'generic', 'todo', ?, 'slate', 0, 1, '[]', 0, 1, '{}', datetime('now'), datetime('now'))
      `);
      insertStatus.run(defaultTenant.id, 'Default Todo');
      insertStatus.run(acme.tenant.id, 'Acme Todo');
      insertStatus.run(beta.tenant.id, 'Beta Todo');

      const created = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Gamma', slug: 'gamma' }),
      });

      const starterSprint = db.prepare(`
        SELECT id
        FROM sprints
        WHERE tenant_id = ? AND sprint_type = 'generic'
        LIMIT 1
      `).get(created.tenant.id) as { id: number };
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM sprint_task_statuses
        WHERE sprint_id = ? AND status_key = 'todo'
      `).get(starterSprint.id) as { n: number }).n).toBe(1);
    } finally {
      await stopServer(server);
    }
  });

  it('scopes workflow metadata readback to the active tenant starter definitions', async () => {
    resetFullDb();
    const { server, baseUrl } = await startServer();
    try {
      const acme = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
      });
      const beta = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Beta', slug: 'beta' }),
      });

      const db = getDb();
      db.prepare(`
        UPDATE sprint_type_task_statuses
        SET label = 'Acme Todo'
        WHERE tenant_id = ? AND sprint_type_key = 'generic' AND status_key = 'todo'
      `).run(acme.tenant.id);
      db.prepare(`
        UPDATE sprint_type_task_statuses
        SET label = 'Beta Todo'
        WHERE tenant_id = ? AND sprint_type_key = 'generic' AND status_key = 'todo'
      `).run(beta.tenant.id);

      await setActiveTenant(baseUrl, acme.tenant.id);
      const acmeMetadata = await json<{
        statuses: Array<{ name: string; label: string }>;
        relationship_types: Array<{ tenant_id?: number; key: string }>;
      }>(`${baseUrl}/api/v1/sprints/workflow-metadata?sprint_type=generic`);
      expect(acmeMetadata.statuses.map((status) => status.name)).toEqual(['todo', 'ready', 'in_progress', 'review', 'done']);
      expect(acmeMetadata.statuses.find((status) => status.name === 'todo')?.label).toBe('Acme Todo');
      expect(acmeMetadata.relationship_types).toEqual([
        expect.objectContaining({ tenant_id: acme.tenant.id, key: 'blocked_by' }),
      ]);

      await setActiveTenant(baseUrl, beta.tenant.id);
      const betaMetadata = await json<{
        statuses: Array<{ name: string; label: string }>;
        relationship_types: Array<{ tenant_id?: number; key: string }>;
      }>(`${baseUrl}/api/v1/sprints/workflow-metadata?sprint_type=generic`);
      expect(betaMetadata.statuses.map((status) => status.name)).toEqual(['todo', 'ready', 'in_progress', 'review', 'done']);
      expect(betaMetadata.statuses.find((status) => status.name === 'todo')?.label).toBe('Beta Todo');
      expect(betaMetadata.relationship_types).toEqual([
        expect.objectContaining({ tenant_id: beta.tenant.id, key: 'blocked_by' }),
      ]);
    } finally {
      await stopServer(server);
    }
  });

  it('keeps legacy company routes and request aliases working for compatibility', async () => {
    resetFullDb();
    const { server, baseUrl } = await startServer();
    try {
      const created = await json<{ tenant: { id: number; name: string } }>(`${baseUrl}/api/v1/companies`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Legacy Alias', slug: 'legacy-alias' }),
      });

      const selected = await json<{ active_tenant_id: number }>(`${baseUrl}/api/v1/companies/active`, {
        method: 'PUT',
        body: JSON.stringify({ company_id: created.tenant.id }),
      });
      expect(selected.active_tenant_id).toBe(created.tenant.id);

      const deleted = await json<{ ok: boolean; deleted_tenant: { id: number } }>(`${baseUrl}/api/v1/companies/${created.tenant.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ company_name: created.tenant.name }),
      });
      expect(deleted).toMatchObject({ ok: true, deleted_tenant: { id: created.tenant.id } });
    } finally {
      await stopServer(server);
    }
  });

  it('blocks deleting the default tenant through the tenant API', async () => {
    resetFullDb();
    const { server, baseUrl } = await startServer();
    try {
      const db = getDb();
      const defaultTenant = db.prepare(`SELECT id, name FROM tenants WHERE is_default = 1`).get() as { id: number; name: string };
      const response = await fetch(`${baseUrl}/api/v1/tenants/${defaultTenant.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: defaultTenant.name }),
      });
      const body = await response.json() as { error?: string };

      expect(response.status).toBe(409);
      expect(body.error).toMatch(/Default tenant cannot be deleted/);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM tenants WHERE is_default = 1`).get() as { n: number }).n).toBe(1);
    } finally {
      await stopServer(server);
    }
  });

  it('requires the exact tenant name before deletion', async () => {
    resetFullDb();
    const { server, baseUrl } = await startServer();
    try {
      const acme = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
      });

      const response = await fetch(`${baseUrl}/api/v1/tenants/${acme.tenant.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: 'wrong name' }),
      });
      const body = await response.json() as { error?: string };

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/requires typing the exact tenant name/);
      expect((getDb().prepare(`SELECT COUNT(*) AS n FROM tenants WHERE id = ?`).get(acme.tenant.id) as { n: number }).n).toBe(1);
    } finally {
      await stopServer(server);
    }
  });

  it('deletes an active non-default tenant and switches to a remaining tenant', async () => {
    resetFullDb();
    const { server, baseUrl } = await startServer();
    try {
      const acme = await json<{ tenant: { id: number; name: string } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Acme', slug: 'acme', set_active: true }),
      });
      const beta = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Beta', slug: 'beta' }),
      });

      const db = getDb();
      const defaultTenant = db.prepare(`SELECT id FROM tenants WHERE is_default = 1`).get() as { id: number };
      const acmeAgent = db.prepare(`SELECT id FROM agents WHERE tenant_id = ? LIMIT 1`).get(acme.tenant.id) as { id: number };
      const acmeProject = db.prepare(`SELECT id FROM projects WHERE tenant_id = ? LIMIT 1`).get(acme.tenant.id) as { id: number };
      const acmeSprint = db.prepare(`SELECT id FROM sprints WHERE tenant_id = ? LIMIT 1`).get(acme.tenant.id) as { id: number };
      const acmeTask = {
        id: Number(db.prepare(`
          INSERT INTO tasks (tenant_id, project_id, sprint_id, title, description, status, priority)
          VALUES (?, ?, ?, 'Acme cleanup task', '', 'todo', 'medium')
        `).run(acme.tenant.id, acmeProject.id, acmeSprint.id).lastInsertRowid),
      };
      const acmeToolId = Number(db.prepare(`
        INSERT INTO tools (tenant_id, name, slug, implementation_type, implementation_body)
        VALUES (?, 'Acme Tool', 'acme-delete-tool', 'bash', 'echo ok')
      `).run(acme.tenant.id).lastInsertRowid);
      const acmeServerId = Number(db.prepare(`
        INSERT INTO mcp_servers (tenant_id, name, slug, command)
        VALUES (?, 'Acme MCP', 'acme-delete-mcp', 'node')
      `).run(acme.tenant.id).lastInsertRowid);
      db.prepare(`INSERT INTO agent_tool_assignments (agent_id, tool_id) VALUES (?, ?)`).run(acmeAgent.id, acmeToolId);
      db.prepare(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id) VALUES (?, ?)`).run(acmeAgent.id, acmeServerId);
      db.prepare(`INSERT INTO mcp_api_keys (agent_id, name, key_prefix, key_hash) VALUES (?, 'Acme Key', 'acme', 'hash-acme')`).run(acmeAgent.id);
      const instanceId = Number(db.prepare(`INSERT INTO job_instances (agent_id, task_id, status) VALUES (?, ?, 'done')`).run(acmeAgent.id, acmeTask.id).lastInsertRowid);
      const sessionId = Number(db.prepare(`
        INSERT INTO sessions (tenant_id, external_key, runtime, agent_id, task_id, instance_id, project_id)
        VALUES (?, 'acme-session', 'openclaw', ?, ?, ?, ?)
      `).run(acme.tenant.id, acmeAgent.id, acmeTask.id, instanceId, acmeProject.id).lastInsertRowid);
      db.prepare(`INSERT INTO session_messages (session_id, ordinal, role, content, timestamp) VALUES (?, 1, 'user', 'hi', datetime('now'))`).run(sessionId);
      db.prepare(`INSERT INTO chat_messages (id, agent_id, role, content, session_key) VALUES ('acme-chat', ?, 'user', 'hi', 'acme-session')`).run(acmeAgent.id);
      db.prepare(`INSERT INTO canonical_chat_sessions (agent_id, channel, session_key) VALUES (?, 'web', 'acme-session')`).run(acmeAgent.id);
      db.prepare(`
        INSERT INTO story_point_model_routing (tenant_id, project_id, sprint_id, sprint_type, max_points, model)
        VALUES (?, ?, ?, 'generic', 1, 'test-model')
      `).run(acme.tenant.id, acmeProject.id, acmeSprint.id);
      db.prepare(`
        INSERT INTO external_event_mappings (tenant_id, project_id, event_name)
        VALUES (?, ?, 'acme.delete.test')
      `).run(acme.tenant.id, acmeProject.id);

      const response = await fetch(`${baseUrl}/api/v1/tenants/${acme.tenant.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: 'Acme' }),
      });
      const body = await response.json() as {
        ok?: boolean;
        active_tenant_id?: number;
        active_tenant_changed?: boolean;
        tenants?: Array<{ id: number }>;
        deleted_counts?: Record<string, number>;
        error?: string;
      };

      if (response.status !== 200) {
        throw new Error(`Expected 200, received ${response.status}: ${JSON.stringify(body)}`);
      }

      expect(body.ok).toBe(true);
      expect(body.active_tenant_changed).toBe(true);
      expect(body.active_tenant_id).toBe(defaultTenant.id);
      expect(body.tenants?.some((tenant) => tenant.id === acme.tenant.id)).toBe(false);
      expect(body.tenants?.some((tenant) => tenant.id === beta.tenant.id)).toBe(true);
      expect(body.deleted_counts?.tenants).toBe(1);

      for (const table of ['projects', 'sprints', 'tasks', 'agents', 'tools', 'mcp_servers', 'sessions', 'story_point_model_routing', 'external_event_mappings']) {
        expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`).get(acme.tenant.id) as { n: number }).n).toBe(0);
      }
      expect((db.prepare(`SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ?`).get(sessionId) as { n: number }).n).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE id = 'acme-chat'`).get() as { n: number }).n).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM canonical_chat_sessions WHERE agent_id = ?`).get(acmeAgent.id) as { n: number }).n).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM job_instances WHERE id = ?`).get(instanceId) as { n: number }).n).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM agent_tool_assignments WHERE tool_id = ?`).get(acmeToolId) as { n: number }).n).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM agent_mcp_assignments WHERE mcp_server_id = ?`).get(acmeServerId) as { n: number }).n).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM mcp_api_keys WHERE agent_id = ?`).get(acmeAgent.id) as { n: number }).n).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE tenant_id = ?`).get(beta.tenant.id) as { n: number }).n).toBeGreaterThan(0);
    } finally {
      await stopServer(server);
    }
  });

  it('seeds each new tenant with its own project-scoped Atlas agent', async () => {
    resetFullDb();
    const { server, baseUrl } = await startServer();
    try {
      const acme = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
      });
      const beta = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Beta', slug: 'beta' }),
      });

      const db = getDb();
      const defaultTenantId = (db.prepare(`SELECT id FROM tenants WHERE slug = 'default'`).get() as { id: number }).id;
      const acmeAtlas = db.prepare(`
        SELECT id, tenant_id, project_id, name, session_key, openclaw_agent_id, workspace_path, system_role, job_instructions
        FROM agents
        WHERE tenant_id = ? AND system_role = ?
      `).get(acme.tenant.id, ATLAS_SYSTEM_ROLE) as { id: number; tenant_id: number; project_id: number; name: string; session_key: string; openclaw_agent_id: string; workspace_path: string; system_role: string; job_instructions: string };
      const betaAtlas = db.prepare(`
        SELECT id, tenant_id, project_id, name, session_key, openclaw_agent_id, workspace_path, system_role
        FROM agents
        WHERE tenant_id = ? AND system_role = ?
      `).get(beta.tenant.id, ATLAS_SYSTEM_ROLE) as typeof acmeAtlas;
      const acmeProject = db.prepare(`SELECT id FROM projects WHERE tenant_id = ? AND name = ?`).get(acme.tenant.id, DEFAULT_PROJECT_NAME) as { id: number };
      const betaProject = db.prepare(`SELECT id FROM projects WHERE tenant_id = ? AND name = ?`).get(beta.tenant.id, DEFAULT_PROJECT_NAME) as { id: number };
      const defaultAtlas = db.prepare(`SELECT id, tenant_id, session_key, openclaw_agent_id FROM agents WHERE tenant_id = ? AND system_role = ?`).get(defaultTenantId, ATLAS_SYSTEM_ROLE) as { id: number; tenant_id: number; session_key: string; openclaw_agent_id: string };

      expect(acmeAtlas.name).toBe(ATLAS_AGENT_NAME);
      expect(acmeAtlas.tenant_id).toBe(acme.tenant.id);
      expect(acmeAtlas.project_id).toBe(acmeProject.id);
      expect(acmeAtlas.session_key).toMatch(/^agent:acme-default-project:atlas:/);
      expect(acmeAtlas.openclaw_agent_id).toBe('atlas-acme');
      expect(acmeAtlas.workspace_path).toContain('workspace-atlas-acme');
      expect(acmeAtlas.job_instructions).toContain('tenant data isolated');
      expect(acmeAtlas.job_instructions).not.toMatch(/Masiah|Dev Environment Lease Manager|agent-hq-dev|workspace-agent-hq-backend|\/Users\/nordini/);
      expect(betaAtlas.name).toBe(ATLAS_AGENT_NAME);
      expect(betaAtlas.tenant_id).toBe(beta.tenant.id);
      expect(betaAtlas.project_id).toBe(betaProject.id);
      expect(betaAtlas.session_key).toMatch(/^agent:beta-default-project:atlas:/);
      expect(betaAtlas.openclaw_agent_id).toBe('atlas-beta');
      expect(betaAtlas.id).not.toBe(acmeAtlas.id);
      expect(betaAtlas.session_key).not.toBe(acmeAtlas.session_key);
      expect(defaultAtlas.session_key).toBe('agent:atlas:main');
      expect(defaultAtlas.openclaw_agent_id).toBe('atlas');

      await setActiveTenant(baseUrl, acme.tenant.id);
      const acmeAgents = await json<Array<{ id: number; tenant_id: number; name: string; system_role: string | null }>>(`${baseUrl}/api/v1/agents`);
      await setActiveTenant(baseUrl, beta.tenant.id);
      const betaAgents = await json<Array<{ id: number; tenant_id: number; name: string; system_role: string | null }>>(`${baseUrl}/api/v1/agents`);
      await setActiveTenant(baseUrl, defaultTenantId);
      const defaultAgents = await json<Array<{ id: number; tenant_id: number; name: string; system_role: string | null }>>(`${baseUrl}/api/v1/agents`);

      expect(acmeAgents.map((agent) => agent.id)).toContain(acmeAtlas.id);
      expect(acmeAgents.map((agent) => agent.id)).not.toContain(defaultAtlas.id);
      expect(betaAgents.map((agent) => agent.id)).toContain(betaAtlas.id);
      expect(betaAgents.map((agent) => agent.id)).not.toContain(defaultAtlas.id);
      expect(defaultAgents.map((agent) => agent.id)).toContain(defaultAtlas.id);
      expect(defaultAgents.map((agent) => agent.id)).not.toContain(acmeAtlas.id);

      for (const doc of ['SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md', 'MEMORY.md', 'AGENTS.md']) {
        const docPath = path.join(acmeAtlas.workspace_path, doc);
        expect(fs.existsSync(docPath)).toBe(true);
        expect(fs.readFileSync(docPath, 'utf-8')).not.toMatch(/Masiah|Dev Environment Lease Manager|agent-hq-dev|workspace-agent-hq-backend|\/Users\/nordini/);
      }
    } finally {
      await stopServer(server);
    }
  });

  it('provisions tenant-local Agent HQ MCP servers and materializes only the local assignment', async () => {
    resetFullDb();
    const { server, baseUrl } = await startServer();
    try {
      const acme = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
      });

      const db = getDb();
      const defaultTenantId = (db.prepare(`SELECT id FROM tenants WHERE slug = 'default'`).get() as { id: number }).id;
      const defaultServer = db.prepare(`
        SELECT id, tenant_id, slug
        FROM mcp_servers
        WHERE tenant_id = ? AND slug = 'agent-hq'
      `).get(defaultTenantId) as { id: number; tenant_id: number; slug: string };
      const acmeServer = db.prepare(`
        SELECT id, tenant_id, slug
        FROM mcp_servers
        WHERE tenant_id = ? AND slug = 'agent-hq'
      `).get(acme.tenant.id) as { id: number; tenant_id: number; slug: string };

      expect(defaultServer).toMatchObject({ tenant_id: defaultTenantId, slug: 'agent-hq' });
      expect(acmeServer).toMatchObject({ tenant_id: acme.tenant.id, slug: 'agent-hq' });
      expect(acmeServer.id).not.toBe(defaultServer.id);

      for (const definition of STARTER_AGENT_DEFINITIONS) {
        const agent = db.prepare(`
          SELECT id
          FROM agents
          WHERE tenant_id = ? AND system_role = ?
        `).get(acme.tenant.id, definition.systemRole) as { id: number };
        const assignment = db.prepare(`
          SELECT s.id AS server_id, s.tenant_id AS server_tenant_id, ama.enabled
          FROM agent_mcp_assignments ama
          JOIN mcp_servers s ON s.id = ama.mcp_server_id
          WHERE ama.agent_id = ? AND s.slug = 'agent-hq'
        `).all(agent.id) as Array<{ server_id: number; server_tenant_id: number; enabled: number }>;
        expect(assignment).toEqual([{ server_id: acmeServer.id, server_tenant_id: acme.tenant.id, enabled: 1 }]);
      }
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM agent_mcp_assignments ama
        JOIN agents a ON a.id = ama.agent_id
        JOIN mcp_servers s ON s.id = ama.mcp_server_id
        WHERE a.tenant_id != s.tenant_id
      `).get() as { n: number }).n).toBe(0);

      const acmeDeveloper = db.prepare(`
        SELECT id
        FROM agents
        WHERE tenant_id = ? AND system_role = ?
      `).get(
        acme.tenant.id,
        STARTER_AGENT_DEFINITIONS.find((definition) => definition.name === 'Developer Agent')?.systemRole,
      ) as { id: number };
      db.prepare(`
        INSERT OR IGNORE INTO agent_mcp_assignments (agent_id, mcp_server_id, overrides, enabled)
        VALUES (?, ?, '{}', 1)
      `).run(acmeDeveloper.id, defaultServer.id);

      const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-tenant-mcp-materialize-'));
      const result = materializeAgentMcpConfig({
        db,
        agentId: acmeDeveloper.id,
        workingDirectory,
      });
      const config = JSON.parse(fs.readFileSync(path.join(workingDirectory, '.mcp.json'), 'utf8')) as {
        mcpServers: Record<string, unknown>;
        agentHqManagedMcpServers: string[];
      };
      const agentHqKeys = Object.keys(config.mcpServers).filter((key) => key.startsWith('agent-hq__agent-'));

      expect(result.ok).toBe(true);
      expect(result.count).toBe(1);
      expect(agentHqKeys).toEqual([`agent-hq__agent-${acmeDeveloper.id}`]);
      expect(config.agentHqManagedMcpServers).toEqual([`agent-hq__agent-${acmeDeveloper.id}`]);
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM agent_mcp_assignments ama
        JOIN agents a ON a.id = ama.agent_id
        JOIN mcp_servers s ON s.id = ama.mcp_server_id
        WHERE a.tenant_id != s.tenant_id
      `).get() as { n: number }).n).toBe(0);

      await setActiveTenant(baseUrl, acme.tenant.id);
      const visibleServers = await json<Array<{ id: number; tenant_id: number; slug: string }>>(`${baseUrl}/api/v1/mcp-servers`);
      expect(visibleServers.filter((row) => row.slug === 'agent-hq')).toEqual([
        expect.objectContaining({ id: acmeServer.id, tenant_id: acme.tenant.id, slug: 'agent-hq' }),
      ]);
    } finally {
      await stopServer(server);
    }
  });

  it('resolves the default artifact workspace to the active tenant Atlas, not the default tenant Atlas', async () => {
    resetFullDb();
    const { server, baseUrl } = await startServer();
    try {
      const acme = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
      });

      const db = getDb();
      const defaultAtlas = db.prepare(`SELECT id, workspace_path FROM agents WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'default') AND system_role = ?`).get(ATLAS_SYSTEM_ROLE) as { id: number; workspace_path: string };
      const acmeAtlas = db.prepare(`SELECT id, workspace_path FROM agents WHERE tenant_id = ? AND system_role = ?`).get(acme.tenant.id, ATLAS_SYSTEM_ROLE) as { id: number; workspace_path: string };
      fs.mkdirSync(defaultAtlas.workspace_path, { recursive: true });
      fs.mkdirSync(acmeAtlas.workspace_path, { recursive: true });
      fs.writeFileSync(path.join(defaultAtlas.workspace_path, 'default-only.md'), 'default workspace', 'utf-8');
      fs.writeFileSync(path.join(acmeAtlas.workspace_path, 'acme-only.md'), 'acme workspace', 'utf-8');

      await setActiveTenant(baseUrl, acme.tenant.id);
      const tree = await json<{ root: string; children: Array<{ name: string }> }>(`${baseUrl}/api/v1/artifacts/tree`);
      expect(tree.root).toBe(acmeAtlas.workspace_path);
      expect(tree.children.map((child) => child.name)).toContain('acme-only.md');
      expect(tree.children.map((child) => child.name)).not.toContain('default-only.md');

      const crossTenantResponse = await fetch(`${baseUrl}/api/v1/artifacts/tree?agentId=${defaultAtlas.id}`);
      expect(crossTenantResponse.status).toBe(404);
    } finally {
      await stopServer(server);
    }
  });

  it('returns empty workspace state for an existing tenant with no provisioned agents', async () => {
    resetFullDb();
    const { server, baseUrl } = await startServer();
    try {
      const db = getDb();
      const tenantId = Number(db.prepare(`
        INSERT INTO tenants (name, slug, is_default)
        VALUES ('Legacy Empty', 'legacy-empty', 0)
      `).run().lastInsertRowid);
      const defaultAtlas = db.prepare(`SELECT workspace_path FROM agents WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'default') AND system_role = ?`).get(ATLAS_SYSTEM_ROLE) as { workspace_path: string };
      fs.mkdirSync(defaultAtlas.workspace_path, { recursive: true });
      fs.writeFileSync(path.join(defaultAtlas.workspace_path, 'default-only.md'), 'default workspace', 'utf-8');

      await setActiveTenant(baseUrl, tenantId);
      const agents = await json<Array<{ id: number }>>(`${baseUrl}/api/v1/agents`);
      const tree = await json<{ root: string; children: Array<{ name: string }> }>(`${baseUrl}/api/v1/artifacts/tree`);

      expect(agents).toEqual([]);
      expect(tree.root).toBe('');
      expect(tree.children).toEqual([]);
    } finally {
      await stopServer(server);
    }
  });

  it('seeds fresh tenants with only Agent HQ runtime and dispatcher workflow events', async () => {
    resetFullDb();
    const { server, baseUrl } = await startServer();
    try {
      const acme = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
      });

      const db = getDb();
      const sources = db.prepare(`
        SELECT DISTINCT source
        FROM external_event_mappings
        WHERE tenant_id = ?
        ORDER BY source ASC
      `).all(acme.tenant.id) as Array<{ source: string }>;
      expect(sources.map((row) => row.source)).toEqual([
        AGENT_HQ_DISPATCHER_SOURCE,
        AGENT_HQ_RUNTIME_SOURCE,
      ]);
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM external_event_mappings
        WHERE tenant_id = ? AND source = ?
      `).get(acme.tenant.id, AGENT_HQ_RUNTIME_SOURCE) as { n: number }).n).toBeGreaterThan(0);
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM external_event_mappings
        WHERE tenant_id = ? AND source = ?
      `).get(acme.tenant.id, AGENT_HQ_DISPATCHER_SOURCE) as { n: number }).n).toBeGreaterThan(0);
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM external_event_mappings
        WHERE tenant_id = ? AND source = ?
      `).get(acme.tenant.id, DEV_ENV_LEASE_MANAGER_SOURCE) as { n: number }).n).toBe(0);
    } finally {
      await stopServer(server);
    }
  });

  it('repairs only tenant-scoped Dev lease-manager workflow event defaults', async () => {
    resetFullDb();
    const { server, baseUrl } = await startServer();
    try {
      const acme = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
      });

      const db = getDb();
      const defaultTenant = db.prepare(`SELECT id FROM tenants WHERE is_default = 1`).get() as { id: number };
      const defaultDevRowsBefore = (db.prepare(`
        SELECT COUNT(*) AS n
        FROM external_event_mappings
        WHERE tenant_id = ? AND source = ?
      `).get(defaultTenant.id, DEV_ENV_LEASE_MANAGER_SOURCE) as { n: number }).n;

      db.prepare(`
        INSERT INTO external_event_mappings (
          tenant_id, project_id, source, event_name, task_type,
          status_includes_json, status_excludes_json, action_kind, action_target,
          apply_review_evidence, apply_failure_detail, enabled, priority
        ) VALUES (?, NULL, ?, 'deploy_failed', NULL, '[]', '["stalled","failed","done","cancelled"]', 'outcome', 'env_blocked', 0, 1, 1, 100)
      `).run(acme.tenant.id, DEV_ENV_LEASE_MANAGER_SOURCE);

      const result = removeDevEnvironmentLeaseManagerWorkflowEventDefaultsForTenant(db, acme.tenant.id);

      expect(result.deleted).toBe(1);
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM external_event_mappings
        WHERE tenant_id = ? AND source = ?
      `).get(acme.tenant.id, DEV_ENV_LEASE_MANAGER_SOURCE) as { n: number }).n).toBe(0);
      expect((db.prepare(`
        SELECT COUNT(*) AS n
        FROM external_event_mappings
        WHERE tenant_id = ? AND source = ?
      `).get(defaultTenant.id, DEV_ENV_LEASE_MANAGER_SOURCE) as { n: number }).n).toBe(defaultDevRowsBefore);
    } finally {
      await stopServer(server);
    }
  });

  it('isolates projects, workflows, tasks, and agents by active tenant context', async () => {
    resetFullDb();
    const { server, baseUrl } = await startServer();
    try {
      const acme = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
      });
      const beta = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Beta', slug: 'beta' }),
      });

      const db = getDb();
      const acmeProject = db.prepare(`SELECT id FROM projects WHERE tenant_id = ? LIMIT 1`).get(acme.tenant.id) as { id: number };
      const betaProject = db.prepare(`SELECT id FROM projects WHERE tenant_id = ? LIMIT 1`).get(beta.tenant.id) as { id: number };
      const acmeSprint = db.prepare(`SELECT id FROM sprints WHERE tenant_id = ? LIMIT 1`).get(acme.tenant.id) as { id: number };
      const betaSprint = db.prepare(`SELECT id FROM sprints WHERE tenant_id = ? LIMIT 1`).get(beta.tenant.id) as { id: number };
      db.prepare(`
        INSERT INTO tasks (tenant_id, project_id, sprint_id, title, description, status, priority)
        VALUES (?, ?, ?, ?, '', 'todo', 'medium'), (?, ?, ?, ?, '', 'todo', 'medium')
      `).run(acme.tenant.id, acmeProject.id, acmeSprint.id, 'Acme Task', beta.tenant.id, betaProject.id, betaSprint.id, 'Beta Task');
      db.prepare(`
        INSERT INTO agents (tenant_id, project_id, name, role, session_key, workspace_path)
        VALUES (?, ?, 'Acme Agent', 'Agent', 'acme-agent', ''), (?, ?, 'Beta Agent', 'Agent', 'beta-agent', '')
      `).run(acme.tenant.id, acmeProject.id, beta.tenant.id, betaProject.id);

      await setActiveTenant(baseUrl, acme.tenant.id);
      const acmeProjects = await json<Array<{ tenant_id: number; name: string }>>(`${baseUrl}/api/v1/projects`);
      const acmeTasks = await json<Array<{ tenant_id: number; title: string }>>(`${baseUrl}/api/v1/tasks?include_closed=true`);
      const acmeAgents = await json<Array<{ tenant_id: number; name: string }>>(`${baseUrl}/api/v1/agents`);
      const acmeSprints = await json<Array<{ tenant_id: number }>>(`${baseUrl}/api/v1/sprints?include_closed=true`);
      await setActiveTenant(baseUrl, beta.tenant.id);
      const betaProjects = await json<Array<{ tenant_id: number; name: string }>>(`${baseUrl}/api/v1/projects`);
      const betaTasks = await json<Array<{ tenant_id: number; title: string }>>(`${baseUrl}/api/v1/tasks?include_closed=true`);
      const betaAgents = await json<Array<{ tenant_id: number; name: string }>>(`${baseUrl}/api/v1/agents`);
      const betaSprints = await json<Array<{ tenant_id: number }>>(`${baseUrl}/api/v1/sprints?include_closed=true`);

      expect(acmeProjects.every((row) => row.tenant_id === acme.tenant.id)).toBe(true);
      expect(betaProjects.every((row) => row.tenant_id === beta.tenant.id)).toBe(true);
      expect(acmeTasks.map((row) => row.title)).toContain('Acme Task');
      expect(acmeTasks.map((row) => row.title)).not.toContain('Beta Task');
      expect(betaTasks.map((row) => row.title)).toContain('Beta Task');
      expect(betaTasks.map((row) => row.title)).not.toContain('Acme Task');
      expect(acmeAgents.map((row) => row.name)).toEqual(expect.arrayContaining([ATLAS_AGENT_NAME, 'Acme Agent']));
      expect(acmeAgents.map((row) => row.name)).not.toContain('Beta Agent');
      expect(betaAgents.map((row) => row.name)).toEqual(expect.arrayContaining([ATLAS_AGENT_NAME, 'Beta Agent']));
      expect(betaAgents.map((row) => row.name)).not.toContain('Acme Agent');
      expect(acmeSprints.every((row) => row.tenant_id === acme.tenant.id)).toBe(true);
      expect(betaSprints.every((row) => row.tenant_id === beta.tenant.id)).toBe(true);
    } finally {
      await stopServer(server);
    }
  });

  it('uses tenant route guards for project audit reads and project mutations', async () => {
    resetFullDb();
    const { server, baseUrl } = await startServer();
    try {
      const acme = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
      });
      const beta = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Beta', slug: 'beta' }),
      });

      await setActiveTenant(baseUrl, acme.tenant.id);
      const forgedCreate = await json<{ id: number; tenant_id: number; name: string }>(`${baseUrl}/api/v1/projects`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Forged tenant body project',
          tenant_id: beta.tenant.id,
          company_id: beta.tenant.id,
        }),
      });
      expect(forgedCreate.tenant_id).toBe(acme.tenant.id);

      const ownAudit = await json<Array<{ project_id: number; action: string }>>(`${baseUrl}/api/v1/projects/${forgedCreate.id}/audit`);
      expect(ownAudit.some((entry) => entry.project_id === forgedCreate.id && entry.action === 'created')).toBe(true);

      const queryManipulation = await fetch(`${baseUrl}/api/v1/projects/${forgedCreate.id}/audit?tenant_id=${beta.tenant.id}`);
      expect(queryManipulation.status).toBe(400);
      await expect(queryManipulation.json()).resolves.toMatchObject({
        code: 'tenant_selector_not_allowed',
        error: 'Explicit tenant selectors are not allowed for this request context',
      });

      const headerManipulation = await fetch(`${baseUrl}/api/v1/projects/${forgedCreate.id}/audit`, {
        headers: { 'X-Agent-HQ-Tenant-ID': String(beta.tenant.id) },
      });
      expect(headerManipulation.status).toBe(400);
      await expect(headerManipulation.json()).resolves.toMatchObject({
        code: 'tenant_selector_not_allowed',
        error: 'Explicit tenant selectors are not allowed for this request context',
      });

      const crossTenantUpdate = await fetch(`${baseUrl}/api/v1/projects/${forgedCreate.id}?tenant_id=${beta.tenant.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Beta should not update this' }),
      });
      expect(crossTenantUpdate.status).toBe(400);
      expect((getDb().prepare(`SELECT name, tenant_id FROM projects WHERE id = ?`).get(forgedCreate.id) as { name: string; tenant_id: number })).toMatchObject({
        name: 'Forged tenant body project',
        tenant_id: acme.tenant.id,
      });
    } finally {
      await stopServer(server);
    }
  });

  it('scopes workflow delete and workflow-type active counts to the selected tenant', async () => {
    resetFullDb();
    const { server, baseUrl } = await startServer();
    try {
      const acme = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
      });
      const beta = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Beta', slug: 'beta' }),
      });

      const db = getDb();
      const acmeStarter = db.prepare(`
        SELECT key, tenant_id FROM sprint_types WHERE tenant_id = ? AND key = 'generic' LIMIT 1
      `).get(acme.tenant.id) as { key: string; tenant_id: number } | undefined;
      const betaStarter = db.prepare(`
        SELECT key, tenant_id FROM sprint_types WHERE tenant_id = ? AND key = 'generic' LIMIT 1
      `).get(beta.tenant.id) as { key: string; tenant_id: number } | undefined;
      expect(acmeStarter).toMatchObject({ key: 'generic', tenant_id: acme.tenant.id });
      expect(betaStarter).toMatchObject({ key: 'generic', tenant_id: beta.tenant.id });
      expect((db.prepare(`SELECT COUNT(*) AS n FROM sprint_types WHERE tenant_id IS NULL`).get() as { n: number }).n).toBe(0);

      db.prepare(`
        INSERT INTO sprint_types (tenant_id, key, name, description, is_system)
        VALUES (?, 'tenant_leak_regression', 'Tenant Leak Regression', '', 0)
      `).run(acme.tenant.id);
      db.prepare(`
        INSERT INTO sprint_types (tenant_id, key, name, description, is_system)
        VALUES (?, 'tenant_leak_regression_beta', 'Tenant Leak Regression Beta', '', 0)
      `).run(beta.tenant.id);

      const acmeProject = db.prepare(`SELECT id FROM projects WHERE tenant_id = ? LIMIT 1`).get(acme.tenant.id) as { id: number };
      const betaProject = db.prepare(`SELECT id FROM projects WHERE tenant_id = ? LIMIT 1`).get(beta.tenant.id) as { id: number };
      const acmeSprint = db.prepare(`SELECT id FROM sprints WHERE tenant_id = ? LIMIT 1`).get(acme.tenant.id) as { id: number };
      const betaSprint = db.prepare(`SELECT id FROM sprints WHERE tenant_id = ? LIMIT 1`).get(beta.tenant.id) as { id: number };
      const acmeAgent = db.prepare(`SELECT id FROM agents WHERE tenant_id = ? LIMIT 1`).get(acme.tenant.id) as { id: number };

      db.prepare(`
        UPDATE sprints
        SET sprint_type = 'tenant_leak_regression', status = 'active'
        WHERE id = ?
      `).run(acmeSprint.id);
      db.prepare(`
        UPDATE sprints
        SET sprint_type = 'tenant_leak_regression', status = 'closed'
        WHERE id = ?
      `).run(betaSprint.id);

      const acmeTaskId = Number(db.prepare(`
        INSERT INTO tasks (tenant_id, project_id, sprint_id, title, description, status, priority)
        VALUES (?, ?, ?, 'Acme Active Task', '', 'in_progress', 'medium')
      `).run(acme.tenant.id, acmeProject.id, acmeSprint.id).lastInsertRowid);
      db.prepare(`INSERT INTO job_instances (task_id, agent_id, status) VALUES (?, ?, 'running')`).run(acmeTaskId, acmeAgent.id);

      await setActiveTenant(baseUrl, acme.tenant.id);
      const acmeTypeDelete = await fetch(`${baseUrl}/api/v1/sprints/types/tenant_leak_regression`, { method: 'DELETE' });
      expect(acmeTypeDelete.status).toBe(409);
      await expect(acmeTypeDelete.json()).resolves.toMatchObject({
        error: 'Cannot delete workflow type "tenant_leak_regression" because 1 open workflow(s) still use it in this tenant',
        code: 'sprint_type_in_use',
        open_sprint_count: 1,
      });
      await expect(fetch(`${baseUrl}/api/v1/sprints/types/tenant_leak_regression_beta`)).resolves.toMatchObject({ status: 404 });

      const wrongTenantDelete = await fetch(`${baseUrl}/api/v1/sprints/${betaSprint.id}`, { method: 'DELETE' });
      expect(wrongTenantDelete.status).toBe(404);

      await setActiveTenant(baseUrl, beta.tenant.id);
      const betaDelete = await fetch(`${baseUrl}/api/v1/sprints/${betaSprint.id}`, { method: 'DELETE' });
      expect(betaDelete.status).toBe(200);
      await expect(betaDelete.json()).resolves.toEqual({ ok: true });
      expect((db.prepare(`SELECT COUNT(*) AS n FROM sprints WHERE id = ?`).get(betaSprint.id) as { n: number }).n).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM sprints WHERE id = ?`).get(acmeSprint.id) as { n: number }).n).toBe(1);

      const betaTypeResponse = await fetch(`${baseUrl}/api/v1/sprints/types/tenant_leak_regression_beta`);
      expect(betaTypeResponse.status).toBe(200);
      const betaType = await betaTypeResponse.json() as { deletion: { protected: boolean; open_sprint_count: number; total_sprint_count: number } };
      expect(betaType.deletion).toEqual(expect.objectContaining({
        protected: false,
        open_sprint_count: 0,
        total_sprint_count: 0,
      }));
      const betaTypeDelete = await fetch(`${baseUrl}/api/v1/sprints/types/tenant_leak_regression_beta`, { method: 'DELETE' });
      expect(betaTypeDelete.status).toBe(200);
      await expect(betaTypeDelete.json()).resolves.toEqual({ ok: true });
      expect((db.prepare(`SELECT COUNT(*) AS n FROM sprint_types WHERE key = 'tenant_leak_regression_beta'`).get() as { n: number }).n).toBe(0);

      await setActiveTenant(baseUrl, acme.tenant.id);
      const acmeSameKeyCreate = await fetch(`${baseUrl}/api/v1/sprints/types`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'tenant_same_key_regression', name: 'Tenant Same Key Regression' }),
      });
      expect(acmeSameKeyCreate.status).toBe(201);

      await setActiveTenant(baseUrl, beta.tenant.id);
      const betaSameKeyCreate = await fetch(`${baseUrl}/api/v1/sprints/types`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'tenant_same_key_regression', name: 'Tenant Same Key Regression' }),
      });
      expect(betaSameKeyCreate.status).toBe(201);

      await setActiveTenant(baseUrl, acme.tenant.id);
      const acmeRelationshipCreate = await json<{ id: number; tenant_id: number; key: string }>(`${baseUrl}/api/v1/sprints/types/tenant_same_key_regression/relationship-types`, {
        method: 'POST',
        body: JSON.stringify({
          key: 'tenant_owned_relation',
          label: 'Tenant Owned Relation',
          inverse_label: 'Inverse',
          category: 'qa',
          direction_semantics: 'informational',
        }),
      });
      expect(acmeRelationshipCreate).toMatchObject({
        tenant_id: acme.tenant.id,
        key: 'tenant_owned_relation',
      });

      await setActiveTenant(baseUrl, beta.tenant.id);
      const betaRelationshipCreate = await json<{ id: number; tenant_id: number; key: string }>(`${baseUrl}/api/v1/sprints/types/tenant_same_key_regression/relationship-types`, {
        method: 'POST',
        body: JSON.stringify({
          key: 'tenant_owned_relation',
          label: 'Beta Tenant Owned Relation',
          inverse_label: 'Beta Inverse',
          category: 'qa',
          direction_semantics: 'informational',
        }),
      });
      expect(betaRelationshipCreate).toMatchObject({
        tenant_id: beta.tenant.id,
        key: 'tenant_owned_relation',
      });

      const betaRelationships = await json<{ relationship_types: Array<{ id: number; tenant_id: number; key: string; label: string }> }>(`${baseUrl}/api/v1/sprints/types/tenant_same_key_regression/relationship-types`);
      expect(betaRelationships.relationship_types).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: betaRelationshipCreate.id, tenant_id: beta.tenant.id, key: 'tenant_owned_relation', label: 'Beta Tenant Owned Relation' }),
      ]));
      expect(betaRelationships.relationship_types).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: acmeRelationshipCreate.id }),
      ]));

      await expect(fetch(`${baseUrl}/api/v1/sprints/types/tenant_same_key_regression/relationship-types/${acmeRelationshipCreate.id}`)).resolves.toMatchObject({ status: 404 });
      const betaRelationshipDelete = await fetch(`${baseUrl}/api/v1/sprints/types/tenant_same_key_regression/relationship-types/${betaRelationshipCreate.id}`, { method: 'DELETE' });
      expect(betaRelationshipDelete.status).toBe(200);
      await expect(betaRelationshipDelete.json()).resolves.toEqual({ ok: true });

      await setActiveTenant(baseUrl, acme.tenant.id);
      const acmeRelationshipStillVisible = await fetch(`${baseUrl}/api/v1/sprints/types/tenant_same_key_regression/relationship-types/${acmeRelationshipCreate.id}`);
      expect(acmeRelationshipStillVisible.status).toBe(200);

      await setActiveTenant(baseUrl, beta.tenant.id);
      const betaSameKeyDelete = await fetch(`${baseUrl}/api/v1/sprints/types/tenant_same_key_regression`, { method: 'DELETE' });
      expect(betaSameKeyDelete.status).toBe(200);
      await expect(betaSameKeyDelete.json()).resolves.toEqual({ ok: true });

      await setActiveTenant(baseUrl, acme.tenant.id);
      const acmeSameKeyStillVisible = await fetch(`${baseUrl}/api/v1/sprints/types/tenant_same_key_regression`);
      expect(acmeSameKeyStillVisible.status).toBe(200);

      const acmeTypeResponse = await fetch(`${baseUrl}/api/v1/sprints/types/tenant_leak_regression`);
      expect(acmeTypeResponse.status).toBe(200);
      const acmeType = await acmeTypeResponse.json() as { deletion: { protected: boolean; open_sprint_count: number; total_sprint_count: number } };
      expect(acmeType.deletion).toEqual(expect.objectContaining({
        protected: true,
        open_sprint_count: 1,
        total_sprint_count: 1,
      }));
    } finally {
      await stopServer(server);
    }
  });

  it('isolates direct task lookups and capability registries by tenant context', async () => {
    resetFullDb();
    const { server, baseUrl } = await startServer();
    try {
      const acme = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
      });
      const beta = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Beta', slug: 'beta' }),
      });

      const db = getDb();
      const acmeProject = db.prepare(`SELECT id FROM projects WHERE tenant_id = ? LIMIT 1`).get(acme.tenant.id) as { id: number };
      const betaProject = db.prepare(`SELECT id FROM projects WHERE tenant_id = ? LIMIT 1`).get(beta.tenant.id) as { id: number };
      const acmeSprint = db.prepare(`SELECT id FROM sprints WHERE tenant_id = ? LIMIT 1`).get(acme.tenant.id) as { id: number };
      const betaSprint = db.prepare(`SELECT id FROM sprints WHERE tenant_id = ? LIMIT 1`).get(beta.tenant.id) as { id: number };
      const acmeTaskId = Number(db.prepare(`
        INSERT INTO tasks (tenant_id, project_id, sprint_id, title, description, status, priority)
        VALUES (?, ?, ?, 'Acme direct task', '', 'todo', 'medium')
      `).run(acme.tenant.id, acmeProject.id, acmeSprint.id).lastInsertRowid);
      const betaTaskId = Number(db.prepare(`
        INSERT INTO tasks (tenant_id, project_id, sprint_id, title, description, status, priority)
        VALUES (?, ?, ?, 'Beta direct task', '', 'todo', 'medium')
      `).run(beta.tenant.id, betaProject.id, betaSprint.id).lastInsertRowid);
      const acmeAgentId = Number(db.prepare(`
        INSERT INTO agents (tenant_id, project_id, name, role, session_key, workspace_path)
        VALUES (?, ?, 'Acme Tool Agent', 'Agent', 'acme-tool-agent', '')
      `).run(acme.tenant.id, acmeProject.id).lastInsertRowid);
      const betaAgentId = Number(db.prepare(`
        INSERT INTO agents (tenant_id, project_id, name, role, session_key, workspace_path)
        VALUES (?, ?, 'Beta Tool Agent', 'Agent', 'beta-tool-agent', '')
      `).run(beta.tenant.id, betaProject.id).lastInsertRowid);

      await setActiveTenant(baseUrl, acme.tenant.id);
      const acmeTask = await json<{ id: number; title: string }>(`${baseUrl}/api/v1/tasks/${acmeTaskId}`);
      expect(acmeTask.title).toBe('Acme direct task');
      await expect(fetch(`${baseUrl}/api/v1/tasks/${betaTaskId}`)).resolves.toMatchObject({ status: 404 });

      const acmeTool = await json<{ id: number; tenant_id: number; name: string }>(`${baseUrl}/api/v1/tools`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Acme Tool', slug: 'acme-tool', implementation_type: 'bash' }),
      });
      await setActiveTenant(baseUrl, beta.tenant.id);
      const betaTool = await json<{ id: number; tenant_id: number; name: string }>(`${baseUrl}/api/v1/tools`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Beta Tool', slug: 'beta-tool', implementation_type: 'bash' }),
      });
      await setActiveTenant(baseUrl, acme.tenant.id);
      const acmeTools = await json<Array<{ id: number; tenant_id: number; name: string }>>(`${baseUrl}/api/v1/tools`);
      expect(acmeTools.map((tool) => tool.name)).toContain('Acme Tool');
      expect(acmeTools.map((tool) => tool.name)).not.toContain('Beta Tool');
      await expect(fetch(`${baseUrl}/api/v1/tools/${betaTool.id}`)).resolves.toMatchObject({ status: 404 });
      await expect(fetch(`${baseUrl}/api/v1/agents/${acmeAgentId}/tools`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool_id: betaTool.id }),
      })).resolves.toMatchObject({ status: 404 });
      const acmeToolAssignment = await json<{ tool_id: number }>(`${baseUrl}/api/v1/agents/${acmeAgentId}/tools`, {
        method: 'POST',
        body: JSON.stringify({ tool_id: acmeTool.id }),
      });
      expect(acmeToolAssignment.tool_id).toBe(acmeTool.id);

      await setActiveTenant(baseUrl, beta.tenant.id);
      const betaServer = await json<{ id: number; tenant_id: number }>(`${baseUrl}/api/v1/mcp-servers`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Beta MCP', slug: 'beta-mcp', command: 'node' }),
      });
      await setActiveTenant(baseUrl, acme.tenant.id);
      const acmeServer = await json<{ id: number; tenant_id: number }>(`${baseUrl}/api/v1/mcp-servers`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Acme MCP', slug: 'acme-mcp', command: 'node' }),
      });
      await expect(fetch(`${baseUrl}/api/v1/mcp-servers/${betaServer.id}`)).resolves.toMatchObject({ status: 404 });
      await expect(fetch(`${baseUrl}/api/v1/agents/${betaAgentId}/mcp-servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcp_server_id: acmeServer.id }),
      })).resolves.toMatchObject({ status: 404 });
    } finally {
      await stopServer(server);
    }
  });

  it('rejects cross-tenant workflow and task relationship mutations', async () => {
    resetFullDb();
    const { server, baseUrl } = await startServer();
    try {
      const acme = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
      });
      const beta = await json<{ tenant: { id: number } }>(`${baseUrl}/api/v1/tenants`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Beta', slug: 'beta' }),
      });

      const db = getDb();
      const acmeProject = db.prepare(`SELECT id FROM projects WHERE tenant_id = ? LIMIT 1`).get(acme.tenant.id) as { id: number };
      const betaProject = db.prepare(`SELECT id FROM projects WHERE tenant_id = ? LIMIT 1`).get(beta.tenant.id) as { id: number };
      const acmeSprint = db.prepare(`SELECT id FROM sprints WHERE tenant_id = ? LIMIT 1`).get(acme.tenant.id) as { id: number };
      const betaSprint = db.prepare(`SELECT id FROM sprints WHERE tenant_id = ? LIMIT 1`).get(beta.tenant.id) as { id: number };
      const acmeTaskId = Number(db.prepare(`
        INSERT INTO tasks (tenant_id, project_id, sprint_id, title, description, status, priority)
        VALUES (?, ?, ?, 'Acme relationship source', '', 'todo', 'medium')
      `).run(acme.tenant.id, acmeProject.id, acmeSprint.id).lastInsertRowid);
      const betaTaskId = Number(db.prepare(`
        INSERT INTO tasks (tenant_id, project_id, sprint_id, title, description, status, priority)
        VALUES (?, ?, ?, 'Beta relationship target', '', 'todo', 'medium')
      `).run(beta.tenant.id, betaProject.id, betaSprint.id).lastInsertRowid);

      await setActiveTenant(baseUrl, acme.tenant.id);
      await expect(fetch(`${baseUrl}/api/v1/sprints/${betaSprint.id}`)).resolves.toMatchObject({ status: 404 });
      await expect(fetch(`${baseUrl}/api/v1/sprints/${betaSprint.id}/metrics`)).resolves.toMatchObject({ status: 404 });
      await expect(fetch(`${baseUrl}/api/v1/sprints/${betaSprint.id}/close`, { method: 'POST' })).resolves.toMatchObject({ status: 404 });

      const crossProjectWorkflow = await fetch(`${baseUrl}/api/v1/sprints/${acmeSprint.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: betaProject.id }),
      });
      expect(crossProjectWorkflow.status).toBe(404);

      const crossTenantRelationship = await fetch(`${baseUrl}/api/v1/tasks/${acmeTaskId}/relationships`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_task_id: betaTaskId, relationship_type_key: 'relates_to' }),
      });
      expect(crossTenantRelationship.status).toBe(404);

      const crossTenantCreate = await fetch(`${baseUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Invalid cross tenant task',
          project_id: acmeProject.id,
          sprint_id: acmeSprint.id,
          relationships: [{ target_task_id: betaTaskId, relationship_type_key: 'relates_to' }],
        }),
      });
      expect(crossTenantCreate.status).toBe(400);
      await expect(crossTenantCreate.json()).resolves.toMatchObject({
        error: `target_task_id ${betaTaskId} is not in the same workspace`,
      });
    } finally {
      await stopServer(server);
    }
  });
});
