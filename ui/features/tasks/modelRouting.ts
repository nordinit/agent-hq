import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import {
  ModelRoutingRule,
  resolveEffectiveModel,
  shortModelName,
} from '@/lib/modelRouting';

export type { ModelRoutingRule };
export { resolveEffectiveModel, shortModelName };

export function useModelRoutingRules(projectId: number | null | undefined, workflowId: number | null | undefined): ModelRoutingRule[] {
  const [rules, setRules] = useState<ModelRoutingRule[]>([]);
  useEffect(() => {
    const params = new URLSearchParams();
    if (projectId) params.set('project_id', String(projectId));
    if (workflowId) params.set('workflow_id', String(workflowId));
    if (projectId || workflowId) params.set('include_fallback', 'true');
    const query = params.toString();
    apiFetch<ModelRoutingRule[]>(`/api/v1/model-routing${query ? `?${query}` : ''}`)
      .then(setRules)
      .catch(() => {});
  }, [projectId, workflowId]);
  return rules;
}
