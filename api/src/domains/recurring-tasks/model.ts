import { listSprintTaskStatuses } from '../routing/policy/statuses';
import { createTaskRecord } from '../tasks/writeModel';
import { VALID_STORY_POINTS } from '../tasks/fields';
import { isTaskStatus } from '../../lib/taskStatuses';
import { isValidTaskType } from '../../lib/taskTypes';
import { isTaskTypeAllowedForSprintType } from '../sprint-definitions/config';
import type {
  RecurringTaskOverlapPolicy,
  RecurringTaskRunRecord,
  RecurringTaskRunStatus,
  RecurringTaskRunWithTask,
  RecurringTaskSeriesListItem,
  RecurringTaskSeriesRecord,
} from './types';
import { type Db } from "../../db/adapter/types";

export interface CreateRecurringTaskSeriesInput {
  tenant_id?: number | null;
  project_id: number;
  sprint_id: number;
  workflow_id?: number;
  title_template: string;
  description_template?: string;
  task_type: string;
  priority: 'low' | 'medium' | 'high';
  story_points: number;
  status_on_create: string;
  schedule_expression: string;
  timezone: string;
  enabled?: number | boolean;
  next_run_at?: string | null;
  last_run_at?: string | null;
  overlap_policy?: RecurringTaskOverlapPolicy;
  agent_id?: number | null;
  created_by?: string;
  updated_by?: string;
}

export interface RecordRecurringTaskRunInput {
  series_id: number;
  scheduled_for: string;
  created_task_id?: number | null;
  status: RecurringTaskRunStatus;
  error_message?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  idempotency_key: string;
}

export interface RecurringTaskSeriesFilters {
  tenant_id?: unknown;
  project_id?: unknown;
  sprint_id?: unknown;
  workflow_id?: unknown;
  enabled?: unknown;
  next_run_from?: unknown;
  next_run_to?: unknown;
  limit?: unknown;
  offset?: unknown;
}

export interface UpdateRecurringTaskSeriesInput extends Partial<CreateRecurringTaskSeriesInput> {}

export interface SchedulePreview {
  schedule_expression: string;
  schedule: string;
  timezone: string;
  occurrences: string[];
}

type SprintValidationRow = {
  id: number;
  tenant_id: number | null;
  project_id: number;
  sprint_type: string | null;
  status: string | null;
  name: string | null;
};

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const MINUTE_INTERVAL_MIN = 5;
const MINUTE_INTERVAL_MAX = 1440;
const TERMINAL_SPRINT_STATUSES = new Set(['complete', 'closed', 'archived', 'deleted']);

function badRequest(message: string, code?: string): Error & { status?: number; code?: string } {
  const err = new Error(message) as Error & { status?: number; code?: string };
  err.status = 400;
  if (code) err.code = code;
  return err;
}

function notFound(message: string, code?: string): Error & { status?: number; code?: string } {
  const err = new Error(message) as Error & { status?: number; code?: string };
  err.status = 404;
  if (code) err.code = code;
  return err;
}

function parsePositiveInteger(raw: unknown, fieldName: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw badRequest(`${fieldName} is required`, `${fieldName}_required`);
  return value;
}

function coalesceWorkflowId(input: { sprint_id?: unknown; workflow_id?: unknown }): unknown {
  if (input.workflow_id !== undefined && input.sprint_id !== undefined && String(input.workflow_id) !== String(input.sprint_id)) {
    throw badRequest('workflow_id conflicts with sprint_id', 'workflow_id_conflict');
  }
  return input.workflow_id !== undefined ? input.workflow_id : input.sprint_id;
}

function parseOptionalPositiveInteger(raw: unknown, fieldName: string): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw badRequest(`${fieldName} must be a positive integer`, `${fieldName}_invalid`);
  return value;
}

function parseRequiredString(raw: unknown, fieldName: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw badRequest(`${fieldName} is required`, `${fieldName}_required`);
  return value;
}

