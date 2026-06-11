import type { TaskType } from './taskTypes';

export type StarterSprintTypeKey = 'generic' | 'dev' | 'ops';
export type StarterFieldDefinition = {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'url' | 'select' | 'number' | 'checkbox';
  required: boolean;
  options?: string[];
  help_text?: string;
  system?: boolean;
};
export type StarterAgentDefinition = {
  name: string;
  role: string;
  jobTitle: string;
  systemRole: string;
  workflowTypes: StarterSprintTypeKey[];
  taskTypes: string[];
  contractTypes: StarterSprintTypeKey[];
  mcpCapabilities: string[];
  mcpServerSlugs: string[];
  toolSlugs: string[];
  skillNames: string[];
  modelPolicy: {
    runtime_type: 'openclaw';
    preferred_provider: string;
    model: string | null;
  };
  requirements: string[];
  identityDocs: Record<string, string>;
};

export const STARTER_BACKLOG_SPRINT_NAME = 'Backlog';
export const STARTER_ROUTING_PRIORITY = -100;
export const DEFAULT_PROJECT_NAME = 'Default Project';
export const LEGACY_STARTER_PROJECT_NAME = 'Agent HQ';
export const STARTER_AGENT_SYSTEM_ROLE_PREFIX = 'default_package.starter_agent.';

export const STARTER_SPRINT_TYPE_SEEDS: Array<{ key: StarterSprintTypeKey; name: string; description: string }> = [
  { key: 'generic', name: 'Generic', description: 'Catch-all sprint profile for mixed delivery work and backlog management.' },
  { key: 'dev', name: 'Development', description: 'Implementation-focused sprint profile for product and software delivery work.' },
  { key: 'ops', name: 'Operations', description: 'Operational sprint profile for release, support, maintenance, and infra work.' },
];

export const DEV_LIFECYCLE_FIELD_DEFINITIONS: StarterFieldDefinition[] = [
  { key: 'review_branch', label: 'Review Branch', type: 'text', required: false },
  { key: 'review_commit', label: 'Review Commit', type: 'text', required: false },
  { key: 'review_url', label: 'Review URL', type: 'url', required: false },
  { key: 'qa_verified_commit', label: 'QA Verified Commit', type: 'text', required: false },
  { key: 'qa_tested_url', label: 'QA Tested URL', type: 'url', required: false },
  { key: 'merged_commit', label: 'Merged Commit', type: 'text', required: false },
  { key: 'deployed_commit', label: 'Deployed Commit', type: 'text', required: false },
  { key: 'deploy_target', label: 'Deploy Target', type: 'text', required: false },
  { key: 'deployed_at', label: 'Deployed At', type: 'text', required: false },
  { key: 'live_verified_by', label: 'Live Verified By', type: 'text', required: false },
  { key: 'live_verified_at', label: 'Live Verified At', type: 'text', required: false },
];

export const INLINE_EVIDENCE_FIELD_KEYS = DEV_LIFECYCLE_FIELD_DEFINITIONS
  .map(field => field.key) as Array<
    | 'review_branch'
    | 'review_commit'
    | 'review_url'
    | 'qa_verified_commit'
    | 'qa_tested_url'
    | 'merged_commit'
    | 'deployed_commit'
    | 'deploy_target'
    | 'deployed_at'
    | 'live_verified_by'
    | 'live_verified_at'
  >;

export const STARTER_FIELD_SCHEMA_SEEDS: Array<{ sprintType: StarterSprintTypeKey; schema: { fields: StarterFieldDefinition[] } }> = [
  {
    sprintType: 'generic',
    schema: {
      fields: [
        { key: 'success_criteria', label: 'Success Criteria', type: 'textarea', required: false, help_text: 'What should be true when this work is finished.' },
      ],
    },
  },
  {
    sprintType: 'dev',
    schema: {
      fields: [
        { key: 'target_surface', label: 'Target Surface', type: 'select', required: false, options: ['api', 'ui', 'fullstack', 'infra'] },
        { key: 'test_plan', label: 'Test Plan', type: 'textarea', required: false, help_text: 'How the implementation should be verified before review.' },
        { key: 'rollout_notes', label: 'Rollout Notes', type: 'textarea', required: false },
        ...DEV_LIFECYCLE_FIELD_DEFINITIONS,
      ],
    },
  },
  {
    sprintType: 'ops',
    schema: {
      fields: [
        { key: 'environment', label: 'Environment', type: 'select', required: false, options: ['dev', 'staging', 'production'] },
        { key: 'impact_level', label: 'Impact Level', type: 'select', required: false, options: ['low', 'medium', 'high'] },
        { key: 'runbook_url', label: 'Runbook URL', type: 'url', required: false },
        { key: 'rollback_notes', label: 'Rollback Notes', type: 'textarea', required: false },
      ],
    },
  },
];

