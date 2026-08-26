import { z } from 'zod';
import { VALID_TASK_PRIORITIES, VALID_TASK_STORY_POINTS } from '../apiClient';
import { McpDomainContext } from '../registrar';

const overlapPolicySchema = z.enum(['skip_if_active', 'create_anyway']);
const changedBySchema = z.string().min(1).optional().describe('Optional audit actor label; defaults to Agent HQ MCP');
const seriesIdSchema = z.number().int().positive().describe('Recurring task series ID');
const workflowIdSchema = z.number().int().positive().optional().describe('Workflow ID. Legacy sprint_id is also accepted by the API, but workflow_id is preferred for new MCP clients.');
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
  .describe('Story points for generated tasks: 1, 2, 3, 5, 8, 13, or 21');

export function registerRecurringTaskSeriesTools(ctx: McpDomainContext) {
  const { api, registerTool, wrap } = ctx;

  registerTool(
    ['agent_hq_list_recurring_task_series'],
    'List recurring task series with optional project, workflow, enabled-state, next-run, and pagination filters.',
    {
      project_id: z.number().int().positive().optional().describe('Filter by project ID'),
      workflow_id: workflowIdSchema,
      sprint_id: z.number().int().positive().optional().describe('Legacy alias for workflow_id'),
      enabled: z.boolean().optional().describe('Filter by enabled state'),
      next_run_from: z.string().optional().describe('Optional ISO lower bound for next_run_at'),
      next_run_to: z.string().optional().describe('Optional ISO upper bound for next_run_at'),
      limit: z.number().int().min(1).max(200).optional().describe('Max results, default 50 and maximum 200'),
      offset: z.number().int().min(0).optional().describe('Pagination offset'),
    },
    (args) => wrap(() => api.listRecurringTaskSeries(args))(),
    { domain: 'recurring_task_series', rest_paths: ['/api/v1/recurring-task-series'] },
  );

  registerTool(
    ['agent_hq_get_recurring_task_series'],
    'Get recurring task series detail, including recent generated-run history.',
    {
      series_id: seriesIdSchema,
      limit: z.number().int().min(1).max(200).optional().describe('Max run-history entries to include, default 25 and maximum 200'),
    },
    ({ series_id, limit }) => wrap(() => api.getRecurringTaskSeries(series_id, limit))(),
    { domain: 'recurring_task_series', rest_paths: ['/api/v1/recurring-task-series/:id'] },
  );

  registerTool(
    ['agent_hq_get_recurring_task_series_history'],
    'List generated-run history for one recurring task series.',
    {
      series_id: seriesIdSchema,
      limit: z.number().int().min(1).max(200).optional().describe('Max run-history entries, default 25 and maximum 200'),
    },
    ({ series_id, limit }) => wrap(() => api.getRecurringTaskSeriesHistory(series_id, limit))(),
    { domain: 'recurring_task_series', rest_paths: ['/api/v1/recurring-task-series/:id/history'] },
  );

  registerTool(
    ['agent_hq_create_recurring_task_series'],
    'Create a recurring task series that schedules normal Agent HQ tasks in a workflow. Supports schedule, timezone, workflow, initial task status, overlap policy, enabled state, and optional agent assignment.',
    {
      project_id: z.number().int().positive().describe('Project ID for generated tasks'),
      workflow_id: z.number().int().positive().describe('Workflow ID for generated tasks'),
      title_template: z.string().min(1).describe('Title template for generated tasks'),
      description_template: z.string().optional().describe('Description template for generated tasks'),
      task_type: z.string().min(1).describe('Task type for generated tasks. Resolve valid values with agent_hq_get_workflow_metadata.'),
      priority: z.enum(VALID_TASK_PRIORITIES).describe('Priority for generated tasks'),
      story_points: storyPointsSchema,
      status_on_create: z.string().min(1).describe('Initial workflow task status for generated tasks. Resolve valid values with agent_hq_get_workflow_metadata.'),
      schedule_expression: z.string().min(1).describe('Schedule expression: "every N minutes", "every day HH:mm", or "every <weekday> HH:mm"'),
      timezone: z.string().min(1).describe('IANA timezone for schedule evaluation, such as America/New_York'),
      enabled: z.boolean().optional().describe('Whether scheduling starts enabled; default true'),
      overlap_policy: overlapPolicySchema.optional().describe('How to behave when prior generated work is still active; default skip_if_active'),
      agent_id: z.number().int().positive().nullable().optional().describe('Optional agent assignment for generated tasks, or null for unassigned'),
      changed_by: changedBySchema,
    },
    (args) => wrap(() => api.createRecurringTaskSeries(args))(),
    { domain: 'recurring_task_series', rest_paths: ['/api/v1/recurring-task-series'] },
  );

  registerTool(
    ['agent_hq_update_recurring_task_series'],
    'Update editable fields on a recurring task series, including schedule, timezone, workflow, generated-task defaults, enabled state, overlap policy, and optional agent assignment.',
    {
      series_id: seriesIdSchema,
      project_id: z.number().int().positive().optional().describe('Project ID for generated tasks'),
      workflow_id: workflowIdSchema,
      title_template: z.string().min(1).optional().describe('Title template for generated tasks'),
      description_template: z.string().optional().describe('Description template for generated tasks'),
      task_type: z.string().min(1).optional().describe('Task type for generated tasks. Resolve valid values with agent_hq_get_workflow_metadata.'),
      priority: z.enum(VALID_TASK_PRIORITIES).optional().describe('Priority for generated tasks'),
      story_points: storyPointsSchema.optional(),
      status_on_create: z.string().min(1).optional().describe('Initial workflow task status for generated tasks. Resolve valid values with agent_hq_get_workflow_metadata.'),
      schedule_expression: z.string().min(1).optional().describe('Schedule expression: "every N minutes", "every day HH:mm", or "every <weekday> HH:mm"'),
      timezone: z.string().min(1).optional().describe('IANA timezone for schedule evaluation'),
      enabled: z.boolean().optional().describe('Whether scheduling is enabled'),
      overlap_policy: overlapPolicySchema.optional().describe('How to behave when prior generated work is still active'),
      agent_id: z.number().int().positive().nullable().optional().describe('Optional agent assignment for generated tasks, or null to clear'),
      changed_by: changedBySchema,
    },
    ({ series_id, ...data }) => wrap(() => api.updateRecurringTaskSeries(series_id, data))(),
    { domain: 'recurring_task_series', rest_paths: ['/api/v1/recurring-task-series/:id'] },
  );

  registerTool(
    ['agent_hq_enable_recurring_task_series'],
    'Enable scheduling for a recurring task series.',
    {
      series_id: seriesIdSchema,
      changed_by: changedBySchema,
    },
    ({ series_id, changed_by }) => wrap(() => api.enableRecurringTaskSeries(series_id, changed_by))(),
    { domain: 'recurring_task_series', rest_paths: ['/api/v1/recurring-task-series/:id/enable'] },
  );

  registerTool(
    ['agent_hq_disable_recurring_task_series'],
    'Disable scheduling for a recurring task series without deleting its configuration or history.',
    {
      series_id: seriesIdSchema,
      changed_by: changedBySchema,
    },
    ({ series_id, changed_by }) => wrap(() => api.disableRecurringTaskSeries(series_id, changed_by))(),
    { domain: 'recurring_task_series', rest_paths: ['/api/v1/recurring-task-series/:id/disable'] },
  );

  registerTool(
    ['agent_hq_run_recurring_task_series_now'],
    'Trigger one recurring task series immediately, creating a normal task now through the recurring-task scheduler path.',
    {
      series_id: seriesIdSchema,
      changed_by: changedBySchema,
    },
    ({ series_id, changed_by }) => wrap(() => api.runRecurringTaskSeriesNow(series_id, changed_by))(),
    { domain: 'recurring_task_series', rest_paths: ['/api/v1/recurring-task-series/:id/run-now'] },
  );
}