function parseOptionalString(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw.trim() : undefined;
}

function parseBooleanInt(raw: unknown, defaultValue: number): number {
  if (raw === undefined) return defaultValue;
  if (raw === true || raw === 1 || raw === '1' || raw === 'true') return 1;
  if (raw === false || raw === 0 || raw === '0' || raw === 'false') return 0;
  throw badRequest('enabled must be a boolean', 'enabled_invalid');
}

function parsePriority(raw: unknown): 'low' | 'medium' | 'high' {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  throw badRequest('priority must be low, medium, or high', 'priority_invalid');
}

function parseOverlapPolicy(raw: unknown): RecurringTaskOverlapPolicy {
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : 'skip_if_active';
  if (value === 'skip_if_active' || value === 'create_anyway') return value;
  throw badRequest('overlap_policy must be skip_if_active or create_anyway', 'overlap_policy_invalid');
}

function parseStoryPoints(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || !VALID_STORY_POINTS.includes(value as typeof VALID_STORY_POINTS[number])) {
    throw badRequest(`Invalid story_points "${raw}". Valid: ${VALID_STORY_POINTS.join(', ')}`, 'story_points_invalid');
  }
  return value;
}

function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw badRequest('timezone must be a valid IANA timezone', 'timezone_invalid');
  }
}

function parseSchedule(schedule: string): { kind: 'minutes'; intervalMinutes: number } | { kind: 'daily' | 'weekly'; weekday?: number; hour: number; minute: number } {
  const normalized = schedule.trim().toLowerCase().replace(/\s+/g, ' ');
  const minutes = /^every ([1-9]\d*) minutes?$/.exec(normalized);
  if (minutes) {
    const intervalMinutes = Number(minutes[1]);
    if (intervalMinutes < MINUTE_INTERVAL_MIN || intervalMinutes > MINUTE_INTERVAL_MAX) {
      throw badRequest(`minute schedule interval must be between ${MINUTE_INTERVAL_MIN} and ${MINUTE_INTERVAL_MAX} minutes`, 'schedule_interval_invalid');
    }
    return { kind: 'minutes', intervalMinutes };
  }

  const daily = /^every day(?: at)? ([01]\d|2[0-3]):([0-5]\d)$/.exec(normalized);
  if (daily) return { kind: 'daily', hour: Number(daily[1]), minute: Number(daily[2]) };

  const weekly = /^every (sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?: at)? ([01]\d|2[0-3]):([0-5]\d)$/.exec(normalized);
  if (weekly) {
    return {
      kind: 'weekly',
      weekday: WEEKDAY_INDEX[weekly[1]],
      hour: Number(weekly[2]),
      minute: Number(weekly[3]),
    };
  }

  throw badRequest(`schedule must match "every N minutes" (${MINUTE_INTERVAL_MIN}-${MINUTE_INTERVAL_MAX}), "every day HH:mm", or "every <weekday> HH:mm"`, 'schedule_invalid');
}

function getTimezoneParts(date: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return {
    year: Number(value('year')),
    month: Number(value('month')),
    day: Number(value('day')),
    hour: Number(value('hour')),
    minute: Number(value('minute')),
    second: Number(value('second')),
    weekday: WEEKDAY_INDEX[value('weekday').toLowerCase()],
  };
}

function timezoneOffsetMs(date: Date, timezone: string): number {
  const parts = getTimezoneParts(date, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function localDateTimeToUtcIso(
  timezone: string,
  local: { year: number; month: number; day: number; hour: number; minute: number },
): string {
  let utcMs = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0, 0);
  utcMs -= timezoneOffsetMs(new Date(utcMs), timezone);
  utcMs -= timezoneOffsetMs(new Date(utcMs), timezone) - timezoneOffsetMs(new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0, 0)), timezone);
  return new Date(utcMs).toISOString();
}

