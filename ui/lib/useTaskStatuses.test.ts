import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskStatusMeta } from './api.ts';
import { getTaskBoardColumns, getDefaultVisibleTaskColumns, normalizeTaskStatuses, unionBoardColumns } from './taskStatuses.ts';

const statuses: TaskStatusMeta[] = [
  {
    name: 'todo',
    label: 'To Do',
    color: 'slate',
    terminal: false,
    is_system: true,
    allowed_transitions: ['ready', 'cancelled'],
  },
  {
    name: 'ready',
    label: 'Ready',
    color: 'blue',
    terminal: false,
    is_system: true,
    allowed_transitions: ['in_progress'],
  },
  {
    name: 'in_progress',
    label: 'In Progress',
    color: 'yellow',
    terminal: false,
    is_system: true,
    allowed_transitions: ['review'],
  },
];

test('normalizeTaskStatuses uses API labels/colors without depending on allowed_transitions', () => {
  assert.deepEqual(
    normalizeTaskStatuses(statuses).map(status => ({ key: status.key, label: status.label, color: status.color })),
    [
      { key: 'todo', label: 'To Do', color: 'slate' },
      { key: 'ready', label: 'Ready', color: 'blue' },
      { key: 'in_progress', label: 'In Progress', color: 'yellow' },
    ],
  );
});

test('task board columns include every status regardless of allowed_transitions metadata', () => {
  assert.deepEqual(
    getTaskBoardColumns(statuses).map(column => column.key),
    ['todo', 'ready', 'in_progress'],
  );

  assert.deepEqual(getDefaultVisibleTaskColumns(statuses), ['todo', 'ready', 'in_progress']);
});

// ── Mobile column union ──────────────────────────────────────────────────────
//
// Regression cover for a mobile-only board bug: a project mixing workflow types showed only the
// first type's status columns on mobile, so a status defined by just one type (Agency's
// lead_generation `closed`) had no chip to tap and could not be selected at all.

test('unionBoardColumns spans every workflow type, first-seen order', () => {
  const dev = [{ key: 'todo' }, { key: 'in_progress' }, { key: 'done' }];
  const leadGen = [{ key: 'todo' }, { key: 'in_progress' }, { key: 'approved' }, { key: 'closed' }];

  assert.deepEqual(
    unionBoardColumns([dev, leadGen]).map(c => c.key),
    ['todo', 'in_progress', 'done', 'approved', 'closed'],
  );
});

test('unionBoardColumns keeps a status defined by only one workflow type', () => {
  const dev = [{ key: 'todo' }, { key: 'done' }];
  const leadGen = [{ key: 'closed' }];
  assert.ok(unionBoardColumns([dev, leadGen]).some(c => c.key === 'closed'));
  // Order of catalogues must not decide whether a status is reachable.
  assert.ok(unionBoardColumns([leadGen, dev]).some(c => c.key === 'closed'));
});

test('unionBoardColumns dedupes by key and preserves the first definition', () => {
  const a = [{ key: 'todo', label: 'To do' }];
  const b = [{ key: 'todo', label: 'Backlog' }, { key: 'closed', label: 'Closed' }];
  const union = unionBoardColumns([a, b]);
  assert.equal(union.length, 2);
  assert.equal(union[0].label, 'To do');
});

test('unionBoardColumns handles empty and absent catalogues', () => {
  assert.deepEqual(unionBoardColumns([]), []);
  assert.deepEqual(unionBoardColumns([[], []]), []);
  assert.deepEqual(unionBoardColumns([[], [{ key: 'closed' }]]).map(c => c.key), ['closed']);
});
