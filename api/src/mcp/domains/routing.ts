import { z } from 'zod';
import { THINKING_LEVELS } from '../../lib/workflowVocabulary';
import { McpDomainContext } from '../registrar';

export function registerRoutingTools(ctx: McpDomainContext) {
  const { api, registerTool, wrap } = ctx;
  const taskTypeSchema = z.string().min(1);
  const tenantSelectorSchema = {
    tenant_id: z.number().int().positive().optional().describe('Optional tenant selector for super-admin MCP keys with admin.cross_tenant only'),
  };

  registerTool(
    ['agent_hq_list_routing_rules', 'agent_hq_list_assignment_rules', 'atlas_list_routing_rules', 'atlas_list_assignment_rules'],
    'List assignment rules that map task type and status to agents for workflow-type defaults or workflow overrides. Optional tenant_id is super-admin MCP only. sprint_* fields are the current machine-readable compatibility fields.',
    {
      ...tenantSelectorSchema,
      project_id: z.number().int().positive().optional().describe('Project ID'),
      sprint_id: z.number().int().positive().optional().describe('Sprint ID'),
      sprint_type: z.string().min(1).optional().describe('Workflow type key'),
      scope: z.enum(['defaults', 'overrides', 'sprint_type_default', 'sprint_override']).optional().describe('Optional scope filter'),
      status: z.string().min(1).optional().describe('Task status filter'),
      task_type: taskTypeSchema.nullable().optional().describe('Task type filter, or null for all task types'),
    },
    (args) => wrap(() => api.listRoutingRules(args))(),
    { domain: 'assignment_rules', rest_paths: ['/api/v1/routing/assignment-rules', '/api/v1/assignment-rules', '/api/v1/routing/rules', '/api/v1/routing-rules'] },
  );
  
  registerTool(
    ['agent_hq_get_routing_rule', 'agent_hq_get_assignment_rule', 'atlas_get_routing_rule', 'atlas_get_assignment_rule'],
    'Get a single assignment rule by ID within its scoped project/workflow-type context. Optional tenant_id is super-admin MCP only.',
    {
      rule_id: z.number().int().positive().describe('Assignment rule ID'),
      ...tenantSelectorSchema,
      project_id: z.number().int().positive().optional().describe('Project ID'),
      sprint_id: z.number().int().positive().optional().describe('Sprint ID'),
      sprint_type: z.string().min(1).optional().describe('Workflow type key'),
      scope: z.enum(['defaults', 'overrides', 'sprint_type_default', 'sprint_override']).optional().describe('Optional scope filter'),
      status: z.string().min(1).optional().describe('Task status filter'),
      task_type: taskTypeSchema.nullable().optional().describe('Task type filter, or null for all task types'),
    },
    ({ rule_id, ...params }) => wrap(() => api.getRoutingRule(rule_id, params))(),
    { domain: 'assignment_rules', rest_paths: ['/api/v1/routing/assignment-rules/:id', '/api/v1/assignment-rules/:id', '/api/v1/routing/rules/:id', '/api/v1/routing-rules/:id'] },
  );
  
  registerTool(
    ['agent_hq_create_routing_rule', 'agent_hq_create_assignment_rule', 'atlas_create_routing_rule', 'atlas_create_assignment_rule'],
    'Create an assignment rule that maps task type and status to an agent. Optional tenant_id is super-admin MCP only.',
    {
      ...tenantSelectorSchema,
      sprint_id: z.number().int().positive().optional().describe('Sprint ID for sprint-specific overrides'),
      project_id: z.number().int().positive().optional().describe('Project ID'),
      sprint_type: z.string().min(1).optional().describe('Workflow type key for defaults or scoped overrides'),
      task_type: taskTypeSchema.nullable().describe('Task type, or null for all task types'),
      status: z.string().min(1).describe('Task status'),
      agent_id: z.number().int().positive().optional().describe('Canonical agent target'),
      job_id: z.number().int().positive().optional().describe('Legacy compat alias for agent_id'),
      enabled: z.boolean().optional().describe('Enabled flag'),
      priority: z.number().int().optional().describe('Rule priority'),
      scope_kind: z.enum(['sprint_type_default', 'sprint_override']).optional().describe('Explicit rule scope'),
      dry_run: z.boolean().optional().describe('Preview validation and affected assignment rule row without writing config'),
    },
    (args) => wrap(() => api.createRoutingRule(args))(),
    { domain: 'assignment_rules', rest_paths: ['/api/v1/routing/assignment-rules', '/api/v1/assignment-rules', '/api/v1/routing/rules', '/api/v1/routing-rules'] },
  );
  
  registerTool(
    ['agent_hq_update_routing_rule', 'agent_hq_update_assignment_rule', 'atlas_update_routing_rule', 'atlas_update_assignment_rule'],
    'Update an assignment rule that maps task type and status to an agent. Optional tenant_id is super-admin MCP only.',
    {
      rule_id: z.number().int().positive().describe('Assignment rule ID'),
      ...tenantSelectorSchema,
      sprint_id: z.number().int().positive().optional().describe('Sprint ID for sprint-specific overrides'),
      project_id: z.number().int().positive().optional().describe('Project ID'),
      sprint_type: z.string().min(1).optional().describe('Workflow type key'),
      task_type: taskTypeSchema.nullable().optional().describe('Task type, or null for all task types'),
      status: z.string().min(1).optional().describe('Task status'),
      agent_id: z.number().int().positive().optional().describe('Canonical agent target'),
      job_id: z.number().int().positive().optional().describe('Legacy compat alias for agent_id'),
      enabled: z.boolean().optional().describe('Enabled flag'),
      priority: z.number().int().optional().describe('Rule priority'),
      scope_kind: z.enum(['sprint_type_default', 'sprint_override']).optional().describe('Explicit rule scope'),
      dry_run: z.boolean().optional().describe('Preview validation and affected assignment rule row without writing config'),
    },
    ({ rule_id, ...patch }) => wrap(() => api.updateRoutingRule(rule_id, patch))(),
    { domain: 'assignment_rules', rest_paths: ['/api/v1/routing/assignment-rules/:id', '/api/v1/assignment-rules/:id', '/api/v1/routing/rules/:id', '/api/v1/routing-rules/:id'] },
  );
  
  registerTool(
    ['agent_hq_delete_routing_rule', 'agent_hq_delete_assignment_rule', 'atlas_delete_routing_rule', 'atlas_delete_assignment_rule'],
    'Delete a workflow-type default or sprint-specific assignment rule. Optional tenant_id is super-admin MCP only.',
    {
      rule_id: z.number().int().positive().describe('Assignment rule ID'),
      ...tenantSelectorSchema,
      project_id: z.number().int().positive().optional().describe('Project ID'),
      sprint_id: z.number().int().positive().optional().describe('Sprint ID'),
      sprint_type: z.string().min(1).optional().describe('Workflow type key'),
      scope: z.enum(['defaults', 'overrides', 'sprint_type_default', 'sprint_override']).optional().describe('Optional scope filter'),
      status: z.string().min(1).optional().describe('Task status filter'),
      task_type: taskTypeSchema.nullable().optional().describe('Task type filter, or null for all task types'),
      dry_run: z.boolean().optional().describe('Preview validation and affected assignment rule row without writing config'),
    },
    ({ rule_id, ...params }) => wrap(() => api.deleteRoutingRule(rule_id, params))(),
    { domain: 'assignment_rules', rest_paths: ['/api/v1/routing/assignment-rules/:id', '/api/v1/assignment-rules/:id', '/api/v1/routing/rules/:id', '/api/v1/routing-rules/:id'] },
  );
  
  registerTool(
    ['agent_hq_list_routing_transitions', 'atlas_list_routing_transitions'],
    'List canonical routing transitions used for model/workflow routing. Optional tenant_id is super-admin MCP only.',
    {
      ...tenantSelectorSchema,
      sprint_id: z.number().int().positive().optional().describe('Sprint override scope'),
      project_id: z.number().int().positive().describe('Required project scope'),
      sprint_type: z.string().optional().describe('Workflow type for default scope'),
    },
    (args) => wrap(() => api.listRoutingTransitions(args))(),
    { domain: 'routing_transitions', rest_paths: ['/api/v1/routing/transitions'] },
  );
  
  registerTool(
    ['agent_hq_get_routing_transition', 'atlas_get_routing_transition'],
    'Get a canonical routing transition by ID. Optional tenant_id is super-admin MCP only.',
    {
      transition_id: z.number().int().positive().describe('Transition ID'),
      ...tenantSelectorSchema,
      sprint_id: z.number().int().positive().optional().describe('Sprint override scope'),
      project_id: z.number().int().positive().describe('Required project scope'),
      sprint_type: z.string().optional().describe('Workflow type for default scope'),
    },
    ({ transition_id, ...params }) => wrap(() => api.getRoutingTransition(transition_id, params))(),
    { domain: 'routing_transitions', rest_paths: ['/api/v1/routing/transitions/:id'] },
  );
  
  registerTool(
    ['agent_hq_create_routing_transition', 'atlas_create_routing_transition'],
    'Create a canonical routing transition. Optional tenant_id is super-admin MCP only.',
    {
      ...tenantSelectorSchema,
      sprint_id: z.number().int().positive().optional().describe('Sprint override scope'),
      project_id: z.number().int().positive().describe('Required project scope'),
      sprint_type: z.string().optional().describe('Workflow type for default scope'),
      task_type: taskTypeSchema.nullable().optional().describe('Optional task type scope'),
      from_status: z.string().min(1).describe('From status'),
      outcome: z.string().min(1).describe('Outcome key'),
      to_status: z.string().min(1).describe('To status'),
      enabled: z.boolean().optional().describe('Enabled flag'),
      priority: z.number().int().optional().describe('Priority'),
      is_protected: z.boolean().optional().describe('Protected flag for sprint-scoped rules'),
      dry_run: z.boolean().optional().describe('Preview validation and affected transition row without writing config'),
    },
    (args) => wrap(() => api.createRoutingTransition(args))(),
    { domain: 'routing_transitions', rest_paths: ['/api/v1/routing/transitions'] },
  );
  
  registerTool(
    ['agent_hq_update_routing_transition', 'atlas_update_routing_transition'],
    'Update a canonical routing transition. Optional tenant_id is super-admin MCP only.',
    {
      transition_id: z.number().int().positive().describe('Transition ID'),
      ...tenantSelectorSchema,
      sprint_id: z.number().int().positive().optional().describe('Sprint override scope'),
      project_id: z.number().int().positive().describe('Required project scope'),
      sprint_type: z.string().optional().describe('Workflow type for default scope'),
      task_type: taskTypeSchema.nullable().optional().describe('Optional task type scope'),
      from_status: z.string().min(1).optional().describe('From status'),
      outcome: z.string().min(1).optional().describe('Outcome key'),
      to_status: z.string().min(1).optional().describe('To status'),
      enabled: z.boolean().optional().describe('Enabled flag'),
      priority: z.number().int().optional().describe('Priority'),
      is_protected: z.boolean().optional().describe('Protected flag for sprint-scoped rules'),
      dry_run: z.boolean().optional().describe('Preview validation and affected transition row without writing config'),
    },
    ({ transition_id, ...patch }) => wrap(() => api.updateRoutingTransition(transition_id, patch))(),
    { domain: 'routing_transitions', rest_paths: ['/api/v1/routing/transitions/:id'] },
  );
  
  registerTool(
    ['agent_hq_delete_routing_transition', 'atlas_delete_routing_transition'],
    'Delete a canonical routing transition. Optional tenant_id is super-admin MCP only.',
    {
      transition_id: z.number().int().positive().describe('Transition ID'),
      ...tenantSelectorSchema,
      sprint_id: z.number().int().positive().optional().describe('Sprint override scope'),
      project_id: z.number().int().positive().describe('Required project scope'),
      sprint_type: z.string().optional().describe('Workflow type for default scope'),
      dry_run: z.boolean().optional().describe('Preview validation and affected transition row without writing config'),
    },
    ({ transition_id, ...params }) => wrap(() => api.deleteRoutingTransition(transition_id, params))(),
    { domain: 'routing_transitions', rest_paths: ['/api/v1/routing/transitions/:id'] },
  );
  
  registerTool(
    ['agent_hq_list_model_routing_rules', 'atlas_list_model_routing_rules'],
    'List story-point model-routing rules, optionally scoped to a project, sprint, or workflow type.',
    {
      project_id: z.number().int().positive().optional().describe('Project scope to list'),
      sprint_id: z.number().int().positive().optional().describe('Sprint scope to list'),
      sprint_type: z.string().min(1).optional().describe('Workflow-type scope to list'),
    },
    (args) => wrap(() => api.listModelRoutingRules(args))(),
    { domain: 'model_routing', rest_paths: ['/api/v1/model-routing', '/api/v1/story-point-routing'] },
  );
  
  registerTool(
    ['agent_hq_get_model_routing_rule', 'atlas_get_model_routing_rule'],
    'Get a story-point model-routing rule by ID.',
    { rule_id: z.number().int().positive().describe('Model-routing rule ID') },
    ({ rule_id }) => wrap(() => api.getModelRoutingRule(rule_id))(),
    { domain: 'model_routing', rest_paths: ['/api/v1/model-routing/:id', '/api/v1/story-point-routing/:id'] },
  );
  
  registerTool(
    ['agent_hq_create_model_routing_rule', 'atlas_create_model_routing_rule'],
    'Create a story-point model-routing rule.',
    {
      max_points: z.number().int().positive().describe('Max story points threshold'),
      provider: z.string().optional().describe('Model provider'),
      model: z.string().min(1).describe('Primary model'),
      fallback_model: z.string().nullable().optional().describe('Fallback model'),
      max_turns: z.number().int().positive().nullable().optional().describe('Max turns'),
      max_budget_usd: z.number().nullable().optional().describe('Budget cap'),
      thinking_level: z.enum(THINKING_LEVELS).nullable().optional().describe('Optional reasoning effort override'),
      enabled: z.boolean().optional().describe('Enabled flag'),
      label: z.string().nullable().optional().describe('Rule label'),
      project_id: z.number().int().positive().nullable().optional().describe('Project scope'),
      sprint_id: z.number().int().positive().nullable().optional().describe('Sprint scope'),
      sprint_type: z.string().min(1).nullable().optional().describe('Workflow-type scope'),
    },
    (args) => wrap(() => api.createModelRoutingRule(args))(),
    { domain: 'model_routing', rest_paths: ['/api/v1/model-routing', '/api/v1/story-point-routing'] },
  );
  
  registerTool(
    ['agent_hq_update_model_routing_rule', 'atlas_update_model_routing_rule'],
    'Update a story-point model-routing rule.',
    {
      rule_id: z.number().int().positive().describe('Model-routing rule ID'),
      max_points: z.number().int().positive().optional().describe('Max story points threshold'),
      provider: z.string().optional().describe('Model provider'),
      model: z.string().min(1).optional().describe('Primary model'),
      fallback_model: z.string().nullable().optional().describe('Fallback model'),
      max_turns: z.number().int().positive().nullable().optional().describe('Max turns'),
      max_budget_usd: z.number().nullable().optional().describe('Budget cap'),
      thinking_level: z.enum(THINKING_LEVELS).nullable().optional().describe('Optional reasoning effort override'),
      enabled: z.boolean().optional().describe('Enabled flag'),
      label: z.string().nullable().optional().describe('Rule label'),
      project_id: z.number().int().positive().nullable().optional().describe('Project scope'),
      sprint_id: z.number().int().positive().nullable().optional().describe('Sprint scope'),
      sprint_type: z.string().min(1).nullable().optional().describe('Workflow-type scope'),
    },
    ({ rule_id, ...patch }) => wrap(() => api.updateModelRoutingRule(rule_id, patch))(),
    { domain: 'model_routing', rest_paths: ['/api/v1/model-routing/:id', '/api/v1/story-point-routing/:id'] },
  );
  
  registerTool(
    ['agent_hq_delete_model_routing_rule', 'atlas_delete_model_routing_rule'],
    'Delete a story-point model-routing rule.',
    { rule_id: z.number().int().positive().describe('Model-routing rule ID') },
    ({ rule_id }) => wrap(() => api.deleteModelRoutingRule(rule_id))(),
    { domain: 'model_routing', rest_paths: ['/api/v1/model-routing/:id', '/api/v1/story-point-routing/:id'] },
  );
}