function addLocalDays(local: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day + days, 12, 0, 0, 0));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function previewRecurringTaskSchedule(
  scheduleExpression: unknown,
  timezone: unknown,
  count = 5,
  fromDate = new Date(),
): SchedulePreview {
  const expression = parseRequiredString(scheduleExpression, 'schedule');
  const resolvedTimezone = parseRequiredString(timezone, 'timezone');
  const schedule = parseSchedule(expression);
  assertValidTimezone(resolvedTimezone);
  const desiredCount = Math.max(1, Math.min(20, count));
  const occurrences: string[] = [];
  if (schedule.kind === 'minutes') {
    let nextMs = fromDate.getTime() + schedule.intervalMinutes * 60_000;
    nextMs -= nextMs % 60_000;
    for (let i = 0; i < desiredCount; i += 1) {
      occurrences.push(new Date(nextMs + (i * schedule.intervalMinutes * 60_000)).toISOString());
    }
    return {
      schedule_expression: expression,
      schedule: expression,
      timezone: resolvedTimezone,
      occurrences,
    };
  }

  const fromLocal = getTimezoneParts(fromDate, resolvedTimezone);
  for (let dayOffset = 0; occurrences.length < desiredCount && dayOffset < 370; dayOffset += 1) {
    const localDay = addLocalDays(fromLocal, dayOffset);
    const noonUtc = localDateTimeToUtcIso(resolvedTimezone, { ...localDay, hour: 12, minute: 0 });
    const weekday = getTimezoneParts(new Date(noonUtc), resolvedTimezone).weekday;
    if (schedule.kind === 'weekly' && weekday !== schedule.weekday) continue;
    const candidateIso = localDateTimeToUtcIso(resolvedTimezone, { ...localDay, hour: schedule.hour, minute: schedule.minute });
    if (new Date(candidateIso).getTime() <= fromDate.getTime()) continue;
    occurrences.push(candidateIso);
  }
  return {
    schedule_expression: expression,
    schedule: expression,
    timezone: resolvedTimezone,
    occurrences,
  };
}

function calculateNextRunAt(scheduleExpression: string, timezone: string, enabled: number): string | null {
  if (!enabled) return null;
  return previewRecurringTaskSchedule(scheduleExpression, timezone, 1).occurrences[0] ?? null;
}

async function requireProject(db: Db, projectId: number, tenantId: number | null): Promise<number | null> {
  const row = await db.get(`SELECT id, tenant_id FROM projects WHERE id = ? LIMIT 1`, projectId) as { id: number; tenant_id: number | null } | undefined;
  if (!row) throw badRequest(`project_id ${projectId} does not exist`, 'project_not_found');
  if (tenantId != null && row.tenant_id !== tenantId) {
    throw badRequest(`project_id ${projectId} is not available in this tenant`, 'project_not_found');
  }
  return row.tenant_id ?? tenantId;
}

async function requireSprintForProject(db: Db, projectId: number, sprintId: number, enabled: number, tenantId: number | null): Promise<SprintValidationRow> {
  const row = await db.get(`
    SELECT id, tenant_id, project_id, sprint_type, status, name
    FROM sprints
    WHERE id = ?
    LIMIT 1
  `, sprintId) as SprintValidationRow | undefined;
  if (!row) throw badRequest(`workflow_id ${sprintId} does not exist`, 'workflow_not_found');
  if (tenantId != null && row.tenant_id !== tenantId) {
    throw badRequest(`workflow_id ${sprintId} is not available in this tenant`, 'workflow_not_found');
  }
  if (row.project_id !== projectId) {
    throw badRequest(`workflow_id ${sprintId} does not belong to project_id ${projectId}`, 'workflow_project_mismatch');
  }
  if (enabled && row.status && TERMINAL_SPRINT_STATUSES.has(row.status)) {
    throw badRequest(`workflow_id ${sprintId} is not available for enabled recurring series`, 'fixed_workflow_unavailable');
  }
  return row;
}

