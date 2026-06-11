import { strict as assert } from 'assert';

describe('task board status transition semantics', () => {
  function buildAllowedTransitionsMap(statuses: Array<{ name: string; allowed_transitions?: string[] }>) {
    return Object.fromEntries(
      statuses.map((status) => [status.name, Array.isArray(status.allowed_transitions) ? status.allowed_transitions : []])
    );
  }

  it('uses status allowed_transitions rather than workflow routing rules as board move gates', () => {
    const statuses = [
      { name: 'todo', allowed_transitions: ['ready', 'cancelled'] },
      { name: 'ready', allowed_transitions: ['in_progress'] },
      { name: 'in_progress', allowed_transitions: ['review'] },
    ];

    const workflowTransitions = [
      { from_status: 'todo', outcome: 'completed_for_review', to_status: 'done', enabled: 1 },
      { from_status: 'ready', outcome: 'start_work', to_status: 'in_progress', enabled: 1 },
    ];

    const allowedTransitionsMap = buildAllowedTransitionsMap(statuses);

    assert.deepEqual(allowedTransitionsMap, {
      todo: ['ready', 'cancelled'],
      ready: ['in_progress'],
      in_progress: ['review'],
    });
    assert.equal(allowedTransitionsMap.todo.includes('ready'), true);
    assert.equal(allowedTransitionsMap.todo.includes('done'), false);
    assert.equal(workflowTransitions.some((transition) => transition.from_status === 'todo' && transition.to_status === 'done'), true);
  });

  it('treats missing allowed_transitions as no legal board moves', () => {
    const allowedTransitionsMap = buildAllowedTransitionsMap([
      { name: 'review' },
    ]);

    assert.deepEqual(allowedTransitionsMap, {
      review: [],
    });
  });
});
