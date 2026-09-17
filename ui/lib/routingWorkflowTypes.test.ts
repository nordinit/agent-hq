import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkflowType } from './api/types.ts';
import { getRoutingWorkflowTypeOptions } from './routingWorkflowTypes.ts';

function workflowType(key: string, name: string): WorkflowType {
  return {
    key,
    name,
    description: '',
    is_system: 0,
    created_at: '',
    updated_at: '',
  };
}

test('routing workflow type options come from workflow definitions without requiring workflow instances', () => {
  const options = getRoutingWorkflowTypeOptions([
    workflowType('dev', 'Development'),
    workflowType('generic', 'Generic'),
    workflowType('ops', 'Operations'),
    workflowType('trading', 'Trading'),
  ]);

  assert.deepEqual(options, [
    { key: 'dev', name: 'Development' },
    { key: 'generic', name: 'Generic' },
    { key: 'ops', name: 'Operations' },
    { key: 'trading', name: 'Trading' },
  ]);
});

test('routing workflow type options ignore blank and duplicate definitions', () => {
  const options = getRoutingWorkflowTypeOptions([
    workflowType('dev', 'Development'),
    workflowType('ops', ''),
    workflowType('dev', 'Duplicate Development'),
    workflowType(' ', 'Blank'),
  ]);

  assert.deepEqual(options, [
    { key: 'dev', name: 'Development' },
    { key: 'ops', name: 'ops' },
  ]);
});
