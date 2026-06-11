import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatWorkflowTerminology } from './sprintLabel.ts';

test('formatWorkflowTerminology rewrites user-facing sprint terminology', () => {
  assert.equal(
    formatWorkflowTerminology('Catch-all sprint profile for mixed delivery work and backlog management.'),
    'Catch-all workflow profile for mixed delivery work and backlog management.',
  );
  assert.equal(
    formatWorkflowTerminology('Sprint and Sprints stay compatible internally.'),
    'Workflow and Workflows stay compatible internally.',
  );
});

test('formatWorkflowTerminology handles empty metadata copy', () => {
  assert.equal(formatWorkflowTerminology(null), '');
  assert.equal(formatWorkflowTerminology(undefined), '');
  assert.equal(formatWorkflowTerminology(''), '');
});
