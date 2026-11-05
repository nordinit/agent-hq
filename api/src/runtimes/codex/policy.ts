/**
 * Truthful model-visible built-ins retained by the hardened local adapter.
 *
 * Verified on Codex 0.164.0 with gpt-6.1-sol and this policy by capturing the
 * Responses request and the runtime `ALL_TOOLS` list. Code-mode models see a
 * top-level `exec`/`wait` pair (a JavaScript isolate without file system or
 * network access that only composes the nested tools below). `request_user_input`
 * stays model-visible but `codex exec` rejects it immediately ("not supported
 * in exec mode"), so it cannot block or reach a human. Assigned MCP tools are
 * added per agent and are not listed here.
 */
export const CODEX_BUILT_IN_TOOLS = [
  'apply_patch',
  'clock__curr_time',
  'exec',
  'exec_command',
  'list_mcp_resource_templates',
  'list_mcp_resources',
  'read_mcp_resource',
  'request_user_input',
  'request_user_input_async',
  'wait',
  'write_stdin',
] as const;

/** Fast is an execution tier, not an ambient tool. It is pinned separately. */
export const CODEX_FAST_MODE_FEATURE = 'fast_mode' as const;

/**
 * Codex 0.164 feature flags that can add ambient tools, remote surfaces,
 * background daemons, hooks, plugins, app integrations, deferred MCP tools or
 * unassigned capability discovery. Assigned stdio MCP servers are configured
 * separately and remain available. Every name must exist in the pinned CLI:
 * 0.164 rejects unknown feature names ("Unknown feature flag").
 *
 * `code_mode_host` is deliberately NOT disabled: gpt-6.x models ship with
 * `tool_mode = "code_mode_only"`, and without the host Codex "fails closed" and
 * the model cannot call any tool. The host runs the bundled
 * `codex-code-mode-host` isolate; it adds no capability beyond the nested tools.
 * `code_mode` and `code_mode_only` stay disabled so models that do not require
 * code mode keep direct tools.
 */
export const CODEX_DISABLED_AMBIENT_FEATURES = [
  'agent_message_board',
  'apps',
  'artifact',
  'auth_elicitation',
  'browser_annotation_api',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'chronicle',
  'code_mode',
  'code_mode_buffered_exec',
  'code_mode_only',
  'computer_use',
  'daemon_auto_start',
  'deferred_executor',
  'deferred_tool_world_state',
  'enable_fanout',
  'enable_mcp_apps',
  'executor_capability_discovery',
  'external_agent_memory_import',
  'goals',
  'guardian_approval',
  'hooks',
  'image_generation',
  'in_app_browser',
  'in_app_chat',
  'in_app_dictation',
  'in_app_local_automation',
  'in_app_updates',
  'in_app_voice',
  'js_repl',
  'memories',
  'multi_agent',
  'multi_agent_mode',
  'multi_agent_v2',
  'network_proxy',
  'plugin_hooks',
  'plugin_sharing',
  'plugins',
  'realtime_conversation',
  'recommended_plugins',
  'remote_control',
  'remote_plugin',
  'request_permissions_tool',
  'skill_mcp_dependency_install',
  'skill_search',
  'shell_snapshot',
  'sleep_tool',
  'standalone_web_search',
  'tool_call_mcp_elicitation',
  'tool_search_always_defer_mcp_tools',
  'tool_suggest',
  'ultrafast_mode',
  'use_agent_identity',
  'view_image',
  'workspace_dependencies',
  'worktrees',
] as const;

/**
 * Config overrides that close surfaces 0.164 no longer gates behind feature
 * flags. Values are TOML literals passed as `-c key=value`.
 *
 * - agents.enabled: gpt-6.x models declare `multi_agent_version = "v2"`, which
 *   adds seven `collaboration.*` sub-agent tools regardless of the
 *   multi_agent/multi_agent_v2 features. Only this key removes them.
 * - skills.include_instructions / skills.bundled.enabled: 0.164 injects skills
 *   from the host-wide ~/.agents/skills root plus bundled system skills
 *   (imagegen, skill-installer, ...). 0.146 under this policy injected none.
 * - web_search: pinned off as defense in depth (0.146 exposed a web_search tool
 *   despite standalone_web_search being disabled). 0.164 deprecates the
 *   web_search_cached/web_search_request features in favour of this key.
 */
export const CODEX_POLICY_CONFIG_OVERRIDES: ReadonlyArray<readonly [string, string]> = [
  ['agents.enabled', 'false'],
  ['skills.include_instructions', 'false'],
  ['skills.bundled.enabled', 'false'],
  ['web_search', '"disabled"'],
];

/**
 * Assigned MCP servers are gated by Agent HQ's per-agent tool allowlist
 * (`enabled_tools`). Codex 0.164 otherwise asks for approval on MCP calls and,
 * with approval_policy "never", fails every call ("MCP tool call requires
 * approval, but approval policy is never").
 */
export const CODEX_MCP_TOOLS_APPROVAL_MODE = 'approve' as const;

export const CODEX_RUNTIME_POLICY_REVISION = 'codex-local-tools-v3-0164' as const;
