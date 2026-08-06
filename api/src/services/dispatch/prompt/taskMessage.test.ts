import { buildTaskMessage } from './taskMessage';

describe('dispatch prompt task message builder', () => {
  it('formats job instructions and assigned task details', () => {
    expect(buildTaskMessage(
      { job_instructions: 'Do the backend work.', title: 'Backend Engineer' },
      {
        id: 814,
        title: 'Extract dispatcher builders',
        description: 'Move pure helpers into dispatch modules.',
        priority: 'medium',
        status: 'ready',
        sprint_name: 'Runtime and Large-File Refactor',
      },
    )).toBe([
      'Do the backend work.',
      '',
      '## Assigned Task',
      'Task #814: Extract dispatcher builders',
      'Priority: medium | Workflow: Runtime and Large-File Refactor',
      '',
      'Move pure helpers into dispatch modules.',
    ].join('\n'));
  });

  it('leads with the team context block when one is supplied', () => {
    // Identity before instructions before task: who the agent is frames how it reads both.
    const message = buildTaskMessage(
      { job_instructions: 'Do the backend work.', title: 'Backend Engineer' },
      {
        id: 814,
        title: 'Extract dispatcher builders',
        description: 'Move pure helpers into dispatch modules.',
        priority: 'medium',
        status: 'ready',
        sprint_name: 'Runtime Refactor',
      },
      '--- Team: Delivery Squad ---\nGoal: Ship it.\n--- End Team ---',
    );

    expect(message.startsWith('--- Team: Delivery Squad ---')).toBe(true);
    expect(message.indexOf('--- End Team ---')).toBeLessThan(message.indexOf('Do the backend work.'));
    expect(message.indexOf('Do the backend work.')).toBeLessThan(message.indexOf('## Assigned Task'));
  });

  it('is unchanged when there is no team context, or only blank text', () => {
    const job = { job_instructions: 'Do the backend work.', title: 'Backend Engineer' };
    const task = {
      id: 814,
      title: 'Extract dispatcher builders',
      description: 'Move pure helpers into dispatch modules.',
      priority: 'medium',
      status: 'ready',
      sprint_name: 'Runtime Refactor',
    };

    const baseline = buildTaskMessage(job, task);
    expect(buildTaskMessage(job, task, null)).toBe(baseline);
    expect(buildTaskMessage(job, task, '   ')).toBe(baseline);
  });
});
