import { z } from 'zod';
import { THINKING_LEVELS } from '../../lib/workflowVocabulary';
import { McpDomainContext } from '../registrar';

export function registerRoutingTools(ctx: McpDomainContext) {
  const { api, registerTool, wrap } = ctx;
  const taskTypeSchema = z.string().min(1);
  const tenantSelectorSchema = {
    tenant_id: z.number().int().positive().optional().describe('Optional tenant selector for super-admin MCP keys with admin.cross_tenant only'),
  };

  // ── Routing graph and traces ───────────────────────────────────────────────
  // Routing config is a state machine: statuses are nodes, transitions are edges,
  // gate requirements are edge conditions, and assignment rules say who owns a node.
  // These four tools expose the derived machine rather than the raw rows, so an agent
  // and the canvas reason over one representation and cannot reach different answers.

  const graphScopeSchema = {
    ...tenantSelectorSchema,
    project_id: z.number().int().positive().optional().describe('Project ID. Most routing config is project-scoped, so omitting this usually yields an empty graph'),
    sprint_id: z.number().int().positive().optional().describe('Workflow ID, to layer workflow-specific overrides over the type defaults'),
    sprint_type: z.string().min(1).describe('Workflow type key. Required: a graph is always scoped to one workflow type'),
    task_type: taskTypeSchema.nullable().optional().describe('Narrow to one task type. Catch-all rows that also apply are still included'),
  };

  registerTool(
    ['agent_hq_get_routing_graph', 'atlas_get_routing_graph'],
    'Get the routing configuration as a state machine: status nodes with their assigned agents and inbound workflow events, transition edges labelled by outcome with their gate requirements, and lint findings for structural problems. Use this instead of reassembling rules, transitions and requirements by hand. Requires workflow.analyze_routing_graph.',
    graphScopeSchema,
    (args) => wrap(() => api.getRoutingGraph(args))(),
    { domain: 'routing_graph', rest_paths: ['/api/v1/routing/graph'] },
  );

  registerTool(
    ['agent_hq_analyze_routing_graph', 'atlas_analyze_routing_graph'],
    'Findings-only digest of the routing graph: unreachable and dead-end statuses, statuses with no agent assigned, transitions that can never fire because a higher-precedence one always wins, gates whose outcome no transition uses, and rules pointing at disabled agents. Returns the same analysis as agent_hq_get_routing_graph without the node and edge geometry, so it is far cheaper on context when you only need to know what is wrong. Requires workflow.analyze_routing_graph.',
    graphScopeSchema,
    (args) => wrap(async () => {
      const graph = await api.getRoutingGraph(args) as {
        scope?: unknown;
        stats?: unknown;
        lint?: Array<{ code: string; severity: string; message: string; node?: string; edge?: string }>;
      };
      const findings = graph.lint ?? [];
      const byCode: Record<string, number> = {};
      for (const finding of findings) byCode[finding.code] = (byCode[finding.code] ?? 0) + 1;
      return {
        scope: graph.scope,
        stats: graph.stats,
        finding_counts_by_code: byCode,
        findings,
      };
    })(),
    { domain: 'routing_graph', rest_paths: ['/api/v1/routing/graph'] },
  );

  registerTool(
    ['agent_hq_trace_routing', 'atlas_trace_routing'],
    'Answer "if a task of this type sitting in this status reports this outcome, what happens?" Returns the transition that wins, every transition that also matched and why it lost, the gate requirements that would be checked first, and which agent picks the task up at the destination status. Gates are listed, not evaluated — a real pass/fail needs evidence values from a real task. Requires workflow.analyze_routing_graph.',
    {
      ...graphScopeSchema,
      from_status: z.string().min(1).describe('The status the task is sitting in'),
      outcome: z.string().min(1).describe('The outcome an agent would report'),
    },
    (args) => wrap(() => api.traceRouting(args as typeof args & { from_status: string; outcome: string }))(),
    { domain: 'routing_graph', rest_paths: ['/api/v1/routing/trace'] },
  );

  registerTool(
    ['agent_hq_trace_task_path', 'atlas_trace_task_path'],
    'Replay a task\'s status history against the routing graph. Each move is matched to the transition or workflow event that produced it, with per-edge visit counts so repeated rework loops are visible, manual moves flagged as off-graph, and moves that no current rule explains reported as configuration drift. Use this to explain why a task ended up where it did, or why it is cycling. Requires workflow.analyze_routing_graph.',
    {
      task_id: z.number().int().positive().describe('Task ID to replay'),
    },
    ({ task_id }) => wrap(() => api.traceTaskPath(task_id))(),
    { domain: 'routing_graph', rest_paths: ['/api/v1/tasks/:id/trace'] },
  );

  registerTool(
    ['agent_hq_list_routing_rules', 'agent_hq_list_assignment_rules', 'atlas_list_routing_rules', 'atlas_list_assignment_rules'],
    'List assignment rules that map task type and status to agents for workflow-type defaults or workflow overrides. Non-admin MCP keys require routing_rules.manage_project_scope and are limited to their assigned project. Optional tenant_id is super-admin MCP only. sprint_* fields are the current machine-readable compatibility fields.',
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
    'Get a single assignment rule by ID within its scoped project/workflow-type context. Non-admin MCP keys require routing_rules.manage_project_scope and are limited to their assigned project. Optional tenant_id is super-admin MCP only.',
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
    'Create an assignment rule that maps task type and status to an agent. Non-admin MCP keys require routing_rules.manage_project_scope and can only create rules in their assigned project. Optional tenant_id is super-admin MCP only.',
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
    'Update an assignment rule that maps task type and status to an agent. Non-admin MCP keys require routing_rules.manage_project_scope and can only update rules that remain in their assigned project. Optional tenant_id is super-admin MCP only.',
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
    'Delete a workflow-type default or sprint-specific assignment rule. Non-admin MCP keys require routing_rules.manage_project_scope and can only delete rules in their assigned project. Optional tenant_id is super-admin MCP only.',
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
    'List automatic workflow transitions for workflow-type defaults or workflow-specific overrides. Non-admin MCP keys require routing_transitions.manage_project_scope and are limited to their assigned project. Optional tenant_id is super-admin MCP only.',
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
    'Get an automatic workflow transition by ID within its scoped project/workflow-type context. Non-admin MCP keys require routing_transitions.manage_project_scope and are limited to their assigned project. Optional tenant_id is super-admin MCP only.',
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
    'Create an automatic workflow transition for a workflow-type default or workflow-specific override. Non-admin MCP keys require routing_transitions.manage_project_scope and can only create transitions in their assigned project. Optional tenant_id is super-admin MCP only.',
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
    'Update an automatic workflow transition. Non-admin MCP keys require routing_transitions.manage_project_scope and can only update transitions that remain in their assigned project. Optional tenant_id is super-admin MCP only.',
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
    'Delete a workflow-type default or workflow-specific automatic transition. Non-admin MCP keys require routing_transitions.manage_project_scope and can only delete transitions in their assigned project. Optional tenant_id is super-admin MCP only.',
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
