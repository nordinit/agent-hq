import Database from 'better-sqlite3';
import { getDashboardTokenUsageLast24h } from './stats';

describe('getDashboardTokenUsageLast24h', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        tenant_id INTEGER,
        project_id INTEGER
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        tenant_id INTEGER,
        project_id INTEGER
      );
      CREATE TABLE job_instances (
        id INTEGER PRIMARY KEY,
        task_id INTEGER,
        agent_id INTEGER,
        created_at TEXT NOT NULL,
        dispatched_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        runtime_ended_at TEXT,
        runtime_completed_at TEXT,
        lifecycle_outcome_posted_at TEXT,
        token_input INTEGER,
        token_output INTEGER,
        token_total INTEGER
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('includes token usage from the rolling last 24 hours and excludes older usage', () => {
    db.prepare(`
      INSERT INTO job_instances (id, created_at, token_input, token_output, token_total)
      VALUES
        (1, datetime('now', '-23 hours'), 10, 15, NULL),
        (2, datetime('now', '-24 hours', '-1 minute'), 100, 200, NULL),
        (3, datetime('now', '-2 hours'), 1, 2, 50)
    `).run();

    expect(getDashboardTokenUsageLast24h(db)).toBe(75);
  });

  it('uses the latest run lifecycle timestamp so delayed token writes are counted', () => {
    db.prepare(`
      INSERT INTO job_instances (
        id, created_at, completed_at, runtime_ended_at, token_input, token_output, token_total
      )
      VALUES
        (1, datetime('now', '-25 hours'), datetime('now', '-1 hour'), datetime('now', '-1 hour'), 20, 30, NULL),
        (2, datetime('now', '-25 hours'), datetime('now', '-25 hours'), datetime('now', '-25 hours'), 100, 200, NULL),
        (3, datetime('now', '-26 hours'), NULL, datetime('now', '-2 hours'), NULL, NULL, 75)
    `).run();

    expect(getDashboardTokenUsageLast24h(db)).toBe(125);
  });

  it('applies project scope to task-owned and unassigned agent-owned runs', () => {
    db.exec(`
      INSERT INTO agents (id, project_id) VALUES (1, 10), (2, 20);
      INSERT INTO tasks (id, project_id) VALUES (1, 10), (2, 20);
      INSERT INTO job_instances (id, task_id, agent_id, created_at, token_input, token_output, token_total)
      VALUES
        (1, 1, 2, datetime('now', '-1 hour'), 5, 5, NULL),
        (2, 2, 1, datetime('now', '-1 hour'), 100, 100, NULL),
        (3, NULL, 1, datetime('now', '-1 hour'), 7, 8, NULL),
        (4, NULL, 2, datetime('now', '-1 hour'), 200, 200, NULL);
    `);

    expect(getDashboardTokenUsageLast24h(db, 10)).toBe(25);
  });
});
