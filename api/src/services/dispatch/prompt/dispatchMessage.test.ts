import { buildDispatchMessage } from '../../dispatcher';

/**
 * buildDispatchMessage is a pure function living in dispatcher.ts; it is tested here beside the
 * other prompt builders because ordering within the message is the contract that matters, and
 * team context added a new position to it.
 */
describe('dispatch message assembly', () => {
  it('places team context after the workflow goal and before project context', () => {
    // The goal says what the work is for, the team block says who is doing it, and both frame
    // everything that follows.
    const message = buildDispatchMessage({
      sprintGoal: 'Ship the billing migration.',
      teamContext: '--- Team: Delivery Squad ---\nGoal: Ship it.\n--- End Team ---',
      projectName: 'Platform',
      projectContext: 'Monorepo, PostgreSQL only.',
      jobInstructions: 'Review the diff.',
    });

    expect(message).toBe([
      '[Workflow Goal: Ship the billing migration.]',
      '',
      '--- Team: Delivery Squad ---',
      'Goal: Ship it.',
      '--- End Team ---',
      '',
      '--- Project Context: Platform ---',
      'Monorepo, PostgreSQL only.',
      '--- End Project Context ---',
      '',
      'Review the diff.',
    ].join('\n'));
  });

  it('omits the block entirely when no team applies', () => {
    const message = buildDispatchMessage({
      sprintGoal: 'Ship the billing migration.',
      teamContext: null,
      jobInstructions: 'Review the diff.',
    });

    expect(message).toBe([
      '[Workflow Goal: Ship the billing migration.]',
      '',
      'Review the diff.',
    ].join('\n'));
  });

  it('still renders team context when there is no workflow goal', () => {
    const message = buildDispatchMessage({
      teamContext: '--- Team: Delivery Squad ---\n--- End Team ---',
      jobInstructions: 'Review the diff.',
    });

    expect(message.startsWith('--- Team: Delivery Squad ---')).toBe(true);
  });
});
