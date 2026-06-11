import type Database from 'better-sqlite3';
import { createTaskRecord } from '../domains/tasks/writeModel';
import {
  finishRecurringTaskRun,
  linkRecurringRunToGeneratedTask,
  recordRecurringTaskRun,
} from '../domains/recurring-tasks';
import type { RecurringTaskRunRecord, RecurringTaskSeriesRecord } from '../domains/recurring-tasks';
import { isTaskStatus, TERMINAL_TASK_STATUSES } from '../lib/taskStatuses';
import { isValidTaskType } from '../lib/taskTypes';
import { isTaskTypeAllowedForSprintType } from '../domains/sprint-definitions/config';
import { listSprintTaskStatuses } from '../domains/routing/policy/statuses';

const DEFAULT_LIMIT = 25;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const RECURRING_GENERATED_FROM = 'recurring_task_series';
const MINUTE_INTERVAL_MIN = 5;
const MINUTE_INTERVAL_MAX = 1440;

type Weekday = typeof WEEKDAYS[number];

interface DueSeriesRow extends RecurringTaskSeriesRecord {}

interface SprintRow {
  id: number;
  project_id: number;
  sprint_type: string | null;
  status: string;
}

export interface RecurringTaskSchedulerSummary {
  checked: number;
  created: number;
  skipped: number;
  failed: number;
  duplicates: number;
  errors: string[];
}

interface ParsedSchedule {
  kind: 'minutes' | 'daily' | 'weekly' | 'weekdays';
  hour?: number;
  minute?: number;
  intervalMinutes?: number;
  weekday?: number;
}

