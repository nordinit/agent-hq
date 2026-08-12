import fs from 'fs';
import path from 'path';
import { notifyTaskStatusChange } from '../lib/taskNotifications';
import { recordDispatchStartupFailureNotification } from '../lib/dispatchStartupFailureNotifications';
import { recordSkillMaterializationIssues } from '../lib/skillMaterializationNotifications';
import { resolveRepoConfig } from '../lib/repoConfig';
import { writeTaskHistory, writeTaskStatusChange } from '../domains/tasks/history';
import { syncTaskActiveAgentFromInstance } from '../domains/tasks/ownership';
import { resolveRuntime } from '../runtimes';
import { resolveRuntimeProviderDispatchSelection } from '../domains/providers/runtimeAdapters';
import { createTaskWorktree } from './worktreeManager';
import { ensureTaskClone, type RepoAccessMode } from './repoWorkspaceManager';
import type { RepoWorkspaceDependencySetupResult } from './repoWorkspaceDependencies';
import {
  OPENCLAW_CONFIG_PATH as OPENCLAW_CONFIG_PATH_DISPATCHER,
  OPENCLAW_GATEWAY_URL,
} from '../config';
import {
  resolveGitHubIdentity,
  injectGitHubCredentials,
  cleanupGitHubCredentials,
} from '../lib/githubIdentity';
import {
  resolveTransportMode,
} from './contracts';
import { getSkillMaterializationAdapter } from '../runtimes/skillMaterialization';
import { syncAssignedMcpForAgent } from '../runtimes/mcpMaterialization';
import { getDb } from '../db/client';
import { nowTimestamp, timestampFromEpochMs } from '../lib/timestamps';
import { buildHookSessionKey, resolveRuntimeAgentSlug } from '../lib/sessionKeys';
import { createDurableRunId, ensureJobInstanceDurableRunId, tableHasColumn as durableTableHasColumn } from '../lib/durableRunIdentity';
import { insertRuntimeLog, resolveRuntimeTenantId, tenantInsertColumns } from '../lib/runtimeTenantScope';
import { TASK_STATUSES, DEFAULT_TERMINAL_TASK_STATUS_SEEDS } from '../lib/taskStatuses';
import { AGENT_HQ_DISPATCHER_SOURCE, DISPATCH_STARTUP_FAILED_EVENT, resolveWorkflowEventMapping } from '../domains/routing/externalEventMappings';
import type { AgentRuntime, DispatchParams } from '../runtimes/types';
import type { RuntimeExecutionTargetV1 } from '../runtimes/runtimeBoundary';
import { resolveAllowedRuntimeExecutable } from '../runtimes/executablePolicy';
import { normalizeClaudeCodeRuntimeConfig } from '../runtimes/claudeCode/config';
import { normalizeCodexRuntimeConfig } from '../runtimes/codex/config';
import { buildRuntimeBoundaryV1 } from './runtimeBoundaryBuilder';
import { loadRuntimeBoundaryAssignments } from './runtimeBoundaryAssignments';
import type { CandidateTask } from './dispatch/types';
import { sortCandidates } from './dispatch/routing/candidates';
export { sortCandidates } from './dispatch/routing/candidates';
export { resolveModelFromStoryPoints, type ResolvedStoryPointModel } from './dispatch/routing/modelRouting';
import { resolveModelFromStoryPoints } from './dispatch/routing/modelRouting';
export {
  appendInstanceInstructions,
  buildDispatchContextBundle,
  buildDispatchContextDrafts,
  buildDispatchTaskNotesSection,
  buildInstanceCallbackContract,
  buildWorkspaceContextSection,
  DISPATCH_CONTEXT_ORDER,
  extractWorkingDirectoryFromRuntimeConfig,
  formatDispatchTaskNote,
  getDispatchTaskNotesContext,
  renderContextBundle,
  resolveDispatchPathContext,
  type ContextBundle,
  type ContextSegment,
  type ContextSegmentDraft,
  type DispatchContextInput,
  type DispatchPathContext,
  type DispatchTaskNoteRow,
  type DispatchTaskNotesContext,
  type InstanceCallbackContractInput,
} from './dispatch/prompt';
import {
  buildDispatchContextBundle,
  buildInstanceCallbackContractSegmentDraft,
  extractWorkingDirectoryFromRuntimeConfig,
  getDispatchTaskNotesContext,
  resolveDispatchPathContext,
  type ContextBundle,
} from './dispatch/prompt';
import { persistDispatchContextBundle } from './dispatch/contextBundleStore';
import { type Db } from "../db/adapter/types";
import { resolveTeamContextForDispatch } from '../domains/teams/context';
import { tableExists as sharedTableExists, columnExists as sharedColumnExists, tableColumns as sharedTableColumns, indexExists as sharedIndexExists } from "../db/introspection";

/**
 * Resolve local runtime binaries while the dispatcher is still constructing
 * the immutable boundary. The runtime's zero-spend version probe must later
 * return this exact fingerprint before it is allowed to spawn the path it
 * probed. Remote/managed drivers intentionally carry no host executable.
 */
export function resolveRuntimeBoundaryExecutableFingerprint(
  runtimeType: string,
  runtimeConfig: unknown,
): string | null {
  if (runtimeType === 'claude-code') {
    const config = normalizeClaudeCodeRuntimeConfig(runtimeConfig as never);
    return resolveAllowedRuntimeExecutable('claude-code', config.claudeBin).fingerprint;
  }
  if (runtimeType === 'codex') {
    const config = normalizeCodexRuntimeConfig(runtimeConfig as never);
    return resolveAllowedRuntimeExecutable('codex', config.codexBin).fingerprint;
  }
  return null;
}

