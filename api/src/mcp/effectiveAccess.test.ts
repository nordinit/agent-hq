import express from 'express';
import type { Server } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { getDb } from '../db/client';
import { authenticateMcpApiKeyIfPresent, authorizeMcpApiRequestIfPresent, issueMcpApiKeyForAgent, replaceAgentMcpPermissionPolicy } from '../lib/mcpApiAuth';
import workflowDefinitionsRouter from '../domains/workflow-definitions/router';
import agentsRouter from '../routes/agents';
import { AgentHqApiClient } from './apiClient';
import { mcpAccessRouter } from './accessRouter';
import { createMcpHttpRouter } from './httpServer';
import { createAgentHqMcpServer } from './serverFactory';

describe('identity permissions across API and MCP transports', () => {
  let http: Server;
  let baseUrl: string;
  let key: string;
  let keyId: number;
  let adminKey: string;
  const clients: Client[] = [];
  const localServers: ReturnType<typeof createAgentHqMcpServer>[] = [];
  const auth = (value = key) => ({ 'x-agent-hq-mcp-client': 'test', authorization: `Bearer ${value}`, 'content-type': 'application/json' });

  beforeEach(async () => {
    const db = await setupTestDb();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Test', 'test', 1), (2, 'Other', 'other', 0)`);
    await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
    await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Assigned'), (2, 1, 'Other project'), (3, 2, 'Other tenant')`);
    await db.run(`INSERT INTO agents (id, tenant_id, project_id, name, session_key, enabled) VALUES (7, 1, 1, 'Test mobile', 'agent:test-mobile:main', 1)`);
    const issued = await issueMcpApiKeyForAgent(db, 7);
    key = issued.apiKey; keyId = issued.keyId;
    adminKey = (await issueMcpApiKeyForAgent(db, 7, 'Admin on same identity', 'admin')).apiKey;
    const app = express();
    app.use(express.json());
    app.use('/api/v1', authenticateMcpApiKeyIfPresent, authorizeMcpApiRequestIfPresent);
    app.use('/api/v1/mcp', mcpAccessRouter);
    app.use('/api/v1/workflows', workflowDefinitionsRouter);
    app.use('/api/v1/agents', agentsRouter);
    http = await new Promise(resolve => { const bound = app.listen(0, '127.0.0.1', () => resolve(bound)); });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    baseUrl = `http://127.0.0.1:${address.port}`;
    app.use('/mcp', createMcpHttpRouter({ apiBaseUrl: baseUrl, rateLimitRpm: 1000 }));
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.close()));
    await Promise.all(localServers.splice(0).map(server => server.close()));
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    await teardownTestDb();
  });
  async function connect(transport: 'http' | 'local') {
    const client = new Client({ name: 'permissions-integration', version: '1' });
    clients.push(client);
    if (transport === 'http') {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: auth() } }));
    } else {
      const server = createAgentHqMcpServer({ api: new AgentHqApiClient(baseUrl, key), hasApiKey: true });
      localServers.push(server);
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a); await client.connect(b);
    }
    return client;
  }
  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name: `agent_hq_${name}`, arguments: args });
    const content = result.content as Array<{ text: string }>;
    return JSON.parse(content[0].text);
  }

  test('self access uses the presented key and remains available with no grants', async () => {
    const scoped = await new AgentHqApiClient(baseUrl, key).getEffectiveAccess();
    const admin = await new AgentHqApiClient(baseUrl, adminKey).getEffectiveAccess();
    expect(scoped.tool_names).not.toContain('agent_hq_api_request');
    expect(admin.tool_names).toContain('agent_hq_api_request');
    expect(scoped.identity.key_role).toBe('scoped');
    expect(admin.policy_fingerprint).not.toBe(scoped.policy_fingerprint);
    await replaceAgentMcpPermissionPolicy(getDb(), 7, []);
    const empty = await new AgentHqApiClient(baseUrl, key).getEffectiveAccess();
    expect(empty.tool_names).toEqual([]);
    expect(empty.policy_fingerprint).not.toBe(scoped.policy_fingerprint);
    expect((await fetch(`${baseUrl}/api/v1/mcp/access`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/v1/mcp/access?tenant_id=2`, { headers: auth() })).status).toBe(403);
  });

  test('HTTP and long-lived local servers list identical schemas and refresh live grants/revocations', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 7, ['workflow_definitions.read_project_scope']);
    const remote = await connect('http');
    const local = await connect('local');
    expect(await remote.listTools()).toEqual(await local.listTools());
    await replaceAgentMcpPermissionPolicy(getDb(), 7, ['workflow_definitions.read_project_scope', 'workflow_definitions.manage_project_scope']);
    for (const client of [remote, local]) expect((await client.listTools()).tools.map(tool => tool.name)).toContain('agent_hq_create_workflow_type');
    await replaceAgentMcpPermissionPolicy(getDb(), 7, []);
    for (const client of [remote, local]) {
      const rejected = await client.callTool({ name: 'agent_hq_create_workflow_type', arguments: { key: 'stale-list', name: 'Stale', project_id: 1 } });
      expect(rejected.isError).toBe(true);
      expect((await client.listTools()).tools).toEqual([]);
    }
    expect(await getDb().get("SELECT key FROM workflow_types WHERE key = 'stale-list'")).toBeUndefined();
  });

  test('actual workflow task type and schema CRUD stays inside the assigned project', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 7, ['workflow_definitions.read_project_scope', 'workflow_definitions.manage_project_scope']);
    const client = await connect('http');
    expect(await call(client, 'create_workflow_type', { key: 'permissions-test', name: 'Permissions test', project_id: 1 })).toMatchObject({ ok: true });
    expect(await call(client, 'update_workflow_type_task_types', { workflow_type_key: 'permissions-test', task_types: ['example'] })).toMatchObject({ ok: true });
    const created = await call(client, 'create_workflow_type_field_schema', { workflow_type_key: 'permissions-test', task_type: 'example', schema: { fields: [{ key: 'text', label: 'Text', type: 'text' }] } });
    expect(created).toMatchObject({ ok: true });
    const schemaId = created.data.id;
    expect(await call(client, 'get_workflow_type_field_schema', { workflow_type_key: 'permissions-test', schema_id: schemaId })).toMatchObject({ ok: true, data: { id: schemaId } });
    expect(await call(client, 'update_workflow_type_field_schema', { workflow_type_key: 'permissions-test', schema_id: schemaId, schema: { fields: [{ key: 'text', label: 'Updated', type: 'text' }] } })).toMatchObject({ ok: true });
    expect(await call(client, 'create_workflow_type', { key: 'denied-test', name: 'Denied', project_id: 2 })).toMatchObject({ ok: false });
    expect(await call(client, 'create_workflow_type', { key: 'tenant-denied-test', name: 'Denied', project_id: 3 })).toMatchObject({ ok: false });
    expect(await call(client, 'delete_workflow_type_field_schema', { workflow_type_key: 'permissions-test', schema_id: schemaId })).toMatchObject({ ok: true });
    expect(await call(client, 'delete_workflow_type', { key: 'permissions-test', project_id: 1 })).toMatchObject({ ok: true });
  });

  test('backend preview uses live key authority and evaluates drafts without persisting them', async () => {
    const preview = (body: unknown) => fetch(`${baseUrl}/api/v1/agents/7/mcp-permissions/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const scoped = await (await preview({ key_role: 'scoped' })).json() as any;
    const admin = await (await preview({ key_role: 'admin' })).json() as any;
    expect(scoped.tools.find((tool: any) => tool.name === 'agent_hq_api_request').available).toBe(false);
    expect(admin.tools.find((tool: any) => tool.name === 'agent_hq_api_request').available).toBe(true);
    const draft = await (await preview({ enabled_capabilities: ['workflow_definitions.manage_project_scope'] })).json() as any;
    expect(draft.draft).toBe(true);
    expect(draft.tools.find((tool: any) => tool.name === 'agent_hq_create_workflow_type').available).toBe(true);
    expect((await new AgentHqApiClient(baseUrl, key).getEffectiveAccess()).policy_mode).toBe('default');
    expect((await preview({ enabled_capabilities: ['unknown'] })).status).toBe(400);
    // A caller with no policy-management grant cannot use the operator preview.
    expect((await fetch(`${baseUrl}/api/v1/agents/7/mcp-permissions/preview`, { method: 'POST', headers: auth(), body: '{}' })).status).toBe(403);
  });

  test.each(['disabled identity', 'revoked key', 'expired key'])('%s invalidates both discovery paths', async reason => {
    const local = await connect('local');
    await local.listTools();
    if (reason === 'disabled identity') await getDb().run('UPDATE agents SET enabled = 0 WHERE id = 7');
    if (reason === 'revoked key') await getDb().run("UPDATE mcp_api_keys SET revoked_at = '2020-01-01' WHERE id = ?", keyId);
    if (reason === 'expired key') await getDb().run("UPDATE mcp_api_keys SET expires_at = '2020-01-01' WHERE id = ?", keyId);
    await expect(local.listTools()).rejects.toThrow();
    const response = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { ...auth(), accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect([401, 403]).toContain(response.status);
  });
});
