import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { closeDb, getDb, getDbPath } from './client';
import { initSchema } from './schema';
import { SqliteAdapter } from "./adapter/SqliteAdapter";

describe('routing_config scoped ownership schema migration', () => {
  const originalDbPath = process.env.AGENT_HQ_DB_PATH;
  let tempDir: string;

  beforeEach(() => {
    closeDb();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-config-scope-'));
    process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
  });

  afterEach(() => {
    closeDb();
    if (originalDbPath == null) delete process.env.AGENT_HQ_DB_PATH;
    else process.env.AGENT_HQ_DB_PATH = originalDbPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('disables legacy null-scoped routing_config rows without disabling project-scoped rows', async () => {
    const db = getDb();
    await db.exec(`
      CREATE TABLE routing_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        from_status TEXT NOT NULL,
        outcome TEXT NOT NULL,
        to_status TEXT NOT NULL,
        lane TEXT NOT NULL DEFAULT 'default',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    await db.run(`
      INSERT INTO routing_config (project_id, from_status, outcome, to_status, lane, enabled)
      VALUES (NULL, 'in_progress', 'custom_global', 'review', 'default', 1)
    `);
    await db.run(`
      INSERT INTO routing_config (project_id, from_status, outcome, to_status, lane, enabled)
      VALUES (1, 'in_progress', 'custom_project', 'review', 'default', 1)
    `);

    await initSchema();

    expect(await db.get(`
      SELECT COUNT(*) AS count FROM routing_config WHERE project_id IS NULL AND enabled = 1
    `)).toEqual({ count: 0 });
    expect(await db.get(`
      SELECT enabled FROM routing_config WHERE project_id = 1 AND outcome = 'custom_project'
    `)).toEqual({ enabled: 1 });
    const columns = await db.all(`PRAGMA table_info(routing_config)`) as Array<{ name: string }>;
    expect(columns.some((column) => column.name === 'lane')).toBe(false);
  });

  it('drops legacy transition lane columns without dropping non-default transition rows', async () => {
    const db = getDb();
    await db.exec(`
      CREATE TABLE sprint_task_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sprint_id INTEGER,
        task_type TEXT,
        from_status TEXT NOT NULL,
        outcome TEXT NOT NULL,
        to_status TEXT NOT NULL,
        lane TEXT NOT NULL DEFAULT 'default',
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        is_protected INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, lane, enabled, priority)
      VALUES (NULL, 'backend', 'in_progress', 'completed_for_review', 'review', 'implementation', 1, 10);

      CREATE TABLE lifecycle_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_type TEXT,
        from_status TEXT NOT NULL,
        outcome TEXT NOT NULL,
        to_status TEXT NOT NULL,
        lane TEXT NOT NULL DEFAULT 'default',
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO lifecycle_rules (task_type, from_status, outcome, to_status, lane, enabled, priority)
      VALUES ('backend', 'review', 'qa_pass', 'ready_to_merge', 'review', 1, 5);
    `);

    await initSchema();

    const transitionColumns = await db.all(`PRAGMA table_info(sprint_task_transitions)`) as Array<{ name: string }>;
    expect(transitionColumns.some((column) => column.name === 'lane')).toBe(false);
    expect(await db.get(`
      SELECT task_type, from_status, outcome, to_status, enabled, priority
      FROM sprint_task_transitions
      WHERE outcome = 'completed_for_review'
    `)).toEqual({
      task_type: 'backend',
      from_status: 'in_progress',
      outcome: 'completed_for_review',
      to_status: 'review',
      enabled: 1,
      priority: 10,
    });

    const lifecycleColumns = await db.all(`PRAGMA table_info(lifecycle_rules)`) as Array<{ name: string }>;
    expect(lifecycleColumns.some((column) => column.name === 'lane')).toBe(false);
    expect(await db.get(`
      SELECT task_type, from_status, outcome, to_status, enabled, priority
      FROM lifecycle_rules
      WHERE outcome = 'qa_pass'
    `)).toEqual({
      task_type: 'backend',
      from_status: 'review',
      outcome: 'qa_pass',
      to_status: 'ready_to_merge',
      enabled: 1,
      priority: 5,
    });
  });

  it('migrates legacy sprint_task_transition_requirements before creating scope indexes', async () => {
    const db = getDb();
    await db.exec(`
      CREATE TABLE task_statuses (
        name TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT 'slate',
        terminal INTEGER NOT NULL DEFAULT 0,
        is_system INTEGER NOT NULL DEFAULT 0,
        allowed_transitions TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE sprint_types (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        is_system INTEGER NOT NULL DEFAULT 0,
        status_seeded_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE sprints (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        sprint_type TEXT NOT NULL,
        workflow_template_key TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        length_kind TEXT NOT NULL DEFAULT 'time',
        length_value TEXT NOT NULL DEFAULT '',
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE sprint_task_transition_requirements (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        sprint_id        INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
        task_type        TEXT,
        outcome          TEXT NOT NULL,
        field_name       TEXT NOT NULL,
        requirement_type TEXT NOT NULL DEFAULT 'required',
        match_field      TEXT,
        severity         TEXT NOT NULL DEFAULT 'block',
        message          TEXT NOT NULL DEFAULT '',
        enabled          INTEGER NOT NULL DEFAULT 1,
        priority         INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    await db.run(`INSERT INTO task_statuses (name, label) VALUES ('ready', 'Ready')`);
    await db.run(`INSERT INTO projects (id, name) VALUES (1, 'Agent HQ')`);
    await db.run(`INSERT INTO sprint_types (key, name) VALUES ('dev', 'Development')`);
    await db.run(`INSERT INTO sprints (id, project_id, name, sprint_type) VALUES (56, 1, 'Bugs', 'dev')`);
    await db.run(`
      INSERT INTO sprint_task_transition_requirements (sprint_id, task_type, outcome, field_name, requirement_type, severity, message, enabled, priority)
      VALUES (56, 'backend', 'completed_for_review', 'review_commit', 'required', 'block', 'Commit required', 1, 0)
    `);

    expect(async () => await initSchema()).not.toThrow();

    const ddl = await db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sprint_task_transition_requirements'`) as { sql: string };
    expect(/sprint_id\s+INTEGER\s+NOT\s+NULL/i.test(ddl.sql)).toBe(false);
    const row = await db.get(`
      SELECT sprint_id, project_id, sprint_type, task_type, outcome, field_name
      FROM sprint_task_transition_requirements
      LIMIT 1
    `);
    expect(row).toEqual({
      sprint_id: 56,
      project_id: 1,
      sprint_type: 'dev',
      task_type: 'backend',
      outcome: 'completed_for_review',
      field_name: 'review_commit',
    });
    const indexRow = await db.get(`
      SELECT name FROM sqlite_master
      WHERE type='index' AND name='idx_sprint_task_transition_requirements_scope_lookup'
    `);
    expect(indexRow).toEqual({ name: 'idx_sprint_task_transition_requirements_scope_lookup' });
  });

  it('migrates legacy sprint_task_routing_rules tables that still declare sprint_id NOT NULL in appended-column SQLite DDL', async () => {
    const db = getDb();
    await db.exec(`
      CREATE TABLE task_statuses (
        name TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT 'slate',
        terminal INTEGER NOT NULL DEFAULT 0,
        is_system INTEGER NOT NULL DEFAULT 0,
        allowed_transitions TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE sprint_types (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        is_system INTEGER NOT NULL DEFAULT 0,
        status_seeded_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE sprints (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        sprint_type TEXT NOT NULL,
        workflow_template_key TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        length_kind TEXT NOT NULL DEFAULT 'time',
        length_value TEXT NOT NULL DEFAULT '',
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        job_title TEXT,
        project_id INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE sprint_task_routing_rules (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        sprint_id   INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
        task_type   TEXT NOT NULL,
        status      TEXT NOT NULL,
        agent_id    INTEGER REFERENCES agents(id) ON DELETE SET NULL,
        priority    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      ALTER TABLE sprint_task_routing_rules ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sprint_task_routing_rules ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE;
      ALTER TABLE sprint_task_routing_rules ADD COLUMN sprint_type TEXT REFERENCES sprint_types(key) ON DELETE CASCADE;
    `);
    await db.run(`INSERT INTO task_statuses (name, label) VALUES ('todo', 'To Do')`);
    await db.run(`INSERT INTO projects (id, name) VALUES (1, 'Agent HQ')`);
    await db.run(`INSERT INTO sprint_types (key, name) VALUES ('dev', 'Development')`);
    await db.run(`INSERT INTO sprints (id, project_id, name, sprint_type) VALUES (56, 1, 'Bugs', 'dev')`);
    await db.run(`INSERT INTO agents (id, name) VALUES (94, 'Cinder')`);
    await db.run(`
      INSERT INTO sprint_task_routing_rules (sprint_id, task_type, status, agent_id, priority, is_system, project_id, sprint_type)
      VALUES (56, 'backend', 'todo', 94, 0, 0, 1, 'dev')
    `);

    await db.close();
    closeDb();

    const migratedDbRaw = new Database(getDbPath());
    const migratedDb = new SqliteAdapter(migratedDbRaw);
    migratedDbRaw.pragma('foreign_keys = ON');
    const ddlBefore = await migratedDb.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sprint_task_routing_rules'`) as { sql: string };
    expect(/sprint_id\s+INTEGER\s+NOT\s+NULL/i.test(ddlBefore.sql)).toBe(true);

    const needsMigration = /sprint_id\s+INTEGER\s+NOT\s+NULL/i.test(ddlBefore.sql);
    if (needsMigration) {
      await migratedDb.exec(`
        BEGIN TRANSACTION;
        CREATE TABLE sprint_task_routing_rules__new (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          sprint_id   INTEGER REFERENCES sprints(id) ON DELETE CASCADE,
          project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
          sprint_type TEXT REFERENCES sprint_types(key) ON DELETE CASCADE,
          task_type   TEXT NOT NULL,
          status      TEXT NOT NULL,
          agent_id    INTEGER REFERENCES agents(id) ON DELETE SET NULL,
          priority    INTEGER NOT NULL DEFAULT 0,
          is_system   INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO sprint_task_routing_rules__new (id, sprint_id, project_id, sprint_type, task_type, status, agent_id, priority, is_system, created_at, updated_at)
        SELECT id, sprint_id, project_id, sprint_type, task_type, status, agent_id, priority, COALESCE(is_system, 0), created_at, updated_at
        FROM sprint_task_routing_rules;
        DROP TABLE sprint_task_routing_rules;
        ALTER TABLE sprint_task_routing_rules__new RENAME TO sprint_task_routing_rules;
        COMMIT;
      `);
    }

    const ddl = await migratedDb.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sprint_task_routing_rules'`) as { sql: string };
    expect(/sprint_id\s+INTEGER\s+NOT\s+NULL/i.test(ddl.sql)).toBe(false);
    const row = await migratedDb.get(`
      SELECT sprint_id, project_id, sprint_type, task_type, status, agent_id
      FROM sprint_task_routing_rules
      LIMIT 1
    `);
    expect(row).toEqual({
      sprint_id: 56,
      project_id: 1,
      sprint_type: 'dev',
      task_type: 'backend',
      status: 'todo',
      agent_id: 94,
    });
    migratedDbRaw.close();
  });

  it('allows multiple routing candidates per scope while preserving exact candidate uniqueness', async () => {
    const db = getDb();
    await initSchema();

    await db.run(`INSERT OR IGNORE INTO projects (id, name) VALUES (86, 'Agent HQ')`);
    await db.run(`INSERT OR IGNORE INTO sprint_types (key, name) VALUES ('dev', 'Development')`);
    await db.run(`INSERT OR IGNORE INTO sprints (id, project_id, name, sprint_type) VALUES (57, 86, 'Enhancements', 'dev')`);
    await db.run(`
      INSERT INTO agents (id, name, role, session_key, job_title, project_id, enabled)
      VALUES (94, 'Cinder', 'backend', 'agent:cinder:test', 'Backend Engineer', 86, 1)
      ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, enabled = excluded.enabled
    `);
    await db.run(`
      INSERT INTO agents (id, name, role, session_key, job_title, project_id, enabled)
      VALUES (108, 'Vulcan', 'backend', 'agent:vulcan:test', 'Backend Engineer', 86, 1)
      ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, enabled = excluded.enabled
    `);

    const oldIndex = await db.get(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_sprint_task_routing_rules_scope_unique'
    `);
    expect(oldIndex).toBeUndefined();
    const candidateIndex = await db.get(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_sprint_task_routing_rules_candidate_unique'
    `);
    expect(candidateIndex).toEqual({ name: 'idx_sprint_task_routing_rules_candidate_unique' });

    await db.run(`
      INSERT INTO sprint_task_routing_rules (project_id, sprint_type, sprint_id, task_type, status, agent_id, priority)
      VALUES (86, 'dev', NULL, 'backend', 'ready', 94, 0)
    `);
    expect(async () => await db.run(`
      INSERT INTO sprint_task_routing_rules (project_id, sprint_type, sprint_id, task_type, status, agent_id, priority)
      VALUES (86, 'dev', NULL, 'backend', 'ready', 108, -10)
    `)).not.toThrow();
    expect(async () => await db.run(`
      INSERT INTO sprint_task_routing_rules (project_id, sprint_type, sprint_id, task_type, status, agent_id, priority)
      VALUES (86, 'dev', NULL, 'backend', 'ready', 94, 0)
    `)).toThrow(/UNIQUE constraint failed|constraint/i);
  });

  it('removes routing rules whose task_type is not allowed by the sprint type catalog', async () => {
    const db = getDb();
    await initSchema();

    await db.run(`INSERT OR IGNORE INTO projects (id, name) VALUES (86, 'Agent HQ')`);
    await db.run(`
      INSERT INTO agents (id, name, role, session_key, job_title, project_id, enabled)
      VALUES (94, 'Cinder', 'backend', 'agent:cinder:cleanup-test', 'Backend Engineer', 86, 1)
      ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, enabled = excluded.enabled
    `);
    await db.run(`INSERT OR IGNORE INTO sprints (id, project_id, name, sprint_type) VALUES (86, 86, 'Runtime', 'dev')`);
    await db.run(`INSERT OR IGNORE INTO sprint_type_task_types (sprint_type_key, task_type) VALUES ('dev', 'backend')`);
    await db.run(`
      INSERT INTO sprint_task_routing_rules (project_id, sprint_type, sprint_id, task_type, status, agent_id, priority)
      VALUES
        (86, 'dev', 86, 'backend', 'ready', 94, 0),
        (86, 'dev', 86, 'adhoc', 'ready', 94, 0),
        (86, 'dev', 86, NULL, 'ready', 94, -10),
        (86, 'dev', NULL, 'other', 'ready', 94, 0)
    `);

    await initSchema();

    const rows = await db.all(`
      SELECT sprint_id, task_type, status
      FROM sprint_task_routing_rules
      WHERE project_id = 86 AND sprint_type = 'dev'
      ORDER BY sprint_id IS NULL ASC, task_type IS NULL ASC, task_type ASC
    `);
    expect(rows).toEqual([
      { sprint_id: 86, task_type: 'backend', status: 'ready' },
      { sprint_id: 86, task_type: null, status: 'ready' },
    ]);
  });
});