function hasMaterializedAgentHqLifecycleMcp(bundlePath: string | undefined, agentId: number | null | undefined): boolean {
  if (!bundlePath || agentId == null || !fs.existsSync(bundlePath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(bundlePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return false;
    return Object.prototype.hasOwnProperty.call(servers, `agent-hq__agent-${agentId}`);
  } catch {
    return false;
  }
}

const REQUIRED_OPENCLAW_MCP_TOOLS_BY_SERVER_SLUG: Record<string, string[]> = {
  'agent-hq': ['agent_hq_start_task_run'],
  'dev-environment-lease-manager': ['dev_env_deploy_worktree'],
};

function requiredOpenClawMcpToolsForServerNames(serverNames: string[]): string[] {
  const tools = new Set<string>();
  for (const serverName of serverNames) {
    const slug = serverName.replace(/__agent-\d+$/, '');
    for (const toolName of REQUIRED_OPENCLAW_MCP_TOOLS_BY_SERVER_SLUG[slug] ?? []) {
      tools.add(toolName);
    }
  }
  return Array.from(tools).sort();
}

function requiredOpenClawMcpToolsByServerName(serverNames: string[]): Record<string, string[]> {
  const entries = serverNames
    .map((serverName) => {
      const slug = serverName.replace(/__agent-\d+$/, '');
      return [serverName, REQUIRED_OPENCLAW_MCP_TOOLS_BY_SERVER_SLUG[slug] ?? []] as const;
    })
    .filter(([, tools]) => tools.length > 0);
  return Object.fromEntries(entries);
}

// ── Dispatch failure backoff (task #355) ─────────────────────────────────────
//
// When a dispatch attempt fails (gateway down, Anthropic overloaded, etc.),
// the dispatcher sets dispatched_at = now on the task and increments retry_count
// before resetting it back to its eligible status. This creates a cooldown window
// during which the reconciler's next tick(s) will NOT re-dispatch the task.
//
// The backoff duration (seconds) is read from the DISPATCH_FAILURE_BACKOFF_SECONDS
// env var or falls back to 120s (2 minutes). This means after a failure the task
// won't be re-dispatched for at least 2 minutes — enough to survive short outages
// without spinning, while still recovering quickly when the gateway comes back up.
//
// Admins can tune this at runtime by setting DISPATCH_FAILURE_BACKOFF_SECONDS
// before restarting the API.
export const DISPATCH_FAILURE_BACKOFF_SECONDS: number =
  parseInt(process.env.DISPATCH_FAILURE_BACKOFF_SECONDS ?? '120', 10) || 120;

// ── Container routing config (task #288) ─────────────────────────────────────
// Used by hooksFetch() when an agent has hooks_url set (container routing).
const GATEWAY_URL = OPENCLAW_GATEWAY_URL;

function readDispatcherGatewayToken(): string | null {
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH_DISPATCHER, 'utf-8');
    const cfg = JSON.parse(raw) as { gateway?: { auth?: { token?: string } } };
    const token = cfg.gateway?.auth?.token;
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

const HOOKS_TOKEN = process.env.OPENCLAW_HOOKS_TOKEN ?? readDispatcherGatewayToken() ?? '';

function gatewayFetch(hookPath: string, init: RequestInit): Promise<Response> {
  const url = `${GATEWAY_URL}${hookPath}`;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  return fetch(url, init);
}
// ── End container routing config ─────────────────────────────────────────────


/**
 * hooksFetch — send a /hooks/agent request to the correct OpenClaw instance.
 *
 * If the agent has a hooks_url (e.g. "http://localhost:3701" for a containerised
 * instance), POST there; otherwise fall back to the host gateway via gatewayFetch.
 *
 * Container instances run plain HTTP on a custom port, so no TLS override needed.
 * The host gateway uses HTTPS with a self-signed cert, so we keep the TLS bypass
 * for that path.
 */
function hooksFetch(agentHooksUrl: string | null | undefined, hookPath: string, init: RequestInit): Promise<Response> {
  if (agentHooksUrl) {
    // Container instance — plain HTTP, no TLS concerns
    const url = `${agentHooksUrl}${hookPath}`;
    return fetch(url, init);
  }
  // Default: host gateway (may be HTTPS with self-signed cert)
  return gatewayFetch(hookPath, init);
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface DispatchResult {
  dispatched: number;
  skipped: number;
  errors: string[];
}

interface JobRow {
  id: number;
  title: string;
  agent_id: number;
  tenant_id?: number | null;
  project_id: number | null;
  job_instructions: string;
  enabled: number;
  timeout_seconds: number;
  agent_session_key: string;
  agent_name: string;
  /** Model override for this job (from agents.model). */
  model?: string | null;
  /** Agent-level model (aliased as agent_model for precedence fallback). */
  agent_model?: string | null;
  /** Runtime columns from agents table — used by resolveRuntime() */
  runtime_type?: string | null;
  runtime_config?: unknown;
  /** Container OpenClaw URL, e.g. "http://localhost:3701". Null = host gateway. */
  agent_hooks_url?: string | null;
  /** Per-agent Authorization header for hooks_url dispatch (task #431). */
  agent_hooks_auth_header?: string | null;
  /** Agent workspace directory — used by generateClaudeMd() for claude-code dispatches. */
  workspace_path?: string | null;
  /** Stable OpenClaw runtime slug, preserved even if Agent HQ session_key is canonicalized. */
  openclaw_agent_id?: string | null;
  /** JSON array of skill names assigned to this job — used by generateClaudeMd(). */
  skill_names?: string | null;
  /** Preferred AI provider for model routing (e.g. 'anthropic', 'openai'). */
  preferred_provider?: string | null;
  /** Runtime-owned provider connection selected for this agent. */
  provider_connection_id?: number | null;
  /** Canonical local git repo path for worktree isolation. */
  repo_path?: string | null;
  /** Remote git URL for clone-backed task workspaces. */
  repo_url?: string | null;
  /** Explicit repo access mode for dispatch/runtime. */
  repo_access_mode?: RepoAccessMode | null;
  /** Project-owned repo config columns joined during candidate resolution. */
  project_repo_path?: string | null;
  project_repo_url?: string | null;
  project_repo_access_mode?: RepoAccessMode | null;
  workflow_repo_path?: string | null;
  workflow_repo_url?: string | null;
  workflow_repo_access_mode?: RepoAccessMode | null;
  repo_config_source?: 'workflow' | 'agent_legacy' | null;
  /** Dedicated macOS OS user for filesystem isolation (task #377). */
  os_user?: string | null;
}

function slugFromSessionKey(sessionKey: string | null | undefined, fallbackName?: string | null): string | null {
  return resolveRuntimeAgentSlug({
    session_key: sessionKey,
    name: fallbackName ?? null,
  });
}

async function prepareRuntimeAuthProfiles(runtime: AgentRuntime, params: DispatchParams): Promise<void> {
  const result = await runtime.prepareAuthProfiles({
    agentSlug: params.agentSlug,
    agentId: params.runtimeBoundary?.identity.agentId ?? null,
    tenantId: params.runtimeBoundary?.identity.tenantId ?? null,
    preferredProvider: params.preferredProvider ?? null,
    providerConnectionId: params.providerConnectionId ?? null,
    runtimeConfig: params.runtimeConfig,
  });
  if (result.ok) return;

  const provider = result.providersSynced[0]
    ?? result.runtimeAuthProvidersSynced[0]
    ?? result.openclawAuthProvidersSynced[0]
    ?? params.preferredProvider
    ?? 'provider';
  throw new Error(
    `Runtime credential preparation failed for ${provider}: ${result.error ?? 'unknown error'}`,
  );
}

interface RelationshipDispatchReason {
  relationshipTypeKey: string;
  relationshipLabel: string;
  relatedTaskId: number;
  relatedTaskTitle: string;
  relatedTaskStatus: string;
}

interface RelationshipDispatchEligibility {
  blockedByTaskId: Map<number, RelationshipDispatchReason[]>;
  blockingCountByTaskId: Map<number, number>;
}
/**
 * RoutingRuleRow — a sprint_task_routing_rules row joined with the agent.
 * The `agent_id` field maps directly to the agents table.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RoutingRuleRow = any; // joined rule+job+agent; accessed by field name below

// ── Routing config helpers ───────────────────────────────────────────────────

interface DispatcherRoutingConfig {
  sort_rules: string[];
}

/**
 * getAgentRoutingConfig — reads routing config from agents table.
 * Task #596: routing_config_legacy has been removed; agents table is the sole source.
 */
async function getAgentRoutingConfig(db: Db, agentId: number): Promise<DispatcherRoutingConfig> {
  const agentRow = await db.get(`SELECT sort_rules FROM agents WHERE id = ?`, agentId) as { sort_rules: string } | undefined;

  if (agentRow) {
    let sort_rules: string[] = [];
    try {
      const parsed = JSON.parse(agentRow.sort_rules || '[]');
      sort_rules = Array.isArray(parsed) ? parsed : [];
    } catch {
      sort_rules = [];
    }
    return { sort_rules };
  }

  return { sort_rules: [] };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function hasActiveInstance(db: Db, agentId: number): Promise<boolean> {
  const row = await db.get(`
    SELECT COUNT(*) as n
    FROM job_instances
    WHERE agent_id = ?
      AND status IN ('queued', 'dispatched', 'running')
  `, agentId) as { n: number };
  return row.n > 0;
}

async function hasTaskLiveInstance(db: Db, taskId: number): Promise<boolean> {
  const row = await db.get(`
    SELECT COUNT(*) as n
    FROM job_instances
    WHERE task_id = ?
      AND status IN ('queued', 'dispatched', 'running')
  `, taskId) as { n: number };
  return row.n > 0;
}

function deriveDispatchTaskStatus(currentStatus: string): string {
  return currentStatus;
}

function deriveDispatchFailureFallbackStatus(currentStatus: string): string {
  if (currentStatus === 'ready') return 'ready';
  if (currentStatus === 'review') return 'review';
  if (currentStatus === 'ready_to_merge') return 'ready_to_merge';
  return currentStatus;
}

function classifyDispatchStartupFailure(reason: string): {
  failureOutcome: 'env_blocked' | 'infra_failed' | 'runtime_failed';
  category: string;
  rootCauseAssessment: string;
  nextAction: string;
  nextOwner: 'dev' | 'PM/operator';
} {
  const lower = reason.toLowerCase();

  if (
    lower.includes('permission denied')
    || lower.includes('operation not permitted')
    || lower.includes('eacces')
    || lower.includes('access denied')
  ) {
    return {
      failureOutcome: 'env_blocked',
      category: 'permissions',
      rootCauseAssessment: 'permissions or workspace access',
      nextAction: 'Fix the repo/workspace permissions for the matched route, then redispatch the task.',
      nextOwner: 'dev',
    };
  }

  if (
    lower.includes('repo_access_mode')
    || lower.includes('repo_path')
    || lower.includes('repo_url')
    || lower.includes('origin/main')
    || lower.includes('origin remote')
    || lower.includes('missing origin')
    || lower.includes('not a git repository')
    || lower.includes('worktree')
    || lower.includes('clone workspace')
    || lower.includes('git')
  ) {
    return {
      failureOutcome: 'env_blocked',
      category: 'repo setup / worktree creation',
      rootCauseAssessment: 'repo configuration or checkout state',
      nextAction: 'Fix the repo setup for the matched route, then redispatch the task.',
      nextOwner: 'dev',
    };
  }

  if (
    lower.includes('gateway')
    || lower.includes('econnrefused')
    || lower.includes('connect')
    || lower.includes('websocket')
    || lower.includes('timed out')
    || lower.includes('timeout')
    || lower.includes('service unavailable')
    || lower.includes('502')
    || lower.includes('503')
  ) {
    return {
      failureOutcome: 'infra_failed',
      category: 'runtime infrastructure',
      rootCauseAssessment: 'gateway or runtime service availability',
      nextAction: 'Restore the runtime/gateway service, then redispatch the task. If the outage is transient, the dispatcher can retry after the backoff window.',
      nextOwner: 'PM/operator',
    };
  }

  return {
    failureOutcome: 'runtime_failed',
    category: 'runtime startup',
    rootCauseAssessment: 'runtime dispatch startup',
    nextAction: 'Inspect the runtime startup failure, fix the underlying issue, then redispatch the task.',
    nextOwner: 'dev',
  };
}

async function persistDispatchStartupFailure(
  db: Db,
  params: {
    taskId: number;
    matchedAgentId: number | null;
    matchedAgentLabel: string;
    routingReason: string;
    priorStatus: string;
    projectId?: number | null;
    sprintId?: number | null;
    sprintType?: string | null;
    taskType?: string | null;
    reason: string;
    retryCount?: number;
    maxRetries?: number;
    keepAutoRetry?: boolean;
    tenantId?: number | null;
  },
): Promise<string> {
  const classification = classifyDispatchStartupFailure(params.reason);
  const fallbackStatus = deriveDispatchFailureFallbackStatus(params.priorStatus);
  const terminalFailureStatus = classification.failureOutcome === 'env_blocked' ? 'stalled' : 'failed';
  const legacySafeStatus = classification.failureOutcome === 'env_blocked'
    ? terminalFailureStatus
    : (params.keepAutoRetry ? fallbackStatus : terminalFailureStatus);
  const hasWorkflowEventMappings = await tableHasColumn(db, 'external_event_mappings', 'event_name');
  const mapping = hasWorkflowEventMappings
    ? await resolveWorkflowEventMapping(db, {
              source: AGENT_HQ_DISPATCHER_SOURCE,
              eventName: DISPATCH_STARTUP_FAILED_EVENT,
              tenantId: params.tenantId ?? null,
              projectId: params.projectId ?? null,
              sprintId: params.sprintId ?? null,
              sprintType: params.sprintType ?? null,
              taskType: params.taskType ?? null,
              currentStatus: params.priorStatus,
            })
    : null;
  const nextStatus = mapping?.action_kind === 'status' && mapping.action_target
    ? mapping.action_target
    : (hasWorkflowEventMappings ? params.priorStatus : legacySafeStatus);

  const failureDetail = [
    'Dispatcher startup failure workflow event',
    `Source: ${AGENT_HQ_DISPATCHER_SOURCE}`,
    `Event: ${DISPATCH_STARTUP_FAILED_EVENT}`,
    `Matched agent: ${params.matchedAgentLabel}${params.matchedAgentId != null ? ` (#${params.matchedAgentId})` : ''}`,
    `Routing reason: ${params.routingReason}`,
    `Prior status: ${params.priorStatus}`,
    `Failure category: ${classification.category}`,
    `Message: ${params.reason}`,
    `Resolved mapping: ${mapping ? `#${mapping.id}` : 'none'}`,
    `Action: ${mapping?.action_kind ?? 'legacy_safe_default'}${mapping?.action_target ? ` → ${mapping.action_target}` : ''}`,
  ].join('\n');

  await writeTaskHistory(db, params.taskId, 'dispatcher', 'workflow_event_source', null, AGENT_HQ_DISPATCHER_SOURCE, false);
  await writeTaskHistory(db, params.taskId, 'dispatcher', 'workflow_event_source_kind', null, 'agent_hq_internal', false);
  await writeTaskHistory(db, params.taskId, 'dispatcher', 'workflow_event_name', null, DISPATCH_STARTUP_FAILED_EVENT, false);
  await writeTaskHistory(db, params.taskId, 'dispatcher', 'workflow_event_matched_agent_id', null, params.matchedAgentId, false);
  await writeTaskHistory(db, params.taskId, 'dispatcher', 'workflow_event_matched_agent_name', null, params.matchedAgentLabel, false);
  await writeTaskHistory(db, params.taskId, 'dispatcher', 'workflow_event_routing_reason', null, params.routingReason, false);
  await writeTaskHistory(db, params.taskId, 'dispatcher', 'workflow_event_failure_category', null, classification.category, false);
  await writeTaskHistory(db, params.taskId, 'dispatcher', 'workflow_event_failure_message', null, params.reason, false);
  await writeTaskHistory(db, params.taskId, 'dispatcher', 'workflow_event_prior_status', null, params.priorStatus, false);
  await writeTaskHistory(db, params.taskId, 'dispatcher', 'workflow_event_mapping_id', null, mapping?.id ?? null, false);
  await writeTaskHistory(db, params.taskId, 'dispatcher', 'workflow_event_action_kind', null, mapping?.action_kind ?? (hasWorkflowEventMappings ? null : 'legacy_safe_default'), false);
  await writeTaskHistory(db, params.taskId, 'dispatcher', 'workflow_event_action_target', null, mapping?.action_target ?? (hasWorkflowEventMappings ? null : nextStatus), false);

  const hasAssignedAgentColumn = await tableHasColumn(db, 'tasks', 'assigned_agent_id');
  const hasClaimedAtColumn = await tableHasColumn(db, 'tasks', 'claimed_at');
  const assignments = [
    'status = ?',
    hasAssignedAgentColumn ? 'assigned_agent_id = ?' : 'agent_id = ?',
    ...(hasAssignedAgentColumn ? ['agent_id = NULL'] : []),
    'active_instance_id = NULL',
    ...(hasClaimedAtColumn ? ['claimed_at = NULL'] : []),
    "dispatched_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')",
    "updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')",
  ];
  const values: Array<string | number | null> = [nextStatus, params.matchedAgentId];

  if (await tableHasColumn(db, 'tasks', 'routing_reason')) {
    assignments.push('routing_reason = ?');
    values.push(params.routingReason);
  }
  if (await tableHasColumn(db, 'tasks', 'failure_detail')) {
    assignments.push('failure_detail = ?');
    values.push(failureDetail);
  }
  if (await tableHasColumn(db, 'tasks', 'previous_status')) {
    assignments.push('previous_status = ?');
    values.push(params.priorStatus);
  }
  if (params.retryCount != null && await tableHasColumn(db, 'tasks', 'retry_count')) {
    assignments.push('retry_count = ?');
    values.push(params.retryCount);
  }

  await db.run(`
    UPDATE tasks
    SET ${assignments.join(',\n        ')}
    WHERE id = ?
  `, ...values, params.taskId);

  const attemptSuffix = params.retryCount != null && params.maxRetries != null
    ? ` (attempt ${params.retryCount}/${params.maxRetries})`
    : '';
  const resultLabel = nextStatus === 'stalled' ? 'blocked' : (nextStatus === params.priorStatus ? 'partial' : 'failed');

  const startupFailureNoteTenant = await tenantInsertColumns(
      db,
      'task_notes',
      (await resolveRuntimeTenantId(db, { taskId: params.taskId })) ?? params.tenantId ?? null,
    );
  await db.run(`INSERT INTO task_notes (${startupFailureNoteTenant.columnSql}task_id, author, content) VALUES (${startupFailureNoteTenant.valueSql}?, ?, ?)`, ...startupFailureNoteTenant.values, params.taskId, 'Agent HQ', [
          'Agent check-in: Blocked',
          `Summary: Dispatch startup failed after routing matched ${params.matchedAgentLabel}${attemptSuffix}`,
          `Work completed: The dispatcher matched route "${params.routingReason}" but execution never started.`,
          `Tests run: Dispatch startup attempted the matched route's repo/runtime setup path.`,
          `Result: ${resultLabel}`,
          `Failure or issue observed: ${params.reason}`,
          `Root cause assessment: ${classification.rootCauseAssessment}`,
          `Evidence: workflow_event=${DISPATCH_STARTUP_FAILED_EVENT}; source=${AGENT_HQ_DISPATCHER_SOURCE}; mapping=${mapping ? `#${mapping.id}` : 'none'}; action=${mapping?.action_kind ?? 'legacy_safe_default'}${mapping?.action_target ? `→${mapping.action_target}` : ''}; legacy_outcome=${classification.failureOutcome}; status=${nextStatus}; routing_reason=${params.routingReason}`,
          `Next action: ${classification.nextAction}`,
          `Next owner: ${classification.nextOwner}`,
        ].join('\n'));

  await recordDispatchStartupFailureNotification(db, {
        taskId: params.taskId,
        tenantId: (await resolveRuntimeTenantId(db, { taskId: params.taskId })) ?? params.tenantId ?? null,
        matchedAgentId: params.matchedAgentId,
        matchedAgentLabel: params.matchedAgentLabel,
        routingReason: params.routingReason,
        failureCategory: classification.category,
        failureMessage: params.reason,
        mappingId: mapping?.id ?? null,
        mappingActionKind: mapping?.action_kind ?? (hasWorkflowEventMappings ? null : 'legacy_safe_default'),
        mappingActionTarget: mapping?.action_target ?? (hasWorkflowEventMappings ? null : nextStatus),
        nextAction: classification.nextAction,
        nextOwner: classification.nextOwner,
        priorStatus: params.priorStatus,
        resolvedStatus: nextStatus,
      });

  if (nextStatus !== params.priorStatus) {
    await writeTaskStatusChange(db, params.taskId, 'dispatcher', params.priorStatus, nextStatus, {
            reason: params.routingReason,
          });
    await notifyTaskStatusChange(db, {
            taskId: params.taskId,
            fromStatus: params.priorStatus,
            toStatus: nextStatus,
            source: 'dispatcher',
          });
  }

  return nextStatus;
}

async function tableHasColumn(db: Db, tableName: string, columnName: string): Promise<boolean> {
    return await sharedColumnExists(db, tableName, columnName);
}

async function tableExists(db: Db, tableName: string): Promise<boolean> {
    return await sharedTableExists(db, tableName);
}

async function resolveDispatchAgentSlug(
  db: Db,
  params: {
    agentId: number;
    openclawAgentId?: string | null;
    sessionKey?: string | null;
    name?: string | null;
  },
): Promise<string | null> {
  let openclawAgentId = params.openclawAgentId ?? null;

  // The stable runtime ID is authoritative. Read it from the agent record as a
  // fallback so canonical Agent HQ session keys never become OpenClaw agent IDs
  // when a dispatch caller omits the field.
  if (!openclawAgentId && await tableHasColumn(db, 'agents', 'openclaw_agent_id')) {
    const row = await db.get(`SELECT openclaw_agent_id FROM agents WHERE id = ?`, params.agentId) as {
      openclaw_agent_id?: string | null;
    } | undefined;
    openclawAgentId = row?.openclaw_agent_id ?? null;
  }

  return resolveRuntimeAgentSlug({
    openclaw_agent_id: openclawAgentId,
    session_key: params.sessionKey,
    name: params.name,
  });
}

function parseStatusList(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
  } catch {
    return [];
  }
}

/**
 * Extra statuses a relationship type treats as resolved, beyond terminality.
 * Terminal blockers are released by configured terminality in
 * getRelationshipDispatchEligibility, so an empty list here simply means
 * "nothing beyond terminal" rather than implying a hardcoded default.
 */
function relationshipResolvedStatuses(raw: unknown): string[] {
  return parseStatusList(raw);
}

async function isRelationshipModelAvailable(db: Db): Promise<boolean> {
  return await tableExists(db, 'task_relationships')
    && await tableExists(db, 'sprint_type_relationship_types')
    && await tableHasColumn(db, 'sprint_type_relationship_types', 'affects_dispatch_eligibility')
    && await tableHasColumn(db, 'sprint_type_relationship_types', 'direction_semantics');
}

async function getRelationshipDispatchEligibility(db: Db, projectId?: number | null): Promise<RelationshipDispatchEligibility | null> {
  if (!await isRelationshipModelAvailable(db)) return null;

  // A blocker that has reached a terminal status in its own workflow can never
  // progress again, so it must stop blocking no matter how the relationship type
  // configured resolved_statuses_json. Without this, a narrow list such as
  // ["done"] leaves the blocked task permanently undispatchable once its blocker
  // is cancelled or failed — with no dispatch, it can never post an outcome to
  // escape. Terminality is workflow-configurable (a workflow may deliberately
  // treat `failed` as retryable), so resolve it exactly the way dispatch
  // eligibility does instead of assuming the global terminal set.
  const sourceTerminality = await buildResolvedTaskTerminalityExpression(db, 'source', 'source_sprint');
  const targetTerminality = await buildResolvedTaskTerminalityExpression(db, 'target', 'target_sprint');

  const projectFilter = projectId == null ? '' : 'AND (source.project_id = ? OR target.project_id = ?)';
  const params = [
    ...sourceTerminality.params,
    ...targetTerminality.params,
    ...(projectId == null ? [] : [projectId, projectId]),
  ];
  const rows = await db.all(`
    SELECT tr.id,
           tr.source_task_id,
           tr.target_task_id,
           tr.relationship_type_key,
           source.title AS source_title,
           source.status AS source_status,
           source.project_id AS source_project_id,
           target.title AS target_title,
           target.status AS target_status,
           target.project_id AS target_project_id,
           rt.sprint_type_key,
           rt.label,
           rt.inverse_label,
           rt.direction_semantics,
           rt.resolved_statuses_json,
           (${sourceTerminality.sql}) AS source_is_terminal,
           (${targetTerminality.sql}) AS target_is_terminal
    FROM task_relationships tr
    JOIN tasks source ON source.id = tr.source_task_id
    JOIN tasks target ON target.id = tr.target_task_id
    LEFT JOIN sprints source_sprint ON source_sprint.id = source.sprint_id
    LEFT JOIN sprints target_sprint ON target_sprint.id = target.sprint_id
    JOIN sprint_type_relationship_types rt
      ON rt.key = tr.relationship_type_key
     AND rt.sprint_type_key IN (COALESCE(source_sprint.sprint_type, 'generic'), 'generic')
    WHERE rt.affects_dispatch_eligibility = 1
      AND rt.direction_semantics IN ('target_blocks_source', 'source_blocks_target')
      ${projectFilter}
    ORDER BY tr.id ASC,
             CASE WHEN rt.sprint_type_key = COALESCE(source_sprint.sprint_type, 'generic') THEN 0 ELSE 1 END ASC
  `, ...params) as Array<Record<string, unknown>>;

  const seenRelationshipIds = new Set<number>();
  const blockedByTaskId = new Map<number, RelationshipDispatchReason[]>();
  const blockingCountByTaskId = new Map<number, number>();

  for (const row of rows) {
    const relationshipId = Number(row.id);
    if (seenRelationshipIds.has(relationshipId)) continue;
    seenRelationshipIds.add(relationshipId);

    const direction = String(row.direction_semantics);
    const sourceTaskId = Number(row.source_task_id);
    const targetTaskId = Number(row.target_task_id);
    const blockedTaskId = direction === 'target_blocks_source' ? sourceTaskId : targetTaskId;
    const blockerTaskId = direction === 'target_blocks_source' ? targetTaskId : sourceTaskId;
    const blockedStatus = direction === 'target_blocks_source' ? String(row.source_status) : String(row.target_status);
    const blockerStatus = direction === 'target_blocks_source' ? String(row.target_status) : String(row.source_status);
    const blockerTitle = direction === 'target_blocks_source' ? String(row.target_title ?? '') : String(row.source_title ?? '');
    const resolvedStatuses = relationshipResolvedStatuses(row.resolved_statuses_json);
    const blockerIsTerminal = direction === 'target_blocks_source'
      ? Number(row.target_is_terminal) === 1
      : Number(row.source_is_terminal) === 1;

    if (!resolvedStatuses.includes(blockedStatus)) {
      blockingCountByTaskId.set(blockerTaskId, (blockingCountByTaskId.get(blockerTaskId) ?? 0) + 1);
    }

    if (resolvedStatuses.includes(blockerStatus) || blockerIsTerminal) continue;
    const reasons = blockedByTaskId.get(blockedTaskId) ?? [];
    reasons.push({
      relationshipTypeKey: String(row.relationship_type_key),
      relationshipLabel: String(row.label ?? row.relationship_type_key),
      relatedTaskId: blockerTaskId,
      relatedTaskTitle: blockerTitle,
      relatedTaskStatus: blockerStatus,
    });
    blockedByTaskId.set(blockedTaskId, reasons);
  }

  return { blockedByTaskId, blockingCountByTaskId };
}

function formatRelationshipDispatchReason(reason: RelationshipDispatchReason): string {
  const title = reason.relatedTaskTitle ? ` "${reason.relatedTaskTitle}"` : '';
  return `${reason.relationshipLabel} (${reason.relationshipTypeKey}) task #${reason.relatedTaskId}${title} is ${reason.relatedTaskStatus}`;
}

async function annotateRelationshipDispatchBlocks(db: Db, blockedByTaskId: Map<number, RelationshipDispatchReason[]>): Promise<void> {
  if (!await tableExists(db, 'task_history')) return;
  for (const [taskId, reasons] of blockedByTaskId.entries()) {
    if (reasons.length === 0) continue;
    const reasonText = `Dispatch ineligible: ${reasons.map(formatRelationshipDispatchReason).join('; ')}`;
    const latest = await db.get(`
      SELECT new_value
      FROM task_history
      WHERE task_id = ? AND changed_by = 'dispatcher' AND field = 'dispatch_eligibility'
      ORDER BY id DESC
      LIMIT 1
    `, taskId) as { new_value?: string | null } | undefined;
    if (latest?.new_value === reasonText) continue;
    await writeTaskHistory(db, taskId, 'dispatcher', 'dispatch_eligibility', null, reasonText, false);
  }
}


function buildDispatchRuntimeConfig(
  runtimeConfig: unknown,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const baseConfig = typeof runtimeConfig === 'string'
    ? (() => {
        try {
          return JSON.parse(runtimeConfig) as Record<string, unknown>;
        } catch {
          return {};
        }
      })()
    : (runtimeConfig && typeof runtimeConfig === 'object'
        ? runtimeConfig as Record<string, unknown>
        : {});

  return {
    ...baseConfig,
    ...overrides,
  };
}

/**
 * Static convenience list built from seed defaults. It is not the terminality
 * authority — dispatch eligibility resolves that from configuration via
 * buildResolvedTaskTerminalityExpression.
 */
export const DISPATCHABLE_ROUTED_STATUSES = TASK_STATUSES.filter(
  (status): status is typeof TASK_STATUSES[number] => !(DEFAULT_TERMINAL_TASK_STATUS_SEEDS as readonly string[]).includes(status),
);

async function buildResolvedTaskTerminalityExpression(
  db: Db,
  taskAlias: string,
  sprintAlias: string | null,
): Promise<{ sql: string; params: unknown[] }> {
  const sources: string[] = [];
  const params: unknown[] = [];

  if (await tableExists(db, 'sprint_task_statuses') && await tableHasColumn(db, 'sprint_task_statuses', 'terminal')) {
    const workflowStatusOrder = await tableHasColumn(db, 'sprint_task_statuses', 'id') ? 'ORDER BY sprint_status.id DESC' : '';
    sources.push(`
      (
        SELECT sprint_status.terminal
        FROM sprint_task_statuses sprint_status
        WHERE sprint_status.sprint_id = ${taskAlias}.sprint_id
          AND sprint_status.status_key = ${taskAlias}.status
        ${workflowStatusOrder}
        LIMIT 1
      )
    `);
  }

  if (
    sprintAlias
    && await tableExists(db, 'sprint_type_task_statuses')
    && await tableHasColumn(db, 'sprint_type_task_statuses', 'terminal')
  ) {
    const hasTaskTenant = await tableHasColumn(db, 'tasks', 'tenant_id');
    const hasSprintTypeTenant = await tableHasColumn(db, 'sprint_type_task_statuses', 'tenant_id');
    const sprintTypeStatusOrder = await tableHasColumn(db, 'sprint_type_task_statuses', 'id') ? 'ORDER BY sprint_type_status.id DESC' : '';
    sources.push(hasTaskTenant && hasSprintTypeTenant
      ? `
        COALESCE(
          (
            SELECT sprint_type_status.terminal
            FROM sprint_type_task_statuses sprint_type_status
            WHERE sprint_type_status.sprint_type_key = ${sprintAlias}.sprint_type
              AND sprint_type_status.status_key = ${taskAlias}.status
              AND sprint_type_status.tenant_id = ${taskAlias}.tenant_id
            ${sprintTypeStatusOrder}
            LIMIT 1
          ),
          (
            SELECT sprint_type_status.terminal
            FROM sprint_type_task_statuses sprint_type_status
            WHERE sprint_type_status.sprint_type_key = ${sprintAlias}.sprint_type
              AND sprint_type_status.status_key = ${taskAlias}.status
              AND sprint_type_status.tenant_id IS NULL
            ${sprintTypeStatusOrder}
            LIMIT 1
          )
        )
      `
      : `
        (
          SELECT sprint_type_status.terminal
          FROM sprint_type_task_statuses sprint_type_status
          WHERE sprint_type_status.sprint_type_key = ${sprintAlias}.sprint_type
            AND sprint_type_status.status_key = ${taskAlias}.status
          ${sprintTypeStatusOrder}
          LIMIT 1
        )
      `);
  }

  if (await tableExists(db, 'task_statuses') && await tableHasColumn(db, 'task_statuses', 'terminal')) {
    const statusKeyColumn = await tableHasColumn(db, 'task_statuses', 'name') ? 'name' : 'status_key';
    const globalStatusOrder = await tableHasColumn(db, 'task_statuses', 'id') ? 'ORDER BY global_status.id DESC' : '';
    sources.push(`
      (
        SELECT global_status.terminal
        FROM task_statuses global_status
        WHERE global_status.${statusKeyColumn} = ${taskAlias}.status
        ${globalStatusOrder}
        LIMIT 1
      )
    `);
  }

  // No hardcoded status list terminates this cascade. Terminality is operator
  // configuration (see domains/tasks/terminality.ts); a status nobody has
  // configured is non-terminal, so unknown work stays visible and dispatchable
  // instead of silently vanishing.
  sources.push('0');

  if (sources.length === 1) {
    return { sql: sources[0], params };
  }
  return { sql: `COALESCE(${sources.join(', ')})`, params };
}

export async function getNonDispatchableTaskStatusPredicate(
  db: Db,
  taskAlias = 't',
  sprintAlias: string | null = 's',
): Promise<{ sql: string; params: unknown[] }> {
  const resolvedTerminality = await buildResolvedTaskTerminalityExpression(db, taskAlias, sprintAlias);
  return {
    sql: `(${resolvedTerminality.sql}) = 0`,
    params: resolvedTerminality.params,
  };
}

/**
 * getAllDispatchableTasks — returns all tasks across all projects (or a single
 * project) that are ready to dispatch, ordered by priority then creation time.
 * Used by the task-first routing path.
 *
 * Dispatch failure backoff (task #355): tasks with a recent dispatched_at value
 * (set by the failure handler) are excluded until DISPATCH_FAILURE_BACKOFF_SECONDS
 * have elapsed, preventing a spin-loop when the gateway/API is down.
 */
async function getAllDispatchableTasks(db: Db, projectId?: number | null): Promise<CandidateTask[]> {
  const assignmentColumn = await tableHasColumn(db, 'tasks', 'assigned_agent_id') ? 'assigned_agent_id' : 'agent_id';
  const relationshipEligibility = await getRelationshipDispatchEligibility(db, projectId);
  const statusEligibility = await getNonDispatchableTaskStatusPredicate(db, 't', 's');
  if (relationshipEligibility) {
    await annotateRelationshipDispatchBlocks(db, relationshipEligibility.blockedByTaskId);
  }
  const dispatchFailureCutoff = timestampFromEpochMs(
    Date.now() - DISPATCH_FAILURE_BACKOFF_SECONDS * 1000,
  ) ?? nowTimestamp();

  const legacyBlockingCountSelect = relationshipEligibility
    ? '0 as blocking_count'
    : `(
             SELECT COUNT(*)
             FROM task_dependencies td2
             WHERE td2.blocker_id = t.id
               AND (SELECT t2.status FROM tasks t2 WHERE t2.id = td2.blocked_id) != 'done'
           ) as blocking_count`;
  const legacyBlockerEligibilityClause = relationshipEligibility
    ? ''
    : `
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies td
        INNER JOIN tasks blocker ON blocker.id = td.blocker_id
        WHERE td.blocked_id = t.id AND blocker.status != 'done'
      )`;

  let sql = `
    SELECT t.id, t.title, t.description, t.status, t.priority,
           t.${assignmentColumn} as agent_id,
           ${await tableHasColumn(db, 'tasks', 'tenant_id') ? 't.tenant_id' : 'NULL'} AS tenant_id,
           t.project_id, t.task_type, t.sprint_id, s.name as sprint_name, s.sprint_type,
           t.created_at, t.story_points, t.active_instance_id,
           ${legacyBlockingCountSelect}
    FROM tasks t
    LEFT JOIN sprints s ON s.id = t.sprint_id
    WHERE ${statusEligibility.sql}
      AND t.active_instance_id IS NULL
      AND t.paused_at IS NULL
      AND (
        t.dispatched_at IS NULL
        OR t.dispatched_at < ?
      )
      AND (t.sprint_id IS NULL OR EXISTS (
        SELECT 1 FROM sprints sp WHERE sp.id = t.sprint_id AND sp.status = 'active'
      ))
      ${legacyBlockerEligibilityClause}
  `;
  const params: unknown[] = [...statusEligibility.params, dispatchFailureCutoff];
  if (projectId != null) {
    sql += ` AND t.project_id = ?`;
    params.push(projectId);
  }
  sql += `
    ORDER BY
      CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC,
      t.created_at ASC
  `;
  const candidates = await db.all(sql, ...params) as CandidateTask[];
  if (!relationshipEligibility) return candidates;
  return candidates
    .filter(task => !relationshipEligibility.blockedByTaskId.has(task.id))
    .map(task => ({
      ...task,
      blocking_count: relationshipEligibility.blockingCountByTaskId.get(task.id) ?? 0,
    }));
}

/**
 * getMatchingRoutingRules — returns sprint routing rules that match a task's
 * sprint_id/status/task_type, ordered by scope specificity, task-type
 * specificity, priority DESC, and stable id tiebreaker. Each row includes full
 * agent fields for dispatch.
 */
async function getMatchingRoutingRules(db: Db, task: CandidateTask): Promise<RoutingRuleRow[]> {
  const hasProjectsTable = await tableHasColumn(db, 'projects', 'id');
  // Array.prototype.every is SYNCHRONOUS. An async callback returns a Promise, which is
  // always truthy, so `.every(async ...)` unconditionally returns true and the column check
  // never actually runs. The columns must be resolved first, then reduced.
  const REPO_COLUMNS = ['repo_path', 'repo_url', 'repo_access_mode'];
  const hasProjectRepoColumns = (await Promise.all(
    REPO_COLUMNS.map((column) => tableHasColumn(db, 'projects', column)),
  )).every(Boolean);
  const hasWorkflowRepoColumns = (await Promise.all(
    REPO_COLUMNS.map((column) => tableHasColumn(db, 'sprints', column)),
  )).every(Boolean);
  const hasScopedRoutingColumns = await tableHasColumn(db, 'sprint_task_routing_rules', 'project_id')
    && await tableHasColumn(db, 'sprint_task_routing_rules', 'sprint_type');
  const hasRoutingTenantColumn = await tableHasColumn(db, 'sprint_task_routing_rules', 'tenant_id');
  const routingRuleEnabledCondition = await tableHasColumn(db, 'sprint_task_routing_rules', 'enabled') ? 'AND rr.enabled = 1' : '';
  const hasAgentTenantColumn = await tableHasColumn(db, 'agents', 'tenant_id');
  const hasProviderConnectionColumn = await tableHasColumn(db, 'agents', 'provider_connection_id');
  const projectRepoSelect = hasProjectRepoColumns
    ? 'p.repo_path as project_repo_path, p.repo_url as project_repo_url, p.repo_access_mode as project_repo_access_mode,'
    : 'NULL as project_repo_path, NULL as project_repo_url, NULL as project_repo_access_mode,';
  const workflowRepoSelect = hasWorkflowRepoColumns
    ? 's.repo_path as workflow_repo_path, s.repo_url as workflow_repo_url, s.repo_access_mode as workflow_repo_access_mode,'
    : 'NULL as workflow_repo_path, NULL as workflow_repo_url, NULL as workflow_repo_access_mode,';
  const projectJoin = hasProjectsTable ? 'LEFT JOIN projects p ON p.id = a.project_id' : '';
  const workflowJoin = hasWorkflowRepoColumns ? 'LEFT JOIN sprints s ON s.id = COALESCE(rr.sprint_id, ?)' : '';

  const tenantCondition = [
    hasRoutingTenantColumn && task.tenant_id != null ? 'rr.tenant_id = ?' : null,
    hasAgentTenantColumn && task.tenant_id != null ? 'a.tenant_id = ?' : null,
  ].filter(Boolean).join(' AND ');
  const tenantParams = [
    ...(hasRoutingTenantColumn && task.tenant_id != null ? [task.tenant_id] : []),
    ...(hasAgentTenantColumn && task.tenant_id != null ? [task.tenant_id] : []),
  ];

  const runRuleQuery = async (scopeCondition: string, params: unknown[], status: string): Promise<RoutingRuleRow[]> => await db.all(`
      SELECT rr.*,
             a.id as agent_id,
             a.job_instructions, a.enabled, a.timeout_seconds, a.model,
             a.skill_names,
             a.session_key as agent_session_key, a.name as agent_name, a.model as agent_model,
             a.openclaw_agent_id, a.runtime_type, a.runtime_config, a.hooks_url as agent_hooks_url,
             a.hooks_auth_header as agent_hooks_auth_header,
             a.workspace_path, a.preferred_provider, ${hasProviderConnectionColumn ? 'a.provider_connection_id' : 'NULL'} as provider_connection_id, a.repo_path, a.repo_url, a.repo_access_mode,
             ${hasAgentTenantColumn ? 'a.tenant_id' : 'NULL'} as tenant_id,
             ${projectRepoSelect}
             ${workflowRepoSelect}
             a.os_user
      FROM sprint_task_routing_rules rr
      JOIN agents a ON a.id = rr.agent_id AND a.enabled = 1
      ${projectJoin}
      ${workflowJoin}
      WHERE ${scopeCondition}
        ${tenantCondition ? `AND ${tenantCondition}` : ''}
        ${routingRuleEnabledCondition}
        AND rr.status = ?
        AND (rr.task_type = ? OR rr.task_type IS NULL)
      ORDER BY CASE WHEN rr.sprint_id = ? THEN 0 ELSE 1 END,
               CASE WHEN rr.task_type = ? THEN 0 ELSE 1 END,
               rr.priority DESC,
               rr.id ASC
    `, ...(hasWorkflowRepoColumns ? [task.sprint_id ?? null] : []), ...params, ...tenantParams, status, task.task_type ?? null, task.sprint_id ?? null, task.task_type ?? null) as RoutingRuleRow[];

  const loadSprintScopedRules = async (status: string): Promise<RoutingRuleRow[]> => {
    if (!task.sprint_id) return [];
    if (hasScopedRoutingColumns && task.project_id && task.sprint_type) {
      return await runRuleQuery(
        'rr.project_id = ? AND rr.sprint_type = ? AND (rr.sprint_id = ? OR rr.sprint_id IS NULL)',
        [task.project_id, task.sprint_type, task.sprint_id],
        status,
      );
    }
    return await runRuleQuery('rr.sprint_id = ?', [task.sprint_id], status);
  };

  try {
    const sprintRules = await loadSprintScopedRules(task.status);
    if (sprintRules.length > 0) return sprintRules;
  } catch {
    // sprint-scoped tables may not exist in minimal test DBs; fall through
  }

  if (task.status === 'in_progress' && task.sprint_id) {
    try {
      const sprintFallback = await loadSprintScopedRules('ready');
      if (sprintFallback.length > 0) return sprintFallback;
    } catch {
      // sprint-scoped tables may not exist in minimal test DBs
    }
  }

  return [];
}

async function isWorkflowRepoRequiredForTask(db: Db, task: CandidateTask): Promise<boolean> {
  if (!task.sprint_id) return false;
  if (!await tableHasColumn(db, 'sprint_types', 'repo_required')) {
    return task.sprint_type === 'dev';
  }

  try {
    const hasSprintTypesTenant = await tableHasColumn(db, 'sprint_types', 'tenant_id');
    const hasSprintsTenant = await tableHasColumn(db, 'sprints', 'tenant_id');
    const tenantJoin = hasSprintTypesTenant && hasSprintsTenant
      ? 'AND (st.tenant_id IS NULL OR st.tenant_id = s.tenant_id)'
      : '';
    const tenantOrder = hasSprintTypesTenant ? 'ORDER BY st.tenant_id IS NULL ASC' : '';
    const row = await db.get(`
      SELECT COALESCE(st.repo_required, 0) AS repo_required
      FROM sprints s
      LEFT JOIN sprint_types st
        ON st.key = s.sprint_type
        ${tenantJoin}
      WHERE s.id = ?
      ${tenantOrder}
      LIMIT 1
    `, task.sprint_id) as { repo_required?: number | null } | undefined;
    return row?.repo_required === 1;
  } catch {
    return task.sprint_type === 'dev';
  }
}

// ── Run context file ─────────────────────────────────────────────────────────

/** Context filename written to agent workspaces before dispatch. */
const RUN_CONTEXT_FILENAME = '.agent-hq-run-context.json';

/**
 * writeRunContext — write `.agent-hq-run-context.json` to the agent's working
 * directory so the `agent-hq-callback` CLI (and any other tool) can auto-discover
 * the instance/task/session context without reading prompt prose.
 *
 * The file is written atomically (write to .tmp, rename) to avoid partial reads
 * by the agent process. If the directory doesn't exist, the write is skipped
 * silently (the agent may still fall back to env vars or CLI flags).
 */
export function writeRunContext(params: {
  workingDirectory: string;
  instanceId: number;
  durableRunId?: string | null;
  taskId: number;
  sessionKey: string;
  agentSlug: string;
  apiBase?: string;
  workspaceRoot?: string | null;
  activeRepoRoot?: string | null;
  worktreeRoot?: string | null;
}): void {
  const { workingDirectory, instanceId, durableRunId, taskId, sessionKey, agentSlug, apiBase, workspaceRoot, activeRepoRoot, worktreeRoot } = params;
  const contextPath = path.join(workingDirectory, RUN_CONTEXT_FILENAME);
  const tmpPath = contextPath + '.tmp';
  const data = {
    instance_id: instanceId,
    durable_run_id: durableRunId ?? null,
    task_id: taskId,
    session_key: sessionKey,
    agent_slug: agentSlug,
    api_base: apiBase ?? 'http://localhost:3501',
    workspace_root: workspaceRoot ?? null,
    active_repo_root: activeRepoRoot ?? workingDirectory,
    worktree_root: worktreeRoot ?? null,
    written_at: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, contextPath);
    console.log(`[dispatcher] writeRunContext: wrote ${contextPath}`);
  } catch (err) {
    console.warn(`[dispatcher] writeRunContext: failed to write ${contextPath}:`, err);
    // Non-fatal — agent can still use env vars or CLI flags
  }
}

/**
 * cleanupRunContext — remove the `.agent-hq-run-context.json` file from a workspace.
 * Called during dispatch failure cleanup to avoid stale context files.
 */
export function cleanupRunContext(workingDirectory: string): void {
  try {
    const contextPath = path.join(workingDirectory, RUN_CONTEXT_FILENAME);
    if (fs.existsSync(contextPath)) {
      fs.unlinkSync(contextPath);
    }
  } catch {
    // Best-effort cleanup
  }
}

// ── Agent runner ─────────────────────────────────────────────────────────────

/**
 * buildSessionKey — Deterministic, isolated session key per job instance.
 *
 * Format: run:<instanceId>:<durableRunId>
 *
 * Uses `hook:` prefix because OpenClaw's allowedSessionKeyPrefixes config
 * restricts caller-provided sessionKey values to this prefix for safety.
 * The `atlas:jobrun:<id>` suffix makes each run uniquely addressable.
 */
function buildSessionKey(instanceId: number, durableRunId?: string | null): string {
  // OpenClaw internally stores the session as "agent:<runtime-slug>:run:<id>:<durable-id>"
  // but the dispatch payload and stored session_key use the short run: form.
  // The session-key resolution endpoint reconstructs the full key for chat.history.
  return buildHookSessionKey(instanceId, durableRunId);
}

// ── CLAUDE.md generator ──────────────────────────────────────────────────────

/**
 * generateClaudeMd — write a CLAUDE.md orientation file to the agent's
 * workingDirectory before each claude-code dispatch.
 *
 * The file contains references (paths) to identity docs, memory, and skills
 * so Claude Code knows what to read. It never pastes file contents directly.
 * Overwrites any existing CLAUDE.md on each dispatch so the timestamp is fresh.
 */
export function generateClaudeMd(params: {
  workingDirectory: string;
  skillNames: string[];
  hooksUrl?: string | null;
}): void {
  const { workingDirectory, skillNames, hooksUrl } = params;
  const timestamp = new Date().toISOString();

  // Identity document table
  const identityDocs = [
    { file: 'SOUL.md',     desc: 'Who you are — persona, values, and working style' },
    { file: 'IDENTITY.md', desc: 'Your role, agent ID, project, and session key' },
    { file: 'AGENTS.md',   desc: 'Operating manual — task workflow, branch conventions, callbacks' },
    { file: 'TOOLS.md',    desc: 'Environment notes — Agent HQ URLs, SSH/infra details' },
    { file: 'USER.md',     desc: 'About the client — preferences and context' },
  ];

  const identityTable = [
    '| File | Description |',
    '|------|-------------|',
    ...identityDocs.map(d => `| \`${path.join(workingDirectory, d.file)}\` | ${d.desc} |`),
  ].join('\n');

  // Memory section
  const memoryDir  = path.join(workingDirectory, 'memory');
  const memoryFile = path.join(workingDirectory, 'MEMORY.md');
  const memorySection = [
    `- **Memory directory:** \`${memoryDir}/\` — dated session notes (e.g. \`YYYY-MM-DD.md\`)`,
    `- **MEMORY.md:** \`${memoryFile}\` — persistent cross-session notes`,
    '',
    '> Read these when resuming prior work. Write findings here; do not keep mental notes.',
  ].join('\n');

  // Skills section
  let skillsSection: string;
  if (skillNames.length === 0) {
    skillsSection = '_No skills assigned to this job._';
  } else {
    const skillsDir = path.join(workingDirectory, '.claude', 'skills');
    const lines = skillNames.map(name => {
      const skillMd = path.join(skillsDir, name, 'SKILL.md');
      return `- **${name}**: \`${skillMd}\``;
    });
    skillsSection = lines.join('\n');
  }

  // Docker / remote gateway note
  const dockerNote = hooksUrl
    ? `\n## Docker / Remote Gateway Note\n\nThis agent runs through a remote gateway at \`${hooksUrl}\`.\nUse Agent HQ MCP lifecycle tools for task notes, evidence, check-ins, and outcomes. Do not call Agent HQ lifecycle HTTP endpoints directly from this runtime.\n`
    : '';

  const content = [
    `<!-- Auto-generated by Agent HQ dispatcher — do not edit manually -->`,
    `<!-- Generated: ${timestamp} -->`,
    ``,
    `# Agent Orientation`,
    ``,
    `This file is regenerated on every dispatch. Read the referenced files via the **Read** tool as needed.`,
    ``,
    `## Identity Documents`,
    ``,
    identityTable,
    ``,
    `## Memory`,
    ``,
    memorySection,
    ``,
    `## Skills`,
    ``,
    skillsSection,
    ``,
    `## Workspace`,
    ``,
    `Working directory: \`${workingDirectory}\``,
    dockerNote,
  ].join('\n');

  fs.writeFileSync(path.join(workingDirectory, 'CLAUDE.md'), content, 'utf-8');
  console.log(`[dispatcher] generateClaudeMd: wrote CLAUDE.md to ${workingDirectory}`);
}

// ── Skill symlink sync ────────────────────────────────────────────────────────

/**
 * OPENCLAW_SKILLS_PATH — the skills directory shipped with the OpenClaw package.
 *
 * Resolved once at module load time from the `openclaw` binary location so it
 * works regardless of NVM node version or install prefix.  Falls back to the
 * well-known default path when the binary cannot be located.
 *
 * Override with the OPENCLAW_SKILLS_PATH env var in tests or non-standard installs.
 */
function resolveOpenClawSkillsPath(): string {
  if (process.env.OPENCLAW_SKILLS_PATH) return process.env.OPENCLAW_SKILLS_PATH;

  try {
    // Locate the openclaw binary via PATH and walk up to the package root.
    // Typical layout: <prefix>/bin/openclaw → resolves to <prefix>/lib/node_modules/openclaw/openclaw.mjs
    // Skills live at: <prefix>/lib/node_modules/openclaw/skills/
    const { execFileSync } = require('child_process') as typeof import('child_process');
    const binPath = execFileSync('which', ['openclaw'], { encoding: 'utf-8' }).trim();
    const resolved = fs.realpathSync(binPath);
    // Ascend from the resolved binary file until we find a `skills/` sibling directory.
    let dir = path.dirname(resolved);
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'skills');
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
      dir = path.dirname(dir);
    }
  } catch {
    // which / realpathSync failed — fall through to default
  }

  // Hard-coded fallback matching the standard NVM install used in production
  return path.join(
    process.env.HOME ?? '/root',
    '.nvm/versions/node/v24.14.0/lib/node_modules/openclaw/skills',
  );
}

export const OPENCLAW_SKILLS_PATH = resolveOpenClawSkillsPath();

/**
 * syncSkillDirs — create `.claude/skills/<name>` symlinks in workingDirectory
 * for each skill assigned to the job template.
 *
 * Steps:
 *   1. Ensure {workingDirectory}/.claude/skills/ directory exists (mkdirSync recursive).
 *   2. For each skill name, resolve the source dir in OPENCLAW_SKILLS_PATH.
 *   3. If the source dir does not exist, log a warning and skip.
 *   4. If a symlink already exists and points to the correct target, skip (idempotent).
 *   5. If a symlink exists but points elsewhere, replace it.
 *   6. Create the symlink.
 *
 * No error is thrown for an empty skillNames array — it is a valid no-op.
 */
export function syncSkillDirs(params: {
  workingDirectory: string;
  skillNames: string[];
  skillsBasePath?: string;
}): void {
  const { workingDirectory, skillNames, skillsBasePath = OPENCLAW_SKILLS_PATH } = params;

  if (skillNames.length === 0) return;

  const skillsDir = path.join(workingDirectory, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  for (const name of skillNames) {
    const source = path.join(skillsBasePath, name);

    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
      console.warn(`[dispatcher] syncSkillDirs: skill "${name}" not found at ${source} — skipping`);
      continue;
    }

    const link = path.join(skillsDir, name);

    // lstat (not stat) so we see the symlink itself, not its target.
    let lstat: ReturnType<typeof fs.lstatSync> | null = null;
    try { lstat = fs.lstatSync(link); } catch { /* not present */ }

    if (lstat) {
      if (lstat.isSymbolicLink()) {
        const existing = fs.readlinkSync(link);
        if (existing === source) {
          // Already correct — idempotent skip
          continue;
        }
      }
      // Stale symlink or unexpected file — remove it
      fs.unlinkSync(link);
    }

    fs.symlinkSync(source, link);
    console.log(`[dispatcher] syncSkillDirs: linked ${link} → ${source}`);
  }
}

// ── End CLAUDE.md generator / skill sync ─────────────────────────────────────

/**
 * fireAgentRun — dispatch an isolated agent run via the resolved AgentRuntime.
 *
 * The runtime is resolved from job.runtime_type / job.runtime_config so the
 * dispatcher remains backend-agnostic. All OpenClaw-specific logic lives in
 * OpenClawRuntime; future backends (ClaudeCodeRuntime, etc.) plug in here.
 */
async function fireAgentRun(
  db: Db,
  job: JobRow,
  message: string,
  instanceId: number,
  agentSlug: string,
  taskStatusAtDispatch: string,
  taskId?: number | null,
  storyPoints?: number | null,
  worktreePath?: string | null,
  repoContext?: {
    repoAccessMode: RepoAccessMode | null;
    repoSource: string | null;
    repoWorkspacePath: string | null;
    repoBranch: string | null;
  },
  modelScope?: { projectId?: number | null; sprintId?: number | null; sprintType?: string | null; tenantId?: number | null },
): Promise<void> {
  const timeoutSec = job.timeout_seconds || 900;
  const durableRunId = await ensureJobInstanceDurableRunId(db, instanceId);
  const boundaryDurableRunId = durableRunId?.trim() || `legacy-instance:${instanceId}`;
  const sessionKey = buildSessionKey(instanceId, durableRunId);
  const pathContext = resolveDispatchPathContext({
    worktreePath,
    runtimeConfigWorkingDirectory: extractWorkingDirectoryFromRuntimeConfig(job.runtime_config),
    workspacePath: job.workspace_path,
  });
  const {
    activeRepoRoot,
    workspaceContainerRoot,
    worktreeRoot,
    runtimeConfigWorkingDirectory,
    pathMode,
    repoRootSource,
    workspaceContainerSource,
  } = pathContext;

  console.log(
    `[dispatcher] Instance #${instanceId} path resolution: mode=${pathMode} activeRepoRoot=${activeRepoRoot ?? 'null'} workspaceRoot=${workspaceContainerRoot ?? 'null'} worktreePath=${worktreeRoot ?? 'null'} runtimeConfigWorkingDirectory=${runtimeConfigWorkingDirectory ?? 'null'} repoRootSource=${repoRootSource} workspaceRootSource=${workspaceContainerSource}`
  );

  // Store the deterministic session key on the instance BEFORE dispatch
  // so it's always available for transcript lookups even if dispatch fails.
  await db.run(`UPDATE job_instances SET session_key = ? WHERE id = ?`, sessionKey, instanceId);

  // Model precedence (highest wins):
  //   1. story_point_model_routing (provider-aware: preferred_provider > NULL-provider)
  //   2. job_template.model
  //   3. agent.model
  //   4. gateway default (null → omit from payload)
  const preferredProvider = job.preferred_provider ?? null;
  const spModel = await resolveModelFromStoryPoints(db, storyPoints ?? null, preferredProvider, modelScope);
  const model = spModel?.model || job.model || job.agent_model || null;
  const thinking = spModel?.thinking_level ?? null;
  const fastMode = spModel?.fast_mode ?? null;
  if (spModel) {
    console.log(
      `[dispatcher] Story points=${storyPoints} preferred_provider=${preferredProvider ?? 'null'} → model=${spModel.model} thinking=${spModel.thinking_level ?? 'default'} fastMode=${spModel.fast_mode ?? 'default'} (rule: ${spModel.label ?? 'unnamed'})`
    );
  }
  console.log(
    `[dispatcher] Model resolution — instance #${instanceId} job="${job.title}"` +
    ` preferred_provider=${preferredProvider ?? 'null'} sp_model=${spModel?.model ?? 'null'} job.model=${job.model ?? 'null'} agent.model=${job.agent_model ?? 'null'}` +
    ` effective=${model ?? 'gateway-default'}`
  );

  const skillMaterializationRuntimeConfig = buildDispatchRuntimeConfig(job.runtime_config, {
    ...(activeRepoRoot ? { workingDirectory: activeRepoRoot } : {}),
  });
  const runtimeType = job.runtime_type ?? 'openclaw';
  const tenantId = Number(job.tenant_id ?? modelScope?.tenantId ?? 1);
  const requiredLifecycleTools = taskId != null
    ? ['agent_hq_post_task_outcome', 'agent_hq_start_task_run']
    : [];
  // Snapshot assignments before writing runtime artifacts. The local adapters
  // re-read the live assignments immediately before spawn; using this same
  // snapshot for materialization and boundary construction closes both sides
  // of the prepare-A/launch-B race.
  const boundaryAssignments = await loadRuntimeBoundaryAssignments({
    db,
    tenantId,
    agentId: job.agent_id,
    requiredLifecycleTools,
    failClosed: runtimeType === 'claude-code' || runtimeType === 'codex',
  });

  // Persist resolved runtime routing on the instance so it's visible in the UI/audit log.
  if (model || thinking || fastMode !== null) {
    if (await tableHasColumn(db, 'job_instances', 'effective_fast_mode')) {
      await db.run(`UPDATE job_instances SET effective_model = ?, effective_thinking_level = ?, effective_fast_mode = ? WHERE id = ?`, model ?? null, thinking ?? null, fastMode === null ? null : (fastMode ? 1 : 0), instanceId);
    } else {
      await db.run(`UPDATE job_instances SET effective_model = ?, effective_thinking_level = ? WHERE id = ?`, model ?? null, thinking ?? null, instanceId);
    }
  }

  // Resolve the correct runtime for this agent (openclaw, claude-code, etc.)
  const runtime = resolveRuntime({
    runtime_type: job.runtime_type,
    runtime_config: job.runtime_config,
  });

  // ── Runtime-aware skill materialization (task #644) ──────────────────────
  // Agent HQ owns the canonical skill assignments. Before dispatching, materialize
  // skills into the correct runtime artifacts (symlinks, CLAUDE.md sections,
  // prompt context, etc.) via the adapter for this agent's runtime_type.
  //
  // Replaces the previous claude-code-only `generateClaudeMd` + `syncSkillDirs`
  // block. All runtime types now go through the adapter factory so OpenClaw,
  // Custom, Webhook agents each receive the correct materialization behavior
  // without requiring runtime-specific conditionals here.
  {
    // Resolve the working directory (same logic as before, now shared across runtimes)
    const workingDirectory: string | null = activeRepoRoot;

    const skillNames = boundaryAssignments.skills.map((skill) => skill.name);

    if (workingDirectory) {
      const adapter = getSkillMaterializationAdapter(job.runtime_type);
      const strictRuntimeSkills = job.runtime_type === 'claude-code' || job.runtime_type === 'codex';
      try {
        const materializeResult = await adapter.materialize({
          workingDirectory,
          skillNames,
          skillsBasePath: OPENCLAW_SKILLS_PATH,
          hooksUrl: job.agent_hooks_url,
          runtimeConfig: skillMaterializationRuntimeConfig,
          db,
          tenantId,
        });
        for (const warn of materializeResult.warnings) {
          console.warn(`[dispatcher] ${warn}`);
        }
        await recordSkillMaterializationIssues(db, materializeResult, {
                    runtimeType: adapter.adapterName,
                    agentId: job.agent_id ?? null,
                    agentName: job.agent_name ?? null,
                    instanceId,
                    taskId,
                    tenantId,
                    requestedSkillNames: skillNames,
                  });
        const satisfiedSkills = new Set(
          materializeResult.details
            .filter((detail) => detail.action === 'created'
              || detail.action === 'updated'
              || (detail.action === 'skipped' && detail.reason === 'already correct'))
            .map((detail) => detail.skill),
        );
        const missingSkills = skillNames.filter((name) => !satisfiedSkills.has(name));
        if (strictRuntimeSkills && (
          !materializeResult.ok
          || missingSkills.length > 0
          || (skillNames.length > 0 && materializeResult.warnings.length > 0)
        )) {
          throw new Error(
            materializeResult.error
              ?? `Assigned skills were not materialized exactly: ${missingSkills.join(', ') || materializeResult.warnings.join('; ')}`,
          );
        }
        if (!materializeResult.ok && materializeResult.error) {
          console.warn(`[dispatcher] skill materialization error for instance #${instanceId}: ${materializeResult.error}`);
        } else if (materializeResult.count > 0) {
          console.log(
            `[dispatcher] skill materialization (${adapter.adapterName}): ${materializeResult.count} skill(s) for instance #${instanceId}`,
          );
        }
      } catch (matErr) {
        if (strictRuntimeSkills) throw matErr;
        console.warn(`[dispatcher] skill materialization failed for instance #${instanceId}:`, matErr);
      }
    }
  }

  // ── Runtime-aware MCP materialization ────────────────────────────────────
  // OpenClaw agents consume assigned MCP servers through parent workspace
  // extension bundles. Hermes full-runtime agents consume the same assigned MCP
  // servers from their prepared runtime cwd/profile context so lifecycle writes
  // happen through Agent HQ MCP callbacks instead of proxy-parsed stdout blocks.
  const runtimeTypeForMcp = runtimeType;
  let openClawMcpReadiness: DispatchParams['openClawMcpReadiness'] = null;
  let mcpStartupError: Error | null = null;
  if (runtimeTypeForMcp === 'openclaw' || runtimeTypeForMcp === 'hermes') {
    const effectiveMcpDir: string | null = runtimeTypeForMcp === 'openclaw' ? workspaceContainerRoot : activeRepoRoot;
    if (effectiveMcpDir) {
      try {
        const mcpResult = await syncAssignedMcpForAgent({
                  db,
                  agentId: job.agent_id,
                  workingDirectory: effectiveMcpDir,
                  // The routed session key is `agent:<agentSlug>:run:*`, so OpenClaw
                  // discovers the bundle in this slug's workspace — keep them aligned.
                  dispatchAgentSlug: agentSlug,
                  activateOpenClawWorkspaceBundle: runtimeTypeForMcp === 'openclaw',
                  refreshPluginRegistry: runtimeTypeForMcp === 'openclaw',
                });
        for (const warn of mcpResult.warnings) {
          console.warn(`[dispatcher] ${warn}`);
        }
        if (!mcpResult.ok && mcpResult.error) {
          console.warn(
            `[dispatcher] MCP materialization error for instance #${instanceId}: ${mcpResult.error}`,
          );
          mcpStartupError = new Error(`MCP materialization failed before dispatch for instance #${instanceId}: ${mcpResult.error}`);
        } else if (mcpResult.count > 0) {
          console.log(
            `[dispatcher] MCP materialization complete: ${mcpResult.count} server(s) for instance #${instanceId}; servers=${mcpResult.serverNames.join(', ') || '(none)'}; bundle=${mcpResult.bundlePath ?? '(none)'}`,
          );
        }
        if (runtimeTypeForMcp === 'openclaw' && mcpResult.ok && mcpResult.count > 0) {
          openClawMcpReadiness = {
            serverNames: mcpResult.serverNames,
            requiredToolNames: requiredOpenClawMcpToolsForServerNames(mcpResult.serverNames),
            requiredToolsByServerName: requiredOpenClawMcpToolsByServerName(mcpResult.serverNames),
            materializedCount: mcpResult.count,
            bundlePath: mcpResult.bundlePath ?? null,
            workingDirectory: mcpResult.workingDirectory ?? null,
          };
          console.log(
            `[dispatcher] MCP registry refresh complete for instance #${instanceId}; requiredTools=${openClawMcpReadiness.requiredToolNames.join(', ') || '(none)'}`,
          );
        }
        if (
          runtimeTypeForMcp === 'openclaw'
          && taskId != null
          && mcpResult.ok
          && mcpResult.count > 0
          && !hasMaterializedAgentHqLifecycleMcp(mcpResult.bundlePath, job.agent_id)
        ) {
          console.warn(
            `[dispatcher] Agent HQ lifecycle MCP preflight warning for instance #${instanceId}: ` +
            `bundle ${mcpResult.bundlePath ?? '(none)'} does not contain agent-hq__agent-${job.agent_id}; ` +
            'Agent HQ lifecycle tools such as agent_hq_start_task_run and agent_hq_post_task_outcome may be absent from the OpenClaw session tool surface.',
          );
        }
      } catch (mcpErr) {
        console.warn(`[dispatcher] MCP materialization failed for instance #${instanceId}:`, mcpErr);
        mcpStartupError = mcpErr instanceof Error ? mcpErr : new Error(String(mcpErr));
      }
    }
  }

  // ── Write .agent-hq-run-context.json (task #466) ───────────────────────
  // Resolve the effective workspace directory for context file injection.
  // This covers all runtimes (OpenClaw, claude-code, etc.) — the file is
  // written to the agent's working directory before dispatch so the
  // agent-hq-callback CLI can auto-discover instance/task/session context.
  const effectiveWorkDir: string | null = activeRepoRoot;
  if (effectiveWorkDir && taskId != null) {
    try {
      writeRunContext({
        workingDirectory: effectiveWorkDir,
        instanceId,
        durableRunId,
        taskId,
        sessionKey,
        agentSlug,
        workspaceRoot: workspaceContainerRoot,
        activeRepoRoot,
        worktreeRoot,
      });
    } catch (ctxErr) {
      console.warn(`[dispatcher] writeRunContext failed for instance #${instanceId}:`, ctxErr);
    }
  }

  try {
    // Dispatching should be a function of the runtime interface.
    // Do not bypass AgentRuntime with direct /hooks/agent calls here.
    if (mcpStartupError) throw mcpStartupError;

    // Build runtimeConfig override from story-point rule (max_turns / max_budget_usd)
    // and resolved repo-root path. The active repo root must remain authoritative
    // for the dispatched runtime cwd even if the stored runtime config still points
    // at the parent workspace or another stale location.
    const runtimeConfigOverride: Record<string, unknown> = {};
    if (spModel) {
      if (spModel.max_turns != null) runtimeConfigOverride.maxTurns = spModel.max_turns;
      if (spModel.max_budget_usd != null) runtimeConfigOverride.maxBudgetUsd = spModel.max_budget_usd;
      if (spModel.fast_mode !== null) runtimeConfigOverride.fastMode = spModel.fast_mode;
    }
    if (activeRepoRoot) {
      runtimeConfigOverride.workingDirectory = activeRepoRoot;
    }
    const dispatchRuntimeConfig = buildDispatchRuntimeConfig(job.runtime_config, runtimeConfigOverride);
    const providerDispatch = await resolveRuntimeProviderDispatchSelection({
          db,
          tenantId,
          runtimeType,
          providerConnectionId: job.provider_connection_id ?? null,
          preferredProvider,
          model,
          runtimeConfig: dispatchRuntimeConfig,
        });
    const executableFingerprint = resolveRuntimeBoundaryExecutableFingerprint(
      runtimeType,
      providerDispatch.runtimeConfig,
    );

    console.log(
      `[dispatcher] Instance #${instanceId} runtime config handoff: mode=${pathMode} workingDirectory=${typeof dispatchRuntimeConfig.workingDirectory === 'string' ? dispatchRuntimeConfig.workingDirectory : 'null'} activeRepoRoot=${activeRepoRoot ?? 'null'} workspaceRoot=${workspaceContainerRoot ?? 'null'} worktreePath=${worktreeRoot ?? 'null'} runtimeConfigWorkingDirectory=${runtimeConfigWorkingDirectory ?? 'null'} repoRootSource=${repoRootSource} workspaceRootSource=${workspaceContainerSource}`
    );

    const runtimeBoundary = buildRuntimeBoundaryV1({
      tenantId,
      projectId: job.project_id ?? modelScope?.projectId ?? null,
      workflowId: modelScope?.sprintId ?? null,
      taskId: taskId ?? null,
      instanceId,
      durableRunId: boundaryDurableRunId,
      agentId: job.agent_id,
      agentSlug,
      runtimeType,
      executableFingerprint,
      runtimeConfig: providerDispatch.runtimeConfig,
      model: providerDispatch.model,
      reasoning: thinking,
      fastMode,
      timeoutSeconds: timeoutSec,
      prompt: message,
      workspaceRoot: workspaceContainerRoot,
      activeRepoRoot,
      repoAccessMode: repoContext?.repoAccessMode ?? null,
      repoSource: repoContext?.repoSource ?? null,
      branch: repoContext?.repoBranch ?? null,
      mcpServers: boundaryAssignments.mcpServers,
      skills: boundaryAssignments.skills,
      registryTools: boundaryAssignments.registryTools,
      requiredLifecycleTools,
      provider: providerDispatch.provider || preferredProvider,
      providerConnectionId: job.provider_connection_id ?? null,
      callbackIdentity: sessionKey,
      requestedBy: 'dispatcher',
    });

    const runtimeParams: DispatchParams = {
      message,
      agentSlug,
      sessionKey,
      timeoutSeconds: timeoutSec,
      name: `Agent HQ: ${job.title}`,
      model: providerDispatch.model,
      preferredProvider: providerDispatch.provider || preferredProvider,
      providerConnectionId: job.provider_connection_id ?? null,
      thinking,
      fastMode,
      // Extra context for runtimes that manage their own session lifecycle (e.g. ClaudeCodeRuntime)
      instanceId,
      durableRunId,
      taskId: taskId ?? null,
      db,
      repoAccessMode: repoContext?.repoAccessMode ?? null,
      repoSource: repoContext?.repoSource ?? null,
      repoWorkspacePath: repoContext?.repoWorkspacePath ?? null,
      repoBranch: repoContext?.repoBranch ?? null,
      // Workspace boundary (task #364): keep the broader workspace container root
      // separate from the authoritative active repo root for this dispatched run.
      workspaceRoot: workspaceContainerRoot,
      activeRepoRoot,
      pathMetadata: {
        pathMode,
        repoRootSource,
        workspaceRootSource: workspaceContainerSource,
        worktreeRoot,
        runtimeConfigWorkingDirectory,
      },
      runtimeConfig: providerDispatch.runtimeConfig,
      runtimeBoundary,
      openClawMcpReadiness,
      hooksUrl: job.agent_hooks_url ?? null,
      hooksAuthHeader: job.agent_hooks_auth_header ?? null,
    };

    await prepareRuntimeAuthProfiles(runtime, runtimeParams);
    const { runId } = await runtime.dispatch(runtimeParams);

    console.log(
      `[dispatcher] Instance #${instanceId} dispatched via ${job.runtime_type ?? 'openclaw'} runtime` +
      ` — sessionKey=${sessionKey} model=${model ?? 'gateway-default'}${runId ? ` runId=${runId}` : ''}`
    );

    // Store run handle for audit / future abort
    await db.run(`UPDATE job_instances SET response = ? WHERE id = ?`, JSON.stringify({ runId }), instanceId);

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[dispatcher] Instance #${instanceId} dispatch failed — ${errorMsg}`);

    // Clean up run context file on dispatch failure (task #466)
    if (effectiveWorkDir) {
      cleanupRunContext(effectiveWorkDir);
      // Clean up GitHub credential files on dispatch failure (task #613)
      cleanupGitHubCredentials(effectiveWorkDir);
    }

    await db.run(`
      UPDATE job_instances
      SET status = 'failed', error = ?, completed_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = ? AND status IN ('dispatched', 'running')
    `, errorMsg, instanceId);

    // Reset linked task back to the correct workflow status, but apply retry backoff
    // to prevent a spin-loop when the gateway/API is persistently down.
    //
    // Strategy (Option 1 from task #355):
    //  - Increment retry_count on each dispatch failure.
    //  - If retry_count >= max_retries → mark task failed (stop flooding the DB).
    //  - Otherwise → reset to fallback status AND set dispatched_at = now so the
    //    dispatcher's eligibility gate (dispatched_at + backoff check) prevents
    //    immediate re-dispatch on the next reconciler tick.
    const taskRoutingReasonSelect = await tableHasColumn(db, 'tasks', 'routing_reason')
      ? 'routing_reason'
      : 'NULL AS routing_reason';
    const taskRow = await db.get(`SELECT id, retry_count, max_retries, ${taskRoutingReasonSelect},
              ${await tableHasColumn(db, 'tasks', 'tenant_id') ? 'tenant_id' : 'NULL'} AS tenant_id,
              project_id, task_type
       FROM tasks
       WHERE active_instance_id = ?`, instanceId) as { id: number; retry_count: number; max_retries: number; routing_reason: string | null; tenant_id: number | null; project_id: number | null; task_type: string | null } | undefined;

    const newRetryCount = (taskRow?.retry_count ?? 0) + 1;
    const maxRetries = taskRow?.max_retries ?? 3;

    if (newRetryCount >= maxRetries) {
      // Too many dispatch failures — mark the task failed to stop the spin-loop.
      console.error(
        `[dispatcher] Task (active_instance_id=${instanceId}) exhausted dispatch retries` +
        ` (retry_count=${newRetryCount}, max_retries=${maxRetries}) — marking failed.`
      );
      if (taskRow?.id != null) {
        await persistDispatchStartupFailure(db, {
                    taskId: taskRow.id,
                    matchedAgentId: job.agent_id,
                    matchedAgentLabel: job.agent_name ?? job.title,
                    routingReason: taskRow.routing_reason ?? `Dispatch launched for ${job.agent_name ?? job.title}`,
                    priorStatus: taskStatusAtDispatch,
                    tenantId: taskRow.tenant_id ?? null,
                    projectId: taskRow.project_id ?? null,
                    taskType: taskRow.task_type ?? null,
                    reason: errorMsg,
                    retryCount: newRetryCount,
                    maxRetries,
                    keepAutoRetry: false,
                  });
      }
    } else {
      // Increment retry_count and keep dispatched_at = now as the backoff timestamp.
      // The dispatcher's eligibility gate will skip this task until the backoff window
      // has elapsed (see DISPATCH_FAILURE_BACKOFF_SECONDS filter in query helpers).
      console.warn(
        `[dispatcher] Task (active_instance_id=${instanceId}) dispatch failure` +
        ` — retry_count=${newRetryCount}/${maxRetries}, resetting to ${deriveDispatchFailureFallbackStatus(taskStatusAtDispatch)} with backoff.`
      );
      if (taskRow?.id != null) {
        await persistDispatchStartupFailure(db, {
                    taskId: taskRow.id,
                    matchedAgentId: job.agent_id,
                    matchedAgentLabel: job.agent_name ?? job.title,
                    routingReason: taskRow.routing_reason ?? `Dispatch launched for ${job.agent_name ?? job.title}`,
                    priorStatus: taskStatusAtDispatch,
                    tenantId: taskRow.tenant_id ?? null,
                    projectId: taskRow.project_id ?? null,
                    taskType: taskRow.task_type ?? null,
                    reason: errorMsg,
                    retryCount: newRetryCount,
                    maxRetries,
                    keepAutoRetry: true,
                  });
      }
    }
  }
}

/**
 * dispatchTaskToJob — shared helper that fires a single task to a single job.
 * Used by the explicit sprint-routing path.
 * Returns true if dispatch succeeded.
 */
export async function dispatchTaskToJob(
  db: Db,
  job: JobRow,
  task: CandidateTask,
  candidateCount: number,
  ruleLabel?: string,
): Promise<boolean> {
  const routingReason = [
    `Priority: ${task.priority}`,
    task.blocking_count > 0 ? `Blocking ${task.blocking_count} task(s)` : null,
    `Created: ${task.created_at}`,
    ruleLabel ?? `Selected from ${candidateCount} candidate(s)`,
  ].filter(Boolean).join(' | ');

  const agentSlug = (await resolveDispatchAgentSlug(db, {
      agentId: job.agent_id,
      openclawAgentId: job.openclaw_agent_id ?? null,
      sessionKey: job.agent_session_key,
      name: job.agent_name ?? null,
    })) ?? String(job.agent_id);

  const repoAccessMode: RepoAccessMode | null = job.repo_access_mode ?? (job.repo_path ? 'worktree' : null);
  const repoOwnerLabel = job.repo_config_source === 'workflow'
    ? 'Workflow'
    : 'Legacy agent fallback';
  let repoWorkspacePath: string | null = null;
  let repoBranch: string | null = null;
  let repoSourceDescriptor: string | null = null;
  let repoDependencySetup: RepoWorkspaceDependencySetupResult[] = [];

  const repoRequired = await isWorkflowRepoRequiredForTask(db, task);
  if (repoRequired && job.repo_config_source !== 'workflow') {
    const reason = `Workflow-level repository configuration is required for repo-backed workflow dispatch (workflow_id=${task.sprint_id ?? 'none'}, workflow_type=${task.sprint_type ?? 'unknown'}). Configure repo_access_mode plus repo_path or repo_url on the workflow.`;
    console.warn(`[dispatcher] Blocking task #${task.id}: ${reason}`);
    await persistDispatchStartupFailure(db, {
            taskId: task.id,
            matchedAgentId: job.agent_id,
            matchedAgentLabel: job.agent_name ?? job.title,
            routingReason,
            priorStatus: task.status,
            tenantId: task.tenant_id,
            projectId: task.project_id,
            sprintId: task.sprint_id,
            sprintType: task.sprint_type,
            taskType: task.task_type,
            reason,
          });
    return false;
  }

  if (repoAccessMode === 'worktree') {
    if (!job.workspace_path || !job.repo_path) {
      const reason = `${repoOwnerLabel} repo_access_mode=worktree requires workspace_path and repo_path (workspace_path=${job.workspace_path ? 'set' : 'missing'}, repo_path=${job.repo_path ? 'set' : 'missing'})`;
      console.warn(`[dispatcher] Blocking task #${task.id}: ${reason}`);
      await persistDispatchStartupFailure(db, {
                taskId: task.id,
                matchedAgentId: job.agent_id,
                matchedAgentLabel: job.agent_name ?? job.title,
                routingReason,
                priorStatus: task.status,
                tenantId: task.tenant_id,
                projectId: task.project_id,
                sprintId: task.sprint_id,
                sprintType: task.sprint_type,
                taskType: task.task_type,
                reason,
              });
      return false;
    }

    const basePath = job.os_user ? `/Users/${job.os_user}/workspaces` : job.workspace_path;
    const wtResult = createTaskWorktree({ repoPath: job.repo_path, basePath, taskId: task.id, taskTitle: task.title, agentSlug });
    if (wtResult.error) {
      const reason = `Worktree creation failed for task #${task.id}: ${wtResult.error}`;
      console.warn(`[dispatcher] ${reason}`);
      await persistDispatchStartupFailure(db, {
                taskId: task.id,
                matchedAgentId: job.agent_id,
                matchedAgentLabel: job.agent_name ?? job.title,
                routingReason,
                priorStatus: task.status,
                tenantId: task.tenant_id,
                projectId: task.project_id,
                sprintId: task.sprint_id,
                sprintType: task.sprint_type,
                taskType: task.task_type,
                reason,
              });
      return false;
    }
    repoWorkspacePath = wtResult.workspacePath;
    repoBranch = wtResult.branch;
    repoSourceDescriptor = `worktree:${job.repo_path}`;
    repoDependencySetup = wtResult.dependencySetup ?? [];
  } else if (repoAccessMode === 'clone') {
    if (!job.workspace_path || !job.repo_url) {
      const reason = `${repoOwnerLabel} repo_access_mode=clone requires workspace_path and repo_url (workspace_path=${job.workspace_path ? 'set' : 'missing'}, repo_url=${job.repo_url ? 'set' : 'missing'})`;
      console.warn(`[dispatcher] Blocking task #${task.id}: ${reason}`);
      await persistDispatchStartupFailure(db, {
                taskId: task.id,
                matchedAgentId: job.agent_id,
                matchedAgentLabel: job.agent_name ?? job.title,
                routingReason,
                priorStatus: task.status,
                tenantId: task.tenant_id,
                projectId: task.project_id,
                sprintId: task.sprint_id,
                sprintType: task.sprint_type,
                taskType: task.task_type,
                reason,
              });
      return false;
    }

    const cloneRoot = job.os_user ? `/Users/${job.os_user}/workspaces` : job.workspace_path;
    const cloneResult = ensureTaskClone({ repoUrl: job.repo_url, workspaceRoot: cloneRoot, taskId: task.id, taskTitle: task.title, agentSlug });
    if (cloneResult.error) {
      const reason = `Clone workspace creation failed for task #${task.id}: ${cloneResult.error}`;
      console.warn(`[dispatcher] ${reason}`);
      await persistDispatchStartupFailure(db, {
                taskId: task.id,
                matchedAgentId: job.agent_id,
                matchedAgentLabel: job.agent_name ?? job.title,
                routingReason,
                priorStatus: task.status,
                tenantId: task.tenant_id,
                projectId: task.project_id,
                sprintId: task.sprint_id,
                sprintType: task.sprint_type,
                taskType: task.task_type,
                reason,
              });
      return false;
    }
    repoWorkspacePath = cloneResult.workspacePath;
    repoBranch = cloneResult.branch;
    repoSourceDescriptor = `clone:${job.repo_url}`;
    repoDependencySetup = cloneResult.dependencySetup ?? [];
  }

  // Resolved before the instance row exists so its provenance can be recorded on the payload:
  // a transcript is only explainable if it says which team definition it ran under.
  const teamContext = await resolveTeamContextForDispatch(db, {
    agentId: job.agent_id,
    sprintId: task.sprint_id ?? null,
  });

  const instancePayload = {
    mode: 'runtime-dispatch',
    transport: 'ws.send',
    agentSlug,
          repoAccessMode,
          repoSource: repoSourceDescriptor,
          repoConfigSource: job.repo_config_source ?? null,
          repoWorkspacePath,
    repoBranch,
    repoDependencySetup,
    teamId: teamContext?.teamId ?? null,
    teamContextVersion: teamContext?.contextVersion ?? null,
  };

  const supportsDurableRunId = await durableTableHasColumn(db, 'job_instances', 'durable_run_id');
  const initialDurableRunId = supportsDurableRunId ? createDurableRunId() : null;
  const instanceTenant = await tenantInsertColumns(db, 'job_instances', task.tenant_id ?? job.tenant_id ?? null);
  const instanceResult = supportsDurableRunId
    ? await db.run(`
        INSERT INTO job_instances (${instanceTenant.columnSql}agent_id, status, dispatched_at, payload_sent, task_id, worktree_path, durable_run_id)
        VALUES (${instanceTenant.valueSql}?, 'dispatched', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), ?, ?, ?, ?)
      `, ...instanceTenant.values, job.agent_id, JSON.stringify(instancePayload), task.id, repoWorkspacePath, initialDurableRunId)
    : await db.run(`
        INSERT INTO job_instances (${instanceTenant.columnSql}agent_id, status, dispatched_at, payload_sent, task_id, worktree_path)
        VALUES (${instanceTenant.valueSql}?, 'dispatched', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), ?, ?, ?)
      `, ...instanceTenant.values, job.agent_id, JSON.stringify(instancePayload), task.id, repoWorkspacePath);
  const instanceId = instanceResult.lastInsertId as number;
  const durableRunId = await ensureJobInstanceDurableRunId(db, instanceId);
  const sessionKey = buildSessionKey(instanceId, durableRunId);
  const taskNotesContext = await getDispatchTaskNotesContext(db, {
          taskId: task.id,
          agentId: job.agent_id,
          currentInstanceId: instanceId,
        });
  const scope = await loadDispatchScopeContext(db, {
    projectId: task.project_id ?? null,
    workflowId: task.sprint_id ?? null,
  });

  const nextTaskStatus = deriveDispatchTaskStatus(task.status);
  const hasFirstDispatchedAt = await tableHasColumn(db, 'tasks', 'first_dispatched_at');
  const hasTotalDispatchCount = await tableHasColumn(db, 'tasks', 'total_dispatch_count');
  const hasClaimedAtColumn = await tableHasColumn(db, 'tasks', 'claimed_at');
  const hasRoutingReasonColumn = await tableHasColumn(db, 'tasks', 'routing_reason');

  const firstDispatchClause = hasFirstDispatchedAt
    ? "first_dispatched_at = COALESCE(first_dispatched_at, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')),"
    : '';
  const dispatchCountClause = hasTotalDispatchCount
    ? 'total_dispatch_count = total_dispatch_count + 1,'
    : '';
  const clearFailureDetailClause = await tableHasColumn(db, 'tasks', 'failure_detail') ? 'failure_detail = NULL,' : '';
  const clearPreviousStatusClause = await tableHasColumn(db, 'tasks', 'previous_status') ? 'previous_status = NULL,' : '';
  const assignedAgentClause = await tableHasColumn(db, 'tasks', 'assigned_agent_id') ? 'assigned_agent_id = ?,' : '';
  const claimedAtClause = hasClaimedAtColumn ? 'claimed_at = NULL,' : '';
  const routingReasonClause = hasRoutingReasonColumn ? 'routing_reason = ?,' : '';
  const assignedAgentValues = assignedAgentClause ? [job.agent_id] : [];
  const routingReasonValues = routingReasonClause ? [routingReason] : [];

  await db.run(`
    UPDATE tasks
    SET status = ?,
        ${assignedAgentClause}
        agent_id = ?,
        dispatched_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
        ${claimedAtClause}
        active_instance_id = ?,
        ${routingReasonClause}
        ${clearFailureDetailClause}
        ${clearPreviousStatusClause}
        ${firstDispatchClause}
        ${dispatchCountClause}
        updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = ?
  `, nextTaskStatus, ...assignedAgentValues, job.agent_id, instanceId, ...routingReasonValues, task.id);
  await syncTaskActiveAgentFromInstance(db, task.id);
  // Dispatch is where the run/task link is CREATED, which makes it the single most important
  // active_instance_id transition to record — and it was the one place that recorded nothing. The
  // UPDATE above sets the column and only a status change was ever written to history, so a task
  // could show a run attached with no history row explaining when or by what. That is why the
  // production denial on task 1036 could not be reconstructed: the link was here all along, set
  // silently at 03:36:18.
  await writeTaskHistory(
    db,
    task.id,
    'dispatcher',
    'active_instance_id',
    task.active_instance_id ?? null,
    instanceId,
  );

  if (nextTaskStatus !== task.status) {
    await writeTaskStatusChange(db, task.id, 'dispatcher', task.status, nextTaskStatus, {
            instanceId,
            reason: routingReason ?? null,
          });
  }

  // ── GitHub identity injection (task #613) ────────────────────────────────
  // Resolve and inject per-agent GitHub credentials so routed agents can
  // operate under distinct GitHub identities for PR open/approve/merge.
  // When a task worktree exists, that active repo root must be authoritative
  // for both dispatch-time cwd and any run-local credential/context files.
  const dispatchPathContext = resolveDispatchPathContext({
    worktreePath: repoWorkspacePath,
    runtimeConfigWorkingDirectory: extractWorkingDirectoryFromRuntimeConfig(job.runtime_config),
    workspacePath: job.workspace_path,
  });
  const ghIdentityEffectiveWorkDir = dispatchPathContext.activeRepoRoot;
  const ghIdentity = await resolveGitHubIdentity(db, job.agent_id);
  if (ghIdentity && ghIdentityEffectiveWorkDir) {
    injectGitHubCredentials(ghIdentityEffectiveWorkDir, ghIdentity.identity);
  }
  // Resolve transport mode from agent runtime type and config (task #632)
  const transportMode = resolveTransportMode({
    runtimeType: job.runtime_type,
    runtimeConfig: job.runtime_config,
    hooksUrl: job.agent_hooks_url,
  });

  const contextBundle = buildDispatchContextBundle({
    workflow: { id: task.sprint_id ?? null, name: task.sprint_name ?? scope.workflow?.name ?? null, goal: scope.workflow?.goal ?? null },
    team: teamContext,
    project: scope.project,
    job: { agentId: job.agent_id, title: job.title, instructions: job.job_instructions },
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      priority: task.priority,
      status: task.status,
      workflowName: task.sprint_name ?? null,
    },
    taskNotes: { context: taskNotesContext, taskId: task.id },
    workspace: dispatchPathContext,
    contract: await buildInstanceCallbackContractSegmentDraft({
      instanceId,
      durableRunId,
      taskId: task.id,
      taskStatus: task.status,
      taskType: task.task_type,
      sprintId: task.sprint_id,
      sprintType: task.sprint_type,
      agentSlug,
      sessionKey,
      // baseUrl omitted → default Agent HQ base URL / localhost
      transportMode,
    }),
    githubIdentity: { resolved: ghIdentity, workingDirectory: ghIdentityEffectiveWorkDir },
  });
  const fullMessage = contextBundle.promptText;

  // Recorded before the run starts so a dispatch that dies on launch is still explainable.
  await persistDispatchContextBundle(db, {
    tenantId: task.tenant_id ?? job.tenant_id ?? null,
    instanceId,
    durableRunId,
    taskId: task.id,
    agentId: job.agent_id,
    bundle: contextBundle,
  });

  fireAgentRun(
    db,
    job,
    fullMessage,
    instanceId,
    agentSlug,
    task.status,
    task.id,
    task.story_points ?? null,
    repoWorkspacePath,
    {
      repoAccessMode,
      repoSource: repoSourceDescriptor,
      repoWorkspacePath,
      repoBranch,
    },
    {
      projectId: task.project_id,
      sprintId: task.sprint_id,
      sprintType: task.sprint_type,
      tenantId: task.tenant_id ?? job.tenant_id ?? null,
    },
  ).catch((err) => {
    console.error(`[dispatcher] Unhandled error in fireAgentRun for instance #${instanceId}:`, err);
  });

  await db.run(`
    INSERT INTO dispatch_log (task_id, agent_id, routing_reason, candidate_count, candidates_skipped)
    VALUES (?, ?, ?, ?, ?)
  `, task.id, job.agent_id, routingReason, candidateCount, JSON.stringify([]));

  console.log(`[dispatcher] Dispatched Task #${task.id} → ${job.title} (${job.agent_name ?? job.agent_id}) — instance #${instanceId}`);
  await notifyTaskStatusChange(db, {
        taskId: task.id,
        fromStatus: task.status,
        toStatus: nextTaskStatus,
        source: job.agent_name ?? job.title,
      });
  return true;
}

