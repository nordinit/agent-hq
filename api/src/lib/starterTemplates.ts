import type Database from 'better-sqlite3';
import {
  defaultAgentModelForProvider,
  getConnectedProviderSlugs,
  resolveSchemaSafePreferredProvider,
  validateAgentProviderSelection,
} from '../domains/agents/providerSelection';
import { seedSprintTaskPolicy } from '../domains/routing/policy/seed';
import { readRuntimeConnectionConfig } from './runtimeOnboarding';
import { buildCanonicalAgentMainSessionKey, slugifySessionKeyPart } from './sessionKeys';

export type StarterTemplateKey =
  | 'software-simple'
  | 'software-qa'
  | 'software-qa-release'
  | 'research'
  | 'ops-incidents'
  | 'blank';

export type StarterOwnerRole = 'implementation' | 'review' | 'release' | 'pm';

export type StarterPlanInput = {
  template_key?: string;
  project_name?: string;
  workflow_name?: string;
  owners?: Partial<Record<StarterOwnerRole, string>>;
  routing_plan?: StarterRoutePlanInput[];
};

export type StarterRoutePlanInput = {
  key?: string;
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

export type StarterSetupPlan = {
  template: StarterTemplateCatalogEntry;
  project: { name: string; description: string };
  workflow: { name: string; sprint_type: string; goal: string };
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
  editable: {
    can_change_owner: boolean;
    can_disable_route: boolean;
    can_add_task_type: boolean;
    advanced_path: string;
  };
};

export const STARTER_TEMPLATE_CATALOG: StarterTemplateCatalogEntry[] = [
  {
    key: 'software-simple',
    label: 'Software: simple',
    description: 'One implementation owner with PM triage for small software projects.',
    fully_implemented: false,
    owner_roles: ['implementation', 'pm'],
  },
  {
    key: 'software-qa',
    label: 'Software: implementation + QA',
    description: 'MVP software delivery flow with implementation, review/QA, and PM triage owners.',
    fully_implemented: true,
    owner_roles: ['implementation', 'review', 'pm'],
  },
  {
    key: 'software-qa-release',
    label: 'Software: implementation + QA + release',
    description: 'Software delivery flow with explicit release ownership.',
    fully_implemented: false,
    owner_roles: ['implementation', 'review', 'release', 'pm'],
  },
  {
    key: 'research',
    label: 'Research',
    description: 'Research workflow starter for investigation, synthesis, and review.',
    fully_implemented: false,
    owner_roles: ['implementation', 'review', 'pm'],
  },
  {
    key: 'ops-incidents',
    label: 'Ops / incidents',
    description: 'Operations and incident response starter with triage and execution ownership.',
    fully_implemented: false,
    owner_roles: ['implementation', 'review', 'pm'],
  },
  {
    key: 'blank',
    label: 'Blank / manual',
    description: 'Create the project and workflow shell without starter agents or routes.',
    fully_implemented: false,
    owner_roles: [],
  },
];

const DEFAULT_OWNER_NAMES: Record<StarterOwnerRole, string> = {
  implementation: 'Developer Agent',
  review: 'Review Agent',
  release: 'Release Agent',
  pm: 'PM Agent',
};

const OWNER_AGENT_DETAILS: Record<StarterOwnerRole, Pick<StarterAgentPlan, 'job_title' | 'role' | 'skill_names'>> = {
  implementation: {
    job_title: 'Developer',
    role: 'Backend, frontend, and full-stack implementation work',
    skill_names: ['create-agent', 'create-project', 'create-task'],
  },
  review: {
    job_title: 'Review Engineer',
    role: 'Review, QA verification, and evidence-focused validation',
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
};

const SOFTWARE_QA_TASK_TYPES = ['backend', 'frontend', 'fullstack'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
  } catch {
    return false;
  }
}

function normalizeTemplateKey(value: unknown): StarterTemplateKey {
  const key = typeof value === 'string' && value.trim() ? value.trim() : 'software-qa';
  const template = STARTER_TEMPLATE_CATALOG.find((entry) => entry.key === key);
  if (!template) {
    throw Object.assign(new Error(`Unknown starter template: ${key}`), { status: 400 });
  }
  return template.key;
}

function normalizeOwnerRole(value: unknown): StarterOwnerRole {
  if (value === 'implementation' || value === 'review' || value === 'release' || value === 'pm') return value;
  throw Object.assign(new Error(`owner_role must be one of: implementation, review, release, pm`), { status: 400 });
}

function normalizeNonEmptyText(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function routeKey(taskType: string, status: string): string {
  return `${taskType}:${status}`;
}

function defaultRoutesForSoftwareQa(owners: Record<StarterOwnerRole, string>): StarterRoutePlan[] {
  const routes: StarterRoutePlan[] = [];
  for (const taskType of SOFTWARE_QA_TASK_TYPES) {
    routes.push({
      key: routeKey(taskType, 'ready'),
      task_type: taskType,
      status: 'ready',
      owner_role: 'implementation',
      owner_name: owners.implementation,
      enabled: true,
      priority: -100,
    });
    routes.push({
      key: routeKey(taskType, 'review'),
      task_type: taskType,
      status: 'review',
      owner_role: 'review',
      owner_name: owners.review,
      enabled: true,
      priority: -100,
    });
  }
  routes.push({
    key: routeKey('qa', 'ready'),
    task_type: 'qa',
    status: 'ready',
    owner_role: 'review',
    owner_name: owners.review,
    enabled: true,
    priority: -100,
  });
  routes.push({
    key: routeKey('adhoc', 'ready'),
    task_type: 'adhoc',
    status: 'ready',
    owner_role: 'pm',
    owner_name: owners.pm,
    enabled: true,
    priority: -100,
  });
  routes.push({
    key: routeKey('other', 'ready'),
    task_type: 'other',
    status: 'ready',
    owner_role: 'pm',
    owner_name: owners.pm,
    enabled: true,
    priority: -100,
  });
  routes.push({
    key: routeKey('fullstack', 'ready_to_merge'),
    task_type: 'fullstack',
    status: 'ready_to_merge',
    owner_role: 'pm',
    owner_name: owners.pm,
    enabled: true,
    priority: -100,
  });
  return routes;
}

function normalizeRouteOverride(input: StarterRoutePlanInput, owners: Record<StarterOwnerRole, string>): StarterRoutePlan {
  const taskType = normalizeNonEmptyText(input.task_type, '');
  const status = normalizeNonEmptyText(input.status, '');
  if (!taskType || !status) {
    throw Object.assign(new Error('Each routing_plan item requires task_type and status'), { status: 400 });
  }
  const ownerRole = normalizeOwnerRole(input.owner_role);
  return {
    key: normalizeNonEmptyText(input.key, routeKey(taskType, status)),
    task_type: taskType,
    status,
    owner_role: ownerRole,
    owner_name: normalizeNonEmptyText(input.owner_name, owners[ownerRole]),
    enabled: input.enabled !== false,
    priority: Number.isInteger(input.priority) ? Number(input.priority) : -100,
  };
}

function mergeRouteOverrides(defaultRoutes: StarterRoutePlan[], overrides: unknown, owners: Record<StarterOwnerRole, string>): StarterRoutePlan[] {
  if (!Array.isArray(overrides)) return defaultRoutes;
  const byKey = new Map(defaultRoutes.map((route) => [route.key, route]));
  for (const raw of overrides) {
    if (!isRecord(raw)) {
      throw Object.assign(new Error('routing_plan must contain objects'), { status: 400 });
    }
    const normalized = normalizeRouteOverride(raw as StarterRoutePlanInput, owners);
    byKey.set(normalized.key, normalized);
  }
  return Array.from(byKey.values());
}

function connectedProviderForPlan(db: Database.Database, tenantId: number): string | null {
  const connected = getConnectedProviderSlugs(tenantId);
  if (connected.length === 0) return null;
  return resolveSchemaSafePreferredProvider(connected);
}

export function listStarterTemplates(): StarterTemplateCatalogEntry[] {
  return STARTER_TEMPLATE_CATALOG.map((template) => ({ ...template, owner_roles: [...template.owner_roles] }));
}

export function buildStarterSetupPlan(db: Database.Database, tenantId: number, input: StarterPlanInput = {}): StarterSetupPlan {
  const templateKey = normalizeTemplateKey(input.template_key);
  const template = STARTER_TEMPLATE_CATALOG.find((entry) => entry.key === templateKey)!;
  const projectName = normalizeNonEmptyText(input.project_name, 'Agent HQ Project');
  const workflowName = normalizeNonEmptyText(input.workflow_name, templateKey === 'blank' ? 'Manual Workflow' : 'Backlog');
  const ownerInput = isRecord(input.owners) ? input.owners : {};
  const owners = {
    implementation: normalizeNonEmptyText(ownerInput.implementation, DEFAULT_OWNER_NAMES.implementation),
    review: normalizeNonEmptyText(ownerInput.review, DEFAULT_OWNER_NAMES.review),
    release: normalizeNonEmptyText(ownerInput.release, DEFAULT_OWNER_NAMES.release),
    pm: normalizeNonEmptyText(ownerInput.pm, DEFAULT_OWNER_NAMES.pm),
  };

  const runtime = readRuntimeConnectionConfig(db);
  const provider = connectedProviderForPlan(db, tenantId);
  const model = defaultAgentModelForProvider(provider);
  const compatibilityErrors: string[] = [];
  const compatibilityWarnings: string[] = [];

  if (!template.fully_implemented && template.key !== 'blank') {
    compatibilityWarnings.push(`Template "${template.key}" is cataloged but not fully implemented; software-qa behavior is used only for the MVP template.`);
  }

  const requiresAgents = template.key !== 'blank';
  if (requiresAgents && runtime?.kind !== 'openclaw') {
    compatibilityErrors.push('Starter agents require a configured OpenClaw runtime. Configure runtime before applying this template.');
  }
  if (requiresAgents && !provider) {
    compatibilityErrors.push('Starter agents require at least one connected provider.');
  }
  if (requiresAgents) {
    const providerError = validateAgentProviderSelection(tenantId, provider, model);
    if (providerError) compatibilityErrors.push(providerError);
  }

  const ownerRoles = template.key === 'software-qa'
    ? template.owner_roles
    : template.key === 'blank'
      ? []
      : ['implementation', 'review', 'pm'] as StarterOwnerRole[];

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

  const defaultRoutes = template.key === 'software-qa' ? defaultRoutesForSoftwareQa(owners) : [];
  const routes = mergeRouteOverrides(defaultRoutes, input.routing_plan, owners);

  const modelRouting: StarterModelRoutingPlan[] = requiresAgents && provider && model
    ? [
        {
          label: 'Starter balanced',
          max_points: 3,
          provider,
          model,
          thinking_level: 'medium',
          fast_mode: null,
          enabled: true,
        },
        {
          label: 'Starter complex',
          max_points: 8,
          provider,
          model,
          thinking_level: 'high',
          fast_mode: null,
          enabled: true,
        },
      ]
    : [];

  return {
    template,
    project: {
      name: projectName,
      description: `Created from starter template: ${template.label}`,
    },
    workflow: {
      name: workflowName,
      sprint_type: template.key === 'blank' ? 'generic' : 'dev',
      goal: template.key === 'blank' ? 'Manual setup workflow.' : 'Template-generated software delivery workflow.',
    },
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
    editable: {
      can_change_owner: true,
      can_disable_route: true,
      can_add_task_type: true,
      advanced_path: '/routing',
    },
  };
}

function insertProject(db: Database.Database, tenantId: number, plan: StarterSetupPlan): number {
  const result = db.prepare(`
    INSERT INTO projects (tenant_id, name, description, context_md)
    VALUES (?, ?, ?, ?)
  `).run(tenantId, plan.project.name, plan.project.description, '');
  return Number(result.lastInsertRowid);
}

function insertWorkflow(db: Database.Database, tenantId: number, projectId: number, plan: StarterSetupPlan): number {
  const result = db.prepare(`
    INSERT INTO sprints (tenant_id, project_id, name, goal, sprint_type, workflow_template_key, status, length_kind, length_value)
    VALUES (?, ?, ?, ?, ?, ?, 'active', 'time', 'ongoing')
  `).run(tenantId, projectId, plan.workflow.name, plan.workflow.goal, plan.workflow.sprint_type, plan.template.key);
  const sprintId = Number(result.lastInsertRowid);
  seedSprintTaskPolicy(db, sprintId);
  return sprintId;
}

function insertAgent(db: Database.Database, tenantId: number, projectId: number, projectName: string, agent: StarterAgentPlan): number {
  const sessionKey = buildCanonicalAgentMainSessionKey({
    projectName,
    projectSlug: slugifySessionKeyPart(projectName, 'project'),
    agentName: agent.name,
    role: agent.job_title,
  });
  const result = db.prepare(`
    INSERT INTO agents (
      tenant_id, name, role, session_key, workspace_path, status, runtime_type, runtime_config,
      project_id, preferred_provider, model, system_role, enabled, job_title, schedule,
      job_instructions, skill_names, timeout_seconds, stall_threshold_min, max_retries, sort_rules
    )
    VALUES (?, ?, ?, ?, '', 'idle', ?, NULL, ?, ?, ?, NULL, 1, ?, '', ?, ?, 900, 30, 3, '[]')
  `).run(
    tenantId,
    agent.name,
    agent.role,
    sessionKey,
    agent.runtime_type,
    projectId,
    agent.preferred_provider,
    agent.model,
    agent.job_title,
    `Starter owner role: ${agent.owner_role}`,
    JSON.stringify(agent.skill_names),
  );
  return Number(result.lastInsertRowid);
}

function insertRoutingRule(db: Database.Database, sprintId: number, projectId: number, sprintType: string, route: StarterRoutePlan, agentId: number): number {
  const result = db.prepare(`
    INSERT INTO sprint_task_routing_rules (sprint_id, project_id, sprint_type, task_type, status, agent_id, enabled, priority, is_system, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
  `).run(sprintId, projectId, sprintType, route.task_type, route.status, agentId, route.enabled ? 1 : 0, route.priority);
  return Number(result.lastInsertRowid);
}

function insertModelRouting(db: Database.Database, tenantId: number, projectId: number, sprintId: number, rule: StarterModelRoutingPlan): number {
  const hasTenant = tableHasColumn(db, 'story_point_model_routing', 'tenant_id');
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
  const result = db.prepare(`
    INSERT INTO story_point_model_routing (${columns.join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})
  `).run(...values);
  return Number(result.lastInsertRowid);
}

export function applyStarterSetupPlan(db: Database.Database, tenantId: number, input: StarterPlanInput = {}): {
  ok: true;
  plan: StarterSetupPlan;
  project_id: number;
  workflow_id: number;
  agent_ids: Record<string, number>;
  route_ids: number[];
  model_routing_ids: number[];
} {
  const plan = buildStarterSetupPlan(db, tenantId, input);
  if (!plan.compatibility.ok) {
    throw Object.assign(new Error(plan.compatibility.errors.join('; ')), {
      status: 422,
      code: 'starter_template_incompatible',
      compatibility: plan.compatibility,
    });
  }

  const tx = db.transaction(() => {
    const projectId = insertProject(db, tenantId, plan);
    const workflowId = insertWorkflow(db, tenantId, projectId, plan);
    const agentIdsByOwner = new Map<string, number>();
    const agentIds: Record<string, number> = {};

    for (const agent of plan.agents) {
      const key = agent.owner_name.trim().toLowerCase();
      const id = agentIdsByOwner.get(key) ?? insertAgent(db, tenantId, projectId, plan.project.name, agent);
      agentIdsByOwner.set(key, id);
      agentIds[agent.owner_role] = id;
    }

    const routeIds: number[] = [];
    for (const route of plan.routes) {
      const agentId = agentIds[route.owner_role];
      if (!agentId) continue;
      routeIds.push(insertRoutingRule(db, workflowId, projectId, plan.workflow.sprint_type, route, agentId));
    }

    const modelRoutingIds = plan.model_routing.map((rule) => insertModelRouting(db, tenantId, projectId, workflowId, rule));

    return {
      ok: true as const,
      plan,
      project_id: projectId,
      workflow_id: workflowId,
      agent_ids: agentIds,
      route_ids: routeIds,
      model_routing_ids: modelRoutingIds,
    };
  });

  return tx();
}
