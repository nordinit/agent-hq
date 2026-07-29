import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import { initSchema } from '../db/schema';
import {
  applyDefaultInstallPackage,
  DEFAULT_INSTALL_AGENT_SEEDS,
  DEFAULT_INSTALL_PACKAGE_VERSION,
} from './defaultInstallPackage';

const originalDbPath = process.env.AGENT_HQ_DB_PATH;
let tempDir = '';

async function resetDb(): Promise<void> {
  closeDb();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-default-install-'));
  process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
  await initSchema();
}

function cleanup(): void {
  closeDb();
  if (originalDbPath == null) delete process.env.AGENT_HQ_DB_PATH;
  else process.env.AGENT_HQ_DB_PATH = originalDbPath;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
}

describe('applyDefaultInstallPackage', () => {
  afterEach(cleanup);

  it('assigns default package agents to a tenant-local Agent HQ MCP server', async () => {
    await resetDb();
    const db = getDb();
    const tenantId = Number((await db.run(`
      INSERT INTO tenants (name, slug, is_default)
      VALUES ('Acme', 'acme', 0)
    `)).lastInsertRowid);

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

  it('installs the canonical create-agent skill and assigns it to the developer agent', async () => {
    await resetDb();
    const db = getDb();
    const tenantId = Number((await db.run(`
      INSERT INTO tenants (name, slug, is_default)
      VALUES ('Acme', 'acme', 0)
    `)).lastInsertRowid);
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
    await resetDb();
    const db = getDb();
    const systemTenantId = Number((await db.run(`
      INSERT INTO tenants (name, slug, is_default)
      VALUES ('System', 'system', 0)
    `)).lastInsertRowid);
    const workspaceTenantId = Number((await db.run(`
      INSERT INTO tenants (name, slug, is_default)
      VALUES ('Workspace', 'workspace', 0)
    `)).lastInsertRowid);
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
