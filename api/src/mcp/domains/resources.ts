import { VALID_TASK_PRIORITIES, VALID_TASK_STATUSES, VALID_TASK_STORY_POINTS } from '../apiClient';
import { getMcpCatalog } from '../catalog';
import { McpDomainContext } from '../registrar';

export function registerResourcesTools(ctx: McpDomainContext) {
  const { api, registerResource } = ctx;

  registerResource(
    [
      { id: 'agent-hq-workflow-statuses', uri: 'agent-hq://workflow/statuses' },
      { id: 'atlas-workflow-statuses', uri: 'atlas://workflow/statuses' },
    ],
    () =>
      JSON.stringify({
        default_statuses: VALID_TASK_STATUSES,
        statuses_source: 'workflow_metadata',
        metadata_tool: 'agent_hq_get_workflow_metadata',
        pipeline: 'todo → ready → dispatched → in_progress → dev_deploy_queued → dev_deploying → review → ready_to_merge → deployed → done',
        terminal: ['done', 'cancelled', 'failed'],
        other: ['stalled', 'blocked'],
      }),
  );
  
  registerResource(
    [
      { id: 'agent-hq-workflow-task-types', uri: 'agent-hq://workflow/task-types' },
      { id: 'atlas-workflow-task-types', uri: 'atlas://workflow/task-types' },
    ],
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
    [
      { id: 'agent-hq-projects-summary', uri: 'agent-hq://projects/summary' },
      { id: 'atlas-projects-summary', uri: 'atlas://projects/summary' },
    ],
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
    [
      { id: 'agent-hq-catalog', uri: 'agent-hq://catalog' },
      { id: 'atlas-catalog', uri: 'atlas://catalog' },
    ],
    () => JSON.stringify(getMcpCatalog()),
  );
}
