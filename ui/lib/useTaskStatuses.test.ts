import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskStatusMeta } from './api.ts';
import { getTaskBoardColumns, getDefaultVisibleTaskColumns, normalizeTaskStatuses } from './taskStatuses.ts';

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