export async function runDispatcher(db: Db, projectId?: number): Promise<DispatchResult> {
  const result: DispatchResult = { dispatched: 0, skipped: 0, errors: [] };

  // ── Phase 1: Task-first routing (universal multi-agent fallback) ──────────
  //
  // Get all dispatchable tasks across all projects (or the filtered project).
  // For each task, find all matching routing rules ordered by priority, then
  // try each rule's agent until one is free. This allows any role to have
  // multiple agents and the dispatcher will always pick the first available one.

  const allTasks = await getAllDispatchableTasks(db, projectId ?? null);

  for (const task of allTasks) {
    try {
      // Skip if task already got an instance earlier in this loop
      if (await hasTaskLiveInstance(db, task.id)) {
        result.skipped++;
        continue;
      }

      const rules = await getMatchingRoutingRules(db, task);
      if (rules.length === 0) {
        console.log(
          `[dispatcher] Task #${task.id} not dispatched: no matching routing rule for sprint_id=${task.sprint_id ?? 'none'} status=${task.status} task_type=${task.task_type ?? 'null'}`
        );
        result.skipped++;
        continue;
      }

      let dispatched = false;
      for (const rule of rules) {
        // Skip if this rule's job agent already has an active run
        if (await hasActiveInstance(db, rule.agent_id)) continue;

        // Race condition guard: re-check task is still free
        if (await hasTaskLiveInstance(db, task.id)) break;

        const resolvedRepo = resolveRepoConfig({
          workflow: {
            repo_path: rule.workflow_repo_path ?? null,
            repo_url: rule.workflow_repo_url ?? null,
            repo_access_mode: rule.workflow_repo_access_mode ?? null,
          },
          agent: {
            repo_path: rule.repo_path ?? null,
            repo_url: rule.repo_url ?? null,
            repo_access_mode: rule.repo_access_mode ?? null,
          },
        });

        // Build a JobRow-compatible object from the joined rule columns
        const jobForDispatch: JobRow = {
          id: rule.agent_id,
          title: rule.agent_name ?? `Agent #${rule.agent_id}`,
          agent_id: rule.agent_id,
          project_id: task.project_id,
          job_instructions: rule.job_instructions,
          enabled: rule.enabled,
          timeout_seconds: rule.timeout_seconds,
          agent_session_key: rule.agent_session_key,
          agent_name: rule.agent_name,
          openclaw_agent_id: rule.openclaw_agent_id ?? null,
          model: rule.model,
          agent_model: rule.agent_model,
          runtime_type: rule.runtime_type,
          runtime_config: rule.runtime_config,
          agent_hooks_url: rule.agent_hooks_url ?? null,
          agent_hooks_auth_header: rule.agent_hooks_auth_header ?? null,
          workspace_path: rule.workspace_path ?? null,
          skill_names: rule.skill_names ?? null,
          preferred_provider: rule.preferred_provider ?? null,
          repo_path: resolvedRepo.repo_path,
          repo_url: resolvedRepo.repo_url,
          repo_access_mode: resolvedRepo.repo_access_mode,
          project_repo_path: rule.project_repo_path ?? null,
          project_repo_url: rule.project_repo_url ?? null,
          project_repo_access_mode: rule.project_repo_access_mode ?? null,
          workflow_repo_path: rule.workflow_repo_path ?? null,
          workflow_repo_url: rule.workflow_repo_url ?? null,
          workflow_repo_access_mode: rule.workflow_repo_access_mode ?? null,
          repo_config_source: resolvedRepo.repo_config_source,
          os_user: rule.os_user ?? null,
        };

        const ok = await dispatchTaskToJob(
                  db,
                  jobForDispatch,
                  task,
                  allTasks.length,
                  `Rule: ${rule.agent_name ?? `agent`} (agent #${rule.agent_id})`,
                );
        if (ok) {
          result.dispatched++;
          dispatched = true;
          break;
        }
      }

      if (!dispatched) result.skipped++;
    } catch (err) {
      const msg = `Task ${task.id}: ${String(err)}`;
      result.errors.push(msg);
      console.error(`[dispatcher] Error (routing-rules path):`, msg);
    }
  }

  return result;
}

