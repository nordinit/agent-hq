import type { AgentApprovals, SetupCheck, WorkflowCheck } from './api';

/**
 * Plain-language status for each check on the Approvals page.
 *
 * Tones: `blocked` means a task can't start because of it right now; `attention` means work routed
 * to the agent would wait; `ok` passes; `muted` fails but nothing is routed there, so nothing waits.
 */
export type ApprovalTone = 'blocked' | 'attention' | 'ok' | 'muted';

export interface CellStatus {
  label: string;
  tone: ApprovalTone;
  detail: string;
}

export const TONE_CLASSES: Record<ApprovalTone, string> = {
  blocked: 'border-red-500/40 bg-red-500/15 text-red-200',
  attention: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  ok: 'border-green-500/30 bg-green-500/10 text-green-300',
  muted: 'border-slate-600 bg-slate-800 text-slate-400',
};

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "review", "review or blocked", "review, blocked or failed". */
export function listStatuses(statuses: string[]): string {
  const names = statuses.map(status => status.replace(/_/g, ' '));
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

function changeSummary(check: SetupCheck): string {
  const labels = check.changes.map(change => change.label);
  if (labels.length === 0) return '';
  const shown = labels.slice(0, 3).join(', ');
  return labels.length > 3 ? `${shown} and ${labels.length - 3} more` : shown;
}

export function permissionStatus(entry: AgentApprovals): CellStatus {
  if (entry.host_execute) return { label: 'Allowed', tone: 'ok', detail: 'Agent HQ may start it on this machine.' };
  const held = entry.host_execute_holds.length;
  if (held > 0) return { label: 'Not allowed', tone: 'blocked', detail: `${plural(held, 'task')} can't start until you allow it.` };
  if (entry.routed) return { label: 'Not allowed', tone: 'attention', detail: 'Tasks routed to it will wait until you allow it.' };
  return { label: 'Not allowed', tone: 'muted', detail: 'Nothing is routed to it, so nothing is waiting.' };
}

function checkLabel(check: SetupCheck): string {
  if (check.state === 'approved') return 'Approved';
  return check.state === 'changed_since_approval' ? 'Changed' : 'Not approved';
}

export function setupStatus(entry: AgentApprovals): CellStatus {
  const check = entry.setup;
  const label = checkLabel(check);
  if (check.state === 'approved') return { label, tone: 'ok', detail: 'Matches what you approved.' };
  if (check.holds.length > 0) return { label, tone: 'blocked', detail: `${plural(check.holds.length, 'task')} can't start until you review it.` };
  if (check.state === 'changed_since_approval') return { label, tone: 'attention', detail: 'Changed after you approved it. Its next task will wait for you.' };
  if (entry.routed) return { label, tone: 'attention', detail: 'Never approved. Tasks routed to it will wait for you.' };
  return { label, tone: 'muted', detail: 'Never approved, but nothing is routed to it yet.' };
}

export function workflowStatus(check: WorkflowCheck): CellStatus {
  const label = checkLabel(check);
  if (check.state === 'approved') return { label, tone: 'ok', detail: 'Its tasks in this workflow start normally.' };
  if (check.holds.length > 0) return { label, tone: 'blocked', detail: `${plural(check.holds.length, 'task')} here can't start until you review it.` };
  if (check.state === 'changed_since_approval') return { label, tone: 'attention', detail: 'Changed after you approved it. The next task here will wait for you.' };
  return { label, tone: 'attention', detail: 'Never approved for this agent. No task is waiting on it.' };
}

/** The Workflow setups column: one summary for every workflow routed to the agent. */
export function workflowsStatus(entry: AgentApprovals): CellStatus {
  const total = entry.workflows.length;
  if (total === 0) return { label: 'None routed', tone: 'muted', detail: 'No routing rule sends it work.' };
  const changed = entry.workflows.filter(check => check.state === 'changed_since_approval');
  const missing = entry.workflows.filter(check => check.state === 'not_approved');
  if (changed.length === 0 && missing.length === 0) {
    return { label: total === 1 ? 'Approved' : `All ${total} approved`, tone: 'ok', detail: 'Its tasks in these workflows start normally.' };
  }
  const label = [changed.length > 0 ? `${changed.length} changed` : '', missing.length > 0 ? `${missing.length} not approved` : '']
    .filter(Boolean).join(', ');
  const blocked = entry.workflows.some(check => check.holds.length > 0);
  const names = [...changed, ...missing].map(check => check.workflow.name).join(', ');
  return { label, tone: blocked ? 'blocked' : 'attention', detail: `Needs your review: ${names}.` };
}

export function tasksStatus(entry: AgentApprovals): CellStatus {
  const held = entry.holds.length;
  if (held > 0) return { label: `${held} can't start`, tone: 'blocked', detail: 'Tasks waiting on a check that failed.' };
  return { label: 'None waiting', tone: 'muted', detail: 'No task is waiting on this agent.' };
}

export function permissionExplanation(entry: AgentApprovals): string {
  const name = entry.agent.name;
  if (entry.host_execute) {
    return `${name} may start its runtime and run commands on this machine, as your user account. You can remove this on its Capability map.`;
  }
  return `Agent HQ won't start ${name} on any task until you allow it. Allowing it lets ${name} start its runtime and run commands on this machine, as your user account.`;
}

export function setupExplanation(entry: AgentApprovals): string {
  const check = entry.setup;
  if (check.state === 'approved') return 'Its instructions, skills, model and credentials match what you approved.';
  if (check.state === 'changed_since_approval') {
    return `Changed after you approved it: ${changeSummary(check) || 'see the details'}. Its tasks wait until you review the change.`;
  }
  return entry.routed
    ? 'Never approved. Tasks routed to it wait until you approve its instructions, skills, model and credentials.'
    : 'Never approved. Nothing is routed to it yet, so nothing is waiting.';
}

/** Why a workflow is listed for this agent: the routing rules that send it work there. */
export function routesSentence(agentName: string, check: WorkflowCheck): string {
  const { count, statuses } = check.routes;
  if (count === 0) return `No routing rule sends ${agentName} work here; a task here was given to it directly.`;
  const rules = count === 1 ? 'One routing rule sends' : `${count} routing rules send`;
  return statuses.length > 0
    ? `${rules} ${agentName} tasks here when they reach ${listStatuses(statuses)}.`
    : `${rules} ${agentName} tasks here.`;
}

/** "James", "James and Casper", "James, Casper and 2 others". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

/**
 * `approvedFor` names the other agents this workflow's current setup is approved for: the setup
 * is the workflow's, so it is the same for all of them, but each agent is approved separately.
 */
export function workflowExplanation(entry: AgentApprovals, check: WorkflowCheck, approvedFor: string[] = []): string {
  const name = entry.agent.name;
  if (check.state === 'approved') return `Approved for ${name}, so its tasks here start normally.`;
  const elsewhere = check.state === 'not_approved' && approvedFor.length > 0
    ? ` It is approved for ${joinNames(approvedFor)}: the setup is the same for every agent in this workflow, but each agent needs its own approval.`
    : '';
  if (check.holds.length > 0) return `${plural(check.holds.length, 'task')} here can't start until you review this setup.${elsewhere}`;
  if (check.state === 'changed_since_approval') {
    return `Changed after you approved it: ${changeSummary(check) || 'see the details'}. The next task here waits for you.`;
  }
  return `Never approved for ${name}.${elsewhere} No task is waiting on it, so nothing is blocked today.`;
}

/** What else must pass before the agent's tasks can start, besides the check being approved. */
export function stillNeeded(entry: AgentApprovals, target: 'permission' | SetupCheck, grantingPermission: boolean): string[] {
  const needed: string[] = [];
  if (target !== 'permission' && !entry.host_execute && !grantingPermission) needed.push('allowing it to run on this machine');
  if (target === 'permission' || target.resource_kind === 'workflow_setup') {
    if (entry.setup.state !== 'approved') needed.push(`approving ${entry.agent.name}'s own setup`);
  }
  if (target === 'permission' || target.resource_kind === 'agent_runtime') {
    const workflows = entry.workflows.filter(check => check.state !== 'approved' && check.routes.count > 0);
    if (workflows.length > 0) needed.push(`approving its ${workflows.length === 1 ? 'workflow' : 'workflows'} ${workflows.map(check => check.workflow.name).join(', ')}`);
  }
  return needed;
}

/** Tasks that can't start come first, then everything else that needs attention, then by name. */
export function sortApprovals(entries: AgentApprovals[]): AgentApprovals[] {
  return [...entries].sort((a, b) => (b.holds.length > 0 ? 1 : 0) - (a.holds.length > 0 ? 1 : 0)
    || Number(b.needs_attention) - Number(a.needs_attention)
    || a.agent.name.localeCompare(b.agent.name));
}

export function matchesProject(entry: AgentApprovals, projectId: number | null): boolean {
  if (projectId === null) return true;
  return entry.agent.project_id === projectId || entry.workflows.some(check => check.workflow.project_id === projectId);
}

/**
 * The routing rules that send this agent work in this workflow. Every other rules filter is set
 * empty so a filter saved on the routing page can't hide them.
 */
export function routingRulesHref(workflowId: number, agentId: number): string {
  const params = new URLSearchParams({
    tab: 'rules',
    workflow_id: String(workflowId),
    rules_agent: String(agentId),
    rules_enabled: 'enabled',
    rules_task_type: '',
    rules_status: '',
    rules_priority: '',
  });
  return `/routing?${params.toString()}`;
}
