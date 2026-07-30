import Database from 'better-sqlite3';
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
    materialize: jest.fn(() => ({ ok: true, count: 0, warnings: [] })),
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

const { resolveRuntime } = jest.requireMock('../runtimes') as { resolveRuntime: jest.Mock };

async function setupDb(options: { includeTaskDispatchMetadataColumns?: boolean } = {}): Promise<Db> {
  const includeTaskDispatchMetadataColumns = options.includeTaskDispatchMetadataColumns ?? true;
  const dbRaw = new Database(':memory:');
    const db = new SqliteAdapter(dbRaw);
  await db.exec(`
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT,
      job_title TEXT NOT NULL,
      project_id INTEGER,
      job_instructions TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      timeout_seconds INTEGER NOT NULL,
      model TEXT,
      skill_names TEXT,
      session_key TEXT NOT NULL,
      runtime_type TEXT,
      runtime_config TEXT,
      hooks_url TEXT,
      hooks_auth_header TEXT,
      workspace_path TEXT,
      preferred_provider TEXT,
      repo_path TEXT,
      repo_url TEXT,
      repo_access_mode TEXT,
      os_user TEXT,
      openclaw_agent_id TEXT,
      sort_rules TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      agent_id INTEGER,
      project_id INTEGER,
      tenant_id INTEGER DEFAULT 1,
      task_type TEXT,
      sprint_id INTEGER,
      created_at TEXT NOT NULL,
      story_points INTEGER,
      active_instance_id INTEGER,
      paused_at TEXT,
      dispatched_at TEXT,
      ${includeTaskDispatchMetadataColumns ? 'claimed_at TEXT,' : ''}
      ${includeTaskDispatchMetadataColumns ? 'routing_reason TEXT,' : ''}
      updated_at TEXT
    );
    CREATE TABLE sprints (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, sprint_type TEXT, status TEXT);
    CREATE TABLE sprint_types (key TEXT PRIMARY KEY, repo_required INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sprint_task_routing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER,
      project_id INTEGER,
      sprint_type TEXT,
      task_type TEXT,
      status TEXT NOT NULL,
      agent_id INTEGER NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sprint_task_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id INTEGER NOT NULL,
      status_key TEXT NOT NULL,
      label TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'slate',
      terminal INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      allowed_transitions_json TEXT NOT NULL DEFAULT '[]',
      stage_order INTEGER NOT NULL DEFAULT 0,
      is_default_entry INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE sprint_type_task_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key TEXT NOT NULL,
      status_key TEXT NOT NULL,
      label TEXT NOT NULL,
      tenant_id INTEGER,
      color TEXT NOT NULL DEFAULT 'slate',
      terminal INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      allowed_transitions_json TEXT NOT NULL DEFAULT '[]',
      stage_order INTEGER NOT NULL DEFAULT 0,
      is_default_entry INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE task_statuses (
      name TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'slate',
      terminal INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      allowed_transitions TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE job_instances (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER, task_id INTEGER, status TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, payload_sent TEXT, worktree_path TEXT, session_key TEXT, dispatched_at TEXT, run_id TEXT, response TEXT, error TEXT, completed_at TEXT, effective_model TEXT, effective_thinking_level TEXT);
    CREATE TABLE dispatch_log (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, agent_id INTEGER, routing_reason TEXT, candidate_count INTEGER, candidates_skipped TEXT);
    CREATE TABLE task_dependencies (id INTEGER PRIMARY KEY AUTOINCREMENT, blocker_id INTEGER, blocked_id INTEGER);
    CREATE TABLE task_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, author TEXT, content TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE task_history (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, changed_by TEXT, field TEXT, old_value TEXT, new_value TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id INTEGER, agent_id INTEGER, job_title TEXT, level TEXT, message TEXT);
    CREATE TABLE sprint_type_relationship_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key TEXT NOT NULL,
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      inverse_label TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'informational',
      affects_dispatch_eligibility INTEGER NOT NULL DEFAULT 0,
      direction_semantics TEXT NOT NULL DEFAULT 'informational',
      active_statuses_json TEXT NOT NULL DEFAULT '[]',
      resolved_statuses_json TEXT NOT NULL DEFAULT '[]',
      allow_create_related_task INTEGER NOT NULL DEFAULT 0,
      default_related_task_type TEXT,
      default_related_task_status TEXT,
      is_system INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(sprint_type_key, key)
    );
    CREATE TABLE task_relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_task_id INTEGER NOT NULL,
      target_task_id INTEGER NOT NULL,
      relationship_type_key TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL DEFAULT 'system',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_task_id, target_task_id, relationship_type_key)
    );
  `);

  await db.run(`
    INSERT INTO agents (id, name, job_title, project_id, job_instructions, enabled, timeout_seconds, session_key, runtime_type, sort_rules)
    VALUES (1, 'Cinder', 'Backend Engineer', 86, 'Do the task', 1, 900, 'agent:cinder:main', 'openclaw', '[]')
  `);
  await db.run(`INSERT INTO sprint_types (key, repo_required) VALUES ('dev', 0)`);
  await db.run(`INSERT INTO sprints (id, project_id, name, sprint_type, status) VALUES (10, 86, 'Enhancements', 'dev', 'active')`);
  await db.run(`INSERT INTO sprint_task_routing_rules (sprint_id, project_id, sprint_type, task_type, status, agent_id, priority) VALUES (10, 86, 'dev', 'backend', 'ready', 1, 10)`);
  await db.run(`
    INSERT INTO sprint_type_relationship_types (sprint_type_key, key, label, inverse_label, category, affects_dispatch_eligibility, direction_semantics, resolved_statuses_json)
    VALUES
      ('dev', 'blocked_by', 'Blocked by', 'Blocks', 'dependency', 1, 'target_blocks_source', '["done","cancelled"]'),
      ('dev', 'blocks', 'Blocks', 'Blocked by', 'dependency', 1, 'source_blocks_target', '["done","cancelled"]'),
      ('dev', 'defect_of', 'Defect of', 'Has defect', 'quality', 0, 'informational', '[]')
  `);
  return db;
}

