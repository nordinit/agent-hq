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
});
