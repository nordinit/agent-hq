import { apiFetch } from './http';

export interface ResolutionSource {
  id: string;
  label: string;
  href: string;
  primary?: boolean;
}
export interface ResolutionEntry {
  id: string;
  kind: 'tool' | 'mcp' | 'skill' | 'permission';
  label: string;
  effective: boolean;
  sources: Array<{ source_id: string; state: 'active' | 'overridden' | 'opted_out' | 'disabled'; explanation: string }>;
  description?: string;
}
export interface AgentResolution {
  agent: { id: number; name: string; enabled: boolean; runtime_type: string; model: string | null };
  sources: ResolutionSource[];
  entries: ResolutionEntry[];
  context: { team_id: number | null; team_name: string | null; section: string; workflow_id: number | null };
  workflows: Array<{ id: number; name: string }>;
  routing: Array<{ status: string; task_type: string | null; rule_id: number; effective: boolean }>;
  policy_revision: string;
  policy_mode: 'default' | 'explicit';
  findings: Array<{ code: string; severity: 'warning' | 'info'; message: string; entry_id?: string }>;
}

export const getAgentResolution = (id: number, workflowId?: number | null) => apiFetch<AgentResolution>(`/api/v1/agents/${id}/resolution${workflowId ? `?workflow_id=${workflowId}` : ''}`);
