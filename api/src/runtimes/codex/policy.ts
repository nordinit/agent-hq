/** Truthful model-visible built-ins retained by the hardened local adapter. */
export const CODEX_BUILT_IN_TOOLS = ['apply_patch', 'shell'] as const;

/** Fast is an execution tier, not an ambient tool. It is pinned separately. */
export const CODEX_FAST_MODE_FEATURE = 'fast_mode' as const;

/**
 * Codex 0.146 feature flags that can add ambient tools, remote surfaces,
 * hooks, plugins, app integrations, or unassigned capability discovery.
 * Assigned stdio MCP servers are configured separately and remain available.
 */
export const CODEX_DISABLED_AMBIENT_FEATURES = [
  'apps',
  'artifact',
  'auth_elicitation',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'chronicle',
  'code_mode',
  'code_mode_buffered_exec',
  'code_mode_host',
  'code_mode_only',
  'computer_use',
  'deferred_executor',
  'deferred_tool_world_state',
  'enable_mcp_apps',
  'executor_capability_discovery',
  'external_agent_memory_import',
  'goals',
  'hooks',
  'image_generation',
  'in_app_browser',
  'in_app_updates',
  'memories',
  'multi_agent',
  'multi_agent_v2',
  'network_proxy',
  'plugin_sharing',
  'plugins',
  'realtime_conversation',
  'remote_plugin',
  'request_permissions_tool',
  'skill_mcp_dependency_install',
  'skill_search',
  'shell_snapshot',
  'standalone_web_search',
  'tool_call_mcp_elicitation',
  'tool_suggest',
  'use_agent_identity',
  'workspace_dependencies',
] as const;

export const CODEX_RUNTIME_POLICY_REVISION = 'codex-local-tools-v2' as const;
