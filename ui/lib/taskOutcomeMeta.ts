import type { WorkflowOutcomeMeta } from './api';
import { getBadgeVariantClass } from './badgeVariants.ts';

export type TaskOutcomeMetaMap = Record<string, WorkflowOutcomeMeta>;

export function getTaskOutcomeMeta(outcomeKey: string, outcomeMap?: TaskOutcomeMetaMap) {
  return outcomeMap?.[outcomeKey] ?? {
    sprint_type_key: '',
    task_type: null,
    outcome_key: outcomeKey,
    label: outcomeKey,
    description: '',
    enabled: 1,
    behavior: 'base',
    badge_variant: null,
    stage_order: 0,
    is_system: 0,
    metadata: {},
  } satisfies WorkflowOutcomeMeta;
}

export function getTaskOutcomeBadgeClass(outcomeKey: string, outcomeMap?: TaskOutcomeMetaMap): string {
  const meta = getTaskOutcomeMeta(outcomeKey, outcomeMap);
  return getBadgeVariantClass(meta.badge_variant, 'workspace');
}

function outcomeMetadataFlag(outcomeKey: string | null | undefined, outcomeMap: TaskOutcomeMetaMap | undefined, flag: 'failure_like' | 'blocked_like'): boolean {
  if (!outcomeKey) return false;
  const configured = outcomeMap?.[outcomeKey];
  return configured?.metadata?.[flag] === true;
}

export function isTaskOutcomeFailureLike(outcomeKey: string | null | undefined, outcomeMap?: TaskOutcomeMetaMap): boolean {
  return outcomeMetadataFlag(outcomeKey, outcomeMap, 'failure_like');
}

export function isTaskOutcomeBlockedLike(outcomeKey: string | null | undefined, outcomeMap?: TaskOutcomeMetaMap): boolean {
  return outcomeMetadataFlag(outcomeKey, outcomeMap, 'blocked_like');
}

export function isTaskOutcomeUnsuccessful(outcomeKey: string | null | undefined, outcomeMap?: TaskOutcomeMetaMap): boolean {
  return isTaskOutcomeFailureLike(outcomeKey, outcomeMap) || isTaskOutcomeBlockedLike(outcomeKey, outcomeMap);
}

export function formatFailureOutcomeBadgeLabel(baseLabel: string, blockedLike: boolean): string {
  const trimmedLabel = baseLabel.trim();
  if (blockedLike) {
    if (/\bblocked\b/i.test(trimmedLabel)) return trimmedLabel;
    return `${trimmedLabel} blocked`;
  }
  if (/\bfailed\b/i.test(trimmedLabel)) return trimmedLabel;
  return `${trimmedLabel} failed`;
}