export const STARTER_SPRINT_TYPE_TASK_TYPE_SEEDS: Array<{ sprintType: StarterSprintTypeKey; taskTypes: TaskType[] }> = [
  { sprintType: 'generic', taskTypes: ['adhoc', 'backend', 'frontend', 'fullstack', 'qa', 'other'] },
  { sprintType: 'dev', taskTypes: ['backend', 'frontend', 'fullstack', 'qa'] },
  { sprintType: 'ops', taskTypes: ['ops', 'adhoc', 'qa', 'other'] },
];

const BASE_SCOPED_MCP_CAPABILITIES = [
  'discovery.read_catalog',
  'tasks.read_active_context',
  'tasks.write_active_lifecycle',
  'projects.read_active_project',
  'projects.manage_active_files',
  'sprints.read_active_sprint',
  'workflow.read_active_configuration',
];

function starterDocs(params: {
  name: string;
  role: string;
  summary: string;
  responsibilities: string[];
  boundaries?: string[];
}): Record<string, string> {
  return {
    'IDENTITY.md': [
      `# IDENTITY.md - ${params.name}`,
      '',
      `- **Name:** ${params.name}`,
      `- **Role:** ${params.role}`,
      '- **Project:** Default Project',
      '- **State:** Unprovisioned starter template',
      '- **Workspace:** Assigned during provisioning',
      '',
    ].join('\n'),
    'SOUL.md': [
      `# SOUL.md - ${params.name}`,
      '',
      params.summary,
      '',
      '## Responsibilities',
      '',
      ...params.responsibilities.map((item) => `- ${item}`),
      '',
      '## Boundaries',
      '',
      ...(params.boundaries ?? [
        'Do not assume host-specific paths, credentials, projects, tenants, or agent IDs.',
        'Use the active Agent HQ task contract and leave truthful lifecycle evidence.',
      ]).map((item) => `- ${item}`),
      '',
    ].join('\n'),
    'AGENTS.md': [
      `# AGENTS.md - ${params.name}`,
      '',
      'This is starter identity content. Provisioning materializes it into a real workspace.',
      '',
      '## Operating Rules',
      '',
      '- Keep tenant and project boundaries explicit.',
      '- Prefer package defaults until an operator customizes this agent.',
      '- Do not claim a live workspace path until provisioning assigns one.',
      '',
    ].join('\n'),
    'USER.md': '# USER.md\n\nLearn operator preferences only after this starter agent is provisioned.\n',
    'TOOLS.md': '# TOOLS.md\n\nRecord tenant-local tool notes after provisioning.\n',
    'MEMORY.md': `# MEMORY.md - ${params.name}\n\nCurated memory starts empty for this starter agent.\n`,
    'HEARTBEAT.md': `# HEARTBEAT.md - ${params.name}\n\nAdd cadence notes after provisioning.\n`,
  };
}

