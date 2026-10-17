'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type CompletedRecentTask, type DashboardStats } from '@/lib/api';
import { telemetryClient } from '@/lib/api/telemetry';
import { dashboardBlocks } from '@/lib/dashboardLayout';
import { telemetryResponseResults, telemetryWidgetQuery } from '@/lib/telemetryViews';
import type { DashboardDocument } from '@/lib/dashboardTypes';
import type { MetricDefinition, TelemetryMetric, TelemetryQuery, TelemetryResult, TelemetryScope } from '@/lib/telemetryTypes';
import { createTelemetryRecoveryGate } from '@/lib/telemetryRecovery';
import { beginDashboardRefresh, finishDashboardMetric, type DashboardMetricSnapshot, type DashboardMetricState } from '@/lib/dashboardMetricState';

export type { DashboardMetricState } from '@/lib/dashboardMetricState';
export interface DashboardOperations { stats?: DashboardStats; tasks?: CompletedRecentTask[]; statsError?: string; tasksError?: string; busy: boolean }
export function useDashboardData(page: DashboardDocument, metrics: TelemetryMetric[], scope: TelemetryScope, window: { from?: string; to?: string; timezone: string }, refresh: number) {
  const [snapshot, setSnapshot] = useState<DashboardMetricSnapshot>({ requestKey: '', data: {} });
  const [operations, setOperations] = useState<DashboardOperations>({ busy: false });
  const recoverRef = useRef<(bindingId: string, queryId: string, manual?: boolean) => Promise<boolean>>(async () => false);
  const recover = useCallback((bindingId: string, queryId: string, manual?: boolean) => recoverRef.current(bindingId, queryId, manual), []);
  // Layout, labels and formatting never trigger recalculation. Duplicate blocks
  // share a binding; identical bindings share both the result and retained proof.
  const requestKey = JSON.stringify({ bindings: page.metrics.map(({ id, metric_id, metric_revision_id, view }) => ({ id, metric_id, metric_revision_id, view: view ? { ...view, sort: undefined } : undefined })), scope, window });
  const data = snapshot.requestKey === requestKey ? snapshot.data : {};
  useEffect(() => {
    const controller = new AbortController();
    const input = JSON.parse(requestKey) as { bindings: DashboardDocument['metrics']; scope: TelemetryScope; window: typeof window };
    setSnapshot(current => beginDashboardRefresh(current, requestKey, input.bindings.map(binding => binding.id)));
    const setData = (update: (current: Record<string, DashboardMetricState>) => Record<string, DashboardMetricState>) => {
      if (!controller.signal.aborted) setSnapshot(current => current.requestKey === requestKey ? { ...current, data: update(current.data) } : current);
    };
    const definitions = new Map<string, Promise<MetricDefinition>>();
    const loaded = new Map<string, DashboardMetricState>();
    const recovery = createTelemetryRecoveryGate();
    recoverRef.current = async (bindingId, queryId, manual = false) => {
      const state = loaded.get(bindingId);
      if (controller.signal.aborted || !state?.query) return false;
      if (state.result?.query_id !== queryId) return true;
      const query = state.query, key = JSON.stringify(query);
      return recovery.run(key, async () => {
        const affected = [...loaded].filter(([, value]) => JSON.stringify(value.query) === key).map(([id]) => id);
        setData(current => ({ ...current, ...Object.fromEntries(affected.map(id => [id, { ...current[id], busy: true, error: undefined }])) }));
        try {
          const pending = telemetryClient.queryTelemetry(query, controller.signal).then(response => {
            const result = telemetryResponseResults(response)[0];
            if (!result) throw new Error('No result returned. Try a narrower scope in Analyze.');
            return result;
          });
          const result = await pending;
          if (controller.signal.aborted) return;
          for (const id of affected) loaded.set(id, { ...loaded.get(id)!, result, busy: false, error: undefined });
          setData(current => ({ ...current, ...Object.fromEntries(affected.map(id => [id, loaded.get(id)!])) }));
        } catch (cause) {
          if (!controller.signal.aborted) {
            const error = cause instanceof Error ? cause.message : 'Could not refresh this calculation.';
            for (const id of affected) loaded.set(id, { ...loaded.get(id)!, busy: false, error });
            setData(current => ({ ...current, ...Object.fromEntries(affected.map(id => [id, loaded.get(id)!])) }));
          }
          throw cause;
        }
      }, manual);
    };
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
    const load = async () => {
      type Prepared = { id: string; definition: MetricDefinition; query: TelemetryQuery };
      const prepared = await Promise.all(input.bindings.map(async binding => {
        try {
          const definition = await definitionFor(binding);
          return { id: binding.id, definition, query: telemetryWidgetQuery(binding, definition, input.scope, input.window) };
        } catch (cause) {
          if (!controller.signal.aborted) setData(current => ({ ...current, [binding.id]: { error: cause instanceof Error ? cause.message : 'Could not load this metric.', busy: false } }));
          return undefined;
        }
      }));
      if (controller.signal.aborted) return;
      const unique = new Map<string, Prepared[]>();
      for (const item of prepared) if (item) {
        const key = JSON.stringify(item.query), bindings = unique.get(key) ?? [];
        bindings.push(item); unique.set(key, bindings);
      }
      const groups = [...unique.entries()];
      for (let offset = 0; offset < groups.length && !controller.signal.aborted; offset += 10) {
        const chunk = groups.slice(offset, offset + 10);
        const publish = (bindings: Prepared[], result?: TelemetryResult, error?: string) => {
          if (controller.signal.aborted) return;
          const changes: Record<string, DashboardMetricState> = {};
          for (const binding of bindings) {
            const state = { definition: binding.definition, query: binding.query, result, error, busy: false };
            changes[binding.id] = state;
          }
          setData(current => ({ ...current, ...Object.fromEntries(Object.entries(changes).map(([id, next]) => {
            const state = finishDashboardMetric(current[id], next);
            loaded.set(id, state);
            return [id, state];
          })) }));
        };
        try {
          const response = await telemetryClient.queryTelemetryBatch({ queries: chunk.map(([, bindings]) => ({ binding_id: bindings[0].id, query: bindings[0].query })) }, controller.signal);
          if (controller.signal.aborted) return;
          const byBinding = new Map(response.results.map(item => [item.binding_id, item]));
          for (const [, bindings] of chunk) {
            const item = byBinding.get(bindings[0].id);
            const result = item?.response ? telemetryResponseResults(item.response)[0] : undefined;
            if (result) publish(bindings, result);
            else publish(bindings, undefined, item?.error?.message ?? 'No result returned. Try a narrower scope in Analyze.');
          }
        } catch (cause) {
          const error = cause instanceof Error ? cause.message : 'Could not load these metrics.';
          for (const [, bindings] of chunk) publish(bindings, undefined, error);
        }
      }
    };
    const debounce = setTimeout(() => { void load(); }, 250);
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
  return { data, operations, recover };
}
