// Gate requirement drafts, and the consequence that has to be said out loud.
//
// Gate resolution REPLACES rather than accumulates. `loadTransitionRequirements` takes the
// first non-empty set of: this workflow's enabled rows, then the global `transition_requirements`
// table. Two things follow, and neither is visible anywhere in the rows themselves:
//
//   * Declaring the FIRST workflow gate for an outcome drops the entire global set for it —
//     not just the row you replaced. Four global gates can vanish behind one new gate.
//   * Removing or disabling the LAST workflow gate for an outcome brings that whole global set
//     back. Every enabled global row in production is severity 'block', so a gate disabled to
//     unblock work can return stricter than it left.
//
// The second has deadlocked real tasks. These helpers are pure and tested because the warning
// is only useful if the count in it is right.

import type { WorkflowGraph } from '@/lib/api';

export type GraphGate = WorkflowGraph['edges'][number]['gates'][number];

export interface GateDraft {
  /** Null means create. */
  requirement_id: number | null;
  /** Heading, since the same form serves add / edit / override / take-control. */
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
  /** True when this draft would be the first workflow gate for its outcome. */
  takes_over_from_global: boolean;
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
  const seen = new Set<string>();
  const gates: GraphGate[] = [];
  for (const edge of graph.edges) {
    if (edge.outcome !== outcome) continue;
    for (const gate of edge.gates) {
      const key = `${gate.source ?? 'workflow'}-${gate.requirement_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      gates.push(gate);
    }
  }
  return gates;
}

/** True when the outcome is gated only because the global table stepped in. */
export function isOnGlobalFallback(graph: WorkflowGraph, outcome: string): boolean {
  const gates = gatesForOutcome(graph, outcome);
  return gates.length > 0 && gates.every(gate => gate.source === 'global');
}

/** A new gate on an outcome that currently has none of its own. */
export function newGateDraft(graph: WorkflowGraph, outcome: string, taskType: string | null = null): GateDraft {
  return {
    ...BLANK,
    requirement_id: null,
    title: 'Add gate',
    outcome,
    task_type: taskType,
    takes_over_from_global: isOnGlobalFallback(graph, outcome),
  };
}

/**
 * Editing an existing gate.
 *
 * A global row cannot be edited from a workflow canvas — it is shared by every project and
 * lives in another table — so selecting one produces a CREATE seeded from its values. That is
 * the only way to take control of the outcome here, and it takes over the whole global set.
 */
export function gateDraftFrom(gate: GraphGate, graph: WorkflowGraph): GateDraft {
  const isGlobal = gate.source === 'global';
  return {
    requirement_id: isGlobal ? null : gate.requirement_id,
    title: isGlobal ? 'Define workflow gate' : 'Edit gate',
    outcome: outcomeOf(gate, graph),
    task_type: gate.task_type,
    field_name: gate.field_name,
    requirement_type: (gate.requirement_type as GateDraft['requirement_type']) ?? 'required',
    match_field: null,
    severity: (gate.severity as GateDraft['severity']) ?? 'block',
    message: gate.message ?? '',
    priority: 0,
    enabled: true,
    is_override: !isGlobal && Boolean(gate.is_override),
    takes_over_from_global: isGlobal,
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
    takes_over_from_global: false,
  };
}

function outcomeOf(gate: GraphGate, graph: WorkflowGraph): string {
  for (const edge of graph.edges) {
    if (edge.gates.some(g => g.requirement_id === gate.requirement_id && g.source === gate.source)) return edge.outcome;
  }
  return '';
}

/**
 * The sentence to show above the form, or null when nothing surprising happens.
 *
 * Only the replacement direction is stated here. The reverse — removing the last gate and
 * handing the outcome back to the global set — arrives through the preview as an introduced
 * `gate_from_global_fallback` finding, which carries the actual field names.
 */
export function gateReplacementNotice(draft: GateDraft, graph: WorkflowGraph): string | null {
  if (!draft.takes_over_from_global) return null;
  const replaced = gatesForOutcome(graph, draft.outcome).filter(gate => gate.source === 'global');
  if (replaced.length === 0) return null;
  const fields = [...new Set(replaced.map(gate => gate.field_name))];
  return `"${draft.outcome}" is currently gated by the shared global requirements `
    + `(${fields.join(', ')}). Defining a gate here replaces all ${replaced.length} of them, `
    + 'not just the one — the workflow set is used instead of the global set, never alongside it.';
}
