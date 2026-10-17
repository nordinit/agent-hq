import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginDashboardRefresh, finishDashboardMetric, type DashboardMetricSnapshot } from './dashboardMetricState.ts';
import type { TelemetryResult } from './telemetryTypes';

const result = { query_id: 'proof-1', value: 10 } as TelemetryResult;
const previous: DashboardMetricSnapshot = { requestKey: 'project-99/revision-1', data: { searches: { result, busy: false } } };

test('refresh keeps an already loaded metric visible until its replacement arrives', () => {
  const next = beginDashboardRefresh(previous, previous.requestKey, ['searches']);
  assert.equal(next.data.searches.result, result);
  assert.equal(next.data.searches.busy, true);
  const replacement = { ...result, query_id: 'proof-2', value: 11 };
  assert.deepEqual(finishDashboardMetric(next.data.searches, { result: replacement, busy: false }), { result: replacement, busy: false });
});

test('changing scope or pinned queries clears prior values and removes obsolete bindings', () => {
  const next = beginDashboardRefresh(previous, 'project-100/revision-1', ['searches', 'new']);
  assert.equal(next.data.searches.result, undefined);
  assert.equal(next.data.new.busy, true);
  assert.deepEqual(beginDashboardRefresh(previous, previous.requestKey, []).data, {});
});

test('a failed refresh retains the previous value with an explicit error, while a first-load failure has no value', () => {
  const failure = { busy: false, error: 'Database busy' };
  assert.deepEqual(finishDashboardMetric(previous.data.searches, failure), { ...failure, result });
  assert.equal(finishDashboardMetric(undefined, failure).result, undefined);
  const retry = beginDashboardRefresh({ ...previous, data: { searches: { ...failure, result } } }, previous.requestKey, ['searches']);
  assert.equal(retry.data.searches.error, undefined);
  assert.equal(retry.data.searches.result, result);
});
