/** Required Agent HQ lifecycle methods are reserved MCP names, never built-ins. */
export const REQUIRED_AGENT_HQ_LIFECYCLE_TOOL_NAMES = [
  'agent_hq_post_task_outcome',
  'agent_hq_start_task_run',
] as const;
