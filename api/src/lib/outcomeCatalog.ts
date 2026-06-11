import type Database from 'better-sqlite3';
import { resolveSprintOutcomeMap, type SprintOutcomeDefinition, getLegacyOutcomeMeta } from '../domains/sprint-definitions/outcomes';

export const RUNTIME_FAILED_OUTCOME = 'runtime_failed';
export const BACKEND_SYSTEM_OUTCOMES = new Set([RUNTIME_FAILED_OUTCOME]);

export interface ResolvedTaskOutcomeCatalogEntry extends SprintOutcomeDefinition {
  workflowPhaseHint: 'implementation' | 'review' | 'release' | 'pm' | 'generic';
  terminalForInstance: boolean;
  blockerLike: boolean;
  failureLike: boolean;
}

function normalizeTaskType(taskType?: string | null): string | null {
  const value = typeof taskType === 'string' ? taskType.trim() : '';
  return value.length > 0 ? value : null;
}

function inferWorkflowPhaseHint(outcomeKey: string, _taskType?: string | null): ResolvedTaskOutcomeCatalogEntry['workflowPhaseHint'] {
  if (outcomeKey === 'completed_for_review' || outcomeKey === 'dev_deploy_queued') return 'implementation';
  if (outcomeKey === 'qa_pass' || outcomeKey === 'qa_fail') return 'review';
  if (outcomeKey === 'deployed_live' || outcomeKey === 'live_verified') return 'release';
  if (outcomeKey === 'blocked' || outcomeKey === 'failed' || outcomeKey === 'qa_fail' || outcomeKey === 'release_failed' || outcomeKey === 'infra_failed' || outcomeKey === RUNTIME_FAILED_OUTCOME || outcomeKey === 'env_blocked' || outcomeKey === 'approval_blocked' || outcomeKey.startsWith('failed:')) return 'generic';
  return 'generic';
}

function metadataFlag(metadata: Record<string, unknown> | undefined, key: 'failure_like' | 'blocked_like'): boolean {
  return metadata?.[key] === true;
}

export function isBackendSystemOutcome(outcomeKey: string): boolean {
  return BACKEND_SYSTEM_OUTCOMES.has(outcomeKey);
}

export function isFailureLikeOutcome(outcomeKey: string, configured?: Pick<SprintOutcomeDefinition, 'metadata'> | null): boolean {
  return metadataFlag(configured?.metadata, 'failure_like')
    || configured?.metadata?.runtime_failure === true
    || outcomeKey === 'failed'
    || outcomeKey === 'qa_fail'
    || outcomeKey === 'release_failed'
    || outcomeKey === 'infra_failed'
    || outcomeKey === RUNTIME_FAILED_OUTCOME
    || outcomeKey.startsWith('failed:');
}

export function isBlockerLikeOutcome(outcomeKey: string, configured?: Pick<SprintOutcomeDefinition, 'metadata'> | null): boolean {
  return metadataFlag(configured?.metadata, 'blocked_like')
    || outcomeKey === 'blocked'
    || outcomeKey === 'env_blocked'
    || outcomeKey === 'approval_blocked';
}

export function isRuntimeFailureOutcome(outcomeKey: string): boolean {
  return outcomeKey === RUNTIME_FAILED_OUTCOME;
}

export function isTerminalInstanceOutcome(outcomeKey: string): boolean {
  return Boolean(outcomeKey);
}

export function resolveTaskOutcomeCatalog(
  db: Database.Database,
  options: { sprintId?: number | null; sprintType?: string | null; taskType?: string | null; fallbackOutcomes?: string[] },
): ResolvedTaskOutcomeCatalogEntry[] {
  const taskType = normalizeTaskType(options.taskType);
  return Array.from(resolveSprintOutcomeMap(db, {
    sprintId: options.sprintId,
    sprintType: options.sprintType,
    taskType,
    fallbackOutcomes: options.fallbackOutcomes,
  }).values()).map((entry) => ({
    ...entry,
    workflowPhaseHint: inferWorkflowPhaseHint(entry.outcome_key, taskType),
    terminalForInstance: isTerminalInstanceOutcome(entry.outcome_key),
    blockerLike: isBlockerLikeOutcome(entry.outcome_key, entry),
    failureLike: isFailureLikeOutcome(entry.outcome_key, entry),
  }));
}

export function resolveTaskOutcomeCatalogEntries(
  db: Database.Database,
  options: { sprintId?: number | null; sprintType?: string | null; taskType?: string | null; fallbackOutcomes?: string[] },
): ResolvedTaskOutcomeCatalogEntry[] {
  return resolveTaskOutcomeCatalog(db, options);
}

export function getOutcomeDisplayMeta(outcomeKey: string, configured?: Pick<SprintOutcomeDefinition, 'label' | 'description' | 'badge_variant'> | null) {
  if (outcomeKey === RUNTIME_FAILED_OUTCOME && !configured) {
    return {
      label: 'Runtime Failed',
      description: 'The runtime or control plane failed before the agent could post its own outcome.',
      badge_variant: 'failed',
    };
  }
  const legacy = getLegacyOutcomeMeta(outcomeKey);
  return {
    label: configured?.label || legacy.label,
    description: configured?.description || legacy.description,
    badge_variant: configured?.badge_variant ?? legacy.badge_variant ?? 'workspace',
  };
}
