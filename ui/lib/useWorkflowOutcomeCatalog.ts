'use client';

import { useEffect, useState } from 'react';
import { RUNTIME_FAILED_DESCRIPTION, RUNTIME_FAILED_LABEL, RUNTIME_FAILED_OUTCOME } from './systemOutcomes';
import { api, type ResolvedWorkflowOutcome, type WorkflowTypeOutcome } from '@/lib/api';

export type WorkflowOutcomeCatalogState = {
  outcomes: WorkflowTypeOutcome[];
  resolved: ResolvedWorkflowOutcome[];
  error: string | null;
};

export type OutcomeOption = {
  value: string;
  label: string;
  description: string;
  taskType: string | null;
  source: 'configured' | 'fallback';
};

function flattenResolvedOutcomes(data: { base: ResolvedWorkflowOutcome[]; by_task_type: Record<string, ResolvedWorkflowOutcome[]> } | null): ResolvedWorkflowOutcome[] {
  if (!data) return [];
  return [
    ...data.base,
    ...Object.values(data.by_task_type).flat(),
  ];
}

export function useWorkflowOutcomeCatalog(workflowType: string | null): WorkflowOutcomeCatalogState {
  const [state, setState] = useState<WorkflowOutcomeCatalogState>({ outcomes: [], resolved: [], error: null });

  useEffect(() => {
    let cancelled = false;
    if (!workflowType) {
      setState({ outcomes: [], resolved: [], error: null });
      return;
    }
    api.getWorkflowOutcomes(workflowType)
      .then(response => {
        if (cancelled) return;
        setState({
          outcomes: response.outcomes ?? [],
          resolved: flattenResolvedOutcomes(response.resolved_outcomes),
          error: null,
        });
      })
      .catch(error => {
        if (cancelled) return;
        setState({ outcomes: [], resolved: [], error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [workflowType]);

  return state;
}

export function mergeOutcomeOptions(catalog: WorkflowOutcomeCatalogState, taskType: string | null): OutcomeOption[] {
  const relevantResolved = catalog.resolved.filter(outcome => (outcome.task_type ?? null) === (taskType ?? null));
  const configured = catalog.outcomes.filter(outcome => (outcome.task_type ?? null) === (taskType ?? null));
  const source = relevantResolved.length > 0 ? relevantResolved : configured;
  const options = source
    .filter(outcome => outcome.enabled !== 0)
    .map(outcome => ({
      value: outcome.outcome_key,
      label: outcome.label || outcome.outcome_key,
      description: outcome.description || '',
      taskType: outcome.task_type ?? null,
      source: ('source' in outcome && outcome.source ? outcome.source : 'configured') as 'configured' | 'fallback',
    }));
  const deduped = new Map<string, OutcomeOption>();
  for (const option of options) {
    if (!deduped.has(option.value)) deduped.set(option.value, option);
  }
  // The built-in runtime_failed is never in a workflow type's catalog but can always be routed.
  if (!deduped.has(RUNTIME_FAILED_OUTCOME)) {
    deduped.set(RUNTIME_FAILED_OUTCOME, {
      value: RUNTIME_FAILED_OUTCOME,
      label: RUNTIME_FAILED_LABEL,
      description: RUNTIME_FAILED_DESCRIPTION,
      taskType: taskType ?? null,
      source: 'configured',
    });
  }
  return Array.from(deduped.values()).sort((a, b) => a.label.localeCompare(b.label));
}

export function firstOutcomeOptionValue(options: OutcomeOption[]): string {
  return options[0]?.value ?? '';
}

export function formatOutcomeOptionLabel(option: OutcomeOption): string {
  return option.description ? `${option.label} (${option.value})` : `${option.label} (${option.value})`;
}
