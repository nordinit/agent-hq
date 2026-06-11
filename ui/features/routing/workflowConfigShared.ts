'use client';

import { getTaskTypeLabel } from '@/lib/taskTypes';

export const ROUTING_TABLE_HELP = {
  rules: 'Map task type and current task status to the agent that should receive matching work in the selected workflow.',
  transitions: 'Define outcome-driven task status changes for the selected workflow. Each row is from status plus outcome to destination status.',
  gates: 'Define field checks that must pass before a run outcome can move a task through a configured outcome transition.',
};

export const TRANSITION_COLUMN_HELP = {
  id: 'The canonical database row ID for this transition. Use this to match imported configuration back to persisted rows.',
  taskType: 'The kind of task this transition applies to. All types means any task type can use it.',
  from: 'The task status before an agent reports an outcome.',
  outcome: 'The run outcome an agent reports to request this status change.',
  to: 'The task status Agent HQ should set after the outcome is accepted.',
  priority: 'Which matching transition wins when more than one rule could apply. Lower numbers run first.',
  enabled: 'Whether this transition is active for routing decisions.',
  scope: 'Whether the row is a workflow-type default or an override for the selected workflow.',
  actions: 'Edit or remove this transition.',
};

export const ROUTING_RULE_COLUMN_HELP = {
  id: 'The canonical database row ID for this assignment rule. Use this to match conflict references to visible rows.',
  taskType: 'The kind of task this assignment rule handles.',
  status: 'The current task status that must match before Agent HQ assigns the task.',
  priority: 'Which matching assignment rule wins when more than one rule could apply. Lower numbers run first.',
  agent: 'The agent that receives matching tasks.',
  scope: 'Whether the row is a workflow-type default or an override for the selected workflow.',
  actions: 'Edit or remove this assignment rule.',
};

export const REQUIREMENT_COLUMN_HELP = {
  id: 'The canonical database row ID for this gate requirement. Use this to match imported configuration back to persisted rows.',
  taskType: 'The task type this gate requirement applies to. All task types means the requirement is not task-type scoped.',
  scope: 'Whether this gate requirement is a workflow-type default or a workflow-specific override.',
  outcome: 'The agent outcome that must satisfy this requirement before the task can move forward.',
  field: 'The task evidence field that Agent HQ checks.',
  check: 'The condition the field must satisfy.',
  severity: 'Whether a failed check blocks the outcome or only warns the operator.',
  message: 'The operator-facing explanation shown when the check fails.',
  priority: 'Which requirement is evaluated first when several checks apply.',
  enabled: 'Whether this requirement is active.',
  actions: 'Edit or remove this requirement.',
};

export type ContractPlaceholderDefinition = {
  key: string;
  description: string;
};

export function parseRoutingRulePriority(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const priority = Number(trimmed);
  return Number.isFinite(priority) ? priority : null;
}

export function formatSprintTypeLabel(value: string): string {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function getRoutingTaskTypeLabel(value: string | null | undefined): string {
  return value ? getTaskTypeLabel(value) : 'All task types';
}

export function getRoutingTaskTypeBadgeClass(value: string | null | undefined, typeBadge: Record<string, string>): string {
  return value ? (typeBadge[value] || 'bg-slate-700') : 'bg-cyan-950/70 text-cyan-200';
}
