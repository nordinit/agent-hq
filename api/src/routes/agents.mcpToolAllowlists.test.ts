import express from 'express';
import type { Server } from 'http';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';

const mockSyncAssignedMcpForAgent = jest.fn();

jest.mock('../runtimes/mcpMaterialization', () => ({
  cleanupOpenClawGlobalMcpForAgent: jest.fn(),
  syncAssignedMcpForAgent: (...args: unknown[]) => mockSyncAssignedMcpForAgent(...args),
}));

import agentsRouter from './agents';

let server: Server;
let baseUrl = '';

async function request(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe('agent MCP tool allowlist routes', () => {
  beforeEach(async () => {
    mockSyncAssignedMcpForAgent.mockReset();
    const db = await setupTestDb();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
    await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')`);
    await db.run(`
      INSERT INTO agents (id, tenant_id, name, session_key, runtime_type, workspace_path, enabled)
      VALUES (7, 1, 'Worker', 'agent:worker:main', 'openclaw', '/tmp/worker', 1)
    `);
    await db.run(`
      INSERT INTO mcp_servers (id, tenant_id, name, slug, command, env)
      VALUES (40, 1, 'Search', 'search', 'node', '{}'),
             (41, 1, 'Files', 'files', 'node', '{}')
    `);
    await db.run(`
      INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id, overrides, enabled)
      VALUES (7, 40, ?, 1), (7, 41, ?, 1)
    `, JSON.stringify({ cwd: '/srv/search', tool_allowlist: ['old_tool'] }), JSON.stringify({ tool_allowlist: ['read_file'] }));

    const app = express();
    app.use(express.json());
    app.use('/api/v1/agents', agentsRouter);
    server = await new Promise<Server>((resolve, reject) => {
      const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
      bound.on('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await teardownTestDb();
  });

  it('publishes the exact updated allowlist before reporting success', async () => {
    let overridesObservedBySync: Record<string, unknown> | null = null;
    mockSyncAssignedMcpForAgent.mockImplementation(async ({ db }: { db: ReturnType<typeof getDb> }) => {
      const row = await db.get<{ overrides: string }>(`
        SELECT overrides FROM agent_mcp_assignments WHERE agent_id = 7 AND mcp_server_id = 40
      `);
      overridesObservedBySync = JSON.parse(row!.overrides) as Record<string, unknown>;
      return { ok: true, count: 2, warnings: [] };
    });

    const response = await request('/api/v1/agents/7/mcp-tool-allowlists/40', {
      tool_allowlist: ['search_web', 'search_news', 'search_web'],
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ runtime_published: true, runtime_sync_skipped: null });
    expect(overridesObservedBySync).toEqual({ cwd: '/srv/search', tool_allowlist: ['search_web', 'search_news'] });
    expect(mockSyncAssignedMcpForAgent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 7,
      materializeOpenClawGlobalConfig: true,
    }));
    expect(response.body.servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ mcp_server_id: 40, tool_allowlist: ['search_web', 'search_news'], unrestricted: false }),
      expect.objectContaining({ mcp_server_id: 41, tool_allowlist: ['read_file'], unrestricted: false }),
    ]));
  });

  it('surfaces runtime publication failure without claiming the stored update was published', async () => {
    mockSyncAssignedMcpForAgent.mockResolvedValue({
      ok: false,
      count: 0,
      warnings: [],
      error: 'gateway reconciliation unavailable',
    });

    const response = await request('/api/v1/agents/7/mcp-tool-allowlists/40', {
      tool_allowlist: ['search_web'],
    });

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      agent_id: 7,
      allowlist_stored: true,
      runtime_published: false,
      error: expect.stringContaining('gateway reconciliation unavailable'),
    });
    const row = await getDb().get<{ overrides: string }>(`
      SELECT overrides FROM agent_mcp_assignments WHERE agent_id = 7 AND mcp_server_id = 40
    `);
    expect(JSON.parse(row!.overrides)).toEqual({ cwd: '/srv/search', tool_allowlist: ['search_web'] });
  });

  it('reports a thrown publication error as unpublished and redacts it', async () => {
    mockSyncAssignedMcpForAgent.mockRejectedValue(
      new Error('gateway rejected Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz0123456789'),
    );

    const response = await request('/api/v1/agents/7/mcp-tool-allowlists/40', {
      tool_allowlist: ['search_web'],
    });

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({ allowlist_stored: true, runtime_published: false });
    expect(response.body.error).toContain('gateway rejected');
    expect(response.body.error).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('stores the allowlist without failing when the agent has no workspace to publish to', async () => {
    mockSyncAssignedMcpForAgent.mockResolvedValue({
      ok: false,
      count: 0,
      warnings: [],
      skipped: 'missing_workspace',
      error: 'Agent #7 has no workspace_path',
    });

    const response = await request('/api/v1/agents/7/mcp-tool-allowlists/40', {
      tool_allowlist: ['search_web'],
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ runtime_published: false, runtime_sync_skipped: 'missing_workspace' });
    expect(response.body.servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ mcp_server_id: 40, tool_allowlist: ['search_web'] }),
    ]));
  });
});
