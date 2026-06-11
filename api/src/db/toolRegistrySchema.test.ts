import { closeDb, getDb } from './client';
import { initSchema, ensureToolRegistryTables, provisionDefaultMcpRegistry, provisionDefaultToolRegistry } from './schema';

function resetDb(): void {
  closeDb();
}

function createMinimalAgentsTable(): void {
  getDb().exec(`
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );
  `);
}

function toolsTableSql(): string {
  return (getDb().prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tools'`).get() as { sql: string }).sql;
}

describe('ensureToolRegistryTables', () => {
  beforeEach(resetDb);
  afterEach(resetDb);

  it('bootstraps cleanly when the tools table does not exist', () => {
    createMinimalAgentsTable();

    expect(() => ensureToolRegistryTables()).not.toThrow();

    expect(toolsTableSql()).toContain("'shell'");
    expect(toolsTableSql()).toContain("'script'");
    expect(getDb().prepare(`SELECT COUNT(*) AS count FROM tools`).get()).toMatchObject({ count: expect.any(Number) });
  });

  it('migrates a legacy tools table shape without referencing a stale legacy table', () => {
    createMinimalAgentsTable();
    getDb().exec(`
      CREATE TABLE tools (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        name                 TEXT NOT NULL,
        slug                 TEXT NOT NULL UNIQUE,
        description          TEXT NOT NULL DEFAULT '',
        implementation_type  TEXT NOT NULL DEFAULT 'bash' CHECK(implementation_type IN ('bash','mcp','function','http')),
        implementation_body  TEXT NOT NULL DEFAULT '',
        input_schema         TEXT NOT NULL DEFAULT '{}',
        permissions          TEXT NOT NULL DEFAULT 'read_only' CHECK(permissions IN ('read_only','read_write','exec','network')),
        tags                 TEXT NOT NULL DEFAULT '[]',
        enabled              INTEGER NOT NULL DEFAULT 1,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO tools (name, slug, implementation_type, implementation_body, permissions)
      VALUES ('Legacy Bash', 'legacy_bash', 'bash', 'echo legacy', 'exec');
    `);

    expect(() => ensureToolRegistryTables()).not.toThrow();

    expect(toolsTableSql()).toContain("'shell'");
    expect(toolsTableSql()).toContain("'script'");
    expect(getDb().prepare(`SELECT name, slug, implementation_type FROM tools WHERE slug = 'legacy_bash'`).get()).toEqual({
      name: 'Legacy Bash',
      slug: 'legacy_bash',
      implementation_type: 'bash',
    });
    expect(getDb().prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tools_legacy_capability_exec'`).get()).toBeUndefined();
  });

  it('replaces legacy global tool slug uniqueness with tenant-local slug uniqueness', () => {
    createMinimalAgentsTable();
    getDb().exec(`
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tenants (id INTEGER PRIMARY KEY, slug TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0);
      INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '7');
      INSERT INTO tenants (id, slug, is_default) VALUES (7, 'default', 1), (8, 'elevation-build', 0);
      CREATE TABLE tools (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        name                 TEXT NOT NULL,
        slug                 TEXT NOT NULL UNIQUE,
        description          TEXT NOT NULL DEFAULT '',
        implementation_type  TEXT NOT NULL DEFAULT 'bash' CHECK(implementation_type IN ('bash','shell','script','mcp','function','http')),
        implementation_body  TEXT NOT NULL DEFAULT '',
        input_schema         TEXT NOT NULL DEFAULT '{}',
        permissions          TEXT NOT NULL DEFAULT 'read_only' CHECK(permissions IN ('read_only','read_write','exec','network')),
        tags                 TEXT NOT NULL DEFAULT '[]',
        enabled              INTEGER NOT NULL DEFAULT 1,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO tools (id, name, slug, implementation_type, implementation_body)
      VALUES (10, 'Legacy Bash', 'bash', 'bash', 'echo legacy');
    `);

    expect(() => ensureToolRegistryTables()).not.toThrow();

    expect(toolsTableSql()).toContain('tenant_id');
    expect(toolsTableSql()).toContain('UNIQUE(tenant_id, slug)');
    expect(getDb().prepare(`SELECT tenant_id, slug FROM tools WHERE id = 10`).get()).toEqual({ tenant_id: 7, slug: 'bash' });
    expect(() => getDb().prepare(`
      INSERT INTO tools (tenant_id, name, slug, implementation_type, implementation_body)
      VALUES (8, 'Tenant Bash', 'bash', 'bash', 'echo tenant')
    `).run()).not.toThrow();
    expect(() => getDb().prepare(`
      INSERT INTO tools (tenant_id, name, slug, implementation_type, implementation_body)
      VALUES (8, 'Duplicate Tenant Bash', 'bash', 'bash', 'echo duplicate')
    `).run()).toThrow(/UNIQUE constraint failed/);
  });

  it('removes stale cross-tenant tool assignments during registry repair', () => {
    getDb().exec(`
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        name TEXT NOT NULL
      );
      INSERT INTO agents (id, tenant_id, name) VALUES (1, 1, 'Tenant A Agent'), (2, 2, 'Tenant B Agent');
      CREATE TABLE tools (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id            INTEGER NOT NULL DEFAULT 1,
        name                 TEXT NOT NULL,
        slug                 TEXT NOT NULL,
        description          TEXT NOT NULL DEFAULT '',
        implementation_type  TEXT NOT NULL DEFAULT 'bash' CHECK(implementation_type IN ('bash','shell','script','mcp','function','http')),
        implementation_body  TEXT NOT NULL DEFAULT '',
        input_schema         TEXT NOT NULL DEFAULT '{}',
        permissions          TEXT NOT NULL DEFAULT 'read_only' CHECK(permissions IN ('read_only','read_write','exec','network')),
        tags                 TEXT NOT NULL DEFAULT '[]',
        enabled              INTEGER NOT NULL DEFAULT 1,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, slug)
      );
      INSERT INTO tools (id, tenant_id, name, slug, implementation_type, implementation_body)
      VALUES (10, 1, 'Tenant A Tool', 'tool', 'bash', 'echo a'), (20, 2, 'Tenant B Tool', 'tool', 'bash', 'echo b');
      CREATE TABLE agent_tool_assignments (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id  INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        tool_id   INTEGER NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
        overrides TEXT NOT NULL DEFAULT '{}',
        enabled   INTEGER NOT NULL DEFAULT 1,
        UNIQUE(agent_id, tool_id)
      );
      INSERT INTO agent_tool_assignments (id, agent_id, tool_id) VALUES (100, 1, 10), (101, 1, 20), (102, 2, 20);
    `);

    ensureToolRegistryTables();

    expect(getDb().prepare(`SELECT id, agent_id, tool_id FROM agent_tool_assignments ORDER BY id ASC`).all()).toEqual([
      { id: 100, agent_id: 1, tool_id: 10 },
      { id: 102, agent_id: 2, tool_id: 20 },
    ]);
  });

  it('repairs assignment foreign keys after a tools table rebuild and then removes stale cross-tenant assignments', () => {
    getDb().exec(`
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        name TEXT NOT NULL
      );
      INSERT INTO agents (id, tenant_id, name) VALUES (1, 1, 'Tenant A Agent'), (2, 2, 'Tenant B Agent');
      CREATE TABLE tools (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id            INTEGER NOT NULL DEFAULT 1,
        name                 TEXT NOT NULL,
        slug                 TEXT NOT NULL,
        description          TEXT NOT NULL DEFAULT '',
        implementation_type  TEXT NOT NULL DEFAULT 'bash' CHECK(implementation_type IN ('bash','mcp','function','http')),
        implementation_body  TEXT NOT NULL DEFAULT '',
        input_schema         TEXT NOT NULL DEFAULT '{}',
        permissions          TEXT NOT NULL DEFAULT 'read_only' CHECK(permissions IN ('read_only','read_write','exec','network')),
        tags                 TEXT NOT NULL DEFAULT '[]',
        enabled              INTEGER NOT NULL DEFAULT 1,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, slug)
      );
      INSERT INTO tools (id, tenant_id, name, slug, implementation_type, implementation_body)
      VALUES (10, 1, 'Tenant A Tool', 'tool-a', 'bash', 'echo a'), (20, 2, 'Tenant B Tool', 'tool-b', 'bash', 'echo b');
      CREATE TABLE agent_tool_assignments (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id  INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        tool_id   INTEGER NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
        overrides TEXT NOT NULL DEFAULT '{}',
        enabled   INTEGER NOT NULL DEFAULT 1,
        UNIQUE(agent_id, tool_id)
      );
      INSERT INTO agent_tool_assignments (id, agent_id, tool_id) VALUES (100, 1, 10), (101, 1, 20), (102, 2, 20);
    `);

    expect(() => ensureToolRegistryTables()).not.toThrow();

    const assignmentSql = (getDb().prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_tool_assignments'`).get() as { sql: string }).sql;
    expect(assignmentSql).toContain('REFERENCES tools(id)');
    expect(assignmentSql).not.toContain('tools_rebuild_');
    expect(getDb().prepare(`PRAGMA foreign_key_list(agent_tool_assignments)`).all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'tool_id', table: 'tools' }),
    ]));
    expect(getDb().prepare(`SELECT id, agent_id, tool_id FROM agent_tool_assignments ORDER BY id ASC`).all()).toEqual([
      { id: 100, agent_id: 1, tool_id: 10 },
      { id: 102, agent_id: 2, tool_id: 20 },
    ]);
  });

  it('repairs assignment tables left pointing at the stale legacy tools table', () => {
    createMinimalAgentsTable();
    getDb().pragma('foreign_keys = OFF');
    getDb().exec(`
      INSERT INTO agents (id, name) VALUES (1, 'Agent');
      CREATE TABLE tools (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        name                 TEXT NOT NULL,
        slug                 TEXT NOT NULL UNIQUE,
        description          TEXT NOT NULL DEFAULT '',
        implementation_type  TEXT NOT NULL DEFAULT 'bash' CHECK(implementation_type IN ('bash','shell','script','mcp','function','http')),
        implementation_body  TEXT NOT NULL DEFAULT '',
        input_schema         TEXT NOT NULL DEFAULT '{}',
        permissions          TEXT NOT NULL DEFAULT 'read_only' CHECK(permissions IN ('read_only','read_write','exec','network')),
        tags                 TEXT NOT NULL DEFAULT '[]',
        enabled              INTEGER NOT NULL DEFAULT 1,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO tools (id, name, slug, implementation_type, implementation_body)
      VALUES (10, 'Tool', 'tool', 'bash', 'echo ok');
      CREATE TABLE tools_legacy_capability_exec (id INTEGER PRIMARY KEY);
      CREATE TABLE agent_tool_assignments (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id  INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        tool_id   INTEGER NOT NULL REFERENCES "tools_legacy_capability_exec"(id) ON DELETE CASCADE,
        overrides TEXT NOT NULL DEFAULT '{}',
        enabled   INTEGER NOT NULL DEFAULT 1,
        UNIQUE(agent_id, tool_id)
      );
      INSERT INTO agent_tool_assignments (agent_id, tool_id) VALUES (1, 10);
      DROP TABLE tools_legacy_capability_exec;
    `);
    getDb().pragma('foreign_keys = ON');

    expect(() => ensureToolRegistryTables()).not.toThrow();

    const assignmentSql = (getDb().prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_tool_assignments'`).get() as { sql: string }).sql;
    expect(assignmentSql).toContain('REFERENCES tools(id)');
    expect(getDb().prepare(`SELECT agent_id, tool_id FROM agent_tool_assignments WHERE agent_id = 1`).get()).toEqual({
      agent_id: 1,
      tool_id: 10,
    });
  });

  it('does not seed tool registry defaults during schema startup', () => {
    createMinimalAgentsTable();

    ensureToolRegistryTables();

    expect(getDb().prepare(`SELECT COUNT(*) AS count FROM tools`).get()).toEqual({ count: 0 });
    expect(getDb().prepare(`SELECT COUNT(*) AS count FROM agent_tool_assignments`).get()).toEqual({ count: 0 });
  });

  it('seeds explore_codebase as a Python script tool through explicit provisioning', () => {
    createMinimalAgentsTable();

    provisionDefaultToolRegistry();

    const tool = getDb().prepare(`
      SELECT slug, implementation_type, implementation_body, input_schema
      FROM tools
      WHERE slug = 'explore_codebase'
    `).get() as any;

    expect(tool).toMatchObject({
      slug: 'explore_codebase',
      implementation_type: 'script',
    });

    const body = JSON.parse(tool.implementation_body);
    expect(body.command).toBe('python3');
    expect(body.inline).toContain("os.environ.get('TOOL_INPUT'");
    expect(body.inline).toContain("'TOOL_FOCUS'");
    expect(body.inline).toContain('def find_relevant_patterns');
    expect(JSON.parse(tool.input_schema)).toMatchObject({
      type: 'object',
      properties: {
        focus: { type: 'string' },
        depth: { type: 'number' },
      },
    });
  });

  it('seeds the local STT transcription tool and assigns it to Atlas through explicit provisioning', () => {
    createMinimalAgentsTable();
    getDb().exec(`
      ALTER TABLE agents ADD COLUMN openclaw_agent_id TEXT;
      INSERT INTO agents (id, name, openclaw_agent_id) VALUES (1, 'Atlas', 'atlas');
    `);

    provisionDefaultToolRegistry();

    const tool = getDb().prepare(`SELECT slug, implementation_type, permissions, input_schema, tags FROM tools WHERE slug = 'local_stt_transcribe'`).get() as any;
    expect(tool).toMatchObject({
      slug: 'local_stt_transcribe',
      implementation_type: 'bash',
      permissions: 'exec',
    });
    expect(JSON.parse(tool.input_schema)).toMatchObject({
      type: 'object',
      required: ['audio_path'],
    });
    expect(JSON.parse(tool.tags)).toEqual(expect.arrayContaining(['audio', 'speech_to_text', 'telegram', 'local']));

    const assignment = getDb().prepare(`
      SELECT ata.agent_id, t.slug
      FROM agent_tool_assignments ata
      JOIN tools t ON t.id = ata.tool_id
      WHERE ata.agent_id = 1 AND t.slug = 'local_stt_transcribe'
    `).get();
    expect(assignment).toEqual({ agent_id: 1, slug: 'local_stt_transcribe' });
  });


  it('is a no-op on the current tools schema', () => {
    createMinimalAgentsTable();

    provisionDefaultToolRegistry();
    const firstSql = toolsTableSql();

    expect(() => ensureToolRegistryTables()).not.toThrow();
    expect(toolsTableSql()).toEqual(firstSql);
  });

  it('does not overwrite custom tool edits on schema restart', () => {
    createMinimalAgentsTable();
    provisionDefaultToolRegistry();
    getDb().prepare(`
      UPDATE tools
      SET name = 'Custom Bash', description = 'customized locally', enabled = 0, updated_at = '2026-01-01 00:00:00'
      WHERE slug = 'bash'
    `).run();

    ensureToolRegistryTables();

    expect(getDb().prepare(`SELECT name, description, enabled, updated_at FROM tools WHERE slug = 'bash'`).get()).toEqual({
      name: 'Custom Bash',
      description: 'customized locally',
      enabled: 0,
      updated_at: '2026-01-01 00:00:00',
    });
  });
});

