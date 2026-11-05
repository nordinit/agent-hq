import { resolveWorkflowOutcomeMap, type WorkflowOutcomeDefinition } from '../domains/workflow-definitions/outcomes';
import { type Db } from "../db/adapter/types";

import { RUNTIME_FAILED_OUTCOME, BACKEND_SYSTEM_OUTCOMES, isBackendSystemOutcome } from './systemOutcomes';

export { RUNTIME_FAILED_OUTCOME, BACKEND_SYSTEM_OUTCOMES, isBackendSystemOutcome };

export interface ResolvedTaskOutcomeCatalogEntry extends WorkflowOutcomeDefinition {
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
  return 'generic';
}

function metadataFlag(metadata: Record<string, unknown> | undefined, key: 'failure_like' | 'blocked_like'): boolean {
  return metadata?.[key] === true;
}

/**
 * Whether an outcome means the work failed. The outcome's own configuration (failure_like) decides,
 * except for the built-in runtime_failed, which always is.
 */
export function isFailureLikeOutcome(outcomeKey: string, configured?: Pick<WorkflowOutcomeDefinition, 'metadata'> | null): boolean {
  return metadataFlag(configured?.metadata, 'failure_like') || outcomeKey === RUNTIME_FAILED_OUTCOME;
}

/** Whether an outcome means the work is blocked. Only the outcome's own configuration decides this. */
export function isBlockerLikeOutcome(_outcomeKey: string, configured?: Pick<WorkflowOutcomeDefinition, 'metadata'> | null): boolean {
  return metadataFlag(configured?.metadata, 'blocked_like');
}

export function isRuntimeFailureOutcome(outcomeKey: string): boolean {
  return outcomeKey === RUNTIME_FAILED_OUTCOME;
}

export function isTerminalInstanceOutcome(outcomeKey: string): boolean {
  return Boolean(outcomeKey);
}

export async function resolveTaskOutcomeCatalog(
  db: Db,
  options: { workflowId?: number | null; workflowType?: string | null; taskType?: string | null; fallbackOutcomes?: string[] },
): Promise<ResolvedTaskOutcomeCatalogEntry[]> {
  const taskType = normalizeTaskType(options.taskType);
  return Array.from((await resolveWorkflowOutcomeMap(db, {
          workflowId: options.workflowId,
          workflowType: options.workflowType,
          taskType,
          fallbackOutcomes: options.fallbackOutcomes,
        })).values()).map((entry) => ({
    ...entry,
    workflowPhaseHint: inferWorkflowPhaseHint(entry.outcome_key, taskType),
    terminalForInstance: isTerminalInstanceOutcome(entry.outcome_key),
    blockerLike: isBlockerLikeOutcome(entry.outcome_key, entry),
    failureLike: isFailureLikeOutcome(entry.outcome_key, entry),
  }));
}
