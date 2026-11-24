import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blankDashboard, dashboardBlocks, dashboardSection, formatDashboardValue, resolveDashboardRange, taskListDetail, taskListRequest, moveDashboardBlock, removeDashboardBlock, resizeDashboardColumns, setDashboardColumns } from './dashboardLayout.ts';
import type { DashboardBlock } from './dashboardTypes.ts';

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

test('relative ranges resolve against the load time and task lists stay inside the page scope', () => {
  const now = Date.parse('2026-11-24T20:00:00.000Z');
  assert.deepEqual(resolveDashboardRange('48h', now), { from: '2026-11-22T20:00:00.000Z', to: '2026-11-24T20:00:00.000Z' });
  assert.equal(resolveDashboardRange('7d', now).from, '2026-11-17T20:00:00.000Z');
  const block = { id: 'b', type: 'task_list' as const, statuses: ['blocked'] };
  assert.deepEqual(taskListRequest(block, { project_id: 99, workflow_id: 114, task_type: 'proposal' }), { projectId: 99, workflowId: 114, statuses: ['blocked'], taskTypes: ['proposal'], limit: 10 });
  assert.deepEqual(taskListRequest({ ...block, workflow_id: 115, task_types: ['lead', 'proposal'], limit: 5 }, { project_id: 99 }), { projectId: 99, workflowId: 115, statuses: ['blocked'], taskTypes: ['lead', 'proposal'], limit: 5 });
});

test('task-list rows show the blocker or outcome by default, or the chosen outcome or field', () => {
  const task = { blocker_reason: '', latest_task_outcome: 'reject', custom_fields: { verdict_summary: 'Rejected: -2.28c/contract', score: 7, empty: '' } };
  assert.equal(taskListDetail(task), 'reject');
  assert.equal(taskListDetail({ ...task, blocker_reason: 'Waiting on NDA' }), 'Waiting on NDA');
  assert.equal(taskListDetail({ ...task, blocker_reason: 'Waiting on NDA' }, { kind: 'outcome' }), 'reject');
  assert.equal(taskListDetail(task, { kind: 'field', key: 'verdict_summary' }), 'Rejected: -2.28c/contract');
  assert.equal(taskListDetail(task, { kind: 'field', key: 'score' }), '7');
  assert.equal(taskListDetail(task, { kind: 'field', key: 'empty' }), null);
  assert.equal(taskListDetail({ ...task, custom_fields: null }, { kind: 'field', key: 'verdict_summary' }), null);
});
