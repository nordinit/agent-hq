/**
 * runtimes/ClaudeCodeRuntime.ts — AgentRuntime backed by the Claude Code Agent SDK.
 *
 * Dispatches tasks to a headless Claude Code session via @anthropic-ai/claude-agent-sdk.
 * The query() loop runs in the background (fire-and-forget from the dispatcher's
 * perspective) so dispatch() returns immediately.
 *
 * Key design decisions:
 * - dispatch() is non-blocking: fires the query() loop via setImmediate and returns
 * - Session ID extracted from the first "init" system message, stored on job_instances
 * - AbortControllers are stored in an in-process Map keyed by instanceId
 * - Agent HQ lifecycle callbacks injected as env vars — the agent calls them via Bash/curl
 * - Model and effort are configurable per-agent via runtime_config
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRuntime, DispatchParams, PrepareAuthProfilesParams, RuntimeAuthProfileSyncResult } from './types';
import { skippedRuntimeAuthProfileSync } from './types';
import { validateAndLogViolation } from '../lib/workspaceBoundary';
import { getAgentHqBaseUrl } from '../lib/agentHqBaseUrl';
import { fetchAgentTools, createAgentToolServer } from './toolInjection';
import { type Db } from "../db/adapter/types";

// ── Config ───────────────────────────────────────────────────────────────────

export interface ClaudeCodeRuntimeConfig {
  /** Working directory for the Claude Code session. */
  workingDirectory?: string;
  /** Model override (e.g. "claude-sonnet-4-6", "claude-opus-4-6"). */
  model?: string;
  /** Effort level for adaptive thinking ("low" | "medium" | "high" | "max"). */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Tools the session is allowed to use. Defaults to standard coding tools. */
  allowedTools?: string[];
  /** Tools explicitly blocked from the session. */
  disallowedTools?: string[];
  /** Maximum agentic turns before stopping. */
  maxTurns?: number;
  /** Maximum spend in USD before stopping. */
  maxBudgetUsd?: number;
  /** Additional arbitrary config fields. */
  [key: string]: unknown;
}

const DEFAULT_ALLOWED_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];

// ── Runtime ──────────────────────────────────────────────────────────────────

export class ClaudeCodeRuntime implements AgentRuntime {
  /**
   * Per-agent base config from runtime_config in the agents table.
   * dispatch() can override individual fields (model, etc.) via DispatchParams.
   */
  private baseConfig: ClaudeCodeRuntimeConfig;

  constructor(config: ClaudeCodeRuntimeConfig = {}) {
    this.baseConfig = config;
  }

  /**
   * In-process AbortController map keyed by instanceId.
   * abort() looks up the controller here and signals cancellation.
   */
  private abortControllers = new Map<number, AbortController>();

  async prepareAuthProfiles(_params: PrepareAuthProfilesParams): Promise<RuntimeAuthProfileSyncResult> {
    return skippedRuntimeAuthProfileSync('Claude Code runtime does not use Agent HQ-managed runtime auth profiles.');
  }

  /**
   * dispatch — fire a Claude Code session in the background and return immediately.
   *
   * The runId `claude-code:<instanceId>` is returned synchronously so the
   * dispatcher can store it before the async loop produces any output.
   *
   * When instanceId and db are provided (expected for production dispatches),
   * the session_id from the SDK init message is persisted on the instance row.
   */
  async dispatch(params: DispatchParams): Promise<{ runId: string }> {
    const {
      message,
      instanceId,
      taskId,
      db,
      model,
      workspaceRoot,
      activeRepoRoot,
    } = params;

    // Per-dispatch runtimeConfig overrides the agent-level baseConfig
    const runtimeConfig: ClaudeCodeRuntimeConfig = {
      ...this.baseConfig,
      ...((params.runtimeConfig as ClaudeCodeRuntimeConfig | undefined) ?? {}),
    };

    const abortController = new AbortController();

    if (instanceId != null) {
      this.abortControllers.set(instanceId, abortController);
    }

    // activeRepoRoot is the authoritative cwd for this run. workspaceRoot remains
    // the broader container boundary when different from the active repo root.
    const effectiveActiveRepoRoot: string | null =
      activeRepoRoot ??
      (typeof runtimeConfig.workingDirectory === 'string' ? runtimeConfig.workingDirectory : null) ??
      workspaceRoot ??
      null;

    const { sessionKey, agentSlug } = params;
    const durableRunId = params.durableRunId ?? null;

    // Fire and forget — run loop in background
    setImmediate(() => {
      this._run(
        message,
        instanceId ?? 0,
        taskId ?? null,
        db ?? null,
        runtimeConfig,
        model ?? null,
        abortController,
        workspaceRoot,
        effectiveActiveRepoRoot,
        sessionKey,
        agentSlug,
        durableRunId,
      ).catch((err: unknown) => {
        console.error('[ClaudeCodeRuntime] unhandled error in _run', err);
      });
    });

    return { runId: `claude-code:${instanceId ?? 0}` };
  }

