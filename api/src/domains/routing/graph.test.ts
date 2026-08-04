import {
  buildWorkflowGraph,
  effectiveEventSources,
  type GraphEventMappingInput,
  type GraphGlobalRequirementInput,
  type GraphRequirementInput,
  type GraphRuleInput,
  type GraphStatusInput,
  type GraphTransitionInput,
} from './graph';

// buildWorkflowGraph is pure, so every lint rule is testable without a database.
// These tests are the contract that the canvas and Atlas both depend on.

const SCOPE = { project_id: 1, workflow_type: 'dev', workflow_id: null, task_type: null };

function status(name: string, over: Partial<GraphStatusInput> = {}): GraphStatusInput {
  return {
    name,
    label: name,
    color: 'slate',
    terminal: false,
    stage_order: 0,
    is_default_entry: false,
    ...over,
  };
}

function transition(id: number, from: string, to: string, outcome: string, over: Partial<GraphTransitionInput> = {}): GraphTransitionInput {
  return { id, from_status: from, to_status: to, outcome, task_type: null, priority: 0, enabled: true, ...over };
}

function rule(id: number, statusKey: string, agentId: number | null, over: Partial<GraphRuleInput> = {}): GraphRuleInput {
  return { id, status: statusKey, task_type: null, agent_id: agentId, priority: 0, enabled: true, ...over };
}

function requirement(id: number, outcome: string, over: Partial<GraphRequirementInput> = {}): GraphRequirementInput {
  return {
    id,
    outcome,
    task_type: null,
    field_name: 'pr_url',
    requirement_type: 'required',
    severity: 'block',
    message: '',
    enabled: true,
    ...over,
  };
}

function globalRequirement(id: number, outcome: string, over: Partial<GraphGlobalRequirementInput> = {}): GraphGlobalRequirementInput {
  return {
    id,
    outcome,
    task_type: null,
    field_name: 'review_commit',
    requirement_type: 'required',
    severity: 'block',
    message: '',
    ...over,
  };
}

function eventMapping(id: number, over: Partial<GraphEventMappingInput> = {}): GraphEventMappingInput {
  return {
    id,
    event_name: 'agent_started',
    source: 'agent_hq_runtime',
    task_type: null,
    status_includes: [],
    status_excludes: [],
    action_kind: 'status',
    action_target: 'in_progress',
    enabled: true,
    priority: 100,
    ...over,
  };
}

function build(over: {
  statuses?: GraphStatusInput[];
  transitions?: GraphTransitionInput[];
  rules?: GraphRuleInput[];
  requirements?: GraphRequirementInput[];
  globalRequirements?: GraphGlobalRequirementInput[];
  agents?: Array<{ id: number; name: string; enabled: boolean }>;
  eventMappings?: GraphEventMappingInput[];
} = {}) {
  return buildWorkflowGraph({
    scope: SCOPE,
    statuses: over.statuses ?? [],
    transitions: over.transitions ?? [],
    rules: over.rules ?? [],
    requirements: over.requirements ?? [],
    globalRequirements: over.globalRequirements ?? [],
    agents: over.agents ?? [{ id: 1, name: 'Piper', enabled: true }],
    eventMappings: over.eventMappings ?? [],
  });
}

const codes = (graph: ReturnType<typeof build>): string[] => graph.lint.map((finding) => finding.code);

/** A minimal healthy two-status workflow: todo -> done, with an owner on todo. */
function healthy() {
  return build({
    statuses: [
      status('todo', { is_default_entry: true, stage_order: 0 }),
      status('done', { terminal: true, stage_order: 1 }),
    ],
    transitions: [transition(1, 'todo', 'done', 'completed')],
    rules: [rule(1, 'todo', 1)],
  });
}

