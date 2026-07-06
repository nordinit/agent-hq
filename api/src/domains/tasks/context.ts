import { getDb } from '../../db/client';
import { evaluateTaskIntegrity } from '../../lib/taskRelease';

export type TaskContextMode = 'summary' | 'full';

export interface TaskContextOptions {
  includeNotes?: boolean;
  includeHistory?: boolean;
  includeRuns?: boolean;
  includeLease?: boolean;
  recentNotesLimit?: number;
  recentHistoryLimit?: number;
  recentRunsLimit?: number;
  recentExternalEventsLimit?: number;
  timelineLimit?: number;
  sinceTimestamp?: string;
  sinceNoteId?: number;
  sinceHistoryId?: number;
  includeNoisyEvents?: boolean;
}

type RecordLike = Record<string, unknown>;

type NormalizedTaskContextOptions = Required<Pick<
  TaskContextOptions,
  | 'includeNotes'
  | 'includeHistory'
  | 'includeRuns'
  | 'includeLease'
  | 'recentNotesLimit'
  | 'recentHistoryLimit'
  | 'recentRunsLimit'
  | 'recentExternalEventsLimit'
  | 'timelineLimit'
  | 'includeNoisyEvents'
>> & Pick<TaskContextOptions, 'sinceTimestamp' | 'sinceNoteId' | 'sinceHistoryId'>;

interface TaskRelationRef {
  id: number;
  title: string;
  status: string | null;
  priority: string | null;
  task_type: string | null;
  agent_id: number | null;
  agent_name: string | null;
  sprint_id: number | null;
  sprint_name: string | null;
  project_id: number | null;
}

interface ClassifiedNote extends RecordLike {
  note_kind: string;
  phase: string | null;
  is_meaningful: boolean;
  meaningful_reason: string | null;
  summary: string | null;
  excerpt: string;
}

interface ClassifiedHistoryGroup extends RecordLike {
  event_kind: string;
  is_meaningful: boolean;
  meaningful_reason: string | null;
  summary: string;
  fields: string[];
  field_values: Record<string, { old_value: string | null; new_value: string | null }>;
}

const SYSTEM_NOTE_AUTHORS = new Set([
  'system',
  'Agent HQ',
  'task_outcome',
  'dispatcher',
  'watchdog',
  'eligibility',
  'reconciler',
  'scheduler',
  'task_lifecycle',
]);

const REVIEW_EVIDENCE_FIELDS = new Set(['review_branch', 'review_commit', 'review_url']);
const QA_EVIDENCE_FIELDS = new Set(['qa_verified_commit', 'qa_tested_url']);
const DEPLOY_EVIDENCE_FIELDS = new Set(['merged_commit', 'deployed_commit', 'deploy_target', 'deployed_at']);
const LIVE_VERIFICATION_FIELDS = new Set(['live_verified_by', 'live_verified_at']);
const FAILURE_FIELDS = new Set(['failure_detail', 'blocker_reason', 'previous_status']);
const LIFECYCLE_FIELDS = new Set([
  'runtime_ended_at',
  'runtime_end_success',
  'runtime_end_error',
  'runtime_end_source',
  'runtime_lifecycle_handoff',
  'lifecycle_outcome',
  'lifecycle_outcome_posted_at',
]);
const OWNERSHIP_FIELDS = new Set(['agent_id']);
const PLACEMENT_FIELDS = new Set(['project_id', 'sprint_id']);

const TASK_CONTEXT_SELECT = `
  SELECT
    t.*,
    p.name AS project_name,
    a.name AS agent_name,
    a.job_title AS agent_job_title,
    s.name AS sprint_name,
    s.status AS sprint_status,
    ji.id AS active_instance_id,
    ji.status AS active_instance_status,
    ji.session_key AS active_instance_session_key,
    ji.created_at AS active_instance_created_at,
    ji.dispatched_at AS active_instance_dispatched_at,
    ji.started_at AS active_instance_started_at,
    ji.completed_at AS active_instance_completed_at,
    ji.runtime_ended_at AS active_instance_runtime_ended_at,
    ji.runtime_completed_at AS active_instance_runtime_completed_at,
    ji.runtime_end_success AS active_instance_runtime_end_success,
    ji.runtime_end_error AS active_instance_runtime_end_error,
    ji.runtime_end_source AS active_instance_runtime_end_source,
    ji.lifecycle_handoff_status AS active_instance_lifecycle_handoff_status,
    ji.semantic_outcome_missing AS active_instance_semantic_outcome_missing,
    ji.lifecycle_outcome_posted_at AS active_instance_lifecycle_outcome_posted_at,
    ji.task_outcome AS active_instance_task_outcome,
    ia.current_stage AS latest_run_stage,
    ia.last_agent_heartbeat_at,
    ia.last_meaningful_output_at,
    ia.latest_commit_hash,
    ia.branch_name,
    ia.changed_files_json,
    ia.changed_files_count,
    ia.summary AS latest_artifact_summary,
    ia.blocker_reason,
    ia.outcome AS latest_run_outcome,
    ia.stale AS run_is_stale,
    ia.stale_at AS run_stale_at,
    ia.updated_at AS artifact_updated_at
  FROM tasks t
  LEFT JOIN projects p ON p.id = t.project_id
  LEFT JOIN agents a ON a.id = t.agent_id
  LEFT JOIN sprints s ON s.id = t.sprint_id
  LEFT JOIN job_instances ji ON ji.id = t.active_instance_id
  LEFT JOIN instance_artifacts ia ON ia.instance_id = ji.id
`;