// ── Unified dispatch helpers (task #64) ────────────────────────────────────
//
// Prompt assembly lives in dispatch/prompt/dispatchContext.ts — one builder for every path.
// dispatchInstance() wraps resolveRuntime() + runtime.dispatch() with all
// the DB lifecycle writes that callers previously duplicated.

export interface DispatchScopeContext {
  workflow: { id: number | null; name: string | null; goal: string | null } | null;
  project: { id: number | null; name: string | null; context: string | null } | null;
}

/**
 * The workflow goal and project prose a dispatch sits inside.
 *
 * Read separately from the candidate query rather than joined into it: the candidate query runs
 * for every eligible task on every scheduler tick, and these two columns are only needed for the
 * one task that actually wins routing. Both lookups are by primary key.
 */
export async function loadDispatchScopeContext(
  db: Db,
  params: { projectId?: number | null; workflowId?: number | null },
): Promise<DispatchScopeContext> {
  const [workflowRow, projectRow] = await Promise.all([
    params.workflowId
      ? db.get<{ id: number; name: string | null; goal: string | null }>(
        `SELECT id, name, goal FROM sprints WHERE id = ?`, params.workflowId,
      )
      : Promise.resolve(undefined),
    params.projectId
      ? db.get<{ id: number; name: string | null; context_md: string | null }>(
        `SELECT id, name, context_md FROM projects WHERE id = ?`, params.projectId,
      )
      : Promise.resolve(undefined),
  ]);

  return {
    workflow: workflowRow
      ? { id: Number(workflowRow.id), name: workflowRow.name ?? null, goal: workflowRow.goal ?? null }
      : null,
    project: projectRow
      ? { id: Number(projectRow.id), name: projectRow.name ?? null, context: projectRow.context_md ?? null }
      : null,
  };
}

