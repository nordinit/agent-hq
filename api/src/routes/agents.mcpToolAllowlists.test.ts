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

  it('stores the exact allowlist for live enforcement without activating a host process',async()=>{
    mockSyncAssignedMcpForAgent.mockRejectedValue(new Error('must not run'));
    const response=await request('/api/v1/agents/7/mcp-tool-allowlists/40',{tool_allowlist:['search_web','search_news','search_web']});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({allowlist_stored:true,enforced_on_next_call:true,runtime_published:false,runtime_sync_skipped:'explicit_host_sync_required'});
    expect(mockSyncAssignedMcpForAgent).not.toHaveBeenCalled();
    const row=await getDb().get<{overrides:string}>('SELECT overrides FROM agent_mcp_assignments WHERE agent_id=7 AND mcp_server_id=40');
    expect(JSON.parse(row!.overrides)).toEqual({cwd:'/srv/search',tool_allowlist:['search_web','search_news']});
    expect(response.body.servers).toEqual(expect.arrayContaining([expect.objectContaining({mcp_server_id:41,tool_allowlist:['read_file']})]));
  });
});
