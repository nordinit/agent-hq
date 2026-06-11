import {
  validateHermesRuntimeConfig,
  type HermesRuntimeConfig,
} from '../../runtimes/hermes/config';

export const SUPPORTED_AGENT_RUNTIME_TYPES = ['openclaw', 'claude-code', 'webhook', 'veri', 'hermes'] as const;

export type AgentRuntimeType = (typeof SUPPORTED_AGENT_RUNTIME_TYPES)[number];

export interface ClaudeCodeRuntimeConfig {
  workingDirectory: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPromptSuffix?: string;
}

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

function validateClaudeCodeRuntimeConfig(config: Record<string, unknown> | null): string | null {
  const workingDirectory = typeof config?.workingDirectory === 'string' ? config.workingDirectory.trim() : '';
  if (!workingDirectory) {
    return 'runtime_config.workingDirectory is required for claude-code runtime';
  }
  return null;
}

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