  /**
   * abort — signal the running session's AbortController.
   *
   * runId format: "claude-code:<instanceId>"
   * Falls back to a no-op if no controller is registered (already done or never started).
   */
  async abort(runId: string, _sessionKey: string): Promise<void> {
    const instanceId = parseInstanceIdFromRunId(runId);
    if (instanceId != null) {
      this.abortControllers.get(instanceId)?.abort();
      this.abortControllers.delete(instanceId);
    }
  }

  // ── Internal query loop ───────────────────────────────────────────────────

  private async _run(
    message: string,
    instanceId: number,
    taskId: number | null,
    db: Db | null,
    config: ClaudeCodeRuntimeConfig,
    modelOverride: string | null,
    abortController: AbortController,
    workspaceRoot: string | null = null,
    activeRepoRoot: string | null = null,
    sessionKey?: string,
    agentSlug?: string,
    durableRunId?: string | null,
  ): Promise<void> {
    const baseUrl = getAgentHqBaseUrl();

    // Determine the effective working directory.
    // activeRepoRoot is authoritative for the dispatched repo root. The runtime
    // config may still carry the same value as a compatibility override, but it
    // must not outrank the resolved active repo root when both are present.
    const effectiveCwd: string | undefined = activeRepoRoot ?? config.workingDirectory ?? workspaceRoot ?? undefined;

    if (effectiveCwd) {
      if (workspaceRoot && db) {
        await validateAndLogViolation(db, workspaceRoot, effectiveCwd, { instanceId });
      }
      console.log(
        `[ClaudeCodeRuntime] instance #${instanceId}: cwd=${effectiveCwd} activeRepoRoot=${activeRepoRoot ?? 'null'} workspaceRoot=${workspaceRoot ?? 'null'} (workspace boundary enforced)`
      );
    }

    // ── Agent tool registry injection (task #559) ──────────────────────────
    // Fetch tools assigned to this agent from the DB and create an in-process
    // MCP server so the Claude Code SDK session can invoke them.
    let agentToolMcpServer: ReturnType<typeof createAgentToolServer> = null;
    if (db) {
      try {
        const instRow = await db.get('SELECT agent_id FROM job_instances WHERE id = ?', instanceId) as { agent_id: number } | undefined;

        if (instRow?.agent_id) {
          const agentTools = await fetchAgentTools(db, instRow.agent_id);
          if (agentTools.length > 0) {
            const hardcodedSlugs = new Set(
              (config.allowedTools ?? DEFAULT_ALLOWED_TOOLS).map(t => t.toLowerCase())
            );
            agentToolMcpServer = createAgentToolServer(
              agentTools,
              effectiveCwd,
              hardcodedSlugs,
            );
            if (agentToolMcpServer) {
              console.log(
                `[ClaudeCodeRuntime] instance #${instanceId}: injecting ${agentTools.length} registry tool(s) via MCP server`,
              );
            }
          }
        }
      } catch (toolErr) {
        console.warn(
          `[ClaudeCodeRuntime] instance #${instanceId}: failed to load agent tools:`,
          toolErr instanceof Error ? toolErr.message : String(toolErr),
        );
      }
    }

    // Accumulate token usage across all assistant turns
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    try {
      for await (const sdkMessage of query({
        prompt: message,
        options: {
          cwd: effectiveCwd,
          model: modelOverride ?? config.model ?? 'claude-sonnet-4-6',
          effort: config.effort ?? 'high',
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          allowedTools: config.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
          disallowedTools: config.disallowedTools,
          maxTurns: config.maxTurns,
          maxBudgetUsd: config.maxBudgetUsd,
          abortController,
          persistSession: true,
          // Inject registry tools as an in-process MCP server (task #559)
          ...(agentToolMcpServer ? {
            mcpServers: { 'agent-hq-agent-tools': agentToolMcpServer },
          } : {}),
          env: {
            ...process.env,
            AGENT_HQ_INSTANCE_ID: String(instanceId),
            AGENT_HQ_DURABLE_RUN_ID: durableRunId ?? '',
            AGENT_HQ_TASK_ID: taskId != null ? String(taskId) : '',
            AGENT_HQ_SESSION_KEY: sessionKey ?? '',
            AGENT_HQ_AGENT_SLUG: agentSlug ?? '',
            AGENT_HQ_API_BASE: baseUrl,
            AGENT_HQ_CALLBACK_START: `${baseUrl}/api/v1/instances/${instanceId}/start`,
            AGENT_HQ_CALLBACK_CHECKIN: `${baseUrl}/api/v1/instances/${instanceId}/check-in`,
            AGENT_HQ_CALLBACK_COMPLETE: `${baseUrl}/api/v1/instances/${instanceId}/complete`,
            // Workspace boundary remains the broader allowed container root when present.
            ...(workspaceRoot ? { AGENT_HQ_WORKSPACE_ROOT: workspaceRoot } : effectiveCwd ? { AGENT_HQ_WORKSPACE_ROOT: effectiveCwd } : {}),
            // Active repo root is the authoritative repo cwd for this dispatched run.
            ...(effectiveCwd ? { AGENT_HQ_ACTIVE_REPO_ROOT: effectiveCwd } : {}),
          } as Record<string, string>,
        },
      })) {
        // Store the SDK session ID on the first init message so transcripts are
        // locatable via the job_instances.session_key column.
        if (
          sdkMessage.type === 'system' &&
          sdkMessage.subtype === 'init' &&
          db != null &&
          instanceId > 0
        ) {
          const sdkSessionId = (sdkMessage as { session_id?: string }).session_id;
          if (sdkSessionId) {
            await db.run('UPDATE job_instances SET session_key = ? WHERE id = ?', `claude-code:${sdkSessionId}`, instanceId);
          }
        }

        // Accumulate token usage from assistant turns
        if (sdkMessage.type === 'assistant') {
          const usage = (sdkMessage as { message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number } } }).message?.usage;
          if (usage) {
            totalInputTokens += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
            totalOutputTokens += usage.output_tokens ?? 0;
          }
        }

        // When the result arrives, persist accumulated token usage to DB.
        if (sdkMessage.type === 'result') {
          if (db != null && instanceId > 0 && (totalInputTokens > 0 || totalOutputTokens > 0)) {
            const total = totalInputTokens + totalOutputTokens;
            await db.run('UPDATE job_instances SET token_input = ?, token_output = ?, token_total = ? WHERE id = ?', totalInputTokens, totalOutputTokens, total, instanceId);
          }
          this.abortControllers.delete(instanceId);
        }
      }

