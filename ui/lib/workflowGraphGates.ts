// Gate requirement drafts.
//
// Gate resolution accumulates. A task-type gate adds to the all-types set for that type; it
// replaces a single all-types gate only when it names the same field and requirement type,
// which is what an override draft below produces. It used to substitute the entire set, so
// adding one narrow gate silently dropped every default for that outcome and task type.
//
// There used to be a second, worse surprise here. A global `transition_requirements` table
// applied whenever a workflow's own set for an outcome was empty, so declaring the FIRST gate
// on an outcome silently dropped a whole set of gates, and removing the LAST one brought that
// set back — every row of it severity 'block'. That deadlocked real tasks. Migration 15 moved
// the table into the dev workflow default and dropped it; nothing outside this workflow's own
// rows can gate an outcome now, so there is no longer a replacement notice to show.

import type { WorkflowGraph } from '@/lib/api';

export type GraphGate = WorkflowGraph['edges'][number]['gates'][number];

export interface GateDraft {
  /** Null means create. */
  requirement_id: number | null;
  /** Heading, since the same form serves add / edit / override. */
  title: string;
  outcome: string;
  task_type: string | null;
  field_name: string;
  requirement_type: 'required' | 'match' | 'from_status';
  match_field: string | null;
  severity: 'block' | 'warn';
  message: string;
  priority: number;
  enabled: boolean;
  is_override: boolean;
}

const BLANK = {
  task_type: null,
  field_name: '',
  requirement_type: 'required' as const,
  match_field: null,
  severity: 'block' as const,
  message: '',
  priority: 0,
  enabled: true,
  is_override: false,
};

/** Every gate the graph currently shows for an outcome, across all edges carrying it. */
export function gatesForOutcome(graph: WorkflowGraph, outcome: string): GraphGate[] {
  const seen = new Set<number>();
  const gates: GraphGate[] = [];
  for (const edge of graph.edges) {
    if (edge.outcome !== outcome) continue;
    for (const gate of edge.gates) {
      if (seen.has(gate.requirement_id)) continue;
      seen.add(gate.requirement_id);
      gates.push(gate);
    }
  }
  return gates;
}

/** A new gate on an outcome. */
export function newGateDraft(graph: WorkflowGraph, outcome: string, taskType: string | null = null): GateDraft {
  return {
    ...BLANK,
    requirement_id: null,
    title: 'Add gate',
    outcome,
    task_type: taskType,
  };
}

/** Editing an existing gate. */
export function gateDraftFrom(gate: GraphGate, graph: WorkflowGraph): GateDraft {
  return {
    requirement_id: gate.requirement_id,
    title: 'Edit gate',
    outcome: outcomeOf(gate, graph),
    task_type: gate.task_type,
    field_name: gate.field_name,
    requirement_type: (gate.requirement_type as GateDraft['requirement_type']) ?? 'required',
    match_field: null,
    severity: (gate.severity as GateDraft['severity']) ?? 'block',
    message: gate.message ?? '',
    priority: 0,
    enabled: true,
    is_override: Boolean(gate.is_override),
  };
}

/**
 * Overriding an inherited workflow-type default for one workflow.
 *
 * There is no operation that moves a row between scopes, and disabling the inherited row is not
 * it either — a disabled override falls through to the default, by design. The only mechanism
 * is a NEW workflow-scoped row carrying the same identity (task type, outcome, field, check,
 * match field), which the resolver de-dupes in favour of the more specific scope.
 *
 * Severity defaults to 'warn' because unblocking one workflow is what this is nearly always
 * for, and 'block' would reproduce the row it is overriding.
 */
export function gateOverrideDraft(gate: GraphGate, graph: WorkflowGraph): GateDraft {
  return {
    ...gateDraftFrom(gate, graph),
    requirement_id: null,
    title: 'Override for this workflow',
    severity: 'warn',
    is_override: true,
  };
}

function outcomeOf(gate: GraphGate, graph: WorkflowGraph): string {
  for (const edge of graph.edges) {
    if (edge.gates.some(g => g.requirement_id === gate.requirement_id)) return edge.outcome;
  }
  return '';
}