describe('buildWorkflowGraph', () => {
  it('produces no findings for a well-formed workflow', () => {
    const graph = healthy();
    expect(graph.lint).toEqual([]);
    expect(graph.stats).toEqual({ node_count: 2, edge_count: 1, error_count: 0, warn_count: 0 });
  });

  it('orders nodes by stage_order and exposes it as the layout layer', () => {
    const graph = build({
      statuses: [
        status('done', { terminal: true, stage_order: 5 }),
        status('todo', { is_default_entry: true, stage_order: 0 }),
      ],
      transitions: [transition(1, 'todo', 'done', 'completed')],
      rules: [rule(1, 'todo', 1)],
    });
    expect(graph.nodes.map((node) => node.id)).toEqual(['todo', 'done']);
    expect(graph.nodes.map((node) => node.layer)).toEqual([0, 5]);
  });

  describe('shadowed_transition', () => {
    it('flags the loser when two transitions share from + outcome + task_type', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('done', { terminal: true, stage_order: 1 }),
          status('review', { stage_order: 2 }),
        ],
        transitions: [
          transition(1, 'todo', 'done', 'completed', { priority: 0 }),
          transition(2, 'todo', 'review', 'completed', { priority: 10 }),
        ],
        rules: [rule(1, 'todo', 1), rule(2, 'review', 1)],
      });
      // Higher priority wins, so #1 can never fire.
      const shadowed = graph.edges.find((edge) => edge.transition_id === 1);
      expect(shadowed?.shadowed_by).toBe('t2');
      expect(graph.edges.find((edge) => edge.transition_id === 2)?.shadowed_by).toBeNull();
      expect(codes(graph)).toContain('shadowed_transition');
    });

    it('breaks priority ties toward the lower id, matching the resolver', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('a', { terminal: true, stage_order: 1 }),
          status('b', { terminal: true, stage_order: 1 }),
        ],
        transitions: [
          transition(7, 'todo', 'a', 'completed', { priority: 5 }),
          transition(3, 'todo', 'b', 'completed', { priority: 5 }),
        ],
        rules: [rule(1, 'todo', 1)],
      });
      // ORDER BY priority DESC, id ASC -> #3 wins, #7 is shadowed.
      expect(graph.edges.find((edge) => edge.transition_id === 7)?.shadowed_by).toBe('t3');
      expect(graph.edges.find((edge) => edge.transition_id === 3)?.shadowed_by).toBeNull();
    });

    it('does not treat a task-type-scoped row as shadowing the catch-all row', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('done', { terminal: true, stage_order: 1 }),
        ],
        transitions: [
          transition(1, 'todo', 'done', 'completed', { task_type: null }),
          transition(2, 'todo', 'done', 'completed', { task_type: 'bug', priority: 10 }),
        ],
        rules: [rule(1, 'todo', 1)],
      });
      // The null row still serves every task type that is not 'bug'.
      expect(graph.edges.every((edge) => edge.shadowed_by === null)).toBe(true);
      expect(codes(graph)).not.toContain('shadowed_transition');
    });

    it('ignores disabled transitions when deciding the winner', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('done', { terminal: true, stage_order: 1 }),
          status('review', { stage_order: 2 }),
        ],
        transitions: [
          transition(1, 'todo', 'done', 'completed', { priority: 0 }),
          transition(2, 'todo', 'review', 'completed', { priority: 10, enabled: false }),
        ],
        rules: [rule(1, 'todo', 1), rule(2, 'review', 1)],
      });
      expect(graph.edges.find((edge) => edge.transition_id === 1)?.shadowed_by).toBeNull();
    });
  });

  describe('reachability', () => {
    it('flags a status nothing transitions into', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('done', { terminal: true, stage_order: 1 }),
          status('orphan', { terminal: true, stage_order: 2 }),
        ],
        transitions: [transition(1, 'todo', 'done', 'completed')],
        rules: [rule(1, 'todo', 1)],
      });
      expect(codes(graph)).toContain('unreachable_status');
      expect(graph.nodes.find((node) => node.id === 'orphan')?.lint).toContain('unreachable_status');
      // The entry status is exempt.
      expect(graph.nodes.find((node) => node.id === 'todo')?.lint).not.toContain('unreachable_status');
    });

    it('does not count a self-loop as a way to reach a status', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('stuck', { stage_order: 1 }),
        ],
        transitions: [transition(1, 'stuck', 'stuck', 'retry')],
        rules: [rule(1, 'todo', 1), rule(2, 'stuck', 1)],
      });
      expect(graph.nodes.find((node) => node.id === 'stuck')?.lint).toContain('unreachable_status');
    });

    it('flags a non-terminal status with no way out', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('limbo', { stage_order: 1 }),
        ],
        transitions: [transition(1, 'todo', 'limbo', 'completed')],
        rules: [rule(1, 'todo', 1), rule(2, 'limbo', 1)],
      });
      expect(graph.nodes.find((node) => node.id === 'limbo')?.lint).toContain('dead_end_status');
      // Terminal statuses are expected to have no way out.
      expect(codes(healthy())).not.toContain('dead_end_status');
    });

    it('treats a shadowed transition as not providing reachability', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('a', { terminal: true, stage_order: 1 }),
          status('b', { terminal: true, stage_order: 1 }),
        ],
        transitions: [
          transition(1, 'todo', 'a', 'completed', { priority: 0 }),
          transition(2, 'todo', 'b', 'completed', { priority: 10 }),
        ],
        rules: [rule(1, 'todo', 1)],
      });
      // #1 never fires, so 'a' is not actually reachable.
      expect(graph.nodes.find((node) => node.id === 'a')?.lint).toContain('unreachable_status');
      expect(graph.nodes.find((node) => node.id === 'b')?.lint).not.toContain('unreachable_status');
    });
  });

  describe('assignment', () => {
    it('flags a non-terminal status with no agent assigned', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('done', { terminal: true, stage_order: 1 }),
        ],
        transitions: [transition(1, 'todo', 'done', 'completed')],
        rules: [],
      });
      expect(graph.nodes.find((node) => node.id === 'todo')?.lint).toContain('unassigned_status');
      // Terminal statuses are exempt: nobody is meant to pick work up from them.
      expect(graph.nodes.find((node) => node.id === 'done')?.lint).not.toContain('unassigned_status');
    });

    it('flags a rule pointing at a disabled agent', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('done', { terminal: true, stage_order: 1 }),
        ],
        transitions: [transition(1, 'todo', 'done', 'completed')],
        rules: [rule(1, 'todo', 9)],
        agents: [{ id: 9, name: 'Casper', enabled: false }],
      });
      expect(codes(graph)).toContain('rule_targets_disabled_agent');
      expect(graph.stats.error_count).toBeGreaterThan(0);
    });

    it('flags a rule pointing at an agent that no longer exists', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('done', { terminal: true, stage_order: 1 }),
        ],
        transitions: [transition(1, 'todo', 'done', 'completed')],
        rules: [rule(1, 'todo', 404)],
        agents: [],
      });
      expect(codes(graph)).toContain('rule_targets_disabled_agent');
    });

    it('attaches assignments to their node', () => {
      const graph = healthy();
      const todo = graph.nodes.find((node) => node.id === 'todo');
      expect(todo?.assignments).toHaveLength(1);
      expect(todo?.assignments[0]).toMatchObject({ agent_id: 1, agent_name: 'Piper', agent_enabled: true });
    });
  });

  describe('gates', () => {
    it('decorates the edge whose outcome the requirement gates', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('done', { terminal: true, stage_order: 1 }),
        ],
        transitions: [transition(1, 'todo', 'done', 'completed')],
        rules: [rule(1, 'todo', 1)],
        requirements: [requirement(1, 'completed')],
      });
      expect(graph.edges[0].gates).toHaveLength(1);
      expect(graph.edges[0].gates[0]).toMatchObject({ requirement_id: 1, field_name: 'pr_url' });
    });

    it('flags a requirement whose outcome no active transition uses', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('done', { terminal: true, stage_order: 1 }),
        ],
        transitions: [transition(1, 'todo', 'done', 'completed')],
        rules: [rule(1, 'todo', 1)],
        requirements: [requirement(1, 'never_used')],
      });
      expect(codes(graph)).toContain('gate_without_transition');
    });

    it('reports an unused outcome once, not once per requirement', () => {
      const graph = build({
        statuses: [status('todo', { is_default_entry: true, terminal: true })],
        rules: [rule(1, 'todo', 1)],
        requirements: [requirement(1, 'ghost'), requirement(2, 'ghost'), requirement(3, 'ghost')],
      });
      expect(codes(graph).filter((code) => code === 'gate_without_transition')).toHaveLength(1);
    });

    it('does not attach a task-type-scoped gate to a different task type', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('done', { terminal: true, stage_order: 1 }),
        ],
        transitions: [transition(1, 'todo', 'done', 'completed', { task_type: 'chore' })],
        rules: [rule(1, 'todo', 1)],
        requirements: [requirement(1, 'completed', { task_type: 'bug' })],
      });
      expect(graph.edges[0].gates).toHaveLength(0);
    });
  });

  describe('structural errors', () => {
    it('flags a transition referencing a status outside the catalog', () => {
      const graph = build({
        statuses: [status('todo', { is_default_entry: true, terminal: true })],
        transitions: [transition(1, 'todo', 'ghost', 'completed')],
        rules: [rule(1, 'todo', 1)],
      });
      expect(codes(graph)).toContain('transition_to_unknown_status');
      expect(graph.edges[0].lint).toContain('transition_to_unknown_status');
    });

    it('flags a workflow with no entry status', () => {
      const graph = build({
        statuses: [
          status('todo', { stage_order: 0 }),
          status('done', { terminal: true, stage_order: 1 }),
        ],
        transitions: [transition(1, 'todo', 'done', 'completed')],
        rules: [rule(1, 'todo', 1)],
      });
      expect(codes(graph)).toContain('no_entry_point');
    });

    it('stays quiet on an empty status catalog rather than inventing findings', () => {
      expect(build().lint).toEqual([]);
    });
  });

  describe('unconfigured scope', () => {
    // Many projects define zero workflow-type defaults and configure everything per
    // workflow, so this scope is common. It must not read as "your workflow is broken".
    const unconfigured = () => build({
      statuses: [
        status('todo', { is_default_entry: true, stage_order: 0 }),
        status('review', { stage_order: 1 }),
        status('done', { terminal: true, stage_order: 2 }),
      ],
      transitions: [],
      rules: [],
    });

    it('reports the scope as unconfigured instead of one warning per status', () => {
      expect(codes(unconfigured())).toEqual(['scope_not_configured']);
    });

    it('raises no warnings or errors for an unconfigured scope', () => {
      const graph = unconfigured();
      expect(graph.stats.warn_count).toBe(0);
      expect(graph.stats.error_count).toBe(0);
    });

    it('does not suppress structural findings once the scope has any edge', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('review', { stage_order: 1 }),
          status('done', { terminal: true, stage_order: 2 }),
        ],
        transitions: [transition(1, 'todo', 'done', 'completed')],
        rules: [rule(1, 'todo', 1)],
      });
      expect(codes(graph)).toContain('unreachable_status');
      expect(codes(graph)).not.toContain('scope_not_configured');
    });
  });

  describe('scope layering', () => {
    it('ignores an inherited row that a workflow-scoped override supersedes', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('done', { terminal: true, stage_order: 1 }),
          status('review', { stage_order: 2 }),
        ],
        transitions: [
          // The inherited default is superseded, so it must not shadow the override
          // and must not make 'review' look reachable.
          transition(1, 'todo', 'review', 'completed', { priority: 99, effective_for_sprint: false, is_inherited: true }),
          transition(2, 'todo', 'done', 'completed', { priority: 0, effective_for_sprint: true, is_override: true }),
        ],
        rules: [rule(1, 'todo', 1), rule(2, 'review', 1)],
      });
      expect(graph.edges.find((edge) => edge.transition_id === 2)?.shadowed_by).toBeNull();
      expect(graph.nodes.find((node) => node.id === 'review')?.lint).toContain('unreachable_status');
    });

    // Without these the canvas cannot tell a live inherited row from one a workflow
    // override supersedes: both look identical once is_inherited is all it gets.
    it('carries the full scope annotation onto edges', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('done', { terminal: true, stage_order: 1 }),
          status('review', { stage_order: 2 }),
        ],
        transitions: [
          transition(1, 'todo', 'review', 'completed', {
            scope_kind: 'sprint_type_default', is_inherited: true, is_override: false, effective_for_sprint: false,
          }),
          transition(2, 'todo', 'done', 'completed', {
            scope_kind: 'sprint_override', is_inherited: false, is_override: true, effective_for_sprint: true,
          }),
        ],
        rules: [rule(1, 'todo', 1), rule(2, 'review', 1)],
      });
      expect(graph.edges.find((edge) => edge.transition_id === 1)).toMatchObject({
        scope_kind: 'sprint_type_default', is_inherited: true, is_override: false, effective_for_sprint: false,
      });
      expect(graph.edges.find((edge) => edge.transition_id === 2)).toMatchObject({
        scope_kind: 'sprint_override', is_inherited: false, is_override: true, effective_for_sprint: true,
      });
    });

    it('defaults an unannotated edge to a live workflow-type default', () => {
      // No workflow is selected, so nothing is superseded and every row participates.
      expect(healthy().edges[0]).toMatchObject({
        scope_kind: 'sprint_type_default', is_inherited: false, is_override: false, effective_for_sprint: true,
      });
    });

    it('carries the full scope annotation onto assignments', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('done', { terminal: true, stage_order: 1 }),
        ],
        transitions: [transition(1, 'todo', 'done', 'completed')],
        rules: [
          rule(1, 'todo', 1, {
            scope_kind: 'sprint_type_default', is_inherited: true, is_override: false, effective_for_sprint: false,
          }),
          rule(2, 'todo', 1, {
            scope_kind: 'sprint_override', is_inherited: false, is_override: true, effective_for_sprint: true,
          }),
        ],
      });
      const todo = graph.nodes.find((node) => node.id === 'todo');
      expect(todo?.assignments.find((assignment) => assignment.rule_id === 1)).toMatchObject({
        scope_kind: 'sprint_type_default', is_inherited: true, is_override: false, effective_for_sprint: false,
      });
      expect(todo?.assignments.find((assignment) => assignment.rule_id === 2)).toMatchObject({
        scope_kind: 'sprint_override', is_inherited: false, is_override: true, effective_for_sprint: true,
      });
    });

    it('carries the full scope annotation onto gates', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('done', { terminal: true, stage_order: 1 }),
        ],
        transitions: [transition(1, 'todo', 'done', 'completed')],
        rules: [rule(1, 'todo', 1)],
        requirements: [
          requirement(1, 'completed', {
            scope_kind: 'sprint_type_default', is_inherited: true, is_override: false, effective_for_sprint: false,
          }),
          requirement(2, 'completed', {
            field_name: 'notes',
            scope_kind: 'sprint_override', is_inherited: false, is_override: true, effective_for_sprint: true,
          }),
        ],
      });
      const gates = graph.edges[0].gates;
      expect(gates.find((gate) => gate.requirement_id === 1)).toMatchObject({
        scope_kind: 'sprint_type_default', is_inherited: true, is_override: false, effective_for_sprint: false,
      });
      expect(gates.find((gate) => gate.requirement_id === 2)).toMatchObject({
        scope_kind: 'sprint_override', is_inherited: false, is_override: true, effective_for_sprint: true,
      });
    });

    it('defaults an unannotated gate to a live workflow-type default', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('done', { terminal: true, stage_order: 1 }),
        ],
        transitions: [transition(1, 'todo', 'done', 'completed')],
        rules: [rule(1, 'todo', 1)],
        requirements: [requirement(1, 'completed')],
      });
      expect(graph.edges[0].gates[0]).toMatchObject({
        scope_kind: 'sprint_type_default', is_inherited: false, is_override: false, effective_for_sprint: true,
      });
    });

    it('marks an event-derived edge as always effective and never inherited', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('ready', { stage_order: 1 }),
          status('in_progress', { stage_order: 2 }),
        ],
        transitions: [transition(1, 'todo', 'ready', 'triaged')],
        rules: [rule(1, 'todo', 1), rule(2, 'ready', 1), rule(3, 'in_progress', 1)],
        eventMappings: [eventMapping(27, { status_includes: ['ready'] })],
      });
      expect(graph.edges.find((edge) => edge.kind === 'event')).toMatchObject({
        scope_kind: 'workflow_event', is_inherited: false, is_override: false, effective_for_sprint: true,
      });
    });
  });

  describe('workflow events', () => {
    describe('effectiveEventSources', () => {
      const all = ['todo', 'ready', 'in_progress', 'done'];

      it('expands an empty includes list to every status', () => {
        expect(effectiveEventSources({ status_includes: [], status_excludes: [] }, all)).toEqual(all);
      });

      it('honours an explicit includes list', () => {
        expect(effectiveEventSources({ status_includes: ['ready'], status_excludes: [] }, all)).toEqual(['ready']);
      });

      it('lets excludes win over includes', () => {
        expect(effectiveEventSources({ status_includes: ['ready', 'todo'], status_excludes: ['todo'] }, all))
          .toEqual(['ready']);
      });

      it('drops statuses that are not in the catalog', () => {
        // Real mappings exclude statuses that do not exist for every workflow type.
        expect(effectiveEventSources({ status_includes: ['ready', 'ghost'], status_excludes: [] }, all))
          .toEqual(['ready']);
      });
    });

    // Regression for the reported bug: Default Project / dev showed Ready as a dead end
    // and In Progress as unreachable, because mapping #27 (agent_started -> in_progress)
    // moves the task and the graph only knew about transitions.
    const withAgentStarted = () => build({
      statuses: [
        status('todo', { is_default_entry: true, stage_order: 0 }),
        status('ready', { stage_order: 1 }),
        status('in_progress', { stage_order: 2 }),
        status('done', { terminal: true, stage_order: 3 }),
      ],
      transitions: [
        transition(1, 'todo', 'ready', 'triaged'),
        transition(2, 'in_progress', 'done', 'completed'),
      ],
      rules: [rule(1, 'todo', 1), rule(2, 'ready', 1), rule(3, 'in_progress', 1)],
      eventMappings: [eventMapping(27, { status_excludes: ['in_progress', 'done'] })],
    });

    it('does not call a status a dead end when an event leaves it', () => {
      const graph = withAgentStarted();
      expect(graph.nodes.find(n => n.id === 'ready')?.lint).not.toContain('dead_end_status');
    });

    it('does not call a status unreachable when an event reaches it', () => {
      const graph = withAgentStarted();
      expect(graph.nodes.find(n => n.id === 'in_progress')?.lint).not.toContain('unreachable_status');
    });

    it('surfaces an ambient event as an inbound marker on its target', () => {
      const graph = withAgentStarted();
      const target = graph.nodes.find(n => n.id === 'in_progress');
      expect(target?.inbound_events).toHaveLength(1);
      expect(target?.inbound_events[0]).toMatchObject({ mapping_id: 27, event_name: 'agent_started' });
      // todo and ready can fire it; in_progress and done are excluded.
      expect(target?.inbound_events[0].from).toEqual(['todo', 'ready']);
    });

    it('does not draw ambient events as arcs', () => {
      const graph = withAgentStarted();
      expect(graph.edges.every(edge => edge.kind === 'transition')).toBe(true);
      expect(graph.edges).toHaveLength(2);
    });

    it('draws a scoped event mapping as a real edge instead', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('ready', { stage_order: 1 }),
          status('in_progress', { stage_order: 2 }),
        ],
        transitions: [transition(1, 'todo', 'ready', 'triaged')],
        rules: [rule(1, 'todo', 1), rule(2, 'ready', 1), rule(3, 'in_progress', 1)],
        eventMappings: [eventMapping(27, { status_includes: ['ready'] })],
      });
      const eventEdge = graph.edges.find(edge => edge.kind === 'event');
      expect(eventEdge).toMatchObject({ from: 'ready', to: 'in_progress', outcome: 'agent_started', mapping_id: 27 });
      // Drawn as an arc, so it must NOT also appear as a node marker.
      expect(graph.nodes.find(n => n.id === 'in_progress')?.inbound_events).toEqual([]);
    });

    it('treats an outcome-kind mapping as a trigger on existing edges, not a new edge', () => {
      const graph = build({
        statuses: [
          status('review', { is_default_entry: true, stage_order: 0 }),
          status('done', { terminal: true, stage_order: 1 }),
        ],
        transitions: [transition(1, 'review', 'done', 'completed_for_review')],
        rules: [rule(1, 'review', 1)],
        eventMappings: [eventMapping(3, {
          event_name: 'deployed_for_qa',
          action_kind: 'outcome',
          action_target: 'completed_for_review',
        })],
      });
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0].event_triggers).toHaveLength(1);
      expect(graph.edges[0].event_triggers[0]).toMatchObject({ mapping_id: 3, event_name: 'deployed_for_qa' });
    });

    it('ignores ignore-kind and disabled mappings entirely', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('done', { terminal: true, stage_order: 1 }),
        ],
        transitions: [transition(1, 'todo', 'done', 'completed')],
        rules: [rule(1, 'todo', 1)],
        eventMappings: [
          eventMapping(5, { action_kind: 'ignore', action_target: null }),
          eventMapping(6, { enabled: false }),
        ],
      });
      expect(graph.edges).toHaveLength(1);
      expect(graph.nodes.every(n => n.inbound_events.length === 0)).toBe(true);
    });

    it('flags an event targeting a status outside the catalog', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('done', { terminal: true, stage_order: 1 }),
        ],
        transitions: [transition(1, 'todo', 'done', 'completed')],
        rules: [rule(1, 'todo', 1)],
        eventMappings: [eventMapping(9, { status_includes: ['todo'], action_target: 'ghost' })],
      });
      expect(codes(graph)).toContain('event_to_unknown_status');
    });

    it('does not report an event-only scope as unconfigured', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('in_progress', { stage_order: 1 }),
        ],
        transitions: [],
        rules: [rule(1, 'todo', 1), rule(2, 'in_progress', 1)],
        eventMappings: [eventMapping(27, { status_excludes: ['in_progress'] })],
      });
      expect(codes(graph)).not.toContain('scope_not_configured');
    });
  });

  describe('back edges', () => {
    it('marks a transition that moves a task backwards as a rework loop', () => {
      const graph = build({
        statuses: [
          status('todo', { is_default_entry: true, stage_order: 0 }),
          status('review', { stage_order: 1 }),
          status('done', { terminal: true, stage_order: 2 }),
        ],
        transitions: [
          transition(1, 'todo', 'review', 'completed'),
          transition(2, 'review', 'done', 'approved'),
          transition(3, 'review', 'todo', 'changes_requested'),
        ],
        rules: [rule(1, 'todo', 1), rule(2, 'review', 1)],
      });
      expect(graph.edges.find((edge) => edge.transition_id === 3)?.is_back_edge).toBe(true);
      expect(graph.edges.find((edge) => edge.transition_id === 1)?.is_back_edge).toBe(false);
    });
  });
});

