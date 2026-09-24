'use client';
import { useEffect, useState } from 'react';
import { api, type CompletedRecentTask, type DashboardStats } from '@/lib/api';
import { telemetryClient } from '@/lib/api/telemetry';
import { dashboardBlocks } from '@/lib/dashboardLayout';
import { telemetryResponseResults, telemetryWidgetQuery } from '@/lib/telemetryViews';
import type { DashboardDocument } from '@/lib/dashboardTypes';
import type { MetricDefinition, TelemetryMetric, TelemetryQuery, TelemetryResult, TelemetryScope } from '@/lib/telemetryTypes';

export interface DashboardMetricState { definition?: MetricDefinition; result?: TelemetryResult; query?: TelemetryQuery; error?: string; busy: boolean }
export interface DashboardOperations { stats?: DashboardStats; tasks?: CompletedRecentTask[]; statsError?: string; tasksError?: string; busy: boolean }
export function useDashboardData(page: DashboardDocument, metrics: TelemetryMetric[], scope: TelemetryScope, window: { from?: string; to?: string; timezone: string }, refresh: number) {
  const [data, setData] = useState<Record<string, DashboardMetricState>>({});
  const [operations, setOperations] = useState<DashboardOperations>({ busy: false });
  // Layout, labels and formatting never trigger recalculation. Duplicate blocks
  // share a binding; identical bindings share both the result and retained proof.
  const requestKey = JSON.stringify({ bindings: page.metrics.map(({ id, metric_id, metric_revision_id, view }) => ({ id, metric_id, metric_revision_id, view: view ? { ...view, sort: undefined } : undefined })), scope, window });
  useEffect(() => {
    const controller = new AbortController();
    const input = JSON.parse(requestKey) as { bindings: DashboardDocument['metrics']; scope: TelemetryScope; window: typeof window };
    setData(Object.fromEntries(input.bindings.map(binding => [binding.id, { busy: true }])));
    const definitions = new Map<string, Promise<MetricDefinition>>();
    const queries = new Map<string, Promise<TelemetryResult>>();
    const definitionFor = (binding: DashboardDocument['metrics'][number]) => {
      const existing = definitions.get(binding.metric_revision_id); if (existing) return existing;
      const promise = (async () => {
        const family = metrics.find(metric => metric.id === binding.metric_id || metric.latest_revision_id === binding.metric_revision_id);
        if (!family && !binding.metric_id) throw new Error('The pinned metric is unavailable.');
        const resource = family?.latest_revision_id === binding.metric_revision_id ? family : await telemetryClient.getTelemetryResource<MetricDefinition>('metrics', family?.id ?? binding.metric_id!);
        const definition = resource.latest_revision_id === binding.metric_revision_id ? resource.definition : resource.revisions?.find(revision => revision.id === binding.metric_revision_id)?.definition;
        if (!definition) throw new Error('The pinned metric revision is unavailable.');
        return definition;
      })();
      definitions.set(binding.metric_revision_id, promise); return promise;
    };
    let cursor = 0;
    const worker = async () => {
      while (!controller.signal.aborted && cursor < input.bindings.length) {
        const binding = input.bindings[cursor++]; let definition: MetricDefinition | undefined;
        try {
          definition = await definitionFor(binding);
          if (controller.signal.aborted) return;
          const query = telemetryWidgetQuery(binding, definition, input.scope, input.window), key = JSON.stringify(query);
          let pending = queries.get(key);
          if (!pending) {
            pending = telemetryClient.queryTelemetry(query, controller.signal).then(response => {
              const result = telemetryResponseResults(response)[0];
              if (!result) throw new Error('No result returned. Try a narrower scope in Analyze.');
              return result;
            }); queries.set(key, pending);
          }
          const result = await pending;
          if (!controller.signal.aborted) setData(current => ({ ...current, [binding.id]: { definition, result, query, busy: false } }));
        } catch (cause) {
          if (!controller.signal.aborted) setData(current => ({ ...current, [binding.id]: { definition, error: cause instanceof Error ? cause.message : 'Could not load this metric.', busy: false } }));
        }
      }
    };
    const debounce = setTimeout(() => { void Promise.all(Array.from({ length: Math.min(3, input.bindings.length) }, worker)); }, 250);
    return () => { clearTimeout(debounce); controller.abort(); };
  }, [requestKey, metrics, refresh]);
  const needsOperations = dashboardBlocks(page).some(block => block.type === 'operation');
  const project = scope.project_id;
  const invalidOperationalScope = Boolean(scope.workflow_id || scope.workflow_type || scope.task_type);
  useEffect(() => {
    let active = true;
    if (!needsOperations) { setOperations({ busy: false }); return; }
    if (invalidOperationalScope) { setOperations({ busy: false, statsError: 'Operational blocks support project scope only.', tasksError: 'Operational blocks support project scope only.' }); return; }
    setOperations({ busy: true });
    void Promise.allSettled([api.getStats(project), api.getCompletedRecent(24, project)]).then(([stats, tasks]) => {
      if (!active) return;
      setOperations({ busy: false, ...(stats.status === 'fulfilled' ? { stats: stats.value } : { statsError: String(stats.reason) }), ...(tasks.status === 'fulfilled' ? { tasks: tasks.value.tasks } : { tasksError: String(tasks.reason) }) });
    });
    return () => { active = false; };
  }, [needsOperations, project, invalidOperationalScope, refresh]);
  return { data, operations };
}