export const STARTER_AGENT_DEFINITIONS: StarterAgentDefinition[] = [
  {
    name: 'PM Agent',
    role: 'Project management, triage, planning, and operator handoff',
    jobTitle: 'Project Manager',
    systemRole: `${STARTER_AGENT_SYSTEM_ROLE_PREFIX}pm`,
    workflowTypes: ['generic', 'dev', 'ops'],
    taskTypes: ['adhoc', 'other', 'backend', 'frontend', 'fullstack', 'ops', 'qa'],
    contractTypes: ['generic', 'dev', 'ops'],
    mcpCapabilities: BASE_SCOPED_MCP_CAPABILITIES,
    mcpServerSlugs: ['agent-hq'],
    toolSlugs: ['explore_codebase'],
    skillNames: ['create-task', 'create-project'],
    modelPolicy: { runtime_type: 'openclaw', preferred_provider: 'anthropic', model: null },
    requirements: [
      'Can read project, workflow, task, and agent context.',
      'Can write lifecycle notes, evidence, and outcomes only for assigned active work.',
      'Needs a tenant-local workspace before dispatch.',
    ],
    identityDocs: starterDocs({
      name: 'PM Agent',
      role: 'Project management, triage, planning, and operator handoff',
      summary: 'You coordinate Agent HQ work with clear scope, priorities, evidence, and handoffs.',
      responsibilities: [
        'Clarify work into actionable tasks and workflow-ready acceptance criteria.',
        'Route ambiguous work to the right project, workflow, and role.',
        'Leave durable notes when product or operator context affects future work.',
      ],
    }),
  },
  {
    name: 'Review Agent',
    role: 'Review, QA verification, and evidence-focused validation',
    jobTitle: 'Review Engineer',
    systemRole: `${STARTER_AGENT_SYSTEM_ROLE_PREFIX}review`,
    workflowTypes: ['dev', 'generic', 'ops'],
    taskTypes: ['qa', 'backend', 'frontend', 'fullstack', 'ops', 'other'],
    contractTypes: ['dev', 'generic', 'ops'],
    mcpCapabilities: BASE_SCOPED_MCP_CAPABILITIES,
    mcpServerSlugs: ['agent-hq'],
    toolSlugs: ['explore_codebase'],
    skillNames: [],
    modelPolicy: { runtime_type: 'openclaw', preferred_provider: 'anthropic', model: null },
    requirements: [
      'Can inspect task context, evidence, and workflow configuration.',
      'Can record QA/review findings through lifecycle tools.',
      'Needs review target access supplied by the active task contract.',
    ],
    identityDocs: starterDocs({
      name: 'Review Agent',
      role: 'Review, QA verification, and evidence-focused validation',
      summary: 'You verify behavior and evidence without overstating what was tested.',
      responsibilities: [
        'Review implementation claims against code, task scope, and evidence.',
        'Run focused QA checks and report exact pass/fail results.',
        'Distinguish product defects from environment, workflow, or evidence blockers.',
      ],
    }),
  },
  {
    name: 'Developer Agent',
    role: 'Backend, frontend, and full-stack implementation work',
    jobTitle: 'Developer',
    systemRole: `${STARTER_AGENT_SYSTEM_ROLE_PREFIX}developer`,
    workflowTypes: ['dev', 'generic'],
    taskTypes: ['backend', 'frontend', 'fullstack', 'adhoc', 'other'],
    contractTypes: ['dev', 'generic'],
    mcpCapabilities: BASE_SCOPED_MCP_CAPABILITIES,
    mcpServerSlugs: ['agent-hq'],
    toolSlugs: ['explore_codebase', 'bash', 'file_edit'],
    skillNames: ['create-agent', 'create-project', 'create-task'],
    modelPolicy: { runtime_type: 'openclaw', preferred_provider: 'anthropic', model: null },
    requirements: [
      'Needs a provisioned workspace and repository access before implementation dispatch.',
      'Can read active task/project context and write lifecycle evidence for assigned tasks.',
      'Uses project-owned repository configuration rather than agent-local repo defaults.',
    ],
    identityDocs: starterDocs({
      name: 'Developer Agent',
      role: 'Backend, frontend, and full-stack implementation work',
      summary: 'You implement scoped Agent HQ tasks and verify your changes before handoff.',
      responsibilities: [
        'Read existing code before changing it.',
        'Keep edits scoped to the assigned task and project.',
        'Run appropriate tests and record exact evidence before review handoff.',
      ],
    }),
  },
  {
    name: 'Ops Agent',
    role: 'Operations, release, maintenance, and environment work',
    jobTitle: 'Operations Engineer',
    systemRole: `${STARTER_AGENT_SYSTEM_ROLE_PREFIX}ops`,
    workflowTypes: ['ops', 'dev', 'generic'],
    taskTypes: ['ops', 'adhoc', 'qa', 'other'],
    contractTypes: ['ops', 'dev', 'generic'],
    mcpCapabilities: [...BASE_SCOPED_MCP_CAPABILITIES, 'external.write_task_events'],
    mcpServerSlugs: ['agent-hq'],
    toolSlugs: ['explore_codebase', 'bash'],
    skillNames: ['task-routing-rules'],
    modelPolicy: { runtime_type: 'openclaw', preferred_provider: 'anthropic', model: null },
    requirements: [
      'Needs explicit environment and release permissions before external actions.',
      'Can record operational evidence and lifecycle outcomes for assigned work.',
      'Treats production, deploy, and public actions as approval-gated unless the task contract explicitly authorizes them.',
    ],
    identityDocs: starterDocs({
      name: 'Ops Agent',
      role: 'Operations, release, maintenance, and environment work',
      summary: 'You handle operational work with careful evidence and clear rollback thinking.',
      responsibilities: [
        'Diagnose environment, configuration, routing, and release issues.',
        'Record exact commands, targets, versions, and verification results.',
        'Separate code defects from environment, workflow, and infrastructure failures.',
      ],
    }),
  },
];

