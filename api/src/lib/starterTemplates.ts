import {
  defaultAgentModelForProvider,
  getConnectedProviderSlugs,
  resolveSchemaSafePreferredProvider,
  validateAgentProviderSelection,
} from '../domains/agents/providerSelection';
import { seedSprintTaskPolicy, seedSprintTypeTaskStatuses } from '../domains/routing/policy/seed';
import { readRuntimeConnectionConfig } from './runtimeOnboarding';
import {
  STARTER_SPRINT_TYPE_SEEDS,
  STARTER_SPRINT_OUTCOME_SEEDS,
  STARTER_FIELD_SCHEMA_SEEDS,
  getStarterTaskTypesForSprintType,
  type StarterFieldDefinition,
} from './starterCatalog';
import { buildCanonicalAgentMainSessionKey, slugifySessionKeyPart } from './sessionKeys';
import { type Db } from "../db/adapter/types";
import { tableExists as sharedTableExists, columnExists as sharedColumnExists, tableColumns as sharedTableColumns, indexExists as sharedIndexExists } from "../db/introspection";

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

export type StarterPlanInput = {
  template_key?: string;
  template_keys?: string[];
  project_name?: string;
  workflow_name?: string;
  workflow_names?: Record<string, string>;
  owners?: Partial<Record<StarterOwnerRole, string>>;
  routing_plan?: StarterRoutePlanInput[];
};

export type StarterRoutePlanInput = {
  key?: string;
  template_key?: string;
  task_type?: string;
  status?: string;
  owner_role?: StarterOwnerRole;
  owner_name?: string;
  enabled?: boolean;
  priority?: number;
};

export type StarterTemplateCatalogEntry = {
  key: StarterTemplateKey;
  label: string;
  description: string;
  fully_implemented: boolean;
  owner_roles: StarterOwnerRole[];
  workflow_type: 'dev' | 'ops' | 'lead_generation' | 'generic';
};

export type StarterAgentPlan = {
  owner_role: StarterOwnerRole;
  owner_name: string;
  name: string;
  job_title: string;
  role: string;
  runtime_type: 'openclaw';
  preferred_provider: string;
  model: string | null;
  skill_names: string[];
};

export type StarterRoutePlan = {
  key: string;
  template_key: StarterTemplateKey;
  task_type: string;
  status: string;
  owner_role: StarterOwnerRole;
  owner_name: string;
  enabled: boolean;
  priority: number;
};

export type StarterModelRoutingPlan = {
  label: string;
  max_points: number;
  provider: string;
  model: string;
  thinking_level: string | null;
  fast_mode: boolean | null;
  enabled: boolean;
};

export type StarterWorkflowPlan = {
  template: StarterTemplateCatalogEntry;
  workflow: { name: string; sprint_type: string; goal: string };
  statuses: string[];
  task_types: string[];
  fields: StarterFieldDefinition[];
  routes: StarterRoutePlan[];
  model_routing: StarterModelRoutingPlan[];
  verification: {
    evidence_gates: string[];
    sample_route_checks: Array<{ task_type: string; status: string; expected_owner_role: StarterOwnerRole }>;
  };
};

export type StarterSetupPlan = {
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
};

export const STARTER_TEMPLATE_CATALOG: StarterTemplateCatalogEntry[] = [
  {
    key: 'development',
    label: 'Development',
    description: 'Default software delivery setup with implementation, QA/review, release handoff, model defaults, and evidence gates.',
    fully_implemented: true,
    owner_roles: ['implementation', 'review', 'release', 'pm'],
    workflow_type: 'dev',
  },
  {
    key: 'ops',
    label: 'Ops',
    description: 'Business operations workflow generalized from Elevation Build issue/change-order intake, impact review, approvals, and stakeholder updates.',
    fully_implemented: true,
    owner_roles: ['ops', 'review', 'approval', 'pm'],
    workflow_type: 'ops',
  },
  {
    key: 'lead-generation',
    label: 'Lead Generation',
    description: 'Prospect intake, qualification, research, outreach/proposal draft, human approval, sent/done, and follow-up.',
    fully_implemented: true,
    owner_roles: ['research', 'outreach', 'approval', 'pm'],
    workflow_type: 'lead_generation',
  },
  {
    key: 'blank',
    label: 'Blank / manual',
    description: 'Create the project and workflow shell without starter agents or routes.',
    fully_implemented: true,
    owner_roles: [],
    workflow_type: 'generic',
  },
];