export interface DispatchInstanceParams {
  instanceId: number;
  agentId: number;
  jobTitle: string;
  /** Agent's main session key (used for slug resolution). */
  sessionKey: string;
  /** Stable OpenClaw runtime ID. Canonical Agent HQ session keys are not runtime IDs. */
  openclawAgentId?: string | null;
  /** Pre-built message (caller assembles via buildDispatchMessage + contract). */
  message: string;
  /**
   * Segment index for `message`, when the caller assembled it through the bundle. Supplied, the
   * run becomes explainable in the context viewer; omitted, the dispatch behaves exactly as
   * before and simply has no stored context.
   */
  contextBundle?: ContextBundle | null;
  /** Task this dispatch belongs to, when it belongs to one. Scopes the stored bundle. */
  taskId?: number | null;
  model?: string | null;
  preferredProvider?: string | null;
  providerConnectionId?: number | null;
  timeoutSeconds?: number;
  hooksUrl?: string | null;
  hooksAuthHeader?: string | null;
  runtimeType?: string | null;
  runtimeConfig?: unknown;
  storyPoints?: number | null;
  projectId?: number | null;
  sprintId?: number | null;
  repoAccessMode?: RepoAccessMode | null;
  repoSource?: string | null;
  repoWorkspacePath?: string | null;
  repoBranch?: string | null;
  /** Explicit scheduler-selected target for remote/ssh/sandbox backends. */
  executionTarget?: RuntimeExecutionTargetV1 | null;
}

