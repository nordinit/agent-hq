import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blankDashboard, dashboardBlocks, dashboardSection, formatDashboardValue, moveDashboardBlock, removeDashboardBlock, resizeDashboardColumns, setDashboardColumns } from './dashboardLayout.ts';
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
