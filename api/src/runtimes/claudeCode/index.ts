/**
 * runtimes/claudeCode/index.ts — public surface of the CLI-backed claude-code runtime.
 */

export { ClaudeCodeRuntime } from './ClaudeCodeRuntime';

export {
  validateClaudeCodeRuntimeConfig,
  normalizeClaudeCodeRuntimeConfig,
} from './config';

export { buildClaudeArgs } from './args';

export { classifyClaudeRun, retryNotBeforeFromRateLimit } from './errors';

export {
  preflightMcpServer,
  preflightMcpServers,
  describeMcpPreflightFailure,
  DEFAULT_MCP_PREFLIGHT_TIMEOUT_MS,
} from './mcpPreflight';
export type { McpPreflightResult } from './mcpPreflight';

export {
  materializeClaudeCodeMcpConfig,
  resolveClaudeCodeAgentStateDir,
  readPreviousRunServers,
} from './mcpConfig';

export {
  ClaudeStreamAccumulator,
  NdjsonDecoder,
  evaluateMcpReadiness,
  mcpToolName,
  parseClaudeStreamJson,
} from './streamJson';

export {
  parseClaudeCodeInstanceIdFromRunId,
  stopClaudeCodeActiveRun,
  terminateClaudeCodeRun,
  waitForClaudeCodeChildProcess,
} from './abort';

export {
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_PERMISSION_MODES,
  CLAUDE_CODE_RUN_ID_PREFIX,
  CLAUDE_CODE_SESSION_KEY_PREFIX,
} from './types';

export type {
  ClaudeCodeRuntimeConfig,
  NormalizedClaudeCodeRuntimeConfig,
  ClaudeEffortLevel,
  ClaudePermissionMode,
  ClaudeArgsInput,
  ClaudeErrorCode,
  ClaudeFailureFamily,
  ClaudeFailureClassification,
  ClaudeMcpMaterialization,
} from './types';
