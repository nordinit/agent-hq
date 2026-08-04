export interface ClaudeCodeRuntimeConfig {
  workingDirectory: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  allowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPromptSuffix?: string;
}

export interface HermesRuntimeConfig {
  hermesBin?: string;
  profile?: string;
  provider?: string | null;
  model?: string | null;
  fastMode?: boolean | null;
  extraArgs?: string[];
  env?: Record<string, string>;
  invocationMode?: 'z' | 'chat-q';
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  passSessionId?: boolean;
}

export type AgentRuntimeConfig = ClaudeCodeRuntimeConfig | HermesRuntimeConfig | Record<string, unknown>;
export type AgentRuntimeType = 'openclaw' | 'claude-code' | 'hermes' | 'webhook' | 'veri';

export interface Agent {
  id: number;
  name: string;
  role: string;
  system_role: string | null;
  session_key: string;
  workspace_path: string;
  /**
   * repo_path — effective repository path resolved for this agent.
   * Workflow repo configuration is the dispatch source of truth; agent fields are legacy compatibility.
   */
  repo_path: string | null;
  /** repo_url — effective clone URL resolved for this agent. */
  repo_url: string | null;
  /** repo_access_mode — effective repo source mode resolved for this agent. */
  repo_access_mode: 'worktree' | 'clone' | null;
  /** repo_config_source — canonical source of the effective repo config. */
  repo_config_source?: 'workflow' | 'agent_legacy' | null;
  legacy_repo_path?: string | null;
  legacy_repo_url?: string | null;
  legacy_repo_access_mode?: 'worktree' | 'clone' | null;
  openclaw_agent_id: string | null;
  status: 'idle' | 'running' | 'blocked';
  model: string | null;
  /**
   * Remote Gateway URL. Serialized as hooks_url for compatibility with existing
   * stored agent records.
   */
  hooks_url: string | null;
  last_active: string | null;
  created_at: string;
  runtime_type: AgentRuntimeType;
  runtime_config: AgentRuntimeConfig | null;
  preferred_provider: string | null;
  provider_connection_id: number | null;

  project_id: number | null;
  project_name: string | null;
  schedule: string | null;
  dispatch_mode?: 'agentTurn' | 'systemEvent' | null;
  job_instructions: string | null;
  skill_name: string | null;
  skill_names: string[];
  enabled: number | null;
  timeout_seconds: number | null;
  startup_grace_seconds: number | null;
  heartbeat_stale_seconds: number | null;
  /** FK to github_identities — per-agent or shared GitHub credential (T#613). */
  github_identity_id: number | null;
}

export interface DeleteAgentResponse {
  ok: boolean;
  deleted?: boolean;
  hard_deleted?: boolean;
  archived?: boolean;
  message?: string;
  dependency_counts?: Record<string, number>;
}

export interface AgentMcpPermissionCapability {
  key: string;
  group: string;
  label: string;
  description: string;
  endpoints: string[];
  enabled: boolean;
  default_enabled: boolean;
  explicit_enabled: boolean | null;
}

export interface AgentMcpPermissionPolicy {
  agent_id: number;
  agent_name: string;
  agent_slug: string;
  policy_mode: 'default' | 'explicit';
  default_policy: 'scoped_runtime' | 'trusted_admin';
  updated_at: string | null;
  capabilities: AgentMcpPermissionCapability[];
}

export interface AgentMcpServerToolAllowlist {
  mcp_server_id: number;
  server_name: string | null;
  server_slug: string | null;
  enabled: boolean;
  /** Empty means every tool on the server is permitted. */
  tool_allowlist: string[];
  unrestricted: boolean;
}

export interface AgentMcpToolAllowlistPolicy {
  agent_id: number;
  servers: AgentMcpServerToolAllowlist[];
}

export interface JobInstance {
  id: number;
  template_id: number;
  agent_id: number;
  project_id?: number | null;
  task_id?: number | null;
  task_title?: string | null;
  task_status?: string | null;
  job_title?: string;
  agent_name?: string;
  agent_session_key?: string;
  status: 'queued' | 'dispatched' | 'running' | 'done' | 'failed';
  /** Internal execution status may still contain dispatched, but operator-facing UI should collapse it into queued/starting views. */
  dispatched_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  runtime_ended_at?: string | null;
  runtime_completed_at?: string | null;
  runtime_end_success?: number | null;
  runtime_end_error?: string | null;
  runtime_end_source?: string | null;
  lifecycle_handoff_status?: 'posted' | 'missing' | 'reconciled' | null;
  semantic_outcome_missing?: number | null;
  lifecycle_outcome_posted_at?: string | null;
  payload_sent: string | null;
  response: string | null;
  error: string | null;
  token_input?: number | null;
  token_output?: number | null;
  token_total?: number | null;
  created_at: string;
  session_key: string | null;
  current_stage?: 'dispatch' | 'start' | 'heartbeat' | 'progress' | 'blocker' | 'completion' | null;
  last_agent_heartbeat_at?: string | null;
  last_meaningful_output_at?: string | null;
  latest_commit_hash?: string | null;
  branch_name?: string | null;
  changed_files_json?: string | null;
  changed_files_count?: number | null;
  artifact_summary?: string | null;
  blocker_reason?: string | null;
  artifact_outcome?: string | null;
  run_is_stale?: number | null;
  stale_at?: string | null;
  /** Task workflow outcome — distinct from execution status and configured by sprint workflow metadata. */
  task_outcome?: string | null;
  /** Model that was selected / used for this run (e.g. anthropic/claude-sonnet-4-6) */
  effective_model?: string | null;
  /** Fast mode selected for this run: 1 true, 0 false, null uses runtime default. */
  effective_fast_mode?: number | boolean | null;
}

