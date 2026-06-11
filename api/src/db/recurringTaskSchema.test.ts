import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from './client';
import { initSchema } from './schema';
import { createTaskRecord } from '../domains/tasks/writeModel';
import {
  createRecurringTaskSeries,
  linkRecurringRunToGeneratedTask,
  recordRecurringTaskRun,
} from '../domains/recurring-tasks';

describe('recurring task scheduling schema', () => {
  const originalDbPath = process.env.AGENT_HQ_DB_PATH;
  let tempDir = '';

  beforeEach(() => {
    closeDb();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recurring-task-schema-'));
    process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
    initSchema();
  });

  afterEach(() => {
    closeDb();
    if (originalDbPath == null) delete process.env.AGENT_HQ_DB_PATH;
    else process.env.AGENT_HQ_DB_PATH = originalDbPath;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  function seedProjectSprint(): void {
    const db = getDb();
    db.prepare(`
      INSERT INTO projects (id, name, description, context_md, created_at)
      VALUES (612, 'Recurring Tasks', '', '', datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO sprints (id, project_id, name, goal, sprint_type, status, length_kind, length_value, created_at)
      VALUES (6121, 612, 'Fixed Sprint', '', 'dev', 'active', 'time', '2w', datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO agents (id, name, role, session_key)
      VALUES (6122, 'Pinned Backend', 'backend', 'agent:pinned-backend:main')
    `).run();
  }

  it('creates a fixed-sprint series, records a run, and links the generated task metadata', () => {
    const db = getDb();
    seedProjectSprint();

    const series = createRecurringTaskSeries(db, {
      project_id: 612,
      sprint_id: 6121,
      title_template: 'Weekly backend maintenance',
      description_template: 'Run the backend maintenance checklist.',
      task_type: 'backend',
      priority: 'high',
      story_points: 3,
      status_on_create: 'in_progress',
      schedule_expression: 'every monday 09:00',
      timezone: 'America/New_York',
      next_run_at: '2026-05-25T13:00:00.000Z',
      overlap_policy: 'skip_if_active',
      agent_id: 6122,
      created_by: 'schema-test',
    });

    const run = recordRecurringTaskRun(db, {
      series_id: series.id,
      scheduled_for: '2026-05-25T13:00:00.000Z',
      status: 'started',
      idempotency_key: `${series.id}:2026-05-25T13:00:00.000Z`,
    });

    const task = createTaskRecord(db, {
      title: 'Weekly backend maintenance',
      description: 'Run the backend maintenance checklist.',
      status: 'in_progress',
      priority: 'high',
      project_id: 612,
      sprint_id: 6121,
      agent_id: 6122,
      task_type: 'backend',
      story_points: 3,
      recurring_series_id: series.id,
      scheduled_for: run.scheduled_for,
      schedule_run_id: run.id,
      generated_from: 'recurring_task_series',
    }, 'scheduler');

    const linkedRun = linkRecurringRunToGeneratedTask(db, run.id, Number(task.id));

    expect(series).toEqual(expect.objectContaining({
      project_id: 612,
      sprint_id: 6121,
      schedule_expression: 'every monday 09:00',
      timezone: 'America/New_York',
      overlap_policy: 'skip_if_active',
      enabled: 1,
    }));
    expect(linkedRun).toEqual(expect.objectContaining({
      id: run.id,
      series_id: series.id,
      created_task_id: Number(task.id),
      status: 'created',
    }));
    expect(task).toEqual(expect.objectContaining({
      recurring_series_id: series.id,
      scheduled_for: '2026-05-25T13:00:00.000Z',
      schedule_run_id: run.id,
      generated_from: 'recurring_task_series',
    }));
  });

  it('prevents duplicate occurrences for the same series and scheduled time', () => {
    const db = getDb();
    seedProjectSprint();

    const series = createRecurringTaskSeries(db, {
      project_id: 612,
      sprint_id: 6121,
      title_template: 'Daily QA sweep',
      task_type: 'qa',
      priority: 'medium',
      story_points: 1,
      status_on_create: 'in_progress',
      schedule_expression: 'every day 10:00',
      timezone: 'UTC',
    });
    const scheduledFor = '2026-05-24T10:00:00.000Z';
    const run = recordRecurringTaskRun(db, {
      series_id: series.id,
      scheduled_for: scheduledFor,
      status: 'started',
      idempotency_key: `${series.id}:${scheduledFor}`,
    });

    expect(() => recordRecurringTaskRun(db, {
      series_id: series.id,
      scheduled_for: scheduledFor,
      status: 'started',
      idempotency_key: `${series.id}:${scheduledFor}:duplicate-worker`,
    })).toThrow();

    createTaskRecord(db, {
      title: 'Daily QA sweep',
      status: 'in_progress',
      project_id: 612,
      sprint_id: 6121,
      task_type: 'qa',
      story_points: 1,
      recurring_series_id: series.id,
      scheduled_for: scheduledFor,
      schedule_run_id: run.id,
      generated_from: 'recurring_task_series',
    }, 'scheduler');

    expect(() => createTaskRecord(db, {
      title: 'Daily QA sweep duplicate',
      status: 'in_progress',
      project_id: 612,
      sprint_id: 6121,
      task_type: 'qa',
      story_points: 1,
      recurring_series_id: series.id,
      scheduled_for: scheduledFor,
      schedule_run_id: run.id,
      generated_from: 'recurring_task_series',
    }, 'scheduler')).toThrow();
  });

  it('creates lookup indexes for due series, run history, and generated tasks', () => {
    const db = getDb();
    const indexes = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'idx_recurring_task_series_due',
          'idx_recurring_task_runs_series_history',
          'idx_tasks_generated_lookup',
          'idx_tasks_generated_occurrence_unique'
        )
      ORDER BY name ASC
    `).all() as Array<{ name: string }>;

    expect(indexes.map(row => row.name)).toEqual([
      'idx_recurring_task_runs_series_history',
      'idx_recurring_task_series_due',
      'idx_tasks_generated_lookup',
      'idx_tasks_generated_occurrence_unique',
    ]);
  });

  it('migrates an existing tasks table before creating generated-task indexes', () => {
    closeDb();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recurring-task-legacy-schema-'));
    process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
    const db = getDb();
    db.exec(`
      CREATE TABLE tasks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        title        TEXT NOT NULL,
        description  TEXT NOT NULL DEFAULT '',
        status       TEXT NOT NULL DEFAULT 'todo',
        priority     TEXT NOT NULL DEFAULT 'medium',
        project_id   INTEGER,
        agent_id     INTEGER,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
        dispatched_at TEXT,
        active_instance_id INTEGER,
        task_type    TEXT,
        story_points INTEGER,
        custom_fields_json TEXT NOT NULL DEFAULT '{}'
      );
    `);

    expect(() => initSchema()).not.toThrow();

    const columns = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
    expect(columns.map(col => col.name)).toEqual(expect.arrayContaining([
      'recurring_series_id',
      'scheduled_for',
      'schedule_run_id',
      'generated_from',
    ]));
    expect(db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_tasks_generated_lookup'
    `).get()).toEqual({ name: 'idx_tasks_generated_lookup' });
  });
});
