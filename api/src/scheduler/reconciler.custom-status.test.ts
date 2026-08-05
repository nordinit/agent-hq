import Database from 'better-sqlite3';
import { reconcileReviewQaRouting } from './reconciler';
import { type Db } from "../db/adapter/types";
import { SqliteAdapter } from "../db/adapter/SqliteAdapter";

jest.mock('../runtimes', () => ({
  resolveRuntime: jest.fn(() => ({
    dispatch: jest.fn(async () => ({ runId: 'run-test' })),
    abort: jest.fn(async () => undefined),
  })),
}));

jest.mock('../runtimes/skillMaterialization', () => ({
  getSkillMaterializationAdapter: jest.fn(() => ({
    adapterName: 'test',
    materialize: jest.fn(() => ({ ok: true, count: 0, details: [], warnings: [] })),
  })),
}));

jest.mock('../runtimes/mcpMaterialization', () => ({
  syncAssignedMcpForAgent: jest.fn(() => ({ ok: true, count: 0, warnings: [] })),
}));

jest.mock('../lib/githubIdentity', () => ({
  resolveGitHubIdentity: jest.fn(() => null),
  injectGitHubCredentials: jest.fn(),
  cleanupGitHubCredentials: jest.fn(),
  buildGitHubIdentityContext: jest.fn(() => ''),
}));

