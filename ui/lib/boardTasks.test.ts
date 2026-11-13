import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  boardBucketKey,
  boardColumnTotal,
  boardWorkflowTotal,
  expandBoardColumn,
  reuseUnchangedTasks,
} from './boardTasks.ts';

const buckets = [
  { workflow_id: 114, status: 'closed', total: 2771, loaded: 30 },
  { workflow_id: 115, status: 'closed', total: 12, loaded: 12 },
  { workflow_id: 114, status: 'ready', total: 3, loaded: 3 },
  { workflow_id: null, status: 'ready', total: 4, loaded: 4 },
];

test('column keys match the board API expand syntax, with "none" for no workflow', () => {
  assert.equal(boardBucketKey(114, 'closed'), '114:closed');
  assert.equal(boardBucketKey(null, 'ready'), 'none:ready');
});

test('column totals count every task in the column, not only the loaded ones', () => {
  assert.equal(boardColumnTotal(buckets, 'closed'), 2783);
  assert.equal(boardColumnTotal(buckets, 'closed', [115]), 12);
  assert.equal(boardColumnTotal(buckets, 'ready'), 7);
  assert.equal(boardColumnTotal(buckets, 'ready', [114]), 3);
  assert.equal(boardColumnTotal(buckets, 'review'), 0);
  assert.equal(boardWorkflowTotal(buckets, 114), 2774);
  assert.equal(boardWorkflowTotal(buckets, null), 4);
});

test('show more grows only the workflow columns that still have unloaded tasks', () => {
  assert.deepEqual(expandBoardColumn({}, buckets, 'closed', null, 30, 30), { '114:closed': 60 });
  assert.deepEqual(expandBoardColumn({ '114:closed': 60 }, buckets, 'closed', null, 30, 30), { '114:closed': 90 });
  assert.deepEqual(expandBoardColumn({}, buckets, 'closed', [115], 30, 30), {});
});

test('a refresh keeps the same object for unchanged tasks so memoized cards skip rendering', () => {
  const a = { id: 1, title: 'A', status: 'ready' };
  const b = { id: 2, title: 'B', status: 'ready' };
  const next = reuseUnchangedTasks([a, b], [{ id: 2, title: 'B', status: 'done' }, { id: 1, title: 'A', status: 'ready' }, { id: 3, title: 'C', status: 'ready' }]);
  assert.equal(next[1], a);
  assert.notEqual(next[0], b);
  assert.deepEqual(next.map(task => task.id), [2, 1, 3]);
  assert.deepEqual(reuseUnchangedTasks([], [a]), [a]);
});
