export interface ModelRoutingRule {
  id: number;
  max_points: number;
  provider: string;
  model: string;
  label: string | null;
  project_id?: number | null;
  sprint_id?: number | null;
  enabled?: boolean | number | null;
}

export function shortModelName(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('haiku')) return 'Haiku';
  if (lower.includes('sonnet')) return 'Sonnet';
  if (lower.includes('opus')) return 'Opus';
  if (lower.includes('gpt-4.1-mini')) return 'GPT-4.1 Mini';
  if (lower.includes('gpt-4.1')) return 'GPT-4.1';
  if (lower.includes('gpt-5')) return 'GPT-5';
  if (lower.includes('gemini-flash')) return 'Gemini Flash';
  if (lower.includes('gemini')) return 'Gemini';
  const parts = model.split('/');
  return parts[parts.length - 1] ?? model;
}

export function modelRuleScopeRank(
  rule: ModelRoutingRule,
  projectId: number | null | undefined,
  sprintId: number | null | undefined,
): number {
  if (projectId && sprintId && rule.project_id === projectId && rule.sprint_id === sprintId) return 0;
  if (projectId && rule.project_id === projectId && rule.sprint_id == null) return 1;
  if (rule.project_id == null && rule.sprint_id == null) return 2;
  return 3;
}

export function resolveEffectiveModel(
  storyPoints: number | null | undefined,
  rules: ModelRoutingRule[],
  projectId: number | null | undefined,
  sprintId: number | null | undefined,
): string | null {
  if (storyPoints == null || rules.length === 0) return null;
  const enabledRules = rules.filter(rule => rule.enabled !== false && rule.enabled !== 0);
  if (enabledRules.length === 0) return null;
  const bestRank = Math.min(...enabledRules.map(rule => modelRuleScopeRank(rule, projectId, sprintId)));
  const sorted = enabledRules
    .filter(rule => modelRuleScopeRank(rule, projectId, sprintId) === bestRank)
    .sort((a, b) => a.max_points - b.max_points);
  const match = sorted.find(r => storyPoints <= r.max_points);
  return match ? match.model : sorted[sorted.length - 1]?.model ?? null;
}
