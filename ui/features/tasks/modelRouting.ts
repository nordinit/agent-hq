import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import {
  ModelRoutingRule,
  resolveEffectiveModel,
  shortModelName,
} from '@/lib/modelRouting';

export type { ModelRoutingRule };
export { resolveEffectiveModel, shortModelName };

export function useModelRoutingRules(projectId: number | null | undefined, sprintId: number | null | undefined): ModelRoutingRule[] {
  const [rules, setRules] = useState<ModelRoutingRule[]>([]);
  useEffect(() => {
    const params = new URLSearchParams();
    if (projectId) params.set('project_id', String(projectId));
    if (sprintId) params.set('sprint_id', String(sprintId));
    if (projectId || sprintId) params.set('include_fallback', 'true');
    const query = params.toString();
    apiFetch<ModelRoutingRule[]>(`/api/v1/model-routing${query ? `?${query}` : ''}`)
      .then(setRules)
      .catch(() => {});
  }, [projectId, sprintId]);
  return rules;
}
