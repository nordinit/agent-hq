import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SprintType } from './api/types.ts';
import { getRoutingWorkflowTypeOptions } from './routingWorkflowTypes.ts';

function sprintType(key: string, name: string): SprintType {
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
    sprintType('dev', 'Development'),
    sprintType('generic', 'Generic'),
    sprintType('ops', 'Operations'),
    sprintType('trading', 'Trading'),
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
    sprintType('dev', 'Development'),
    sprintType('ops', ''),
    sprintType('dev', 'Duplicate Development'),
    sprintType(' ', 'Blank'),
  ]);

  assert.deepEqual(options, [
    { key: 'dev', name: 'Development' },
    { key: 'ops', name: 'ops' },
  ]);
});
