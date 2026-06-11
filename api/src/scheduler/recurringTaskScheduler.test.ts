import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import { initSchema } from '../db/schema';
import { createRecurringTaskSeries, recordRecurringTaskRun } from '../domains/recurring-tasks';
import { createTaskRecord } from '../domains/tasks/writeModel';
import * as dispatchTrigger from '../services/dispatchTrigger';
import { calculateNextRecurringRunAt, runRecurringTaskSchedulerTick } from './recurringTaskScheduler';

describe('recurring task scheduler', () => {
  const originalDbPath = process.env.AGENT_HQ_DB_PATH;
  let tempDir = '';
  let triggerDispatchSpy: jest.SpyInstance;

  beforeEach(() => {
    closeDb();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recurring-task-scheduler-'));
    process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
    initSchema();
    seedBaseRows();
    triggerDispatchSpy = jest.spyOn(dispatchTrigger, 'triggerDispatch').mockImplementation(() => {});
  });

  afterEach(() => {
    triggerDispatchSpy.mockRestore();
    closeDb();
    if (originalDbPath == null) delete process.env.AGENT_HQ_DB_PATH;
    else process.env.AGENT_HQ_DB_PATH = originalDbPath;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  function seedBaseRows(status = 'active'): void {
    const db = getDb();
    db.prepare(`
      INSERT INTO projects (id, name, description, context_md, created_at)
      VALUES (613, 'Recurring Scheduler', '', '', datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO sprints (id, project_id, name, goal, sprint_type, status, length_kind, length_value, created_at)
      VALUES (6131, 613, 'Fixed Sprint', '', 'dev', ?, 'time', '2w', datetime('now'))
    `).run(status);
    db.prepare(`
      INSERT INTO agents (id, name, role, session_key)
      VALUES (6132, 'Backend Agent', 'backend', 'agent:backend:main')
    `).run();
  }

  function createDueSeries(input: Partial<Parameters<typeof createRecurringTaskSeries>[1]> = {}) {
    return createRecurringTaskSeries(getDb(), {
      project_id: 613,
      sprint_id: 6131,
      title_template: 'Weekly backend maintenance',
      description_template: 'Run the backend maintenance checklist.',
      task_type: 'backend',
      priority: 'high',
      story_points: 3,
      status_on_create: 'todo',
      schedule_expression: 'every monday 09:00',
      timezone: 'America/New_York',
      next_run_at: '2026-05-18T13:00:00.000Z',
      overlap_policy: 'skip_if_active',
      agent_id: 6132,
      created_by: 'scheduler-test',
      ...input,
    });
  }

  function createPersistedDriftSeries(updates: Record<string, unknown>) {
    const db = getDb();
    const series = createDueSeries();
    const fields = Object.keys(updates);
    db.prepare(`
      UPDATE recurring_task_series
      SET ${fields.map(field => `${field} = ?`).join(', ')}
      WHERE id = ?
    `).run(...fields.map(field => updates[field]), series.id);
    return db.prepare(`SELECT * FROM recurring_task_series WHERE id = ?`).get(series.id) as typeof series;
  }

  it('creates one normal task for a due enabled occurrence and advances next_run_at', () => {
    const db = getDb();
    const series = createDueSeries({ status_on_create: 'ready' });

    const summary = runRecurringTaskSchedulerTick(db, { now: new Date('2026-05-18T13:00:01.000Z') });

    expect(summary).toEqual(expect.objectContaining({ checked: 1, created: 1, skipped: 0, failed: 0 }));
    const task = db.prepare(`
      SELECT *
      FROM tasks
      WHERE recurring_series_id = ?
    `).get(series.id) as Record<string, unknown>;
    expect(task).toEqual(expect.objectContaining({
      title: 'Weekly backend maintenance',
      status: 'ready',
      project_id: 613,
      sprint_id: 6131,
      agent_id: null,
      assigned_agent_id: 6132,
      task_type: 'backend',
      generated_from: 'recurring_task_series',
      scheduled_for: '2026-05-18T13:00:00.000Z',
    }));
    const run = db.prepare(`SELECT * FROM recurring_task_runs WHERE series_id = ?`).get(series.id) as Record<string, unknown>;
    expect(run).toEqual(expect.objectContaining({
      status: 'created',
      created_task_id: task.id,
      scheduled_for: '2026-05-18T13:00:00.000Z',
    }));
    const updatedSeries = db.prepare(`SELECT * FROM recurring_task_series WHERE id = ?`).get(series.id) as Record<string, unknown>;
    expect(updatedSeries.last_run_at).toBe('2026-05-18T13:00:00.000Z');
    expect(updatedSeries.next_run_at).toBe('2026-05-25T13:00:00.000Z');
  });

  it('does not process disabled series', () => {
    const db = getDb();
    createDueSeries({ enabled: 0 });

    const summary = runRecurringTaskSchedulerTick(db, { now: new Date('2026-05-18T13:00:01.000Z') });

    expect(summary.checked).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM recurring_task_runs`).get() as { n: number }).n).toBe(0);
  });

  it('uses the run uniqueness key to prevent duplicate task creation for an occurrence', () => {
    const db = getDb();
    const series = createDueSeries();

    runRecurringTaskSchedulerTick(db, { now: new Date('2026-05-18T13:00:01.000Z') });
    db.prepare(`UPDATE recurring_task_series SET next_run_at = ? WHERE id = ?`).run('2026-05-18T13:00:00.000Z', series.id);
    const secondSummary = runRecurringTaskSchedulerTick(db, { now: new Date('2026-05-18T13:00:02.000Z') });

    expect(secondSummary).toEqual(expect.objectContaining({ checked: 1, duplicates: 1, created: 0 }));
    expect((db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE recurring_series_id = ?`).get(series.id) as { n: number }).n).toBe(1);
  });

  it('skip_if_active records a skipped run when a prior generated task is non-terminal', () => {
    const db = getDb();
    const series = createDueSeries();
    const previousRun = recordRecurringTaskRun(db, {
      series_id: series.id,
      scheduled_for: '2026-05-11T13:00:00.000Z',
      status: 'started',
      idempotency_key: `${series.id}:2026-05-11T13:00:00.000Z`,
    });
    createTaskRecord(db, {
      title: 'Prior generated task',
      status: 'ready',
      project_id: 613,
      sprint_id: 6131,
      task_type: 'backend',
      story_points: 3,
      recurring_series_id: series.id,
      scheduled_for: previousRun.scheduled_for,
      schedule_run_id: previousRun.id,
      generated_from: 'recurring_task_series',
    }, 'scheduler-test');

    const summary = runRecurringTaskSchedulerTick(db, { now: new Date('2026-05-18T13:00:01.000Z') });

    expect(summary).toEqual(expect.objectContaining({ created: 0, skipped: 1, failed: 0 }));
    const skipped = db.prepare(`
      SELECT status, error_message
      FROM recurring_task_runs
      WHERE series_id = ? AND scheduled_for = ?
    `).get(series.id, '2026-05-18T13:00:00.000Z') as { status: string; error_message: string };
    expect(skipped.status).toBe('skipped');
    expect(skipped.error_message).toContain('active_task_exists');
    expect((db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE recurring_series_id = ?`).get(series.id) as { n: number }).n).toBe(1);
  });

  it('create_anyway creates a new dated occurrence even when a generated task is active', () => {
    const db = getDb();
    const series = createDueSeries({ overlap_policy: 'create_anyway' });
    const previousRun = recordRecurringTaskRun(db, {
      series_id: series.id,
      scheduled_for: '2026-05-11T13:00:00.000Z',
      status: 'started',
      idempotency_key: `${series.id}:2026-05-11T13:00:00.000Z`,
    });
    createTaskRecord(db, {
      title: 'Prior generated task',
      status: 'ready',
      project_id: 613,
      sprint_id: 6131,
      task_type: 'backend',
      story_points: 3,
      recurring_series_id: series.id,
      scheduled_for: previousRun.scheduled_for,
      schedule_run_id: previousRun.id,
      generated_from: 'recurring_task_series',
    }, 'scheduler-test');

    const summary = runRecurringTaskSchedulerTick(db, { now: new Date('2026-05-18T13:00:01.000Z') });

    expect(summary.created).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE recurring_series_id = ?`).get(series.id) as { n: number }).n).toBe(2);
  });

  it('records paused fixed sprints as skipped and still advances the series', () => {
    const db = getDb();
    db.prepare(`UPDATE sprints SET status = 'paused' WHERE id = 6131`).run();
    const series = createDueSeries();

    const summary = runRecurringTaskSchedulerTick(db, { now: new Date('2026-05-18T13:00:01.000Z') });

    expect(summary.skipped).toBe(1);
    const run = db.prepare(`SELECT status, error_message FROM recurring_task_runs WHERE series_id = ?`).get(series.id) as { status: string; error_message: string };
    expect(run).toEqual(expect.objectContaining({ status: 'skipped' }));
    expect(run.error_message).toContain('sprint_paused');
    const updatedSeries = db.prepare(`SELECT enabled, next_run_at FROM recurring_task_series WHERE id = ?`).get(series.id) as { enabled: number; next_run_at: string };
    expect(updatedSeries.enabled).toBe(1);
    expect(updatedSeries.next_run_at).toBe('2026-05-25T13:00:00.000Z');
  });

  it('records closed fixed sprints as failed and disables the series', () => {
    const db = getDb();
    const series = createDueSeries();
    db.prepare(`UPDATE sprints SET status = 'closed' WHERE id = 6131`).run();

    const summary = runRecurringTaskSchedulerTick(db, { now: new Date('2026-05-18T13:00:01.000Z') });

    expect(summary.failed).toBe(1);
    const run = db.prepare(`SELECT status, error_message FROM recurring_task_runs WHERE series_id = ?`).get(series.id) as { status: string; error_message: string };
    expect(run.status).toBe('failed');
    expect(run.error_message).toContain('fixed_sprint_unavailable');
    const updatedSeries = db.prepare(`SELECT enabled, next_run_at FROM recurring_task_series WHERE id = ?`).get(series.id) as { enabled: number; next_run_at: string | null };
    expect(updatedSeries.enabled).toBe(0);
    expect(updatedSeries.next_run_at).toBeNull();
  });

  it('records invalid sprint-scoped status_on_create as failed and disables the series', () => {
    const db = getDb();
    db.prepare(`DELETE FROM sprint_task_statuses WHERE sprint_id = 6131`).run();
    db.prepare(`
      INSERT INTO sprint_task_statuses (sprint_id, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json)
      VALUES (6131, 'todo', 'Todo', 'slate', 0, 1, '[]', 0, 1, '{}')
    `).run();
    const series = createPersistedDriftSeries({ status_on_create: 'ready' });

    const summary = runRecurringTaskSchedulerTick(db, { now: new Date('2026-05-18T13:00:01.000Z') });

    expect(summary.failed).toBe(1);
    const run = db.prepare(`SELECT status, error_message FROM recurring_task_runs WHERE series_id = ?`).get(series.id) as { status: string; error_message: string };
    expect(run.status).toBe('failed');
    expect(run.error_message).toContain('invalid_status_on_create');
    const updatedSeries = db.prepare(`SELECT enabled, next_run_at FROM recurring_task_series WHERE id = ?`).get(series.id) as { enabled: number; next_run_at: string | null };
    expect(updatedSeries.enabled).toBe(0);
    expect(updatedSeries.next_run_at).toBeNull();
  });

  it('records invalid schedules as failed attempts and disables the series', () => {
    const db = getDb();
    const series = createPersistedDriftSeries({ schedule_expression: 'every someday soon' });

    const summary = runRecurringTaskSchedulerTick(db, { now: new Date('2026-05-18T13:00:01.000Z') });

    expect(summary.failed).toBe(1);
    const run = db.prepare(`SELECT status, error_message FROM recurring_task_runs WHERE series_id = ?`).get(series.id) as { status: string; error_message: string };
    expect(run.status).toBe('failed');
    expect(run.error_message).toContain('invalid_schedule');
    const updatedSeries = db.prepare(`SELECT enabled, next_run_at FROM recurring_task_series WHERE id = ?`).get(series.id) as { enabled: number; next_run_at: string | null };
    expect(updatedSeries.enabled).toBe(0);
    expect(updatedSeries.next_run_at).toBeNull();
  });

  it('calculates next runs in the stored timezone', () => {
    expect(calculateNextRecurringRunAt(
      'every monday 09:00',
      'America/New_York',
      new Date('2026-05-18T13:00:00.000Z'),
    )).toBe('2026-05-25T13:00:00.000Z');
    expect(calculateNextRecurringRunAt(
      'every day 10:00',
      'UTC',
      new Date('2026-05-18T10:00:00.000Z'),
    )).toBe('2026-05-19T10:00:00.000Z');
  });

  it('calculates and advances minute-level recurring schedules', () => {
    expect(calculateNextRecurringRunAt(
      'every 15 minutes',
      'America/New_York',
      new Date('2026-05-18T13:00:00.000Z'),
    )).toBe('2026-05-18T13:15:00.000Z');

    const db = getDb();
    const series = createDueSeries({
      schedule_expression: 'every 15 minutes',
      next_run_at: '2026-05-18T13:00:00.000Z',
    });

    const summary = runRecurringTaskSchedulerTick(db, { now: new Date('2026-05-18T13:00:01.000Z') });

    expect(summary).toEqual(expect.objectContaining({ checked: 1, created: 1 }));
    const updatedSeries = db.prepare(`SELECT last_run_at, next_run_at FROM recurring_task_series WHERE id = ?`).get(series.id) as Record<string, unknown>;
    expect(updatedSeries).toMatchObject({
      last_run_at: '2026-05-18T13:00:00.000Z',
      next_run_at: '2026-05-18T13:15:00.000Z',
    });
  });
});