function parseSimpleSchedule(expression: string): ParsedSchedule {
  const normalized = expression.trim().toLowerCase().replace(/\s+/g, ' ');
  const minutes = /^every ([1-9]\d*) minutes?$/.exec(normalized);
  if (minutes) {
    const intervalMinutes = Number(minutes[1]);
    if (intervalMinutes < MINUTE_INTERVAL_MIN || intervalMinutes > MINUTE_INTERVAL_MAX) {
      throw new Error(`Invalid recurring schedule interval "${intervalMinutes}". Minute intervals must be between ${MINUTE_INTERVAL_MIN} and ${MINUTE_INTERVAL_MAX}.`);
    }
    return { kind: 'minutes', intervalMinutes };
  }

  const match = /^(?:every\s+)?(day|daily|weekday|weekdays|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+(\d{1,2}):(\d{2})$/.exec(normalized);
  if (!match) {
    throw new Error(`Unsupported recurring schedule "${expression}". Expected examples: "every 15 minutes", "every day 10:00", or "every monday 09:00".`);
  }

  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid recurring schedule time "${match[2]}:${match[3]}"`);
  }

  const cadence = match[1];
  if (cadence === 'day' || cadence === 'daily') return { kind: 'daily', hour, minute };
  if (cadence === 'weekday' || cadence === 'weekdays') return { kind: 'weekdays', hour, minute };
  return { kind: 'weekly', hour, minute, weekday: WEEKDAYS.indexOf(cadence as Weekday) };
}

function zonedParts(date: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function partsToUtcMs(parts: { year: number; month: number; day: number; hour: number; minute: number; second?: number }, timezone: string): number {
  let utcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second ?? 0, 0);
  for (let i = 0; i < 4; i += 1) {
    const projected = zonedParts(new Date(utcMs), timezone);
    const projectedMs = Date.UTC(projected.year, projected.month - 1, projected.day, projected.hour, projected.minute, projected.second, 0);
    const desiredMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second ?? 0, 0);
    const delta = projectedMs - desiredMs;
    if (delta === 0) break;
    utcMs -= delta;
  }
  return utcMs;
}

function addLocalDays(parts: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0, 0));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function weekdayForLocalDate(parts: { year: number; month: number; day: number }): number {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0, 0)).getUTCDay();
}

export function calculateNextRecurringRunAt(scheduleExpression: string, timezone: string, after: Date): string {
  const schedule = parseSimpleSchedule(scheduleExpression);
  if (schedule.kind === 'minutes') {
    const nextMs = after.getTime() + (schedule.intervalMinutes ?? MINUTE_INTERVAL_MIN) * 60_000;
    return new Date(nextMs - (nextMs % 60_000)).toISOString();
  }
  const afterLocal = zonedParts(after, timezone);

  for (let offset = 0; offset <= 14; offset += 1) {
    const localDate = addLocalDays(afterLocal, offset);
    const weekday = weekdayForLocalDate(localDate);
    if (schedule.kind === 'weekly' && weekday !== schedule.weekday) continue;
    if (schedule.kind === 'weekdays' && (weekday === 0 || weekday === 6)) continue;

    const candidateMs = partsToUtcMs({
      ...localDate,
      hour: schedule.hour ?? 0,
      minute: schedule.minute ?? 0,
      second: 0,
    }, timezone);
    if (candidateMs > after.getTime()) {
      return new Date(candidateMs).toISOString();
    }
  }

  throw new Error(`Could not calculate next run for schedule "${scheduleExpression}" in timezone "${timezone}"`);
}

function loadDueSeries(db: Database.Database, nowIso: string, limit: number): DueSeriesRow[] {
  return db.prepare(`
    SELECT *
    FROM recurring_task_series
    WHERE enabled = 1
      AND next_run_at IS NOT NULL
      AND next_run_at <= ?
    ORDER BY next_run_at ASC, id ASC
    LIMIT ?
  `).all(nowIso, limit) as DueSeriesRow[];
}

function loadSprint(db: Database.Database, sprintId: number): SprintRow | null {
  return db.prepare(`
    SELECT id, project_id, sprint_type, status
    FROM sprints
    WHERE id = ?
    LIMIT 1
  `).get(sprintId) as SprintRow | undefined ?? null;
}

function activeGeneratedTaskId(db: Database.Database, series: RecurringTaskSeriesRecord): number | null {
  const statuses = listSprintTaskStatuses(db, series.sprint_id);
  const configuredTerminalStatuses = statuses.filter(status => status.terminal).map(status => status.name);
  const terminalStatuses = configuredTerminalStatuses.length > 0
    ? configuredTerminalStatuses
    : [...TERMINAL_TASK_STATUSES];
  const placeholders = terminalStatuses.map(() => '?').join(', ');
  const row = db.prepare(`
    SELECT id
    FROM tasks
    WHERE recurring_series_id = ?
      AND generated_from = ?
      AND status NOT IN (${placeholders})
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `).get(series.id, RECURRING_GENERATED_FROM, ...terminalStatuses) as { id: number } | undefined;
  return row?.id ?? null;
}

function validateSeriesForCreation(db: Database.Database, series: RecurringTaskSeriesRecord, sprint: SprintRow): void {
  if (!isValidTaskType(series.task_type)) {
    throw new Error(`invalid_task_type: "${series.task_type}" is not a valid task type`);
  }
  if (!isTaskStatus(series.status_on_create)) {
    throw new Error(`invalid_status_on_create: "${series.status_on_create}" is not a valid task status`);
  }
  if (!isTaskTypeAllowedForSprintType(db, sprint.sprint_type ?? 'generic', series.task_type)) {
    throw new Error(`invalid_task_type: "${series.task_type}" is not allowed for sprint type "${sprint.sprint_type ?? 'generic'}"`);
  }
  const sprintStatuses = listSprintTaskStatuses(db, series.sprint_id);
  if (sprintStatuses.length > 0 && !sprintStatuses.some(status => status.name === series.status_on_create)) {
    throw new Error(`invalid_status_on_create: "${series.status_on_create}" is not configured for sprint ${series.sprint_id}`);
  }
}

function createStartedRun(db: Database.Database, series: RecurringTaskSeriesRecord, scheduledFor: string): RecurringTaskRunRecord | null {
  try {
    return recordRecurringTaskRun(db, {
      series_id: series.id,
      scheduled_for: scheduledFor,
      status: 'started',
      idempotency_key: `${series.id}:${scheduledFor}`,
    });
  } catch (err) {
    const existing = db.prepare(`
      SELECT *
      FROM recurring_task_runs
      WHERE series_id = ? AND scheduled_for = ?
      LIMIT 1
    `).get(series.id, scheduledFor) as RecurringTaskRunRecord | undefined;
    if (existing) return null;
    throw err;
  }
}

function advanceSeries(db: Database.Database, series: RecurringTaskSeriesRecord, scheduledFor: string, options: { disable?: boolean; nextRunAt?: string } = {}): string | null {
  const nextRunAt = options.disable
    ? null
    : options.nextRunAt ?? calculateNextRecurringRunAt(series.schedule_expression, series.timezone, new Date(scheduledFor));
  db.prepare(`
    UPDATE recurring_task_series
    SET last_run_at = ?,
        next_run_at = ?,
        enabled = CASE WHEN ? THEN 0 ELSE enabled END,
        updated_at = datetime('now'),
        updated_by = 'recurring-task-scheduler'
    WHERE id = ?
  `).run(scheduledFor, nextRunAt, options.disable ? 1 : 0, series.id);
  return nextRunAt;
}

function finishAndAdvance(
  db: Database.Database,
  series: RecurringTaskSeriesRecord,
  runId: number,
  scheduledFor: string,
  status: 'skipped' | 'failed',
  reason: string,
  disable = false,
): void {
  finishRecurringTaskRun(db, runId, { status, error_message: reason });
  advanceSeries(db, series, scheduledFor, { disable });
}

function processDueSeries(db: Database.Database, series: RecurringTaskSeriesRecord): 'created' | 'skipped' | 'failed' | 'duplicate' {
  const scheduledFor = series.next_run_at;
  if (!scheduledFor) return 'skipped';

  const tx = db.transaction(() => {
    const fresh = db.prepare(`SELECT * FROM recurring_task_series WHERE id = ?`).get(series.id) as RecurringTaskSeriesRecord | undefined;
    if (!fresh || fresh.enabled !== 1 || !fresh.next_run_at || fresh.next_run_at !== scheduledFor) return 'duplicate' as const;

    const run = createStartedRun(db, fresh, scheduledFor);
    if (!run) return 'duplicate' as const;

    const sprint = loadSprint(db, fresh.sprint_id);
    if (!sprint || sprint.status === 'closed' || sprint.status === 'complete') {
      finishAndAdvance(db, fresh, run.id, scheduledFor, 'failed', `fixed_sprint_unavailable: sprint ${fresh.sprint_id} is ${sprint?.status ?? 'missing'}`, true);
      return 'failed' as const;
    }

    let nextRunAt: string;
    try {
      nextRunAt = calculateNextRecurringRunAt(fresh.schedule_expression, fresh.timezone, new Date(scheduledFor));
    } catch (err) {
      finishAndAdvance(db, fresh, run.id, scheduledFor, 'failed', `invalid_schedule: ${err instanceof Error ? err.message : String(err)}`, true);
      return 'failed' as const;
    }

    if (sprint.status === 'paused') {
      finishRecurringTaskRun(db, run.id, { status: 'skipped', error_message: `sprint_paused: sprint ${fresh.sprint_id} is paused` });
      advanceSeries(db, fresh, scheduledFor, { nextRunAt });
      return 'skipped' as const;
    }

    try {
      validateSeriesForCreation(db, fresh, sprint);
    } catch (err) {
      finishAndAdvance(db, fresh, run.id, scheduledFor, 'failed', err instanceof Error ? err.message : String(err), true);
      return 'failed' as const;
    }

    if (fresh.overlap_policy === 'skip_if_active') {
      const blockingTaskId = activeGeneratedTaskId(db, fresh);
      if (blockingTaskId != null) {
        finishRecurringTaskRun(db, run.id, { status: 'skipped', error_message: `active_task_exists: task ${blockingTaskId}` });
        advanceSeries(db, fresh, scheduledFor, { nextRunAt });
        return 'skipped' as const;
      }
    }

    try {
      const task = createTaskRecord(db, {
        title: fresh.title_template,
        description: fresh.description_template,
        status: fresh.status_on_create,
        priority: fresh.priority,
        project_id: fresh.project_id,
        sprint_id: fresh.sprint_id,
        agent_id: fresh.agent_id,
        task_type: fresh.task_type,
        story_points: fresh.story_points,
        recurring_series_id: fresh.id,
        scheduled_for: scheduledFor,
        schedule_run_id: run.id,
        generated_from: RECURRING_GENERATED_FROM,
      }, 'recurring-task-scheduler');
      linkRecurringRunToGeneratedTask(db, run.id, Number(task.id));
      advanceSeries(db, fresh, scheduledFor, { nextRunAt });
      return 'created' as const;
    } catch (err) {
      finishRecurringTaskRun(db, run.id, { status: 'failed', error_message: err instanceof Error ? err.message : String(err) });
      advanceSeries(db, fresh, scheduledFor, { nextRunAt });
      return 'failed' as const;
    }
  });

  return tx();
}

export function runRecurringTaskSchedulerTick(
  db: Database.Database,
  options: { now?: Date; limit?: number } = {},
): RecurringTaskSchedulerSummary {
  const now = options.now ?? new Date();
  const dueSeries = loadDueSeries(db, now.toISOString(), options.limit ?? DEFAULT_LIMIT);
  const summary: RecurringTaskSchedulerSummary = {
    checked: dueSeries.length,
    created: 0,
    skipped: 0,
    failed: 0,
    duplicates: 0,
    errors: [],
  };

  for (const series of dueSeries) {
    try {
      const result = processDueSeries(db, series);
      if (result === 'created') summary.created += 1;
      else if (result === 'skipped') summary.skipped += 1;
      else if (result === 'failed') summary.failed += 1;
      else summary.duplicates += 1;
    } catch (err) {
      summary.failed += 1;
      summary.errors.push(`series ${series.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (summary.created > 0 || summary.skipped > 0 || summary.failed > 0 || summary.errors.length > 0) {
    console.log(`[recurring-task-scheduler] checked=${summary.checked} created=${summary.created} skipped=${summary.skipped} failed=${summary.failed} duplicates=${summary.duplicates} errors=${summary.errors.length}`);
  }

  return summary;
}
