import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  gateDraftFrom,
  gateOverrideDraft,
  gateReplacementNotice,
  gatesForOutcome,
  isOnGlobalFallback,
  newGateDraft,
  type GraphGate,
} from './workflowGraphGates.ts';
import type { WorkflowGraph } from '@/lib/api';

function gate(over: Partial<GraphGate> = {}): GraphGate {
  return {
    source: 'workflow',
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

test('a workflow gate and a global gate with the same id are different gates', () => {
  // The ids come from different tables and do collide in practice.
  const graph = graphWith([{
    outcome: 'qa_pass',
    gates: [gate({ requirement_id: 3, source: 'workflow' }), gate({ requirement_id: 3, source: 'global' })],
  }]);
  assert.equal(gatesForOutcome(graph, 'qa_pass').length, 2);
});

test('an outcome gated only by global rows is on the fallback', () => {
  const graph = graphWith([{ outcome: 'qa_pass', gates: [gate({ source: 'global' })] }]);
  assert.equal(isOnGlobalFallback(graph, 'qa_pass'), true);
});

test('one workflow gate means the outcome is not on the fallback', () => {
  const graph = graphWith([{ outcome: 'qa_pass', gates: [gate({ source: 'workflow' })] }]);
  assert.equal(isOnGlobalFallback(graph, 'qa_pass'), false);
});

test('an ungated outcome is not on the fallback either', () => {
  const graph = graphWith([{ outcome: 'qa_pass', gates: [] }]);
  assert.equal(isOnGlobalFallback(graph, 'qa_pass'), false);
});

test('the replacement notice counts every global row, not just the one selected', () => {
  // The whole point: replacing one visible gate silently drops the other three.
  const graph = graphWith([{
    outcome: 'live_verified',
    gates: [
      gate({ requirement_id: 1, source: 'global', field_name: 'status' }),
      gate({ requirement_id: 2, source: 'global', field_name: 'deployed_commit' }),
      gate({ requirement_id: 3, source: 'global', field_name: 'live_verified_by' }),
      gate({ requirement_id: 4, source: 'global', field_name: 'live_verified_at' }),
    ],
  }]);
  const notice = gateReplacementNotice(newGateDraft(graph, 'live_verified'), graph);
  assert.match(notice ?? '', /replaces all 4 of them/);
  assert.match(notice ?? '', /status, deployed_commit, live_verified_by, live_verified_at/);
});

test('no replacement notice when the outcome already has a workflow gate', () => {
  const graph = graphWith([{ outcome: 'qa_pass', gates: [gate({ source: 'workflow' })] }]);
  assert.equal(gateReplacementNotice(newGateDraft(graph, 'qa_pass'), graph), null);
});

test('no replacement notice for an ungated outcome', () => {
  const graph = graphWith([{ outcome: 'qa_pass', gates: [] }]);
  assert.equal(gateReplacementNotice(newGateDraft(graph, 'qa_pass'), graph), null);
});

test('selecting a global gate produces a create, not an edit', () => {
  // A global row belongs to another table and every project; it cannot be edited from here.
  const global = gate({ requirement_id: 12, source: 'global', field_name: 'review_branch' });
  const graph = graphWith([{ outcome: 'completed_for_review', gates: [global] }]);
  const draft = gateDraftFrom(global, graph);
  assert.equal(draft.requirement_id, null);
  assert.equal(draft.field_name, 'review_branch');
  assert.equal(draft.outcome, 'completed_for_review');
  assert.equal(draft.takes_over_from_global, true);
});

test('selecting a workflow gate produces an edit that keeps its identity', () => {
  const own = gate({ requirement_id: 12, source: 'workflow', is_override: true, severity: 'warn' });
  const graph = graphWith([{ outcome: 'qa_pass', gates: [own] }]);
  const draft = gateDraftFrom(own, graph);
  assert.equal(draft.requirement_id, 12);
  assert.equal(draft.is_override, true);
  assert.equal(draft.severity, 'warn');
  assert.equal(draft.takes_over_from_global, false);
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

test('overriding never claims to take over the global set', () => {
  // An inherited row exists, so the outcome is not on the fallback by definition.
  const inherited = gate({ requirement_id: 5, source: 'workflow' });
  const graph = graphWith([{ outcome: 'qa_pass', gates: [inherited] }]);
  const draft = gateOverrideDraft(inherited, graph);
  assert.equal(draft.takes_over_from_global, false);
  assert.equal(gateReplacementNotice(draft, graph), null);
});

test('a new gate on an outcome sitting on the fallback is flagged as a takeover', () => {
  const graph = graphWith([{ outcome: 'qa_pass', gates: [gate({ source: 'global' })] }]);
  assert.equal(newGateDraft(graph, 'qa_pass').takes_over_from_global, true);
});

test('a new gate carries the task type lens it was created under', () => {
  const graph = graphWith([{ outcome: 'qa_pass', gates: [] }]);
  assert.equal(newGateDraft(graph, 'qa_pass', 'qa').task_type, 'qa');
});
