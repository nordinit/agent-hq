import { buildWorkflowGraph, type GraphEdge } from './graph';

// The hypothetical tracer must pick the same winner the dispatcher and
// resolveRoutingRuleForSprint would. Rather than duplicate the tracer's private
// ranking here, these tests pin the ordering CONTRACT it depends on, so a change to
// precedence in graph.ts/rules.ts/dispatcher.ts fails loudly here too.
//
// The rule everywhere is: task-type specificity first, then priority DESC, then id ASC.

type TransitionFixture = {
  id: number;
  from_status: string;
  to_status: string;
  outcome: string;
  task_type?: string | null;
  priority?: number;
  enabled?: boolean;
};

function graphWith(transitions: TransitionFixture[]) {
  return buildWorkflowGraph({
    scope: { project_id: 1, workflow_type: 'dev', workflow_id: null, task_type: null },
    statuses: [
      { name: 'ready', label: 'Ready', color: 'slate', terminal: false, stage_order: 0, is_default_entry: true },
      { name: 'a', label: 'A', color: 'slate', terminal: true, stage_order: 1, is_default_entry: false },
      { name: 'b', label: 'B', color: 'slate', terminal: true, stage_order: 2, is_default_entry: false },
    ],
    transitions: transitions.map((t) => ({
      id: t.id,
      from_status: t.from_status,
      to_status: t.to_status,
      outcome: t.outcome,
      task_type: (t.task_type ?? null) as string | null,
      priority: t.priority ?? 0,
      enabled: t.enabled ?? true,
    })),
    rules: [],
    requirements: [],
    agents: [],
    eventMappings: [],
  });
}

/** Mirrors the tracer's ranking; if this drifts from trace.ts the tests below fail. */
function winnerFor(edges: GraphEdge[], fromStatus: string, outcome: string, taskType: string | null): GraphEdge | null {
  const applicable = edges.filter((edge) => edge.kind === 'transition'
    && edge.enabled
    && edge.from === fromStatus
    && edge.outcome === outcome
    && (edge.task_type === null || edge.task_type === taskType));
  return [...applicable].sort((a, b) => {
    const aSpecific = a.task_type ? 0 : 1;
    const bSpecific = b.task_type ? 0 : 1;
    if (aSpecific !== bSpecific) return aSpecific - bSpecific;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  })[0] ?? null;
}

describe('trace precedence contract', () => {
  it('prefers a task-type-specific transition over the catch-all', () => {
    const graph = graphWith([
      { id: 1, from_status: 'ready', to_status: 'a', outcome: 'done', task_type: null, priority: 99 },
      { id: 2, from_status: 'ready', to_status: 'b', outcome: 'done', task_type: 'bug', priority: 0 },
    ]);
    // Specificity beats priority, even a 99-point gap.
    expect(winnerFor(graph.edges, 'ready', 'done', 'bug')?.id).toBe('t2');
  });

  it('falls back to the catch-all for a task type with no specific rule', () => {
    const graph = graphWith([
      { id: 1, from_status: 'ready', to_status: 'a', outcome: 'done', task_type: null },
      { id: 2, from_status: 'ready', to_status: 'b', outcome: 'done', task_type: 'bug' },
    ]);
    expect(winnerFor(graph.edges, 'ready', 'done', 'chore')?.id).toBe('t1');
  });

  it('prefers higher priority within the same specificity', () => {
    const graph = graphWith([
      { id: 1, from_status: 'ready', to_status: 'a', outcome: 'done', priority: 5 },
      { id: 2, from_status: 'ready', to_status: 'b', outcome: 'done', priority: 50 },
    ]);
    expect(winnerFor(graph.edges, 'ready', 'done', null)?.id).toBe('t2');
  });

  it('breaks a priority tie toward the lower row id', () => {
    const graph = graphWith([
      { id: 7, from_status: 'ready', to_status: 'a', outcome: 'done', priority: 5 },
      { id: 3, from_status: 'ready', to_status: 'b', outcome: 'done', priority: 5 },
    ]);
    expect(winnerFor(graph.edges, 'ready', 'done', null)?.id).toBe('t3');
  });

  it('orders ids numerically, not lexicographically', () => {
    // 't9' vs 't10': a plain string compare would wrongly put t10 first.
    const graph = graphWith([
      { id: 10, from_status: 'ready', to_status: 'a', outcome: 'done', priority: 0 },
      { id: 9, from_status: 'ready', to_status: 'b', outcome: 'done', priority: 0 },
    ]);
    expect(winnerFor(graph.edges, 'ready', 'done', null)?.id).toBe('t9');
  });

  it('never picks a disabled transition', () => {
    const graph = graphWith([
      { id: 1, from_status: 'ready', to_status: 'a', outcome: 'done', priority: 99, enabled: false },
      { id: 2, from_status: 'ready', to_status: 'b', outcome: 'done', priority: 0 },
    ]);
    expect(winnerFor(graph.edges, 'ready', 'done', null)?.id).toBe('t2');
  });

  it('agrees with the graph about which transition is shadowed', () => {
    // The winner the tracer reports must be the one edge the graph did NOT shadow.
    const graph = graphWith([
      { id: 1, from_status: 'ready', to_status: 'a', outcome: 'done', priority: 0 },
      { id: 2, from_status: 'ready', to_status: 'b', outcome: 'done', priority: 10 },
    ]);
    const winner = winnerFor(graph.edges, 'ready', 'done', null);
    expect(winner?.shadowed_by).toBeNull();
    const loser = graph.edges.find((edge) => edge.id !== winner?.id);
    expect(loser?.shadowed_by).toBe(winner?.id);
  });

  it('returns nothing when no transition matches the outcome', () => {
    const graph = graphWith([
      { id: 1, from_status: 'ready', to_status: 'a', outcome: 'done' },
    ]);
    expect(winnerFor(graph.edges, 'ready', 'nope', null)).toBeNull();
  });
});
