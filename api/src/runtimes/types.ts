/**
 * runtimes/types.ts — AgentRuntime interface and shared dispatch types.
 *
 * Shared runtime end-event contracts live in runtimeEvents.ts.
 * The dispatcher calls AgentRuntime.dispatch() and AgentRuntime.abort()
 * without knowing which runtime backend (OpenClaw, Claude Code, etc.) is
 * in use. Each backend provides a concrete implementation.
 */

import type Database from 'better-sqlite3';
import type { RuntimeEndEvent, RuntimeEndEventType, RuntimeEventCallbacks } from './runtimeEvents';

export type { RuntimeEndEvent, RuntimeEndEventType, RuntimeEventCallbacks } from './runtimeEvents';

export interface DispatchParams extends RuntimeEventCallbacks {
  message: string;
  agentSlug: string;
  sessionKey: string;
  timeoutSeconds: number;
  name: string;
  model?: string | null;
  /** Auth/provider slug used to resolve runtime-specific credentials. */
  preferredProvider?: string | null;
  /** Runtime-owned provider connection selected for this agent. */
  providerConnectionId?: number | null;
  thinking?: string | null;
  /** Latency-vs-depth override. Null/undefined leaves the runtime default unchanged. */
  fastMode?: boolean | null;
  /**
   * Instance ID — required for runtimes that emit terminal runtime events.
   * Terminal runtimes must use this to persist job_instances runtime-end state
   * before or during run-end handling; dispatcher callbacks are observability
   * hooks and must not be the only path that moves a run out of running.
   */
  instanceId?: number;
  /** Durable Agent HQ run ID, stable across SQLite restore/autoincrement reuse. */
  durableRunId?: string | null;
  /** Task ID — forwarded to runtimes that expose it to agents via env vars. */
  taskId?: number | null;
  /**
   * Database handle — required for runtimes that write run state directly.
   * Runtimes that know a process/session has ended must persist
   * runtime_ended_at, runtime_end_success/source/error, completed_at, and the
   * derived terminal instance status when instanceId and db are available.
   */
  db?: Database.Database;
  /** Repo source mode used for this run, when dispatch prepared a repo-backed workspace. */
  repoAccessMode?: 'worktree' | 'clone' | null;
  /** Truthful descriptor of the repo source used for this run, e.g. worktree:/repo or clone:https://... */
  repoSource?: string | null;
  /** Effective repo-backed workspace path used for this run. */
  repoWorkspacePath?: string | null;
  /** Effective branch prepared for this run. */
  repoBranch?: string | null;
  /** Runtime-specific config override assembled by dispatcher. */
  runtimeConfig?: unknown;
  /**
   * Parent workspace container root for this agent (normally agents.workspace_path).
   * This remains the broader allowed container boundary when the active repo is a
   * task worktree nested under a larger workspace.
   * Never treat this value as the repo cwd when activeRepoRoot is present.
   */
  workspaceRoot?: string | null;
  /**
   * Authoritative active repo root for this dispatched run.
   * When a task worktree exists, this must point at the worktree repo root so the
   * runtime cwd, prompt context, metadata, and any repo-file assumptions all agree
   * on the same path.
   */
  activeRepoRoot?: string | null;
  /**
   * Optional dispatch metadata describing how the active repo root and workspace
   * boundary were resolved. This is for observability only and must not be used
   * to override activeRepoRoot/workspaceRoot semantics.
   */
  pathMetadata?: {
    pathMode?: 'worktree' | 'runtime-config' | 'workspace';
    repoRootSource?: 'worktree' | 'runtime-config' | 'workspace' | 'none';
    workspaceRootSource?: 'workspace' | 'active-repo-root' | 'none';
    worktreeRoot?: string | null;
    runtimeConfigWorkingDirectory?: string | null;
  } | null;
  /**
   * OpenClaw MCP readiness contract produced by dispatch-time materialization.
   * OpenClawRuntime uses this to verify assigned MCP tools have reached the
   * session-effective catalog before it sends the first agent turn.
   */
  openClawMcpReadiness?: {
    serverNames: string[];
    requiredToolNames: string[];
    requiredToolsByServerName?: Record<string, string[]>;
    materializedCount: number;
    bundlePath?: string | null;
    workingDirectory?: string | null;
  } | null;
  /**
   * Legacy container hook metadata.
   * OpenClawRuntime ignores hook transport and dispatches via the runtime WS path.
   * Kept here for compatibility with existing dispatcher/job records.
   */
  hooksUrl?: string | null;
  /** Legacy per-agent hook auth header; retained for compatibility only. */
  hooksAuthHeader?: string | null;
}

export interface PrepareAuthProfilesParams {
  agentSlug: string;
  preferredProvider?: string | null;
  providerConnectionId?: number | null;
  runtimeConfig?: unknown;
}

export interface RuntimeAuthProfileSyncResult {
  ok: boolean;
  status: 'synced' | 'skipped' | 'failed';
  providersSynced: string[];
  runtimeAuthProvidersSynced: string[];
  openclawAuthProvidersSynced: string[];
  runtimeAuthPath?: string | null;
  openclawAuthPath?: string | null;
  refreshed?: boolean;
  source?: string | null;
  error?: string;
  details?: Record<string, unknown>;
}

export function skippedRuntimeAuthProfileSync(reason: string): RuntimeAuthProfileSyncResult {
  return {
    ok: true,
    status: 'skipped',
    providersSynced: [],
    runtimeAuthProvidersSynced: [],
    openclawAuthProvidersSynced: [],
    details: { reason },
  };
}

export interface AgentRuntime {
  /**
   * prepareAuthProfiles — materialize provider credentials into the files the
   * concrete runtime reads before first dispatch.
   */
  prepareAuthProfiles(params: PrepareAuthProfilesParams): Promise<RuntimeAuthProfileSyncResult>;

  /**
   * dispatch — fire an isolated agent run and return a handle that can be
   * used to abort the run if needed.
   *
   * If the runtime can observe its own terminal process/session event, it is
   * responsible for applying that terminal state to job_instances. The
   * optional onRuntimeEnd callback is not a substitute for persistence.
   */
  dispatch(params: DispatchParams): Promise<{ runId: string }>;

  /**
   * abort — request cancellation of a running agent turn.
   * Implementations should treat "already gone" as a success.
   */
  abort(runId: string, sessionKey: string): Promise<void>;
}
