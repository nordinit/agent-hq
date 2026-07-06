import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldClearInvalidTaskType, type TaskTypeOption } from './taskTypeSelection.ts';

const leadGenerationTaskTypes: TaskTypeOption[] = [
  { value: 'lead', label: 'Lead' },
  { value: 'research', label: 'Research' },
  { value: 'outreach', label: 'Outreach' },
];

test('keeps a task type that is valid for the selected workflow metadata', () => {
  assert.equal(shouldClearInvalidTaskType('research', leadGenerationTaskTypes, false), false);
});

test('clears a stale global task type when workflow metadata excludes it', () => {
  assert.equal(shouldClearInvalidTaskType('backend', leadGenerationTaskTypes, false), true);
});

test('waits for metadata before clearing the current task type', () => {
  assert.equal(shouldClearInvalidTaskType('backend', leadGenerationTaskTypes, true), false);
});

test('does not force a concrete task type when the task has none selected', () => {
  assert.equal(shouldClearInvalidTaskType(null, leadGenerationTaskTypes, false), false);
});
