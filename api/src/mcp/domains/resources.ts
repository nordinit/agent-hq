import { VALID_TASK_PRIORITIES, VALID_TASK_STORY_POINTS } from '../apiClient';
import { getMcpCatalog } from '../catalog';
import { McpDomainContext } from '../registrar';

export function registerResourcesTools(ctx: McpDomainContext) {
  const { api, registerResource } = ctx;

  registerResource(
    [{ id: 'agent-hq-workflow-statuses', uri: 'agent-hq://workflow/statuses' }],
    () =>
      JSON.stringify({
        statuses_source: 'workflow_metadata',
        metadata_tool: 'agent_hq_get_workflow_metadata',
        note: 'Task statuses, their order and which are terminal are configured per workflow (or its workflow type). '
          + 'There is no global status list: read the statuses of your task\'s workflow with agent_hq_get_workflow_metadata '
          + 'and use only those.',
      }),
  );
  
  registerResource(
    [{ id: 'agent-hq-workflow-task-types', uri: 'agent-hq://workflow/task-types' }],
    () =>
      JSON.stringify({
        task_types_source: 'workflow_definition_config',
        legacy_default_task_types: [
          'frontend',
          'backend',
          'fullstack',
          'qa',
          'design',
          'marketing',
          'pm',
          'pm_analysis',
          'pm_operational',
          'ops',
          'data',
          'adhoc',
          'other',
        ],
        priorities: VALID_TASK_PRIORITIES,
        story_points: VALID_TASK_STORY_POINTS,
        default: 'backend',
      }),
  );
  
  registerResource(
    [{ id: 'agent-hq-projects-summary', uri: 'agent-hq://projects/summary' }],
    async () => {
      let projects: unknown[] = [];
      try {
        projects = await api.listProjects();
      } catch {
        // If the API is down, return an empty list rather than crashing resource discovery.
      }
      return JSON.stringify({ projects });
    },
  );
  
  registerResource(
    [{ id: 'agent-hq-catalog', uri: 'agent-hq://catalog' }],
    async () => JSON.stringify(ctx.getCatalog ? await ctx.getCatalog() : getMcpCatalog()),
  );
}
