import fs from 'fs';
import path from 'path';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import {
  applyDefaultInstallPackage,
  DEFAULT_INSTALL_AGENT_SEEDS,
  DEFAULT_INSTALL_PACKAGE_VERSION,
} from './defaultInstallPackage';

// setupTestDb() picks the engine from AGENT_HQ_TEST_PG_URL, so this file runs unchanged on SQLite
// and on PostgreSQL. The PostgreSQL fixture carries DDL only and is truncated between tests, so
// every tenant this file needs is inserted explicitly rather than relying on initSchema seeding.
async function insertTenant(name: string, slug: string): Promise<number> {
  return Number((await getDb().run(
    `INSERT INTO tenants (name, slug, is_default) VALUES (?, ?, 0)`,
    name,
    slug,
  )).lastInsertId);
}

describe('applyDefaultInstallPackage', () => {
  beforeEach(async () => { await setupTestDb(); });
  afterEach(async () => { await teardownTestDb(); });

  it('assigns default package agents to a tenant-local Agent HQ MCP server', async () => {
    const db = getDb();
    const tenantId = await insertTenant('Acme', 'acme');

    const result = await applyDefaultInstallPackage(db, tenantId);

    expect(result.created.agent_mcp_assignments).toBe(DEFAULT_INSTALL_AGENT_SEEDS.length);
    const acmeServer = await db.get(`
      SELECT id, tenant_id, slug
      FROM mcp_servers
      WHERE tenant_id = ? AND slug = 'agent-hq'
    `, tenantId) as { id: number; tenant_id: number; slug: string };
    expect(acmeServer).toMatchObject({ tenant_id: tenantId, slug: 'agent-hq' });

    const rows = await db.all(`
      SELECT a.system_role, s.id AS server_id, s.tenant_id AS server_tenant_id, ama.enabled
      FROM agents a
      JOIN agent_mcp_assignments ama ON ama.agent_id = a.id
      JOIN mcp_servers s ON s.id = ama.mcp_server_id
      WHERE a.tenant_id = ?
      ORDER BY a.system_role ASC
    `, tenantId) as Array<{ system_role: string; server_id: number; server_tenant_id: number; enabled: number }>;
    expect(rows).toEqual(DEFAULT_INSTALL_AGENT_SEEDS
      .map((seed) => ({
        system_role: seed.systemRole,
        server_id: acmeServer.id,
        server_tenant_id: tenantId,
        enabled: 1,
      }))
      .sort((a, b) => a.system_role.localeCompare(b.system_role)));
    expect((await db.get(`
      SELECT COUNT(*) AS n
      FROM agent_mcp_assignments ama
      JOIN agents a ON a.id = ama.agent_id
      JOIN mcp_servers s ON s.id = ama.mcp_server_id
      WHERE a.tenant_id != s.tenant_id
    `) as { n: number }).n).toBe(0);
  });

  // Routing used to be filled in afterwards by a heuristic that guessed each agent's role from
  // its job-title text. That guessing is gone, so the declared seeds are now the ONLY thing
  // routing a fresh install — if they ever stop covering it, an install comes up unroutable and
  // silently dispatches nothing.
  it('routes a fresh install from declared seeds alone', async () => {
    const db = getDb();
    const tenantId = await insertTenant('Routing', 'routing');

    await applyDefaultInstallPackage(db, tenantId);

    const rules = await db.all(`
      SELECT r.sprint_type, r.task_type, r.status, a.system_role
      FROM sprint_task_routing_rules r
      JOIN agents a ON a.id = r.agent_id
      WHERE a.tenant_id = ?
    `, tenantId) as Array<{ sprint_type: string; task_type: string; status: string; system_role: string }>;

    expect(rules.length).toBeGreaterThan(0);
    // Implementation work goes to the declared developer, never to any other seed.
    const devReady = rules.filter(r => r.sprint_type === 'dev' && r.status === 'ready'
      && ['backend', 'frontend', 'fullstack'].includes(r.task_type));
    expect(devReady.length).toBe(3);
    expect([...new Set(devReady.map(r => r.system_role))]).toEqual(['default_developer']);
    // Every rule points at a declared seed rather than an inferred match.
    const seededRoles = new Set(DEFAULT_INSTALL_AGENT_SEEDS.map(seed => seed.systemRole));
    expect(rules.every(rule => seededRoles.has(rule.system_role))).toBe(true);
  });

  it('installs the canonical create-agent skill and assigns it to the developer agent', async () => {
    const db = getDb();
    const tenantId = await insertTenant('Acme', 'acme');
    const canonicalContent = fs.readFileSync(
      path.resolve(__dirname, '../../../skills/create-agent/SKILL.md'),
      'utf8',
    );

    const result = await applyDefaultInstallPackage(db, tenantId);

    expect(result.version).toBe(DEFAULT_INSTALL_PACKAGE_VERSION);
    expect(result.created.skills).toBe(1);
    expect(await db.get(`
      SELECT content, source, fs_path
      FROM skills
      WHERE tenant_id = ? AND name = 'create-agent'
    `, tenantId)).toEqual({ content: canonicalContent, source: 'system', fs_path: null });
    const agents = await db.all(`
      SELECT system_role, skill_names
      FROM agents
      WHERE tenant_id = ?
      ORDER BY system_role
    `, tenantId) as Array<{ system_role: string; skill_names: string }>;
    expect(agents.find((agent) => agent.system_role === 'default_developer')?.skill_names).toBe('["create-agent"]');
    expect(agents.filter((agent) => agent.system_role !== 'default_developer').every((agent) => agent.skill_names === '[]')).toBe(true);
  });

  it('refreshes package-managed skills while preserving tenant-managed overrides', async () => {
    const db = getDb();
    const systemTenantId = await insertTenant('System', 'system');
    const workspaceTenantId = await insertTenant('Workspace', 'workspace');
    await db.run(`
      INSERT INTO skills (tenant_id, name, description, content, source)
      VALUES (?, 'create-agent', 'Old', '# Old', 'system')
    `, systemTenantId);
    await db.run(`
      INSERT INTO skills (tenant_id, name, description, content, source)
      VALUES (?, 'create-agent', 'Custom', '# Custom', 'workspace')
    `, workspaceTenantId);

    const systemResult = await applyDefaultInstallPackage(db, systemTenantId, { mode: 'reinstall' });
    const workspaceResult = await applyDefaultInstallPackage(db, workspaceTenantId, { mode: 'reinstall' });

    expect(systemResult.updated.skills).toBe(1);
    expect((await db.get(`SELECT content FROM skills WHERE tenant_id = ? AND name = 'create-agent'`, systemTenantId) as { content: string }).content)
      .toContain('Repository configuration is workflow-owned.');
    expect(workspaceResult.conflicts).toEqual([
      expect.objectContaining({ kind: 'skill', key: 'create-agent' }),
    ]);
    expect(await db.get(`SELECT description, content, source FROM skills WHERE tenant_id = ? AND name = 'create-agent'`, workspaceTenantId))
      .toEqual({ description: 'Custom', content: '# Custom', source: 'workspace' });
  });
});
