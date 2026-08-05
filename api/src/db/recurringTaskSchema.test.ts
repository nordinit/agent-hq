import { getDb } from './client';
import { initSchema } from './schema';
import { describeSqliteOnly, setupTestDb, teardownTestDb, usingPostgres } from './testDb';
import { getDefaultTenantId } from '../lib/tenantContext';
import { createTaskRecord } from '../domains/tasks/writeModel';
import {
  createRecurringTaskSeries,
  linkRecurringRunToGeneratedTask,
  recordRecurringTaskRun,
} from '../domains/recurring-tasks';

/**
 * Each engine words a unique-index violation in its own way, and nothing between the domain code
 * and the driver normalises it. The phrase is still engine-EXACT rather than a loose /unique/i, so
 * a foreign-key or CHECK failure cannot satisfy the assertion by accident.
 */
const UNIQUE_VIOLATION = usingPostgres()
  ? 'duplicate key value violates unique constraint'
  : 'UNIQUE constraint failed';

const LOOKUP_INDEXES = [
  'idx_recurring_task_series_due',
  'idx_recurring_task_runs_series_history',
  'idx_tasks_generated_lookup',
  'idx_tasks_generated_occurrence_unique',
];

/** sqlite_master has no PostgreSQL equivalent; pg_indexes is the catalog that answers the same question. */
async function lookupIndexNames(): Promise<string[]> {
  const db = getDb();
  const placeholders = LOOKUP_INDEXES.map(() => '?').join(', ');
  const rows = usingPostgres()
    ? await db.all(`
        SELECT indexname AS name
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (${placeholders})
        ORDER BY indexname ASC
      `, ...LOOKUP_INDEXES)
    : await db.all(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (${placeholders})
        ORDER BY name ASC
      `, ...LOOKUP_INDEXES);
  return (rows as Array<{ name: string }>).map(row => row.name);
}

describe('recurring task scheduling schema', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  async function seedProjectSprint(): Promise<void> {
    const db = getDb();
    // The real baseline carries the foreign keys the hand-written fixture schema never had:
    // projects/sprints/agents all point at tenants, and recurring_task_series points at all three.
    // So the tenant has to exist before its children rather than being left implicit.
    const tenantId = await getDefaultTenantId(db);
    await db.run(`
      INSERT INTO projects (id, tenant_id, name, description, context_md)
      VALUES (612, ?, 'Recurring Tasks', '', '')
    `, tenantId);
    await db.run(`
      INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value)
      VALUES (6121, ?, 612, 'Fixed Sprint', '', 'dev', 'active', 'time', '2w')
    `, tenantId);
    await db.run(`
      INSERT INTO agents (id, tenant_id, name, role, session_key)
      VALUES (6122, ?, 'Pinned Backend', 'backend', 'agent:pinned-backend:main')
    `, tenantId);
  }

  it('creates a fixed-sprint series, records a run, and links the generated task metadata', async () => {
    const db = getDb();
    await seedProjectSprint();

    const series = await createRecurringTaskSeries(db, {
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

    const run = await recordRecurringTaskRun(db, {
          series_id: series.id,
          scheduled_for: '2026-05-25T13:00:00.000Z',
          status: 'started',
          idempotency_key: `${series.id}:2026-05-25T13:00:00.000Z`,
        });

    const task = await createTaskRecord(db, {
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

    const linkedRun = await linkRecurringRunToGeneratedTask(db, run.id, Number(task.id));

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

  it('prevents duplicate occurrences for the same series and scheduled time', async () => {
    const db = getDb();
    await seedProjectSprint();

    const series = await createRecurringTaskSeries(db, {
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
    const run = await recordRecurringTaskRun(db, {
          series_id: series.id,
          scheduled_for: scheduledFor,
          status: 'started',
          idempotency_key: `${series.id}:${scheduledFor}`,
        });

    // Asserted on the rejection VALUE. A bare .rejects.toThrow() is order-dependent here:

    // better-sqlite3 is a native addon, and a SqliteError raised from the second test file

    // loaded in a jest worker fails `instanceof Error` (the addon keeps the constructor from

    // the first module-registry load), so toThrow cannot classify it and reports "did not

    // throw" despite a correct rejection.

    await expect((async () => await recordRecurringTaskRun(db, {
                series_id: series.id,
                scheduled_for: scheduledFor,
                status: 'started',
                idempotency_key: `${series.id}:${scheduledFor}:duplicate-worker`,
              }))()).rejects.toMatchObject({ message: expect.stringContaining(UNIQUE_VIOLATION) });

    await createTaskRecord(db, {
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

    // Asserted on the rejection VALUE. A bare .rejects.toThrow() is order-dependent here:

    // better-sqlite3 is a native addon, and a SqliteError raised from the second test file

    // loaded in a jest worker fails `instanceof Error` (the addon keeps the constructor from

    // the first module-registry load), so toThrow cannot classify it and reports "did not

    // throw" despite a correct rejection.

    await expect((async () => await createTaskRecord(db, {
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
              }, 'scheduler'))()).rejects.toMatchObject({ message: expect.stringContaining(UNIQUE_VIOLATION) });
  });

  it('creates lookup indexes for due series, run history, and generated tasks', async () => {
    expect(await lookupIndexNames()).toEqual([
      'idx_recurring_task_runs_series_history',
      'idx_recurring_task_series_due',
      'idx_tasks_generated_lookup',
      'idx_tasks_generated_occurrence_unique',
    ]);
  });
});

/**
 * SQLite-only on purpose, and not a conversion gap.
 *
 * What this covers is initSchema()'s in-place ALTER TABLE migration of a pre-existing tasks table,
 * which exists solely to carry legacy SQLite installs forward. PostgreSQL gets those columns from
 * db/pg-baseline, so there is no PostgreSQL behaviour here to exercise — running it there would
 * assert against the baseline rather than against the migration.
 */
describeSqliteOnly('recurring task schema legacy migration', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('migrates an existing tasks table before creating generated-task indexes', async () => {
    // Replace the fully-migrated tasks table with the legacy shape, rather than bootstrapping a
    // second database by hand: setupTestDb() owns AGENT_HQ_DB_PATH now. initSchema() creates tasks
    // with IF NOT EXISTS, so the legacy table below is what it has to migrate. Dropping it also
    // drops its indexes, so idx_tasks_generated_lookup really is re-created rather than left over.
    await getDb().exec(`
      DROP TABLE tasks;
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

    // The premise, pinned: setupTestDb() hands over a fully-migrated tasks table, so if the drop
    // above ever stopped working this test would assert the migration's outcome against a table
    // that never needed migrating, and pass for no reason.
    const before = await getDb().all(`PRAGMA table_info(tasks)`) as Array<{ name: string }>;
    expect(before.map(col => col.name)).not.toContain('recurring_series_id');

    await initSchema();

    const db = getDb();
    const columns = await db.all(`PRAGMA table_info(tasks)`) as Array<{ name: string }>;
    expect(columns.map(col => col.name)).toEqual(expect.arrayContaining([
      'recurring_series_id',
      'scheduled_for',
      'schedule_run_id',
      'generated_from',
    ]));
    expect(await db.get(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_tasks_generated_lookup'
    `)).toEqual({ name: 'idx_tasks_generated_lookup' });
  });
});