export const STARTER_RELATIONSHIP_TYPE_SEEDS: Array<{
  sprintTypes: StarterSprintTypeKey[];
  key: string;
  label: string;
  inverse_label: string;
  category: string;
  affects_dispatch_eligibility: number;
  direction_semantics: 'target_blocks_source' | 'source_blocks_target' | 'informational';
  active_statuses_json: string;
  resolved_statuses_json: string;
  allow_create_related_task: number;
  default_related_task_type: TaskType | null;
  default_related_task_status: string | null;
}> = [
  {
    sprintTypes: ['generic', 'dev', 'ops'],
    key: 'blocked_by',
    label: 'Blocked by',
    inverse_label: 'Blocks',
    category: 'dependency',
    affects_dispatch_eligibility: 1,
    direction_semantics: 'target_blocks_source',
    active_statuses_json: JSON.stringify(['todo', 'ready', 'in_progress', 'review']),
    resolved_statuses_json: JSON.stringify(['done']),
    allow_create_related_task: 0,
    default_related_task_type: null,
    default_related_task_status: null,
  },
  {
    sprintTypes: ['dev'],
    key: 'blocks',
    label: 'Blocks',
    inverse_label: 'Blocked by',
    category: 'dependency',
    affects_dispatch_eligibility: 1,
    direction_semantics: 'source_blocks_target',
    active_statuses_json: JSON.stringify(['todo', 'ready', 'in_progress', 'review', 'blocked']),
    resolved_statuses_json: JSON.stringify(['done', 'deployed']),
    allow_create_related_task: 0,
    default_related_task_type: null,
    default_related_task_status: null,
  },
  {
    sprintTypes: ['dev'],
    key: 'defect_of',
    label: 'Defect of',
    inverse_label: 'Has defect',
    category: 'quality',
    affects_dispatch_eligibility: 0,
    direction_semantics: 'informational',
    active_statuses_json: '[]',
    resolved_statuses_json: '[]',
    allow_create_related_task: 1,
    default_related_task_type: 'backend',
    default_related_task_status: 'todo',
  },
  {
    sprintTypes: ['dev'],
    key: 'follow_up_to',
    label: 'Follow-up to',
    inverse_label: 'Has follow-up',
    category: 'continuity',
    affects_dispatch_eligibility: 0,
    direction_semantics: 'informational',
    active_statuses_json: '[]',
    resolved_statuses_json: '[]',
    allow_create_related_task: 1,
    default_related_task_type: null,
    default_related_task_status: 'todo',
  },
  {
    sprintTypes: ['dev'],
    key: 'duplicate_of',
    label: 'Duplicate of',
    inverse_label: 'Has duplicate',
    category: 'dedupe',
    affects_dispatch_eligibility: 0,
    direction_semantics: 'informational',
    active_statuses_json: '[]',
    resolved_statuses_json: '[]',
    allow_create_related_task: 0,
    default_related_task_type: null,
    default_related_task_status: null,
  },
];

