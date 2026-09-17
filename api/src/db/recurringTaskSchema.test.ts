import { getDb } from './client';
import { setupTestDb, teardownTestDb } from './testDb';
import { getDefaultTenantId } from '../lib/tenantContext';
import { createTaskRecord } from '../domains/tasks/writeModel';
import { getTaskById, listTasks, searchTasks, searchProjectTasks, listRecentlyCompletedTasks } from '../domains/tasks/readModel';
import { buildTaskContext } from '../domains/tasks/context';
import { loadTaskRecurrenceMetadata } from '../domains/tasks/recurrence';
import { buildDispatchContextBundle } from '../services/dispatch/prompt/dispatchContext';
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
const UNIQUE_VIOLATION = 'duplicate key value violates unique constraint';

const LOOKUP_INDEXES = [
  'idx_recurring_task_series_due',
  'idx_recurring_task_runs_series_history',
  'idx_tasks_generated_lookup',
  'idx_tasks_generated_occurrence_unique',
];

/** Read the PostgreSQL catalog rather than inferring index existence from behavior. */
async function lookupIndexNames(): Promise<string[]> {
  const db = getDb();
  const placeholders = LOOKUP_INDEXES.map(() => '?').join(', ');
  const rows = await db.all(`
        SELECT indexname AS name
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (${placeholders})
        ORDER BY indexname ASC
      `, ...LOOKUP_INDEXES);
  return (rows as Array<{ name: string }>).map(row => row.name);
}

describe('recurring task scheduling schema', () => {
  beforeEach(async () => {
    const db = await setupTestDb();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Recurring Tasks', 'recurring-tasks', 1)`);
    await db.run(`
      INSERT INTO app_settings (key, value)
      VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')
    `);
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  async function seedProjectWorkflow(): Promise<void> {
    const db = getDb();
    // The real baseline carries the foreign keys the hand-written fixture schema never had:
    // projects/workflows/agents all point at tenants, and recurring_task_series points at all three.
    // So the tenant has to exist before its children rather than being left implicit.
    const tenantId = await getDefaultTenantId(db);
    await db.run(`
      INSERT INTO projects (id, tenant_id, name, description, context_md)
      VALUES (612, ?, 'Recurring Tasks', '', '')
    `, tenantId);
    await db.run(`
      INSERT INTO workflows (id, tenant_id, project_id, name, goal, workflow_type, status, length_kind, length_value)
      VALUES (6121, ?, 612, 'Fixed Workflow', '', 'dev', 'active', 'time', '2w')
    `, tenantId);
    await db.run(`
      INSERT INTO agents (id, tenant_id, name, role, session_key)
      VALUES (6122, ?, 'Pinned Backend', 'backend', 'agent:pinned-backend:main')
    `, tenantId);
  }

  it('creates a fixed-workflow series, records a run, and links the generated task metadata', async () => {
    const db = getDb();
    await seedProjectWorkflow();

    const series = await createRecurringTaskSeries(db, {
          project_id: 612,
          workflow_id: 6121,
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
          workflow_id: 6121,
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
      workflow_id: 6121,
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

    const taskId = Number(task.id);
    const provenance = { recurring_series_id: series.id, schedule_run_id: run.id,
      scheduled_for: run.scheduled_for, generated_from: 'recurring_task_series' };
    expect(await getTaskById(db, taskId)).toMatchObject(provenance);
    expect(await listTasks(db, { project_id: 612 })).toEqual(expect.arrayContaining([expect.objectContaining(provenance)]));
    expect(await listTasks(db, { project_id: 612, limit: 10 })).toMatchObject({ tasks: [expect.objectContaining(provenance)] });
    expect(await searchTasks(db, { q: 'Weekly', project_id: 612 })).toEqual([expect.objectContaining(provenance)]);
    expect(await searchProjectTasks(db, { tenant_id: 1, project_id: 612 })).toMatchObject({ tasks: [expect.objectContaining(provenance)] });
    for (const mode of ['summary', 'full'] as const) {
      expect(await buildTaskContext(taskId, mode)).toMatchObject({ task: provenance });
    }
    const dispatchProvenance = await loadTaskRecurrenceMetadata(db, taskId);
    expect(dispatchProvenance).toEqual(provenance);
    const bundle = buildDispatchContextBundle({ task: {
      id: taskId, title: String(task.title), description: '', priority: 'high', status: 'in_progress', ...dispatchProvenance,
    } });
    expect(bundle.segments.find(segment => segment.kind === 'task')?.source.detail).toMatchObject(provenance);
    expect(bundle.promptText).toContain(JSON.stringify(dispatchProvenance));

    await db.run(`UPDATE tasks SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, taskId);
    expect(await listRecentlyCompletedTasks(db, 24, 612, 1)).toMatchObject({ tasks: [expect.objectContaining(provenance)] });
  });

  it('returns explicit null provenance for ordinary tasks on compact and full reads', async () => {
    const db = getDb();
    await seedProjectWorkflow();
    const task = await createTaskRecord(db, {
      title: 'Ordinary maintenance', project_id: 612, workflow_id: 6121, task_type: 'backend',
    }, 'test');
    const empty = { recurring_series_id: null, scheduled_for: null, schedule_run_id: null, generated_from: null };
    expect(await getTaskById(db, Number(task.id))).toMatchObject(empty);
    expect(await searchTasks(db, { q: 'Ordinary', project_id: 612 })).toEqual([expect.objectContaining(empty)]);
    expect(await searchProjectTasks(db, { tenant_id: 1, project_id: 612 })).toMatchObject({ tasks: [expect.objectContaining(empty)] });
    expect(await buildTaskContext(Number(task.id))).toMatchObject({ task: empty });
    expect(await loadTaskRecurrenceMetadata(db, Number(task.id))).toEqual(empty);
  });

  it('prevents duplicate occurrences for the same series and scheduled time', async () => {
    const db = getDb();
    await seedProjectWorkflow();

    const series = await createRecurringTaskSeries(db, {
          project_id: 612,
          workflow_id: 6121,
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

    // Match the concrete PostgreSQL unique-constraint error rather than accepting any rejection.
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
            workflow_id: 6121,
            task_type: 'qa',
            story_points: 1,
            recurring_series_id: series.id,
            scheduled_for: scheduledFor,
            schedule_run_id: run.id,
            generated_from: 'recurring_task_series',
          }, 'scheduler');

    // The second occurrence must fail for the intended unique index, not another constraint.
    await expect((async () => await createTaskRecord(db, {
                title: 'Daily QA sweep duplicate',
                status: 'in_progress',
                project_id: 612,
                workflow_id: 6121,
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