// ── Global gate fallback ──────────────────────────────────────────────────────
//
// loadTransitionRequirements REPLACES rather than accumulates: an empty workflow-scoped set
// hands the outcome to the global table. Every enabled global row in production is severity
// 'block', so this is the difference between "no gate" and "the strictest gate there is".

test('an outcome with no workflow gate falls back to the global table', () => {
  const graph = build({
    statuses: [status('review'), status('done')],
    transitions: [transition(1, 'review', 'done', 'qa_pass')],
    globalRequirements: [globalRequirement(9, 'qa_pass', { field_name: 'qa_verified_commit' })],
  });
  const gates = graph.edges[0].gates;
  expect(gates.length).toBe(1);
  expect(gates[0].source).toBe('global');
  expect(gates[0].field_name).toBe('qa_verified_commit');
  expect(gates[0].scope_kind).toBe('global_default');
  expect(codes(graph).includes('gate_from_global_fallback')).toBe(true);
});

test('one surviving workflow gate short-circuits the global table entirely', () => {
  // This is why disabling gates one at a time looks safe right up until the last one.
  const graph = build({
    statuses: [status('review'), status('done')],
    transitions: [transition(1, 'review', 'done', 'qa_pass')],
    requirements: [requirement(1, 'qa_pass', { field_name: 'pr_url' })],
    globalRequirements: [globalRequirement(9, 'qa_pass', { field_name: 'qa_verified_commit' })],
  });
  const gates = graph.edges[0].gates;
  expect(gates.length).toBe(1);
  expect(gates[0].source).toBe('workflow');
  expect(gates[0].field_name).toBe('pr_url');
  expect(codes(graph).includes('gate_from_global_fallback')).toBe(false);
});