async function insertTask(db: Db, id: number, status = 'ready', taskType = 'backend'): Promise<void> {
  await db.run(`
    INSERT INTO tasks (id, title, description, status, priority, project_id, tenant_id, task_type, sprint_id, created_at, updated_at)
    VALUES (?, ?, 'Task', ?, 'high', 86, 1, ?, 10, '2026-05-20T12:00:00.000Z', '2026-05-20T12:00:00.000Z')
  `, id, `Task ${id}`, status, taskType);
}

describe('dispatcher relationship-driven eligibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps a task ineligible when a blocking relationship points to an unresolved related task', async () => {
    const db = await setupDb();
    const { runDispatcher } = await import('./dispatcher');
    await insertTask(db, 530, 'ready');
    await insertTask(db, 567, 'in_progress', 'frontend');
    await db.run(`INSERT INTO task_relationships (source_task_id, target_task_id, relationship_type_key) VALUES (530, 567, 'blocked_by')`);

    const result = await runDispatcher(db, 86);

    expect(result.dispatched).toBe(0);
    expect(resolveRuntime).not.toHaveBeenCalled();
    const task = await db.get(`SELECT status, active_instance_id FROM tasks WHERE id = 530`) as { status: string; active_instance_id: number | null };
    expect(task.status).toBe('ready');
    expect(task.active_instance_id).toBeNull();
    const history = await db.get(`SELECT new_value FROM task_history WHERE task_id = 530 AND field = 'dispatch_eligibility'`) as { new_value: string };
    expect(history.new_value).toContain('Dispatch ineligible: Blocked by (blocked_by) task #567');
    expect(history.new_value).toContain('is in_progress');
    await db.close();
  });

  it('keeps sprint overrides ahead of higher-priority sprint-type fallback candidates', async () => {
    const db = await setupDb();
    const { runDispatcher } = await import('./dispatcher');
    await db.run(`
      INSERT INTO agents (id, name, job_title, project_id, job_instructions, enabled, timeout_seconds, session_key, runtime_type, sort_rules)
      VALUES (2, 'Vulcan', 'Backend Engineer', 86, 'Do the task', 1, 900, 'agent:vulcan:main', 'openclaw', '[]')
    `);
    await db.run(`
      INSERT INTO sprint_task_routing_rules (sprint_id, project_id, sprint_type, task_type, status, agent_id, priority)
      VALUES (NULL, 86, 'dev', 'backend', 'ready', 2, 100)
    `);
    await insertTask(db, 608, 'ready');

    const result = await runDispatcher(db, 86);

    expect(result.dispatched).toBe(1);
    const task = await db.get(`SELECT status, agent_id, active_instance_id FROM tasks WHERE id = 608`) as { status: string; agent_id: number | null; active_instance_id: number | null };
    expect(task).toEqual({ status: 'ready', agent_id: 1, active_instance_id: 1 });
    await db.close();
  });

  it('dispatches workflow-defined custom statuses when a matching routing rule exists', async () => {
    const db = await setupDb();
    const { runDispatcher } = await import('./dispatcher');
    await db.run(`
      INSERT INTO sprint_task_routing_rules (sprint_id, project_id, sprint_type, task_type, status, agent_id, priority)
      VALUES (10, 86, 'dev', 'backend', 'intake', 1, 10)
    `);
    await insertTask(db, 797, 'intake');

    const result = await runDispatcher(db, 86);

    expect(result.dispatched).toBe(1);
    const task = await db.get(`SELECT status, agent_id, active_instance_id FROM tasks WHERE id = 797`) as { status: string; agent_id: number | null; active_instance_id: number | null };
    expect(task).toEqual({ status: 'intake', agent_id: 1, active_instance_id: 1 });
    await new Promise(resolve => setImmediate(resolve));
    await db.close();
  });

  it('does not dispatch custom statuses without a matching routing rule', async () => {
    const db = await setupDb();
    const { runDispatcher } = await import('./dispatcher');
    await insertTask(db, 798, 'field_reported');

    const result = await runDispatcher(db, 86);

    expect(result.dispatched).toBe(0);
    const task = await db.get(`SELECT status, active_instance_id FROM tasks WHERE id = 798`) as { status: string; active_instance_id: number | null };
    expect(task).toEqual({ status: 'field_reported', active_instance_id: null });
    await db.close();
  });

  it('does not dispatch workflow terminal statuses even when a routing rule exists', async () => {
    const db = await setupDb();
    const { runDispatcher } = await import('./dispatcher');
    await db.run(`
      INSERT INTO sprint_task_statuses (sprint_id, status_key, label, terminal, stage_order)
      VALUES (10, 'archived', 'Archived', 1, 99)
    `);
    await db.run(`
      INSERT INTO sprint_task_routing_rules (sprint_id, project_id, sprint_type, task_type, status, agent_id, priority)
      VALUES (10, 86, 'dev', 'backend', 'archived', 1, 10)
    `);
    await insertTask(db, 799, 'archived');

    const result = await runDispatcher(db, 86);

    expect(result.dispatched).toBe(0);
    const task = await db.get(`SELECT status, active_instance_id FROM tasks WHERE id = 799`) as { status: string; active_instance_id: number | null };
    expect(task).toEqual({ status: 'archived', active_instance_id: null });
    await db.close();
  });

  it('dispatches legacy failed when workflow configuration marks it non-terminal', async () => {
    const db = await setupDb();
    const { runDispatcher } = await import('./dispatcher');
    await db.run(`
      INSERT INTO sprint_task_statuses (sprint_id, status_key, label, terminal, stage_order)
      VALUES (10, 'failed', 'Failed', 0, 80)
    `);
    await db.run(`
      INSERT INTO sprint_task_routing_rules (sprint_id, project_id, sprint_type, task_type, status, agent_id, priority)
      VALUES (10, 86, 'dev', 'backend', 'failed', 1, 10)
    `);
    await insertTask(db, 800, 'failed');

    const result = await runDispatcher(db, 86);

    expect(result.dispatched).toBe(1);
    const task = await db.get(`SELECT status, agent_id, active_instance_id FROM tasks WHERE id = 800`) as { status: string; agent_id: number | null; active_instance_id: number | null };
    expect(task).toEqual({ status: 'failed', agent_id: 1, active_instance_id: 1 });
    await new Promise(resolve => setImmediate(resolve));
    await db.close();
  });

  it('uses workflow-specific terminality before sprint-type and global fallbacks', async () => {
    const db = await setupDb();
    const { runDispatcher } = await import('./dispatcher');
    await db.run(`INSERT INTO task_statuses (name, label, terminal) VALUES ('failed', 'Failed', 1)`);
    await db.run(`INSERT INTO sprint_type_task_statuses (sprint_type_key, status_key, label, terminal) VALUES ('dev', 'failed', 'Failed', 1)`);
    await db.run(`
      INSERT INTO sprint_task_statuses (sprint_id, status_key, label, terminal, stage_order)
      VALUES (10, 'failed', 'Failed', 0, 80)
    `);
    await db.run(`
      INSERT INTO sprint_task_routing_rules (sprint_id, project_id, sprint_type, task_type, status, agent_id, priority)
      VALUES (10, 86, 'dev', 'backend', 'failed', 1, 10)
    `);
    await insertTask(db, 801, 'failed');

    const result = await runDispatcher(db, 86);

    expect(result.dispatched).toBe(1);
    const task = await db.get(`SELECT active_instance_id FROM tasks WHERE id = 801`) as { active_instance_id: number | null };
    expect(task.active_instance_id).toBe(1);
    await new Promise(resolve => setImmediate(resolve));
    await db.close();
  });

  it('keeps workflow-specific terminal statuses non-dispatchable before non-terminal fallbacks', async () => {
    const db = await setupDb();
    const { runDispatcher } = await import('./dispatcher');
    await db.run(`INSERT INTO task_statuses (name, label, terminal) VALUES ('failed', 'Failed', 0)`);
    await db.run(`INSERT INTO sprint_type_task_statuses (sprint_type_key, status_key, label, terminal) VALUES ('dev', 'failed', 'Failed', 0)`);
    await db.run(`
      INSERT INTO sprint_task_statuses (sprint_id, status_key, label, terminal, stage_order)
      VALUES (10, 'failed', 'Failed', 1, 80)
    `);
    await db.run(`
      INSERT INTO sprint_task_routing_rules (sprint_id, project_id, sprint_type, task_type, status, agent_id, priority)
      VALUES (10, 86, 'dev', 'backend', 'failed', 1, 10)
    `);
    await insertTask(db, 806, 'failed');

    const result = await runDispatcher(db, 86);

    expect(result.dispatched).toBe(0);
    const task = await db.get(`SELECT active_instance_id FROM tasks WHERE id = 806`) as { active_instance_id: number | null };
    expect(task.active_instance_id).toBeNull();
    await db.close();
  });

  it('dispatches configured non-terminal failed tasks on legacy task schemas without dispatch metadata columns', async () => {
    const db = await setupDb({ includeTaskDispatchMetadataColumns: false });
    const { runDispatcher } = await import('./dispatcher');
    await db.run(`INSERT INTO task_statuses (name, label, terminal) VALUES ('failed', 'Failed', 1)`);
    await db.run(`INSERT INTO sprint_type_task_statuses (sprint_type_key, status_key, label, terminal) VALUES ('dev', 'failed', 'Failed', 1)`);
    await db.run(`
      INSERT INTO sprint_task_statuses (sprint_id, status_key, label, terminal, stage_order)
      VALUES (10, 'failed', 'Failed', 0, 80)
    `);
    await db.run(`
      INSERT INTO sprint_task_routing_rules (sprint_id, project_id, sprint_type, task_type, status, agent_id, priority)
      VALUES (10, 86, 'dev', 'backend', 'failed', 1, 10)
    `);
    await insertTask(db, 805, 'failed');

    const result = await runDispatcher(db, 86);

    expect(result).toEqual({ dispatched: 1, skipped: 0, errors: [] });
    const task = await db.get(`SELECT status, agent_id, active_instance_id, dispatched_at FROM tasks WHERE id = 805`) as {
      status: string;
      agent_id: number | null;
      active_instance_id: number | null;
      dispatched_at: string | null;
    };
    expect(task.status).toBe('failed');
    expect(task.agent_id).toBe(1);
    expect(task.active_instance_id).toBe(1);
    expect(task.dispatched_at).toBeTruthy();
    const instance = await db.get(`SELECT task_id, status FROM job_instances WHERE id = ?`, task.active_instance_id) as { task_id: number; status: string };
    expect(instance).toEqual({ task_id: 805, status: 'dispatched' });
    await new Promise(resolve => setImmediate(resolve));
    await db.close();
  });

  it('uses tenant-specific sprint-type terminality before default sprint-type fallback', async () => {
    const db = await setupDb();
    const { runDispatcher } = await import('./dispatcher');
    await db.run(`
      INSERT INTO sprint_type_task_statuses (sprint_type_key, status_key, label, tenant_id, terminal)
      VALUES
        ('dev', 'failed', 'Failed', NULL, 1),
        ('dev', 'failed', 'Failed', 1, 0)
    `);
    await db.run(`
      INSERT INTO sprint_task_routing_rules (sprint_id, project_id, sprint_type, task_type, status, agent_id, priority)
      VALUES (10, 86, 'dev', 'backend', 'failed', 1, 10)
    `);
    await insertTask(db, 802, 'failed');

    const result = await runDispatcher(db, 86);

    expect(result.dispatched).toBe(1);
    const task = await db.get(`SELECT active_instance_id FROM tasks WHERE id = 802`) as { active_instance_id: number | null };
    expect(task.active_instance_id).toBe(1);
    await new Promise(resolve => setImmediate(resolve));
    await db.close();
  });

  it('keeps globally configured terminal statuses non-dispatchable', async () => {
    const db = await setupDb();
    const { runDispatcher } = await import('./dispatcher');
    // Terminality is configuration only — there is no hardcoded fallback, so
    // every terminal status this asserts on must be configured explicitly.
    await db.run(`INSERT INTO task_statuses (name, label, terminal) VALUES ('done', 'Done', 1)`);
    await db.run(`INSERT INTO task_statuses (name, label, terminal) VALUES ('cancelled', 'Cancelled', 1)`);
    await db.run(`INSERT INTO task_statuses (name, label, terminal) VALUES ('failed', 'Failed', 1)`);
    await db.run(`
      INSERT INTO sprint_task_routing_rules (sprint_id, project_id, sprint_type, task_type, status, agent_id, priority)
      VALUES
        (10, 86, 'dev', 'backend', 'done', 1, 10),
        (10, 86, 'dev', 'backend', 'cancelled', 1, 10),
        (10, 86, 'dev', 'backend', 'failed', 1, 10)
    `);
    await insertTask(db, 802, 'done');
    await insertTask(db, 803, 'cancelled');
    await insertTask(db, 804, 'failed');

    const result = await runDispatcher(db, 86);

    expect(result.dispatched).toBe(0);
    const tasks = await db.all(`SELECT id, active_instance_id FROM tasks WHERE id IN (802, 803, 804) ORDER BY id`) as Array<{ id: number; active_instance_id: number | null }>;
    expect(tasks).toEqual([
      { id: 802, active_instance_id: null },
      { id: 803, active_instance_id: null },
      { id: 804, active_instance_id: null },
    ]);
    await db.close();
  });

  it('uses relationship direction semantics to resolve which side blocks dispatch', async () => {
    const db = await setupDb();
    const { runDispatcher } = await import('./dispatcher');
    await insertTask(db, 530, 'ready');
    await insertTask(db, 567, 'in_progress', 'frontend');
    await db.run(`INSERT INTO task_relationships (source_task_id, target_task_id, relationship_type_key) VALUES (567, 530, 'blocks')`);

    const result = await runDispatcher(db, 86);

    expect(result.dispatched).toBe(0);
    const task = await db.get(`SELECT status, active_instance_id FROM tasks WHERE id = 530`) as { status: string; active_instance_id: number | null };
    expect(task.status).toBe('ready');
    expect(task.active_instance_id).toBeNull();
    const history = await db.get(`SELECT new_value FROM task_history WHERE task_id = 530 AND field = 'dispatch_eligibility'`) as { new_value: string };
    expect(history.new_value).toContain('Dispatch ineligible: Blocks (blocks) task #567');
    await db.close();
  });

  it('dispatches when the related blocking task is resolved', async () => {
    const db = await setupDb();
    const { runDispatcher } = await import('./dispatcher');
    await insertTask(db, 530, 'ready');
    await insertTask(db, 567, 'done');
    await db.run(`INSERT INTO task_relationships (source_task_id, target_task_id, relationship_type_key) VALUES (530, 567, 'blocked_by')`);

    const result = await runDispatcher(db, 86);

    expect(result.dispatched).toBe(1);
    const task = await db.get(`SELECT status, active_instance_id FROM tasks WHERE id = 530`) as { status: string; active_instance_id: number | null };
    expect(task.status).toBe('ready');
    expect(task.active_instance_id).toBeGreaterThan(0);
    await new Promise(resolve => setImmediate(resolve));
    await db.close();
  });

  it('ignores non-blocking relationship types for dispatch eligibility', async () => {
    const db = await setupDb();
    const { runDispatcher } = await import('./dispatcher');
    await insertTask(db, 530, 'ready');
    await insertTask(db, 567, 'in_progress', 'frontend');
    await db.run(`INSERT INTO task_relationships (source_task_id, target_task_id, relationship_type_key) VALUES (530, 567, 'defect_of')`);

    const result = await runDispatcher(db, 86);

    expect(result.dispatched).toBe(1);
    const task = await db.get(`SELECT status, active_instance_id FROM tasks WHERE id = 530`) as { status: string; active_instance_id: number | null };
    expect(task.status).toBe('ready');
    expect(task.active_instance_id).toBeGreaterThan(0);
    await new Promise(resolve => setImmediate(resolve));
    await db.close();
  });

  // A relationship type whose resolved_statuses_json omits terminal statuses used
  // to strand the blocked task forever: it could not dispatch, so it could never
  // post the outcome that would clear the blocker.
  async function insertNarrowBlockerType(db: Db): Promise<void> {
    await db.run(`
      INSERT INTO sprint_type_relationship_types (sprint_type_key, key, label, inverse_label, category, affects_dispatch_eligibility, direction_semantics, resolved_statuses_json)
      VALUES ('dev', 'narrow_blocked_by', 'Blocked by', 'Blocks', 'dependency', 1, 'target_blocks_source', '["done"]')
    `);
    // Terminality comes from configuration, so state it explicitly rather than
    // relying on the status name.
    await db.run(`INSERT INTO task_statuses (name, label, terminal) VALUES ('cancelled', 'Cancelled', 1)`);
    await db.run(`INSERT INTO task_statuses (name, label, terminal) VALUES ('failed', 'Failed', 1)`);
  }

  it('releases a blocked task when its blocker is cancelled despite a narrow resolved_statuses_json', async () => {
    const db = await setupDb();
    const { runDispatcher } = await import('./dispatcher');
    await insertNarrowBlockerType(db);
    await insertTask(db, 530, 'ready');
    await insertTask(db, 567, 'cancelled', 'frontend');
    await db.run(`INSERT INTO task_relationships (source_task_id, target_task_id, relationship_type_key) VALUES (530, 567, 'narrow_blocked_by')`);

    const result = await runDispatcher(db, 86);

    expect(result.dispatched).toBe(1);
    const task = await db.get(`SELECT active_instance_id FROM tasks WHERE id = 530`) as { active_instance_id: number | null };
    expect(task.active_instance_id).toBeGreaterThan(0);
    await new Promise(resolve => setImmediate(resolve));
    await db.close();
  });

  it('releases a blocked task when its blocker failed despite a narrow resolved_statuses_json', async () => {
    const db = await setupDb();
    const { runDispatcher } = await import('./dispatcher');
    await insertNarrowBlockerType(db);
    await insertTask(db, 530, 'ready');
    await insertTask(db, 567, 'failed', 'frontend');
    await db.run(`INSERT INTO task_relationships (source_task_id, target_task_id, relationship_type_key) VALUES (530, 567, 'narrow_blocked_by')`);

    const result = await runDispatcher(db, 86);

    expect(result.dispatched).toBe(1);
    const task = await db.get(`SELECT active_instance_id FROM tasks WHERE id = 530`) as { active_instance_id: number | null };
    expect(task.active_instance_id).toBeGreaterThan(0);
    await new Promise(resolve => setImmediate(resolve));
    await db.close();
  });

  it('keeps blocking when the workflow marks the blocker status non-terminal', async () => {
    const db = await setupDb();
    const { runDispatcher } = await import('./dispatcher');
    await insertNarrowBlockerType(db);
    // This workflow treats `failed` as retryable, so the blocker can still
    // progress and must keep blocking.
    await db.run(`INSERT INTO sprint_task_statuses (sprint_id, status_key, label, terminal) VALUES (10, 'failed', 'Failed', 0)`);
    await insertTask(db, 530, 'ready');
    await insertTask(db, 567, 'failed', 'frontend');
    await db.run(`INSERT INTO task_relationships (source_task_id, target_task_id, relationship_type_key) VALUES (530, 567, 'narrow_blocked_by')`);

    const result = await runDispatcher(db, 86);

    expect(result.dispatched).toBe(0);
    const task = await db.get(`SELECT active_instance_id FROM tasks WHERE id = 530`) as { active_instance_id: number | null };
    expect(task.active_instance_id).toBeNull();
    await db.close();
  });
});