describe('skills registry schema startup', () => {
  beforeEach(resetDb);
  afterEach(resetDb);

  it('rebuilds legacy skills with tenant-local uniqueness and tenant cascade ownership', () => {
    getDb().exec(`
      CREATE TABLE skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'atlas',
        fs_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO skills (id, name, description, content)
      VALUES (10, 'shared-skill', 'legacy default skill', '# default');
    `);

    initSchema();

    const skillsSql = (getDb().prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'skills'`).get() as { sql: string }).sql;
    expect(skillsSql).toContain('UNIQUE(tenant_id, name)');
    expect(getDb().prepare(`PRAGMA foreign_key_list(skills)`).all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'tenant_id', table: 'tenants', on_delete: 'CASCADE' }),
    ]));

    const defaultTenantId = (getDb().prepare(`SELECT id FROM tenants WHERE is_default = 1`).get() as { id: number }).id;
    expect(getDb().prepare(`SELECT id, tenant_id, name FROM skills WHERE id = 10`).get()).toEqual({
      id: 10,
      tenant_id: defaultTenantId,
      name: 'shared-skill',
    });

    const otherTenantId = Number(getDb().prepare(`
      INSERT INTO tenants (name, slug, is_default)
      VALUES ('Acme', 'acme', 0)
    `).run().lastInsertRowid);
    expect(() => getDb().prepare(`
      INSERT INTO skills (tenant_id, name, description, content)
      VALUES (?, 'shared-skill', 'tenant skill', '# tenant')
    `).run(otherTenantId)).not.toThrow();

    getDb().pragma('foreign_keys = ON');
    getDb().prepare(`DELETE FROM tenants WHERE id = ?`).run(otherTenantId);
    expect(getDb().prepare(`SELECT name FROM skills WHERE tenant_id = ?`).all(otherTenantId)).toEqual([]);
    expect(getDb().prepare(`SELECT name FROM skills WHERE tenant_id = ?`).all(defaultTenantId)).toEqual([
      { name: 'shared-skill' },
    ]);
  });
});

describe('MCP registry schema startup', () => {
  beforeEach(resetDb);
  afterEach(resetDb);

  it('seeds the default tenant-local Agent HQ MCP server during schema startup without assignments', () => {
    initSchema();

    expect(getDb().prepare(`SELECT slug, enabled FROM mcp_servers WHERE slug = 'agent-hq'`).get()).toEqual({
      slug: 'agent-hq',
      enabled: 1,
    });
    // Assignments are only created through explicit provisioning, not schema startup.
    expect(getDb().prepare(`SELECT COUNT(*) AS count FROM agent_mcp_assignments`).get()).toEqual({ count: 0 });
  });

  it('assigns the default agent-hq MCP server to the Atlas system agent through explicit provisioning', () => {
    initSchema();

    provisionDefaultMcpRegistry();

    expect(getDb().prepare(`SELECT slug, enabled FROM mcp_servers WHERE slug = 'agent-hq'`).get()).toEqual({
      slug: 'agent-hq',
      enabled: 1,
    });
    expect(getDb().prepare(`
      SELECT a.system_role, ama.enabled
      FROM agent_mcp_assignments ama
      JOIN agents a ON a.id = ama.agent_id
      JOIN mcp_servers s ON s.id = ama.mcp_server_id
      WHERE s.slug = 'agent-hq'
    `).all()).toEqual([{ system_role: 'atlas', enabled: 1 }]);
    expect(getDb().prepare(`SELECT COUNT(*) AS count FROM agent_mcp_assignments`).get()).toEqual({ count: 1 });
  });

  it('does not overwrite custom MCP registry edits on schema restart', () => {
    initSchema();
    provisionDefaultMcpRegistry();
    getDb().prepare(`
      UPDATE mcp_servers
      SET name = 'Custom Agent HQ MCP', command = '/custom/node', enabled = 0, updated_at = '2026-01-01 00:00:00'
      WHERE slug = 'agent-hq'
    `).run();

    initSchema();

    expect(getDb().prepare(`SELECT name, command, enabled, updated_at FROM mcp_servers WHERE slug = 'agent-hq'`).get()).toEqual({
      name: 'Custom Agent HQ MCP',
      command: '/custom/node',
      enabled: 0,
      updated_at: '2026-01-01 00:00:00',
    });
  });
});
