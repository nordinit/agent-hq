import { parseDbDate, timeAgo } from './date.ts';
import { getTaskOutcomeMeta } from './taskOutcomeMeta.ts';
import type { TaskOutcomeMetaMap } from './taskOutcomeMeta.ts';

export type RunDisplayStatus = 'queued' | 'starting' | 'running' | 'awaiting_outcome' | 'done' | 'failed';

/**
 * Task-level workflow outcome — what the agent determined about the task.
 * This is intentionally separate from execution status.
 * A run can complete execution cleanly (done) while reporting qa_fail or blocked.
 */
export type TaskOutcomeKind = string;

export interface RunLifecycleLike {
  status: string;
  created_at?: string | null;
  dispatched_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  runtime_ended_at?: string | null;
  runtime_end_success?: number | boolean | null;
  runtime_end_error?: string | null;
  lifecycle_outcome_posted_at?: string | null;
  /** Explicit task outcome recorded by the outcome API */
  task_outcome?: string | null;
  /** Legacy: artifact outcome from check-in observability */
  artifact_outcome?: string | null;
}

export interface RunLifecycle {
  /** Execution status — reflects whether the run itself succeeded or failed */
  displayStatus: RunDisplayStatus;
  /** Task workflow outcome — what the agent decided about the task (may be null if not yet reported) */
  taskOutcome: string | null;
  dispatchedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  missingStart: boolean;
  staleMissingStart: boolean;
  note: string | null;
}

export interface RunLifecycleOptions {
  nonFailureOutcomes?: Set<string> | string[];
}

const STALE_MISSING_START_MS = 5 * 60 * 1000;

function ageMs(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const ms = parseDbDate(dateStr).getTime();
  return Number.isNaN(ms) ? null : Date.now() - ms;
}

function hasNonFailureOutcome(outcome: string | null, options?: RunLifecycleOptions): boolean {
  if (!outcome || !options?.nonFailureOutcomes) return false;
  return Array.isArray(options.nonFailureOutcomes)
    ? options.nonFailureOutcomes.includes(outcome)
    : options.nonFailureOutcomes.has(outcome);
}

/**
 * Resolve the effective execution display status.
 * Key rule: if the run's DB status is 'failed' but it has a task_outcome that
 * indicates a healthy execution (e.g. qa_fail, blocked), the run itself should
 * not be shown as a runtime failure — it completed and reported a workflow result.
 */
function resolveExecStatus(instance: RunLifecycleLike, startedAt: string | null, options?: RunLifecycleOptions): RunDisplayStatus {
  const taskOutcome = instance.task_outcome ?? instance.artifact_outcome ?? null;
  const runtimeEnded = Boolean(instance.runtime_ended_at);
  const runtimeFailed = instance.status === 'failed' || instance.runtime_end_success === 0 || instance.runtime_end_success === false;
  const lifecycleOutcomePosted = Boolean(instance.lifecycle_outcome_posted_at || taskOutcome);

  if (runtimeEnded && runtimeFailed && !hasNonFailureOutcome(taskOutcome, options)) {
    return 'failed';
  }

  if (runtimeEnded && !lifecycleOutcomePosted) {
    return 'awaiting_outcome';
  }

  switch (instance.status) {
    case 'queued':
      return 'queued';
    case 'dispatched':
      return startedAt ? 'running' : 'starting';
    case 'running':
      return startedAt ? 'running' : 'starting';
    case 'done':
      return 'done';
    case 'failed':
      if (hasNonFailureOutcome(taskOutcome, options)) {
        return 'done';
      }
      return 'failed';
    default:
      return runtimeEnded ? 'done' : 'queued';
  }
}

export function getRunLifecycle(instance: RunLifecycleLike, options?: RunLifecycleOptions): RunLifecycle {
  const dispatchedAt = instance.dispatched_at ?? instance.created_at ?? null;
  const startedAt = instance.started_at ?? null;
  const completedAt = instance.completed_at ?? null;

  const taskOutcome = instance.task_outcome ?? instance.artifact_outcome ?? null;

  const missingStart = Boolean(
    dispatchedAt &&
    !startedAt &&
    (instance.status === 'dispatched' || instance.status === 'running')
  );

  const dispatchedAge = ageMs(dispatchedAt);
  const staleMissingStart = Boolean(
    missingStart && dispatchedAge != null && dispatchedAge >= STALE_MISSING_START_MS
  );

  const displayStatus = resolveExecStatus(instance, startedAt, options);

  let note: string | null = null;
  if (instance.status === 'dispatched' && !startedAt) {
    note = staleMissingStart ? 'Accepted but still missing a confirmed start.' : 'Accepted, waiting for a confirmed start.';
  } else if (instance.status === 'running' && !startedAt) {
    note = staleMissingStart ? 'Work may be ghosted — start is still unconfirmed.' : 'Work is starting, but the start is not yet confirmed.';
  } else if (displayStatus === 'awaiting_outcome') {
    note = 'Runtime ended, waiting for lifecycle outcome handoff.';
  } else if ((instance.status === 'done' || instance.status === 'failed') && completedAt && !startedAt) {
    note = 'Completed without a confirmed start timestamp.';
  }

  return {
    displayStatus,
    taskOutcome,
    dispatchedAt,
    startedAt,
    completedAt,
    missingStart,
    staleMissingStart,
    note,
  };
}

export function getRunStatusLabel(status: RunDisplayStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'starting':
      return 'Starting';
    case 'running':
      return 'Running';
    case 'awaiting_outcome':
      return 'Awaiting Outcome';
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
  }
}

/**
 * Human-readable label for a task outcome value.
 */
export function getTaskOutcomeLabel(outcome: string, outcomeMap?: TaskOutcomeMetaMap): string {
  return getTaskOutcomeMeta(outcome, outcomeMap).label;
}

/**
 * Badge variant for a task outcome — determines colour in the UI.
 */
export function getTaskOutcomeBadgeVariant(outcome: string, outcomeMap?: TaskOutcomeMetaMap): string {
  return getTaskOutcomeMeta(outcome, outcomeMap).badge_variant ?? 'workspace';
}

export function getRunTimelineSummary(instance: RunLifecycleLike, options?: RunLifecycleOptions): string {
  const lifecycle = getRunLifecycle(instance, options);

  if (lifecycle.completedAt) {
    return `Completed ${timeAgo(lifecycle.completedAt)}`;
  }

  if (lifecycle.startedAt) {
    return `Started ${timeAgo(lifecycle.startedAt)}`;
  }

  if (lifecycle.dispatchedAt) {
    return `Accepted ${timeAgo(lifecycle.dispatchedAt)}`;
  }

  if (instance.created_at) {
    return `Created ${timeAgo(instance.created_at)}`;
  }

  return 'No lifecycle timestamps';
}
