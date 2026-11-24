import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkflowType } from './api/types.ts';
import { getRoutingWorkflowScope, getRoutingWorkflowTypeOptions } from './routingWorkflowTypes.ts';

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

test('routing workflow options follow both project and workflow type', () => {
  const types = [workflowType('dev', 'Development'), workflowType('ops', 'Operations'), workflowType('generic', 'Generic')];
  const workflows = [
    { id: 1, project_id: 10, workflow_type: 'dev', name: 'Build' },
    { id: 2, project_id: 10, workflow_type: 'ops', name: 'Deploy' },
    { id: 3, project_id: 20, workflow_type: 'ops', name: 'Monitor' },
  ];

  const firstProject = getRoutingWorkflowScope(types, workflows, 10, 'dev');
  assert.deepEqual(firstProject.availableTypes.map(type => type.key), ['dev', 'ops']);
  assert.deepEqual(firstProject.workflows, [workflows[0]]);
  assert.deepEqual(getRoutingWorkflowScope(types, workflows, 10, 'ops').workflows, [workflows[1]]);
  assert.deepEqual(getRoutingWorkflowScope(types, workflows, 10, '').workflows, []);

  const secondProject = getRoutingWorkflowScope(types, workflows, 20, 'dev');
  assert.deepEqual(secondProject.availableTypes.map(type => type.key), ['ops']);
  assert.equal(secondProject.workflowType, 'ops');
  assert.deepEqual(secondProject.workflows, [workflows[2]]);

  assert.deepEqual(getRoutingWorkflowScope(types, workflows, 30, 'ops'), {
    availableTypes: [], workflowType: null, workflows: [],
  });
  const allProjects = getRoutingWorkflowScope(types, workflows, null, 'ops');
  assert.deepEqual(allProjects.availableTypes.map(type => type.key), ['dev', 'ops', 'generic']);
  assert.deepEqual(allProjects.workflows, []);
});
