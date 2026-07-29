import { closeDb, getDb, getRawDb } from './client';
import { initSchema, ensureToolRegistryTables, provisionDefaultMcpRegistry, provisionDefaultToolRegistry } from './schema';

function resetDb(): void {
  closeDb();
}

async function createMinimalAgentsTable(): Promise<void> {
  await getDb().exec(`
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );
  `);
}

async function toolsTableSql(): Promise<string> {
  return (await getDb().get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tools'`) as { sql: string }).sql;
}

describe('ensureToolRegistryTables', () => {
  beforeEach(resetDb);
  afterEach(resetDb);

  it('bootstraps cleanly when the tools table does not exist', async () => {
    await createMinimalAgentsTable();

    expect(() => ensureToolRegistryTables()).not.toThrow();

    expect(await toolsTableSql()).toContain("'shell'");
    expect(await toolsTableSql()).toContain("'script'");
    expect(await getDb().get(`SELECT COUNT(*) AS count FROM tools`)).toMatchObject({ count: expect.any(Number) });
  });

  it('migrates a legacy tools table shape without referencing a stale legacy table', async () => {
    await createMinimalAgentsTable();
    await getDb().exec(`
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

    expect(await toolsTableSql()).toContain("'shell'");
    expect(await toolsTableSql()).toContain("'script'");
    expect(await getDb().get(`SELECT name, slug, implementation_type FROM tools WHERE slug = 'legacy_bash'`)).toEqual({
      name: 'Legacy Bash',
      slug: 'legacy_bash',
      implementation_type: 'bash',
    });
    expect(await getDb().get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tools_legacy_capability_exec'`)).toBeUndefined();
  });

  it('replaces legacy global tool slug uniqueness with tenant-local slug uniqueness', async () => {
    await createMinimalAgentsTable();
    await getDb().exec(`
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

    expect(await toolsTableSql()).toContain('tenant_id');
    expect(await toolsTableSql()).toContain('UNIQUE(tenant_id, slug)');
    expect(await getDb().get(`SELECT tenant_id, slug FROM tools WHERE id = 10`)).toEqual({ tenant_id: 7, slug: 'bash' });
    await (async () => await getDb().run(`
      INSERT INTO tools (tenant_id, name, slug, implementation_type, implementation_body)
      VALUES (8, 'Tenant Bash', 'bash', 'bash', 'echo tenant')
    `))();
    // Asserted on the rejection VALUE, not .rejects.toThrow(). better-sqlite3 is a native
    // addon: a SqliteError raised from the SECOND test file loaded in a jest worker fails
    // `instanceof Error`, because the addon keeps the constructor registered by the FIRST
    // module-registry load. jest's toThrow only inspects the rejection once it classifies it
    // as an Error, so otherwise it reports "did not throw" despite a correct rejection —
    // making the assertion depend on file order. Matching the message is realm-independent.
    await expect((async () => await getDb().run(`
      INSERT INTO tools (tenant_id, name, slug, implementation_type, implementation_body)
      VALUES (8, 'Duplicate Tenant Bash', 'bash', 'bash', 'echo duplicate')
    `))()).rejects.toMatchObject({ message: expect.stringContaining('UNIQUE constraint failed') });
  });

  it('removes stale cross-tenant tool assignments during registry repair', async () => {
    await getDb().exec(`
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

    expect(await getDb().all(`SELECT id, agent_id, tool_id FROM agent_tool_assignments ORDER BY id ASC`)).toEqual([
      { id: 100, agent_id: 1, tool_id: 10 },
      { id: 102, agent_id: 2, tool_id: 20 },
    ]);
  });

  it('repairs assignment foreign keys after a tools table rebuild and then removes stale cross-tenant assignments', async () => {
    await getDb().exec(`
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

    const assignmentSql = (await getDb().get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_tool_assignments'`) as { sql: string }).sql;
    expect(assignmentSql).toContain('REFERENCES tools(id)');
    expect(assignmentSql).not.toContain('tools_rebuild_');
    expect(await getDb().all(`PRAGMA foreign_key_list(agent_tool_assignments)`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'tool_id', table: 'tools' }),
    ]));
    expect(await getDb().all(`SELECT id, agent_id, tool_id FROM agent_tool_assignments ORDER BY id ASC`)).toEqual([
      { id: 100, agent_id: 1, tool_id: 10 },
      { id: 102, agent_id: 2, tool_id: 20 },
    ]);
  });

  it('repairs assignment tables left pointing at the stale legacy tools table', async () => {
    await createMinimalAgentsTable();
    getRawDb().pragma('foreign_keys = OFF');
    await getDb().exec(`
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
    getRawDb().pragma('foreign_keys = ON');

    expect(() => ensureToolRegistryTables()).not.toThrow();

    const assignmentSql = (await getDb().get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_tool_assignments'`) as { sql: string }).sql;
    expect(assignmentSql).toContain('REFERENCES tools(id)');
    expect(await getDb().get(`SELECT agent_id, tool_id FROM agent_tool_assignments WHERE agent_id = 1`)).toEqual({
      agent_id: 1,
      tool_id: 10,
    });
  });

  it('does not seed tool registry defaults during schema startup', async () => {
    await createMinimalAgentsTable();

    ensureToolRegistryTables();

    expect(await getDb().get(`SELECT COUNT(*) AS count FROM tools`)).toEqual({ count: 0 });
    expect(await getDb().get(`SELECT COUNT(*) AS count FROM agent_tool_assignments`)).toEqual({ count: 0 });
  });

  it('seeds explore_codebase as a Python script tool through explicit provisioning', async () => {
    await createMinimalAgentsTable();

    provisionDefaultToolRegistry();

    const tool = await getDb().get(`
      SELECT slug, implementation_type, implementation_body, input_schema
      FROM tools
      WHERE slug = 'explore_codebase'
    `) as any;

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

  it('seeds the local STT transcription tool and assigns it to Atlas through explicit provisioning', async () => {
    await createMinimalAgentsTable();
    await getDb().exec(`
      ALTER TABLE agents ADD COLUMN openclaw_agent_id TEXT;
      INSERT INTO agents (id, name, openclaw_agent_id) VALUES (1, 'Atlas', 'atlas');
    `);

    provisionDefaultToolRegistry();

    const tool = await getDb().get(`SELECT slug, implementation_type, permissions, input_schema, tags FROM tools WHERE slug = 'local_stt_transcribe'`) as any;
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

    const assignment = await getDb().get(`
      SELECT ata.agent_id, t.slug
      FROM agent_tool_assignments ata
      JOIN tools t ON t.id = ata.tool_id
      WHERE ata.agent_id = 1 AND t.slug = 'local_stt_transcribe'
    `);
    expect(assignment).toEqual({ agent_id: 1, slug: 'local_stt_transcribe' });
  });


  it('is a no-op on the current tools schema', async () => {
    await createMinimalAgentsTable();

    provisionDefaultToolRegistry();
    const firstSql = await toolsTableSql();

    expect(() => ensureToolRegistryTables()).not.toThrow();
    expect(await toolsTableSql()).toEqual(firstSql);
  });

  it('does not overwrite custom tool edits on schema restart', async () => {
    await createMinimalAgentsTable();
    provisionDefaultToolRegistry();
    await getDb().run(`
      UPDATE tools
      SET name = 'Custom Bash', description = 'customized locally', enabled = 0, updated_at = '2026-01-01 00:00:00'
      WHERE slug = 'bash'
    `);

    ensureToolRegistryTables();

    expect(await getDb().get(`SELECT name, description, enabled, updated_at FROM tools WHERE slug = 'bash'`)).toEqual({
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

  it('rebuilds legacy skills with tenant-local uniqueness and tenant cascade ownership', async () => {
    await getDb().exec(`
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

    await initSchema();

    const skillsSql = (await getDb().get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'skills'`) as { sql: string }).sql;
    expect(skillsSql).toContain('UNIQUE(tenant_id, name)');
    expect(await getDb().all(`PRAGMA foreign_key_list(skills)`)).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'tenant_id', table: 'tenants', on_delete: 'CASCADE' }),
    ]));

    const defaultTenantId = (await getDb().get(`SELECT id FROM tenants WHERE is_default = 1`) as { id: number }).id;
    expect(await getDb().get(`SELECT id, tenant_id, name FROM skills WHERE id = 10`)).toEqual({
      id: 10,
      tenant_id: defaultTenantId,
      name: 'shared-skill',
    });

    const otherTenantId = Number((await getDb().run(`
      INSERT INTO tenants (name, slug, is_default)
      VALUES ('Acme', 'acme', 0)
    `)).lastInsertId);
    await (async () => await getDb().run(`
      INSERT INTO skills (tenant_id, name, description, content)
      VALUES (?, 'shared-skill', 'tenant skill', '# tenant')
    `, otherTenantId))();

    getRawDb().pragma('foreign_keys = ON');
    await getDb().run(`DELETE FROM tenants WHERE id = ?`, otherTenantId);
    expect(await getDb().all(`SELECT name FROM skills WHERE tenant_id = ?`, otherTenantId)).toEqual([]);
    expect(await getDb().all(`SELECT name FROM skills WHERE tenant_id = ?`, defaultTenantId)).toEqual([
      { name: 'shared-skill' },
    ]);
  });
});