      // After the run loop completes, ingest the JSONL transcript into canonical sessions.
      if (instanceId > 0 && db != null) {
        try {
          const row = await db.get('SELECT session_key FROM job_instances WHERE id = ?', instanceId) as { session_key: string | null } | undefined;
          const externalKey = row?.session_key;
          if (externalKey?.startsWith('claude-code:')) {
            const { ingestSessionByExternalKey } = await import('../lib/canonicalSessions');
            await ingestSessionByExternalKey(externalKey, { instanceId }, 'claude-code');
            console.log(`[ClaudeCodeRuntime] Ingested canonical session for instance #${instanceId}: ${externalKey}`);
          }
        } catch (ingestErr) {
          console.warn(`[ClaudeCodeRuntime] Failed to ingest canonical session for instance #${instanceId}:`, ingestErr);
        }
      }
    } catch (err) {
      // AbortError is expected on cancellation — suppress it
      if (err instanceof Error && err.name === 'AbortError') {
        console.log(`[ClaudeCodeRuntime] instance #${instanceId} aborted`);
      } else {
        throw err;
      }
    } finally {
      this.abortControllers.delete(instanceId);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * parseInstanceIdFromRunId — extract the numeric instanceId from a runId string.
 * Format: "claude-code:<instanceId>"
 * Returns null if the format doesn't match or the number is invalid.
 */
function parseInstanceIdFromRunId(runId: string): number | null {
  const match = runId.match(/^claude-code:(\d+)$/);
  if (!match) return null;
  const id = parseInt(match[1], 10);
  return isNaN(id) ? null : id;
}
