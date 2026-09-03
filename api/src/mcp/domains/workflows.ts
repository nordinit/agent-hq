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
  
  // Workflow lifecycle. One tool with a status enum rather than four verb-shaped tools: unlike
  // the run-lifecycle tools, whose payloads genuinely differ, every transition here takes the
  // same two arguments, so four tools would be four near-identical schemas loaded into every
  // conversation — exactly the cost the narrowed tool profiles exist to avoid.
  //
  // The status routes the call, because the transitions are not the same kind of write.
  // Completing and closing have their own endpoints that stamp ended_at, and completing also
  // stands down the workflow's agents; a PUT that only sets status = 'complete' would leave a
  // workflow that reads as finished but never ended. Pausing and resuming really are field
  // writes, which is what the canvas does for those buttons too.
  registerTool(
    ['agent_hq_set_workflow_status'],
    'Move an Agent HQ workflow through its lifecycle: pause a running workflow, resume a paused one, or end the cycle by completing or closing it. Completing stamps the end date and stands down the workflow\'s agents; pausing is a reversible hold that does neither. A completed or closed workflow can be reopened by setting it back to active.',
    {
      workflow_id: z.number().int().positive().describe('Workflow ID'),
      status: z.enum(['planning', 'active', 'paused', 'complete', 'closed'])
        .describe('Target lifecycle status. active resumes (or reopens) a workflow, paused holds it, complete ends the cycle and stands down its agents, closed ends it without the agent stand-down.'),
      note: z.string().optional().describe('Optional reason, recorded on the audit entry for this change'),
    },
    ({ workflow_id, status, note }) => wrap(() => {
      if (status === 'complete') return api.completeSprint(workflow_id, note ? { note } : {});
      if (status === 'closed') return api.closeSprint(workflow_id, note ? { note } : {});
      return api.updateSprint(workflow_id, note ? { status, note } : { status });
    })(),
    {
      domain: 'workflows',
      rest_paths: [
        '/api/v1/workflows/:id',
        '/api/v1/workflows/:id/complete',
        '/api/v1/workflows/:id/close',
      ],
    },
  );

  registerTool(
    ['agent_hq_update_workflow'],
    'Update a workflow in Agent HQ: name, goal, type, length, dates, and repository configuration. Machine-readable legacy sprint fields remain accepted during compatibility. To pause, resume, complete, or close a workflow, prefer agent_hq_set_workflow_status — it routes completion through the endpoint that ends the cycle properly.',
    {
      workflow_id: z.number().int().positive().describe('Workflow ID'),
      project_id: z.number().int().positive().optional().describe('Optional project reassignment request'),
      name: z.string().min(1).optional().describe('Workflow name'),
      goal: z.string().optional().describe('Workflow goal'),
      workflow_type: z.string().optional().describe('Workflow type key'),
      sprint_type: z.string().optional().describe('Legacy workflow type key alias'),
      status: z.enum(['planning', 'active', 'paused', 'complete', 'closed']).optional().describe('Workflow status. Writes the field directly; for lifecycle changes use agent_hq_set_workflow_status, which routes complete and closed through the endpoints that stamp the end date.'),
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
