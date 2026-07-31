import {
  validateHermesRuntimeConfig,
  type HermesRuntimeConfig,
} from '../../runtimes/hermes/config';
import { validateClaudeCodeRuntimeConfig } from '../../runtimes/claudeCode/config';
import type { ClaudeCodeRuntimeConfig } from '../../runtimes/claudeCode/types';

export const SUPPORTED_AGENT_RUNTIME_TYPES = ['openclaw', 'claude-code', 'webhook', 'veri', 'hermes'] as const;

export type AgentRuntimeType = (typeof SUPPORTED_AGENT_RUNTIME_TYPES)[number];

/**
 * Re-exported from the runtime rather than redeclared.
 *
 * There used to be two disagreeing copies of this interface — one here (which
 * required `workingDirectory` and omitted the `xhigh` effort level) and one in
 * the runtime — so validation and execution could not agree on what a valid
 * config was. The runtime's definition is now the single source of truth.
 */
export type { ClaudeCodeRuntimeConfig };

export type AgentRuntimeConfigPayload = ClaudeCodeRuntimeConfig | HermesRuntimeConfig | Record<string, unknown> | null;

export function isSupportedAgentRuntimeType(value: string): value is AgentRuntimeType {
  return (SUPPORTED_AGENT_RUNTIME_TYPES as readonly string[]).includes(value);
}

export function parseRuntimeConfigObject(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null;
}

// claude-code validation now lives with the runtime (runtimes/claudeCode/config.ts)
// so the create/update routes and the pre-spawn gate cannot drift apart.
//
// `workingDirectory` is deliberately no longer required: dispatch resolves the
// cwd as activeRepoRoot -> runtime_config.workingDirectory -> workspaceRoot, and
// a task worktree always supplies activeRepoRoot. Requiring it forced operators
// to invent a path that the runtime would then ignore. Relaxing a requirement is
// safe for existing agents; tightening one would not be (PUT /agents/:id
// re-validates the STORED config on every unrelated update).

function validateWebhookRuntimeConfig(config: Record<string, unknown> | null): string | null {
  if (config?.lifecycleProxy !== undefined) {
    return 'runtime_config.lifecycleProxy is no longer supported for webhook runtime; use Agent HQ MCP/capability lifecycle tools instead';
  }
  return null;
}

export function validateAgentRuntimeConfig(runtimeType: string, runtimeConfig: unknown): string | null {
  if (!isSupportedAgentRuntimeType(runtimeType)) {
    return `runtime_type must be one of: ${SUPPORTED_AGENT_RUNTIME_TYPES.join(', ')}`;
  }

  if (runtimeConfig !== undefined && runtimeConfig !== null && !parseRuntimeConfigObject(runtimeConfig)) {
    return 'runtime_config must be an object or null';
  }

  const parsedConfig = parseRuntimeConfigObject(runtimeConfig);
  if (runtimeType === 'claude-code') {
    return validateClaudeCodeRuntimeConfig(parsedConfig);
  }
  if (runtimeType === 'hermes') {
    return validateHermesRuntimeConfig(parsedConfig);
  }
  if (runtimeType === 'webhook') {
    return validateWebhookRuntimeConfig(parsedConfig);
  }

  return null;
}
