/**
 * runtimes/claudeCode/types.ts — shared contracts for the CLI-backed
 * claude-code runtime.
 *
 * This file is the keystone: every other module in this directory imports its
 * types from here so the leaf modules (config, args, errors, mcpConfig) stay
 * independently testable and free of circular imports.
 *
 * Design reference: docs/architecture/claude-code-runtime-v2.md
 */

// ── Runtime config ───────────────────────────────────────────────────────────

/**
 * Effort levels accepted by `claude --effort`.
 *
 * NOTE `xhigh` — it sits between `high` and `max` and is the recommended level
 * for coding/agentic work. The pre-existing claude-code config types omitted it
 * (api/src/domains/agents/runtimeConfig.ts, api/src/runtimes/ClaudeCodeRuntime.ts),
 * which silently capped Agent HQ agents below the CLI's best setting.
 */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

/**
 * Permission postures Agent HQ is willing to run the CLI under.
 *
 * `bypass`  — `--dangerously-skip-permissions`. Correct for a task worktree on a
 *             host Agent HQ already controls.
 * `allowlist` — `--allowedTools <curated list>`. Correct when the execution
 *             target is less trusted, and the only posture that can express a
 *             per-MCP-server tool allowlist.
 */
export const CLAUDE_PERMISSION_MODES = ['bypass', 'allowlist'] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

/**
 * Productive local default without the unrestricted bypass-permissions flag.
 *
 * `--tools` is the EXCLUSIVE availability boundary, so anything absent here does
 * not exist for the agent — there is no prompt-to-approve fallback in a headless
 * run. WebFetch/WebSearch are included because research-shaped tasks are ordinary
 * agent work and were previously impossible without editing every agent by hand.
 *
 * Verified against Claude Code 2.1.224 by reading the `system/init` event's
 * `tools` array: every name below resolves. Note that unknown tool names are
 * SILENTLY DROPPED by the CLI (`TodoWrite`, `BashOutput`, `KillShell`,
 * `SlashCommand` and `Skill` all vanish without error), so never add a name here
 * without confirming it appears in that array first. Note also that `Glob` and
 * `Grep` are real but are NOT part of the CLI's own `--tools default` set, which
 * is precisely why this list is explicit rather than delegated to `default`.
 */
export const DEFAULT_CLAUDE_ALLOWED_TOOLS = [
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'Read',
  'WebFetch',
  'WebSearch',
  'Write',
] as const;

/**
 * Agent-level `runtime_config` for `runtime_type: 'claude-code'`.
 *
 * Every field is optional. This is deliberate and load-bearing:
 * `PUT /agents/:id` re-validates the STORED runtime_config whenever the request
 * body omits it (api/src/routes/agents.ts:1671), so adding a required field
 * would retroactively 400 every unrelated update to an existing claude-code
 * agent — including the three seeded dev agents in api/src/db/seed-dev.ts.
 */
export interface ClaudeCodeRuntimeConfig {
  /**
   * Fallback working directory. Only consulted when dispatch supplies neither
   * `activeRepoRoot` nor `workspaceRoot`; it must never outrank the resolved
   * active repo root.
   */
  workingDirectory?: string;
  /** Absolute path or PATH-resolved command. Defaults to `claude`. */
  claudeBin?: string;
  model?: string;
  effort?: ClaudeEffortLevel;
  /** Built-in tool names to allow. Omit for the CLI's default tool set. */
  allowedTools?: string[];
  /** Built-in tool names to deny. */
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  permissionMode?: ClaudePermissionMode;
  /** Explicit safety latch required with permissionMode=bypass. */
  allowDangerousBypass?: boolean;
  /** Appended to the system prompt on fresh sessions only. */
  systemPromptSuffix?: string;
  /** Extra CLI args. Limited to a small, argument-free allowlist. */
  extraArgs?: string[];
  /** Extra environment for the child process. String values only. */
  env?: Record<string, string>;
  /** Grace period between SIGTERM and SIGKILL. Defaults to 10000. */
  killGraceMs?: number;
  /**
   * Isolate Claude Code state (credentials, sessions, settings) per agent by
   * pointing CLAUDE_CONFIG_DIR here. Unset means the CLI inherits the API
   * process's `~/.claude`, which shares credentials across every agent.
   */
  claudeConfigDir?: string;
  /** Opaque selected provider-home reference injected by the provider adapter. */
  providerConnectionExternalRef?: string;
  [key: string]: unknown;
}

/** Config after validation, with every default applied. */
export interface NormalizedClaudeCodeRuntimeConfig {
  workingDirectory: string | null;
  claudeBin: string;
  model: string | null;
  effort: ClaudeEffortLevel | null;
  allowedTools: string[];
  disallowedTools: string[];
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  permissionMode: ClaudePermissionMode;
  allowDangerousBypass: boolean;
  systemPromptSuffix: string | null;
  extraArgs: string[];
  env: Record<string, string>;
  killGraceMs: number;
  claudeConfigDir: string | null;
  providerConnectionExternalRef: string | null;
}

// ── argv construction ────────────────────────────────────────────────────────

