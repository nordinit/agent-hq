import { createHash } from 'crypto';
import {
  RUNTIME_BOUNDARY_VERSION,
  assertRuntimeBoundaryV1,
  canonicalRuntimeJson,
  type RuntimeBoundaryV1,
  type RuntimeExecutionTargetV1,
  type RuntimeMcpAssignmentV1,
  type RuntimeSkillAssignmentV1,
} from '../runtimes/runtimeBoundary';
import { normalizeClaudeCodeRuntimeConfig } from '../runtimes/claudeCode/config';
import type { ClaudeCodeRuntimeConfig } from '../runtimes/claudeCode/types';
import {
  CODEX_BUILT_IN_TOOLS,
  CODEX_DISABLED_AMBIENT_FEATURES,
  CODEX_FAST_MODE_FEATURE,
  CODEX_RUNTIME_POLICY_REVISION,
} from '../runtimes/codex/policy';

const SENSITIVE_CONFIG_KEY = /(?:secret|token|password|api[_-]?key|authorization|cookie|private[_-]?key|credential)/i;
const SENSITIVE_URL_PARAMETER = /(?:secret|token|password|passcode|api[_-]?key|authorization|cookie|private[_-]?key|credential|signature|signed|(^|[-_])sig($|[-_])|oauth|jwt|session|code|x-amz-|x-goog-)/i;
const ENVIRONMENT_CONFIG_KEY = /^(?:env|environment)$/i;
const ARGUMENT_CONFIG_KEY = /^(?:args|extraArgs)$/i;
const SENSITIVE_ARGUMENT = /(?:secret|token|password|api[_-]?key|authorization|cookie|private[_-]?key|credential)/i;

export const RUNTIME_BOUNDARY_DRIVER_VERSION = 1 as const;

export interface BuildRuntimeBoundaryV1Input {
  tenantId: number;
  projectId?: number | null;
  workflowId?: number | null;
  taskId?: number | null;
  instanceId: number;
  durableRunId: string;
  agentId: number;
  agentSlug: string;
  runtimeType: string;
  /** Fingerprint of the canonical host executable selected for a local runtime. */
  executableFingerprint?: string | null;
  runtimeConfig?: unknown;
  model?: string | null;
  reasoning?: string | null;
  fastMode?: boolean | null;
  timeoutSeconds: number;
  prompt: string;
  workspaceRoot?: string | null;
  activeRepoRoot?: string | null;
  repoAccessMode?: 'worktree' | 'clone' | 'workspace' | 'remote' | null;
  repoSource?: string | null;
  branch?: string | null;
  commit?: string | null;
  executionTarget?: RuntimeExecutionTargetV1 | null;
  mcpServers?: RuntimeMcpAssignmentV1[];
  skills?: RuntimeSkillAssignmentV1[];
  requiredLifecycleTools?: string[];
  provider?: string | null;
  providerConnectionId?: number | null;
  evidenceRequirements?: string[];
  callbackIdentity: string;
  traceId?: string | null;
  correlationId?: string | null;
  requestedBy?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sortedStrings(values: readonly unknown[]): string[] {
  return Array.from(new Set(
    values
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.trim())
      .filter(Boolean),
  )).sort((left, right) => left.localeCompare(right));
}

function stripUrlCredentials(value: string): string {
  const markerMatch = value.match(/^([a-z][a-z0-9+.-]*:)([a-z][a-z0-9+.-]*:\/\/.*)$/i);
  const marker = markerMatch?.[1] ?? '';
  const candidate = markerMatch?.[2] ?? value;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) return value;
  try {
    const parsed = new URL(candidate);
    let changed = false;
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      changed = true;
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (!SENSITIVE_URL_PARAMETER.test(key)) continue;
      parsed.searchParams.set(key, '[redacted]');
      changed = true;
    }
    if (parsed.hash) {
      // URL fragments are not sent to repository servers and commonly carry
      // browser OAuth tokens. They have no place in a durable runtime locator.
      parsed.hash = '';
      changed = true;
    }
    if (!changed) return value;
    return `${marker}${parsed.toString()}`;
  } catch {
    return value;
  }
}

