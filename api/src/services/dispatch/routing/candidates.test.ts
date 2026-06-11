import { sortCandidates } from './candidates';
import type { CandidateTask } from '../types';

function candidate(overrides: Partial<CandidateTask>): CandidateTask {
  return {
    id: 1,
    title: 'Task',
    description: 'Task',
    status: 'ready',
    priority: 'medium',
    agent_id: null,
    tenant_id: null,
    project_id: 1,
    task_type: 'backend',
    sprint_id: 1,
    sprint_name: 'Dev',
    sprint_type: 'dev',
    created_at: '2026-06-01T00:00:00.000Z',
    blocking_count: 0,
    story_points: null,
    active_instance_id: null,
    ...overrides,
  };
}

describe('dispatch routing candidate sorting', () => {
  it('uses default priority, blocking count, then oldest order', () => {
    const sorted = sortCandidates([
      candidate({ id: 1, priority: 'medium', blocking_count: 0, created_at: '2026-06-03T00:00:00.000Z' }),
      candidate({ id: 2, priority: 'high', blocking_count: 0, created_at: '2026-06-03T00:00:00.000Z' }),
      candidate({ id: 3, priority: 'high', blocking_count: 2, created_at: '2026-06-04T00:00:00.000Z' }),
      candidate({ id: 4, priority: 'high', blocking_count: 2, created_at: '2026-06-02T00:00:00.000Z' }),
    ]);

    expect(sorted.map(task => task.id)).toEqual([4, 3, 2, 1]);
  });

  it('honors configured sort rules and ignores unknown rules', () => {
    const sorted = sortCandidates([
      candidate({ id: 1, created_at: '2026-06-01T00:00:00.000Z', blocking_count: 10 }),
      candidate({ id: 2, created_at: '2026-06-03T00:00:00.000Z', blocking_count: 0 }),
      candidate({ id: 3, created_at: '2026-06-02T00:00:00.000Z', blocking_count: 3 }),
    ], ['unknown', 'newest_first', 'blocking_first']);

    expect(sorted.map(task => task.id)).toEqual([2, 3, 1]);
  });
});
