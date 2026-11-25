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

export interface PendingProfile {
  resource_kind: 'agent_runtime' | 'workflow_setup';
  resource_id: number;
  resource_name: string;
  state: 'not_approved' | 'changed_since_approval';
  /** The setup Approve approves; approving fails if it changes again first. */
  digest: string | null;
  approved_revision_id: string | null;
  changes: ProfileChange[];
  /** Set when the current setup cannot be approved, for example a missing file. */
  error: string | null;
}

export interface PendingApprovalAgent {
  agent: { id: number; name: string; project_id: number | null; runtime_type: string | null };
  host_execute: boolean;
  routed: boolean;
  holds: Array<{ task_id: number; task_title: string; reason_code: string; reason: string; last_refused_at: string }>;
  profiles: PendingProfile[];
}

export interface ApproveRequest {
  agent_id: number;
  grant_host_execute: boolean;
  profiles: Array<{ resource_kind: PendingProfile['resource_kind']; resource_id: number; digest: string }>;
}

export const approvalsClient = {
  getPendingApprovals: (agentId?: number) =>
    apiFetch<{ agents: PendingApprovalAgent[] }>(`/api/v1/execution/approvals${agentId ? `?agent_id=${agentId}` : ''}`),
  approvePending: (data: ApproveRequest) =>
    apiFetch<{ agent_id: number; approved: Array<{ resource_kind: string; resource_id: number; revision_id: string }>; host_execute_granted: boolean }>(
      '/api/v1/execution/approvals', { method: 'POST', body: JSON.stringify(data) },
    ),
};