export interface SkillEntry {
  id: number | null;                         // null for system-only skills
  name: string;
  source: 'atlas' | 'workspace' | 'system';
  description: string;
  files: string[];
  created_at: string | null;
  updated_at: string | null;
}

export interface SkillDetail {
  id: number | null;
  name: string;
  content: string;
  source: 'atlas' | 'workspace' | 'system';
  description: string;
  fs_path: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface Tool {
  id: number;
  name: string;
  slug: string;
  description: string;
  implementation_type: 'bash' | 'mcp' | 'function';
  implementation_body: string;
  input_schema: string; // JSON string
  permissions: string;
  tags: string; // JSON string array
  enabled: number; // 0 | 1
  created_at: string;
  updated_at: string;
}

/** @alias Tool — for backward compat with capability pages using ToolEntry */
export type ToolEntry = Tool;

export interface AgentToolAssignment {
  /** Join-table row id for this assignment. Metadata only, never pass this to DELETE. */
  assignment_id: number;
  /** Agent id owning the assignment. */
  agent_id: number;
  /** Canonical tool id for assigned-tool checks and DELETE /agents/:agentId/tools/:toolId. */
  tool_id: number;
  overrides: string; // JSON
  assignment_enabled: number;
  // Tool fields joined for a consistent agent-tool assignment contract.
  // `tool_id` is the canonical identifier used by the UI contract.
  // `id` mirrors the same tool id for backward compatibility with older consumers.
  id: number;
  name: string;
  slug: string;
  description: string;
  implementation_type: 'bash' | 'mcp' | 'function';
  permissions: string;
  tags: string;
  enabled: number;
}

export interface McpServer {
  id: number;
  name: string;
  slug: string;
  description: string;
  transport: 'stdio';
  command: string;
  args: string;
  env: string;
  cwd: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface AgentMcpAssignment {
  assignment_id: number;
  agent_id: number;
  mcp_server_id: number;
  overrides: string;
  assignment_enabled: number;
  id: number;
  name: string;
  slug: string;
  description: string;
  transport: 'stdio';
  command: string;
  args: string;
  env: string;
  cwd: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface LogEntry {
  id: number;
  instance_id: number | null;
  agent_id: number | null;
  agent_name?: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  created_at: string;
}

export interface LogParams {
  agent_id?: number;
  level?: string;
  from?: string;
  to?: string;
  limit?: number;
  instance_id?: number;
}

export interface AgentDoc {
  filename: string;
  content: string | null;
  exists: boolean;
}

export interface ProvisionResult {
  ok: boolean;
  provisioned?: boolean;
  session_key: string;
  workspace_path: string;
  workspace?: string;
  message?: string;
}

export interface GatewayRestartResponse {
  ok: boolean;
  message?: string;
  output?: string | null;
  error?: string;
  pairing_approved?: boolean;
  pairing_message?: string | null;
}

export type GatewayRuntimeHint = 'powershell' | 'wsl' | 'macos' | 'linux' | 'external';

export interface GatewayConfig {
  ok: boolean;
  ws_url: string;
  http_url: string;
  runtime_hint: GatewayRuntimeHint;
  auth_token?: string;
  auth_token_configured?: boolean;
  auth_token_source?: 'stored' | 'local' | 'none';
  source?: 'stored' | 'default';
  error?: string | null;
}

export interface GatewayStatus extends GatewayConfig {
  state: 'ready' | 'offline' | 'pairing_required' | 'auth_error' | 'timeout';
  reachable: boolean;
  pairing_required: boolean;
  checked_at: string;
  error: string | null;
}

export interface GatewayPairResponse extends GatewayStatus {
  auto_pair_supported: boolean;
  manual_required: boolean;
  pairing_approved: boolean;
  message: string | null;
}

export type StarterTemplateKey = 'development' | 'ops' | 'lead-generation' | 'blank';

export type StarterOwnerRole =
  | 'implementation'
  | 'review'
  | 'release'
  | 'pm'
  | 'ops'
  | 'research'
  | 'outreach'
  | 'approval';

export interface StarterTemplateCatalogEntry {
  key: StarterTemplateKey;
  label: string;
  description: string;
  fully_implemented: boolean;
  owner_roles: StarterOwnerRole[];
  workflow_type: 'dev' | 'ops' | 'lead_generation' | 'generic';
}

export interface StarterPlanInput {
  template_key?: StarterTemplateKey;
  template_keys?: StarterTemplateKey[];
  project_name?: string;
  workflow_name?: string;
  workflow_names?: Record<string, string>;
  owners?: Partial<Record<StarterOwnerRole, string>>;
  routing_plan?: StarterRoutePlan[];
}

export interface StarterAgentPlan {
  owner_role: StarterOwnerRole;
  owner_name: string;
  name: string;
  job_title: string;
  role: string;
  runtime_type: 'openclaw';
  preferred_provider: string;
  model: string | null;
  skill_names: string[];
}

export interface StarterRoutePlan {
  key: string;
  template_key: StarterTemplateKey;
  task_type: string;
  status: string;
  owner_role: StarterOwnerRole;
  owner_name: string;
  enabled: boolean;
  priority: number;
}

export interface StarterModelRoutingPlan {
  label: string;
  max_points: number;
  provider: string;
  model: string;
  thinking_level: string | null;
  fast_mode: boolean | null;
  enabled: boolean;
}

export interface StarterWorkflowPlan {
  template: StarterTemplateCatalogEntry;
  workflow: { name: string; sprint_type: string; goal: string };
  statuses: string[];
  task_types: string[];
  fields: Array<{ key: string; label?: string; type?: string; required?: boolean; options?: string[] }>;
  routes: StarterRoutePlan[];
  model_routing: StarterModelRoutingPlan[];
  verification: {
    evidence_gates: string[];
    sample_route_checks: Array<{ task_type: string; status: string; expected_owner_role: StarterOwnerRole }>;
  };
}

export interface StarterSetupPlan {
  template: StarterTemplateCatalogEntry;
  templates: StarterTemplateCatalogEntry[];
  project: { name: string; description: string };
  workflow: { name: string; sprint_type: string; goal: string };
  workflows: StarterWorkflowPlan[];
  agents: StarterAgentPlan[];
  routes: StarterRoutePlan[];
  model_routing: StarterModelRoutingPlan[];
  compatibility: {
    ok: boolean;
    runtime: string | null;
    provider: string | null;
    errors: string[];
    warnings: string[];
  };
  preview: {
    changes: Array<{ action: 'create' | 'update' | 'skip'; resource: string; name: string; reason: string }>;
  };
  editable: {
    can_change_owner: boolean;
    can_disable_route: boolean;
    can_add_task_type: boolean;
    advanced_path: string;
  };
}

export interface StarterTemplateCatalogResponse {
  templates: StarterTemplateCatalogEntry[];
}

export interface StarterPlanPreviewResponse {
  ok: true;
  plan: StarterSetupPlan;
}

export interface StarterPlanApplyResponse {
  ok: true;
  plan: StarterSetupPlan;
  project_id: number;
  workflow_id: number;
  workflow_ids: Record<string, number>;
  agent_ids: Record<string, number>;
  route_ids: number[];
  model_routing_ids: number[];
}

export interface RuntimeConfigResponse {
  ok: boolean;
  configured: boolean;
  runtime?: {
    kind: 'openclaw' | 'hermes' | 'custom';
    endpoint: string;
    auth_present: boolean;
    label: string | null;
  };
  status?: Record<string, unknown>;
}

export interface ClaudeMdResult {
  exists: boolean;
  content: string | null;
  path: string | null;
  last_modified: string | null; // ISO timestamp
}

export interface ProvisionStatus {
  provisioned: boolean;
  session_key: string | null;
  workspace_path: string | null;
}

export interface CompletedRecentTask {
  id: number;
  title: string;
  status: string;
  priority: string;
  project_id: number | null;
  project_name: string | null;
  sprint_name: string | null;
  agent_name: string | null;
  custom_fields?: Record<string, unknown> | null;
  updated_at: string;
  completed_at: string | null;
  outcome: string | null;
}

export interface CompletedRecentResponse {
  hours: number;
  count: number;
  tasks: CompletedRecentTask[];
}

export interface DashboardStats {
  totalAgents: number;
  activeJobs: number;
  runningJobs: number;
  pendingJobs: number;
  recentRuns: number;
  failedRecent: number;
  doneRecent: number;
  enabledTemplates: number;
  tokensLast24h: number;
  todayTokenUsage: number;
  recentFailed: JobInstance[];
}

export interface Project {
  id: number;
  name: string;
  description: string;
  context_md: string;
  repo_path: string | null;
  repo_url: string | null;
  repo_access_mode: 'worktree' | 'clone' | null;
  created_at: string;
  is_default?: number | boolean;
}

export interface ProjectImportWarning {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  section?: string;
  ref?: string;
}

export interface ProjectImportPreview {
  valid: boolean;
  schema_version: string | null;
  source_project: { id: number | string | null; name: string | null };
  proposed_project_name: string;
  counts: {
    agents: number;
    workflows: number;
    routing_rules: number;
    routing_config?: number;
    workflow_transitions?: number;
    transition_requirements?: number;
    task_routing_rules?: number;
    model_routing?: number;
    workflow_event_mappings?: number;
    recurring_templates: number;
    files: number;
    unresolved_dependencies: number;
  };
  warnings: ProjectImportWarning[];
}

export interface ProjectImportResult {
  ok: boolean;
  project: Project;
  project_id: number;
  preview: ProjectImportPreview;
  id_map: { agents: Record<string, number>; workflows: Record<string, number> };
}

export interface Tenant {
  id: number;
  name: string;
  slug: string;
  is_default: number | boolean;
  is_active?: number | boolean;
  project_count?: number;
  task_count?: number;
  agent_count?: number;
  created_at: string;
  updated_at: string;
}

export interface TenantListResponse {
  tenants: Tenant[];
  active_tenant_id: number;
}

export interface TenantMutationResponse {
  tenant: Tenant;
  active_tenant_id: number;
}

export interface TenantDeleteResponse {
  ok: boolean;
  deleted_tenant: Tenant;
  active_tenant_id: number;
  active_tenant_changed: boolean;
  deletion_semantics: 'hard_delete_tenant_owned_records';
  deleted_counts: Record<string, number>;
  tenants: Tenant[];
}

export interface ProjectAuditEntry {
  id: number;
  project_id: number;
  entity_type: 'project' | 'sprint' | 'agent';
  entity_id: number;
  action: 'created' | 'updated' | 'deleted';
  actor: string;
  changes: Record<string, unknown>;
  created_at: string;
}

export interface ProjectFile {
  id: number;
  tenant_id?: number;
  project_id?: number;
  workflow_id?: number;
  scope?: 'project' | 'workflow';
  filename: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  uploaded_by: string;
  updated_at: string;
  updated_by: string;
  current_version: number;
  current_version_id: number | null;
}

export interface WorkflowFile extends ProjectFile {
  tenant_id: number;
  project_id: number;
  workflow_id: number;
  scope: 'workflow';
}

export interface ProjectFileVersion {
  id: number;
  tenant_id: number;
  project_id: number;
  workflow_id?: number;
  scope?: 'project' | 'workflow';
  file_id: number;
  version_number: number;
  filename: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  created_by: string;
  created_at: string;
  change_source: string;
}

export interface WorkflowFileVersion extends ProjectFileVersion {
  workflow_id: number;
  scope: 'workflow';
}

export interface ArtifactTreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: ArtifactTreeNode[];
  size?: number;
  modified?: string;
}

export interface ArtifactTree {
  root: string;
  children: ArtifactTreeNode[];
}

export interface ArtifactFile {
  path: string;
  content: string | null;
  size: number;
  modified: string;
  binary: boolean;
}

export type TaskStatus = string;

export interface SprintRelationshipTypeInput {
  key: string;
  label: string;
  inverse_label?: string;
  category?: string;
  affects_dispatch_eligibility?: number;
  direction_semantics?: 'target_blocks_source' | 'source_blocks_target' | 'informational';
  active_statuses?: string[];
  resolved_statuses?: string[];
  allow_create_related_task?: number;
  default_related_task_type?: string | null;
  default_related_task_status?: string | null;
}

export interface TaskRelationshipTypeConfig {
  id: number;
  sprint_type_key: string;
  key: string;
  label: string;
  inverse_label: string;
  category: string;
  affects_dispatch_eligibility: number;
  direction_semantics: 'target_blocks_source' | 'source_blocks_target' | 'informational';
  active_statuses: string[];
  resolved_statuses: string[];
  allow_create_related_task: number;
  default_related_task_type: string | null;
  default_related_task_status: string | null;
  is_system: number;
  metadata: Record<string, unknown>;
}

export interface TaskRelationshipTaskRef {
  id: number;
  title: string;
  status: string;
  sprint_id?: number | null;
  task_type?: string | null;
}

export interface TaskRelationship {
  id: number;
  source_task_id: number;
  target_task_id: number;
  relationship_type_key: string;
  metadata: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
  type: TaskRelationshipTypeConfig | null;
  source_task?: TaskRelationshipTaskRef | null;
  target_task?: TaskRelationshipTaskRef | null;
}

export type CreateTaskPayload = Omit<Partial<Task>, 'relationships'> & {
  relationships?: Array<{
    target_task_id: number;
    relationship_type_key: string;
    metadata?: Record<string, unknown>;
  }>;
};

export interface Task {
  id: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: 'low' | 'medium' | 'high';
  agent_id?: number | null;
  assigned_agent_id?: number | null;
  assigned_agent_name?: string | null;
  active_agent_name?: string | null;
  project_id: number | null;
  sprint_id: number | null;
  sprint_name?: string | null;
  agent_name?: string;
  recurring?: number | boolean;
  recurring_series_id?: number | null;
  scheduled_for?: string | null;
  schedule_run_id?: number | null;
  generated_from?: 'recurring_task_series' | string | null;
  story_points?: number | null;
  branch_url?: string | null;
  active_instance_id?: number | null;
  active_instance_status?: string | null;
  active_instance_session_key?: string | null;
  active_instance_created_at?: string | null;
  active_instance_dispatched_at?: string | null;
  active_instance_started_at?: string | null;
  active_instance_completed_at?: string | null;
  active_instance_runtime_ended_at?: string | null;
  active_instance_runtime_end_success?: number | null;
  active_instance_runtime_end_error?: string | null;
  active_instance_runtime_end_source?: string | null;
  active_instance_lifecycle_outcome_posted_at?: string | null;
  active_instance_task_outcome?: string | null;
  latest_task_outcome?: string | null;
  latest_run_stage?: string | null;
  last_agent_heartbeat_at?: string | null;
  last_meaningful_output_at?: string | null;
  latest_commit_hash?: string | null;
  branch_name?: string | null;
  changed_files?: string[];
  changed_files_count?: number | null;
  latest_artifact_summary?: string | null;
  blocker_reason?: string | null;
  latest_run_outcome?: string | null;
  run_is_stale?: number | null;
  run_stale_at?: string | null;
  blockers?: Task[];
  blocking?: Task[];
  relationships?: TaskRelationship[];
  review_branch?: string | null;
  review_commit?: string | null;
  review_url?: string | null;
  qa_verified_commit?: string | null;
  qa_tested_url?: string | null;
  merged_commit?: string | null;
  deployed_commit?: string | null;
  deployed_at?: string | null;
  live_verified_at?: string | null;
  live_verified_by?: string | null;
  deploy_target?: string | null;
  evidence_json?: string | null;
  failure_detail?: string | null;
  previous_status?: string | null;
  review_owner_agent_id?: number | null;
  integrity_state?: 'clean' | 'missing_review_evidence' | 'missing_qa_evidence' | 'missing_deploy_evidence' | 'missing_live_verification' | 'invalid_done_state';
  integrity_warnings?: string[];
  release_state_badge?: 'review build' | 'qa passed' | 'ready to merge' | 'live deployed' | 'live verified' | null;
  release_state_label?: string | null;
  is_legacy_unverified_done?: boolean;
  task_type?: string | null;
  routing_reason?: string | null;
  origin_task_id?: number | null;
  origin_task_title?: string | null;
  defect_type?: string | null;
  spawned_defects?: number | null;
  custom_fields?: Record<string, unknown> | null;
  resolved_sprint_type?: string | null;
  resolved_custom_field_schema?: {
    fields?: CustomFieldDefinition[];
  } | null;
  paused_at?: string | null;
  pause_reason?: string | null;
  created_at: string;
  updated_at: string;
}

export type RecurringTaskOverlapPolicy = 'skip_if_active' | 'create_anyway';
export type RecurringTaskRunStatus = 'started' | 'created' | 'skipped' | 'failed';

export interface RecurringTaskSeries {
  id: number;
  project_id: number;
  project_name: string | null;
  sprint_id: number;
  sprint_name: string | null;
  sprint_status: string | null;
  sprint_type: string | null;
  workflow_id?: number;
  workflow_name?: string | null;
  workflow_status?: string | null;
  workflow_type?: string | null;
  title_template: string;
  description_template: string;
  task_type: string;
  priority: 'low' | 'medium' | 'high';
  story_points: number;
  status_on_create: string;
  schedule_expression: string;
  schedule: string;
  timezone: string;
  enabled: number | boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  overlap_policy: RecurringTaskOverlapPolicy;
  agent_id: number | null;
  agent_name: string | null;
  latest_run_id: number | null;
  latest_run_status: RecurringTaskRunStatus | null;
  latest_run_scheduled_for: string | null;
  latest_run_created_task_id: number | null;
  generated_task_count?: number;
  created_at: string;
  updated_at: string;
}

export interface RecurringTaskSeriesInput {
  project_id: number;
  workflow_id: number;
  sprint_id?: number;
  title_template: string;
  description_template?: string;
  task_type: string;
  priority: 'low' | 'medium' | 'high';
  story_points: number;
  status_on_create: string;
  schedule_expression: string;
  timezone: string;
  enabled?: boolean | number;
  overlap_policy: RecurringTaskOverlapPolicy;
  agent_id?: number | null;
  changed_by?: string;
}

export interface RecurringTaskRun {
  id: number;
  series_id: number;
  scheduled_for: string;
  created_task_id: number | null;
  status: RecurringTaskRunStatus;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  generated_task?: {
    id: number;
    title: string | null;
    status: string | null;
    url: string;
  } | null;
}

export interface RecurringTaskSeriesListResponse {
  series: RecurringTaskSeries[];
  total: number;
  limit: number;
  offset: number;
}

export interface RecurringTaskSeriesDetail extends RecurringTaskSeries {
  runs: RecurringTaskRun[];
}

export interface RecurringTaskRunNowResponse {
  series: RecurringTaskSeries;
  run: RecurringTaskRun;
  task: Task & { url?: string };
}

export interface TaskNote {
  id: number;
  task_id: number;
  author: string;
  content: string;
  created_at: string;
}


export interface CustomFieldDefinition {
  key: string;
  label?: string;
  type?: string;
  required?: boolean;
  options?: string[];
  help_text?: string;
  system?: boolean;
}

export interface ResolvedTaskFieldSchemaResponse {
  sprint_type: string;
  allowed_task_types: string[];
  fields: CustomFieldDefinition[];
  schema?: TaskFieldSchemaDocument;
}

export interface TaskAttachment {
  id: number;
  task_id: number;
  filename: string;
  filepath: string;
  mime_type: string;
  size: number;
  uploaded_by: string;
  created_at: string;
}

export interface TaskHistory {
  id: number;
  task_id: number;
  changed_by: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

export type ChatEventType = 'text' | 'thought' | 'tool_call' | 'tool_result' | 'turn_start' | 'system' | 'error';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  event_type?: ChatEventType;
  meta?: Record<string, unknown>;
}

export interface ChatConfig {
  gatewayUrl: string;
  token: string;
}

export interface ChatSession {
  instance_id: number | null;
  session_key: string;
  agent_id: number;
  agent_name: string | null;
  task_id?: number | null;
  status?: CanonicalSessionStatus;
  run_status?: JobInstance['status'] | null;
  runtime_end_success?: number | null;
  runtime_end_error?: string | null;
  runtime_end_source?: string | null;
  runtime_ended_at?: string | null;
  lifecycle_outcome_posted_at?: string | null;
  project_id: number | null;
  project_name: string | null;
  project_slug: string | null;
  project_source: 'task' | 'none';
  message_count: number;
  started_at: string;
  last_activity: string;
  last_message: string | null;
  last_role: 'user' | 'assistant' | 'system' | 'tool' | null;
}

// ─── Canonical Sessions ───────────────────────────────────────────────────────

export type CanonicalSessionStatus = 'active' | 'completed' | 'failed' | 'abandoned';

export interface CanonicalSession {
  id: number;
  external_key: string;
  runtime: string;
  agent_id: number | null;
  task_id: number | null;
  instance_id: number | null;
  project_id: number | null;
  status: CanonicalSessionStatus;
  title: string;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  token_input: number | null;
  token_output: number | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
  // Joined fields
  agent_name?: string | null;
  task_title?: string | null;
  project_name?: string | null;
}

export interface CanonicalMessage {
  id: number;
  session_id: number;
  ordinal: number;
  role: 'user' | 'assistant' | 'system';
  event_type: ChatEventType;
  content: string;
  event_meta: string; // JSON string
  raw_payload: string | null;
  timestamp: string;
  created_at: string;
}

export interface CanonicalSessionMessagesResponse {
  session: CanonicalSession;
  messages: CanonicalMessage[];
  total: number;
  in_progress: boolean;
}

export interface SprintTypeDeletionState {
  protected: boolean;
  reason: 'generic' | 'open_sprints' | null;
  open_sprint_count: number;
  total_sprint_count: number;
}

export interface SprintType {
  key: string;
  name: string;
  description: string;
  is_system: number;
  created_at: string;
  updated_at: string;
}

export interface SprintTypeTaskType {
  id: number;
  sprint_type_key: string;
  task_type: string | null;
  is_system: number;
  created_at: string;
  updated_at: string;
}

export interface TaskFieldSchemaDocument {
  fields: CustomFieldDefinition[];
}

export interface TaskFieldSchema {
  id: number;
  sprint_type_key: string;
  task_type: string | null;
  schema: TaskFieldSchemaDocument;
  is_system: number;
  created_at: string;
  updated_at: string;
}

export interface SprintTypeOutcome {
  id: number;
  sprint_type_key: string;
  task_type: string | null;
  outcome_key: string;
  label: string;
  description: string;
  enabled: number;
  behavior: 'base' | 'extend' | 'override' | 'disable';
  badge_variant: string | null;
  stage_order: number;
  is_system: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ResolvedSprintOutcome extends Omit<SprintTypeOutcome, 'id' | 'created_at' | 'updated_at'> {
  id?: number;
  source?: 'configured' | 'fallback';
  created_at?: string;
  updated_at?: string;
}

export interface McpCatalogArg {
  name: string;
  required: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface McpCatalogTool {
  canonical_name: string;
  aliases: string[];
  description: string;
  args: McpCatalogArg[];
  domain: string;
  rest_paths?: string[];
}

export interface McpCatalogResource {
  id: string;
  uri: string;
  description: string;
}

export interface McpCatalog {
  server: {
    name: string;
    version: string;
    transport: string;
    discoverability: {
      catalog_endpoint: string;
      health_endpoint: string;
      notes: string[];
    };
  };
  domains: string[];
  enums: Record<string, unknown>;
  resources: McpCatalogResource[];
  tools: McpCatalogTool[];
}

export interface ResolvedSprintOutcomes {
  base: ResolvedSprintOutcome[];
  by_task_type: Record<string, ResolvedSprintOutcome[]>;
}

export interface SprintOutcomesResponse {
  outcomes: SprintTypeOutcome[];
  resolved_outcomes: ResolvedSprintOutcomes | null;
}

export interface SprintTypeConfig extends SprintType {
  deletion?: SprintTypeDeletionState;
  task_types: SprintTypeTaskType[];
  statuses?: TaskStatusMeta[];
  field_schemas: TaskFieldSchema[];
  outcomes: SprintTypeOutcome[];
  resolved_outcomes: ResolvedSprintOutcomes | null;
  relationship_types?: TaskRelationshipTypeConfig[];
}

export interface WorkflowConfigResponse {
  sprint_types: SprintTypeConfig[];
}

export interface Sprint {
  id: number;
  project_id: number;
  project_name?: string;
  name: string;
  goal: string;
  sprint_type: string;
  status: 'planning' | 'active' | 'paused' | 'complete' | 'closed';
  length_kind: 'time' | 'runs';
  length_value: string;
  started_at: string | null;
  ended_at: string | null;
  repo_path: string | null;
  repo_url: string | null;
  repo_access_mode: 'worktree' | 'clone' | null;
  created_at: string;
  task_count?: number;
  tasks_done?: number;
  total_story_points?: number;
  done_story_points?: number;
  remaining_story_points?: number;
}

export interface CreateSprintInput {
  project_id: number;
  name: string;
  goal?: string;
  sprint_type?: string;
  source_sprint_id?: number;
  status?: Sprint['status'];
  length_kind?: Sprint['length_kind'];
  length_value?: string;
  started_at?: string | null;
  repo_path?: string | null;
  repo_url?: string | null;
  repo_access_mode?: Sprint['repo_access_mode'];
}

export interface SprintAssignment extends Sprint {
  assignment_kind: 'primary' | 'attached';
  is_primary_sprint: number;
}

export interface SprintMetrics {
  sprint_id: number;
  tasks_total: number;
  tasks_done: number;
  completion_rate: number;
  total_story_points: number;
  done_story_points: number;
  remaining_story_points: number;
  job_runs_total: number;
  job_runs_success: number;
  job_runs_failed: number;
  success_rate: number;
  blocker_count: number;
  avg_task_duration_ms: number;
}

export interface ProjectMetrics extends SprintMetrics {
  project_id: number;
  sprint_count: number;
}

export interface TaskStatusMeta {
  name: string;
  label: string;
  emoji?: string | null;
  color: string;
  terminal: boolean;
  is_system: boolean;
  allowed_transitions: string[];
  stage_order?: number;
  is_default_entry?: boolean;
  metadata?: Record<string, unknown>;
}

export interface WorkflowTaskTypeMeta {
  value: string;
  label: string;
  is_system: boolean;
}

export interface WorkflowTransitionMeta {
  from_status: string;
  to_status: string;
  transition_key: string;
  label: string;
  outcome: string | null;
  stage_order: number;
  is_system: boolean;
  metadata: Record<string, unknown>;
}

export interface SystemPolicy {
  id: number;
  policy_key: string;
  from_status: string;
  to_status: string;
  trigger_event: string;
  classification: 'protected_system' | 'configurable' | 'deprecated' | string;
  enabled: number;
  threshold_seconds: number | null;
  description: string;
  source_file: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRoutingWarning {
  kind: 'routed_status_missing_external_event_or_outcome_transitions';
  sprint_id: number;
  sprint_type: string;
  status: string;
  status_label: string;
  task_types: string[];
  routing_rule_ids: number[];
  transition_task_types: string[];
  external_event_names: string[];
  message: string;
}

export interface WorkflowOutcomeMeta {
  id?: number;
  sprint_type_key: string;
  task_type: string | null;
  outcome_key: string;
  label: string;
  description: string;
  enabled: number;
  behavior: 'base' | 'extend' | 'override' | 'disable';
  badge_variant: string | null;
  stage_order: number;
  is_system: number;
  metadata: Record<string, unknown>;
}

export interface WorkflowMetadataResponse {
  sprint_id: number | null;
  sprint_type: string;
  task_type: string | null;
  task_types: WorkflowTaskTypeMeta[];
  statuses: TaskStatusMeta[];
  transitions: WorkflowTransitionMeta[];
  outcomes: WorkflowOutcomeMeta[];
  relationship_types: TaskRelationshipTypeConfig[];
  non_failure_outcomes: string[];
  routing_warnings: WorkflowRoutingWarning[];
}

export interface RoutingConfig {
  id: number;
  agent_id?: number | null;
  agent_name?: string | null;
  project_id: number | null;
  from_status: string;
  outcome: string;
  to_status: string;
  enabled: number;
  stall_threshold_min?: number;
  max_retries?: number;
  sort_rules?: string[];
  created_at: string;
  [key: string]: any;
}

export interface ReconcilerConfig {
  needs_attention_eligible_statuses: string[];
}

export interface RoutingTransition {
  id: number;
  project_id: number | null;
  project_name?: string | null;
  sprint_id?: number | null;
  sprint_name?: string | null;
  sprint_type?: string | null;
  task_type?: string | null;
  from_status: string;
  outcome: string;
  to_status: string;
  enabled: number;
  priority?: number;
  scope_kind?: 'sprint_type_default' | 'default_scope' | 'sprint_override';
  is_inherited?: boolean;
  is_override?: boolean;
  overridden_by_sprint?: boolean;
  effective_for_sprint?: boolean;
  /** Legacy compatibility field. Transition rows remain operator-configurable even if older data still carries this flag. */
  is_protected?: number;
}

export interface TaskRoutingRule {
  id: number;
  project_id?: number;
  project_name?: string | null;
  sprint_id?: number | null;
  sprint_name?: string | null;
  sprint_type?: string | null;
  task_type: string | null;
  status: string;
  agent_id: number;
  agent_name?: string | null;
  enabled: number;
  priority: number;
  scope_kind?: 'sprint_type_default' | 'sprint_override';
  is_inherited?: boolean;
  is_override?: boolean;
  overridden_by_sprint?: boolean;
  effective_for_sprint?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface TransitionRequirement {
  id: number;
  sprint_id?: number | null;
  sprint_name?: string | null;
  sprint_type?: string | null;
  project_id?: number | null;
  task_type: string | null;
  outcome: string;
  field_name: string;
  requirement_type: 'required' | 'match' | 'from_status';
  match_field: string | null;
  severity: 'block' | 'warn';
  message: string;
  enabled: number;
  priority: number;
  scope_kind?: 'sprint_type_default' | 'default_scope' | 'sprint_override';
  is_inherited?: boolean;
  is_override?: boolean;
  overridden_by_sprint?: boolean;
  effective_for_sprint?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface RoutingScopeInfo {
  project_id: number;
  sprint_type: string;
  sprint_id: number | null;
}

export interface WorkflowEventMapping {
  id: number;
  project_id: number | null;
  sprint_id?: number | null;
  sprint_type?: string | null;
  scope_kind?: 'sprint_type_default' | 'default_scope' | 'sprint_override';
  is_inherited?: boolean;
  is_override?: boolean;
  source: string | null;
  event_model?: 'workflow_event';
  source_kind?: 'agent_hq_internal' | 'external_integration' | 'wildcard_compatibility';
  source_label?: string;
  event_name: string;
  task_type: string | null;
  status_includes: string[];
  status_excludes: string[];
  action_kind: 'ignore' | 'outcome' | 'status';
  action_target: string | null;
  apply_review_evidence: number;
  apply_failure_detail: number;
  enabled: number;
  priority: number;
  conflicts_with?: number[];
  created_at?: string;
  updated_at?: string;
}

export type ExternalEventMapping = WorkflowEventMapping;

export interface TransitionRequirementFieldsResponse {
  sprint_type: string;
  task_type: string | null;
  fields: CustomFieldDefinition[];
  field_names: string[];
}

export interface SetupStatus {
  hasProjects: boolean;
  hasAgents: boolean;
  has_atlas_agent?: boolean;
  onboarding_completed?: boolean;
  onboarding_provider_gate_passed?: boolean;
  connected_provider_count?: number;
}

// ─── Provider types ───────────────────────────────────────────────────────────

export type ProviderSlug = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'ollama' | 'openai-codex' | 'mlx-studio' | 'minimax';

export interface ProviderRecord {
  id: number;
  slug: ProviderSlug;
  display_name: string;
  status: 'pending' | 'connected' | 'failed' | 'untested';
  config: Record<string, unknown>;
  last_validated_at: string | null;
  validation_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderListResponse {
  providers: ProviderRecord[];
  onboarding_provider_gate_passed: boolean;
  connected_count: number;
}

export interface ProviderConnectionRecord {
  id: number;
  provider_slug: string;
  auth_mode: string;
  runtime_type: string;
  external_ref: string;
  display_name: string;
  status: 'pending' | 'connected' | 'failed';
  metadata: Record<string, unknown>;
  last_validated_at: string | null;
  validation_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface RuntimeProviderCapability {
  runtime: string;
  provider: string;
  authModes: string[];
  supportsProfiles: boolean;
  supportsInteractiveLogin: boolean;
  supportsHeadlessLogin: boolean;
}

export interface DiscoveredProviderConnection {
  externalRef: string;
  displayName: string;
  metadata: Record<string, unknown>;
}

export interface ProviderSaveResponse extends ProviderRecord {
  validation: { ok: boolean; error: string | null };
  onboarding_provider_gate_passed: boolean;
}

export interface ProviderGateResponse {
  onboarding_provider_gate_passed: boolean;
  connected_count: number;
}

// ── Workflow routing graph ────────────────────────────────────────────────────
// Mirrors api/src/domains/routing/graph.ts. The server derives the state machine
// once so the canvas and Atlas cannot drift apart; keep these in sync with it.

export type WorkflowGraphLintSeverity = 'error' | 'warn' | 'info';

export interface WorkflowGraphLintFinding {
  code: string;
  severity: WorkflowGraphLintSeverity;
  message: string;
  node?: string;
  edge?: string;
}

export interface WorkflowGraphAssignment {
  rule_id: number;
  task_type: string | null;
  agent_id: number | null;
  agent_name: string | null;
  agent_enabled: boolean;
  priority: number;
  enabled: boolean;
  scope_kind: string;
  is_inherited: boolean;
}

export interface WorkflowGraphInboundEvent {
  mapping_id: number;
  event_name: string;
  source: string | null;
  task_type: string | null;
  /** Statuses this event can fire from, after includes/excludes are applied. */
  from: string[];
  priority: number;
}

export interface WorkflowGraphEventTrigger {
  mapping_id: number;
  event_name: string;
  source: string | null;
  task_type: string | null;
}

export interface WorkflowGraphNode {
  id: string;
  label: string;
  color: string;
  terminal: boolean;
  stage_order: number;
  is_default_entry: boolean;
  layer: number;
  assignments: WorkflowGraphAssignment[];
  inbound_events: WorkflowGraphInboundEvent[];
  inbound: number;
  outbound: number;
  lint: string[];
}

export interface WorkflowGraphGate {
  requirement_id: number;
  field_name: string;
  requirement_type: string;
  severity: string;
  message: string;
  task_type: string | null;
  enabled: boolean;
}

export interface WorkflowGraphEdge {
  id: string;
  kind: 'transition' | 'event';
  transition_id: number | null;
  mapping_id: number | null;
  from: string;
  to: string;
  outcome: string;
  task_type: string | null;
  priority: number;
  enabled: boolean;
  is_protected: boolean;
  scope_kind: string;
  is_inherited: boolean;
  parallel_group: string;
  is_back_edge: boolean;
  shadowed_by: string | null;
  gates: WorkflowGraphGate[];
  event_triggers: WorkflowGraphEventTrigger[];
  lint: string[];
}

export interface WorkflowGraph {
  scope: {
    project_id: number | null;
    workflow_type: string | null;
    workflow_id: number | null;
    task_type: string | null;
  };
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  lint: WorkflowGraphLintFinding[];
  stats: {
    node_count: number;
    edge_count: number;
    error_count: number;
    warn_count: number;
  };
}

// ── Routing traces ────────────────────────────────────────────────────────────
// Mirrors api/src/domains/routing/trace.ts. Both modes key their steps to the same
// edge ids WorkflowGraph emits, so one canvas overlay renders either.

export interface RoutingTraceGate {
  requirement_id: number;
  field_name: string;
  requirement_type: string;
  match_field: string | null;
  severity: string;
  message: string;
  task_type: string | null;
}

export interface RoutingTraceCandidate {
  edge_id: string;
  to_status: string;
  task_type: string | null;
  priority: number;
  wins: boolean;
  reason: string | null;
}

export interface HypotheticalTrace {
  scope: WorkflowGraph['scope'];
  input: { task_type: string | null; from_status: string; outcome: string };
  matched: boolean;
  result: { edge_id: string; to_status: string; to_status_label: string; is_back_edge: boolean } | null;
  candidates: RoutingTraceCandidate[];
  gates: RoutingTraceGate[];
  assignment: {
    status: string;
    agent_id: number | null;
    agent_name: string | null;
    rule_id: number | null;
    candidates: Array<{ rule_id: number; agent_id: number | null; agent_name: string | null; task_type: string | null; priority: number; wins: boolean }>;
  } | null;
  notes: string[];
}

export type TraceStepMatch = 'transition' | 'event' | 'off_graph' | 'no_current_edge';

export interface TraceStep {
  seq: number;
  event_id: number;
  from_status: string | null;
  to_status: string;
  move_type: string;
  moved_by: string;
  agent_id: number | null;
  instance_id: number | null;
  outcome: string | null;
  reason: string | null;
  created_at: string;
  edge_id: string | null;
  match: TraceStepMatch;
}

export interface HistoricalTrace {
  task: {
    id: number;
    title: string;
    status: string;
    task_type: string | null;
    project_id: number | null;
    sprint_id: number | null;
    sprint_type: string | null;
  };
  scope: WorkflowGraph['scope'];
  steps: TraceStep[];
  visits: Record<string, number>;
  drift: Array<{ seq: number; message: string }>;
  stats: {
    step_count: number;
    matched: number;
    off_graph: number;
    drifted: number;
    distinct_edges: number;
  };
}
