import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignmentDraft, type GraphAssignment } from './workflowGraphAssignment.ts';
import type { WorkflowGraph } from '@/lib/api';

function assignment(over: Partial<GraphAssignment>): GraphAssignment {
  return {
    rule_id: 1,
    agent_id: 7,
    agent_name: 'Talon (QA)',
    agent_enabled: true,
    task_type: null,
    priority: 0,
    enabled: true,
    is_override: false,
    ...over,
  } as GraphAssignment;
}

function graphWith(assignments: GraphAssignment[]): WorkflowGraph {
  return {
    nodes: [{ id: 'review', label: 'Review', assignments } as unknown as WorkflowGraph['nodes'][number]],
  } as WorkflowGraph;
}

test('a bare drop onto an unassigned status is a create', () => {
  const draft = assignmentDraft({ agentId: 7, agentName: 'Talon (QA)', status: 'review' }, graphWith([]));
  assert.equal(draft.rule_id, null);
  assert.equal(draft.priority, 0);
  assert.equal(draft.enabled, true);
  assert.equal(draft.is_override, false);
});

test('a bare drop onto a status the agent already covers is an edit, not a duplicate', () => {
  // The unique index would reject a second all-task-types row for the same agent and status,
  // so a create here fails at commit; matching turns it into the edit the operator meant.
  const graph = graphWith([assignment({ rule_id: 42, priority: -5, is_override: true })]);
  const draft = assignmentDraft({ agentId: 7, agentName: 'Talon (QA)', status: 'review' }, graph);
  assert.equal(draft.rule_id, 42);
  assert.equal(draft.priority, -5);
  assert.equal(draft.is_override, true);
});

test('a bare drop ignores a task-type-scoped rule and still creates', () => {
  // Dropping a chip says nothing about task type, so it must not silently retarget a narrower
  // rule the operator never pointed at.
  const graph = graphWith([assignment({ rule_id: 42, task_type: 'qa' })]);
  const draft = assignmentDraft({ agentId: 7, agentName: 'Talon (QA)', status: 'review' }, graph);
  assert.equal(draft.rule_id, null);
  assert.equal(draft.task_type, null);
});

test('a clicked row is edited by identity, task type and all', () => {
  // This is the regression: matching by task_type === null would miss a scoped row entirely
  // and turn an explicit edit into a create.
  const rule = assignment({ rule_id: 99, task_type: 'qa', priority: 3, enabled: false });
  const draft = assignmentDraft(
    { agentId: 7, agentName: 'Talon (QA)', status: 'review', rule },
    graphWith([rule]),
  );
  assert.equal(draft.rule_id, 99);
  assert.equal(draft.task_type, 'qa');
  assert.equal(draft.priority, 3);
  assert.equal(draft.enabled, false);
});

test('a clicked row wins over a same-agent match in the graph', () => {
  const clicked = assignment({ rule_id: 99, task_type: 'qa', priority: 3 });
  const bare = assignment({ rule_id: 42, task_type: null, priority: -5 });
  const draft = assignmentDraft(
    { agentId: 7, agentName: 'Talon (QA)', status: 'review', rule: clicked },
    graphWith([bare, clicked]),
  );
  assert.equal(draft.rule_id, 99);
  assert.equal(draft.priority, 3);
});

test('an unknown status yields a create rather than throwing', () => {
  const draft = assignmentDraft({ agentId: 7, agentName: 'Talon (QA)', status: 'nope' }, graphWith([assignment({})]));
  assert.equal(draft.rule_id, null);
});

test('another agent on the same status does not match', () => {
  const graph = graphWith([assignment({ rule_id: 42, agent_id: 8, agent_name: 'Gauge (QA)' })]);
  const draft = assignmentDraft({ agentId: 7, agentName: 'Talon (QA)', status: 'review' }, graph);
  assert.equal(draft.rule_id, null);
  assert.equal(draft.agent_id, 7);
});
