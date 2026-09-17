'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, WorkflowMetadataResponse, WorkflowOutcomeMeta } from '@/lib/api';

const EMPTY_WORKFLOW_METADATA: WorkflowMetadataResponse = {
  workflow_id: null,
  workflow_type: 'generic',
  task_type: null,
  task_types: [],
  statuses: [],
  transitions: [],
  outcomes: [],
  relationship_types: [],
  non_failure_outcomes: [],
  routing_warnings: [],
};

function cacheKey(workflowId?: number | null, workflowType?: string | null, taskType?: string | null) {
  return ['workflow-metadata', workflowId ?? '', workflowType ?? '', taskType ?? ''].join(':');
}

export function buildOutcomeMetaMap(outcomes: WorkflowOutcomeMeta[] = []) {
  return Object.fromEntries(outcomes.map(outcome => [outcome.outcome_key, outcome])) as Record<string, WorkflowOutcomeMeta>;
}

export function useWorkflowMetadata(
  workflowId?: number | null,
  options?: { workflowType?: string | null; taskType?: string | null },
) {
  const [metadata, setMetadata] = useState<WorkflowMetadataResponse>(EMPTY_WORKFLOW_METADATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api.getWorkflowMetadata({
      workflow_id: workflowId ?? null,
      workflow_type: options?.workflowType ?? null,
      task_type: options?.taskType ?? null,
    })
      .then(data => {
        if (!cancelled) setMetadata(data);
      })
      .catch(err => {
        if (!cancelled) {
          setError(err);
          setMetadata(EMPTY_WORKFLOW_METADATA);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [workflowId, options?.workflowType, options?.taskType]);

  const outcomeMap = useMemo(() => buildOutcomeMetaMap(metadata.outcomes), [metadata.outcomes]);
  const nonFailureOutcomes = useMemo(() => new Set(metadata.non_failure_outcomes), [metadata.non_failure_outcomes]);

  return {
    cacheKey: cacheKey(workflowId, options?.workflowType, options?.taskType),
    metadata,
    outcomeMap,
    nonFailureOutcomes,
    loading,
    error,
  };
}
