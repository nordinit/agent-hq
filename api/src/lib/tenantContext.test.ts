import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { deleteTenant, ensureTenantSchema, verifyTenantSchemaForStartup } from './tenantContext';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  // Minimal operational tables the backfill touches. tasks already carries tenant_id;
  // job_instances starts without it so ensureTenantSchema must add + backfill it.
  db.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, tenant_id INTEGER);
    CREATE TABLE job_instances (id INTEGER PRIMARY KEY, task_id INTEGER, agent_id INTEGER);
  `);
});

afterEach(() => {
  db.close();
});

describe('ensureTenantSchema', () => {
  it('backfills tenant ownership for existing rows on the first call', () => {
    db.prepare(`INSERT INTO tasks (id, tenant_id) VALUES (1, 1)`).run();
    db.prepare(`INSERT INTO job_instances (id, task_id) VALUES (10, 1)`).run();

    const defaultTenantId = ensureTenantSchema(db);

    const row = db.prepare(`SELECT tenant_id FROM job_instances WHERE id = 10`).get() as { tenant_id: number | null };
    expect(row.tenant_id).toBe(1);
    expect(typeof defaultTenantId).toBe('number');
  });

  it('preserves lightweight null tenant repair on cached calls', () => {
    db.prepare(`INSERT INTO tasks (id, tenant_id) VALUES (1, 1)`).run();
    const first = ensureTenantSchema(db);

    db.prepare(`INSERT INTO job_instances (id, task_id, tenant_id) VALUES (20, 1, NULL)`).run();
    const second = ensureTenantSchema(db);

    expect(second).toBe(first);
    const row = db.prepare(`SELECT tenant_id FROM job_instances WHERE id = 20`).get() as { tenant_id: number | null };
    expect(row.tenant_id).toBe(first);
  });

  it('adds tenant ownership to tenant-owned tables created after the first ensure', () => {
    const defaultTenantId = ensureTenantSchema(db);
    db.exec(`
      CREATE TABLE mcp_servers (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        command TEXT NOT NULL
      );
    `);

    const second = ensureTenantSchema(db);

    expect(second).toBe(defaultTenantId);
    const columns = db.prepare(`PRAGMA table_info(mcp_servers)`).all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('tenant_id');
  });

  it('migrates MCP server slugs from global unique to tenant-local unique', () => {
    db.exec(`
      CREATE TABLE mcp_servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        transport TEXT NOT NULL DEFAULT 'stdio' CHECK(transport IN ('stdio')),
        command TEXT NOT NULL,
        args TEXT NOT NULL DEFAULT '[]',
        env TEXT NOT NULL DEFAULT '{}',
        cwd TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO mcp_servers (id, name, slug, command) VALUES (10, 'Default Agent HQ MCP', 'agent-hq', 'node');
    `);

    const defaultTenantId = ensureTenantSchema(db);
    const otherTenantId = Number(db.prepare(`
      INSERT INTO tenants (name, slug, is_default)
      VALUES ('Acme', 'acme', 0)
    `).run().lastInsertRowid);
    db.prepare(`
      INSERT INTO mcp_servers (tenant_id, name, slug, command)
      VALUES (?, 'Acme Agent HQ MCP', 'agent-hq', 'node')
    `).run(otherTenantId);

    const rows = db.prepare(`
      SELECT id, tenant_id, slug
      FROM mcp_servers
      WHERE slug = 'agent-hq'
      ORDER BY tenant_id ASC
    `).all() as Array<{ id: number; tenant_id: number; slug: string }>;
    expect(rows).toEqual([
      { id: 10, tenant_id: defaultTenantId, slug: 'agent-hq' },
      { id: 11, tenant_id: otherTenantId, slug: 'agent-hq' },
    ]);
    expect(() => db.prepare(`
      INSERT INTO mcp_servers (tenant_id, name, slug, command)
      VALUES (?, 'Duplicate', 'agent-hq', 'node')
    `).run(otherTenantId)).toThrow();
  });

  it('repairs existing cross-tenant Agent HQ MCP assignments on cached schema calls', () => {
    const defaultTenantId = ensureTenantSchema(db);
    const otherTenantId = Number(db.prepare(`
      INSERT INTO tenants (name, slug, is_default)
      VALUES ('Acme', 'acme', 0)
    `).run().lastInsertRowid);
    db.exec(`
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL
      );
      CREATE TABLE mcp_servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        transport TEXT NOT NULL DEFAULT 'stdio' CHECK(transport IN ('stdio')),
        command TEXT NOT NULL,
        args TEXT NOT NULL DEFAULT '[]',
        env TEXT NOT NULL DEFAULT '{}',
        cwd TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, slug)
      );
      CREATE TABLE agent_mcp_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        mcp_server_id INTEGER NOT NULL,
        overrides TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        UNIQUE(agent_id, mcp_server_id)
      );
    `);
    const defaultServerId = Number(db.prepare(`
      INSERT INTO mcp_servers (tenant_id, name, slug, command)
      VALUES (?, 'Default Agent HQ MCP', 'agent-hq', 'node')
    `).run(defaultTenantId).lastInsertRowid);
    const otherAgentId = Number(db.prepare(`
      INSERT INTO agents (tenant_id) VALUES (?)
    `).run(otherTenantId).lastInsertRowid);
    db.prepare(`
      INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id, overrides, enabled)
      VALUES (?, ?, '{"from":"stale"}', 1)
    `).run(otherAgentId, defaultServerId);

    expect(ensureTenantSchema(db)).toBe(defaultTenantId);

    const localServer = db.prepare(`
      SELECT id, tenant_id, slug
      FROM mcp_servers
      WHERE tenant_id = ? AND slug = 'agent-hq'
    `).get(otherTenantId) as { id: number; tenant_id: number; slug: string };
    expect(localServer).toMatchObject({ tenant_id: otherTenantId, slug: 'agent-hq' });
    expect(localServer.id).not.toBe(defaultServerId);

    expect(db.prepare(`
      SELECT s.id AS server_id, s.tenant_id AS server_tenant_id, ama.overrides, ama.enabled
      FROM agent_mcp_assignments ama
      JOIN mcp_servers s ON s.id = ama.mcp_server_id
      WHERE ama.agent_id = ? AND s.slug = 'agent-hq'
    `).all(otherAgentId)).toEqual([
      { server_id: localServer.id, server_tenant_id: otherTenantId, overrides: '{"from":"stale"}', enabled: 1 },
    ]);
    expect((db.prepare(`
      SELECT COUNT(*) AS n
      FROM agent_mcp_assignments ama
      JOIN agents a ON a.id = ama.agent_id
      JOIN mcp_servers s ON s.id = ama.mcp_server_id
      WHERE a.tenant_id != s.tenant_id
    `).get() as { n: number }).n).toBe(0);
  });

  it('deletes tenant-owned skills when deleting a tenant', () => {
    const defaultTenantId = ensureTenantSchema(db);
    const otherTenantId = Number(db.prepare(`
      INSERT INTO tenants (name, slug, is_default)
      VALUES ('Acme', 'acme', 0)
    `).run().lastInsertRowid);
    db.exec(`
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL
      );
      CREATE TABLE skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'atlas',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, name)
      );
    `);
    db.prepare(`INSERT INTO skills (tenant_id, name, content) VALUES (?, 'default-skill', '# default')`).run(defaultTenantId);
    db.prepare(`INSERT INTO skills (tenant_id, name, content) VALUES (?, 'tenant-skill', '# tenant')`).run(otherTenantId);

    const result = deleteTenant(db, otherTenantId, { confirmation: 'Acme' });

    expect(result.deleted_counts.skills).toBe(1);
    expect(db.prepare(`SELECT id FROM tenants WHERE id = ?`).get(otherTenantId)).toBeUndefined();
    expect(db.prepare(`SELECT tenant_id, name FROM skills ORDER BY id`).all()).toEqual([
      { tenant_id: defaultTenantId, name: 'default-skill' },
    ]);
  });
});

describe('verifyTenantSchemaForStartup', () => {
  function createCurrentTenantState(): void {
    db.exec(`
      DROP TABLE IF EXISTS tasks;
      DROP TABLE IF EXISTS job_instances;
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE tenants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1);
      INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1');
    `);
  }

  it('fails with an install/migration-required error instead of creating tenant state', () => {
    expect(() => verifyTenantSchemaForStartup(db)).toThrow('Tenant install/migration required');
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenants'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'`).get()).toBeUndefined();
  });

  it('does not repair null tenant ownership during startup verification', () => {
    createCurrentTenantState();
    db.exec(`
      CREATE TABLE tasks (id INTEGER PRIMARY KEY, tenant_id INTEGER);
      CREATE TABLE job_instances (id INTEGER PRIMARY KEY, task_id INTEGER, tenant_id INTEGER);
      INSERT INTO tasks (id, tenant_id) VALUES (1, 1);
      INSERT INTO job_instances (id, task_id, tenant_id) VALUES (10, 1, NULL);
    `);

    expect(() => verifyTenantSchemaForStartup(db)).toThrow('job_instances contains rows without tenant ownership');
    const row = db.prepare(`SELECT tenant_id FROM job_instances WHERE id = 10`).get() as { tenant_id: number | null };
    expect(row.tenant_id).toBeNull();
  });

  it('accepts current tenant state without updating tenant or app setting rows', () => {
    createCurrentTenantState();
    db.exec(`
      CREATE TABLE tasks (id INTEGER PRIMARY KEY, tenant_id INTEGER);
      CREATE TABLE job_instances (id INTEGER PRIMARY KEY, task_id INTEGER, tenant_id INTEGER);
      CREATE TABLE sprint_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        key TEXT NOT NULL
      );
      CREATE TABLE task_field_schemas (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, sprint_type_key TEXT NOT NULL);
      INSERT INTO tasks (id, tenant_id) VALUES (1, 1);
      INSERT INTO job_instances (id, task_id, tenant_id) VALUES (10, 1, 1);
      INSERT INTO sprint_types (tenant_id, key) VALUES (1, 'dev');
      INSERT INTO task_field_schemas (id, tenant_id, sprint_type_key) VALUES (1, 1, 'dev');
    `);
    const beforeSettings = db.prepare(`SELECT key, value, updated_at FROM app_settings ORDER BY key`).all();
    const beforeTenants = db.prepare(`SELECT id, name, slug, is_default, updated_at FROM tenants ORDER BY id`).all();

    expect(verifyTenantSchemaForStartup(db)).toBe(1);
    expect(verifyTenantSchemaForStartup(db)).toBe(1);

    expect(db.prepare(`SELECT key, value, updated_at FROM app_settings ORDER BY key`).all()).toEqual(beforeSettings);
    expect(db.prepare(`SELECT id, name, slug, is_default, updated_at FROM tenants ORDER BY id`).all()).toEqual(beforeTenants);
  });
});
