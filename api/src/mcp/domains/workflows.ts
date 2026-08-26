import { z } from 'zod';
import { McpDomainContext } from '../registrar';

export function registerWorkflowsTools(ctx: McpDomainContext) {
  const { api, registerTool, wrap } = ctx;

  registerTool(
    ['agent_hq_list_workflows'],
    'List Agent HQ workflows. Workflows are the preferred name for boards/operating cycles; legacy sprint routes and fields remain supported.',
    {
      project_id: z.number().int().positive().optional().describe('Filter by project ID'),
      include_closed: z.boolean().optional().describe('Include closed workflows (default false)'),
    },
    ({ project_id, include_closed }) => wrap(() => api.listSprints({ project_id, include_closed }))(),
    { domain: 'workflows', rest_paths: ['/api/v1/workflows', '/api/v1/sprints'] },
  );
  
  registerTool(
    ['agent_hq_get_workflow'],
    'Get workflow detail and metrics.',
    { workflow_id: z.number().int().positive().describe('Workflow ID') },
    ({ workflow_id }) => wrap(() => api.getSprint(workflow_id))(),
    { domain: 'workflows', rest_paths: ['/api/v1/workflows/:id', '/api/v1/sprints/:id'] },
  );
  
  registerTool(
    ['agent_hq_update_workflow'],
    'Update a workflow in Agent HQ. Machine-readable legacy sprint fields remain accepted during compatibility.',
    {
      workflow_id: z.number().int().positive().describe('Workflow ID'),
      project_id: z.number().int().positive().optional().describe('Optional project reassignment request'),
      name: z.string().min(1).optional().describe('Workflow name'),
      goal: z.string().optional().describe('Workflow goal'),
      workflow_type: z.string().optional().describe('Workflow type key'),
      sprint_type: z.string().optional().describe('Legacy workflow type key alias'),
      status: z.enum(['planning', 'active', 'paused', 'complete', 'closed']).optional().describe('Workflow status'),
      length_kind: z.enum(['time', 'runs']).optional().describe('Workflow length kind'),
      length_value: z.string().optional().describe('Workflow length value'),
      started_at: z.string().nullable().optional().describe('Workflow start timestamp'),
      ended_at: z.string().nullable().optional().describe('Workflow end timestamp'),
      repo_access_mode: z.enum(['worktree', 'clone']).nullable().optional().describe('Workflow repository access mode'),
      repo_path: z.string().nullable().optional().describe('Workflow-owned local repo path for worktree mode'),
      repo_url: z.string().nullable().optional().describe('Workflow-owned git URL for clone mode'),
    },
    ({ workflow_id, workflow_type, ...patch }) => wrap(() => api.updateSprint(workflow_id, { ...patch, sprint_type: workflow_type ?? patch.sprint_type }))(),
    { domain: 'workflows', rest_paths: ['/api/v1/workflows/:id', '/api/v1/sprints/:id'] },
  );
  
  registerTool(
    ['agent_hq_delete_workflow'],
    'Delete a workflow in Agent HQ.',
    { workflow_id: z.number().int().positive().describe('Workflow ID') },
    ({ workflow_id }) => wrap(() => api.deleteSprint(workflow_id))(),
    { domain: 'workflows', rest_paths: ['/api/v1/workflows/:id', '/api/v1/sprints/:id'] },
  );
  
  // Legacy sprint aliases are intentionally grouped here. Prefer workflow-named tools in new clients; remove sprint aliases after compatibility consumers migrate.
  registerTool(
    ['agent_hq_create_workflow'],
    'Create a new workflow in Agent HQ, with optional dry-run preview. Machine-readable legacy sprint fields remain accepted during compatibility.',
    {
      project_id: z.number().int().positive().describe('Project ID (required)'),
      name: z.string().min(1).describe('Workflow name (required)'),
      goal: z.string().optional().describe('Workflow goal'),
      workflow_type: z.string().optional().describe('Workflow type key'),
      sprint_type: z.string().optional().describe('Legacy workflow type key alias'),
      source_workflow_id: z.number().int().positive().optional().describe('Optional source workflow to clone workflow-scoped setup from during creation'),
      source_sprint_id: z.number().int().positive().optional().describe('Legacy source sprint alias'),
      status: z.enum(['planning', 'active', 'paused', 'complete', 'closed']).optional().describe('Initial workflow status'),
      length_kind: z.enum(['time', 'runs']).optional().describe('Workflow length kind'),
      length_value: z.string().optional().describe('Workflow length value, e.g. 2w or 10'),
      started_at: z.string().nullable().optional().describe('Workflow start timestamp'),
      repo_access_mode: z.enum(['worktree', 'clone']).nullable().optional().describe('Workflow repository access mode'),
      repo_path: z.string().nullable().optional().describe('Workflow-owned local repo path for worktree mode'),
      repo_url: z.string().nullable().optional().describe('Workflow-owned git URL for clone mode'),
      dry_run: z.boolean().optional().describe('Return a mutation preview without writing data'),
    },
    ({ project_id, name, goal, workflow_type, sprint_type, source_workflow_id, source_sprint_id, status, length_kind, length_value, started_at, repo_access_mode, repo_path, repo_url, dry_run }) =>
      wrap(() => api.createSprint({
        project_id,
        name,
        goal,
        sprint_type: workflow_type ?? sprint_type,
        source_sprint_id: source_workflow_id ?? source_sprint_id,
        status,
        length_kind,
        length_value,
        started_at,
        repo_access_mode,
        repo_path,
        repo_url,
        dry_run,
      }))(),
    { domain: 'workflows', rest_paths: ['/api/v1/workflows', '/api/v1/sprints'] },
  );
}
