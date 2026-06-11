export interface SprintTaskStatusMeta {
  name: string;
  label: string;
  color: string;
  terminal: boolean;
  is_system: boolean;
  allowed_transitions: string[];
  emoji?: string | null;
  metadata?: Record<string, unknown>;
  stage_order?: number;
  is_default_entry?: boolean;
}

export interface SprintTaskTransitionRow {
  id: number;
  sprint_id: number | null;
  project_id?: number | null;
  sprint_type?: string | null;
  task_type: string | null;
  from_status: string;
  outcome: string;
  to_status: string;
  enabled: number;
  priority: number;
  is_protected: number;
  created_at?: string;
  updated_at?: string;
}

export interface SprintTaskTransitionRequirementRow {
  id: number;
  sprint_id: number | null;
  task_type: string | null;
  outcome: string;
  field_name: string;
  requirement_type: string;
  match_field: string | null;
  severity: string;
  message: string;
  enabled: number;
  priority: number;
  created_at?: string;
  updated_at?: string;
}

export interface SprintTaskRoutingRuleRow {
  id: number;
  sprint_id: number | null;
  task_type: string | null;
  status: string;
  agent_id: number | null;
  enabled: number;
  priority: number;
  is_system?: number;
  created_at?: string;
  updated_at?: string;
}

export type SprintSeedRow = {
  id: number;
  project_id: number | null;
  sprint_type: string | null;
  tenant_id?: number | null;
  task_policy_seeded_at?: string | null;
};

export type StarterSprintType = 'dev' | 'generic' | 'ops';

export type PolicyTransitionSeed = {
  task_type: string | null;
  from_status: string;
  outcome: string;
  to_status: string;
  enabled: number;
  priority: number;
  is_protected?: number | null;
};

export type PolicyRequirementSeed = {
  task_type: string | null;
  outcome: string;
  field_name: string;
  requirement_type: string;
  match_field: string | null;
  severity: string;
  message: string;
  enabled: number;
  priority: number;
};

export type RequirementSeedIdentity = {
  task_type: string | null;
  outcome: string;
  field_name: string;
  requirement_type: string;
  match_field: string | null;
};
