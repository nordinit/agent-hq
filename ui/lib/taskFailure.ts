import type { TaskHistory } from './api';
import {
  getTaskOutcomeMeta,
  isTaskOutcomeBlockedLike,
  isTaskOutcomeFailureLike,
  isTaskOutcomeUnsuccessful,
  type TaskOutcomeMetaMap,
} from './taskOutcomeMeta.ts';

export type FailureTaskLike = {
  failure_detail?: string | null;
  blocker_reason?: string | null;
  active_instance_task_outcome?: string | null;
  latest_task_outcome?: string | null;
};

function labelFromOutcome(outcome: string, outcomeMap?: TaskOutcomeMetaMap): string {
  const configured = outcomeMap?.[outcome];
  if (configured?.label) return configured.label;
  const meta = getTaskOutcomeMeta(outcome, outcomeMap);
  if (meta.label && meta.label !== outcome) return meta.label;
  return outcome
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase());
}

function latestOutcome(task: Pick<FailureTaskLike, 'active_instance_task_outcome' | 'latest_task_outcome'>): string | null {
  return task.latest_task_outcome || task.active_instance_task_outcome || null;
}

export function isFailureBlocked(task: Pick<FailureTaskLike, 'active_instance_task_outcome' | 'latest_task_outcome'>, outcomeMap?: TaskOutcomeMetaMap): boolean {
  const outcome = latestOutcome(task);
  return isTaskOutcomeBlockedLike(outcome, outcomeMap);
}

export function getFailureSourceLabel(task: Pick<FailureTaskLike, 'active_instance_task_outcome' | 'latest_task_outcome'>, outcomeMap?: TaskOutcomeMetaMap): string | null {
  const outcome = latestOutcome(task);
  if (outcome && isTaskOutcomeUnsuccessful(outcome, outcomeMap)) {
    return labelFromOutcome(outcome, outcomeMap);
  }
  return null;
}

export function getFailureTone(task: Pick<FailureTaskLike, 'active_instance_task_outcome' | 'latest_task_outcome'>, outcomeMap?: TaskOutcomeMetaMap): {
  pill: string;
  panel: string;
  text: string;
} {
  if (isFailureBlocked(task, outcomeMap)) {
    return {
      pill: 'bg-amber-900/60 text-amber-300 border border-amber-600/30',
      panel: 'border-amber-500/30 bg-amber-950/20',
      text: 'text-amber-200',
    };
  }

  return {
    pill: 'bg-red-900/60 text-red-300 border border-red-600/30',
    panel: 'border-red-500/30 bg-red-950/20',
    text: 'text-red-200',
  };
}

export function getFailureSummary(task: Pick<FailureTaskLike, 'failure_detail' | 'blocker_reason'>): string | null {
  return task.failure_detail || task.blocker_reason || null;
}

export function getFailureActor(history: TaskHistory[]): string | null {
  for (const entry of history) {
    if (entry.field === 'status') {
      return entry.changed_by;
    }
  }
  return null;
}

export function getFailureRecoveryLabel(task: Pick<FailureTaskLike, 'active_instance_task_outcome' | 'latest_task_outcome'>, outcomeMap?: TaskOutcomeMetaMap): string {
  const outcome = latestOutcome(task);
  if (isTaskOutcomeBlockedLike(outcome, outcomeMap)) return 'Blocked';
  if (isTaskOutcomeFailureLike(outcome, outcomeMap)) return 'Follow configured route';
  return 'Configured workflow';
}
