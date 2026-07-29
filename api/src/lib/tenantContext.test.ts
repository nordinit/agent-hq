import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { deleteTenant, ensureTenantSchema, verifyTenantSchemaForStartup } from './tenantContext';
import { type Db } from "../db/adapter/types";

let db: Db;

beforeEach(async () => {
  db = new Database(':memory:');
  // Minimal operational tables the backfill touches. tasks already carries tenant_id;
  // job_instances starts without it so ensureTenantSchema must add + backfill it.
  await db.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, tenant_id INTEGER);
    CREATE TABLE job_instances (id INTEGER PRIMARY KEY, task_id INTEGER, agent_id INTEGER);
  `);
});

afterEach(() => {
  db.close();
});

describe('ensureTenantSchema', () => {
  it('backfills tenant ownership for existing rows on the first call', async () => {
    await db.run(`INSERT INTO tasks (id, tenant_id) VALUES (1, 1)`);
    await db.run(`INSERT INTO job_instances (id, task_id) VALUES (10, 1)`);

    const defaultTenantId = await ensureTenantSchema(db);

    const row = await db.get(`SELECT tenant_id FROM job_instances WHERE id = 10`) as { tenant_id: number | null };
    expect(row.tenant_id).toBe(1);
    expect(typeof defaultTenantId).toBe('number');
  });

  it('preserves lightweight null tenant repair on cached calls', async () => {
    await db.run(`INSERT INTO tasks (id, tenant_id) VALUES (1, 1)`);
    const first = await ensureTenantSchema(db);

    await db.run(`INSERT INTO job_instances (id, task_id, tenant_id) VALUES (20, 1, NULL)`);
    const second = await ensureTenantSchema(db);

    expect(second).toBe(first);
    const row = await db.get(`SELECT tenant_id FROM job_instances WHERE id = 20`) as { tenant_id: number | null };
    expect(row.tenant_id).toBe(first);
  });

  it('adds tenant ownership to tenant-owned tables created after the first ensure', async () => {
    const defaultTenantId = await ensureTenantSchema(db);
    await db.exec(`
      CREATE TABLE mcp_servers (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        command TEXT NOT NULL
      );
    `);

    const second = await ensureTenantSchema(db);

    expect(second).toBe(defaultTenantId);
    const columns = await db.all(`PRAGMA table_info(mcp_servers)`) as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('tenant_id');
  });

  it('migrates MCP server slugs from global unique to tenant-local unique', async () => {
    await db.exec(`
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

    const defaultTenantId = await ensureTenantSchema(db);
    const otherTenantId = Number((await db.run(`
      INSERT INTO tenants (name, slug, is_default)
      VALUES ('Acme', 'acme', 0)
    `)).lastInsertRowid);
    await db.run(`
      INSERT INTO mcp_servers (tenant_id, name, slug, command)
      VALUES (?, 'Acme Agent HQ MCP', 'agent-hq', 'node')
    `, otherTenantId);

    const rows = await db.all(`
      SELECT id, tenant_id, slug
      FROM mcp_servers
      WHERE slug = 'agent-hq'
      ORDER BY tenant_id ASC
    `) as Array<{ id: number; tenant_id: number; slug: string }>;
    expect(rows).toEqual([
      { id: 10, tenant_id: defaultTenantId, slug: 'agent-hq' },
      { id: 11, tenant_id: otherTenantId, slug: 'agent-hq' },
    ]);
    expect(async () => await db.run(`
      INSERT INTO mcp_servers (tenant_id, name, slug, command)
      VALUES (?, 'Duplicate', 'agent-hq', 'node')
    `, otherTenantId)).toThrow();
  });

  it('repairs existing cross-tenant Agent HQ MCP assignments on cached schema calls', async () => {
    const defaultTenantId = await ensureTenantSchema(db);
    const otherTenantId = Number((await db.run(`
      INSERT INTO tenants (name, slug, is_default)
      VALUES ('Acme', 'acme', 0)
    `)).lastInsertRowid);
    await db.exec(`
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
    const defaultServerId = Number((await db.run(`
      INSERT INTO mcp_servers (tenant_id, name, slug, command)
      VALUES (?, 'Default Agent HQ MCP', 'agent-hq', 'node')
    `, defaultTenantId)).lastInsertRowid);
    const otherAgentId = Number((await db.run(`
      INSERT INTO agents (tenant_id) VALUES (?)
    `, otherTenantId)).lastInsertRowid);
    await db.run(`
      INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id, overrides, enabled)
      VALUES (?, ?, '{"from":"stale"}', 1)
    `, otherAgentId, defaultServerId);

    expect(await ensureTenantSchema(db)).toBe(defaultTenantId);

    const localServer = await db.get(`
      SELECT id, tenant_id, slug
      FROM mcp_servers
      WHERE tenant_id = ? AND slug = 'agent-hq'
    `, otherTenantId) as { id: number; tenant_id: number; slug: string };
    expect(localServer).toMatchObject({ tenant_id: otherTenantId, slug: 'agent-hq' });
    expect(localServer.id).not.toBe(defaultServerId);

    expect(await db.all(`
      SELECT s.id AS server_id, s.tenant_id AS server_tenant_id, ama.overrides, ama.enabled
      FROM agent_mcp_assignments ama
      JOIN mcp_servers s ON s.id = ama.mcp_server_id
      WHERE ama.agent_id = ? AND s.slug = 'agent-hq'
    `, otherAgentId)).toEqual([
      { server_id: localServer.id, server_tenant_id: otherTenantId, overrides: '{"from":"stale"}', enabled: 1 },
    ]);
    expect((await db.get(`
      SELECT COUNT(*) AS n
      FROM agent_mcp_assignments ama
      JOIN agents a ON a.id = ama.agent_id
      JOIN mcp_servers s ON s.id = ama.mcp_server_id
      WHERE a.tenant_id != s.tenant_id
    `) as { n: number }).n).toBe(0);
  });

  it('deletes tenant-owned skills when deleting a tenant', async () => {
    const defaultTenantId = await ensureTenantSchema(db);
    const otherTenantId = Number((await db.run(`
      INSERT INTO tenants (name, slug, is_default)
      VALUES ('Acme', 'acme', 0)
    `)).lastInsertRowid);
    await db.exec(`
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
    await db.run(`INSERT INTO skills (tenant_id, name, content) VALUES (?, 'default-skill', '# default')`, defaultTenantId);
    await db.run(`INSERT INTO skills (tenant_id, name, content) VALUES (?, 'tenant-skill', '# tenant')`, otherTenantId);

    const result = await deleteTenant(db, otherTenantId, { confirmation: 'Acme' });

    expect(result.deleted_counts.skills).toBe(1);
    expect(await db.get(`SELECT id FROM tenants WHERE id = ?`, otherTenantId)).toBeUndefined();
    expect(await db.all(`SELECT tenant_id, name FROM skills ORDER BY id`)).toEqual([
      { tenant_id: defaultTenantId, name: 'default-skill' },
    ]);
  });
});