describe('MCP registry schema startup', () => {
  beforeEach(resetDb);
  afterEach(resetDb);

  it('seeds the default tenant-local Agent HQ MCP server during schema startup without assignments', async () => {
    await initSchema();

    expect(await getDb().get(`SELECT slug, enabled FROM mcp_servers WHERE slug = 'agent-hq'`)).toEqual({
      slug: 'agent-hq',
      enabled: 1,
    });
    // Assignments are only created through explicit provisioning, not schema startup.
    expect(await getDb().get(`SELECT COUNT(*) AS count FROM agent_mcp_assignments`)).toEqual({ count: 0 });
  });

  it('assigns the default agent-hq MCP server to the Atlas system agent through explicit provisioning', async () => {
    await initSchema();

    await provisionDefaultMcpRegistry();

    expect(await getDb().get(`SELECT slug, enabled FROM mcp_servers WHERE slug = 'agent-hq'`)).toEqual({
      slug: 'agent-hq',
      enabled: 1,
    });
    expect(await getDb().all(`
      SELECT a.system_role, ama.enabled
      FROM agent_mcp_assignments ama
      JOIN agents a ON a.id = ama.agent_id
      JOIN mcp_servers s ON s.id = ama.mcp_server_id
      WHERE s.slug = 'agent-hq'
    `)).toEqual([{ system_role: 'atlas', enabled: 1 }]);
    expect(await getDb().get(`SELECT COUNT(*) AS count FROM agent_mcp_assignments`)).toEqual({ count: 1 });
  });

  it('does not overwrite custom MCP registry edits on schema restart', async () => {
    await initSchema();
    await provisionDefaultMcpRegistry();
    await getDb().run(`
      UPDATE mcp_servers
      SET name = 'Custom Agent HQ MCP', command = '/custom/node', enabled = 0, updated_at = '2026-01-01 00:00:00'
      WHERE slug = 'agent-hq'
    `);

    await initSchema();

    expect(await getDb().get(`SELECT name, command, enabled, updated_at FROM mcp_servers WHERE slug = 'agent-hq'`)).toEqual({
      name: 'Custom Agent HQ MCP',
      command: '/custom/node',
      enabled: 0,
      updated_at: '2026-01-01 00:00:00',
    });
  });
});