function sanitizeArguments(values: unknown[], seen: WeakSet<object>): unknown[] {
  const result: unknown[] = [];
  let redactNext = false;
  for (const value of values) {
    if (typeof value !== 'string') {
      result.push(sanitizeRuntimeConfigForRevision(value, seen));
      redactNext = false;
      continue;
    }
    if (redactNext) {
      result.push('[redacted]');
      redactNext = false;
      continue;
    }
    const equals = value.indexOf('=');
    const flag = equals >= 0 ? value.slice(0, equals) : value;
    if (flag.startsWith('-') && SENSITIVE_ARGUMENT.test(flag)) {
      result.push(equals >= 0 ? `${flag}=[redacted]` : flag);
      redactNext = equals < 0;
      continue;
    }
    result.push(stripUrlCredentials(value));
  }
  return result;
}

/**
 * Reduce runtime config to resume-relevant, non-secret material before hashing.
 * Environment values and credential-shaped fields never influence the revision;
 * only environment key names are retained so the persisted boundary cannot be
 * used as an offline oracle for low-entropy secrets.
 */
export function sanitizeRuntimeConfigForRevision(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return stripUrlCredentials(value);
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(entry => sanitizeRuntimeConfigForRevision(entry, seen));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_CONFIG_KEY.test(key)) {
      sanitized[key] = '[redacted]';
      continue;
    }
    if (ENVIRONMENT_CONFIG_KEY.test(key) && isRecord(child)) {
      sanitized[key] = { keys: sortedStrings(Object.keys(child)) };
      continue;
    }
    if (ARGUMENT_CONFIG_KEY.test(key) && Array.isArray(child)) {
      sanitized[key] = sanitizeArguments(child, seen);
      continue;
    }
    sanitized[key] = sanitizeRuntimeConfigForRevision(child, seen);
  }
  return sanitized;
}

export function runtimeBoundaryDigest(label: string, value: unknown): string {
  const digest = createHash('sha256')
    .update(`${label}\n`)
    .update(canonicalRuntimeJson(value))
    .digest('hex');
  return `sha256:${digest}`;
}

function runtimeConfigRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the built-in tool set from the same policy source the local drivers
 * use at launch time. In particular, an omitted Claude allowlist means Agent
 * HQ's hardened default while an explicit empty allowlist remains empty.
 *
 * Only the tool-policy field is projected into the Claude normalizer. Boundary
 * construction also accepts opaque config fields so it can safely fingerprint
 * and redact them; validating unrelated driver fields remains the adapter's
 * responsibility.
 */
