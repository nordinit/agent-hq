import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from './client';
import { initSchema } from './schema';
import { SqliteAdapter } from "./adapter/SqliteAdapter";

describe('tasks.status schema migration', () => {
  const originalDbPath = process.env.AGENT_HQ_DB_PATH;
  let tempDir = '';

  beforeEach(() => {
    closeDb();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-status-migration-'));
    process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
  });

  afterEach(() => {
    closeDb();
    if (originalDbPath == null) delete process.env.AGENT_HQ_DB_PATH;
    else process.env.AGENT_HQ_DB_PATH = originalDbPath;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  it('removes the legacy hard-coded tasks.status CHECK constraint without losing task rows', async () => {
    const legacyDbRaw = new Database(process.env.AGENT_HQ_DB_PATH!);
      const legacyDb = new SqliteAdapter(legacyDbRaw);
    await legacyDb.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        context_md TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE sprints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        sprint_type TEXT NOT NULL DEFAULT 'generic',
        status TEXT NOT NULL DEFAULT 'planning',
        length_kind TEXT NOT NULL DEFAULT 'time',
        length_value TEXT NOT NULL DEFAULT '',
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','ready','dispatched','in_progress','dev_deploy_queued','dev_deploying','review','qa_pass','ready_to_merge','deployed','done','needs_attention','cancelled','stalled','failed','blocked')),
        priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
        project_id INTEGER,
        agent_id INTEGER,
        assigned_agent_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        dispatched_at TEXT,
        active_instance_id INTEGER,
        task_type TEXT,
        story_points INTEGER,
        recurring INTEGER NOT NULL DEFAULT 0,
        recurring_series_id INTEGER,
        scheduled_for TEXT,
        schedule_run_id INTEGER,
        generated_from TEXT,
        sprint_id INTEGER,
        branch_url TEXT,
        custom_fields_json TEXT NOT NULL DEFAULT '{}',
        review_branch TEXT,
        review_commit TEXT,
        review_url TEXT,
        qa_verified_commit TEXT,
        qa_tested_url TEXT,
        merged_commit TEXT,
        deployed_commit TEXT,
        deployed_at TEXT,
        live_verified_at TEXT,
        live_verified_by TEXT,
        deploy_target TEXT,
        evidence_json TEXT,
        review_owner_agent_id INTEGER,
        origin_task_id INTEGER,
        defect_type TEXT,
        failure_detail TEXT,
        paused_at TEXT,
        pause_reason TEXT,
        previous_status TEXT,
        first_dispatched_at TEXT,
        total_dispatch_count INTEGER NOT NULL DEFAULT 0,
        manual_intervention_count INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO projects (id, name) VALUES (86, 'Agent HQ');
      INSERT INTO sprints (id, project_id, name, status) VALUES (56, 86, 'Bugs', 'active');
      INSERT INTO tasks (id, title, description, status, priority, sprint_id)
      VALUES (797, 'Elevation Build intake', '', 'todo', 'medium', 56);
    `);
    legacyDbRaw.close();

    // expect(fn).toThrow() calls fn SYNCHRONOUSLY. An async fn returns a promise instead of
    // throwing, so not.toThrow() passed trivially while the call ran DETACHED — and then
    // rejected after teardown closed the connection, killing the jest worker. toThrow() on an
    // async fn simply never matched. Both forms must go through the promise.
    await initSchema();
    const db = getDb();
    const ddl = (await db.get(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'tasks'
    `) as { sql: string }).sql;

    expect(ddl).not.toContain('CHECK(status IN');
    expect(await db.get(`SELECT title, status FROM tasks WHERE id = 797`)).toEqual({
      title: 'Elevation Build intake',
      status: 'todo',
    });

    await db.run(`UPDATE tasks SET status = 'field_reported' WHERE id = 797`);
    expect((await db.get(`SELECT status FROM tasks WHERE id = 797`) as { status: string }).status).toBe('field_reported');
  });

  it('removes orphaned tasks and rebuilds sprint_id as required with cascade delete', async () => {
    const legacyDbRaw = new Database(process.env.AGENT_HQ_DB_PATH!);
      const legacyDb = new SqliteAdapter(legacyDbRaw);
    await legacyDb.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        context_md TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE sprints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        sprint_type TEXT NOT NULL DEFAULT 'generic',
        status TEXT NOT NULL DEFAULT 'planning',
        length_kind TEXT NOT NULL DEFAULT 'time',
        length_value TEXT NOT NULL DEFAULT '',
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo',
        priority TEXT NOT NULL DEFAULT 'medium',
        project_id INTEGER,
        agent_id INTEGER,
        sprint_id INTEGER,
        custom_fields_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO projects (id, name) VALUES (86, 'Agent HQ');
      INSERT INTO sprints (id, project_id, name, status) VALUES (56, 86, 'Bugs', 'active');
      INSERT INTO tasks (id, title, project_id, sprint_id) VALUES
        (1, 'Valid workflow task', 86, 56),
        (2, 'Null workflow task', 86, NULL),
        (3, 'Missing workflow task', 86, 999);
    `);
    legacyDbRaw.close();

    await initSchema();
    const db = getDb();

    expect(await db.all(`SELECT id, title, sprint_id FROM tasks ORDER BY id`)).toEqual([
      { id: 1, title: 'Valid workflow task', sprint_id: 56 },
    ]);

    const sprintInfo = (await db.all(`PRAGMA table_info(tasks)`) as Array<{ name: string; notnull: number }>)
      .find((column) => column.name === 'sprint_id');
    expect(sprintInfo?.notnull).toBe(1);
    const sprintFk = (await db.all(`PRAGMA foreign_key_list(tasks)`) as Array<{ from: string; table: string; on_delete: string }>)
      .find((fk) => fk.from === 'sprint_id' && fk.table === 'sprints');
    expect(sprintFk?.on_delete).toBe('CASCADE');

    expect(await db.get(`SELECT COUNT(*) AS count FROM tasks WHERE sprint_id IS NULL`)).toEqual({ count: 0 });
  });
});
