import Database from 'better-sqlite3';
import { listRecentlyCompletedTasks } from './readModel';
import { type Db } from "../../db/adapter/types";
import { SqliteAdapter } from "../../db/adapter/SqliteAdapter";

describe('listRecentlyCompletedTasks tenant isolation', () => {
  let db: Db;

  beforeEach(async () => {
    db = new SqliteAdapter(new Database(':memory:'));
    await db.exec(`
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        name TEXT,
        job_title TEXT
      );
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT
      );
      CREATE TABLE sprints (
        id INTEGER PRIMARY KEY,
        name TEXT
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        tenant_id INTEGER,
        title TEXT,
        status TEXT,
        priority TEXT,
        project_id INTEGER,
        sprint_id INTEGER,
        agent_id INTEGER,
        live_verified_at TEXT,
        live_verified_by TEXT,
        updated_at TEXT
      );
      CREATE TABLE task_history (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        field TEXT,
        new_value TEXT,
        created_at TEXT
      );
      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        task_outcome TEXT,
        completed_at TEXT
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('returns only recently completed tasks for the requested tenant', async () => {
    await db.exec(`
      INSERT INTO projects (id, name) VALUES (10, 'Default Project'), (20, 'EcoPool Project');
      INSERT INTO sprints (id, name) VALUES (100, 'Default Workflow'), (200, 'EcoPool Workflow');
      INSERT INTO tasks (id, tenant_id, title, status, priority, project_id, sprint_id, updated_at)
      VALUES
        (1, 1, 'Default completed task', 'done', 'medium', 10, 100, datetime('now', '-1 hour')),
        (2, 2, 'EcoPool completed task', 'done', 'medium', 20, 200, datetime('now', '-1 hour')),
        (3, 2, 'EcoPool stale task', 'done', 'medium', 20, 200, datetime('now', '-25 hours'));
      INSERT INTO task_history (task_id, field, new_value, created_at)
      VALUES
        (1, 'status', 'done', datetime('now', '-1 hour')),
        (2, 'status', 'done', datetime('now', '-1 hour')),
        (3, 'status', 'done', datetime('now', '-25 hours'));
    `);

    const ecoPool = await listRecentlyCompletedTasks(db, 24, undefined, 2);
    expect(ecoPool.tasks.map(task => task.title)).toEqual(['EcoPool completed task']);

    const defaultCompany = await listRecentlyCompletedTasks(db, 24, undefined, 1);
    expect(defaultCompany.tasks.map(task => task.title)).toEqual(['Default completed task']);
  });

  it('applies project and tenant scope together', async () => {
    await db.exec(`
      INSERT INTO projects (id, name) VALUES (10, 'Default Project'), (20, 'EcoPool Project');
      INSERT INTO sprints (id, name) VALUES (100, 'Default Workflow'), (200, 'EcoPool Workflow');
      INSERT INTO tasks (id, tenant_id, title, status, priority, project_id, sprint_id, updated_at)
      VALUES
        (1, 1, 'Default project task', 'done', 'medium', 10, 100, datetime('now', '-1 hour')),
        (2, 2, 'EcoPool project task', 'done', 'medium', 20, 200, datetime('now', '-1 hour'));
    `);

    expect((await listRecentlyCompletedTasks(db, 24, 10, 2)).tasks).toEqual([]);
    expect((await listRecentlyCompletedTasks(db, 24, 20, 2)).tasks.map(task => task.title)).toEqual(['EcoPool project task']);
  });
});