async function requireAgent(db: Db, agentId: number | null, tenantId: number | null): Promise<void> {
  if (agentId == null) return;
  const row = await db.get(`SELECT id, tenant_id FROM agents WHERE id = ? LIMIT 1`, agentId) as { id: number; tenant_id: number | null } | undefined;
  if (!row) throw badRequest(`agent_id ${agentId} does not exist`, 'agent_not_found');
  if (tenantId != null && row.tenant_id !== tenantId) {
    throw badRequest(`agent_id ${agentId} is not available in this tenant`, 'agent_not_found');
  }
}

async function validateWorkflowFields(db: Db, sprint: SprintValidationRow, taskType: string, statusOnCreate: string): Promise<void> {
  if (!isValidTaskType(taskType)) {
    throw badRequest(`task_type "${taskType}" is not supported`, 'task_type_unsupported');
  }
  if (!await isTaskTypeAllowedForSprintType(db, sprint.sprint_type ?? 'generic', taskType)) {
    throw badRequest(`task_type "${taskType}" is not allowed for sprint type "${sprint.sprint_type ?? 'generic'}"`, 'task_type_not_allowed_for_sprint_type');
  }
  if (!isTaskStatus(statusOnCreate)) {
    throw badRequest(`status_on_create "${statusOnCreate}" is not supported`, 'status_on_create_unsupported');
  }
  const statuses = (await listSprintTaskStatuses(db, sprint.id)).map(status => status.name);
  if (statuses.length > 0 && !statuses.includes(statusOnCreate)) {
    throw badRequest(`status_on_create "${statusOnCreate}" is not valid for workflow_id ${sprint.id}`, 'status_on_create_not_allowed_for_workflow');
  }
}

async function normalizeCreateInput(db: Db, input: CreateRecurringTaskSeriesInput): Promise<CreateRecurringTaskSeriesInput> {
  const projectId = parsePositiveInteger(input.project_id, 'project_id');
  const sprintId = parsePositiveInteger(coalesceWorkflowId(input), 'workflow_id');
  const titleTemplate = parseRequiredString(input.title_template, 'title_template');
  const taskType = parseRequiredString(input.task_type, 'task_type');
  const statusOnCreate = parseRequiredString(input.status_on_create, 'status_on_create');
  const scheduleExpression = parseRequiredString((input as CreateRecurringTaskSeriesInput & { schedule?: unknown }).schedule ?? input.schedule_expression, 'schedule');
  const timezone = parseRequiredString(input.timezone, 'timezone');
  const enabled = parseBooleanInt(input.enabled, 1);
  const agentId = parseOptionalPositiveInteger(input.agent_id, 'agent_id');
  const requestedTenantId = parseOptionalPositiveInteger(input.tenant_id, 'tenant_id');

  parseSchedule(scheduleExpression);
  assertValidTimezone(timezone);
  const tenantId = await requireProject(db, projectId, requestedTenantId);
  const sprint = await requireSprintForProject(db, projectId, sprintId, enabled, tenantId);
  await requireAgent(db, agentId, tenantId);
  await validateWorkflowFields(db, sprint, taskType, statusOnCreate);

  return {
    ...input,
    tenant_id: tenantId,
    project_id: projectId,
    sprint_id: sprintId,
    title_template: titleTemplate,
    description_template: parseOptionalString(input.description_template) ?? '',
    task_type: taskType,
    priority: parsePriority(input.priority),
    story_points: parseStoryPoints(input.story_points),
    status_on_create: statusOnCreate,
    schedule_expression: scheduleExpression,
    timezone,
    enabled,
    next_run_at: input.next_run_at ?? calculateNextRunAt(scheduleExpression, timezone, enabled),
    overlap_policy: parseOverlapPolicy(input.overlap_policy),
    agent_id: agentId,
  };
}

