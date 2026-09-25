import express from 'express';
import type { Server } from 'http';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import chatRouter from './chat';
import mcpServersRouter, { agentMcpServersRouter } from './mcp-servers';
import settingsRouter from './settings';

// MCP server edits schedule a background re-materialization that writes runtime config files.
// Nothing here is about materialization, and it must not touch this host's OpenClaw config.
jest.mock('../runtimes/mcpMaterialization', () => ({
  syncAssignedMcpForAgent: jest.fn(async () => ({ ok: true, count: 0, warnings: [] })),
  syncAssignedMcpForServer: jest.fn(async () => []),
}));

const GATEWAY_TOKEN = 'gw-0123456789abcdef-secret';
const MCP_SECRET = 'sk-live-0123456789abcdef';

let server: Server;
let baseUrl = '';

async function request(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: res.status, body: await res.json() };
}

async function storedSetting(key: string): Promise<string | null> {
  const row = await getDb().get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', key);
  return row?.value ?? null;
}

describe('secrets on read endpoints', () => {
  const originalEnvToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const originalGatewayToken = process.env.GATEWAY_TOKEN;

  beforeEach(async () => {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.GATEWAY_TOKEN;
    const db = await setupTestDb();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
    await db.run(`
      INSERT INTO app_settings (key, value)
      VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1'),
             ('gateway_ws_url', 'ws://127.0.0.1:18789'), ('gateway_runtime_hint', 'external'),
             ('gateway_auth_token', ?)
    `, GATEWAY_TOKEN);

    const app = express();
    app.use(express.json());
    app.use('/api/v1/chat', chatRouter);
    app.use('/api/v1/settings', settingsRouter);
    app.use('/api/v1/mcp-servers', mcpServersRouter);
    app.use('/api/v1/agents/:id/mcp-servers', agentMcpServersRouter);
    server = await new Promise<Server>((resolve) => {
      const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await teardownTestDb();
    if (originalEnvToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = originalEnvToken;
    if (originalGatewayToken === undefined) delete process.env.GATEWAY_TOKEN;
    else process.env.GATEWAY_TOKEN = originalGatewayToken;
  });

  it('does not hand the gateway token to the chat client', async () => {
    const res = await request('/api/v1/chat/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ gatewayUrl: expect.stringMatching(/\/api\/v1\/chat\/ws$/) });
    expect(JSON.stringify(res.body)).not.toContain(GATEWAY_TOKEN);
  });

  it('masks the gateway token and keeps it when the mask is saved back', async () => {
    const read = await request('/api/v1/settings/gateway/config');
    expect(read.status).toBe(200);
    expect(read.body.auth_token).toBe('********cret');
    expect(read.body.auth_token_configured).toBe(true);
    expect(JSON.stringify(read.body)).not.toContain(GATEWAY_TOKEN);

    // The settings screen sends the whole form back, mask included.
    const roundTrip = await request('/api/v1/settings/gateway/config', {
      method: 'PUT',
      body: { ws_url: 'ws://127.0.0.1:18789', runtime_hint: 'external', auth_token: read.body.auth_token },
    });
    expect(roundTrip.status).toBe(200);
    expect(roundTrip.body.auth_token).toBe('********cret');
    expect(await storedSetting('gateway_auth_token')).toBe(GATEWAY_TOKEN);

    await request('/api/v1/settings/gateway/config', {
      method: 'PUT',
      body: { ws_url: 'ws://127.0.0.1:18789', runtime_hint: 'external', auth_token: 'replacement-token-value' },
    });
    expect(await storedSetting('gateway_auth_token')).toBe('replacement-token-value');

    await request('/api/v1/settings/gateway/config', {
      method: 'PUT',
      body: { ws_url: 'ws://127.0.0.1:18789', runtime_hint: 'external', auth_token: '' },
    });
    expect(await storedSetting('gateway_auth_token')).toBeNull();
  });

  it('masks MCP server env values, keeps the keys, and preserves masked values on update', async () => {
    const created = await request('/api/v1/mcp-servers', {
      method: 'POST',
      body: { name: 'Search', slug: 'search', command: 'node', env: { SEARCH_API_KEY: MCP_SECRET, REGION: 'eu' } },
    });
    expect(created.status).toBe(201);
    expect(JSON.parse(created.body.env)).toEqual({ SEARCH_API_KEY: '********cdef', REGION: '********' });
    const id = created.body.id as number;

    const list = await request('/api/v1/mcp-servers');
    const single = await request(`/api/v1/mcp-servers/${id}`);
    for (const body of [list.body, single.body]) expect(JSON.stringify(body)).not.toContain(MCP_SECRET);
    expect(JSON.parse(single.body.env)).toEqual({ SEARCH_API_KEY: '********cdef', REGION: '********' });

    // Round trip the masked env with one edited value.
    const updated = await request(`/api/v1/mcp-servers/${id}`, {
      method: 'PUT',
      body: { env: JSON.stringify({ SEARCH_API_KEY: '********cdef', REGION: 'us' }) },
    });
    expect(updated.status).toBe(200);
    expect(JSON.stringify(updated.body)).not.toContain(MCP_SECRET);
    const stored = await getDb().get<{ env: string }>('SELECT env FROM mcp_servers WHERE id = ?', id);
    expect(JSON.parse(stored!.env)).toEqual({ SEARCH_API_KEY: MCP_SECRET, REGION: 'us' });
  });

  it('masks env on agent MCP assignment listings', async () => {
    const db = getDb();
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key) VALUES (5, 1, 'Worker', 'agent:worker:main')`);
    await db.run(`
      INSERT INTO mcp_servers (id, tenant_id, name, slug, command, env)
      VALUES (40, 1, 'Search', 'search', 'node', ?)
    `, JSON.stringify({ SEARCH_API_KEY: MCP_SECRET }));
    await db.run(`
      INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id, overrides)
      VALUES (5, 40, ?)
    `, JSON.stringify({ env: { SEARCH_API_KEY: 'override-0123456789abcdef' } }));

    const res = await request('/api/v1/agents/5/mcp-servers');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(new RegExp(`${MCP_SECRET}|override-0123456789abcdef`));
    expect(JSON.parse(res.body[0].env)).toEqual({ SEARCH_API_KEY: '********cdef' });
  });
});
