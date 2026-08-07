/**
 * runtimes/index.ts — Runtime registry.
 *
 * resolveRuntime() returns the correct AgentRuntime implementation for an agent
 * based on its runtime_type. The dispatcher calls this instead of importing
 * OpenClaw-specific functions directly.
 */

export type {
  AgentRuntime,
  DispatchParams,
  PrepareAuthProfilesParams,
  RuntimeAuthProfileSyncResult,
  RuntimeAbortResult,
  RuntimeAbortStatus,
  RuntimeEndEvent,
  RuntimeEndEventType,
  RuntimeEventCallbacks,
} from './types';
export * from './runtimeBoundary';
export * from './dispatchContextGuard';
export * from './runtimeExecutionStore';
export * from './runtimeExecutionReconciler';
export {
  LocalProcessSupervisor,
  localProcessSupervisor,
  localProcessSpawnOptions,
  localProcessGroupId,
  localProcessIdentity,
} from './localProcessSupervisor';
export type {
  ActiveLocalProcessRun,
  LocalProcessSignalResult,
  LocalProcessSignalStatus,
  RegisterLocalProcessRun,
} from './localProcessSupervisor';

// Skill materialization — task #644
export {
  getSkillMaterializationAdapter,
  NoopSkillAdapter,
  FilesystemSkillAdapter,
  OpenClawSkillAdapter,
  ClaudeCodeSkillAdapter,
  CodexSkillAdapter,
  PromptInjectionSkillAdapter,
  HermesSkillAdapter,
} from './skillMaterialization';
export type {
  SkillMaterializationAdapter,
  MaterializationContext,
  MaterializationResult,
} from './skillMaterialization';
export { OpenClawRuntime, abortChatRunBySessionKey } from './openclaw';
export type { AbortChatRunResult, AbortChatRunStatus } from './openclaw';
export { ClaudeCodeRuntime } from './claudeCode';
export type {
  ClaudeCodeRuntimeConfig,
  NormalizedClaudeCodeRuntimeConfig,
  ClaudeEffortLevel,
  ClaudePermissionMode,
} from './claudeCode';
export {
  validateClaudeCodeRuntimeConfig,
  normalizeClaudeCodeRuntimeConfig,
} from './claudeCode';
export {
  CodexRuntime,
  validateCodexRuntimeConfig,
  normalizeCodexRuntimeConfig,
} from './codex';
export type {
  CodexRuntimeConfig,
  NormalizedCodexRuntimeConfig,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexApprovalPolicy,
} from './codex';
export { HermesRuntime, validateHermesRuntimeConfig } from './hermes';
export type { HermesRuntimeConfig } from './hermes';
export { WebhookRuntime } from './WebhookRuntime';
export type { WebhookRuntimeConfig } from './WebhookRuntime';


import type { AgentRuntime } from './types';
import { OpenClawRuntime } from './openclaw';
import { ClaudeCodeRuntime } from './claudeCode';
import { CodexRuntime } from './codex';
import { HermesRuntime } from './hermes';
import { WebhookRuntime, type WebhookRuntimeConfig } from './WebhookRuntime';

/**
 * resolveRuntime — factory that maps runtime_type → AgentRuntime implementation.
 *
 * @param agent - any object with runtime_type and runtime_config fields
 *                (matches the agents DB row shape)
 * @returns      the correct AgentRuntime for this agent
 */
export function resolveRuntime(agent: {
  runtime_type?: string | null;
  runtime_config?: unknown;
}): AgentRuntime {
  const type = agent.runtime_type?.trim() || 'openclaw';

  // Parse runtime_config JSON string if needed
  let config: Record<string, unknown> = {};
  if (agent.runtime_config) {
    if (typeof agent.runtime_config === 'string') {
      try {
        config = JSON.parse(agent.runtime_config) as Record<string, unknown>;
      } catch {
        config = {};
      }
    } else if (typeof agent.runtime_config === 'object') {
      config = agent.runtime_config as Record<string, unknown>;
    }
  }

  switch (type) {
    case 'claude-code':
      return new ClaudeCodeRuntime(config);
    case 'codex':
      return new CodexRuntime(config);
    case 'hermes':
      return new HermesRuntime(config);
    case 'webhook': {
      if (!config.dispatchUrl || typeof config.dispatchUrl !== 'string') {
        throw new Error(
          'WebhookRuntime requires runtime_config.dispatchUrl to be set on the agent',
        );
      }
      return new WebhookRuntime(config as unknown as WebhookRuntimeConfig);
    }
    case 'openclaw':
      return new OpenClawRuntime();
    default:
      throw new Error(`Unsupported agent runtime type: ${type}`);
  }
}