test('disabling the last workflow gate hands the outcome to the global table', () => {
  // The trap in full: the operator disables a gate to unblock work and gets a stricter one.
  const graph = build({
    statuses: [status('review'), status('done')],
    transitions: [transition(1, 'review', 'done', 'completed_for_review')],
    requirements: [requirement(1, 'completed_for_review', { enabled: false, severity: 'warn' })],
    globalRequirements: [
      globalRequirement(9, 'completed_for_review', { field_name: 'review_branch' }),
      globalRequirement(10, 'completed_for_review', { field_name: 'review_commit' }),
    ],
  });
  const gates = graph.edges[0].gates;
  expect(gates.length).toBe(2);
  expect(gates.every(gate => gate.source === 'global' && gate.severity === 'block')).toBe(true);
  const finding = graph.lint.find(f => f.code === 'gate_from_global_fallback');
  expect(finding).toBeDefined();
  expect(finding?.message).toMatch(/review_branch, review_commit/);
});

test('a task-type-specific global row beats the all-types global row', () => {
  const graph = build({
    statuses: [status('review'), status('done')],
    transitions: [transition(1, 'review', 'done', 'qa_pass', { task_type: 'qa' })],
    globalRequirements: [
      globalRequirement(9, 'qa_pass', { task_type: null, field_name: 'generic_field' }),
      globalRequirement(10, 'qa_pass', { task_type: 'qa', field_name: 'qa_field' }),
    ],
  });
  expect(graph.edges[0].gates.map(g => g.field_name)).toEqual(['qa_field']);
});