describe('verifyTenantSchemaForStartup', () => {
  async function createCurrentTenantState(): Promise<void> {
    await db.exec(`
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

  it('fails with an install/migration-required error instead of creating tenant state', async () => {
    expect(async () => await verifyTenantSchemaForStartup(db)).toThrow('Tenant install/migration required');
    expect(await db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenants'`)).toBeUndefined();
    expect(await db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'`)).toBeUndefined();
  });

  it('does not repair null tenant ownership during startup verification', async () => {
    await createCurrentTenantState();
    await db.exec(`
      CREATE TABLE tasks (id INTEGER PRIMARY KEY, tenant_id INTEGER);
      CREATE TABLE job_instances (id INTEGER PRIMARY KEY, task_id INTEGER, tenant_id INTEGER);
      INSERT INTO tasks (id, tenant_id) VALUES (1, 1);
      INSERT INTO job_instances (id, task_id, tenant_id) VALUES (10, 1, NULL);
    `);

    expect(async () => await verifyTenantSchemaForStartup(db)).toThrow('job_instances contains rows without tenant ownership');
    const row = await db.get(`SELECT tenant_id FROM job_instances WHERE id = 10`) as { tenant_id: number | null };
    expect(row.tenant_id).toBeNull();
  });

  it('accepts current tenant state without updating tenant or app setting rows', async () => {
    await createCurrentTenantState();
    await db.exec(`
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
    const beforeSettings = await db.all(`SELECT key, value, updated_at FROM app_settings ORDER BY key`);
    const beforeTenants = await db.all(`SELECT id, name, slug, is_default, updated_at FROM tenants ORDER BY id`);

    expect(await verifyTenantSchemaForStartup(db)).toBe(1);
    expect(await verifyTenantSchemaForStartup(db)).toBe(1);

    expect(await db.all(`SELECT key, value, updated_at FROM app_settings ORDER BY key`)).toEqual(beforeSettings);
    expect(await db.all(`SELECT id, name, slug, is_default, updated_at FROM tenants ORDER BY id`)).toEqual(beforeTenants);
  });
});