/**
 * Everything `buildClaudeArgs` needs. Modelled as one explicit payload rather
 * than a pile of positional parameters so that the runtime boundary for a
 * dispatched node is a single inspectable object (sprint 111 #906).
 *
 * The prompt is NOT part of this payload — it is written to the child's stdin,
 * because `--print -` reads the prompt from stdin. Putting a multi-KB prompt in
 * argv would risk E2BIG on large task contexts.
 */
export interface ClaudeArgsInput {
  config: NormalizedClaudeCodeRuntimeConfig;
  /** Pre-minted session UUID passed as `--session-id`. */
  sessionId: string;
  /** Per-dispatch model override; outranks config.model. */
  model?: string | null;
  /** Path to the run-scoped mcp-config.json, when MCP servers were materialized. */
  mcpConfigPath?: string | null;
  /**
   * Fully-qualified MCP tool names (`mcp__<server>__<tool>`) the agent is
   * permitted to call, derived from each server's `toolFilter.include`.
   *
   * This exists because the Claude Code CLI IGNORES the `toolFilter` key that
   * Agent HQ's materializer writes into each server entry. Without translating
   * it into an explicit allowlist, Agent HQ's fail-CLOSED tool policy silently
   * becomes fail-OPEN. See mcpConfig.ts.
   */
  mcpAllowedToolNames?: string[];
  /** Path to a file appended to the system prompt (fresh sessions only). */
  appendSystemPromptFilePath?: string | null;
  /** Extra directories to grant tool access to. */
  addDirs?: string[];
}

// ── Error classification ─────────────────────────────────────────────────────

/**
 * Normalized failure classes for a claude-code run.
 *
 * `infra` maps to Agent HQ's `infra_failed` (the run never had a fair chance:
 * auth, quota, model availability, MCP wiring), `runtime` to `runtime_failed`
 * (the agent ran but the work failed).
 */
export type ClaudeFailureFamily = 'infra' | 'runtime' | 'none';

export type ClaudeErrorCode =
  | 'claude_auth_required'
  | 'provider_quota'
  | 'claude_transient_upstream'
  | 'model_not_found'
  | 'max_turns_exhausted'
  | 'max_budget_exhausted'
  | 'claude_refusal'
  | 'mcp_not_ready'
  | 'timeout'
  | 'aborted'
  | 'spawn_failed'
  | 'nonzero_exit'
  | 'no_result';

export interface ClaudeFailureClassification {
  code: ClaudeErrorCode;
  family: ClaudeFailureFamily;
  /** Single-line human summary suitable for `runtime_end_error`. */
  summary: string;
  /**
   * Earliest time a retry could succeed, when the CLI told us. Derived from the
   * structured `rate_limit_event.rate_limit_info.resetsAt` (epoch seconds)
   * rather than scraped from error prose.
   */
  retryNotBefore?: string | null;
}

// ── MCP materialization ──────────────────────────────────────────────────────

/** Result of writing the run-scoped mcp-config.json. */
export interface ClaudeMcpMaterialization {
  /** Absolute path to the written config, or null when no servers were assigned. */
  configPath: string | null;
  /** Server names written, e.g. `agent-hq__agent-42`. */
  serverNames: string[];
  /**
   * Server names that MUST reach `status: 'connected'` before the run is
   * considered viable. In practice the Agent HQ lifecycle server: without it
   * the agent cannot post an outcome, and the CLI will NOT fail the run on its
   * own (verified: a broken MCP command still exits 0 / `terminal_reason:
   * 'completed'`).
   */
  requiredServerNames: string[];
  /** Fully-qualified `mcp__<server>__<tool>` names to pass to --allowedTools. */
  allowedToolNames: string[];
  warnings: string[];
}

// ── Constants ────────────────────────────────────────────────────────────────

/** runId format: `claude-code:<instanceId>`. Matches the pre-existing scheme. */
export const CLAUDE_CODE_RUN_ID_PREFIX = 'claude-code:';

/** session_key format: `claude-code:<session uuid>`. */
export const CLAUDE_CODE_SESSION_KEY_PREFIX = 'claude-code:';

/**
 * chat_messages id prefix for the terminal turn_end row.
 *
 * The watchdog's crash-recovery path reads this row and infers the runtime
 * source from `event_meta.source` first, falling back to an id-prefix match
 * (api/src/scheduler/watchdog.ts:485-493). We write `source` explicitly into
 * event_meta so recovery does not depend on prefix matching.
 */
export const CLAUDE_CODE_RUNTIME_END_MESSAGE_PREFIX = 'claude-code-runtime-end-';

/** MCP slug that carries the Agent HQ lifecycle tools. */
export const AGENT_HQ_MCP_SLUG = 'agent-hq';

/**
 * Sentinel the materializer writes into `toolFilter.include` when an assignment
 * grants no tools. It means "expose nothing", and must never be passed through
 * to the CLI as a real tool name.
 */
export const NO_ALLOWED_MCP_TOOLS_SENTINEL = '__agent_hq_no_allowed_mcp_tools__';

export const DEFAULT_KILL_GRACE_MS = 10_000;
export const DEFAULT_CLAUDE_BIN = 'claude';
