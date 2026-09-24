import express from 'express';
import type { Server } from 'http';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { getDb } from '../db/client';
import { authenticateMcpApiKeyIfPresent, authorizeMcpApiRequestIfPresent, issueMcpApiKeyForAgent, replaceAgentMcpPermissionPolicy } from './mcpApiAuth';

describe('telemetry MCP capability boundary', () => {
  let server: Server; let url: string; let scopedKey: string; let adminKey: string; let unassignedKey: string;
  beforeAll(async () => {
    const db = await setupTestDb();
    await db.run("INSERT INTO tenants(id,name,slug,is_default) VALUES(1,'One','one',1),(2,'Two','two',0) ON CONFLICT DO NOTHING");
    await db.run("INSERT INTO app_settings(key,value) VALUES('default_tenant_id','1'),('active_tenant_id','1') ON CONFLICT DO NOTHING");
    await db.run("INSERT INTO projects(id,tenant_id,name) VALUES(901,1,'Telemetry'),(902,1,'Other'),(903,2,'Other tenant')");
    await db.run("INSERT INTO agents(id,tenant_id,project_id,name,session_key,enabled) VALUES(901,1,901,'Telemetry Agent','agent:telemetry-test:main',1),(902,1,901,'Telemetry Admin','agent:telemetry-admin-test:main',1),(903,1,NULL,'Unassigned','agent:telemetry-unassigned-test:main',1)");
    scopedKey = (await issueMcpApiKeyForAgent(db, 901)).apiKey;
    adminKey = (await issueMcpApiKeyForAgent(db, 902, 'Telemetry admin', 'admin')).apiKey;
    unassignedKey = (await issueMcpApiKeyForAgent(db, 903)).apiKey;
    const app = express(); app.use(express.json());
    app.use('/api/v1', authenticateMcpApiKeyIfPresent, authorizeMcpApiRequestIfPresent);
    app.all('/api/v1/telemetry/v2/*', (req, res) => res.json({ authorized_project_id: req.telemetryProjectId ?? null }));
    app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode ?? error.status ?? 500).json({ error: error.message }));
    server = await new Promise<Server>(resolve => { const started = app.listen(0, '127.0.0.1', () => resolve(started)); });
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/telemetry/v2`;
  });
  afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await teardownTestDb(); });
  async function request(path: string, method = 'GET', body?: unknown, key = scopedKey) {
    return fetch(`${url}${path}`, { method, headers: { 'x-agent-hq-mcp-client': 'telemetry-test', Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  beforeEach(async () => { for (const agent of [901, 902, 903]) await replaceAgentMcpPermissionPolicy(getDb(), agent, []); });

  test('ordinary credentials have no implicit telemetry authority', async () => {
    expect((await request('/catalog')).status).toBe(403);
    expect((await request('/queries', 'POST', {})).status).toBe(403);
  });
  test('reads require their grant and omission of scope forces the assigned project', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 901, ['telemetry.read']);
    expect(await (await request('/catalog')).json()).toEqual({ authorized_project_id: 901 });
    expect((await request('/queries/id/contributors')).status).toBe(200);
    expect((await request('/bindings/preview','POST',{family_key:'value',scope:{project_id:901}})).status).toBe(200);
    expect((await request('/bindings/preview','POST',{family_key:'value',scope:{project_id:902}})).status).toBe(403);
    expect((await request('/queries', 'POST', {})).status).toBe(403);
    expect((await request('/metrics', 'POST', {})).status).toBe(403);
  });
  test('query authority cannot write definitions, maintenance state or unknown future routes', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 901, ['telemetry.query']);
    expect((await request('/queries/preview', 'POST', {})).status).toBe(200);
    expect((await request('/queries/id', 'DELETE')).status).toBe(200);
    expect((await request('/metrics', 'POST', {})).status).toBe(403);
    expect((await request('/backfills', 'POST', {})).status).toBe(403);
    expect((await request('/settings', 'PUT', {})).status).toBe(403);
    expect((await request('/future-operation', 'POST', {})).status).toBe(403);
  });
  test('cross-project and cross-tenant selectors are denied while forged body authority is ignored', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 901, ['telemetry.read', 'telemetry.query']);
    expect((await request('/catalog?project_id=902')).status).toBe(403);
    expect((await request('/queries', 'POST', { scope: { project_id: 902 } })).status).toBe(403);
    expect((await request('/catalog?tenant_id=2')).status).toBe(403);
    expect(await (await request('/queries', 'POST', { telemetryProjectId: 902, scope: { project_id: 901 } })).json()).toEqual({ authorized_project_id: 901 });
  });
  test('metric/profile/binding grants and report grants are independent', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 901, ['telemetry.manage_metrics']);
    expect((await request('/metrics', 'POST', {})).status).toBe(200);
    expect((await request('/profiles/id/revisions', 'POST', {})).status).toBe(200);
    expect((await request('/bindings', 'PUT', {})).status).toBe(200);
    expect((await request('/reports', 'POST', {})).status).toBe(403);
    expect((await request('/dashboards', 'POST', {})).status).toBe(403);
    expect((await request('/reports/id/snapshots', 'POST', {})).status).toBe(403);
    await replaceAgentMcpPermissionPolicy(getDb(), 901, ['telemetry.manage_reports']);
    expect((await request('/dashboards', 'POST', {})).status).toBe(200);
    expect((await request('/dashboards/id/revisions', 'POST', {})).status).toBe(200);
    expect((await request('/dashboards/id', 'DELETE')).status).toBe(200);
    expect((await request('/reports/id/snapshots', 'POST', {})).status).toBe(200);
    expect((await request('/metrics', 'POST', {})).status).toBe(403);
  });
  test('imports require both definition write grants; exports have their own grant', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 901, ['telemetry.manage_metrics']);
    expect((await request('/import', 'POST', {})).status).toBe(403);
    await replaceAgentMcpPermissionPolicy(getDb(), 901, ['telemetry.manage_metrics', 'telemetry.manage_reports']);
    expect((await request('/import', 'POST', {})).status).toBe(200);
    expect((await request('/export', 'POST', {})).status).toBe(403);
    await replaceAgentMcpPermissionPolicy(getDb(), 901, ['telemetry.export']);
    expect((await request('/export', 'POST', {})).status).toBe(200);
  });
  test('assigned project is mandatory even with a read grant', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 903, ['telemetry.read']);
    expect((await request('/catalog', 'GET', undefined, unassignedKey)).status).toBe(403);
  });
  test('an admin credential with only a scoped read grant remains project scoped', async () => {
    await replaceAgentMcpPermissionPolicy(getDb(), 902, ['telemetry.read']);
    expect(await (await request('/catalog', 'GET', undefined, adminKey)).json()).toEqual({ authorized_project_id: 901 });
    expect((await request('/catalog?project_id=902', 'GET', undefined, adminKey)).status).toBe(403);
    await replaceAgentMcpPermissionPolicy(getDb(), 902, ['admin.full_access']);
    expect(await (await request('/catalog', 'GET', undefined, adminKey)).json()).toEqual({ authorized_project_id: null });
  });
});
