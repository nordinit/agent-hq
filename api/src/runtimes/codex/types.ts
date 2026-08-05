/** Contracts shared by the local Codex CLI runtime. */

export const CODEX_REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

export const CODEX_SANDBOX_MODES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

export const CODEX_APPROVAL_POLICIES = [
  'untrusted',
  'on-request',
  'never',
] as const;
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];

export interface CodexRuntimeConfig {
  workingDirectory?: string;
  codexBin?: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  sandboxMode?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  /** Required safety latch for danger-full-access until execution-target trust exists. */
  allowDangerousFullAccess?: boolean;
  skipGitRepoCheck?: boolean;
  /** Parent directory; an opaque per-agent directory is always appended. */
  codexHomeRoot?: string;
  /** Exact CLI-owned home, used only with a runtime-owned provider connection. */
  codexHome?: string;
  /** Opaque provider-connection profile reference injected by the dispatcher. */
  providerConnectionExternalRef?: string;
  /** Recovery-only native thread id; requires a matching durable priorCheckpoint. */
  resumeSessionId?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  killGraceMs?: number;
  [key: string]: unknown;
}

export interface NormalizedCodexRuntimeConfig {
  workingDirectory: string | null;
  codexBin: string;
  model: string | null;
  reasoningEffort: CodexReasoningEffort | null;
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  allowDangerousFullAccess: boolean;
  skipGitRepoCheck: boolean;
  codexHomeRoot: string | null;
  codexHome: string | null;
  providerConnectionExternalRef: string | null;
  resumeSessionId: string | null;
  extraArgs: string[];
  env: Record<string, string>;
  killGraceMs: number;
}

export interface CodexArgsInput {
  config: NormalizedCodexRuntimeConfig;
  model?: string | null;
  reasoningEffort?: string | null;
  /** Effective noninteractive service tier; omitted/null is hardened standard mode. */
  fastMode?: boolean | null;
  /** Internal Codex v2 profile selected for this dispatch. */
  configProfile?: string | null;
}

export interface CodexMcpMaterialization {
  codexHome: string;
  configPath: string;
  snapshotPath: string;
  serverNames: string[];
  requiredServerNames: string[];
  servers: Record<string, Record<string, unknown>>;
  warnings: string[];
}

export type CodexFailureFamily = 'infra' | 'runtime' | 'none';
export type CodexErrorCode =
  | 'codex_auth_required'
  | 'provider_quota'
  | 'codex_transient_upstream'
  | 'model_not_found'
  | 'mcp_not_ready'
  | 'sandbox_denied'
  | 'malformed_output'
  | 'timeout'
  | 'aborted'
  | 'spawn_failed'
  | 'turn_failed'
  | 'nonzero_exit'
  | 'no_turn_completion'
  | 'success';

export interface CodexFailureClassification {
  code: CodexErrorCode;
  family: CodexFailureFamily;
  summary: string;
}

export const CODEX_RUN_ID_PREFIX = 'codex:';
export const CODEX_SESSION_KEY_PREFIX = 'codex:';
export const CODEX_RUNTIME_END_MESSAGE_PREFIX = 'codex-runtime-end-';
export const DEFAULT_CODEX_BIN = 'codex';
export const DEFAULT_KILL_GRACE_MS = 10_000;
export const AGENT_HQ_MCP_SLUG = 'agent-hq';
export const NO_ALLOWED_MCP_TOOLS_SENTINEL = '__agent_hq_no_allowed_mcp_tools__';
