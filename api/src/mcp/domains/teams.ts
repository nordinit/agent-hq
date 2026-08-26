import { z } from 'zod';
import { McpDomainContext } from '../registrar';

/**
 * Team management over MCP, so Atlas can build and maintain teams rather than an operator
 * having to assemble every one by hand in the UI.
 *
 * The two tools worth knowing about:
 *   - agent_hq_preview_team_context returns the exact prose a member's prompt will carry, which
 *     is how an agent editing a team can check its own work.
 *   - agent_hq_apply_workflow_team_routing defaults to a dry run for a reason: it rewrites
 *     routing configuration, and an agent should look at the plan before executing it.
 */
export function registerTeamsTools(ctx: McpDomainContext) {
  const { api, registerTool, wrap } = ctx;

  registerTool(
    ['agent_hq_list_teams'],
    'List agent teams.',
    {},
    () => wrap(() => api.listTeams())(),
    { domain: 'teams', rest_paths: ['/api/v1/teams'] },
  );

  registerTool(
    ['agent_hq_get_team'],
    'Get a team by ID.',
    { team_id: z.number().int().positive().describe('Team ID') },
    ({ team_id }) => wrap(() => api.getTeam(team_id))(),
    { domain: 'teams', rest_paths: ['/api/v1/teams/:id'] },
  );

  registerTool(
    ['agent_hq_create_team'],
    'Create a team. goal and charter are injected into every member\'s prompt.',
    {
      name: z.string().min(1).describe('Display name'),
      slug: z.string().optional().describe('Unique slug; derived from name when omitted'),
      description: z.string().optional().describe('Operator-facing description'),
      goal: z.string().optional().describe('Shared goal, injected into every member prompt'),
      charter: z.string().optional().describe('Working agreements, injected into every member prompt'),
      project_id: z.number().int().positive().optional().describe('Optional project scope'),
      skill_names: z.array(z.string()).optional().describe('Skills granted to every member'),
      enabled: z.boolean().optional().describe('Enabled flag'),
    },
    (args) => wrap(() => api.createTeam(args))(),
    { domain: 'teams', rest_paths: ['/api/v1/teams'] },
  );

  registerTool(
    ['agent_hq_update_team'],
    'Update a team. Any change to goal, charter or membership bumps its context version.',
    {
      team_id: z.number().int().positive().describe('Team ID'),
      patch: z.record(z.string(), z.unknown()).describe('Partial update payload'),
    },
    ({ team_id, patch }) => wrap(() => api.updateTeam(team_id, patch))(),
    { domain: 'teams', rest_paths: ['/api/v1/teams/:id'] },
  );

  registerTool(
    ['agent_hq_delete_team'],
    'Soft-delete a team. Workflows and materialized routing rules keep their provenance.',
    { team_id: z.number().int().positive().describe('Team ID') },
    ({ team_id }) => wrap(() => api.deleteTeam(team_id))(),
    { domain: 'teams', rest_paths: ['/api/v1/teams/:id'] },
  );

  registerTool(
    ['agent_hq_list_team_members'],
    'List the members of a team.',
    { team_id: z.number().int().positive().describe('Team ID') },
    ({ team_id }) => wrap(() => api.listTeamMembers(team_id))(),
    { domain: 'teams', rest_paths: ['/api/v1/teams/:id/members'] },
  );

  registerTool(
    ['agent_hq_add_team_member'],
    'Add an agent to a team. An agent may belong to several teams but only one primary team.',
    {
      team_id: z.number().int().positive().describe('Team ID'),
      agent_id: z.number().int().positive().describe('Agent ID'),
      member_role: z.string().optional().describe('Role on this team, e.g. Reviewer'),
      responsibilities: z.string().optional().describe('What this member does, shown to teammates'),
      is_lead: z.boolean().optional().describe('Team lead flag'),
      is_primary: z.boolean().optional().describe('Primary team for this agent; at most one'),
      sort_order: z.number().int().optional().describe('Roster ordering'),
      enabled: z.boolean().optional().describe('Enabled flag'),
    },
    ({ team_id, ...rest }) => wrap(() => api.addTeamMember(team_id, rest))(),
    { domain: 'teams', rest_paths: ['/api/v1/teams/:id/members'] },
  );

  registerTool(
    ['agent_hq_update_team_member'],
    'Update an agent\'s role on a team.',
    {
      team_id: z.number().int().positive().describe('Team ID'),
      agent_id: z.number().int().positive().describe('Agent ID'),
      patch: z.record(z.string(), z.unknown()).describe('Partial update payload'),
    },
    ({ team_id, agent_id, patch }) => wrap(() => api.updateTeamMember(team_id, agent_id, patch))(),
    { domain: 'teams', rest_paths: ['/api/v1/teams/:id/members/:agentId'] },
  );

  registerTool(
    ['agent_hq_remove_team_member'],
    'Remove an agent from a team.',
    {
      team_id: z.number().int().positive().describe('Team ID'),
      agent_id: z.number().int().positive().describe('Agent ID'),
    },
    ({ team_id, agent_id }) => wrap(() => api.removeTeamMember(team_id, agent_id))(),
    { domain: 'teams', rest_paths: ['/api/v1/teams/:id/members/:agentId'] },
  );

  registerTool(
    ['agent_hq_list_team_tools'],
    'List registry tools granted to every member of a team.',
    { team_id: z.number().int().positive().describe('Team ID') },
    ({ team_id }) => wrap(() => api.listTeamTools(team_id))(),
    { domain: 'teams', rest_paths: ['/api/v1/teams/:id/tools'] },
  );

  registerTool(
    ['agent_hq_assign_tool_to_team'],
    'Grant a registry tool to every member of a team.',
    {
      team_id: z.number().int().positive().describe('Team ID'),
      tool_id: z.number().int().positive().describe('Tool ID'),
      overrides: z.record(z.string(), z.unknown()).optional().describe('Assignment overrides'),
      enabled: z.boolean().optional().describe('Enabled flag'),
    },
    ({ team_id, tool_id, overrides, enabled }) =>
      wrap(() => api.assignToolToTeam(team_id, tool_id, overrides, enabled))(),
    { domain: 'teams', rest_paths: ['/api/v1/teams/:id/tools'] },
  );

  registerTool(
    ['agent_hq_remove_tool_from_team'],
    'Revoke a team-wide registry tool grant.',
    {
      team_id: z.number().int().positive().describe('Team ID'),
      tool_id: z.number().int().positive().describe('Tool ID'),
    },
    ({ team_id, tool_id }) => wrap(() => api.removeToolFromTeam(team_id, tool_id))(),
    { domain: 'teams', rest_paths: ['/api/v1/teams/:id/tools/:toolId'] },
  );

  registerTool(
    ['agent_hq_list_team_mcp_servers'],
    'List MCP servers granted to every member of a team.',
    { team_id: z.number().int().positive().describe('Team ID') },
    ({ team_id }) => wrap(() => api.listTeamMcpServers(team_id))(),
    { domain: 'teams', rest_paths: ['/api/v1/teams/:id/mcp-servers'] },
  );

  registerTool(
    ['agent_hq_assign_mcp_server_to_team'],
    'Grant an MCP server to every member of a team.',
    {
      team_id: z.number().int().positive().describe('Team ID'),
      mcp_server_id: z.number().int().positive().describe('MCP server ID'),
      overrides: z.record(z.string(), z.unknown()).optional().describe('Assignment overrides'),
      enabled: z.boolean().optional().describe('Enabled flag'),
    },
    ({ team_id, mcp_server_id, overrides, enabled }) =>
      wrap(() => api.assignMcpServerToTeam(team_id, mcp_server_id, overrides, enabled))(),
    { domain: 'teams', rest_paths: ['/api/v1/teams/:id/mcp-servers'] },
  );

  registerTool(
    ['agent_hq_remove_mcp_server_from_team'],
    'Revoke a team-wide MCP server grant.',
    {
      team_id: z.number().int().positive().describe('Team ID'),
      mcp_server_id: z.number().int().positive().describe('MCP server ID'),
    },
    ({ team_id, mcp_server_id }) => wrap(() => api.removeMcpServerFromTeam(team_id, mcp_server_id))(),
    { domain: 'teams', rest_paths: ['/api/v1/teams/:id/mcp-servers/:serverId'] },
  );

  registerTool(
    ['agent_hq_list_team_routing_rules'],
    'List a team\'s default routing rules. These are templates, not live routing.',
    { team_id: z.number().int().positive().describe('Team ID') },
    ({ team_id }) => wrap(() => api.listTeamRoutingRules(team_id))(),
    { domain: 'teams', rest_paths: ['/api/v1/teams/:id/routing-rules'] },
  );

  registerTool(
    ['agent_hq_create_team_routing_rule'],
    'Add a default routing rule to a team. Target either a member agent or a member_role; '
    + 'role targeting keeps the template portable when membership changes.',
    {
      team_id: z.number().int().positive().describe('Team ID'),
      status: z.string().min(1).describe('Task status this rule routes'),
      workflow_type: z.string().optional().describe('Workflow type, or omit to apply to any'),
      task_type: z.string().optional().describe('Task type, or omit to apply to any'),
      agent_id: z.number().int().positive().optional().describe('Target agent; must be a team member'),
      member_role: z.string().optional().describe('Target role, resolved to whoever holds it'),
      priority: z.number().int().optional().describe('Rule priority'),
      enabled: z.boolean().optional().describe('Enabled flag'),
    },
    ({ team_id, ...rest }) => wrap(() => api.createTeamRoutingRule(team_id, rest))(),
    { domain: 'teams', rest_paths: ['/api/v1/teams/:id/routing-rules'] },
  );

  registerTool(
    ['agent_hq_delete_team_routing_rule'],
    'Delete a team default routing rule. Already-materialized workflow rules are left in place.',
    {
      team_id: z.number().int().positive().describe('Team ID'),
      rule_id: z.number().int().positive().describe('Team routing rule ID'),
    },
    ({ team_id, rule_id }) => wrap(() => api.deleteTeamRoutingRule(team_id, rule_id))(),
    { domain: 'teams', rest_paths: ['/api/v1/teams/:id/routing-rules/:ruleId'] },
  );

  registerTool(
    ['agent_hq_preview_team_context'],
    'Render the exact team context block a given member will receive in its prompt.',
    {
      team_id: z.number().int().positive().describe('Team ID'),
      agent_id: z.number().int().positive().describe('Agent ID to render the block for'),
    },
    ({ team_id, agent_id }) => wrap(() => api.previewTeamContext(team_id, agent_id))(),
    { domain: 'teams', rest_paths: ['/api/v1/teams/:id/context-preview'] },
  );

  registerTool(
    ['agent_hq_list_agent_teams'],
    'List the teams an agent belongs to.',
    { agent_id: z.number().int().positive().describe('Agent ID') },
    ({ agent_id }) => wrap(() => api.listAgentTeams(agent_id))(),
    { domain: 'teams', rest_paths: ['/api/v1/agents/:id/teams'] },
  );

  registerTool(
    ['agent_hq_get_agent_effective_capabilities'],
    'The tools, MCP servers and skills an agent actually gets at dispatch, each labelled as its '
    + 'own grant or inherited from a team.',
    { agent_id: z.number().int().positive().describe('Agent ID') },
    ({ agent_id }) => wrap(() => api.getAgentEffectiveCapabilities(agent_id))(),
    { domain: 'teams', rest_paths: ['/api/v1/agents/:id/effective-capabilities'] },
  );

  registerTool(
    ['agent_hq_set_workflow_team'],
    'Assign a team to a workflow, or pass team_id null to clear it. Changes team context '
    + 'injection immediately; does not touch routing.',
    {
      workflow_id: z.number().int().positive().describe('Workflow ID'),
      team_id: z.number().int().positive().nullable().describe('Team ID, or null to clear'),
    },
    ({ workflow_id, team_id }) => wrap(() => api.setWorkflowTeam(workflow_id, team_id))(),
    { domain: 'teams', rest_paths: ['/api/v1/workflows/:workflowId/team'] },
  );

  registerTool(
    ['agent_hq_apply_workflow_team_routing'],
    'Stamp the owning team\'s routing template onto a workflow. Defaults to a dry run — pass '
    + 'dry_run false to write. Conflicts and operator-edited rules are reported, never overwritten.',
    {
      workflow_id: z.number().int().positive().describe('Workflow ID'),
      dry_run: z.boolean().optional().describe('Preview only; defaults to true'),
    },
    ({ workflow_id, dry_run }) =>
      wrap(() => api.applyWorkflowTeamRouting(workflow_id, dry_run !== false))(),
    { domain: 'teams', rest_paths: ['/api/v1/workflows/:workflowId/team/apply-routing'] },
  );
}