test('an outcome with no global row and no workflow gate stays ungated', () => {
  const graph = build({
    statuses: [status('review'), status('done')],
    transitions: [transition(1, 'review', 'done', 'looks_good')],
    globalRequirements: [globalRequirement(9, 'qa_pass')],
  });
  expect(graph.edges[0].gates.length).toBe(0);
  expect(codes(graph).includes('gate_from_global_fallback')).toBe(false);
});

test('global fallback is reported once per outcome, not once per edge', () => {
  const graph = build({
    statuses: [status('review'), status('done'), status('failed')],
    transitions: [
      transition(1, 'review', 'done', 'qa_pass'),
      transition(2, 'review', 'failed', 'qa_pass'),
    ],
    globalRequirements: [globalRequirement(9, 'qa_pass')],
  });
  expect(codes(graph).filter(code => code === 'gate_from_global_fallback').length).toBe(1);
});

test('task-type gates replacing the all-types set is reported', () => {
  const graph = build({
    statuses: [status('review'), status('done')],
    transitions: [transition(1, 'review', 'done', 'qa_pass')],
    requirements: [
      requirement(1, 'qa_pass', { task_type: null, field_name: 'pr_url' }),
      requirement(2, 'qa_pass', { task_type: 'qa', field_name: 'qa_commit' }),
    ],
  });
  const finding = graph.lint.find(f => f.code === 'gate_task_type_replaces_default');
  expect(finding).toBeDefined();
  expect(finding?.message).toMatch(/qa/);
});