async function setupDb(): Promise<Db> {
  const dbRaw = new Database(':memory:');
    const db = new SqliteAdapter(dbRaw);
  await db.exec(`
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT,
      job_title TEXT,
      job_instructions TEXT,
      enabled INTEGER,
      timeout_seconds INTEGER,
      session_key TEXT,
      runtime_type TEXT,
      runtime_config TEXT,
      model TEXT,
      preferred_provider TEXT,
      hooks_url TEXT,
      hooks_auth_header TEXT,
      sprint_id INTEGER,
      skill_name TEXT,
      openclaw_agent_id TEXT
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      agent_id INTEGER,
      assigned_agent_id INTEGER,
      review_owner_agent_id INTEGER,
      active_instance_id INTEGER,
      project_id INTEGER,
      tenant_id INTEGER DEFAULT 1,
      sprint_id INTEGER,
      task_type TEXT,
      story_points INTEGER,
      previous_status TEXT,
      paused_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE sprints (
      id INTEGER PRIMARY KEY,
      project_id INTEGER,
      name TEXT,
      goal TEXT,
      sprint_type TEXT,
      status TEXT
    );
    CREATE TABLE sprint_task_routing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER,
      project_id INTEGER,
      sprint_type TEXT,
      task_type TEXT,
      status TEXT NOT NULL,
      agent_id INTEGER,
      priority INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sprint_task_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
      status_key TEXT NOT NULL,
      label TEXT NOT NULL,
      terminal INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sprint_type_task_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key TEXT NOT NULL,
      status_key TEXT NOT NULL,
      label TEXT NOT NULL,
      tenant_id INTEGER,
      terminal INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE task_statuses (
      name TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      terminal INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER,
      task_id INTEGER,
      status TEXT
    );
    CREATE TABLE task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      changed_by TEXT,
      field TEXT,
      old_value TEXT,
      new_value TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER,
      task_id INTEGER,
      agent_id INTEGER,
      job_title TEXT,
      level TEXT,
      message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.run(`INSERT INTO sprints (id, project_id, name, goal, sprint_type, status) VALUES (10, 86, 'Elevation Built', 'Goal', 'dev', 'active')`);
  await db.run(`INSERT INTO agents (id, name, job_title, job_instructions, enabled, timeout_seconds, session_key, runtime_type) VALUES (1, 'Old Agent', 'Old', 'Old', 1, 900, 'agent:old', 'openclaw')`);
  await db.run(`INSERT INTO agents (id, name, job_title, job_instructions, enabled, timeout_seconds, session_key, runtime_type) VALUES (2, 'Addison', 'PM', 'Review', 1, 900, 'agent:addison', 'openclaw')`);
  return db;
}

async function insertTask(db: Db, id: number, status: string): Promise<void> {
  await db.run(`
    INSERT INTO tasks (
      id, title, description, status, priority, agent_id, assigned_agent_id,
      review_owner_agent_id, active_instance_id, project_id, tenant_id, sprint_id, task_type,
      updated_at
    ) VALUES (?, ?, 'Task', ?, 'high', 1, 1, NULL, NULL, 86, 1, 10, 'backend', '2026-06-04T12:00:00.000Z')
  `, id, `Task ${id}`, status);
}

describe('reconciler workflow-defined status routing', () => {
  it('reconciles ownership for a custom status with a matching routing rule', async () => {
    const db = await setupDb();
    await db.run(`
      INSERT INTO sprint_task_routing_rules (sprint_id, project_id, sprint_type, task_type, status, agent_id, priority)
      VALUES (10, 86, 'dev', 'backend', 'intake', 2, 10)
    `);
    await insertTask(db, 797, 'intake');

    await reconcileReviewQaRouting({ dispatchInstance: jest.fn(async () => undefined) }, db);

    const task = await db.get(`SELECT assigned_agent_id FROM tasks WHERE id = 797`) as { assigned_agent_id: number };
    expect(task.assigned_agent_id).toBe(2);
    await db.close();
  });

  it('does not reconcile ownership for workflow terminal custom statuses', async () => {
    const db = await setupDb();
    await db.run(`INSERT INTO sprint_task_statuses (sprint_id, status_key, label, terminal) VALUES (10, 'archived', 'Archived', 1)`);
    await db.run(`
      INSERT INTO sprint_task_routing_rules (sprint_id, project_id, sprint_type, task_type, status, agent_id, priority)
      VALUES (10, 86, 'dev', 'backend', 'archived', 2, 10)
    `);
    await insertTask(db, 798, 'archived');

    await reconcileReviewQaRouting({ dispatchInstance: jest.fn(async () => undefined) }, db);

    const task = await db.get(`SELECT assigned_agent_id FROM tasks WHERE id = 798`) as { assigned_agent_id: number };
    expect(task.assigned_agent_id).toBe(1);
    await db.close();
  });

  it('reconciles ownership for legacy failed when workflow configuration marks it non-terminal', async () => {
    const db = await setupDb();
    await db.run(`INSERT INTO sprint_task_statuses (sprint_id, status_key, label, terminal) VALUES (10, 'failed', 'Failed', 0)`);
    await db.run(`
      INSERT INTO sprint_task_routing_rules (sprint_id, project_id, sprint_type, task_type, status, agent_id, priority)
      VALUES (10, 86, 'dev', 'backend', 'failed', 2, 10)
    `);
    await insertTask(db, 799, 'failed');

    await reconcileReviewQaRouting({ dispatchInstance: jest.fn(async () => undefined) }, db);

    const task = await db.get(`SELECT assigned_agent_id FROM tasks WHERE id = 799`) as { assigned_agent_id: number };
    expect(task.assigned_agent_id).toBe(2);
    await db.close();
  });

  it('uses workflow-specific terminality before sprint-type and global fallbacks', async () => {
    const db = await setupDb();
    await db.run(`INSERT INTO task_statuses (name, label, terminal) VALUES ('failed', 'Failed', 1)`);
    await db.run(`INSERT INTO sprint_type_task_statuses (sprint_type_key, status_key, label, terminal) VALUES ('dev', 'failed', 'Failed', 1)`);
    await db.run(`INSERT INTO sprint_task_statuses (sprint_id, status_key, label, terminal) VALUES (10, 'failed', 'Failed', 0)`);
    await db.run(`
      INSERT INTO sprint_task_routing_rules (sprint_id, project_id, sprint_type, task_type, status, agent_id, priority)
      VALUES (10, 86, 'dev', 'backend', 'failed', 2, 10)
    `);
    await insertTask(db, 800, 'failed');

    await reconcileReviewQaRouting({ dispatchInstance: jest.fn(async () => undefined) }, db);

    const task = await db.get(`SELECT assigned_agent_id FROM tasks WHERE id = 800`) as { assigned_agent_id: number };
    expect(task.assigned_agent_id).toBe(2);
    await db.close();
  });

  it('keeps workflow-specific terminal failed from reconciling before non-terminal fallbacks', async () => {
    const db = await setupDb();
    await db.run(`INSERT INTO task_statuses (name, label, terminal) VALUES ('failed', 'Failed', 0)`);
    await db.run(`INSERT INTO sprint_type_task_statuses (sprint_type_key, status_key, label, terminal) VALUES ('dev', 'failed', 'Failed', 0)`);
    await db.run(`INSERT INTO sprint_task_statuses (sprint_id, status_key, label, terminal) VALUES (10, 'failed', 'Failed', 1)`);
    await db.run(`
      INSERT INTO sprint_task_routing_rules (sprint_id, project_id, sprint_type, task_type, status, agent_id, priority)
      VALUES (10, 86, 'dev', 'backend', 'failed', 2, 10)
    `);
    await insertTask(db, 804, 'failed');

    await reconcileReviewQaRouting({ dispatchInstance: jest.fn(async () => undefined) }, db);

    const task = await db.get(`SELECT assigned_agent_id FROM tasks WHERE id = 804`) as { assigned_agent_id: number };
    expect(task.assigned_agent_id).toBe(1);
    await db.close();
  });

  it('uses tenant-specific sprint-type terminality before default sprint-type fallback', async () => {
    const db = await setupDb();
    await db.run(`
      INSERT INTO sprint_type_task_statuses (sprint_type_key, status_key, label, tenant_id, terminal)
      VALUES
        ('dev', 'failed', 'Failed', NULL, 1),
        ('dev', 'failed', 'Failed', 1, 0)
    `);
    await db.run(`
      INSERT INTO sprint_task_routing_rules (sprint_id, project_id, sprint_type, task_type, status, agent_id, priority)
      VALUES (10, 86, 'dev', 'backend', 'failed', 2, 10)
    `);
    await insertTask(db, 801, 'failed');

    await reconcileReviewQaRouting({ dispatchInstance: jest.fn(async () => undefined) }, db);

    const task = await db.get(`SELECT assigned_agent_id FROM tasks WHERE id = 801`) as { assigned_agent_id: number };
    expect(task.assigned_agent_id).toBe(2);
    await db.close();
  });

  it('keeps configured terminal statuses out of ownership reconciliation', async () => {
    const db = await setupDb();
    // Terminality is configuration only — there is no hardcoded fallback, so
    // every terminal status this asserts on must be configured explicitly.
    await db.run(`INSERT INTO task_statuses (name, label, terminal) VALUES ('done', 'Done', 1)`);
    await db.run(`INSERT INTO task_statuses (name, label, terminal) VALUES ('cancelled', 'Cancelled', 1)`);
    await db.run(`INSERT INTO task_statuses (name, label, terminal) VALUES ('failed', 'Failed', 1)`);
    await db.run(`
      INSERT INTO sprint_task_routing_rules (sprint_id, project_id, sprint_type, task_type, status, agent_id, priority)
      VALUES
        (10, 86, 'dev', 'backend', 'done', 2, 10),
        (10, 86, 'dev', 'backend', 'cancelled', 2, 10),
        (10, 86, 'dev', 'backend', 'failed', 2, 10)
    `);
    await insertTask(db, 801, 'done');
    await insertTask(db, 802, 'cancelled');
    await insertTask(db, 803, 'failed');

    await reconcileReviewQaRouting({ dispatchInstance: jest.fn(async () => undefined) }, db);

    const tasks = await db.all(`SELECT id, assigned_agent_id FROM tasks WHERE id IN (801, 802, 803) ORDER BY id`) as Array<{ id: number; assigned_agent_id: number }>;
    expect(tasks).toEqual([
      { id: 801, assigned_agent_id: 1 },
      { id: 802, assigned_agent_id: 1 },
      { id: 803, assigned_agent_id: 1 },
    ]);
    await db.close();
  });
});
