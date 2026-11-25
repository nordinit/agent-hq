import { apiFetch } from './http';

/** One difference between the approved setup and the current one. Secrets show only that they changed. */
export interface ProfileChange {
  path: string;
  label: string;
  change: 'added' | 'removed' | 'changed';
  before: string | null;
  after: string | null;
  note?: string;
}

/** A task Agent HQ could not start, and why. */
export interface ApprovalHold {
  task_id: number;
  task_title: string;
  reason_code: string;
  reason: string;
  last_refused_at: string;
}

/** The agent's own setup, or a workflow's repository and environment setup for this agent. */
export interface SetupCheck {
  resource_kind: 'agent_runtime' | 'workflow_setup';
  resource_id: number;
  resource_name: string;
  state: 'approved' | 'not_approved' | 'changed_since_approval';
  /** The setup Approve approves; approving fails if it changes again first. */
  digest: string | null;
  approved_revision_id: string | null;
  changes: ProfileChange[];
  /** Set when the current setup cannot be approved, for example a missing file. */
  error: string | null;
  holds: ApprovalHold[];
}

export interface WorkflowCheck extends SetupCheck {
  workflow: { id: number; name: string; project_id: number | null; project_name: string | null };
  /** The enabled routing rules that send this agent work in this workflow. */
  routes: { count: number; statuses: string[] };
}

/** Where an agent stands on each check Agent HQ makes before it starts the agent on a task. */
export interface AgentApprovals {
  agent: { id: number; name: string; project_id: number | null; project_name: string | null; runtime_type: string | null };
  host_execute: boolean;
  host_execute_holds: ApprovalHold[];
  routed: boolean;
  needs_attention: boolean;
  holds: ApprovalHold[];
  setup: SetupCheck;
  workflows: WorkflowCheck[];
}

export interface ApproveRequest {
  agent_id: number;
  grant_host_execute: boolean;
  profiles: Array<{ resource_kind: SetupCheck['resource_kind']; resource_id: number; digest: string }>;
}

export const approvalsClient = {
  getApprovals: (agentId?: number) =>
    apiFetch<{ agents: AgentApprovals[] }>(`/api/v1/execution/approvals${agentId ? `?agent_id=${agentId}` : ''}`),
  approvePending: (data: ApproveRequest) =>
    apiFetch<{ agent_id: number; approved: Array<{ resource_kind: string; resource_id: number; revision_id: string }>; host_execute_granted: boolean }>(
      '/api/v1/execution/approvals', { method: 'POST', body: JSON.stringify(data) },
    ),
};