function effectiveBuiltInTools(
  runtimeType: string,
  config: Record<string, unknown> | null,
): string[] {
  if (runtimeType === 'codex') return sortedStrings(CODEX_BUILT_IN_TOOLS);
  if (runtimeType === 'claude-code') {
    const toolPolicy = config && Object.prototype.hasOwnProperty.call(config, 'allowedTools')
      ? { allowedTools: config.allowedTools } as ClaudeCodeRuntimeConfig
      : undefined;
    return sortedStrings(normalizeClaudeCodeRuntimeConfig(toolPolicy).allowedTools);
  }
  return sortedStrings(Array.isArray(config?.allowedTools) ? config.allowedTools : []);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function runtimeDriverVersion(runtimeType: string): string {
  return `${runtimeType || 'unknown'}-driver/${RUNTIME_BOUNDARY_DRIVER_VERSION}`;
}

/** Defaults describe today's adapters while allowing a scheduler to supply an
 * explicit ssh/sandbox/managed target when remote execution is introduced. */
export function defaultRuntimeExecutionTarget(runtimeType: string): RuntimeExecutionTargetV1 {
  switch (runtimeType) {
    case 'claude-code':
      return {
        id: 'local:claude-code',
        kind: 'local-process',
        trustLevel: 'workspace',
        capabilities: ['inspect', 'network', 'signals', 'workspace-write'],
      };
    case 'codex':
      return {
        id: `local:${runtimeType}`,
        kind: 'local-process',
        trustLevel: 'workspace',
        capabilities: ['inspect', 'network', 'resume', 'signals', 'workspace-write'],
      };
    case 'hermes':
      return {
        id: 'local:hermes',
        kind: 'local-process',
        trustLevel: 'workspace',
        capabilities: ['inspect', 'network', 'signals', 'workspace-write'],
      };
    case 'openclaw':
      return {
        id: 'managed:openclaw-gateway',
        kind: 'managed',
        trustLevel: 'workspace',
        capabilities: ['inspect', 'live-redirect', 'network', 'resume', 'workspace-write'],
      };
    case 'veri':
      return {
        id: 'managed:veri',
        kind: 'managed',
        trustLevel: 'untrusted',
        capabilities: ['inspect', 'network', 'signals'],
      };
    case 'webhook':
      return {
        id: 'managed:webhook',
        kind: 'managed',
        trustLevel: 'untrusted',
        capabilities: ['network'],
      };
    default:
      return {
        id: `managed:${runtimeType || 'unknown'}`,
        kind: 'managed',
        trustLevel: 'untrusted',
        capabilities: ['network'],
      };
  }
}

function sanitizeRepoSource(value: string | null | undefined): string | null {
  const normalized = nonEmptyString(value);
  return normalized ? stripUrlCredentials(normalized) : null;
}

function resolveCredentialRefs(params: BuildRuntimeBoundaryV1Input): RuntimeBoundaryV1['auth']['credentialRefs'] {
  if (positiveInteger(params.providerConnectionId) != null) {
    return [{
      kind: 'provider-connection',
      reference: `provider-connection:${params.providerConnectionId}`,
    }];
  }
  const provider = nonEmptyString(params.provider);
  if (!provider) return [];
  const localProfileRuntimes = new Set(['openclaw', 'hermes', 'claude-code', 'codex']);
  return [{
    kind: localProfileRuntimes.has(params.runtimeType) ? 'operator-profile' : 'environment',
    reference: localProfileRuntimes.has(params.runtimeType)
      ? `runtime-profile:${params.runtimeType}:${params.agentSlug}`
      : `runtime-provider:${provider}`,
  }];
}

export function buildRuntimeBoundaryV1(params: BuildRuntimeBoundaryV1Input): RuntimeBoundaryV1 {
  const config = runtimeConfigRecord(params.runtimeConfig);
  const targetInput = params.executionTarget ?? defaultRuntimeExecutionTarget(params.runtimeType);
  const executionTarget: RuntimeExecutionTargetV1 = {
    ...targetInput,
    id: stripUrlCredentials(targetInput.id),
    capabilities: sortedStrings(targetInput.capabilities),
  };
  const workspaceRoot = nonEmptyString(params.workspaceRoot);
  const suppliedActiveRepoRoot = nonEmptyString(params.activeRepoRoot);
  const activeRepoRoot = suppliedActiveRepoRoot
    ?? workspaceRoot
    ?? (executionTarget.kind === 'local-process'
      ? `unresolved://workspace/${encodeURIComponent(params.agentSlug)}`
      : `remote://${encodeURIComponent(executionTarget.id)}`);
  const repoSource = sanitizeRepoSource(params.repoSource);
  const repoAccessMode = params.repoAccessMode
    ?? (suppliedActiveRepoRoot || workspaceRoot
      ? 'workspace'
      : executionTarget.kind === 'local-process' ? null : 'remote');
  const branch = nonEmptyString(params.branch);
  const commit = nonEmptyString(params.commit);
  const model = nonEmptyString(params.model) ?? nonEmptyString(config?.model);
  const reasoning = nonEmptyString(params.reasoning)
    ?? nonEmptyString(config?.reasoningEffort)
    ?? nonEmptyString(config?.effort)
    ?? nonEmptyString(config?.thinking);
  const requestedFastMode = typeof params.fastMode === 'boolean'
    ? params.fastMode
    : typeof config?.fastMode === 'boolean' ? config.fastMode : null;
  // Codex argv pins standard routing when no explicit fast request exists, so
  // the durable boundary records the effective boolean rather than `null`.
  const fastMode = params.runtimeType === 'codex'
    ? requestedFastMode === true
    : requestedFastMode;
  const requiredLifecycleTools = sortedStrings(
    params.requiredLifecycleTools
      ?? (params.taskId != null ? ['agent_hq_post_task_outcome', 'agent_hq_start_task_run'] : []),
  );
  const evidenceRequirements = sortedStrings(params.evidenceRequirements ?? []);
  const builtIn = effectiveBuiltInTools(params.runtimeType, config);
  const configRevisionMaterial = params.runtimeType === 'codex'
    ? {
        config: sanitizeRuntimeConfigForRevision(config),
        policyRevision: CODEX_RUNTIME_POLICY_REVISION,
        builtIn,
        disabledFeatures: [
          ...CODEX_DISABLED_AMBIENT_FEATURES,
          ...(fastMode === true ? [] : [CODEX_FAST_MODE_FEATURE]),
        ],
        fastServiceTier: fastMode === true ? 'fast' : 'default',
      }
    : config === null ? null : sanitizeRuntimeConfigForRevision(config);

  const boundary: RuntimeBoundaryV1 = {
    version: RUNTIME_BOUNDARY_VERSION,
    identity: {
      tenantId: params.tenantId,
      projectId: params.projectId ?? null,
      workflowId: params.workflowId ?? null,
      taskId: params.taskId ?? null,
      instanceId: params.instanceId,
      durableRunId: params.durableRunId,
      agentId: params.agentId,
      agentSlug: params.agentSlug,
    },
    runtime: {
      type: params.runtimeType,
      driverVersion: runtimeDriverVersion(params.runtimeType),
      executableFingerprint: nonEmptyString(params.executableFingerprint),
      configRevision: configRevisionMaterial === null
        ? null
        : runtimeBoundaryDigest('runtime-config-v1', configRevisionMaterial),
      model,
      reasoning,
      fastMode,
      timeoutSeconds: params.timeoutSeconds,
      tokenBudget: positiveInteger(config?.tokenBudget) ?? positiveInteger(config?.maxTokens),
      turnLimit: positiveInteger(config?.maxTurns) ?? positiveInteger(config?.turnLimit),
    },
    workspace: {
      workspaceRoot,
      activeRepoRoot,
      repoAccessMode,
      repoSource,
      branch,
      commit,
      fingerprint: runtimeBoundaryDigest('runtime-workspace-v1', {
        workspaceRoot,
        activeRepoRoot,
        repoAccessMode,
        repoSource,
        branch,
        commit,
      }),
    },
    prompt: {
      bundleFingerprint: runtimeBoundaryDigest('runtime-prompt-bundle-v1', params.prompt),
    },
    executionTarget,
    tools: {
      builtIn,
      mcpServers: [...(params.mcpServers ?? [])]
        .map(server => ({
          ...server,
          requiredToolNames: sortedStrings(server.requiredToolNames),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      requiredLifecycleTools,
      skills: [...(params.skills ?? [])]
        .sort((left, right) => left.name.localeCompare(right.name)),
    },
    auth: {
      provider: nonEmptyString(params.provider),
      providerConnectionId: positiveInteger(params.providerConnectionId),
      credentialRefs: resolveCredentialRefs(params),
    },
    evidence: {
      required: evidenceRequirements.length > 0,
      requirements: evidenceRequirements,
    },
    callback: { identity: params.callbackIdentity },
    priorCheckpoint: null,
    observability: {
      traceId: nonEmptyString(params.traceId) ?? `runtime:${params.durableRunId}`,
      correlationId: nonEmptyString(params.correlationId) ?? `instance:${params.instanceId}`,
      requestedBy: nonEmptyString(params.requestedBy),
    },
  };

  assertRuntimeBoundaryV1(boundary);
  return boundary;
}
