import type { TelemetryBinding, TelemetryBindingPreview, TelemetryBindingPreviewRequest, TelemetryScope } from './telemetryTypes.ts';

export function telemetryBindingPreviewRequest(binding: TelemetryBinding, scope: TelemetryScope): TelemetryBindingPreviewRequest | null {
  if (!binding.family_key.trim()) return null;
  const request: TelemetryBindingPreviewRequest = { family_key: binding.family_key.trim(), scope };
  if (binding.disabled) request.override = { disabled: true, metric_revision_id: null, profile_revision_id: null };
  else if (binding.metric_revision_id) request.override = { disabled: false, metric_revision_id: binding.metric_revision_id, profile_revision_id: binding.profile_revision_id ?? null };
  return request;
}
export interface TelemetryBindingReview { requestKey: string; preview: TelemetryBindingPreview }
export function telemetryBindingAttention(binding: Pick<TelemetryBinding, 'validation_state' | 'validation_issues'>): string[] {
  const issues = binding.validation_issues?.filter(issue => typeof issue === 'string' && issue.trim()) ?? [];
  if (issues.length) return issues;
  return binding.validation_state === 'needs_attention' ? ['A referenced workflow signal is no longer valid. Review this binding before using it.'] : [];
}
export function telemetryBindingWrite(binding: TelemetryBinding, scope: TelemetryScope, review: TelemetryBindingReview | null) {
  const request = telemetryBindingPreviewRequest(binding, scope);
  if (!request?.override || !review || review.requestKey !== JSON.stringify(request) || !review.preview.proposed) throw new Error('Wait for a successful preview of this exact binding before saving.');
  // The server resolved the effective scope. Use the current exact winner's version;
  // an inherited winner is not the row this save would replace.
  const current = review.preview.current;
  return { family_key: request.family_key, scope: review.preview.scope, ...request.override,
    expected_version: current.origin === 'exact' ? current.winner?.version : undefined };
}
