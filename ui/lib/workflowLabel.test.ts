import assert from 'node:assert/strict';
import test from 'node:test';
import { formatWorkflowLabel } from './workflowLabel.ts';
test('formats a workflow number and optional name', () => {
  assert.equal(formatWorkflowLabel({id: 42, name: ' Sales '}), '#42 · Sales');
  assert.equal(formatWorkflowLabel({id: 42}), '#42');
});
