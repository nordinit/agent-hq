/**
 * Agent HQ MCP Server — Tool Profiles
 *
 * The full Agent HQ catalog registers ~186 tools, one name each. That is the right surface for
 * a local stdio client driving the whole product and the wrong one for a remote connector:
 * Claude and ChatGPT load every tool definition into the conversation before the user has asked
 * for anything, so the full surface spends more context on the menu than on the work.
 *
 * A profile is a named allow-list of *exposed tool names*; only the listed names are registered
 * on the server. `full` is the historical behaviour and stays the default so the stdio server
 * and every existing client are unchanged.
 *
 * A profile narrows what a client can *see*. It is not an authorization boundary: every tool
 * call still goes through the Agent HQ API with the caller's MCP key, so the capability policy
 * in mcpApiAuth remains the thing that decides what the call may touch. Pair a narrow profile
 * with a matching capability policy — see docs/agent-hq-mcp.md.
 */

export interface McpToolProfile {
  name: string;
  description: string;
  /** Exposed tool names, or null to expose every registered tool. */
  toolNames: ReadonlySet<string> | null;
  /**
   * The MCP capability policy this profile is designed against, as keys from
   * AGENT_MCP_CAPABILITY_CATALOG. Kept beside the tool list because the two only make sense
   * together: a tool the policy denies is a 403 the client discovers at the worst moment, and a
   * capability no tool uses is standing granted for nothing. Applied by
   * src/bin/provision-remote-mcp-identity.ts; null means "whatever the identity already has".
   */
  capabilities: readonly string[] | null;
}

/**
 * Phone-sized surface: read the board, file and update work, move a workflow through its
 * lifecycle, run the recurring series that drive scheduled automation. Deliberately excluded —
 * configuration surfaces (agents, skills, routing, workflow definitions, teams, tools, MCP
 * servers), file upload/download, and the dispatch-scoped lifecycle writes (evidence, outcomes,
 * run check-ins) that only mean something for an agent that owns a dispatched run.
 *
 * Workflow lifecycle is in while workflow *definitions* stay out, and the line between them is
 * the point: pausing a cycle from a phone is an operator deciding when work runs, whereas
 * defining a workflow type is design work that wants the canvas.
 *
 * Names here are the tools' own names — since every tool answers to exactly one name, a profile
 * entry that no longer resolves is a typo, which the profile tests catch.
 */
const MOBILE_TOOL_NAMES: readonly string[] = [
  // Board reads
  'agent_hq_list_projects',
  'agent_hq_get_project',
  'agent_hq_list_workflows',
  'agent_hq_get_workflow',
  'agent_hq_get_workflow_metadata',
  'agent_hq_list_tasks',
  'agent_hq_get_task',
  'agent_hq_get_task_notes',
  'agent_hq_get_task_history',
  'agent_hq_list_task_relationships',
  'agent_hq_get_task_relationship_types',
  'agent_hq_search_project_tasks',
  'agent_hq_list_recurring_task_series',
  'agent_hq_get_recurring_task_series',

  // Task writes
  'agent_hq_create_task',
  'agent_hq_update_task',
  'agent_hq_move_task',
  'agent_hq_add_task_note',
  'agent_hq_create_task_relationship',

  // Workflow lifecycle. The board's own pause/resume/complete controls, which is a different
  // thing from the workflow *configuration* excluded below: this moves a cycle the operator
  // already set up between its statuses, it does not define or reshape one.
  'agent_hq_set_workflow_status',

  // Scheduled automation
  'agent_hq_create_recurring_task_series',
  'agent_hq_update_recurring_task_series',
  'agent_hq_enable_recurring_task_series',
  'agent_hq_disable_recurring_task_series',
  'agent_hq_run_recurring_task_series_now',
];

/**
 * The capability policy the mobile profile is built against. Several of these exist for this
 * shape of client: `projects.read_project_board` makes a board legible to an identity that owns
 * no dispatched task, `tasks.write_project_notes` lets it comment on work it is not executing,
 * and the two `sprints.*_active_sprint` writes let it work the lifecycle controls of a workflow
 * it is not running — all of which resolve through the assigned project rather than a dispatched
 * task. The rest are existing project-scoped grants. Notably absent: every admin key, both
 * cross-tenant grants, and `tasks.write_active_lifecycle` — a connector should not be able to
 * report evidence or an outcome for a run it is not executing.
 */
const MOBILE_PROFILE_CAPABILITIES: readonly string[] = [
  'discovery.read_catalog',
  'projects.read_project_board',
  'projects.read_active_project',
  'sprints.read_active_sprint',
  'sprints.pause_active_sprint',
  'sprints.complete_active_sprint',
  'workflow_definitions.read_project_scope',
  'tasks.read_project_context',
  'tasks.manage_project_tasks',
  'tasks.write_project_notes',
  'tasks.search_project_tasks',
  'recurring_task_series.read_project_scope',
  'recurring_task_series.manage_project_scope',
];

export const MCP_TOOL_PROFILES: Readonly<Record<string, McpToolProfile>> = {
  full: {
    name: 'full',
    description: 'Every registered tool. Default; used by the stdio server.',
    toolNames: null,
    capabilities: null,
  },
  mobile: {
    name: 'mobile',
    description: 'Board reads, task writes, and recurring task series for a remote/phone MCP client.',
    toolNames: new Set(MOBILE_TOOL_NAMES),
    capabilities: MOBILE_PROFILE_CAPABILITIES,
  },
};

export const DEFAULT_MCP_TOOL_PROFILE = 'full';

export function listMcpToolProfileNames(): string[] {
  return Object.keys(MCP_TOOL_PROFILES);
}

/**
 * Resolves a profile by name. Throws on an unknown name rather than silently falling back to
 * `full`: a typo in a connector's environment should fail the server's boot, not quietly hand
 * a remote client the entire administrative surface.
 */
export function resolveMcpToolProfile(name?: string | null): McpToolProfile {
  const requested = (name ?? '').trim() || DEFAULT_MCP_TOOL_PROFILE;
  const profile = MCP_TOOL_PROFILES[requested];
  if (!profile) {
    throw new Error(
      `Unknown Agent HQ MCP tool profile "${requested}". Known profiles: ${listMcpToolProfileNames().join(', ')}.`,
    );
  }
  return profile;
}

/** Names this profile exposes out of a tool's registered name list. */
export function selectProfileToolNames(profile: McpToolProfile, names: readonly string[]): string[] {
  if (!profile.toolNames) return [...names];
  return names.filter((name) => profile.toolNames!.has(name));
}
