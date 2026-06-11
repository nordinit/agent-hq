import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import { initSchema } from '../db/schema';
import { applyDefaultInstallPackage, DEFAULT_INSTALL_AGENT_SEEDS } from './defaultInstallPackage';

const originalDbPath = process.env.AGENT_HQ_DB_PATH;
let tempDir = '';

function resetDb(): void {
  closeDb();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-default-install-'));
  process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
  initSchema();
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

  it('assigns default package agents to a tenant-local Agent HQ MCP server', () => {
    resetDb();
    const db = getDb();
    const tenantId = Number(db.prepare(`
      INSERT INTO tenants (name, slug, is_default)
      VALUES ('Acme', 'acme', 0)
    `).run().lastInsertRowid);

    const result = applyDefaultInstallPackage(db, tenantId);

    expect(result.created.agent_mcp_assignments).toBe(DEFAULT_INSTALL_AGENT_SEEDS.length);
    const acmeServer = db.prepare(`
      SELECT id, tenant_id, slug
      FROM mcp_servers
      WHERE tenant_id = ? AND slug = 'agent-hq'
    `).get(tenantId) as { id: number; tenant_id: number; slug: string };
    expect(acmeServer).toMatchObject({ tenant_id: tenantId, slug: 'agent-hq' });

    const rows = db.prepare(`
      SELECT a.system_role, s.id AS server_id, s.tenant_id AS server_tenant_id, ama.enabled
      FROM agents a
      JOIN agent_mcp_assignments ama ON ama.agent_id = a.id
      JOIN mcp_servers s ON s.id = ama.mcp_server_id
      WHERE a.tenant_id = ?
      ORDER BY a.system_role ASC
    `).all(tenantId) as Array<{ system_role: string; server_id: number; server_tenant_id: number; enabled: number }>;
    expect(rows).toEqual(DEFAULT_INSTALL_AGENT_SEEDS
      .map((seed) => ({
        system_role: seed.systemRole,
        server_id: acmeServer.id,
        server_tenant_id: tenantId,
        enabled: 1,
      }))
      .sort((a, b) => a.system_role.localeCompare(b.system_role)));
    expect((db.prepare(`
      SELECT COUNT(*) AS n
      FROM agent_mcp_assignments ama
      JOIN agents a ON a.id = ama.agent_id
      JOIN mcp_servers s ON s.id = ama.mcp_server_id
      WHERE a.tenant_id != s.tenant_id
    `).get() as { n: number }).n).toBe(0);
  });
});
