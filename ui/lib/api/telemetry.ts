import { getApiBase } from './http';
import { telemetryScopeQuery } from '../telemetryPresentation';
import type { DefinitionValidation, MetricDefinition, TelemetryBinding, TelemetryBindingPreview, TelemetryBindingPreviewRequest, TelemetryCatalog, TelemetryContributors, TelemetryMetric, TelemetryProfile, TelemetryQuery, TelemetryQueryResponse, TelemetryReport, TelemetryReportDefinition, TelemetryResource, TelemetryScope } from '../telemetryTypes';

const BASE = '/api/v1/telemetry/v2';
export class TelemetryApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number, readonly details?: unknown) { super(message); this.name = 'TelemetryApiError'; }
}
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${getApiBase()}${BASE}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body?.error;
    let message = typeof error === 'string' ? error : error?.message ?? body?.message ?? `Telemetry request failed (${response.status}).`;
    if (Array.isArray(body?.issues)) message += '\n' + body.issues.map((issue: { path?: unknown; message?: string }) => `${Array.isArray(issue.path) ? issue.path.join('.') : issue.path ?? ''}: ${issue.message ?? 'Invalid value'}`).join('\n');
    throw new TelemetryApiError(message, error?.code ?? body?.code ?? 'request_failed', response.status, body?.issues ?? body?.details);
  }
  return body as T;
}
const post = <T>(path: string, body: unknown, signal?: AbortSignal) => request<T>(path, { method: 'POST', body: JSON.stringify(body), signal });
const scopeQuery = (scope?: TelemetryScope) => telemetryScopeQuery({ ...scope });
type ResourceKind = 'metrics' | 'profiles' | 'reports';

export const telemetryClient = {
  getTelemetryCatalog: (scope?: TelemetryScope, signal?: AbortSignal) => request<TelemetryCatalog>(`/catalog${scopeQuery(scope)}`, { signal }),
  validateTelemetryDefinition: (definition: MetricDefinition, scope: TelemetryScope) => post<DefinitionValidation & { description?: string }>('/definitions/validate', { definition, scope }),
  previewTelemetry: (query: TelemetryQuery, signal?: AbortSignal) => post<TelemetryQueryResponse>('/queries/preview', query, signal),
  queryTelemetry: (query: TelemetryQuery, signal?: AbortSignal) => post<TelemetryQueryResponse>('/queries', query, signal),
  getTelemetryQuery: (id: string, signal?: AbortSignal) => request<TelemetryQueryResponse>(`/queries/${encodeURIComponent(id)}`, { signal }),
  cancelTelemetryQuery: (id: string) => request<{ cancelled: boolean }>(`/queries/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  getTelemetryContributors: (id: string, options: { offset?: number; limit?: number; metric_revision_id?: string; metric_index?: number; included?: boolean; group?: string } = {}, signal?: AbortSignal) => request<TelemetryContributors>(`/queries/${encodeURIComponent(id)}/contributors${telemetryScopeQuery(options)}`, { signal }),
  getTelemetryMetrics: (scope?: TelemetryScope, signal?: AbortSignal) => request<{ metrics: TelemetryMetric[] }>(`/metrics${scopeQuery(scope)}`, { signal }),
  getTelemetryReports: (scope?: TelemetryScope, signal?: AbortSignal) => request<{ reports: TelemetryReport[] }>(`/reports${scopeQuery(scope)}`, { signal }),
  getTelemetryProfiles: (scope?: TelemetryScope, signal?: AbortSignal) => request<{ profiles: TelemetryProfile[] }>(`/profiles${scopeQuery(scope)}`, { signal }),
  getTelemetryResource: <T>(kind: ResourceKind, id: string) => request<TelemetryResource<T>>(`/${kind}/${encodeURIComponent(id)}`),
  createTelemetryMetric: (data: { key: string; name: string; scope: TelemetryScope; definition: MetricDefinition }) => post<TelemetryMetric>('/metrics', data),
  reviseTelemetryMetric: (id: string, data: { definition: MetricDefinition; expected_revision_id: string }) => post<TelemetryMetric>(`/metrics/${encodeURIComponent(id)}/revisions`, { ...data, name: data.definition.name }),
  createTelemetryReport: (data: { key: string; name: string; scope: TelemetryScope; definition: TelemetryReportDefinition }) => post<TelemetryReport>('/reports', data),
  reviseTelemetryReport: (id: string, data: { definition: TelemetryReportDefinition; expected_revision_id: string; name?: string }) => post<TelemetryReport>(`/reports/${encodeURIComponent(id)}/revisions`, data),
  saveTelemetryProfile: (data: { key: string; name: string; scope: TelemetryScope; definition: TelemetryProfile['definition'] }, existing?: TelemetryProfile) => existing ? post<TelemetryProfile>(`/profiles/${encodeURIComponent(existing.id)}/revisions`, { name: data.name, definition: data.definition, expected_revision_id: existing.latest_revision_id }) : post<TelemetryProfile>('/profiles', data),
  archiveTelemetryResource: (kind: ResourceKind, id: string) => request<{ ok: boolean }>(`/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  getTelemetryBindings: (scope?: TelemetryScope, signal?: AbortSignal) => request<{ bindings: TelemetryBinding[] }>(`/bindings${scopeQuery(scope)}`, { signal }),
  previewTelemetryBinding: (data: TelemetryBindingPreviewRequest, signal?: AbortSignal) => post<TelemetryBindingPreview>('/bindings/preview', data, signal),
  saveTelemetryBinding: (binding: TelemetryBinding & { expected_version?: number }) => request<{ binding: TelemetryBinding }>('/bindings', { method: 'PUT', body: JSON.stringify(binding) }),
  getTelemetryCoverage: (scope?: TelemetryScope, signal?: AbortSignal) => request<Record<string, unknown>>(`/coverage${scopeQuery(scope)}`, { signal }),
  getTelemetrySnapshots: (id: string) => request<{ snapshots: Record<string, unknown>[] }>(`/reports/${encodeURIComponent(id)}/snapshots`),
  freezeTelemetryReport: (id: string, data: { query_id: string; name?: string; report_revision_id?: string }) => post<Record<string, unknown>>(`/reports/${encodeURIComponent(id)}/snapshots`, data),
  exportTelemetry: (data: { scope: TelemetryScope; metric_ids?: string[]; report_ids?: string[]; profile_ids?: string[] }) => post<Record<string, unknown>>('/export', data),
  importTelemetry: (data: { bundle: unknown; scope: TelemetryScope; reference_map: Record<string, string> }) => post<Record<string, unknown>>('/import', data),
};