function normalizeSeries(row: RecurringTaskSeriesListItem | RecurringTaskSeriesRecord): Record<string, unknown> {
  const enriched = row as RecurringTaskSeriesListItem;
  return {
    ...row,
    workflow_id: row.sprint_id,
    workflow_name: enriched.sprint_name ?? null,
    workflow_status: enriched.sprint_status ?? null,
    workflow_type: enriched.sprint_type ?? null,
    enabled: Boolean(row.enabled),
    schedule: row.schedule_expression,
    agent_pin: row.agent_id == null ? null : {
      agent_id: row.agent_id,
      behavior: 'optional_pinned_assignment',
      note: 'Generated tasks receive this agent assignment, but routing and dispatch still use the normal task workflow.',
    },
  };
}

export async function createRecurringTaskSeries(
  db: Db,
  input: CreateRecurringTaskSeriesInput,
): Promise<RecurringTaskSeriesRecord> {
  const normalized = await normalizeCreateInput(db, input);
  const result = await db.run(`
    INSERT INTO recurring_task_series (
      tenant_id, project_id, sprint_id, title_template, description_template, task_type, priority,
      story_points, status_on_create, schedule_expression, timezone, enabled,
      next_run_at, last_run_at, overlap_policy, agent_id, created_by, updated_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, normalized.tenant_id ?? null, normalized.project_id, normalized.sprint_id, normalized.title_template, normalized.description_template ?? '', normalized.task_type, normalized.priority, normalized.story_points, normalized.status_on_create, normalized.schedule_expression, normalized.timezone, normalized.enabled, normalized.next_run_at ?? null, normalized.last_run_at ?? null, normalized.overlap_policy ?? 'skip_if_active', normalized.agent_id ?? null, normalized.created_by ?? 'system', normalized.updated_by ?? normalized.created_by ?? 'system');

  return await db.get(`SELECT * FROM recurring_task_series WHERE id = ?`, result.lastInsertId) as RecurringTaskSeriesRecord;
}

export async function listRecurringTaskSeries(
  db: Db,
  filters: RecurringTaskSeriesFilters = {},
): Promise<{ series: Array<Record<string, unknown>>; total: number; limit: number; offset: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const tenantId = parseOptionalPositiveInteger(filters.tenant_id, 'tenant_id');
  const projectId = parseOptionalPositiveInteger(filters.project_id, 'project_id');
  const sprintId = parseOptionalPositiveInteger(coalesceWorkflowId(filters), 'workflow_id');
  if (tenantId != null) {
    conditions.push('rts.tenant_id = ?');
    params.push(tenantId);
  }
  if (projectId != null) {
    conditions.push('rts.project_id = ?');
    params.push(projectId);
  }
  if (sprintId != null) {
    conditions.push('rts.sprint_id = ?');
    params.push(sprintId);
  }
  if (filters.enabled !== undefined && filters.enabled !== '') {
    conditions.push('rts.enabled = ?');
    params.push(parseBooleanInt(filters.enabled, 1));
  }
  if (typeof filters.next_run_from === 'string' && filters.next_run_from.trim()) {
    conditions.push('rts.next_run_at >= ?');
    params.push(filters.next_run_from.trim());
  }
  if (typeof filters.next_run_to === 'string' && filters.next_run_to.trim()) {
    conditions.push('rts.next_run_at <= ?');
    params.push(filters.next_run_to.trim());
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Math.max(1, Number(filters.limit) || 100), 500);
  const offset = Math.max(0, Number(filters.offset) || 0);
  const series = await db.all(`
    SELECT
      rts.*,
      p.name AS project_name,
      s.name AS sprint_name,
      s.status AS sprint_status,
      s.sprint_type AS sprint_type,
      a.name AS agent_name,
      latest.id AS latest_run_id,
      latest.status AS latest_run_status,
      latest.scheduled_for AS latest_run_scheduled_for,
      latest.created_task_id AS latest_run_created_task_id,
      (
        SELECT COUNT(*)
        FROM recurring_task_runs count_runs
        WHERE count_runs.series_id = rts.id
          AND count_runs.created_task_id IS NOT NULL
      ) AS generated_task_count
    FROM recurring_task_series rts
    LEFT JOIN projects p ON p.id = rts.project_id
    LEFT JOIN sprints s ON s.id = rts.sprint_id
    LEFT JOIN agents a ON a.id = rts.agent_id
    LEFT JOIN recurring_task_runs latest ON latest.id = (
      SELECT rtr.id
      FROM recurring_task_runs rtr
      WHERE rtr.series_id = rts.id
      ORDER BY rtr.scheduled_for DESC, rtr.id DESC
      LIMIT 1
    )
    ${where}
    ORDER BY COALESCE(rts.next_run_at, '9999-12-31T23:59:59.999Z') ASC, rts.id DESC
    LIMIT ? OFFSET ?
  `, ...params, limit, offset) as RecurringTaskSeriesListItem[];
  const total = (await db.get(`SELECT COUNT(*) AS count FROM recurring_task_series rts ${where}`, ...params) as { count: number }).count;
  return { series: series.map(normalizeSeries), total, limit, offset };
}

export async function getRecurringTaskSeries(db: Db, seriesId: number, tenantId?: number | null): Promise<Record<string, unknown> | null> {
  const tenantFilter = tenantId != null ? 'AND rts.tenant_id = ?' : '';
  const params = tenantId != null ? [seriesId, tenantId] : [seriesId];
  const row = await db.get(`
    SELECT
      rts.*,
      p.name AS project_name,
      s.name AS sprint_name,
      s.status AS sprint_status,
      s.sprint_type AS sprint_type,
      a.name AS agent_name,
      latest.id AS latest_run_id,
      latest.status AS latest_run_status,
      latest.scheduled_for AS latest_run_scheduled_for,
      latest.created_task_id AS latest_run_created_task_id,
      (
        SELECT COUNT(*)
        FROM recurring_task_runs count_runs
        WHERE count_runs.series_id = rts.id
          AND count_runs.created_task_id IS NOT NULL
      ) AS generated_task_count
    FROM recurring_task_series rts
    LEFT JOIN projects p ON p.id = rts.project_id
    LEFT JOIN sprints s ON s.id = rts.sprint_id
    LEFT JOIN agents a ON a.id = rts.agent_id
    LEFT JOIN recurring_task_runs latest ON latest.id = (
      SELECT rtr.id
      FROM recurring_task_runs rtr
      WHERE rtr.series_id = rts.id
      ORDER BY rtr.scheduled_for DESC, rtr.id DESC
      LIMIT 1
    )
    WHERE rts.id = ?
      ${tenantFilter}
    LIMIT 1
  `, ...params) as RecurringTaskSeriesListItem | undefined;
  return row ? normalizeSeries(row) : null;
}

export async function updateRecurringTaskSeries(
  db: Db,
  seriesId: number,
  input: UpdateRecurringTaskSeriesInput,
  tenantId?: number | null,
): Promise<RecurringTaskSeriesRecord> {
  const existing = await db.get(`SELECT * FROM recurring_task_series WHERE id = ?${tenantId != null ? ' AND tenant_id = ?' : ''} LIMIT 1`, ...(tenantId != null ? [seriesId, tenantId] : [seriesId])) as RecurringTaskSeriesRecord | undefined;
  if (!existing) throw notFound('Recurring task series not found', 'series_not_found');
  const merged = { ...existing, ...input, next_run_at: input.next_run_at } as CreateRecurringTaskSeriesInput;
  const normalized = await normalizeCreateInput(db, merged);
  await db.run(`
    UPDATE recurring_task_series
    SET project_id = ?, sprint_id = ?, title_template = ?, description_template = ?,
        task_type = ?, priority = ?, story_points = ?, status_on_create = ?,
        schedule_expression = ?, timezone = ?, enabled = ?, next_run_at = ?,
        overlap_policy = ?, agent_id = ?, updated_by = ?, updated_at = datetime('now')
    WHERE id = ?
  `, normalized.project_id, normalized.sprint_id, normalized.title_template, normalized.description_template ?? '', normalized.task_type, normalized.priority, normalized.story_points, normalized.status_on_create, normalized.schedule_expression, normalized.timezone, normalized.enabled, normalized.next_run_at ?? null, normalized.overlap_policy ?? 'skip_if_active', normalized.agent_id ?? null, normalized.updated_by ?? normalized.created_by ?? existing.updated_by ?? 'system', seriesId);
  return await db.get(`SELECT * FROM recurring_task_series WHERE id = ?`, seriesId) as RecurringTaskSeriesRecord;
}

export async function setRecurringTaskSeriesEnabled(
  db: Db,
  seriesId: number,
  enabled: boolean,
  updatedBy = 'system',
  tenantId?: number | null,
): Promise<RecurringTaskSeriesRecord> {
  const existing = await db.get(`SELECT * FROM recurring_task_series WHERE id = ?${tenantId != null ? ' AND tenant_id = ?' : ''} LIMIT 1`, ...(tenantId != null ? [seriesId, tenantId] : [seriesId])) as RecurringTaskSeriesRecord | undefined;
  if (!existing) throw notFound('Recurring task series not found', 'series_not_found');
  const normalized = await normalizeCreateInput(db, { ...existing, enabled: enabled ? 1 : 0, next_run_at: undefined, updated_by: updatedBy });
  await db.run(`
    UPDATE recurring_task_series
    SET enabled = ?, next_run_at = ?, updated_by = ?, updated_at = datetime('now')
    WHERE id = ?
  `, normalized.enabled, normalized.next_run_at ?? null, updatedBy, seriesId);
  return await db.get(`SELECT * FROM recurring_task_series WHERE id = ?`, seriesId) as RecurringTaskSeriesRecord;
}

export async function deleteRecurringTaskSeries(db: Db, seriesId: number, tenantId?: number | null): Promise<{ ok: true; deleted_id: number }> {
  const result = await db.run(`DELETE FROM recurring_task_series WHERE id = ?${tenantId != null ? ' AND tenant_id = ?' : ''}`, ...(tenantId != null ? [seriesId, tenantId] : [seriesId]));
  if (result.changes === 0) throw notFound('Recurring task series not found', 'series_not_found');
  return { ok: true, deleted_id: seriesId };
}

export async function listRecurringTaskRuns(db: Db, seriesId: number, limitRaw: unknown = 25, tenantId?: number | null): Promise<Array<Record<string, unknown>>> {
  const limit = Math.min(Math.max(1, Number(limitRaw) || 25), 100);
  const tenantFilter = tenantId != null ? 'AND rts.tenant_id = ?' : '';
  const params = tenantId != null ? [seriesId, tenantId, limit] : [seriesId, limit];
  const rows = await db.all(`
    SELECT
      rtr.*,
      t.title AS generated_task_title,
      t.status AS generated_task_status
    FROM recurring_task_runs rtr
    JOIN recurring_task_series rts ON rts.id = rtr.series_id
    LEFT JOIN tasks t ON t.id = rtr.created_task_id
    WHERE rtr.series_id = ?
      ${tenantFilter}
    ORDER BY rtr.scheduled_for DESC, rtr.id DESC
    LIMIT ?
  `, ...params) as RecurringTaskRunWithTask[];
  return rows.map(row => ({
    ...row,
    generated_task: row.created_task_id == null ? null : {
      id: row.created_task_id,
      title: row.generated_task_title,
      status: row.generated_task_status,
      url: `/tasks/${row.created_task_id}`,
    },
  }));
}

export async function recordRecurringTaskRun(
  db: Db,
  input: RecordRecurringTaskRunInput,
): Promise<RecurringTaskRunRecord> {
  const result = await db.run(`
    INSERT INTO recurring_task_runs (
      series_id, scheduled_for, created_task_id, status, error_message,
      started_at, finished_at, idempotency_key
    )
    VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?)
  `, input.series_id, input.scheduled_for, input.created_task_id ?? null, input.status, input.error_message ?? null, input.started_at ?? null, input.finished_at ?? null, input.idempotency_key);

  return await db.get(`SELECT * FROM recurring_task_runs WHERE id = ?`, result.lastInsertId) as RecurringTaskRunRecord;
}

export async function linkRecurringRunToGeneratedTask(
  db: Db,
  runId: number,
  taskId: number,
): Promise<RecurringTaskRunRecord> {
  await db.run(`
    UPDATE recurring_task_runs
    SET created_task_id = ?, status = 'created', finished_at = COALESCE(finished_at, datetime('now')), updated_at = datetime('now')
    WHERE id = ?
  `, taskId, runId);

  return await db.get(`SELECT * FROM recurring_task_runs WHERE id = ?`, runId) as RecurringTaskRunRecord;
}

export async function finishRecurringTaskRun(
  db: Db,
  runId: number,
  input: {
    status: RecurringTaskRunStatus;
    created_task_id?: number | null;
    error_message?: string | null;
  },
): Promise<RecurringTaskRunRecord> {
  await db.run(`
    UPDATE recurring_task_runs
    SET status = ?,
        created_task_id = ?,
        error_message = ?,
        finished_at = COALESCE(finished_at, datetime('now')),
        updated_at = datetime('now')
    WHERE id = ?
  `, input.status, input.created_task_id ?? null, input.error_message ?? null, runId);

  return await db.get(`SELECT * FROM recurring_task_runs WHERE id = ?`, runId) as RecurringTaskRunRecord;
}

export async function runRecurringTaskSeriesNow(
  db: Db,
  seriesId: number,
  actor = 'system',
  tenantId?: number | null,
): Promise<{ series: Record<string, unknown>; run: RecurringTaskRunRecord; task: Record<string, unknown> }> {
  const series = await db.get(`SELECT * FROM recurring_task_series WHERE id = ?${tenantId != null ? ' AND tenant_id = ?' : ''} LIMIT 1`, ...(tenantId != null ? [seriesId, tenantId] : [seriesId])) as RecurringTaskSeriesRecord | undefined;
  if (!series) throw notFound('Recurring task series not found', 'series_not_found');
  await normalizeCreateInput(db, series);
  const scheduledFor = new Date().toISOString();
  const result = db.transaction(async () => {
    const run = await recordRecurringTaskRun(db, {
          series_id: series.id,
          scheduled_for: scheduledFor,
          status: 'started',
          idempotency_key: `${series.id}:run-now:${scheduledFor}`,
        });
    const task = await createTaskRecord(db, {
          tenant_id: series.tenant_id,
          title: series.title_template,
          description: series.description_template,
          status: series.status_on_create,
          priority: series.priority,
          project_id: series.project_id,
          sprint_id: series.sprint_id,
          agent_id: series.agent_id,
          task_type: series.task_type,
          story_points: series.story_points,
          recurring_series_id: series.id,
          scheduled_for: run.scheduled_for,
          schedule_run_id: run.id,
          generated_from: 'recurring_task_series',
        }, actor);
    const linkedRun = await linkRecurringRunToGeneratedTask(db, run.id, Number(task.id));
    await db.run(`
      UPDATE recurring_task_series
      SET last_run_at = ?, next_run_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `, scheduledFor, calculateNextRunAt(series.schedule_expression, series.timezone, series.enabled), series.id);
    return { run: linkedRun, task };
  })();
  return {
    series: (await getRecurringTaskSeries(db, series.id, tenantId)) ?? normalizeSeries(series),
    run: result.run,
    task: {
      ...result.task,
      url: `/tasks/${result.task.id}`,
    },
  };
}
