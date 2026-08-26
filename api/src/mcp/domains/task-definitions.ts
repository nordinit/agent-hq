import { z } from 'zod';
import {
  RELATIONSHIP_DIRECTION_SEMANTICS,
  SPRINT_TYPE_OUTCOME_BEHAVIORS,
  TASK_FIELD_TYPES,
  TRANSITION_REQUIREMENT_SEVERITIES,
  TRANSITION_REQUIREMENT_TYPES,
  WORKFLOW_EVENT_ACTION_KINDS,
} from '../../lib/workflowVocabulary';
import { McpDomainContext } from '../registrar';

export function registerTaskDefinitionsTools(ctx: McpDomainContext) {
  const { api, registerTool, wrap } = ctx;
  const taskTypeSchema = z.string().min(1);
  const tenantSelectorSchema = {
    tenant_id: z.number().int().positive().optional().describe('Optional tenant selector for super-admin MCP keys with admin.cross_tenant only'),
  };

  registerTool(
    ['agent_hq_list_workflow_types'],
    'List workflow types. Optional tenant_id is super-admin MCP only.',
    {
      ...tenantSelectorSchema,
      project_id: z.number().int().positive().optional().describe('Optional project scope for project-owned workflow definitions'),
    },
    (args) => wrap(() => api.listSprintTypes(args))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/list', '/api/v1/task-definitions/workflow-types'] },
  );

  registerTool(
    ['agent_hq_get_workflow_type'],
    'Read one project-scoped workflow definition and its configurable metadata. Non-admin MCP keys must pass their assigned project_id.',
    {
      key: z.string().min(1).describe('Workflow definition key'),
      project_id: z.number().int().positive().describe('Project scope for least-privilege readback'),
      ...tenantSelectorSchema,
    },
    ({ key, ...params }) => wrap(() => api.getSprintType(key, params))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key', '/api/v1/workflow-definitions/types/:key'] },
  );
  
  registerTool(
    ['agent_hq_list_workflow_type_task_types'],
    'List allowed task types for a workflow type. Optional tenant_id is super-admin MCP only.',
    { sprint_type_key: z.string().min(1).describe('Workflow type key'), ...tenantSelectorSchema },
    ({ sprint_type_key, ...params }) => wrap(() => api.listSprintTypeTaskTypes(sprint_type_key, params))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/task-types', '/api/v1/task-definitions/workflow-types/:key/task-types'] },
  );
  
  registerTool(
    ['agent_hq_update_workflow_type_task_types'],
    'Replace the allowed task types for a workflow type.',
    {
      sprint_type_key: z.string().min(1).describe('Workflow type key'),
      task_types: z.array(z.string().min(1)).describe('Allowed task type keys'),
    },
    ({ sprint_type_key, task_types }) => wrap(() => api.updateSprintTypeTaskTypes(sprint_type_key, task_types))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/task-types', '/api/v1/task-definitions/workflow-types/:key/task-types'] },
  );
  
  registerTool(
    ['agent_hq_create_workflow_type'],
    'Create a workflow type. Non-admin MCP keys require project_id and the workflow_definitions.manage_project_scope capability.',
    {
      key: z.string().min(1).describe('Workflow type key'),
      project_id: z.number().int().positive().optional().describe('Project scope for least-privilege workflow-definition creation'),
      name: z.string().min(1).describe('Workflow type name'),
      description: z.string().optional().describe('Workflow type description'),
    },
    (args) => wrap(() => api.createSprintType(args))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types', '/api/v1/task-definitions/workflow-types'] },
  );
  
  registerTool(
    ['agent_hq_update_workflow_type'],
    'Update a workflow type. Non-admin MCP keys require project_id matching the definition and their assigned project.',
    {
      key: z.string().min(1).describe('Workflow type key'),
      project_id: z.number().int().positive().optional().describe('Project scope for least-privilege workflow-definition updates'),
      name: z.string().min(1).optional().describe('Workflow type name'),
      description: z.string().optional().describe('Workflow type description'),
    },
    ({ key, ...patch }) => wrap(() => api.updateSprintType(key, patch))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key', '/api/v1/task-definitions/workflow-types/:key'] },
  );
  
  registerTool(
    ['agent_hq_delete_workflow_type'],
    'Delete a workflow type. Non-admin MCP keys require project_id matching the definition and their assigned project.',
    {
      key: z.string().min(1).describe('Workflow type key'),
      project_id: z.number().int().positive().optional().describe('Project scope for least-privilege workflow-definition deletion'),
    },
    ({ key, ...params }) => wrap(() => api.deleteSprintType(key, params))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key', '/api/v1/task-definitions/workflow-types/:key'] },
  );
  
  const customFieldDefinitionSchema = z.object({
    key: z.string().min(1).describe('Field key'),
    label: z.string().min(1).describe('Field label'),
    type: z.enum(TASK_FIELD_TYPES).describe('Field input type'),
    required: z.boolean().optional().describe('Whether the field is required'),
    options: z.array(z.string().min(1)).optional().describe('Allowed values for select fields'),
    help_text: z.string().optional().describe('Optional helper text shown to users'),
  });
  
  const taskFieldSchemaDocumentSchema = z.object({
    fields: z.array(customFieldDefinitionSchema).describe('Custom field definitions for this schema'),
  });
  
  const transitionRequirementSchema = z.object({
    ...tenantSelectorSchema,
    sprint_id: z.number().int().positive().optional().describe('Optional sprint-scoped override target'),
    project_id: z.number().int().positive().optional().describe('Optional project scope for workflow-type defaults'),
    sprint_type: z.string().min(1).optional().describe('Optional workflow type scope for default requirements'),
    task_type: z.string().nullable().optional().describe('Optional task type scope'),
    outcome: z.string().min(1).describe('Outcome key this requirement applies to'),
    field_name: z.string().min(1).describe('Evidence or task field name to require'),
    requirement_type: z.enum(TRANSITION_REQUIREMENT_TYPES).optional().describe('Requirement behavior'),
    match_field: z.string().nullable().optional().describe('Other field name used by match requirements'),
    severity: z.enum(TRANSITION_REQUIREMENT_SEVERITIES).optional().describe('Whether missing evidence blocks the move or only warns'),
    message: z.string().optional().describe('Human explanation shown when the requirement fails'),
    enabled: z.union([z.boolean(), z.number().int()]).optional().describe('Enabled flag'),
    priority: z.number().int().optional().describe('Priority, higher runs first'),
  });
  
  const workflowEventMappingSchema = {
    ...tenantSelectorSchema,
    project_id: z.number().int().positive().nullable().optional().describe('Optional project scope'),
    source: z.string().nullable().optional().describe('Workflow event source, or null for wildcard compatibility'),
    event_name: z.string().min(1).describe('Workflow event name'),
    task_type: taskTypeSchema.nullable().optional().describe('Optional task type guard'),
    status_includes: z.array(z.string().min(1)).optional().describe('Statuses this mapping applies to'),
    status_excludes: z.array(z.string().min(1)).optional().describe('Statuses this mapping must not apply to'),
    action_kind: z.enum(WORKFLOW_EVENT_ACTION_KINDS).optional().describe('Action applied when the mapping matches'),
    action_target: z.string().nullable().optional().describe('Outcome or status target for non-ignore mappings'),
    apply_review_evidence: z.boolean().optional().describe('Whether review evidence from the event is copied'),
    apply_failure_detail: z.boolean().optional().describe('Whether failure detail from the event is copied'),
    enabled: z.boolean().optional().describe('Enabled flag'),
    priority: z.number().int().optional().describe('Priority, higher wins'),
  };
  
  const sprintTypeStatusSchema = {
    name: z.string().min(1).optional().describe('Status key'),
    status_key: z.string().min(1).optional().describe('Status key alias'),
    label: z.string().min(1).optional().describe('Visible status label'),
    color: z.string().optional().describe('Status color token'),
    emoji: z.string().nullable().optional().describe('Optional status emoji'),
    terminal: z.boolean().optional().describe('Whether the status is terminal'),
    allowed_transitions: z.array(z.string().min(1)).optional().describe('Allowed visible status transitions'),
    stage_order: z.number().int().optional().describe('Sort order'),
    is_default_entry: z.boolean().optional().describe('Whether this is the default entry status'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Additional status metadata'),
  };
  
  const sprintTypeOutcomeSchema = {
    task_type: taskTypeSchema.nullable().optional().describe('Optional task type scope'),
    outcome_key: z.string().min(1).optional().describe('Outcome key'),
    label: z.string().min(1).optional().describe('Visible outcome label'),
    description: z.string().optional().describe('Outcome description'),
    enabled: z.boolean().optional().describe('Enabled flag'),
    behavior: z.enum(SPRINT_TYPE_OUTCOME_BEHAVIORS).optional().describe('Outcome merge behavior'),
    badge_variant: z.string().nullable().optional().describe('Badge variant token'),
    stage_order: z.number().int().optional().describe('Sort order'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Outcome metadata'),
  };
  
  const sprintTypeRelationshipTypeSchema = {
    key: z.string().min(1).optional().describe('Relationship type key'),
    label: z.string().min(1).optional().describe('Forward label'),
    inverse_label: z.string().optional().describe('Inverse label'),
    category: z.string().optional().describe('Relationship category'),
    affects_dispatch_eligibility: z.boolean().optional().describe('Whether this relationship blocks dispatch eligibility'),
    direction_semantics: z.enum(RELATIONSHIP_DIRECTION_SEMANTICS).optional().describe('Relationship direction semantics'),
    active_statuses: z.array(z.string().min(1)).optional().describe('Statuses that make the relationship active'),
    resolved_statuses: z.array(z.string().min(1)).optional().describe('Statuses that resolve the relationship'),
    allow_create_related_task: z.boolean().optional().describe('Whether UI may create a related task from this relationship'),
    default_related_task_type: taskTypeSchema.nullable().optional().describe('Default related task type'),
    default_related_task_status: z.string().nullable().optional().describe('Default related task status'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Relationship metadata'),
  };
  
  registerTool(
    ['agent_hq_list_workflow_event_mappings'],
    'List workflow-event mappings used to resolve runtime and external workflow events. Optional tenant_id is super-admin MCP only.',
    {
      ...tenantSelectorSchema,
      project_id: z.number().int().positive().optional().describe('Optional project scope'),
      source: z.string().optional().describe('Optional workflow event source filter'),
      event_name: z.string().optional().describe('Optional event name filter'),
      task_type: taskTypeSchema.optional().describe('Optional task type filter'),
    },
    (args) => wrap(() => api.listWorkflowEventMappings(args))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/routing/workflow-event-mappings'] },
  );
  
  registerTool(
    ['agent_hq_get_workflow_event_mapping'],
    'Get one workflow-event mapping. Optional tenant_id is super-admin MCP only.',
    {
      mapping_id: z.number().int().positive().describe('Workflow-event mapping ID'),
      ...tenantSelectorSchema,
    },
    ({ mapping_id, ...params }) => wrap(() => api.getWorkflowEventMapping(mapping_id, params))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/routing/workflow-event-mappings/:id'] },
  );
  
  registerTool(
    ['agent_hq_create_workflow_event_mapping'],
    'Create a workflow-event mapping. Optional tenant_id is super-admin MCP only.',
    {
      ...workflowEventMappingSchema,
      event_name: z.string().min(1).describe('Workflow event name'),
      dry_run: z.boolean().optional().describe('Preview validation and affected workflow-event mapping row without writing config'),
    },
    (payload) => wrap(() => api.createWorkflowEventMapping(payload))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/routing/workflow-event-mappings'] },
  );
  
  registerTool(
    ['agent_hq_update_workflow_event_mapping'],
    'Update a workflow-event mapping. Optional tenant_id is super-admin MCP only.',
    {
      mapping_id: z.number().int().positive().describe('Workflow-event mapping ID'),
      ...workflowEventMappingSchema,
      event_name: z.string().min(1).optional().describe('Workflow event name'),
      dry_run: z.boolean().optional().describe('Preview validation and affected workflow-event mapping row without writing config'),
    },
    ({ mapping_id, ...patch }) => wrap(() => api.updateWorkflowEventMapping(mapping_id, patch))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/routing/workflow-event-mappings/:id'] },
  );
  
  registerTool(
    ['agent_hq_delete_workflow_event_mapping'],
    'Delete a workflow-event mapping. Optional tenant_id is super-admin MCP only.',
    {
      mapping_id: z.number().int().positive().describe('Workflow-event mapping ID'),
      ...tenantSelectorSchema,
      dry_run: z.boolean().optional().describe('Preview validation and affected workflow-event mapping row without writing config'),
    },
    ({ mapping_id, ...params }) => wrap(() => api.deleteWorkflowEventMapping(mapping_id, params))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/routing/workflow-event-mappings/:id'] },
  );
  
  registerTool(
    ['agent_hq_get_agent_dispatch_contract'],
    'Read the workflow-type agent dispatch contract template and placeholder catalog.',
    {
      sprint_type: z.string().min(1).optional().describe('Workflow type key'),
      sprint_type_key: z.string().min(1).optional().describe('Workflow type key alias'),
    },
    (args) => wrap(() => api.getAgentDispatchContract(args))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/routing/agent-contract'] },
  );
  
  registerTool(
    ['agent_hq_update_agent_dispatch_contract'],
    'Update the workflow-type agent dispatch contract template.',
    {
      sprint_type: z.string().min(1).optional().describe('Workflow type key'),
      sprint_type_key: z.string().min(1).optional().describe('Workflow type key alias'),
      content: z.string().describe('Full contract template content'),
    },
    (args) => wrap(() => api.updateAgentDispatchContract(args))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/routing/agent-contract'] },
  );
  
  registerTool(
    ['agent_hq_get_workflow_config'],
    'Read the Workflow Definitions configuration snapshot. Non-admin MCP keys must pass project_id for project-scoped readback.',
    {
      project_id: z.number().int().positive().optional().describe('Optional project scope for project-owned workflow definitions'),
      ...tenantSelectorSchema,
    },
    (args) => wrap(() => api.getWorkflowConfig(args))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/config'] },
  );
  
  registerTool(
    ['agent_hq_get_workflow_metadata'],
    'Resolve workflow metadata for a workflow, workflow type, and optional task type. Optional tenant_id is super-admin MCP only.',
    {
      ...tenantSelectorSchema,
      sprint_id: z.number().int().positive().optional().describe('Optional sprint scope'),
      sprint_type: z.string().min(1).optional().describe('Optional workflow type scope'),
      task_type: taskTypeSchema.optional().describe('Optional task type scope'),
    },
    (args) => wrap(() => api.getWorkflowMetadata(args))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/workflow-metadata'] },
  );
  
  registerTool(
    ['agent_hq_list_transition_requirement_fields'],
    'List fields available for transition requirement/gate configuration. Optional tenant_id is super-admin MCP only.',
    {
      ...tenantSelectorSchema,
      sprint_id: z.number().int().positive().optional().describe('Optional sprint scope'),
      sprint_type: z.string().min(1).optional().describe('Optional workflow type scope'),
      task_type: taskTypeSchema.optional().describe('Optional task type scope'),
    },
    (args) => wrap(() => api.listTransitionRequirementFields(args))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/routing/transition-requirement-fields'] },
  );
  
  registerTool(
    ['agent_hq_list_workflow_type_statuses'],
    'List status labels for a workflow type. Optional tenant_id is super-admin MCP only.',
    { sprint_type_key: z.string().min(1).describe('Workflow type key'), ...tenantSelectorSchema },
    ({ sprint_type_key, ...params }) => wrap(() => api.listSprintTypeStatuses(sprint_type_key, params))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/statuses'] },
  );
  
  registerTool(
    ['agent_hq_get_resolved_workflow_type_statuses'],
    'Read the resolved visible status catalog for a workflow type. Optional tenant_id is super-admin MCP only.',
    { sprint_type_key: z.string().min(1).describe('Workflow type key'), ...tenantSelectorSchema },
    ({ sprint_type_key, ...params }) => wrap(() => api.listSprintTypeStatuses(sprint_type_key, params))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/statuses'] },
  );
  
  registerTool(
    ['agent_hq_get_workflow_type_status'],
    'Get one status label for a workflow type. Optional tenant_id is super-admin MCP only.',
    { sprint_type_key: z.string().min(1).describe('Workflow type key'), status_key: z.string().min(1).describe('Status key'), ...tenantSelectorSchema },
    ({ sprint_type_key, status_key, ...params }) => wrap(() => api.getSprintTypeStatus(sprint_type_key, status_key, params))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/statuses/:statusKey'] },
  );
  
  registerTool(
    ['agent_hq_create_workflow_type_status'],
    'Create a sprint definition status label.',
    { sprint_type_key: z.string().min(1).describe('Workflow type key'), ...sprintTypeStatusSchema, name: z.string().min(1).describe('Status key'), label: z.string().min(1).describe('Visible status label') },
    ({ sprint_type_key, ...payload }) => wrap(() => api.createSprintTypeStatus(sprint_type_key, payload))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/statuses'] },
  );
  
  registerTool(
    ['agent_hq_update_workflow_type_status'],
    'Update a sprint definition status label.',
    { ...sprintTypeStatusSchema, sprint_type_key: z.string().min(1).describe('Workflow type key'), status_key: z.string().min(1).describe('Current status key') },
    ({ sprint_type_key, status_key, ...patch }) => wrap(() => api.updateSprintTypeStatus(sprint_type_key, status_key, patch))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/statuses/:statusKey'] },
  );
  
  registerTool(
    ['agent_hq_delete_workflow_type_status'],
    'Delete a sprint definition status label.',
    { sprint_type_key: z.string().min(1).describe('Workflow type key'), status_key: z.string().min(1).describe('Status key') },
    ({ sprint_type_key, status_key }) => wrap(() => api.deleteSprintTypeStatus(sprint_type_key, status_key))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/statuses/:statusKey'] },
  );
  
  registerTool(
    ['agent_hq_list_workflow_type_outcomes'],
    'List run outcomes for a workflow type. Optional tenant_id is super-admin MCP only.',
    { sprint_type_key: z.string().min(1).describe('Workflow type key'), ...tenantSelectorSchema },
    ({ sprint_type_key, ...params }) => wrap(() => api.listSprintTypeOutcomes(sprint_type_key, params))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/outcomes'] },
  );
  
  registerTool(
    ['agent_hq_get_resolved_workflow_type_outcomes'],
    'Read the resolved run outcome catalog for a workflow type. Optional tenant_id is super-admin MCP only.',
    { sprint_type_key: z.string().min(1).describe('Workflow type key'), ...tenantSelectorSchema },
    ({ sprint_type_key, ...params }) => wrap(() => api.listSprintTypeOutcomes(sprint_type_key, params))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/outcomes'] },
  );
  
  registerTool(
    ['agent_hq_get_workflow_type_outcome'],
    'Get one run outcome definition for a workflow type. Optional tenant_id is super-admin MCP only.',
    { sprint_type_key: z.string().min(1).describe('Workflow type key'), outcome_id: z.number().int().positive().describe('Outcome definition ID'), ...tenantSelectorSchema },
    ({ sprint_type_key, outcome_id, ...params }) => wrap(() => api.getSprintTypeOutcome(sprint_type_key, outcome_id, params))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/outcomes/:outcomeId'] },
  );
  
  registerTool(
    ['agent_hq_create_workflow_type_outcome'],
    'Create a sprint definition run outcome.',
    { sprint_type_key: z.string().min(1).describe('Workflow type key'), ...sprintTypeOutcomeSchema, outcome_key: z.string().min(1).describe('Outcome key'), label: z.string().min(1).describe('Visible outcome label') },
    ({ sprint_type_key, ...payload }) => wrap(() => api.createSprintTypeOutcome(sprint_type_key, payload))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/outcomes'] },
  );
  
  registerTool(
    ['agent_hq_update_workflow_type_outcome'],
    'Update a sprint definition run outcome.',
    { sprint_type_key: z.string().min(1).describe('Workflow type key'), outcome_id: z.number().int().positive().describe('Outcome definition ID'), ...sprintTypeOutcomeSchema },
    ({ sprint_type_key, outcome_id, ...patch }) => wrap(() => api.updateSprintTypeOutcome(sprint_type_key, outcome_id, patch))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/outcomes/:outcomeId'] },
  );
  
  registerTool(
    ['agent_hq_delete_workflow_type_outcome'],
    'Delete a sprint definition run outcome.',
    { sprint_type_key: z.string().min(1).describe('Workflow type key'), outcome_id: z.number().int().positive().describe('Outcome definition ID') },
    ({ sprint_type_key, outcome_id }) => wrap(() => api.deleteSprintTypeOutcome(sprint_type_key, outcome_id))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/outcomes/:outcomeId'] },
  );
  
  registerTool(
    ['agent_hq_list_workflow_type_relationship_types'],
    'List relationship types for a workflow type. Optional tenant_id is super-admin MCP only.',
    { sprint_type_key: z.string().min(1).describe('Workflow type key'), ...tenantSelectorSchema },
    ({ sprint_type_key, ...params }) => wrap(() => api.listSprintTypeRelationshipTypes(sprint_type_key, params))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/relationship-types'] },
  );
  
  registerTool(
    ['agent_hq_get_workflow_type_relationship_type'],
    'Get one relationship type for a workflow type. Optional tenant_id is super-admin MCP only.',
    { sprint_type_key: z.string().min(1).describe('Workflow type key'), relationship_type_id: z.number().int().positive().describe('Relationship type ID'), ...tenantSelectorSchema },
    ({ sprint_type_key, relationship_type_id, ...params }) => wrap(() => api.getSprintTypeRelationshipType(sprint_type_key, relationship_type_id, params))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/relationship-types/:relationshipTypeId'] },
  );
  
  registerTool(
    ['agent_hq_create_workflow_type_relationship_type'],
    'Create a sprint definition relationship type.',
    { sprint_type_key: z.string().min(1).describe('Workflow type key'), ...sprintTypeRelationshipTypeSchema, key: z.string().min(1).describe('Relationship type key'), label: z.string().min(1).describe('Forward label') },
    ({ sprint_type_key, ...payload }) => wrap(() => api.createSprintTypeRelationshipType(sprint_type_key, payload))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/relationship-types'] },
  );
  
  registerTool(
    ['agent_hq_update_workflow_type_relationship_type'],
    'Update a sprint definition relationship type.',
    { sprint_type_key: z.string().min(1).describe('Workflow type key'), relationship_type_id: z.number().int().positive().describe('Relationship type ID'), ...sprintTypeRelationshipTypeSchema },
    ({ sprint_type_key, relationship_type_id, ...patch }) => wrap(() => api.updateSprintTypeRelationshipType(sprint_type_key, relationship_type_id, patch))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/relationship-types/:relationshipTypeId'] },
  );
  
  registerTool(
    ['agent_hq_delete_workflow_type_relationship_type'],
    'Delete a sprint definition relationship type.',
    { sprint_type_key: z.string().min(1).describe('Workflow type key'), relationship_type_id: z.number().int().positive().describe('Relationship type ID') },
    ({ sprint_type_key, relationship_type_id }) => wrap(() => api.deleteSprintTypeRelationshipType(sprint_type_key, relationship_type_id))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/relationship-types/:relationshipTypeId'] },
  );
  
  registerTool(
    ['agent_hq_list_workflow_type_field_schemas'],
    'List task field schemas for a workflow type. Optional tenant_id is super-admin MCP only.',
    {
      sprint_type_key: z.string().min(1).describe('Workflow type key'),
      ...tenantSelectorSchema,
    },
    ({ sprint_type_key, ...params }) => wrap(() => api.listTaskFieldSchemas(sprint_type_key, params))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/field-schemas', '/api/v1/task-definitions/workflow-types/:key/field-schemas'] },
  );
  
  registerTool(
    ['agent_hq_get_workflow_type_field_schema'],
    'Get a task field schema for a workflow type. Optional tenant_id is super-admin MCP only.',
    {
      sprint_type_key: z.string().min(1).describe('Workflow type key'),
      schema_id: z.number().int().positive().describe('Schema ID'),
      ...tenantSelectorSchema,
    },
    ({ sprint_type_key, schema_id, ...params }) => wrap(() => api.getTaskFieldSchema(sprint_type_key, schema_id, params))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/field-schemas/:schemaId', '/api/v1/task-definitions/workflow-types/:key/field-schemas/:schemaId'] },
  );
  
  registerTool(
    ['agent_hq_create_workflow_type_field_schema'],
    'Create a task field schema for a workflow type. The schema document mirrors Workflow Definitions UI payloads and accepts full schema.fields[] content.',
    {
      sprint_type_key: z.string().min(1).describe('Workflow type key'),
      task_type: z.string().nullable().optional().describe('Optional task type scope'),
      schema: taskFieldSchemaDocumentSchema.describe('Field schema document with schema.fields[] entries'),
    },
    ({ sprint_type_key, ...payload }) => wrap(() => api.createTaskFieldSchema(sprint_type_key, payload))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/field-schemas', '/api/v1/task-definitions/workflow-types/:key/field-schemas'] },
  );
  
  registerTool(
    ['agent_hq_update_workflow_type_field_schema'],
    'Update a task field schema for a workflow type. Atlas can send the full schema.fields[] payload used by Workflow Definitions UI.',
    {
      sprint_type_key: z.string().min(1).describe('Workflow type key'),
      schema_id: z.number().int().positive().describe('Schema ID'),
      task_type: z.string().nullable().optional().describe('Optional task type scope'),
      schema: taskFieldSchemaDocumentSchema.optional().describe('Field schema document with schema.fields[] entries'),
    },
    ({ sprint_type_key, schema_id, ...payload }) => wrap(() => api.updateTaskFieldSchema(sprint_type_key, schema_id, payload))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/field-schemas/:schemaId', '/api/v1/task-definitions/workflow-types/:key/field-schemas/:schemaId'] },
  );
  
  registerTool(
    ['agent_hq_list_transition_requirements'],
    'List workflow gate requirements that drive review, QA, and release evidence checks. Non-admin MCP keys require transition_requirements.manage_project_scope or active workflow configuration read access and must scope reads to their assigned project. Optional tenant_id is super-admin MCP only. These are the real configurable gate rows behind outcome validation.',
    {
      ...tenantSelectorSchema,
      sprint_id: z.number().int().positive().optional().describe('Optional sprint-scoped requirement set'),
      project_id: z.number().int().positive().optional().describe('Optional project scope for workflow-type defaults'),
      sprint_type: z.string().min(1).optional().describe('Optional workflow type scope for default requirements'),
      task_type: z.string().optional().describe('Optional task type filter'),
      outcome: z.string().optional().describe('Optional outcome key filter'),
    },
    (args) => wrap(() => api.listTransitionRequirements(args))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/routing/transition-requirements'] },
  );
  
  registerTool(
    ['agent_hq_create_transition_requirement'],
    'Create a workflow gate requirement row. Non-admin MCP keys require transition_requirements.manage_project_scope and can only create requirements inside their assigned project with explicit project/workflow scope. Optional tenant_id is super-admin MCP only. Use this for truthful MCP editing of review or release evidence requirements when they are config-driven.',
    {
      ...transitionRequirementSchema.shape,
      dry_run: z.boolean().optional().describe('Preview validation and affected transition requirement row without writing config'),
    },
    (payload) => wrap(() => api.createTransitionRequirement(payload))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/routing/transition-requirements'] },
  );
  
  registerTool(
    ['agent_hq_update_transition_requirement'],
    'Update a workflow gate requirement row. Non-admin MCP keys require transition_requirements.manage_project_scope and can only update requirements inside their assigned project with explicit project/workflow scope. Optional tenant_id is super-admin MCP only. This edits the real configurable gate behavior used by task outcomes.',
    {
      requirement_id: z.number().int().positive().describe('Requirement ID'),
      ...tenantSelectorSchema,
      sprint_id: z.number().int().positive().optional().describe('Optional sprint scope for sprint-specific overrides'),
      project_id: z.number().int().positive().optional().describe('Optional project scope for workflow-type defaults'),
      sprint_type: z.string().min(1).optional().describe('Optional workflow type scope for default requirements'),
      patch: transitionRequirementSchema.partial().describe('Partial requirement update payload'),
      dry_run: z.boolean().optional().describe('Preview validation and affected transition requirement row without writing config'),
    },
    ({ requirement_id, tenant_id, sprint_id, project_id, sprint_type, patch, dry_run }) => wrap(() => api.updateTransitionRequirement(requirement_id, { ...(patch ?? {}), ...(tenant_id !== undefined ? { tenant_id } : {}), ...(sprint_id !== undefined ? { sprint_id } : {}), ...(project_id !== undefined ? { project_id } : {}), ...(sprint_type !== undefined ? { sprint_type } : {}), ...(dry_run !== undefined ? { dry_run } : {}) }))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/routing/transition-requirements/:id'] },
  );
  
  registerTool(
    ['agent_hq_delete_transition_requirement'],
    'Delete a workflow gate requirement row. Non-admin MCP keys require transition_requirements.manage_project_scope and can only delete requirements inside their assigned project with explicit project/workflow scope. Optional tenant_id is super-admin MCP only.',
    {
      requirement_id: z.number().int().positive().describe('Requirement ID'),
      ...tenantSelectorSchema,
      sprint_id: z.number().int().positive().optional().describe('Optional sprint scope for sprint-specific overrides'),
      project_id: z.number().int().positive().optional().describe('Optional project scope for workflow-type defaults'),
      sprint_type: z.string().min(1).optional().describe('Optional workflow type scope for default requirements'),
      dry_run: z.boolean().optional().describe('Preview validation and affected transition requirement row without writing config'),
    },
    ({ requirement_id, ...params }) => wrap(() => api.deleteTransitionRequirement(requirement_id, params))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/routing/transition-requirements/:id'] },
  );
  
  registerTool(
    ['agent_hq_delete_workflow_type_field_schema'],
    'Delete a task field schema from a workflow type.',
    {
      sprint_type_key: z.string().min(1).describe('Workflow type key'),
      schema_id: z.number().int().positive().describe('Schema ID'),
    },
    ({ sprint_type_key, schema_id }) => wrap(() => api.deleteTaskFieldSchema(sprint_type_key, schema_id))(),
    { domain: 'task_definitions', rest_paths: ['/api/v1/sprints/types/:key/field-schemas/:schemaId', '/api/v1/task-definitions/workflow-types/:key/field-schemas/:schemaId'] },
  );
}