function asRecord(value: unknown): RecordLike {
  return value && typeof value === 'object' ? value as RecordLike : {};
}

function stripRetiredTaskColumns(row: RecordLike): RecordLike {
  const retiredFailureColumn = ['failure', 'class'].join('_');
  const { [retiredFailureColumn]: _retiredFailureColumn, ...rest } = row;
  return rest;
}

function parseCustomFields(raw: unknown): RecordLike {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as RecordLike : {};
  } catch {
    return {};
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
      ? Number(value)
      : null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  return null;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value as number)));
}

function normalizeOptions(mode: TaskContextMode, options: TaskContextOptions = {}): NormalizedTaskContextOptions {
  const summaryMode = mode === 'summary';
  return {
    includeNotes: options.includeNotes ?? true,
    includeHistory: options.includeHistory ?? true,
    includeRuns: options.includeRuns ?? true,
    includeLease: options.includeLease ?? true,
    recentNotesLimit: clamp(options.recentNotesLimit, summaryMode ? 6 : 50, 1, 200),
    recentHistoryLimit: clamp(options.recentHistoryLimit, summaryMode ? 12 : 150, 1, 400),
    recentRunsLimit: clamp(options.recentRunsLimit, summaryMode ? 6 : 30, 1, 100),
    recentExternalEventsLimit: clamp(options.recentExternalEventsLimit, summaryMode ? 6 : 30, 1, 100),
    timelineLimit: clamp(options.timelineLimit, summaryMode ? 8 : 40, 1, 200),
    sinceTimestamp: options.sinceTimestamp,
    sinceNoteId: options.sinceNoteId,
    sinceHistoryId: options.sinceHistoryId,
    includeNoisyEvents: options.includeNoisyEvents ?? !summaryMode,
  };
}

function parseChangedFiles(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    return asArray(JSON.parse(raw)).map((item) => String(item)).filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeWhitespace(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const withZone = /Z|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : 0;
}

function safeIsoOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const ms = normalizeTimestamp(value);
  return ms ? new Date(ms).toISOString() : null;
}

