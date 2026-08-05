import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  gateDraftFrom,
  gateOverrideDraft,
  gatesForOutcome,
  newGateDraft,
  type GraphGate,
} from './workflowGraphGates.ts';
import type { WorkflowGraph } from '@/lib/api';

function gate(over: Partial<GraphGate> = {}): GraphGate {
  return {
    requirement_id: 1,
    field_name: 'review_commit',
    requirement_type: 'required',
    severity: 'block',
    message: '',
    task_type: null,
    enabled: true,
    scope_kind: 'sprint_type_default',
    is_inherited: true,
    is_override: false,
    effective_for_sprint: true,
    ...over,
  } as GraphGate;
}

function graphWith(edges: Array<{ outcome: string; gates: GraphGate[] }>): WorkflowGraph {
  return { edges } as unknown as WorkflowGraph;
}

test('gates for an outcome are deduped across the edges that share it', () => {
  // One transition drawn from three source statuses is three edges carrying one gate row.
  const shared = gate({ requirement_id: 7 });
  const graph = graphWith([
    { outcome: 'qa_pass', gates: [shared] },
    { outcome: 'qa_pass', gates: [shared] },
    { outcome: 'other', gates: [gate({ requirement_id: 9 })] },
  ]);
  assert.equal(gatesForOutcome(graph, 'qa_pass').length, 1);
});

test('every gate on an outcome belongs to this workflow', () => {
  // There was a second source once — a global table consulted when this workflow's set for the
  // outcome was empty — and its ids collided with these. Migration 15 dropped it, so
  // requirement_id is unambiguous again and is the whole dedupe key.
  const graph = graphWith([{
    outcome: 'qa_pass',
    gates: [gate({ requirement_id: 3 }), gate({ requirement_id: 4 })],
  }]);
  assert.equal(gatesForOutcome(graph, 'qa_pass').length, 2);
});

test('selecting a gate produces an edit that keeps its identity', () => {
  const own = gate({ requirement_id: 12, is_override: true, severity: 'warn' });
  const graph = graphWith([{ outcome: 'qa_pass', gates: [own] }]);
  const draft = gateDraftFrom(own, graph);
  assert.equal(draft.requirement_id, 12);
  assert.equal(draft.is_override, true);
  assert.equal(draft.severity, 'warn');
  assert.equal(draft.outcome, 'qa_pass');
});

test('an override draft is a create that keeps the identity and warns instead of blocking', () => {
  // Identity must survive — task type, outcome, field and check are what the resolver dedupes
  // on, so changing any of them adds a second gate rather than overriding the first.
  const inherited = gate({ requirement_id: 5, task_type: 'qa', field_name: 'qa_verified_commit', severity: 'block' });
  const graph = graphWith([{ outcome: 'qa_pass', gates: [inherited] }]);
  const draft = gateOverrideDraft(inherited, graph);
  assert.equal(draft.requirement_id, null);
  assert.equal(draft.task_type, 'qa');
  assert.equal(draft.field_name, 'qa_verified_commit');
  assert.equal(draft.requirement_type, 'required');
  assert.equal(draft.outcome, 'qa_pass');
  assert.equal(draft.severity, 'warn');
  assert.equal(draft.is_override, true);
});

test('a new gate on an ungated outcome is an ordinary create', () => {
  const graph = graphWith([{ outcome: 'qa_pass', gates: [] }]);
  const draft = newGateDraft(graph, 'qa_pass');
  assert.equal(draft.requirement_id, null);
  assert.equal(draft.outcome, 'qa_pass');
  assert.equal(draft.title, 'Add gate');
});

test('a new gate carries the task type lens it was created under', () => {
  const graph = graphWith([{ outcome: 'qa_pass', gates: [] }]);
  assert.equal(newGateDraft(graph, 'qa_pass', 'qa').task_type, 'qa');
});
