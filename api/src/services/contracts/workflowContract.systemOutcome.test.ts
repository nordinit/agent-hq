import { resolveWorkflow } from './workflowContract';

it('never offers the built-in runtime_failed outcome to an agent, even where a transition routes it', async () => {
  const resolved = await resolveWorkflow({
    taskStatus: 'in_progress',
    taskType: null,
    workflowType: 'generic',
    resolvedWorkflow: {
      workflowId: 1,
      workflowType: 'generic',
      statuses: [],
      transitions: [
        { fromStatus: 'in_progress', outcome: 'completed', toStatus: 'done', taskType: null, priority: 0, isProtected: false },
        { fromStatus: 'in_progress', outcome: 'runtime_failed', toStatus: 'failed', taskType: null, priority: 0, isProtected: false },
      ],
    },
  });
  expect(resolved.validOutcomes).toContain('completed');
  expect(resolved.validOutcomes).not.toContain('runtime_failed');
});