const DEFAULT_OWNER_NAMES: Record<StarterOwnerRole, string> = {
  implementation: 'Developer Agent',
  review: 'Review Agent',
  release: 'Release Agent',
  pm: 'PM Agent',
  ops: 'Ops Agent',
  research: 'Research Agent',
  outreach: 'Outreach Agent',
  approval: 'Approval Owner',
};

const OWNER_AGENT_DETAILS: Record<StarterOwnerRole, Pick<StarterAgentPlan, 'job_title' | 'role' | 'skill_names'>> = {
  implementation: {
    job_title: 'Developer',
    role: 'Backend, frontend, and full-stack implementation work',
    skill_names: ['create-agent', 'create-project', 'create-task'],
  },
  review: {
    job_title: 'Review Engineer',
    role: 'Review, QA verification, risk review, and evidence-focused validation',
    skill_names: [],
  },
  release: {
    job_title: 'Release Engineer',
    role: 'Release, deployment, and environment verification work',
    skill_names: ['task-routing-rules'],
  },
  pm: {
    job_title: 'Project Manager',
    role: 'Project management, triage, planning, and operator handoff',
    skill_names: ['create-task', 'create-project'],
  },
  ops: {
    job_title: 'Operations Lead',
    role: 'Business operations execution, action plans, and stakeholder updates',
    skill_names: ['task-routing-rules'],
  },
  research: {
    job_title: 'Research Lead',
    role: 'Prospect and account research for qualification and outreach planning',
    skill_names: ['create-task'],
  },
  outreach: {
    job_title: 'Outreach Lead',
    role: 'Drafts outreach, proposal notes, and follow-up plans for human approval',
    skill_names: ['create-task'],
  },
  approval: {
    job_title: 'Approval Owner',
    role: 'Human approval checkpoint owner for sensitive operational and outreach work',
    skill_names: [],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function tableHasColumn(db: Db, table: string, column: string): Promise<boolean> {
    return await sharedColumnExists(db, table, column);
}

function normalizeTemplateKey(value: unknown): StarterTemplateKey {
  const raw = typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'development';
  const key = raw === 'software-qa' ? 'development' : raw;
  const template = STARTER_TEMPLATE_CATALOG.find((entry) => entry.key === key);
  if (!template) {
    throw Object.assign(new Error(`Unknown starter template: ${key}`), { status: 400 });
  }
  return template.key;
}

function normalizeTemplateKeys(input: StarterPlanInput): StarterTemplateKey[] {
  const raw = Array.isArray(input.template_keys) && input.template_keys.length > 0
    ? input.template_keys
    : [input.template_key ?? 'development'];
  const keys: StarterTemplateKey[] = [];
  for (const value of raw) {
    const key = normalizeTemplateKey(value);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys.includes('blank') && keys.length > 1 ? keys.filter((key) => key !== 'blank') : keys;
}

function normalizeOwnerRole(value: unknown): StarterOwnerRole {
  const roles: StarterOwnerRole[] = ['implementation', 'review', 'release', 'pm', 'ops', 'research', 'outreach', 'approval'];
  if (roles.includes(value as StarterOwnerRole)) return value as StarterOwnerRole;
  throw Object.assign(new Error(`owner_role must be one of: ${roles.join(', ')}`), { status: 400 });
}

function normalizeNonEmptyText(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function routeKey(templateKey: StarterTemplateKey, taskType: string, status: string): string {
  return `${templateKey}:${taskType}:${status}`;
}

function ownerMap(input: StarterPlanInput): Record<StarterOwnerRole, string> {
  const ownerInput = isRecord(input.owners) ? input.owners : {};
  return {
    implementation: normalizeNonEmptyText(ownerInput.implementation, DEFAULT_OWNER_NAMES.implementation),
    review: normalizeNonEmptyText(ownerInput.review, DEFAULT_OWNER_NAMES.review),
    release: normalizeNonEmptyText(ownerInput.release, DEFAULT_OWNER_NAMES.release),
    pm: normalizeNonEmptyText(ownerInput.pm, DEFAULT_OWNER_NAMES.pm),
    ops: normalizeNonEmptyText(ownerInput.ops, DEFAULT_OWNER_NAMES.ops),
    research: normalizeNonEmptyText(ownerInput.research, DEFAULT_OWNER_NAMES.research),
    outreach: normalizeNonEmptyText(ownerInput.outreach, DEFAULT_OWNER_NAMES.outreach),
    approval: normalizeNonEmptyText(ownerInput.approval, DEFAULT_OWNER_NAMES.approval),
  };
}

function workflowNameFor(template: StarterTemplateCatalogEntry, input: StarterPlanInput, selectedCount: number): string {
  if (isRecord(input.workflow_names)) {
    const configured = input.workflow_names[template.key];
    if (typeof configured === 'string' && configured.trim()) return configured.trim();
  }
  if (selectedCount === 1) return normalizeNonEmptyText(input.workflow_name, template.key === 'blank' ? 'Manual Workflow' : template.label);
  return template.label;
}

function fieldsForSprintType(sprintType: string): StarterFieldDefinition[] {
  return STARTER_FIELD_SCHEMA_SEEDS.find((entry) => entry.sprintType === sprintType)?.schema.fields.map((field) => ({ ...field, options: field.options ? [...field.options] : undefined })) ?? [];
}

function defaultRoutesForTemplate(template: StarterTemplateCatalogEntry, owners: Record<StarterOwnerRole, string>): StarterRoutePlan[] {
  const make = (taskType: string, status: string, ownerRole: StarterOwnerRole, priority = -100): StarterRoutePlan => ({
    key: routeKey(template.key, taskType, status),
    template_key: template.key,
    task_type: taskType,
    status,
    owner_role: ownerRole,
    owner_name: owners[ownerRole],
    enabled: true,
    priority,
  });

  if (template.key === 'development') {
    const routes: StarterRoutePlan[] = [];
    for (const taskType of ['backend', 'frontend', 'fullstack']) {
      routes.push(make(taskType, 'ready', 'implementation'));
      routes.push(make(taskType, 'review', 'review'));
      routes.push(make(taskType, 'ready_to_merge', 'release'));
    }
    routes.push(make('qa', 'ready', 'review'));
    routes.push(make('adhoc', 'ready', 'pm'));
    return routes;
  }

  if (template.key === 'ops') {
    const routes: StarterRoutePlan[] = [];
    for (const taskType of ['ops', 'data', 'pm_operational', 'adhoc']) {
      routes.push(make(taskType, 'intake', 'pm'));
      routes.push(make(taskType, 'triage', 'pm'));
      routes.push(make(taskType, 'risk_review', 'review'));
      routes.push(make(taskType, 'impact_review', 'review'));
      routes.push(make(taskType, 'action_plan', 'ops'));
      routes.push(make(taskType, 'stakeholder_update', 'ops'));
      routes.push(make(taskType, 'human_approval', 'approval'));
    }
    return routes;
  }

  if (template.key === 'lead-generation') {
    return [
      make('lead', 'intake', 'pm'),
      make('lead', 'qualification', 'pm'),
      make('research', 'research', 'research'),
      make('outreach', 'outreach_draft', 'outreach'),
      make('proposal', 'outreach_draft', 'outreach'),
      make('proposal', 'human_approval', 'approval'),
      make('outreach', 'sent', 'outreach'),
      make('follow_up', 'follow_up', 'outreach'),
    ];
  }

  return [];
}

function normalizeRouteOverride(input: StarterRoutePlanInput, owners: Record<StarterOwnerRole, string>, fallbackTemplateKey: StarterTemplateKey): StarterRoutePlan {
  const taskType = normalizeNonEmptyText(input.task_type, '');
  const status = normalizeNonEmptyText(input.status, '');
  if (!taskType || !status) {
    throw Object.assign(new Error('Each routing_plan item requires task_type and status'), { status: 400 });
  }
  const ownerRole = normalizeOwnerRole(input.owner_role);
  const templateKey = input.template_key ? normalizeTemplateKey(input.template_key) : fallbackTemplateKey;
  return {
    key: normalizeNonEmptyText(input.key, routeKey(templateKey, taskType, status)),
    template_key: templateKey,
    task_type: taskType,
    status,
    owner_role: ownerRole,
    owner_name: normalizeNonEmptyText(input.owner_name, owners[ownerRole]),
    enabled: input.enabled !== false,
    priority: Number.isInteger(input.priority) ? Number(input.priority) : -100,
  };
}

function mergeRouteOverrides(defaultRoutes: StarterRoutePlan[], overrides: unknown, owners: Record<StarterOwnerRole, string>, fallbackTemplateKey: StarterTemplateKey): StarterRoutePlan[] {
  if (!Array.isArray(overrides)) return defaultRoutes;
  const byKey = new Map(defaultRoutes.map((route) => [route.key, route]));
  for (const raw of overrides) {
    if (!isRecord(raw)) {
      throw Object.assign(new Error('routing_plan must contain objects'), { status: 400 });
    }
    const normalized = normalizeRouteOverride(raw as StarterRoutePlanInput, owners, fallbackTemplateKey);
    byKey.set(normalized.key, normalized);
  }
  return Array.from(byKey.values());
}

async function connectedProviderForPlan(tenantId: number): Promise<string | null> {
  const connected = await getConnectedProviderSlugs(tenantId);
  if (connected.length === 0) return null;
  return resolveSchemaSafePreferredProvider(connected);
}

function modelRoutingFor(provider: string | null, model: string | null, labelPrefix: string): StarterModelRoutingPlan[] {
  if (!provider || !model) return [];
  return [
    {
      label: `${labelPrefix} balanced`,
      max_points: 3,
      provider,
      model,
      thinking_level: 'medium',
      fast_mode: null,
      enabled: true,
    },
    {
      label: `${labelPrefix} complex`,
      max_points: 8,
      provider,
      model,
      thinking_level: 'high',
      fast_mode: null,
      enabled: true,
    },
  ];
}

function verificationFor(template: StarterTemplateCatalogEntry): StarterWorkflowPlan['verification'] {
  if (template.key === 'development') {
    return {
      evidence_gates: ['completed_for_review: review_branch, review_commit', 'qa_pass: qa_verified_commit matches review_commit', 'live_verified: deployed_commit, live_verified_by, live_verified_at'],
      sample_route_checks: [
        { task_type: 'backend', status: 'ready', expected_owner_role: 'implementation' },
        { task_type: 'backend', status: 'review', expected_owner_role: 'review' },
        { task_type: 'backend', status: 'ready_to_merge', expected_owner_role: 'release' },
      ],
    };
  }
  if (template.key === 'ops') {
    return {
      evidence_gates: ['approval_blocked routes approval waits to stalled', 'completed from human_approval routes to done'],
      sample_route_checks: [
        { task_type: 'ops', status: 'triage', expected_owner_role: 'pm' },
        { task_type: 'ops', status: 'risk_review', expected_owner_role: 'review' },
        { task_type: 'ops', status: 'action_plan', expected_owner_role: 'ops' },
        { task_type: 'ops', status: 'human_approval', expected_owner_role: 'approval' },
      ],
    };
  }
  if (template.key === 'lead-generation') {
    return {
      evidence_gates: ['outreach/proposal drafts route through human_approval before sent/follow-up'],
      sample_route_checks: [
        { task_type: 'research', status: 'research', expected_owner_role: 'research' },
        { task_type: 'outreach', status: 'outreach_draft', expected_owner_role: 'outreach' },
        { task_type: 'proposal', status: 'human_approval', expected_owner_role: 'approval' },
      ],
    };
  }
  return { evidence_gates: [], sample_route_checks: [] };
}

export function listStarterTemplates(): StarterTemplateCatalogEntry[] {
  return STARTER_TEMPLATE_CATALOG.map((template) => ({ ...template, owner_roles: [...template.owner_roles] }));
}

export async function buildStarterSetupPlan(db: Db, tenantId: number, input: StarterPlanInput = {}): Promise<StarterSetupPlan> {
  const templateKeys = normalizeTemplateKeys(input);
  const templates = templateKeys.map((key) => STARTER_TEMPLATE_CATALOG.find((entry) => entry.key === key)!);
  const primaryTemplate = templates[0];
  const projectName = normalizeNonEmptyText(input.project_name, 'Agent HQ Project');
  const owners = ownerMap(input);

  const runtime = await readRuntimeConnectionConfig(db);
  const provider = await connectedProviderForPlan(tenantId);
  const model = defaultAgentModelForProvider(provider);
  const requiresAgents = templates.some((template) => template.key !== 'blank');
  const compatibilityErrors: string[] = [];
  const compatibilityWarnings: string[] = [];

  if (requiresAgents && runtime?.kind !== 'openclaw') {
    compatibilityErrors.push('Starter agents require a configured OpenClaw runtime. Configure runtime before applying this template.');
  }
  if (requiresAgents && !provider) {
    compatibilityErrors.push('Starter agents require at least one connected provider.');
  }
  if (requiresAgents) {
    const providerError = await validateAgentProviderSelection(tenantId, provider, model);
    if (providerError) compatibilityErrors.push(providerError);
  }

  const ownerRoles = Array.from(new Set(templates.flatMap((template) => template.owner_roles)));
  const agents = requiresAgents
    ? ownerRoles.map((ownerRole) => {
        const details = OWNER_AGENT_DETAILS[ownerRole];
        return {
          owner_role: ownerRole,
          owner_name: owners[ownerRole],
          name: owners[ownerRole],
          job_title: details.job_title,
          role: details.role,
          runtime_type: 'openclaw' as const,
          preferred_provider: provider ?? 'anthropic',
          model,
          skill_names: [...details.skill_names],
        };
      })
    : [];

  const workflows = templates.map((template) => {
    const defaultRoutes = defaultRoutesForTemplate(template, owners);
    const routes = mergeRouteOverrides(
      defaultRoutes,
      input.routing_plan,
      owners,
      template.key,
    ).filter((route) => route.template_key === template.key || templateKeys.length === 1);
    const modelRouting = modelRoutingFor(provider, model, template.label);
    return {
      template,
      workflow: {
        name: workflowNameFor(template, input, templates.length),
        sprint_type: template.workflow_type,
        goal: template.key === 'blank'
          ? 'Manual setup workflow.'
          : `Template-generated ${template.label.toLowerCase()} workflow.`,
      },
      statuses: template.key === 'blank'
        ? ['todo', 'ready', 'in_progress', 'review', 'done']
        : template.key === 'development'
          ? ['todo', 'ready', 'in_progress', 'dev_deploy_queued', 'dev_deploying', 'review', 'ready_to_merge', 'deployed', 'done']
          : template.key === 'ops'
            ? ['todo', 'intake', 'triage', 'risk_review', 'impact_review', 'action_plan', 'stakeholder_update', 'human_approval', 'blocked', 'stalled', 'done']
            : ['intake', 'qualification', 'research', 'outreach_draft', 'human_approval', 'sent', 'follow_up', 'done'],
      task_types: getStarterTaskTypesForSprintType(template.workflow_type),
      fields: fieldsForSprintType(template.workflow_type),
      routes,
      model_routing: template.key === 'blank' ? [] : modelRouting,
      verification: verificationFor(template),
    };
  });

  const routes = workflows.flatMap((workflow) => workflow.routes);
  const modelRouting = workflows.flatMap((workflow) => workflow.model_routing);
  const changes: StarterSetupPlan['preview']['changes'] = [
    { action: 'create', resource: 'project', name: projectName, reason: 'starter setup creates one project for the selected templates' },
    ...workflows.map((workflow) => ({ action: 'create' as const, resource: 'workflow', name: workflow.workflow.name, reason: `${workflow.template.label} template selected` })),
    ...agents.map((agent) => ({ action: 'create' as const, resource: 'agent', name: agent.name, reason: `${agent.owner_role} owner mapping` })),
    ...(routes.length ? [{ action: 'create' as const, resource: 'routing', name: `${routes.length} route rules`, reason: 'owner answers converted into starter routing rules' }] : []),
    ...(modelRouting.length ? [{ action: 'create' as const, resource: 'model_policy', name: `${modelRouting.length} model routing defaults`, reason: 'provider-compatible default model policy' }] : []),
  ];

  return {
    template: primaryTemplate,
    templates,
    project: {
      name: projectName,
      description: `Created from starter templates: ${templates.map((template) => template.label).join(', ')}`,
    },
    workflow: workflows[0].workflow,
    workflows,
    agents,
    routes,
    model_routing: modelRouting,
    compatibility: {
      ok: compatibilityErrors.length === 0,
      runtime: runtime?.kind ?? null,
      provider,
      errors: compatibilityErrors,
      warnings: compatibilityWarnings,
    },
    preview: { changes },
    editable: {
      can_change_owner: true,
      can_disable_route: true,
      can_add_task_type: true,
      advanced_path: '/routing',
    },
  };
}

async function insertProject(db: Db, tenantId: number, plan: StarterSetupPlan): Promise<number> {
  const result = await db.run(`
    INSERT INTO projects (tenant_id, name, description, context_md)
    VALUES (?, ?, ?, ?)
  `, tenantId, plan.project.name, plan.project.description, '');
  return Number(result.lastInsertId);
}

async function insertWorkflow(db: Db, tenantId: number, projectId: number, workflow: StarterWorkflowPlan): Promise<number> {
  const result = await db.run(`
    INSERT INTO sprints (tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value)
    VALUES (?, ?, ?, ?, ?, 'active', 'time', 'ongoing')
  `, tenantId, projectId, workflow.workflow.name, workflow.workflow.goal, workflow.workflow.sprint_type);
  const sprintId = Number(result.lastInsertId);
  await seedSprintTaskPolicy(db, sprintId);
  return sprintId;
}

async function tenantPredicate(db: Db, table: string, tenantId: number): Promise<{ sql: string; params: unknown[] }> {
  if (!await tableHasColumn(db, table, 'tenant_id')) return { sql: '', params: [] };
  return { sql: ' AND tenant_id = ?', params: [tenantId] };
}

async function tenantInsert(db: Db, table: string, tenantId: number): Promise<{ columns: string; placeholders: string; params: unknown[] }> {
  if (!await tableHasColumn(db, table, 'tenant_id')) return { columns: '', placeholders: '', params: [] };
  return { columns: 'tenant_id, ', placeholders: '?, ', params: [tenantId] };
}

async function ensureStarterSprintTypeRegistry(db: Db, tenantId: number, workflow: StarterWorkflowPlan): Promise<void> {
  const sprintType = workflow.workflow.sprint_type;
  const sprintTypeSeed = STARTER_SPRINT_TYPE_SEEDS.find((seed) => seed.key === sprintType);
  if (!sprintTypeSeed) return;

  const typeTenant = await tenantPredicate(db, 'sprint_types', tenantId);
  const existingType = await db.get(`
    SELECT key, is_system
    FROM sprint_types
    WHERE key = ?
      ${typeTenant.sql}
    LIMIT 1
  `, sprintType, ...typeTenant.params) as { key: string; is_system: number } | undefined;

  if (!existingType) {
    const insert = await tenantInsert(db, 'sprint_types', tenantId);
    await db.run(`
      INSERT INTO sprint_types (${insert.columns}key, name, description, is_system, created_at, updated_at)
      VALUES (${insert.placeholders}?, ?, ?, 1, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
    `, ...insert.params, sprintTypeSeed.key, sprintTypeSeed.name, sprintTypeSeed.description);
  } else if (existingType.is_system === 1) {
    await db.run(`
      UPDATE sprint_types
      SET name = ?, description = ?, is_system = 1, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
      WHERE key = ?
        ${typeTenant.sql}
    `, sprintTypeSeed.name, sprintTypeSeed.description, sprintType, ...typeTenant.params);
  }

  const taskTypes = getStarterTaskTypesForSprintType(sprintType);
  const taskTypeTenant = await tenantPredicate(db, 'sprint_type_task_types', tenantId);
  if (taskTypes.length > 0) {
    await db.run(`
      DELETE FROM sprint_type_task_types
      WHERE sprint_type_key = ?
        ${taskTypeTenant.sql}
        AND COALESCE(is_system, 0) = 1
        AND task_type NOT IN (${taskTypes.map(() => '?').join(', ')})
    `, sprintType, ...taskTypeTenant.params, ...taskTypes);
  }
  const taskTypeInsert = await tenantInsert(db, 'sprint_type_task_types', tenantId);
  const taskTypeExistingSql = `
    SELECT id, is_system
    FROM sprint_type_task_types
    WHERE sprint_type_key = ? AND task_type = ?
      ${taskTypeTenant.sql}
    LIMIT 1
  `;
  const taskTypeCreateSql = `
    INSERT INTO sprint_type_task_types (${taskTypeInsert.columns}sprint_type_key, task_type, is_system, created_at, updated_at)
    VALUES (${taskTypeInsert.placeholders}?, ?, 1, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
  `;
  const taskTypeUpdateSql = `
    UPDATE sprint_type_task_types
    SET is_system = 1, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    WHERE sprint_type_key = ? AND task_type = ?
      ${taskTypeTenant.sql}
  `;
  for (const taskType of taskTypes) {
    const existing = await db.get(taskTypeExistingSql, sprintType, taskType, ...taskTypeTenant.params) as { id: number; is_system: number } | undefined;
    if (!existing) await db.run(taskTypeCreateSql, ...taskTypeInsert.params, sprintType, taskType);
    else if (existing.is_system === 1) await db.run(taskTypeUpdateSql, sprintType, taskType, ...taskTypeTenant.params);
  }

  const fieldSeed = STARTER_FIELD_SCHEMA_SEEDS.find((seed) => seed.sprintType === sprintType);
  if (fieldSeed) {
    const schemaJson = JSON.stringify(fieldSeed.schema);
    const fieldTenant = await tenantPredicate(db, 'task_field_schemas', tenantId);
    const existing = await db.get(`
      SELECT id, is_system
      FROM task_field_schemas
      WHERE sprint_type_key = ? AND task_type IS NULL
        ${fieldTenant.sql}
      LIMIT 1
    `, sprintType, ...fieldTenant.params) as { id: number; is_system: number } | undefined;
    if (!existing) {
      const insert = await tenantInsert(db, 'task_field_schemas', tenantId);
      await db.run(`
        INSERT INTO task_field_schemas (${insert.columns}sprint_type_key, task_type, schema_json, is_system, created_at, updated_at)
        VALUES (${insert.placeholders}?, NULL, ?, 1, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
      `, ...insert.params, sprintType, schemaJson);
    } else if (existing.is_system === 1) {
      await db.run(`
        UPDATE task_field_schemas
        SET schema_json = ?, is_system = 1, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
        WHERE sprint_type_key = ? AND task_type IS NULL
          ${fieldTenant.sql}
      `, schemaJson, sprintType, ...fieldTenant.params);
    }
  }

  await seedSprintTypeTaskStatuses(db, sprintType, { force: true, tenantId });

  const outcomeSeed = STARTER_SPRINT_OUTCOME_SEEDS.find((seed) => seed.sprintType === sprintType);
  if (!outcomeSeed) return;

  const outcomeTenant = await tenantPredicate(db, 'sprint_type_outcomes', tenantId);
  const outcomeInsert = await tenantInsert(db, 'sprint_type_outcomes', tenantId);
  const existingOutcomeSql = `
    SELECT id, is_system
    FROM sprint_type_outcomes
    WHERE sprint_type_key = ?
      AND (task_type = ? OR (task_type IS NULL AND ?::text IS NULL))
      AND outcome_key = ?
      ${outcomeTenant.sql}
    LIMIT 1
  `;
  const createOutcomeSql = `
    INSERT INTO sprint_type_outcomes (
      ${outcomeInsert.columns}sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, badge_variant, stage_order, is_system, metadata_json, created_at, updated_at
    ) VALUES (${outcomeInsert.placeholders}?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
  `;
  const updateOutcomeSql = `
    UPDATE sprint_type_outcomes
    SET label = ?, description = ?, enabled = ?, behavior = ?, badge_variant = ?, stage_order = ?, is_system = 1, metadata_json = ?, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    WHERE sprint_type_key = ?
      AND (task_type = ? OR (task_type IS NULL AND ?::text IS NULL))
      AND outcome_key = ?
      ${outcomeTenant.sql}
  `;
  for (const outcome of outcomeSeed.outcomes) {
    const taskType = outcome.task_type ?? null;
    const enabled = outcome.enabled ?? 1;
    const behavior = outcome.behavior ?? (taskType ? 'extend' : 'base');
    const badge = outcome.badge_variant ?? null;
    const metadataJson = JSON.stringify(outcome.metadata ?? {});
    const existing = await db.get(existingOutcomeSql, sprintType, taskType, taskType, outcome.outcome_key, ...outcomeTenant.params) as { id: number; is_system: number } | undefined;
    if (!existing) {
      await db.run(createOutcomeSql, ...outcomeInsert.params, sprintType, taskType, outcome.outcome_key, outcome.label, outcome.description, enabled, behavior, badge, outcome.stage_order, metadataJson);
    } else if (existing.is_system === 1) {
      await db.run(updateOutcomeSql, outcome.label, outcome.description, enabled, behavior, badge, outcome.stage_order, metadataJson, sprintType, taskType, taskType, outcome.outcome_key, ...outcomeTenant.params);
    }
  }
}

async function insertAgent(db: Db, tenantId: number, projectId: number, projectName: string, agent: StarterAgentPlan): Promise<number> {
  const sessionKey = buildCanonicalAgentMainSessionKey({
    projectName,
    projectSlug: slugifySessionKeyPart(projectName, 'project'),
    agentName: agent.name,
    role: agent.job_title,
  });
  const result = await db.run(`
    INSERT INTO agents (
      tenant_id, name, role, session_key, workspace_path, status, runtime_type, runtime_config,
      project_id, preferred_provider, model, system_role, enabled, job_title, schedule,
      job_instructions, skill_names, timeout_seconds, stall_threshold_min, max_retries, sort_rules
    )
    VALUES (?, ?, ?, ?, '', 'idle', ?, NULL, ?, ?, ?, NULL, 1, ?, '', ?, ?, 900, 30, 3, '[]')
  `, tenantId, agent.name, agent.role, sessionKey, agent.runtime_type, projectId, agent.preferred_provider, agent.model, agent.job_title, `Starter owner role: ${agent.owner_role}`, JSON.stringify(agent.skill_names));
  return Number(result.lastInsertId);
}

async function insertRoutingRule(db: Db, sprintId: number, projectId: number, sprintType: string, route: StarterRoutePlan, agentId: number): Promise<number> {
  const result = await db.run(`
    INSERT INTO sprint_task_routing_rules (sprint_id, project_id, sprint_type, task_type, status, agent_id, enabled, priority, is_system, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
  `, sprintId, projectId, sprintType, route.task_type, route.status, agentId, route.enabled ? 1 : 0, route.priority);
  return Number(result.lastInsertId);
}

async function insertModelRouting(db: Db, tenantId: number, projectId: number, sprintId: number, rule: StarterModelRoutingPlan): Promise<number> {
  const hasTenant = await tableHasColumn(db, 'story_point_model_routing', 'tenant_id');
  const columns = [
    ...(hasTenant ? ['tenant_id'] : []),
    'project_id', 'sprint_id', 'sprint_type', 'max_points', 'provider', 'model', 'fallback_model',
    'max_turns', 'max_budget_usd', 'thinking_level', 'fast_mode', 'enabled', 'label',
  ];
  const values = [
    ...(hasTenant ? [tenantId] : []),
    projectId,
    sprintId,
    null,
    rule.max_points,
    rule.provider,
    rule.model,
    null,
    null,
    null,
    rule.thinking_level,
    rule.fast_mode == null ? null : (rule.fast_mode ? 1 : 0),
    rule.enabled ? 1 : 0,
    rule.label,
  ];
  const result = await db.run(`
    INSERT INTO story_point_model_routing (${columns.join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})
  `, ...values);
  return Number(result.lastInsertId);
}

export async function applyStarterSetupPlan(db: Db, tenantId: number, input: StarterPlanInput = {}): Promise<{
  ok: true;
  plan: StarterSetupPlan;
  project_id: number;
  workflow_id: number;
  workflow_ids: Record<string, number>;
  agent_ids: Record<string, number>;
  route_ids: number[];
  model_routing_ids: number[];
}> {
  const plan = await buildStarterSetupPlan(db, tenantId, input);
  if (!plan.compatibility.ok) {
    throw Object.assign(new Error(plan.compatibility.errors.join('; ')), {
      status: 422,
      code: 'starter_template_incompatible',
      compatibility: plan.compatibility,
    });
  }

  return await db.withTransaction(async (db) => {
    const projectId = await insertProject(db, tenantId, plan);
    const workflowIds: Record<string, number> = {};
    const agentIdsByOwner = new Map<string, number>();
    const agentIds: Record<string, number> = {};

    for (const agent of plan.agents) {
      const key = agent.owner_name.trim().toLowerCase();
      const id = agentIdsByOwner.get(key) ?? (await insertAgent(db, tenantId, projectId, plan.project.name, agent));
      agentIdsByOwner.set(key, id);
      agentIds[agent.owner_role] = id;
    }

    const routeIds: number[] = [];
    const modelRoutingIds: number[] = [];
    for (const workflow of plan.workflows) {
      await ensureStarterSprintTypeRegistry(db, tenantId, workflow);
      const workflowId = await insertWorkflow(db, tenantId, projectId, workflow);
      workflowIds[workflow.template.key] = workflowId;
      for (const route of workflow.routes) {
        const agentId = agentIds[route.owner_role];
        if (!agentId) continue;
        routeIds.push(await insertRoutingRule(db, workflowId, projectId, workflow.workflow.sprint_type, route, agentId));
      }
      for (const rule of workflow.model_routing) {
        modelRoutingIds.push(await insertModelRouting(db, tenantId, projectId, workflowId, rule));
      }
    }

    return {
      ok: true as const,
      plan,
      project_id: projectId,
      workflow_id: Object.values(workflowIds)[0] ?? 0,
      workflow_ids: workflowIds,
      agent_ids: agentIds,
      route_ids: routeIds,
      model_routing_ids: modelRoutingIds,
    };
  });
}
