import { z } from 'zod';
import { VALID_TASK_PRIORITIES, VALID_TASK_STORY_POINTS } from '../apiClient';
import { McpDomainContext } from '../registrar';

export function registerTasksTools(ctx: McpDomainContext) {
  const { api, registerTool, wrap } = ctx;
  const taskTypeSchema = z.string().min(1);
  const customFieldsSchema = z.record(z.string(), z.unknown())
    .optional()
    .describe('Workflow/task-type custom fields. Resolve accepted keys with agent_hq_get_workflow_metadata or agent_hq_get_task_field_schema before create/update.');

  
  const storyPointsSchema = z
    .union(
      VALID_TASK_STORY_POINTS.map((value) => z.literal(value)) as [
        z.ZodLiteral<1>,
        z.ZodLiteral<2>,
        z.ZodLiteral<3>,
        z.ZodLiteral<5>,
        z.ZodLiteral<8>,
        z.ZodLiteral<13>,
        z.ZodLiteral<21>,
      ],
    )
    .nullable()
    .optional();
  
  registerTool(
    ['agent_hq_create_task', 'atlas_create_task'],
    'Create a new task in Agent HQ in a required workflow, with optional initial workflow status, assignment, and dry-run preview. Scoped non-admin MCP callers need Project task CRUD or legacy Create Tasks capability and may only create inside their assigned project. Legacy compatibility: blockers is deprecated for one release; prefer relationship-first tools for dispatch dependencies.',
    {
      title: z.string().min(1).describe('Task title (required)'),
      project_id: z.number().int().positive().describe('Project ID (required)'),
      description: z.string().optional().describe('Task description (markdown supported)'),
      sprint_id: z.number().int().positive().describe('Sprint/workflow ID to place the task in (required)'),
      status: z.string().min(1).optional().describe('Initial workflow status. When omitted, task creation uses the workflow/default creation status. Status values are resolved from the selected workflow; call agent_hq_get_workflow_metadata for allowed values.'),
      priority: z.enum(VALID_TASK_PRIORITIES).optional().describe('Priority (default: medium)'),
      task_type: taskTypeSchema.optional().describe('Task type (default: backend)'),
      story_points: storyPointsSchema.describe('Story points: 1, 2, 3, 5, 8, 13, or 21'),
      custom_fields: customFieldsSchema,
      agent_id: z.number().int().positive().nullable().optional().describe('Assign the task to an agent'),
      blockers: z.array(z.number().int().positive()).optional().describe('Legacy compatibility only. Task IDs that block this task when the workflow still defines blocked_by as a dispatch-blocking relationship. Prefer agent_hq_get_task_relationship_types and agent_hq_create_task_relationship.'),
      dry_run: z.boolean().optional().describe('Return a mutation preview without writing data'),
    },
    ({ title, project_id, description, sprint_id, status, priority, task_type, story_points, custom_fields, agent_id, blockers, dry_run }) =>
      wrap(() =>
        api.createTask({
          title,
          project_id,
          description,
          sprint_id,
          status,
          priority,
          task_type,
          story_points,
          custom_fields,
          agent_id,
          blockers,
          dry_run,
        }),
      )(),
    { domain: 'tasks', rest_paths: ['/api/v1/tasks'] },
  );
  
  registerTool(
    ['agent_hq_update_task', 'atlas_update_task'],
    'Update editable fields on an existing task, including workflow movement and assignment, with optional dry-run preview. Scoped non-admin MCP callers need Project task CRUD and may only update tasks, workflows, and assignments inside their assigned project.',
    {
      task_id: z.number().int().positive().describe('Task ID (required)'),
      title: z.string().min(1).optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      priority: z.enum(VALID_TASK_PRIORITIES).optional().describe('New priority'),
      sprint_id: z.number().int().positive().optional().describe('Move to a different sprint/workflow'),
      task_type: taskTypeSchema.optional().describe('New task type'),
      story_points: storyPointsSchema.describe('New story point estimate'),
      custom_fields: customFieldsSchema,
      agent_id: z.number().int().positive().nullable().optional().describe('Assign to a different agent, or null to clear'),
      dry_run: z.boolean().optional().describe('Return a mutation preview without writing data'),
    },
    ({ task_id, title, description, priority, sprint_id, task_type, story_points, custom_fields, agent_id, dry_run }) =>
      wrap(() => api.updateTask(task_id, { title, description, priority, sprint_id, task_type, story_points, custom_fields, agent_id, dry_run }))(),
    { domain: 'tasks', rest_paths: ['/api/v1/tasks/:id'] },
  );
  
  registerTool(
    ['agent_hq_move_task', 'atlas_move_task'],
    'Move a task to a new status. Uses outcome semantics for gated workflow states and supports dry-run preview.',
    {
      task_id: z.number().int().positive().describe('Task ID (required)'),
      status: z.string().min(1).describe('Target workflow status (required). Status values are resolved from the task workflow; call agent_hq_get_workflow_metadata for allowed values. Prefer agent_hq_post_task_outcome for lifecycle transitions.'),
      summary: z.string().optional().describe('Optional summary for outcome-based moves'),
      payload: z.record(z.string(), z.unknown()).optional().describe('Workflow-specific evidence and dynamic outcome fields. Prefer agent_hq_post_task_outcome or the typed lifecycle evidence tools for lifecycle handoffs.'),
      failure_detail: z.string().optional().describe('Failure detail when moving through a failed outcome'),
      dry_run: z.boolean().optional().describe('Return a mutation preview without writing data'),
    },
    ({ task_id, status, summary, payload, failure_detail, dry_run }) =>
      wrap(() =>
        api.moveTask(task_id, {
          status,
          summary,
          payload,
          failure_detail,
          dry_run,
        }),
      )(),
    { domain: 'tasks', rest_paths: ['/api/v1/tasks/:id', '/api/v1/tasks/:id/outcome'] },
  );
  
  registerTool(
    ['agent_hq_get_tasks', 'atlas_get_tasks', 'agent_hq_list_tasks', 'atlas_list_tasks'],
    'List Agent HQ tasks with optional filtering.',
    {
      project_id: z.number().int().positive().optional().describe('Filter by project ID'),
      sprint_id: z.number().int().positive().optional().describe('Filter by sprint ID'),
      status: z.string().optional().describe('Task status filter'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 50, max 100)'),
      offset: z.number().int().min(0).optional().describe('Pagination offset (default 0)'),
    },
    ({ project_id, sprint_id, status, limit, offset }) =>
      wrap(() => api.listTasks({ project_id, sprint_id, status, limit, offset }))(),
    { domain: 'tasks', rest_paths: ['/api/v1/tasks'] },
  );

  registerTool(
    ['agent_hq_search_project_tasks', 'atlas_search_project_tasks'],
    'Search the authenticated agent\'s assigned project for existing tasks using bounded exact-match filters for safe follow-up deduplication. The project scope is derived from the MCP agent identity; caller-supplied project IDs are not accepted. Returns minimal task summaries only and does not allow task mutation or broad listing.',
    {
      workflow_id: z.number().int().positive().optional().describe('Optional workflow/sprint ID filter. Must belong to the authenticated agent\'s assigned project to match anything.'),
      sprint_id: z.number().int().positive().optional().describe('Legacy alias for workflow_id.'),
      statuses: z.array(z.string().min(1)).max(20).optional().describe('Optional status filters. Use nonterminal_only for active/nonterminal dedupe searches.'),
      active_only: z.boolean().optional().describe('Alias for nonterminal_only; excludes terminal tasks such as done, cancelled, and failed.'),
      nonterminal_only: z.boolean().optional().describe('When true, excludes terminal tasks such as done, cancelled, and failed.'),
      task_type: taskTypeSchema.optional().describe('Optional exact task type filter.'),
      custom_fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe('Exact custom-field matches for dedupe, such as { "crm_lead_id": "..." } or { "external_project_id": "..." }. Field names and values are parameterized server-side.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20, max 50).'),
      offset: z.number().int().min(0).optional().describe('Pagination offset (default 0).'),
    },
    ({ workflow_id, sprint_id, statuses, active_only, nonterminal_only, task_type, custom_fields, limit, offset }) =>
      wrap(() => api.searchProjectTasks({ workflow_id, sprint_id, statuses, active_only, nonterminal_only, task_type, custom_fields, limit, offset }))(),
    { domain: 'tasks', rest_paths: ['/api/v1/tasks/project-search'] },
  );
  
  registerTool(
    ['agent_hq_get_task_detail', 'atlas_get_task_detail', 'agent_hq_get_task', 'atlas_get_task'],
    'Get full task detail including blocker, sprint, and assignment context. Scoped non-admin MCP callers need active task context, read project task context, or Project task CRUD for tasks in their assigned project.',
    { task_id: z.number().int().positive().describe('Task ID') },
    ({ task_id }) => wrap(() => api.getTask(task_id))(),
    { domain: 'tasks', rest_paths: ['/api/v1/tasks/:id'] },
  );
  
  registerTool(
    ['agent_hq_get_task_context', 'atlas_get_task_context'],
    'Get the canonical task context in summary or full mode, including truthful task state, meaningful notes/events, run state, blockers, and lease context.',
    {
      task_id: z.number().int().positive().describe('Task ID'),
      mode: z.enum(['summary', 'full']).optional().describe('Context mode, defaults to summary'),
      includeNotes: z.boolean().optional().describe('Include task notes in the response'),
      includeHistory: z.boolean().optional().describe('Include task history in the response'),
      includeRuns: z.boolean().optional().describe('Include task run history in the response'),
      includeLease: z.boolean().optional().describe('Include lease/dev-environment context in the response'),
      recentNotesLimit: z.number().int().min(1).max(200).optional().describe('Max notes to consider'),
      recentHistoryLimit: z.number().int().min(1).max(400).optional().describe('Max history entries to consider'),
      recentRunsLimit: z.number().int().min(1).max(100).optional().describe('Max runs to consider'),
      recentExternalEventsLimit: z.number().int().min(1).max(100).optional().describe('Max workflow/lease events to consider'),
      timelineLimit: z.number().int().min(1).max(200).optional().describe('Max timeline items to return'),
      sinceTimestamp: z.string().optional().describe('Optional ISO timestamp filter applied server-side'),
      sinceNoteId: z.number().int().positive().optional().describe('Only include notes newer than this note id'),
      sinceHistoryId: z.number().int().positive().optional().describe('Only include history newer than this history id'),
      includeNoisyEvents: z.boolean().optional().describe('Include noisy status churn and low-signal events'),
    },
    ({ task_id, mode, ...options }) => wrap(() => api.getTaskContext(task_id, mode, options))(),
    { domain: 'tasks', rest_paths: ['/api/v1/tasks/:id/context'] },
  );
  
  registerTool(
    ['agent_hq_delete_task', 'atlas_delete_task'],
    'Delete a generic task from Agent HQ. Scoped non-admin MCP callers need Project task CRUD and may only delete tasks inside their assigned project.',
    {
      task_id: z.number().int().positive().describe('Task ID'),
      deleted_by: z.string().optional().describe('Audit label for the delete operation'),
    },
    ({ task_id, deleted_by }) => wrap(() => api.deleteTask(task_id, deleted_by))(),
    { domain: 'tasks', rest_paths: ['/api/v1/tasks/:id'] },
  );
  
  registerTool(
    ['agent_hq_get_task_notes', 'atlas_get_task_notes'],
    'Get notes/comments for a task.',
    { task_id: z.number().int().positive().describe('Task ID') },
    ({ task_id }) => wrap(() => api.getTaskNotes(task_id))(),
    { domain: 'tasks', rest_paths: ['/api/v1/tasks/:id/notes'] },
  );
  
  registerTool(
    ['agent_hq_get_task_history', 'atlas_get_task_history'],
    'Get task history entries for a task.',
    { task_id: z.number().int().positive().describe('Task ID') },
    ({ task_id }) => wrap(() => api.getTaskHistory(task_id))(),
    { domain: 'tasks', rest_paths: ['/api/v1/tasks/:id/history'] },
  );

  registerTool(
    ['agent_hq_get_task_instances', 'atlas_get_task_instances'],
    'Get job instances and run state for a task. Requires active-task read scope or Read project task context for tasks in the agent assigned project.',
    { task_id: z.number().int().positive().describe('Task ID') },
    ({ task_id }) => wrap(() => api.getTaskInstances(task_id))(),
    { domain: 'tasks', rest_paths: ['/api/v1/tasks/:id/instances'] },
  );

  registerTool(
    ['agent_hq_get_task_active_owner', 'atlas_get_task_active_owner'],
    'Check the active-owner context for a task, including whether the authenticated MCP agent owns the active run. Requires active-task read scope or Read project task context for tasks in the agent assigned project.',
    { task_id: z.number().int().positive().describe('Task ID') },
    ({ task_id }) => wrap(() => api.getTaskActiveOwner(task_id))(),
    { domain: 'tasks', rest_paths: ['/api/v1/tasks/:id/active-owner'] },
  );

  registerTool(
    ['agent_hq_get_task_relationship_types', 'atlas_get_task_relationship_types'],
    'Resolve relationship type keys valid for this task workflow, including labels, direction_semantics, and affects_dispatch_eligibility. Use this before creating task relationships.',
    { task_id: z.number().int().positive().describe('Task ID') },
    ({ task_id }) => wrap(() => api.getTaskRelationshipTypes(task_id))(),
    { domain: 'tasks', rest_paths: ['/api/v1/tasks/:id/relationship-types'] },
  );

  registerTool(
    ['agent_hq_list_task_relationships', 'atlas_list_task_relationships'],
    'List generic task relationships for a task. Relationship labels and dispatch-blocking semantics come from workflow configuration.',
    { task_id: z.number().int().positive().describe('Task ID') },
    ({ task_id }) => wrap(() => api.listTaskRelationships(task_id))(),
    { domain: 'tasks', rest_paths: ['/api/v1/tasks/:id/relationships'] },
  );

  registerTool(
    ['agent_hq_create_task_relationship', 'atlas_create_task_relationship'],
    'Create or update a generic task relationship using a workflow-configured relationship_type_key. Scoped non-admin MCP callers need Project task CRUD and may only link tasks inside their assigned project. Dispatch eligibility is affected only when the relationship type configuration says so.',
    {
      task_id: z.number().int().positive().describe('Source task ID'),
      target_task_id: z.number().int().positive().describe('Target/related task ID in the same tenant/workspace'),
      relationship_type_key: z.string().min(1).describe('Workflow-configured relationship type key. Call agent_hq_get_task_relationship_types for valid keys.'),
      metadata: z.record(z.string(), z.unknown()).optional().describe('Optional relationship metadata JSON object'),
      created_by: z.string().optional().describe('Optional audit actor label'),
    },
    ({ task_id, target_task_id, relationship_type_key, metadata, created_by }) =>
      wrap(() => api.createTaskRelationship(task_id, { target_task_id, relationship_type_key, metadata, created_by }))(),
    { domain: 'tasks', rest_paths: ['/api/v1/tasks/:id/relationships'] },
  );

  registerTool(
    ['agent_hq_delete_task_relationship', 'atlas_delete_task_relationship'],
    'Delete a generic task relationship by relationship record ID. Scoped non-admin MCP callers need Project task CRUD and may only remove relationships whose source and target tasks are inside their assigned project.',
    {
      task_id: z.number().int().positive().describe('Source task ID for the relationship'),
      relationship_id: z.number().int().positive().describe('Relationship record ID'),
    },
    ({ task_id, relationship_id }) => wrap(() => api.deleteTaskRelationship(task_id, relationship_id))(),
    { domain: 'tasks', rest_paths: ['/api/v1/tasks/:id/relationships/:relationshipId'] },
  );
  
  registerTool(
    ['agent_hq_add_blocker', 'atlas_add_blocker'],
    'Legacy compatibility for one release: mark a task as blocked by another task only when the workflow still defines blocked_by as a dispatch-blocking relationship. Prefer agent_hq_get_task_relationship_types and agent_hq_create_task_relationship.',
    {
      task_id: z.number().int().positive().describe('The task to mark as blocked (required)'),
      blocked_by_task_id: z.number().int().positive().describe('The task that is blocking it (required)'),
      dry_run: z.boolean().optional().describe('Return a mutation preview without writing data'),
    },
    ({ task_id, blocked_by_task_id, dry_run }) => wrap(() => api.addBlocker(task_id, blocked_by_task_id, dry_run))(),
    { domain: 'tasks', rest_paths: ['/api/v1/tasks/:id/blockers'] },
  );
  
  registerTool(
    ['agent_hq_remove_blocker', 'atlas_remove_blocker'],
    'Legacy compatibility for one release: remove a blocked_by compatibility relationship/dependency. Prefer agent_hq_delete_task_relationship for new relationship-first callers.',
    {
      task_id: z.number().int().positive().describe('The blocked task (required)'),
      blocker_id: z.number().int().positive().describe('The blocker record ID to remove (required)'),
    },
    ({ task_id, blocker_id }) => wrap(() => api.removeBlocker(task_id, blocker_id))(),
    { domain: 'tasks', rest_paths: ['/api/v1/tasks/:id/blockers/:blockerId'] },
  );
}