export const STARTER_SPRINT_OUTCOME_SEEDS: Array<{
  sprintType: StarterSprintTypeKey;
  outcomes: Array<{
    task_type?: TaskType | null;
    outcome_key: string;
    label: string;
    description: string;
    enabled?: number;
    behavior?: 'base' | 'extend' | 'override' | 'disable';
    badge_variant?: string | null;
    stage_order: number;
    metadata?: Record<string, unknown>;
  }>;
}> = [
  {
    sprintType: 'generic',
    outcomes: [
      { outcome_key: 'completed', label: 'Completed', description: 'Task work is complete.', badge_variant: 'done', stage_order: 0, metadata: {} },
      { outcome_key: 'blocked', label: 'Blocked', description: 'Task cannot proceed because of an external blocker.', badge_variant: 'stalled', stage_order: 1, metadata: { blocked_like: true } },
      { outcome_key: 'env_blocked', label: 'Environment Blocked', description: 'Task is blocked by environment, access, dependency, or workspace state.', badge_variant: 'stalled', stage_order: 2, metadata: { blocked_like: true } },
      { outcome_key: 'approval_blocked', label: 'Approval Blocked', description: 'Task is blocked waiting for human approval or external signoff.', badge_variant: 'stalled', stage_order: 3, metadata: { blocked_like: true } },
      { outcome_key: 'failed', label: 'Failed', description: 'The task failed and needs triage.', badge_variant: 'failed', stage_order: 4, metadata: { failure_like: true } },
      { outcome_key: 'infra_failed', label: 'Infrastructure Failed', description: 'Task failed because infrastructure or platform dependencies are unavailable.', badge_variant: 'failed', stage_order: 5, metadata: { failure_like: true } },
    ],
  },
  {
    sprintType: 'dev',
    outcomes: [
      { outcome_key: 'completed_for_review', label: 'Ready for Review', description: 'Implementation is ready for review or QA.', badge_variant: 'review', stage_order: 0, metadata: {} },
      { outcome_key: 'dev_deploy_queued', label: 'Dev Deploy Queued', description: 'Implementation is complete and queued for the shared dev environment.', badge_variant: 'queued', stage_order: 1, metadata: {} },
      { outcome_key: 'qa_pass', label: 'QA Pass', description: 'QA passed and the task can move forward.', badge_variant: 'done', stage_order: 2, metadata: {} },
      { outcome_key: 'qa_fail', label: 'QA Fail', description: 'QA failed and the task should return to implementation.', badge_variant: 'failed', stage_order: 3, metadata: { failure_like: true } },
      { outcome_key: 'deployed_live', label: 'Deployed', description: 'Merge/deploy completed and the task is on the live target.', badge_variant: 'deployed', stage_order: 4, metadata: {} },
      { outcome_key: 'live_verified', label: 'Live Verified', description: 'Deployed work was verified live and can move to done.', badge_variant: 'done', stage_order: 5, metadata: {} },
      { outcome_key: 'blocked', label: 'Blocked', description: 'Task cannot proceed because of an external blocker.', badge_variant: 'stalled', stage_order: 6, metadata: { blocked_like: true } },
      { outcome_key: 'env_blocked', label: 'Environment Blocked', description: 'Task is blocked by environment, access, dependency, or workspace state.', badge_variant: 'stalled', stage_order: 7, metadata: { blocked_like: true } },
      { outcome_key: 'approval_blocked', label: 'Approval Blocked', description: 'Task is blocked waiting for human approval or external signoff.', badge_variant: 'stalled', stage_order: 8, metadata: { blocked_like: true } },
      { outcome_key: 'release_failed', label: 'Release Failed', description: 'Post-QA merge, deploy, or live verification failed and work should return for remediation.', badge_variant: 'failed', stage_order: 9, metadata: { failure_like: true } },
      { outcome_key: 'infra_failed', label: 'Infrastructure Failed', description: 'Task failed because infrastructure or platform dependencies are unavailable.', badge_variant: 'failed', stage_order: 10, metadata: { failure_like: true } },
      { outcome_key: 'failed', label: 'Failed', description: 'The task failed and needs triage.', badge_variant: 'failed', stage_order: 11, metadata: { failure_like: true } },
      { outcome_key: 'retry', label: 'Retry', description: 'Retry the task from a recoverable terminal or stalled state.', badge_variant: 'queued', stage_order: 12, metadata: {} },
    ],
  },
  {
    sprintType: 'ops',
    outcomes: [
      { outcome_key: 'completed', label: 'Completed', description: 'Operational work is complete.', badge_variant: 'done', stage_order: 0, metadata: {} },
      { outcome_key: 'blocked', label: 'Blocked', description: 'Operational work is blocked.', badge_variant: 'stalled', stage_order: 1, metadata: { blocked_like: true } },
      { outcome_key: 'env_blocked', label: 'Environment Blocked', description: 'Operational work is blocked by environment, access, or dependency state.', badge_variant: 'stalled', stage_order: 2, metadata: { blocked_like: true } },
      { outcome_key: 'approval_blocked', label: 'Approval Blocked', description: 'Operational work is blocked waiting for human approval or external signoff.', badge_variant: 'stalled', stage_order: 3, metadata: { blocked_like: true } },
      { outcome_key: 'failed', label: 'Failed', description: 'The operational task failed and needs triage.', badge_variant: 'failed', stage_order: 4, metadata: { failure_like: true } },
      { outcome_key: 'infra_failed', label: 'Infrastructure Failed', description: 'Operational work failed because infrastructure or platform dependencies are unavailable.', badge_variant: 'failed', stage_order: 5, metadata: { failure_like: true } },
    ],
  },
];

export function isStarterSprintTypeKey(value: string | null | undefined): value is StarterSprintTypeKey {
  return value === 'generic' || value === 'dev' || value === 'ops';
}

export function starterSprintTypeBaseKey(value: string | null | undefined): StarterSprintTypeKey | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (isStarterSprintTypeKey(normalized)) return normalized;
  const suffix = normalized.match(/__(generic|dev|ops)$/)?.[1];
  return isStarterSprintTypeKey(suffix) ? suffix : null;
}

export function getStarterTaskTypesForSprintType(sprintType: string | null | undefined): TaskType[] {
  const baseSprintType = starterSprintTypeBaseKey(sprintType);
  const row = STARTER_SPRINT_TYPE_TASK_TYPE_SEEDS.find((entry) => entry.sprintType === baseSprintType);
  return row ? [...row.taskTypes] : [];
}
