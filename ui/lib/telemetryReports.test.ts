import assert from 'node:assert/strict';
import { test } from 'node:test';
import { savedTelemetryReportFilters, telemetryFamilyCoverageNotice, telemetryReportQuery } from './telemetryReports.ts';
import type { TelemetryReport } from './telemetryTypes.ts';

const report: TelemetryReport = { id: 'report', key: 'review', name: 'Review', latest_revision_id: 'report-v1', revision: 1, definition: { metrics: [{ metric_revision_id: 'metric-v1' }], scope: { project_id: 11, include_archived: false }, timezone: 'America/New_York', from: '2026-11-01T05:30:00.000Z', to: '2026-11-01T07:30:00.000Z', group_by: [{ field: 'project_id' }, { field: 'agent_id' }] } };
test('opening a report restores saved timezone, archive policy, pins, and exact ambiguous wall-time instant', () => {
  const filters = savedTelemetryReportFilters(report); const query = telemetryReportQuery(report);
  assert.equal(filters.timezone, 'America/New_York'); assert.equal(filters.scope.include_archived, false);
  assert.equal(filters.from, '2026-11-01T01:30'); assert.equal(filters.grouping, '__saved__');
  assert.equal(query.from, '2026-11-01T05:30:00.000Z'); assert.deepEqual(query.group_by, report.definition.group_by);
  assert.equal(query.report_revision_id, 'report-v1');
});
test('explicit report filter changes apply to its query and can replace saved grouping', () => {
  const query = telemetryReportQuery(report, { ...savedTelemetryReportFilters(report), scope: { project_id: 11, workflow_id: 111, include_archived: false }, from: '2026-11-02T09:00', to: '2026-11-03T09:00', grouping: '' });
  assert.equal(query.from, '2026-11-02T14:00:00.000Z'); assert.equal(query.scope?.workflow_id, 111); assert.deepEqual(query.group_by, []);
});
test('partial family binding coverage is visible even when other metric cards have results', () => {
  assert.match(telemetryFamilyCoverageNotice(3, 2)!, /3 tasks have no metric binding; 2 tasks have an explicit disable/);
  assert.equal(telemetryFamilyCoverageNotice(), null);
});