function excerpt(value: string | null | undefined, max = 220): string {
  const normalized = (value ?? '').trim().replace(/\s+/g, ' ');
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function shortSha(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > 10 ? value.slice(0, 10) : value;
}

function formatTaskRef(row: RecordLike): TaskRelationRef {
  return {
    id: asNumber(row.id) ?? 0,
    title: asString(row.title) ?? 'Untitled task',
    status: asString(row.status),
    priority: asString(row.priority),
    task_type: asString(row.task_type),
    agent_id: asNumber(row.agent_id),
    agent_name: asString(row.agent_name),
    sprint_id: asNumber(row.sprint_id),
    sprint_name: asString(row.sprint_name),
    project_id: asNumber(row.project_id),
  };
}

function loadTask(taskId: number): RecordLike | null {
  const db = getDb();
  const task = db.prepare(`${TASK_CONTEXT_SELECT} WHERE t.id = ?`).get(taskId) as RecordLike | undefined;
  if (!task) return null;
  const customFields = parseCustomFields(task.custom_fields_json);
  const taskWithoutRetiredColumns = stripRetiredTaskColumns({ ...task, ...customFields });

  const blockers = db.prepare(`
    SELECT t.id, t.title, t.status, t.priority, t.task_type, t.agent_id, a.name AS agent_name, t.sprint_id, s.name AS sprint_name, t.project_id
    FROM tasks t
    LEFT JOIN agents a ON a.id = t.agent_id
    LEFT JOIN sprints s ON s.id = t.sprint_id
    WHERE t.id IN (SELECT blocker_id FROM task_dependencies WHERE blocked_id = ?)
    ORDER BY t.id ASC
  `).all(taskId) as RecordLike[];

  const blocking = db.prepare(`
    SELECT t.id, t.title, t.status, t.priority, t.task_type, t.agent_id, a.name AS agent_name, t.sprint_id, s.name AS sprint_name, t.project_id
    FROM tasks t
    LEFT JOIN agents a ON a.id = t.agent_id
    LEFT JOIN sprints s ON s.id = t.sprint_id
    WHERE t.id IN (SELECT blocked_id FROM task_dependencies WHERE blocker_id = ?)
    ORDER BY t.id ASC
  `).all(taskId) as RecordLike[];

  return {
    ...taskWithoutRetiredColumns,
    ...evaluateTaskIntegrity(task as { status?: string | null; task_type?: string | null }, db),
    changed_files: parseChangedFiles(task.changed_files_json),
    blockers: blockers.map(formatTaskRef),
    blocking: blocking.map(formatTaskRef),
  };
}

function buildSinceClause(column: string, value: string | undefined, params: unknown[]): string {
  if (!value) return '';
  const normalized = safeIsoOrNull(value);
  if (!normalized) return '';
  params.push(normalized);
  return ` AND datetime(${column}) >= datetime(?)`;
}

function loadNotes(taskId: number, options: NormalizedTaskContextOptions): RecordLike[] {
  if (!options.includeNotes) return [];
  const db = getDb();
  const params: unknown[] = [taskId];
  let query = `SELECT * FROM task_notes WHERE task_id = ?`;
  if (Number.isFinite(options.sinceNoteId)) {
    query += ` AND id > ?`;
    params.push(options.sinceNoteId as number);
  }
  query += buildSinceClause('created_at', options.sinceTimestamp, params);
  query += ` ORDER BY created_at DESC, id DESC LIMIT ?`;
  params.push(options.recentNotesLimit);
  return db.prepare(query).all(...params) as RecordLike[];
}

function loadHistory(taskId: number, options: NormalizedTaskContextOptions): RecordLike[] {
  if (!options.includeHistory) return [];
  const db = getDb();
  const params: unknown[] = [taskId];
  let query = `SELECT * FROM task_history WHERE task_id = ?`;
  if (Number.isFinite(options.sinceHistoryId)) {
    query += ` AND id > ?`;
    params.push(options.sinceHistoryId as number);
  }
  query += buildSinceClause('created_at', options.sinceTimestamp, params);
  query += ` ORDER BY created_at DESC, id DESC LIMIT ?`;
  params.push(options.recentHistoryLimit);
  return db.prepare(query).all(...params) as RecordLike[];
}

function loadRuns(taskId: number, options: NormalizedTaskContextOptions): RecordLike[] {
  if (!options.includeRuns) return [];
  const db = getDb();
  const params: unknown[] = [taskId];
  let query = `
    SELECT ji.*, a.name AS agent_name,
           ia.current_stage, ia.last_agent_heartbeat_at, ia.last_meaningful_output_at,
           ia.latest_commit_hash, ia.branch_name, ia.changed_files_json, ia.changed_files_count,
           ia.summary AS artifact_summary, ia.blocker_reason, ia.outcome AS artifact_outcome,
           ia.stale AS run_is_stale, ia.stale_at,
           ji.task_outcome,
           ji.runtime_ended_at,
           ji.runtime_completed_at,
           ji.runtime_end_success,
           ji.runtime_end_error,
           ji.runtime_end_source,
           ji.lifecycle_handoff_status,
           ji.semantic_outcome_missing,
           ji.lifecycle_outcome_posted_at
    FROM job_instances ji
    LEFT JOIN agents a ON a.id = ji.agent_id
    LEFT JOIN instance_artifacts ia ON ia.instance_id = ji.id
    WHERE ji.task_id = ?
  `;
  if (options.sinceTimestamp) {
    const normalized = safeIsoOrNull(options.sinceTimestamp);
    if (normalized) {
      query += ` AND datetime(COALESCE(ji.runtime_completed_at, ji.completed_at, ji.started_at, ji.dispatched_at, ji.created_at)) >= datetime(?)`;
      params.push(normalized);
    }
  }
  query += ` ORDER BY ji.created_at DESC, ji.id DESC LIMIT ?`;
  params.push(options.recentRunsLimit);
  const rows = db.prepare(query).all(...params) as RecordLike[];
  return rows.map((row) => ({
    ...stripRetiredTaskColumns(row),
    changed_files: parseChangedFiles(row.changed_files_json),
  }));
}

function loadExternalEvents(taskId: number, options: NormalizedTaskContextOptions): RecordLike[] {
  if (!options.includeLease) return [];
  const db = getDb();
  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='external_task_event_receipts'`).get() as { name: string } | undefined;
  if (!tableExists) return [];

  const params: unknown[] = [taskId];
  let query = `SELECT * FROM external_task_event_receipts WHERE task_id = ?`;
  query += buildSinceClause('created_at', options.sinceTimestamp, params);
  query += ` ORDER BY created_at DESC, id DESC LIMIT ?`;
  params.push(options.recentExternalEventsLimit);
  return db.prepare(query).all(...params) as RecordLike[];
}

function classifyNote(row: RecordLike): ClassifiedNote {
  const author = asString(row.author) ?? 'system';
  const content = asString(row.content) ?? '';
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstLine = lines[0] ?? '';
  const summaryLine = lines.find((line) => line.startsWith('Summary: '));
  const blockerLine = lines.find((line) => line.startsWith('Blocker: '));
  const summary = summaryLine?.slice('Summary: '.length).trim() || blockerLine?.slice('Blocker: '.length).trim() || null;

  if (firstLine.startsWith('Agent check-in: ')) {
    const label = firstLine.slice('Agent check-in: '.length).trim();
    const phase = label === 'Run started'
      ? 'start'
      : label === 'Heartbeat'
        ? 'heartbeat'
        : label === 'Progress update'
          ? 'progress'
          : label === 'Blocked'
            ? 'blocked'
            : label === 'Run failed'
              ? 'failed'
              : label === 'Run completed'
                ? 'completed'
                : 'agent_checkin';

    const isMeaningful = phase === 'blocked'
      || phase === 'failed'
      || phase === 'completed'
      || (phase === 'progress' && Boolean(summary || lines.some((line) => /^(Commit|Branch|Changed files|Files|Outcome): /.test(line))));

    return {
      ...row,
      note_kind: 'agent_checkin',
      phase,
      is_meaningful: isMeaningful,
      meaningful_reason: isMeaningful
        ? (phase === 'progress' ? 'agent_progress_update' : phase === 'blocked' ? 'blocked_checkin' : phase === 'failed' ? 'failed_checkin' : 'completion_checkin')
        : phase === 'heartbeat'
          ? 'heartbeat_noise'
          : 'routine_checkin',
      summary,
      excerpt: excerpt(summary ?? content),
    };
  }

  if (firstLine === 'Workflow event received' || firstLine === 'External task event received') {
    return {
      ...row,
      note_kind: 'workflow_event_note',
      phase: null,
      is_meaningful: false,
      meaningful_reason: 'duplicated_by_external_receipt',
      summary,
      excerpt: excerpt(summary ?? content),
    };
  }

  const normalized = normalizeWhitespace(content);
  const humanish = !SYSTEM_NOTE_AUTHORS.has(author);
  const strongSignal = /\b(blocked|blocker|failed|error|review|qa|deploy|lease|commit|next action|root cause)\b/.test(normalized);

  return {
    ...row,
    note_kind: humanish ? 'human_note' : 'system_note',
    phase: null,
    is_meaningful: humanish || strongSignal,
    meaningful_reason: humanish ? 'human_or_operator_note' : strongSignal ? 'system_truth_update' : 'routine_system_note',
    summary: summary ?? lines[0] ?? null,
    excerpt: excerpt(summary ?? content),
  };
}

function historyEventKind(field: string | null): string {
  if (!field) return 'other';
  if (field === 'status') return 'status_change';
  if (field === 'created' || field === 'deleted') return 'task_record_change';
  if (REVIEW_EVIDENCE_FIELDS.has(field)) return 'review_evidence_update';
  if (QA_EVIDENCE_FIELDS.has(field)) return 'qa_evidence_update';
  if (DEPLOY_EVIDENCE_FIELDS.has(field)) return 'deploy_evidence_update';
  if (LIVE_VERIFICATION_FIELDS.has(field)) return 'live_verification_update';
  if (FAILURE_FIELDS.has(field)) return 'failure_context_update';
  if (LIFECYCLE_FIELDS.has(field)) return 'lifecycle_update';
  if (OWNERSHIP_FIELDS.has(field)) return 'ownership_change';
  if (PLACEMENT_FIELDS.has(field)) return 'placement_change';
  if (field.startsWith('workflow_event_') || field.startsWith('external_')) return 'workflow_event_detail';
  return 'other';
}

function isMeaningfulHistoryField(field: string | null): boolean {
  if (!field) return false;
  return field === 'status'
    || field === 'created'
    || field === 'deleted'
    || REVIEW_EVIDENCE_FIELDS.has(field)
    || QA_EVIDENCE_FIELDS.has(field)
    || DEPLOY_EVIDENCE_FIELDS.has(field)
    || LIVE_VERIFICATION_FIELDS.has(field)
    || FAILURE_FIELDS.has(field)
    || LIFECYCLE_FIELDS.has(field)
    || OWNERSHIP_FIELDS.has(field)
    || PLACEMENT_FIELDS.has(field);
}

function meaningfulReasonForHistory(field: string | null): string | null {
  const kind = historyEventKind(field);
  switch (kind) {
    case 'status_change': return 'task_truth_changed';
    case 'review_evidence_update': return 'review_evidence_changed';
    case 'qa_evidence_update': return 'qa_truth_changed';
    case 'deploy_evidence_update': return 'deploy_truth_changed';
    case 'live_verification_update': return 'live_verification_changed';
    case 'failure_context_update': return 'blocker_or_failure_changed';
    case 'lifecycle_update': return 'run_truth_changed';
    case 'ownership_change': return 'ownership_changed';
    case 'placement_change': return 'placement_changed';
    case 'task_record_change': return 'task_record_changed';
    default: return null;
  }
}

function formatHistoryGroupSummary(group: ClassifiedHistoryGroup): string {
  const values = group.field_values;
  switch (group.event_kind) {
    case 'status_change': {
      const status = values.status;
      return `Status changed ${status?.old_value ?? 'unknown'} → ${status?.new_value ?? 'unknown'}`;
    }
    case 'review_evidence_update': {
      const branch = values.review_branch?.new_value ?? null;
      const commit = shortSha(values.review_commit?.new_value ?? null);
      const url = values.review_url?.new_value ?? null;
      return `Review evidence updated${branch ? ` on ${branch}` : ''}${commit ? ` @ ${commit}` : ''}${url ? ` (${url})` : ''}`;
    }
    case 'qa_evidence_update': {
      const commit = shortSha(values.qa_verified_commit?.new_value ?? null);
      const url = values.qa_tested_url?.new_value ?? null;
      return `QA evidence updated${commit ? ` for ${commit}` : ''}${url ? ` (${url})` : ''}`;
    }
    case 'deploy_evidence_update': {
      const commit = shortSha(values.deployed_commit?.new_value ?? values.merged_commit?.new_value ?? null);
      const target = values.deploy_target?.new_value ?? null;
      return `Deploy evidence updated${target ? ` for ${target}` : ''}${commit ? ` @ ${commit}` : ''}`;
    }
    case 'live_verification_update':
      return `Live verification evidence updated`;
    case 'failure_context_update': {
      const detail = values.failure_detail?.new_value ?? values.blocker_reason?.new_value ?? null;
      return `Failure or blocker context updated${detail ? `: ${excerpt(detail, 160)}` : ''}`;
    }
    case 'lifecycle_update': {
      const outcome = values.lifecycle_outcome?.new_value ?? null;
      const runtime = values.runtime_end_source?.new_value ?? null;
      return `Lifecycle state updated${outcome ? ` (${outcome})` : runtime ? ` (${runtime})` : ''}`;
    }
    case 'ownership_change':
      return `Ownership changed`;
    case 'placement_change':
      return `Project or sprint placement changed`;
    case 'task_record_change':
      return group.fields.includes('created') ? 'Task created' : 'Task deleted';
    default:
      return `${group.fields.length} task history field${group.fields.length === 1 ? '' : 's'} updated`;
  }
}

function groupHistory(rows: RecordLike[], includeNoisyEvents: boolean): ClassifiedHistoryGroup[] {
  const groups: ClassifiedHistoryGroup[] = [];

  for (const row of rows) {
    const field = asString(row.field);
    const eventKind = historyEventKind(field);
    const createdAt = asString(row.created_at);
    const changedBy = asString(row.changed_by);
    const oldValue = asString(row.old_value);
    const newValue = asString(row.new_value);
    const meaningful = isMeaningfulHistoryField(field);

    if (!includeNoisyEvents && !meaningful) continue;
    if (eventKind === 'workflow_event_detail' && !includeNoisyEvents) continue;

    const previous = groups[groups.length - 1];
    if (
      previous
      && previous.event_kind === eventKind
      && asString(previous.created_at) === createdAt
      && asString(previous.changed_by) === changedBy
    ) {
      previous.fields.push(field ?? 'unknown');
      previous.field_values[field ?? `unknown_${previous.fields.length}`] = { old_value: oldValue, new_value: newValue };
      previous.summary = formatHistoryGroupSummary(previous);
      continue;
    }

    const group: ClassifiedHistoryGroup = {
      ...row,
      event_kind: eventKind,
      is_meaningful: meaningful,
      meaningful_reason: meaningfulReasonForHistory(field),
      summary: '',
      fields: [field ?? 'unknown'],
      field_values: {
        [field ?? 'unknown']: { old_value: oldValue, new_value: newValue },
      },
    };
    group.summary = formatHistoryGroupSummary(group);
    groups.push(group);
  }

  return groups;
}

function buildMeaningfulNotesSummary(rows: RecordLike[]): ClassifiedNote[] {
  const output: ClassifiedNote[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const classified = classifyNote(row);
    if (!classified.is_meaningful) continue;
    const author = asString(classified.author) ?? 'system';
    const dedupeKey = classified.note_kind === 'agent_checkin'
      ? `${author}:${classified.phase ?? 'checkin'}`
      : `${classified.note_kind}:${normalizeWhitespace(classified.summary ?? classified.excerpt)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    output.push(classified);
  }

  return output;
}

function buildMeaningfulEventSummary(historyRows: RecordLike[], externalEvents: RecordLike[], includeNoisyEvents: boolean): Array<RecordLike> {
  const history = groupHistory(historyRows, includeNoisyEvents)
    .filter((group) => includeNoisyEvents || group.is_meaningful)
    .map((group) => ({
      source: 'task_history',
      id: asNumber(group.id),
      created_at: asString(group.created_at),
      changed_by: asString(group.changed_by),
      event_kind: group.event_kind,
      is_meaningful: group.is_meaningful,
      meaningful_reason: group.meaningful_reason,
      summary: group.summary,
      fields: group.fields,
      field_values: group.field_values,
    }));

  const receipts = externalEvents.map((row) => ({
    source: 'external_receipt',
    id: asNumber(row.id),
    created_at: asString(row.created_at),
    changed_by: asString(row.received_by),
    event_kind: asString(row.event) ?? 'workflow_event',
    is_meaningful: true,
    meaningful_reason: 'workflow_event_update',
    summary: `Workflow event ${asString(row.event) ?? 'received'}: ${excerpt(asString(row.message), 180)}`,
    environment_id: asString(row.environment_id),
    queue_id: asString(row.queue_id),
    lease_id: asString(row.lease_id),
    branch: asString(row.branch),
    commit_sha: asString(row.commit_sha),
    review_url: asString(row.review_url),
    message: asString(row.message),
    source_name: asString(row.source),
  }));

  return [...receipts, ...history].sort((a, b) => {
    const tsDiff = normalizeTimestamp(asString(b.created_at)) - normalizeTimestamp(asString(a.created_at));
    if (tsDiff !== 0) return tsDiff;
    return (asNumber(b.id) ?? 0) - (asNumber(a.id) ?? 0);
  });
}

function deriveBlockerContext(task: RecordLike, meaningfulNotes: ClassifiedNote[], events: Array<RecordLike>, runs: RecordLike[]): RecordLike | null {
  const directBlockers = asArray(task.blockers);
  const failureDetail = asString(task.failure_detail);
  const runBlocker = asString(task.blocker_reason)
    ?? asString(task.active_instance_runtime_end_error)
    ?? asString(runs.find((row) => asString(row.blocker_reason) || asString(row.runtime_end_error))?.blocker_reason)
    ?? asString(runs.find((row) => asString(row.runtime_end_error))?.runtime_end_error);
  const blockerNote = meaningfulNotes.find((note) => note.phase === 'blocked' || /\bblock(ed|er)\b/i.test(asString(note.summary) ?? '') || /\bblock(ed|er)\b/i.test(asString(note.excerpt) ?? ''));
  const blockerEvent = events.find((event) => {
    const kind = asString(event.event_kind);
    return kind === 'failure_context_update' || (kind === 'status_change' && asString(asRecord(event.field_values).status ? asRecord(asRecord(event.field_values).status).new_value : null) === 'blocked');
  });

  if (!failureDetail && !runBlocker && !blockerNote && !blockerEvent && directBlockers.length === 0) return null;

  return {
    failure_detail: failureDetail,
    run_blocker_reason: runBlocker,
    latest_blocker_note: blockerNote
      ? {
          id: asNumber(blockerNote.id),
          author: asString(blockerNote.author),
          created_at: asString(blockerNote.created_at),
          summary: blockerNote.summary,
          excerpt: blockerNote.excerpt,
        }
      : null,
    latest_blocker_event: blockerEvent ?? null,
    direct_blockers: directBlockers,
  };
}

function deriveLeaseContext(task: RecordLike, externalEvents: RecordLike[]): RecordLike | null {
  const latest = externalEvents[0] ? asRecord(externalEvents[0]) : null;
  const reviewUrl = asString(task.review_url) ?? asString(latest?.review_url);
  const relevant = latest || reviewUrl || ['dev_deploy_queued', 'dev_deploying', 'review', 'ready_to_merge'].includes(asString(task.status) ?? '');
  if (!relevant) return null;

  return {
    review_url: reviewUrl,
    latest_event: latest
      ? {
          id: asNumber(latest.id),
          source: asString(latest.source),
          event: asString(latest.event),
          environment_id: asString(latest.environment_id),
          queue_id: asString(latest.queue_id),
          lease_id: asString(latest.lease_id),
          branch: asString(latest.branch),
          commit_sha: asString(latest.commit_sha),
          processing_state: asString(latest.processing_state),
          processing_error: asString(latest.processing_error),
          mapping_action_kind: asString(latest.mapping_action_kind),
          mapping_action_target: asString(latest.mapping_action_target),
          message: asString(latest.message),
          created_at: asString(latest.created_at),
        }
      : null,
    related_events: externalEvents,
  };
}

function latestRunState(task: RecordLike, runs: RecordLike[]): RecordLike | null {
  const activeInstanceId = asNumber(task.active_instance_id);
  const active = runs.find((run) => asNumber(run.id) === activeInstanceId) ?? runs[0] ?? null;
  if (!active && !activeInstanceId) return null;
  const row = asRecord(active ?? task);
  return {
    instance_id: asNumber(row.id) ?? activeInstanceId,
    status: asString(row.status) ?? asString(task.active_instance_status),
    session_key: asString(row.session_key) ?? asString(task.active_instance_session_key),
    current_stage: asString(row.current_stage) ?? asString(task.latest_run_stage),
    artifact_outcome: asString(row.artifact_outcome) ?? asString(task.latest_run_outcome),
    task_outcome: asString(row.task_outcome) ?? asString(task.active_instance_task_outcome),
    blocker_reason: asString(row.blocker_reason) ?? asString(task.blocker_reason),
    latest_commit_hash: asString(row.latest_commit_hash) ?? asString(task.latest_commit_hash),
    branch_name: asString(row.branch_name) ?? asString(task.branch_name),
    changed_files_count: asNumber(row.changed_files_count) ?? asNumber(task.changed_files_count),
    changed_files: asArray(row.changed_files).length > 0 ? row.changed_files : asArray(task.changed_files),
    last_meaningful_output_at: asString(row.last_meaningful_output_at) ?? asString(task.last_meaningful_output_at),
    last_agent_heartbeat_at: asString(row.last_agent_heartbeat_at) ?? asString(task.last_agent_heartbeat_at),
    started_at: asString(row.started_at) ?? asString(task.active_instance_started_at),
    completed_at: asString(row.completed_at) ?? asString(task.active_instance_completed_at),
    runtime_ended_at: asString(row.runtime_ended_at) ?? asString(task.active_instance_runtime_ended_at),
    runtime_end_success: asBoolean(row.runtime_end_success) ?? asBoolean(task.active_instance_runtime_end_success),
    runtime_end_error: asString(row.runtime_end_error) ?? asString(task.active_instance_runtime_end_error),
    lifecycle_handoff_status: asString(row.lifecycle_handoff_status) ?? asString(task.active_instance_lifecycle_handoff_status),
    lifecycle_outcome_posted_at: asString(row.lifecycle_outcome_posted_at) ?? asString(task.active_instance_lifecycle_outcome_posted_at),
    semantic_outcome_missing: asBoolean(row.semantic_outcome_missing) ?? asBoolean(task.active_instance_semantic_outcome_missing),
    artifact_summary: asString(row.artifact_summary) ?? asString(task.latest_artifact_summary),
    run_is_stale: asBoolean(row.run_is_stale) ?? asBoolean(task.run_is_stale),
    run_stale_at: asString(row.stale_at) ?? asString(task.run_stale_at),
  };
}

function buildTimeline(notes: ClassifiedNote[], events: Array<RecordLike>, limit: number): Array<RecordLike> {
  const noteItems = notes.map((note) => ({
    source: 'task_note',
    id: asNumber(note.id),
    created_at: asString(note.created_at),
    author: asString(note.author),
    event_kind: note.note_kind,
    is_meaningful: note.is_meaningful,
    meaningful_reason: note.meaningful_reason,
    summary: note.summary ?? note.excerpt,
    excerpt: note.excerpt,
    phase: note.phase,
  }));

  return [...events, ...noteItems]
    .sort((a, b) => {
      const tsDiff = normalizeTimestamp(asString(b.created_at)) - normalizeTimestamp(asString(a.created_at));
      if (tsDiff !== 0) return tsDiff;
      return (asNumber(b.id) ?? 0) - (asNumber(a.id) ?? 0);
    })
    .slice(0, limit);
}

function deriveNextAction(task: RecordLike, blockerContext: RecordLike | null, leaseContext: RecordLike | null, runState: RecordLike | null): string | null {
  const status = asString(task.status) ?? 'unknown';
  if (blockerContext && ['blocked', 'failed', 'stalled'].includes(status)) {
    return 'Resolve the blocker or failure context before retrying the task.';
  }
  if (status === 'dev_deploy_queued') return 'Wait for the shared dev deploy queue to advance or for lease-manager callbacks to update task truth.';
  if (status === 'dev_deploying') return 'Wait for the shared dev deploy to finish, then verify the served branch and commit.';
  if (status === 'review') {
    const commit = shortSha(asString(task.review_commit));
    return `QA or review should validate the deployed review artifact${commit ? ` at commit ${commit}` : ''}.`;
  }
  if (status === 'ready_to_merge') return 'Release ownership should pick up the task for deploy and live verification.';
  if (status === 'in_progress') {
    if (runState && asString(runState.current_stage)) {
      return `The active run is still progressing at stage ${asString(runState.current_stage)}.`;
    }
    return 'Implementation is still in progress.';
  }
  if (status === 'ready' || status === 'todo') return 'The task is not actively running yet.';
  if (leaseContext && asRecord(leaseContext.latest_event).event === 'deploy_failed') return 'A lease-backed deploy failed and needs implementation or environment follow-up.';
  return null;
}

function buildServerSummary(task: RecordLike, blockerContext: RecordLike | null, leaseContext: RecordLike | null, runState: RecordLike | null): string {
  const parts: string[] = [];
  const status = asString(task.status) ?? 'unknown';
  parts.push(`Task #${asNumber(task.id) ?? '?'} is ${status}`);

  const assignee = asString(task.agent_name);
  const sprint = asString(task.sprint_name);
  const project = asString(task.project_name);
  if (assignee) parts.push(`assigned to ${assignee}`);
  if (sprint) parts.push(`in sprint ${sprint}`);
  if (project) parts.push(`for project ${project}`);

  const blockerDetail = asString(blockerContext?.failure_detail)
    ?? asString(blockerContext?.run_blocker_reason)
    ?? asString(asRecord(blockerContext?.latest_blocker_note).summary)
    ?? null;
  if (blockerDetail) {
    parts.push(`Current blocker: ${excerpt(blockerDetail, 180)}`);
  } else if (leaseContext) {
    const latestEvent = asRecord(leaseContext.latest_event);
    const event = asString(latestEvent.event);
    const env = asString(latestEvent.environment_id);
    const commit = shortSha(asString(latestEvent.commit_sha) ?? asString(task.review_commit));
    if (event || env || commit) {
      parts.push(`Latest dev lease context is ${event ?? 'recorded'}${env ? ` on ${env}` : ''}${commit ? ` @ ${commit}` : ''}`);
    }
  } else if (asString(task.review_commit) || asString(task.review_branch)) {
    parts.push(`Review evidence is recorded${asString(task.review_branch) ? ` on ${asString(task.review_branch)}` : ''}${shortSha(asString(task.review_commit)) ? ` @ ${shortSha(asString(task.review_commit))}` : ''}`);
  } else if (runState && asString(runState.current_stage)) {
    parts.push(`Latest run stage is ${asString(runState.current_stage)}`);
  }

  const next = deriveNextAction(task, blockerContext, leaseContext, runState);
  if (next) parts.push(`Next: ${next}`);

  return `${parts.join('. ')}.`;
}

function loadDeltaMarkers(taskId: number): RecordLike {
  const db = getDb();
  const latestNote = db.prepare(`SELECT id, created_at FROM task_notes WHERE task_id = ? ORDER BY id DESC LIMIT 1`).get(taskId) as RecordLike | undefined;
  const latestHistory = db.prepare(`SELECT id, created_at FROM task_history WHERE task_id = ? ORDER BY id DESC LIMIT 1`).get(taskId) as RecordLike | undefined;
  const latestRun = db.prepare(`SELECT id, COALESCE(runtime_completed_at, completed_at, started_at, dispatched_at, created_at) AS activity_at FROM job_instances WHERE task_id = ? ORDER BY id DESC LIMIT 1`).get(taskId) as RecordLike | undefined;
  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='external_task_event_receipts'`).get() as { name: string } | undefined;
  const latestExternal = tableExists
    ? db.prepare(`SELECT id, created_at FROM external_task_event_receipts WHERE task_id = ? ORDER BY id DESC LIMIT 1`).get(taskId) as RecordLike | undefined
    : undefined;

  const latestActivityAt = [
    asString(latestNote?.created_at),
    asString(latestHistory?.created_at),
    asString(latestRun?.activity_at),
    asString(latestExternal?.created_at),
  ].filter(Boolean).sort((a, b) => normalizeTimestamp(b) - normalizeTimestamp(a))[0] ?? null;

  return {
    latest_note_id: asNumber(latestNote?.id),
    latest_history_id: asNumber(latestHistory?.id),
    latest_external_event_id: asNumber(latestExternal?.id),
    latest_workflow_event_id: asNumber(latestExternal?.id),
    latest_run_id: asNumber(latestRun?.id),
    latest_activity_at: latestActivityAt,
  };
}

export function buildTaskContext(taskId: number, mode: TaskContextMode = 'summary', options: TaskContextOptions = {}): RecordLike | null {
  const normalized = normalizeOptions(mode, options);
  const task = loadTask(taskId);
  if (!task) return null;

  const notes = loadNotes(taskId, normalized);
  const history = loadHistory(taskId, normalized);
  const runs = loadRuns(taskId, normalized);
  const externalEvents = loadExternalEvents(taskId, normalized);

  const meaningfulNotes = buildMeaningfulNotesSummary(notes);
  const meaningfulEvents = buildMeaningfulEventSummary(history, externalEvents, normalized.includeNoisyEvents);
  const blockerContext = deriveBlockerContext(task, meaningfulNotes, meaningfulEvents, runs);
  const leaseContext = deriveLeaseContext(task, externalEvents);
  const runState = latestRunState(task, runs);
  const timeline = buildTimeline(meaningfulNotes, meaningfulEvents, normalized.timelineLimit);

  const base: RecordLike = {
    task_id: taskId,
    mode,
    generated_at: new Date().toISOString(),
    options_applied: normalized,
    delta_markers: loadDeltaMarkers(taskId),
    task: task,
    blockers: task.blockers,
    blocking: task.blocking,
    blocker_context: blockerContext,
    active_instance: runState,
    latest_run_state: runState,
    lease_context: leaseContext,
    server_summary: buildServerSummary(task, blockerContext, leaseContext, runState),
  };

  if (mode === 'summary') {
    return {
      ...base,
      recent_meaningful_notes: meaningfulNotes.slice(0, normalized.recentNotesLimit),
      recent_meaningful_events: meaningfulEvents.slice(0, normalized.recentHistoryLimit),
      recent_timeline: timeline,
    };
  }

  return {
    ...base,
    notes: notes.map((row) => classifyNote(row)),
    history: groupHistory(history, normalized.includeNoisyEvents),
    runs,
    workflow_events: externalEvents,
    external_events: externalEvents,
    recent_meaningful_notes: meaningfulNotes,
    recent_meaningful_events: meaningfulEvents,
    recent_timeline: timeline,
  };
}