/**
 * dispatchInstance — unified dispatch orchestrator.
 *
 * All dispatch paths (scheduler, reconciler, sprint summaries) call this
 * instead of the legacy dispatchJob(). It:
 *   1. Builds a deterministic session key
 *   2. Resolves the agent slug
 *   3. Resolves model from story points (if applicable)
 *   4. Marks the instance as 'dispatched' with payload_sent
 *   5. Calls resolveRuntime() → runtime.dispatch()
 *   6. On success: marks 'running', logs
 *   7. On failure: marks 'failed', logs, re-throws
 */
export async function dispatchInstance(params: DispatchInstanceParams): Promise<void> {
  const db = getDb();
  // Canonical (offset-less UTC) so this write of job_instances.dispatched_at is
  // indistinguishable from PostgreSQL defaults and inline canonical SQL writes.
  const now = nowTimestamp();

  let existingPayload: Record<string, unknown> = {};
  try {
    const row = await db.get(`SELECT payload_sent FROM job_instances WHERE id = ?`, params.instanceId) as { payload_sent: string | null } | undefined;
    if (row?.payload_sent) {
      const parsed = JSON.parse(row.payload_sent);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existingPayload = parsed as Record<string, unknown>;
      }
    }
  } catch {
    existingPayload = {};
  }

  const durableRunId = await ensureJobInstanceDurableRunId(db, params.instanceId);
  const boundaryDurableRunId = durableRunId?.trim() || `legacy-instance:${params.instanceId}`;
  const runSessionKey = buildSessionKey(params.instanceId, durableRunId);
  const agentSlug = (await resolveDispatchAgentSlug(db, {
      agentId: params.agentId,
      openclawAgentId: params.openclawAgentId ?? null,
      sessionKey: params.sessionKey,
      name: params.jobTitle,
    })) ?? params.sessionKey.replace(/[^a-z0-9-]/gi, '-').toLowerCase();

  // Model precedence: story_points → caller-provided → gateway default
  const preferredProvider = params.preferredProvider ?? null;
  const tenantId = (await resolveRuntimeTenantId(db, {
      instanceId: params.instanceId,
      agentId: params.agentId,
      projectId: params.projectId ?? null,
    })) ?? 1;
  const spModel = await resolveModelFromStoryPoints(db, params.storyPoints ?? null, preferredProvider, {
      projectId: params.projectId ?? null,
      sprintId: params.sprintId ?? null,
      tenantId,
    });
  const effectiveModel = spModel?.model || params.model || null;
  const effectiveThinking = spModel?.thinking_level ?? null;
  const effectiveFastMode = spModel?.fast_mode ?? null;
  if (params.contextBundle) {
    await persistDispatchContextBundle(db, {
      tenantId,
      instanceId: params.instanceId,
      durableRunId,
      taskId: params.taskId ?? null,
      agentId: params.agentId,
      bundle: params.contextBundle,
    });
  }
  if (spModel) {
    console.log(
      `[dispatchInstance] Story points=${params.storyPoints} → model=${spModel.model} thinking=${spModel.thinking_level ?? 'default'} fastMode=${spModel.fast_mode ?? 'default'} (rule: ${spModel.label ?? 'unnamed'})`
    );
  }
  console.log(
    `[dispatchInstance] Model for instance #${params.instanceId} job="${params.jobTitle}"` +
    ` preferred_provider=${preferredProvider ?? 'null'}` +
    ` sp_model=${spModel?.model ?? 'null'} caller_model=${params.model ?? 'null'}` +
    ` effective=${effectiveModel ?? 'gateway-default'}`
  );

  // Mark as dispatched
  const repoAccessMode = params.repoAccessMode ?? (existingPayload.repoAccessMode as 'worktree' | 'clone' | null | undefined) ?? null;
  const repoSource = params.repoSource ?? (existingPayload.repoSource as string | null | undefined) ?? null;
  const repoWorkspacePath = params.repoWorkspacePath ?? (existingPayload.repoWorkspacePath as string | null | undefined) ?? null;
  const repoBranch = params.repoBranch ?? (existingPayload.repoBranch as string | null | undefined) ?? null;

  const runtimeDispatchPayload = {
    ...existingPayload,
    mode: 'runtime-dispatch',
    agentSlug,
    sessionKey: runSessionKey,
    durableRunId,
    repoAccessMode,
    repoSource,
    repoWorkspacePath,
    repoBranch,
  };

  if (effectiveModel || effectiveThinking || effectiveFastMode !== null) {
    if (await tableHasColumn(db, 'job_instances', 'effective_fast_mode')) {
      await db.run(`UPDATE job_instances SET effective_model = ?, effective_thinking_level = ?, effective_fast_mode = ? WHERE id = ?`, effectiveModel ?? null, effectiveThinking ?? null, effectiveFastMode === null ? null : (effectiveFastMode ? 1 : 0), params.instanceId);
    } else if (await tableHasColumn(db, 'job_instances', 'effective_model') && await tableHasColumn(db, 'job_instances', 'effective_thinking_level')) {
      await db.run(`UPDATE job_instances SET effective_model = ?, effective_thinking_level = ? WHERE id = ?`, effectiveModel ?? null, effectiveThinking ?? null, params.instanceId);
    }
  }

  await db.run(`
    UPDATE job_instances
    SET status = 'dispatched', dispatched_at = ?, payload_sent = ?, session_key = ?
    WHERE id = ?
  `, now, JSON.stringify(runtimeDispatchPayload), runSessionKey, params.instanceId);

  await insertRuntimeLog(db, {
        instanceId: params.instanceId,
        agentId: params.agentId,
        jobTitle: params.jobTitle,
        level: 'info',
        message: `Dispatching job "${params.jobTitle}" via AgentRuntime (sessionKey=${runSessionKey})`,
      });

  const runtime = resolveRuntime({
    runtime_type: params.runtimeType ?? 'openclaw',
    runtime_config: params.runtimeConfig,
  });

  try {
    const runtimeConfigOverride: Record<string, unknown> = {};
    if (repoWorkspacePath) {
      runtimeConfigOverride.workingDirectory = repoWorkspacePath;
    }
    const baseRuntimeConfig = params.runtimeConfig && typeof params.runtimeConfig === 'object'
      ? params.runtimeConfig as Record<string, unknown>
      : {};
    const dispatchRuntimeConfig = Object.keys(runtimeConfigOverride).length > 0
      ? { ...baseRuntimeConfig, ...runtimeConfigOverride }
      : baseRuntimeConfig;
    const runtimeType = params.runtimeType ?? 'openclaw';
    const providerDispatch = await resolveRuntimeProviderDispatchSelection({
          db,
          tenantId,
          runtimeType,
          providerConnectionId: params.providerConnectionId ?? null,
          preferredProvider,
          model: effectiveModel,
          runtimeConfig: dispatchRuntimeConfig,
        });
    const executableFingerprint = resolveRuntimeBoundaryExecutableFingerprint(
      runtimeType,
      providerDispatch.runtimeConfig,
    );

    const boundaryAssignments = await loadRuntimeBoundaryAssignments({
      db,
      tenantId,
      agentId: params.agentId,
      failClosed: runtimeType === 'claude-code' || runtimeType === 'codex',
    });
    if ((runtimeType === 'claude-code' || runtimeType === 'codex') && repoWorkspacePath) {
      const skillNames = boundaryAssignments.skills.map((skill) => skill.name);
      const adapter = getSkillMaterializationAdapter(runtimeType);
      const materialized = await adapter.materialize({
        workingDirectory: repoWorkspacePath,
        skillNames,
        skillsBasePath: OPENCLAW_SKILLS_PATH,
        runtimeConfig: dispatchRuntimeConfig,
        db,
        tenantId,
      });
      const satisfiedSkills = new Set(
        materialized.details
          .filter((detail) => detail.action === 'created'
            || detail.action === 'updated'
            || (detail.action === 'skipped' && detail.reason === 'already correct'))
          .map((detail) => detail.skill),
      );
      const missingSkills = skillNames.filter((name) => !satisfiedSkills.has(name));
      if (
        !materialized.ok
        || missingSkills.length > 0
        || (skillNames.length > 0 && materialized.warnings.length > 0)
      ) {
        throw new Error(
          materialized.error
            ?? `Assigned skills were not materialized exactly: ${missingSkills.join(', ') || materialized.warnings.join('; ')}`,
        );
      }
    }
    const runtimeBoundary = buildRuntimeBoundaryV1({
      tenantId,
      projectId: params.projectId ?? null,
      workflowId: params.sprintId ?? null,
      taskId: null,
      instanceId: params.instanceId,
      durableRunId: boundaryDurableRunId,
      agentId: params.agentId,
      agentSlug,
      runtimeType,
      executableFingerprint,
      runtimeConfig: providerDispatch.runtimeConfig,
      model: providerDispatch.model,
      reasoning: effectiveThinking,
      fastMode: effectiveFastMode,
      timeoutSeconds: params.timeoutSeconds ?? 900,
      prompt: params.message,
      workspaceRoot: repoWorkspacePath,
      activeRepoRoot: repoWorkspacePath,
      repoAccessMode,
      repoSource,
      branch: repoBranch,
      executionTarget: params.executionTarget,
      mcpServers: boundaryAssignments.mcpServers,
      skills: boundaryAssignments.skills,
      registryTools: boundaryAssignments.registryTools,
      requiredLifecycleTools: [],
      provider: providerDispatch.provider || preferredProvider,
      providerConnectionId: params.providerConnectionId ?? null,
      callbackIdentity: runSessionKey,
      requestedBy: 'dispatch-instance',
    });

    const runtimeParams: DispatchParams = {
      message: params.message,
      agentSlug,
      sessionKey: runSessionKey,
      timeoutSeconds: params.timeoutSeconds ?? 900,
      name: `Agent HQ: ${params.jobTitle}`,
      model: providerDispatch.model,
      preferredProvider: providerDispatch.provider || preferredProvider,
      providerConnectionId: params.providerConnectionId ?? null,
      thinking: effectiveThinking,
      fastMode: effectiveFastMode,
      instanceId: params.instanceId,
      durableRunId,
      taskId: null,
      db,
      repoAccessMode,
      repoSource,
      repoWorkspacePath,
      repoBranch,
      workspaceRoot: repoWorkspacePath,
      activeRepoRoot: repoWorkspacePath,
      runtimeConfig: providerDispatch.runtimeConfig,
      runtimeBoundary,
      hooksUrl: params.hooksUrl,
      hooksAuthHeader: params.hooksAuthHeader,
    };

    await prepareRuntimeAuthProfiles(runtime, runtimeParams);
    const { runId } = await runtime.dispatch(runtimeParams);

    await db.run(`
      UPDATE job_instances
      SET status = 'running',
          response = ?,
          run_id = COALESCE(?, run_id)
      WHERE id = ?
    `, JSON.stringify({ runId }), runId, params.instanceId);

    await insertRuntimeLog(db, {
            instanceId: params.instanceId,
            agentId: params.agentId,
            jobTitle: params.jobTitle,
            level: 'info',
            message: `Job dispatched via AgentRuntime. sessionKey=${runSessionKey}${runId ? ` runId=${runId}` : ''}`,
          });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    await db.run(`
      UPDATE job_instances
      SET status = 'failed', error = ?, completed_at = ?
      WHERE id = ?
    `, errorMsg, nowTimestamp(), params.instanceId);

    await insertRuntimeLog(db, {
            instanceId: params.instanceId,
            agentId: params.agentId,
            jobTitle: params.jobTitle,
            level: 'error',
            message: `Failed to dispatch job: ${errorMsg}`,
          });

    throw err;
  }
}
