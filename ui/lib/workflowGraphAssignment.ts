import type { WorkflowGraph, WorkflowGraphNode } from '@/lib/api';

export type GraphAssignment = WorkflowGraphNode['assignments'][number];

export interface AssignmentDraft {
  rule_id: number | null;
  status: string;
  agent_id: number;
  agent_name: string;
  task_type: string | null;
  priority: number;
  enabled: boolean;
  is_override: boolean;
}

export interface AssignmentGesture {
  agentId: number;
  agentName: string;
  status: string;
  /** Set when the operator clicked a specific assignment row rather than dropping a chip. */
  rule?: GraphAssignment;
}

/**
 * Turn an assignment gesture into a composer draft.
 *
 * The interesting case is deciding create versus edit. Dropping an agent onto a status it
 * already covers is an EDIT: the unique index on routing rules would reject a second row, so
 * treating it as a create would fail at commit, and silently writing a losing duplicate would
 * be worse than either.
 *
 * A clicked row already knows which row it is, so it wins outright. Matching is only for a
 * bare drop, and only against the all-task-types rule — that is the row a bare drop would
 * actually collide with. Matching a task-type-scoped rule there would drag the operator into
 * editing a narrower rule they never pointed at.
 */
export function assignmentDraft(gesture: AssignmentGesture, graph: WorkflowGraph): AssignmentDraft {
  const node = graph.nodes.find(n => n.id === gesture.status);
  const existing = gesture.rule
    ?? node?.assignments.find(a => a.agent_id === gesture.agentId && a.task_type === null);

  return {
    rule_id: existing?.rule_id ?? null,
    status: gesture.status,
    agent_id: gesture.agentId,
    agent_name: gesture.agentName,
    task_type: existing?.task_type ?? null,
    priority: existing?.priority ?? 0,
    enabled: existing?.enabled ?? true,
    is_override: Boolean(existing?.is_override),
  };
}
