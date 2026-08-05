import express from 'express';
import type { Server } from 'http';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import {
  authenticateMcpApiKeyIfPresent,
  authorizeMcpApiRequestIfPresent,
  issueMcpApiKeyForAgent,
  replaceAgentMcpPermissionPolicy,
} from '../lib/mcpApiAuth';
import { handleJsonRequestErrors } from '../lib/jsonRequestErrors';
import tasksRouter from './tasks';

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use(handleJsonRequestErrors);
  app.use('/api/v1', authenticateMcpApiKeyIfPresent);
  app.use('/api/v1', authorizeMcpApiRequestIfPresent);
  app.use('/api/v1/tasks', tasksRouter);
  const server = await new Promise<Server>((resolve, reject) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
    bound.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-agent-hq-mcp-client': 'agent-hq-mcp',
    authorization: `Bearer ${apiKey}`,
  };
}

async function seedProjectTaskSearchFixture(): Promise<{ agencyKey: string; otherProjectKey: string; otherTenantKey: string }> {
  const db = getDb();

  await db.run(`
    INSERT INTO tenants (id, name, slug, is_default) VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    ON CONFLICT (id) DO NOTHING
  `, 1, 'Default Tenant', 'default', 1, 2, 'Other Tenant', 'other', 0);
  await db.run(`
    INSERT INTO app_settings (key, value)
    VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  await db.run(`
    INSERT INTO task_statuses (name, label, color, terminal, is_system, allowed_transitions)
    VALUES
      ('in_progress', 'In Progress', 'yellow', 0, 1, '[]'),
      ('review', 'Review', 'purple', 0, 1, '[]'),
      ('done', 'Done', 'green', 1, 1, '[]')
  `);

  await db.run(`
    INSERT INTO projects (id, tenant_id, name, description, context_md)
    VALUES (?, ?, ?, '', ''), (?, ?, ?, '', ''), (?, ?, ?, '', '')
  `, 99, 1, 'Agency', 100, 1, 'Other Project', 200, 2, 'Tenant Two Project');
  await db.run(`
    INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status)
    VALUES (?, ?, ?, ?, '', 'lead_generation', 'active'),
           (?, ?, ?, ?, '', 'lead_generation', 'active'),
           (?, ?, ?, ?, '', 'lead_generation', 'active')
  `, 501, 1, 99, 'Lead Generation', 502, 1, 100, 'Other Leads', 601, 2, 200, 'Tenant Two Leads');
  await db.run(`
    INSERT INTO agents (id, tenant_id, project_id, name, role, session_key, workspace_path, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'running'),
           (?, ?, ?, ?, ?, ?, ?, 'running'),
           (?, ?, ?, ?, ?, ?, ?, 'running')
  `, 7, 1, 99, 'James', 'Agency Worker', 'agent:james:test', '/tmp/james', 8, 1, 100, 'Other Worker', 'Other Worker', 'agent:other:test', '/tmp/other', 9, 2, 200, 'Tenant Two Worker', 'Tenant Two Worker', 'agent:tenant-two:test', '/tmp/tenant-two');
  await db.run(`
    INSERT INTO tasks (
      id, tenant_id, title, description, status, priority, project_id, sprint_id, agent_id,
      task_type, custom_fields_json, updated_at
    )
    VALUES
      (?, ?, ?, '', ?, 'high', ?, ?, ?, ?, ?, ?),
      (?, ?, ?, '', ?, 'medium', ?, ?, ?, ?, ?, ?),
      (?, ?, ?, '', ?, 'medium', ?, ?, ?, ?, ?, ?),
      (?, ?, ?, '', ?, 'medium', ?, ?, ?, ?, ?, ?),
      (?, ?, ?, '', ?, 'medium', ?, ?, ?, ?, ?, ?)
  `, 9101, 1, 'Follow up Acme lead', 'in_progress', 99, 501, 7, 'lead_generation', JSON.stringify({ crm_lead_id: 'crm-123', unique_string: 'exact-string', external_project_id: 'ext-abc', lead_score: 42, approved: true, optional_note: null, 'source.id': 'dot-123' }), '2026-07-20 10:00:00', 9102, 1, 'Completed Acme lead', 'done', 99, 501, 7, 'lead_generation', JSON.stringify({ crm_lead_id: 'crm-123', external_project_id: 'ext-abc', lead_score: 7, approved: false, optional_note: 'present', 'source.id': 'dot-other' }), '2026-07-20 09:00:00', 9103, 1, 'Other project Acme lead', 'in_progress', 100, 502, 8, 'lead_generation', JSON.stringify({ crm_lead_id: 'crm-123', external_project_id: 'ext-abc', lead_score: 42, approved: true, optional_note: null, 'source.id': 'dot-123' }), '2026-07-20 11:00:00', 9104, 2, 'Other tenant Acme lead', 'in_progress', 200, 601, 9, 'lead_generation', JSON.stringify({ crm_lead_id: 'crm-123', external_project_id: 'ext-abc', lead_score: 42, approved: true, optional_note: null, 'source.id': 'dot-123' }), '2026-07-20 12:00:00', 9105, 1, 'Different Agency lead', 'review', 99, 501, 7, 'lead_generation', JSON.stringify({ crm_lead_id: 'crm-999', external_project_id: 'ext-999', lead_score: 7, approved: false, optional_note: 'present', 'source.id': 'dot-other' }), '2026-07-20 13:00:00');

  const agencyKey = (await issueMcpApiKeyForAgent(db, 7)).apiKey;
  const otherProjectKey = (await issueMcpApiKeyForAgent(db, 8)).apiKey;
  const otherTenantKey = (await issueMcpApiKeyForAgent(db, 9)).apiKey;
  for (const agentId of [7, 8, 9]) {
    await replaceAgentMcpPermissionPolicy(db, agentId, [
            'discovery.read_catalog',
            'tasks.search_project_tasks',
          ]);
  }

  return { agencyKey, otherProjectKey, otherTenantKey };
}

describe('POST /api/v1/tasks/project-search', () => {
  let server: Server | undefined;
  let baseUrl: string;
  let agencyKey: string;
  let otherProjectKey: string;
  let otherTenantKey: string;

  beforeEach(async () => {
    await setupTestDb();
    ({ agencyKey, otherProjectKey, otherTenantKey } = await seedProjectTaskSearchFixture());
    ({ server, baseUrl } = await startServer());
  });

  afterEach(async () => {
    await stopServer(server);
    await teardownTestDb();
  });

  it('finds an active same-project task by exact crm_lead_id with minimal summaries', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tasks/project-search`, {
      method: 'POST',
      headers: authHeaders(agencyKey),
      body: JSON.stringify({
        workflow_id: 501,
        task_type: 'lead_generation',
        nonterminal_only: true,
        custom_fields: { crm_lead_id: 'crm-123' },
        limit: 10,
      }),
    });
    const body = await response.json() as { tasks: Array<Record<string, unknown>>; total: number; project_id: number };

    expect(response.status).toBe(200);
    expect(body.project_id).toBe(99);
    expect(body.total).toBe(1);
    expect(body.tasks).toEqual([
      expect.objectContaining({
        id: 9101,
        title: 'Follow up Acme lead',
        status: 'in_progress',
        task_type: 'lead_generation',
        project_id: 99,
        sprint_id: 501,
        matched_custom_fields: { crm_lead_id: 'crm-123' },
      }),
    ]);
    expect(body.tasks[0]).not.toHaveProperty('description');
    expect(body.tasks[0]).not.toHaveProperty('custom_fields');
  });

  it('finds by exact external_project_id and applies bounded pagination', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tasks/project-search`, {
      method: 'POST',
      headers: authHeaders(agencyKey),
      body: JSON.stringify({
        statuses: ['in_progress', 'review'],
        custom_fields: { external_project_id: 'ext-abc' },
        limit: 1,
        offset: 0,
      }),
    });
    const body = await response.json() as { tasks: Array<Record<string, unknown>>; total: number; limit: number; hasMore: boolean };

    expect(response.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.limit).toBe(1);
    expect(body.hasMore).toBe(false);
    expect(body.tasks.map((task) => task.id)).toEqual([9101]);
  });

  it.each([
    ['string', 'unique_string', 'exact-string'],
    ['numeric', 'lead_score', 42],
    ['boolean', 'approved', true],
    ['null', 'optional_note', null],
    ['literal dotted key', 'source.id', 'dot-123'],
  ])('matches %s custom-field values exactly', async (_label, key, value) => {
    const response = await fetch(`${baseUrl}/api/v1/tasks/project-search`, {
      method: 'POST',
      headers: authHeaders(agencyKey),
      body: JSON.stringify({ custom_fields: { [key]: value } }),
    });
    const body = await response.json() as { tasks: Array<Record<string, unknown>>; total: number };

    expect(response.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.tasks).toEqual([
      expect.objectContaining({
        id: 9101,
        matched_custom_fields: { [key]: value },
      }),
    ]);
  });

  it('does not reveal another project or tenant when matching filters exist elsewhere', async () => {
    const otherWorkflowResponse = await fetch(`${baseUrl}/api/v1/tasks/project-search`, {
      method: 'POST',
      headers: authHeaders(agencyKey),
      body: JSON.stringify({
        workflow_id: 502,
        custom_fields: { crm_lead_id: 'crm-123' },
      }),
    });
    const otherWorkflowBody = await otherWorkflowResponse.json() as { tasks: unknown[]; total: number };
    expect(otherWorkflowResponse.status).toBe(200);
    expect(otherWorkflowBody).toMatchObject({ tasks: [], total: 0 });

    const otherProjectResponse = await fetch(`${baseUrl}/api/v1/tasks/project-search`, {
      method: 'POST',
      headers: authHeaders(otherProjectKey),
      body: JSON.stringify({
        custom_fields: { crm_lead_id: 'crm-123' },
      }),
    });
    const otherProjectBody = await otherProjectResponse.json() as { tasks: Array<Record<string, unknown>>; project_id: number };
    expect(otherProjectResponse.status).toBe(200);
    expect(otherProjectBody.project_id).toBe(100);
    expect(otherProjectBody.tasks.map((task) => task.id)).toEqual([9103]);

    const otherTenantResponse = await fetch(`${baseUrl}/api/v1/tasks/project-search`, {
      method: 'POST',
      headers: authHeaders(otherTenantKey),
      body: JSON.stringify({
        custom_fields: { crm_lead_id: 'crm-123' },
      }),
    });
    const otherTenantBody = await otherTenantResponse.json() as { tasks: Array<Record<string, unknown>>; project_id: number };
    expect(otherTenantResponse.status).toBe(200);
    expect(otherTenantBody.project_id).toBe(200);
    expect(otherTenantBody.tasks.map((task) => task.id)).toEqual([9104]);
  });

  it('rejects unsafe custom-field filter shapes before querying', async () => {
    const response = await fetch(`${baseUrl}/api/v1/tasks/project-search`, {
      method: 'POST',
      headers: authHeaders(agencyKey),
      body: JSON.stringify({
        custom_fields: { 'crm_lead_id")) OR 1=1 --': 'crm-123' },
      }),
    });
    const body = await response.json() as { code?: string; error?: string };

    expect(response.status).toBe(400);
    expect(body.code).toBe('invalid_project_task_search_filter');
    expect(body.error).toContain('Invalid custom field key');
  });
});