test('task-type gates alone are not reported as replacing anything', () => {
  const graph = build({
    statuses: [status('review'), status('done')],
    transitions: [transition(1, 'review', 'done', 'qa_pass')],
    requirements: [requirement(1, 'qa_pass', { task_type: 'qa' })],
  });
  expect(codes(graph).includes('gate_task_type_replaces_default')).toBe(false);
});

test('a disabled row does not count toward the task-type replacement warning', () => {
  const graph = build({
    statuses: [status('review'), status('done')],
    transitions: [transition(1, 'review', 'done', 'qa_pass')],
    requirements: [
      requirement(1, 'qa_pass', { task_type: null }),
      requirement(2, 'qa_pass', { task_type: 'qa', enabled: false }),
    ],
  });
  expect(codes(graph).includes('gate_task_type_replaces_default')).toBe(false);
});

test('outcome-scoped findings carry their outcome so the preview diff can tell them apart', () => {
  // preview.ts keys findings by code + node + edge + outcome. Several outcomes raise
  // gate_from_global_fallback at once, so without the anchor they collapse to a single key and
  // a change that fixes exactly one of them is reported as fixing none.
  const graph = build({
    statuses: [status('review'), status('done'), status('live')],
    transitions: [
      transition(1, 'review', 'done', 'qa_pass'),
      transition(2, 'done', 'live', 'live_verified'),
    ],
    globalRequirements: [
      globalRequirement(9, 'qa_pass'),
      globalRequirement(10, 'live_verified'),
    ],
  });
  const fallbacks = graph.lint.filter(f => f.code === 'gate_from_global_fallback');
  expect(fallbacks.map(f => f.outcome).sort()).toEqual(['live_verified', 'qa_pass']);
});

test('an unused-gate finding is anchored to its outcome too', () => {
  const graph = build({
    statuses: [status('review'), status('done')],
    transitions: [transition(1, 'review', 'done', 'qa_pass')],
    requirements: [requirement(1, 'never_used')],
  });
  const finding = graph.lint.find(f => f.code === 'gate_without_transition');
  expect(finding?.outcome).toBe('never_used');
});
