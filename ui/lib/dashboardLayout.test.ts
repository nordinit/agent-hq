import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blankDashboard, dashboardBlocks, dashboardFromReport, dashboardSection, formatDashboardValue, moveDashboardBlock, removeDashboardBlock, resizeDashboardColumns, setDashboardColumns } from './dashboardLayout.ts';
import type { DashboardBlock } from './dashboardTypes.ts';
import type { TelemetryReport } from './telemetryTypes.ts';

test('presentation rounds exact decimals without float conversion, including carry, zero places and percentages', () => {
  assert.equal(formatDashboardValue({ decimal: '2.444444444444444444444444' }), '2.44');
  assert.equal(formatDashboardValue({ decimal: '9007199254740993.999' }), '9,007,199,254,740,994');
  assert.equal(formatDashboardValue({ decimal: '0.24444444444444444444' }, 'percent', 1), '24.4%');
  assert.equal(formatDashboardValue({ decimal: '9.99' }, undefined, 0), '10');
  assert.equal(formatDashboardValue({ decimal: '-0.00001' }), '0');
  assert.equal(formatDashboardValue(null), '—');
});
test('moving into empty columns, reordering and resizing preserve blocks and the 12-column budget', () => {
  const page = blankDashboard().definition;
  const blocks: DashboardBlock[] = ['a', 'b', 'c'].map(id => ({ id, type: 'note', text: id }));
  page.sections = [dashboardSection('Main', blocks, 1), dashboardSection('Empty', [], 2)];
  const target = page.sections[1].columns[1].id;
  const moved = moveDashboardBlock(page, 'a', target);
  assert.deepEqual(moved.sections[1].columns[1].blocks.map(block => block.id), ['a']);
  assert.equal(page.sections[0].columns[0].blocks.length, 3);
  const reordered = moveDashboardBlock(moved, 'c', moved.sections[0].columns[0].id, 'b');
  assert.deepEqual(reordered.sections[0].columns[0].blocks.map(block => block.id), ['c', 'b']);
  const resized = resizeDashboardColumns(reordered, page.sections[1].id, 0, 100);
  assert.deepEqual(resized.sections[1].columns.map(column => column.width), [11, 1]);
  const changed = setDashboardColumns(resized, page.sections[0].id, 4);
  assert.equal(changed.sections[0].columns.length, 4);
  assert.deepEqual(dashboardBlocks(changed).map(block => block.id).sort(), ['a', 'b', 'c']);
});
test('removing a duplicate retains its shared query until the final reference is removed', () => {
  const page = blankDashboard().definition;
  page.metrics = [{ id: 'source', metric_revision_id: 'pinned' }];
  page.sections = [dashboardSection('', [{ id: 'a', type: 'metric', binding_id: 'source' }, { id: 'b', type: 'comparison', binding_ids: ['source'] }])];
  const first = removeDashboardBlock(page, 'a'); assert.equal(first.metrics.length, 1);
  const second = removeDashboardBlock(first, 'b'); assert.equal(second.metrics.length, 0);
});
test('Agency conversion keeps every metric pin, exact historical boundary and local override without mutating the original', () => {
  const ids = ['searches', 'raw_hits', 'reviewed', 'qualification_rate', 'qualified_per_search', 'drafts_per_search', 'rejection_rate', 'average_score', 'commercial_refusal'];
  const report: TelemetryReport = { id: 'agency', name: 'Agency', key: 'agency', latest_revision_id: 'r1', revision: 1, scope: { project_id: 99 }, definition: { presentation: 'dashboard', metrics: ids.map(id => ({ id, metric_revision_id: `${id}-v1`, view: { group_by: [{ field: 'title' }], filter: { field: 'id', op: 'ne', value: 12 } } })), from: '2026-11-01T01:30:00-04:00', timezone: 'America/New_York' } };
  const before = JSON.stringify(report), converted = dashboardFromReport(report);
  assert.equal(converted.definition.template, 'agency'); assert.equal(converted.definition.metrics.length, 9);
  assert.deepEqual(converted.definition.metrics, report.definition.metrics);
  assert.equal(converted.definition.scope?.project_id, 99); assert.equal(converted.definition.from, report.definition.from);
  assert.equal(dashboardBlocks(converted.definition).filter(block => block.type === 'metric').length, 9);
  assert.equal(JSON.stringify(report), before);
});
