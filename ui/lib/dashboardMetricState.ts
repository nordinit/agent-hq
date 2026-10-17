import type { MetricDefinition, TelemetryQuery, TelemetryResult } from './telemetryTypes';

export interface DashboardMetricState { definition?: MetricDefinition; result?: TelemetryResult; query?: TelemetryQuery; error?: string; busy: boolean }
export interface DashboardMetricSnapshot { requestKey: string; data: Record<string, DashboardMetricState> }

/** Reuse visible values only while refreshing exactly the same pinned queries. */
export function beginDashboardRefresh(previous: DashboardMetricSnapshot, requestKey: string, bindingIds: string[]): DashboardMetricSnapshot {
  return { requestKey, data: Object.fromEntries(bindingIds.map(id => [id, {
    ...(previous.requestKey === requestKey ? previous.data[id] : undefined), busy: true, error: undefined,
  }])) };
}

/** A failed refresh can retain its previous value, but must display the failure. */
export function finishDashboardMetric(previous: DashboardMetricState | undefined, next: DashboardMetricState): DashboardMetricState {
  return { ...next, result: next.result ?? (next.error ? previous?.result : undefined) };
}
