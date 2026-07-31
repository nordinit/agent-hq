/**
 * runtimes/claudeCode/ClaudeCodeRuntime.ts — AgentRuntime backed by the Claude
 * Code headless CLI.
 *
 * Replaces the previous in-process `@anthropic-ai/claude-agent-sdk` runtime.
 * Design and rationale: docs/architecture/claude-code-runtime-v2.md.
 *
 * Structurally this mirrors runtimes/hermes/HermesRuntime.ts — spawn, hand the
 * run to a fire-and-forget monitorRun(), build exactly one RuntimeEndEvent on
 * every terminal path, and persist it before firing the observability callback.
 * Four things differ, each because of a verified CLI behaviour:
 *
 *  - The prompt goes on STDIN (`--print -`), so stdin is a pipe that must be
 *    closed or the run hangs with no output.
 *  - The session UUID is minted by Agent HQ and passed via `--session-id`, so
 *    `job_instances.session_key` is correct BEFORE the process starts rather
 *    than after an init message races in.
 *  - stdout is parsed incrementally as stream-json rather than buffered, so a
 *    live transcript can be written as events arrive.
 *  - Required MCP servers are PREFLIGHTED before spawn (mcpPreflight.ts). A run
 *    whose MCP servers failed to start still exits 0 with
 *    `terminal_reason: 'completed'`, so without an out-of-band check an agent
 *    that could not reach `agent_hq_post_task_outcome` is indistinguishable from
 *    a healthy one. The check is deliberately NOT read from the event stream —
 *    see the comment in mcpPreflight.ts for the measurements that ruled that out.
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

import type {
  AgentRuntime,
  DispatchParams,
  PrepareAuthProfilesParams,
  RuntimeAuthProfileSyncResult,
  RuntimeEndEvent,
} from '../types';
import { skippedRuntimeAuthProfileSync } from '../types';
import { applyRuntimeEndToJobInstance } from '../../domains/runs/runtimeEnd';
import { validateAndLogViolation } from '../../lib/workspaceBoundary';
import { nowTimestamp } from '../../lib/timestamps';
import { type Db } from '../../db/adapter/types';

import {
  ActiveClaudeCodeRun,
  parseClaudeCodeInstanceIdFromRunId,
  stopClaudeCodeActiveRun,
  terminateClaudeCodeRun,
  waitForClaudeCodeChildProcess,
  writePromptToStdin,
  type ProcessExitResult,
} from './abort';
import { normalizeClaudeCodeRuntimeConfig } from './config';
import { buildClaudeArgs } from './args';
import { classifyClaudeRun } from './errors';
import { ClaudeStreamAccumulator, NdjsonDecoder } from './streamJson';
import {
  materializeClaudeCodeMcpConfig,
  readPreviousRunServers,
  resolveClaudeCodeAgentStateDir,
} from './mcpConfig';
import { describeMcpPreflightFailure, preflightMcpServers } from './mcpPreflight';
import {
  CLAUDE_CODE_RUNTIME_END_MESSAGE_PREFIX,
  CLAUDE_CODE_RUN_ID_PREFIX,
  CLAUDE_CODE_SESSION_KEY_PREFIX,
  type ClaudeCodeRuntimeConfig,
  type ClaudeMcpMaterialization,
  type NormalizedClaudeCodeRuntimeConfig,
} from './types';

export class ClaudeCodeRuntime implements AgentRuntime {
  private readonly baseConfig: ClaudeCodeRuntimeConfig;
  private readonly activeRuns = new Map<number, ActiveClaudeCodeRun>();

  constructor(config: ClaudeCodeRuntimeConfig = {}) {
    this.baseConfig = config;
  }

  async prepareAuthProfiles(
    _params: PrepareAuthProfilesParams,
  ): Promise<RuntimeAuthProfileSyncResult> {
    // Claude Code credentials are operator-owned host state (~/.claude, or the
    // per-agent CLAUDE_CONFIG_DIR in runtime_config). Agent HQ does not mint them.
    return skippedRuntimeAuthProfileSync(
      'Claude Code runtime uses operator-managed CLI credentials; set runtime_config.claudeConfigDir to isolate them per agent.',
    );
  }

  async dispatch(params: DispatchParams): Promise<{ runId: string }> {
    // Layer-2 validation: throws before anything is spawned or written. The
    // create/update routes validate too, but a config written straight to the DB
    // (or predating a validation change) reaches here unchecked otherwise.
    const config = normalizeClaudeCodeRuntimeConfig({
      ...this.baseConfig,
      ...((params.runtimeConfig as ClaudeCodeRuntimeConfig | undefined) ?? {}),
    });

    const instanceId = params.instanceId ?? null;
    const runId = `${CLAUDE_CODE_RUN_ID_PREFIX}${instanceId ?? Date.now()}`;
    const db = params.db ?? null;

    // activeRepoRoot is authoritative. runtime_config.workingDirectory is a
    // compatibility fallback only and must never outrank the resolved repo root.
    const cwd =
      params.activeRepoRoot ?? config.workingDirectory ?? params.workspaceRoot ?? null;
    if (!cwd) {
      throw new Error(
        'Claude Code runtime requires activeRepoRoot, runtime_config.workingDirectory, or workspaceRoot',
      );
    }

    if (params.workspaceRoot && db) {
      await validateAndLogViolation(db, params.workspaceRoot, cwd, {
        instanceId: instanceId ?? undefined,
      });
    }

    // Mint the session id up front so session_key is truthful before the process
    // exists. The CLI honours --session-id exactly, so the on-disk transcript at
    // ~/.claude/projects/<slug>/<uuid>.jsonl is locatable from this moment on.
    const sessionId = randomUUID();
    if (db && instanceId != null) {
      await db.run(
        'UPDATE job_instances SET session_key = ? WHERE id = ?',
        `${CLAUDE_CODE_SESSION_KEY_PREFIX}${sessionId}`,
        instanceId,
      );
    }

    const agentId = db && instanceId != null ? await this.lookupAgentId(db, instanceId) : null;
    const mcp = await this.materializeMcp(db, agentId, instanceId, config);
    await this.preflightRequiredMcpServers(mcp, instanceId);

    const args = buildClaudeArgs({
      config,
      sessionId,
      model: params.model ?? null,
      mcpConfigPath: mcp.configPath,
      mcpAllowedToolNames: mcp.allowedToolNames,
      addDirs: [],
    });

    const child = spawn(config.claudeBin, args, {
      cwd,
      env: this.buildEnv(params, config, cwd),
      // stdin MUST be a pipe: `--print -` reads the prompt from it.
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const state: ActiveClaudeCodeRun = {
      child,
      killGraceMs: config.killGraceMs,
      exited: false,
      aborted: false,
      timedOut: false,
      mcpGateFailed: false,
    };

    const accumulator = new ClaudeStreamAccumulator();
    const decoder = new NdjsonDecoder();
    let stderr = '';

    child.stdout.on('data', (chunk: string) => {
      for (const event of decoder.push(chunk)) {
        accumulator.observe(event);
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const { spawned, exited } = waitForClaudeCodeChildProcess(child);
    writePromptToStdin(child, params.message);

    try {
      await spawned;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Mirrors Hermes: a launch failure is surfaced to the dispatcher, which
      // owns infra_failed vs runtime_failed classification for throwing dispatches.
      throw new Error(`Claude Code runtime failed to launch: ${message}`);
    }

    if (instanceId != null) {
      this.activeRuns.set(instanceId, state);
      await db?.run('UPDATE job_instances SET run_id = ? WHERE id = ?', runId, instanceId);
    }

    const timeoutTimer =
      params.timeoutSeconds > 0
        ? setTimeout(() => {
            state.timedOut = true;
            terminateClaudeCodeRun(state);
          }, params.timeoutSeconds * 1000)
        : null;

    void this.monitorRun({
      params,
      config,
      runId,
      db,
      state,
      exited,
      accumulator,
      decoder,
      getStderr: () => stderr,
      isMcpReady: () => true,
      mcp,
      timeoutTimer,
    }).catch((err: unknown) => {
      console.error('[ClaudeCodeRuntime] unhandled error in monitorRun', err);
    });

    return { runId };
  }

  async abort(runId: string, _sessionKey: string): Promise<void> {
    const instanceId = parseClaudeCodeInstanceIdFromRunId(runId);
    if (instanceId == null) return;

    const active = this.activeRuns.get(instanceId);
    if (!active || active.exited) return;

    stopClaudeCodeActiveRun(active);
  }

  // ── MCP preflight ──────────────────────────────────────────────────────────

  /**
   * Verify every required MCP server actually starts, BEFORE spawning the agent.
   *
   * This is a dispatch-time startup failure in the same class as a missing
   * binary, so it throws — the dispatcher owns infra_failed classification for
   * throwing dispatches (services/dispatcher.classifyDispatchStartupFailure).
   *
   * Doing it here rather than mid-stream is not a stylistic choice. The CLI gives
   * no reliable in-band readiness signal: a healthy run reports its servers as
   * `pending` forever, and so does a run whose server command does not exist. An
   * in-band gate therefore either misses real failures or fails healthy runs —
   * it did the latter, which is how this was found. Preflighting also means a
   * broken lifecycle server costs zero model spend instead of a full wasted run.
   */
  private async preflightRequiredMcpServers(
    mcp: ClaudeMcpMaterialization,
    instanceId: number | null,
  ): Promise<void> {
    if (mcp.requiredServerNames.length === 0 || !mcp.configPath) return;

    let servers: Record<string, Record<string, unknown>>;
    try {
      servers = readPreviousRunServers(mcp.configPath);
    } catch {
      return; // unreadable config is reported by the spawn path instead
    }

    const results = await preflightMcpServers(servers, mcp.requiredServerNames);
    const failure = describeMcpPreflightFailure(results);
    if (failure) {
      console.error(`[ClaudeCodeRuntime] instance #${instanceId ?? '?'}: ${failure}`);
      throw new Error(failure);
    }

    console.log(
      `[ClaudeCodeRuntime] instance #${instanceId ?? '?'}: MCP preflight ok — ` +
        results
          .map((r) => `${r.serverName} (${r.toolNames.length} tool(s), ${r.durationMs}ms)`)
          .join(', '),
    );
  }

  // ── Run monitor ────────────────────────────────────────────────────────────

  private async monitorRun(args: {
    params: DispatchParams;
    config: NormalizedClaudeCodeRuntimeConfig;
    runId: string;
    db: Db | null;
    state: ActiveClaudeCodeRun;
    exited: Promise<ProcessExitResult>;
    accumulator: ClaudeStreamAccumulator;
    decoder: NdjsonDecoder;
    getStderr: () => string;
    isMcpReady: () => boolean;
    mcp: ClaudeMcpMaterialization;
    timeoutTimer: ReturnType<typeof setTimeout> | null;
  }): Promise<void> {
    const { params, runId, db, state, exited, accumulator, decoder, mcp } = args;
    const instanceId = params.instanceId ?? null;
    let runtimeEndEvent: RuntimeEndEvent | null = null;

    try {
      const result = await exited;
      state.exited = true;
      if (instanceId != null) this.activeRuns.delete(instanceId);
      if (args.timeoutTimer) clearTimeout(args.timeoutTimer);

      // A process can exit without a trailing newline; drain the partial line.
      for (const event of decoder.flush()) accumulator.observe(event);

      const classification = classifyClaudeRun({
        accumulator,
        exitCode: result.code,
        signal: result.signal,
        spawnError: result.error ?? null,
        timedOut: state.timedOut,
        aborted: state.aborted,
        mcpReady: args.isMcpReady(),
        stderr: args.getStderr(),
        timeoutSeconds: params.timeoutSeconds,
      });

      await this.persistAssistantMessage(db, instanceId, accumulator.finalText);
      await this.persistTokenUsageFallback(db, instanceId, accumulator);

      const success = classification.family === 'none' && !state.aborted;
      runtimeEndEvent = {
        type: 'runEnded',
        source: 'claude-code',
        sessionKey: params.sessionKey,
        runId,
        success,
        endedAt: nowTimestamp(),
        reason: state.aborted
          ? 'aborted'
          : state.timedOut
            ? 'timeout'
            : success
              ? 'completed'
              : 'error',
        ...(success ? {} : { error: classification.summary }),
        metadata: {
          exit_code: result.code,
          signal: result.signal,
          stderr: args.getStderr().trim() || null,
          error_code: classification.code,
          error_family: classification.family,
          retry_not_before: classification.retryNotBefore ?? null,
          claude_session_id: accumulator.sessionId,
          claude_cli_version: accumulator.cliVersion,
          effective_model: accumulator.model,
          terminal_reason: accumulator.terminalReason,
          result_subtype: accumulator.resultSubtype,
          result_event_count: accumulator.resultCount,
          total_turns: accumulator.totalTurns,
          // There is no cost column on job_instances, so cost rides in the
          // runtime-end metadata rather than being silently dropped.
          total_cost_usd: accumulator.costUsd,
          model_usage: accumulator.modelUsage,
          mcp_required_servers: mcp.requiredServerNames,
          mcp_preflight_ok: mcp.requiredServerNames.length > 0 ? true : null,
          mcp_tool_calls: accumulator.mcpToolCallNames,
          mcp_servers_confirmed_in_run: mcp.requiredServerNames.filter((name) =>
            accumulator.confirmedMcpServer(name),
          ),
          malformed_stdout_lines: decoder.malformedLines.length,
        },
      };
    } catch (err) {
      runtimeEndEvent = {
        type: 'runEnded',
        source: 'claude-code',
        sessionKey: params.sessionKey,
        runId,
        success: false,
        endedAt: nowTimestamp(),
        reason: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (instanceId != null && runtimeEndEvent) {
        await this.handleRuntimeEnd(db, instanceId, runtimeEndEvent, accumulator);
      }
      if (runtimeEndEvent) {
        await params.onRuntimeEnd?.(runtimeEndEvent);
      }
    }
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private async handleRuntimeEnd(
    db: Db | null,
    instanceId: number,
    event: RuntimeEndEvent,
    accumulator: ClaudeStreamAccumulator,
  ): Promise<void> {
    if (!db) return;

    const usage = accumulator.usage;
    await applyRuntimeEndToJobInstance(db, {
      instanceId,
      event: usage
        ? {
            ...event,
            metadata: {
              ...(event.metadata ?? {}),
              token_input: usage.inputTokens,
              token_output: usage.outputTokens,
              token_total: usage.inputTokens + usage.outputTokens,
            },
          }
        : event,
      runtimeName: 'Claude Code',
      runtimeEndSource: event.source,
    });
    await this.persistRuntimeEndEvent(db, instanceId, event);
  }

  /**
   * Writes the two records the watchdog's crash-recovery path reads back
   * (scheduler/watchdog.ts): the terminal `turn_end` chat message and the
   * `response.runtimeEnd` blob. A runtime that persists runtime_end_* but skips
   * these loses recovery when the API restarts mid-run.
   *
   * `source` is written explicitly into event_meta so recovery does not have to
   * fall back to matching the message-id prefix.
   */
  private async persistRuntimeEndEvent(
    db: Db,
    instanceId: number,
    event: RuntimeEndEvent,
  ): Promise<void> {
    const meta = {
      source: event.source,
      runtime_end_type: event.type,
      terminal_reason: event.reason ?? (event.success ? 'completed' : 'error'),
      session_key: event.sessionKey,
      run_id: event.runId ?? null,
      success: event.success,
      error: event.error ?? null,
      ...(event.metadata ?? {}),
    };

    try {
      await db.run(
        `
        INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp, event_type, event_meta)
        SELECT ?, agent_id, id, 'system', ?, ?, 'turn_end', ?
        FROM job_instances
        WHERE id = ?
        ON CONFLICT(id) DO UPDATE SET
          content = excluded.content,
          timestamp = excluded.timestamp,
          event_type = excluded.event_type,
          event_meta = excluded.event_meta
      `,
        `${CLAUDE_CODE_RUNTIME_END_MESSAGE_PREFIX}${instanceId}`,
        `Runtime ${event.type} (${meta.terminal_reason})`,
        event.endedAt,
        JSON.stringify(meta),
        instanceId,
      );

      // json_set's path must be a literal — the Postgres dialect layer rejects a
      // bound-parameter path when translating to jsonb_set.
      await db.run(
        `
        UPDATE job_instances
        SET response = json_set(COALESCE(response, '{}'), '$.runtimeEnd', json(?))
        WHERE id = ?
      `,
        JSON.stringify(event),
        instanceId,
      );
    } catch (err) {
      console.warn(
        `[ClaudeCodeRuntime] failed to persist runtime-end records for instance #${instanceId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Token usage is normally written inside applyRuntimeEndToJobInstance's guarded
   * claim UPDATE. That claim matches zero rows when the agent already posted its
   * lifecycle outcome (status left 'queued'/'dispatched'/'running' is a
   * precondition), which silently drops the tokens. This unguarded follow-up
   * keeps usage accounting correct in that case.
   */
  private async persistTokenUsageFallback(
    db: Db | null,
    instanceId: number | null,
    accumulator: ClaudeStreamAccumulator,
  ): Promise<void> {
    if (!db || instanceId == null) return;
    const usage = accumulator.usage;
    if (!usage) return;

    try {
      await db.run(
        'UPDATE job_instances SET token_input = ?, token_output = ?, token_total = ? WHERE id = ?',
        usage.inputTokens,
        usage.outputTokens,
        usage.inputTokens + usage.outputTokens,
        instanceId,
      );
    } catch (err) {
      console.warn(
        `[ClaudeCodeRuntime] failed to persist token usage for instance #${instanceId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async persistAssistantMessage(
    db: Db | null,
    instanceId: number | null,
    text: string,
  ): Promise<void> {
    if (!db || instanceId == null || !text.trim()) return;

    try {
      await db.run(
        `
        INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp, event_type)
        SELECT ?, agent_id, id, 'assistant', ?, ?, 'text'
        FROM job_instances
        WHERE id = ?
        ON CONFLICT(id) DO UPDATE SET
          content = excluded.content,
          timestamp = excluded.timestamp
      `,
        `claude-code-asst-${instanceId}`,
        text,
        nowTimestamp(),
        instanceId,
      );
    } catch (err) {
      console.warn(
        `[ClaudeCodeRuntime] failed to persist assistant message for instance #${instanceId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async lookupAgentId(db: Db, instanceId: number): Promise<number | null> {
    try {
      const row = (await db.get(
        'SELECT agent_id FROM job_instances WHERE id = ?',
        instanceId,
      )) as { agent_id?: number } | undefined;
      return row?.agent_id ?? null;
    } catch {
      return null;
    }
  }

  private async materializeMcp(
    db: Db | null,
    agentId: number | null,
    instanceId: number | null,
    config: NormalizedClaudeCodeRuntimeConfig,
  ): Promise<ClaudeMcpMaterialization> {
    const empty: ClaudeMcpMaterialization = {
      configPath: null,
      serverNames: [],
      requiredServerNames: [],
      allowedToolNames: [],
      warnings: [],
    };
    if (!db || agentId == null || instanceId == null) return empty;

    try {
      const stateDir = resolveClaudeCodeAgentStateDir(agentId);
      const result = await materializeClaudeCodeMcpConfig({
        db,
        agentId,
        instanceId,
        stateDir,
        // Carrying the previous run's servers forward keeps
        // ensureMaterializedMcpApiKeyForAgent from minting (and never revoking)
        // a fresh AGENT_HQ_MCP_API_KEY on every single dispatch.
        previousServers: readPreviousRunServers(`${stateDir}/mcp-config.json`),
      });
      for (const warning of result.warnings) {
        console.warn(`[ClaudeCodeRuntime] ${warning}`);
      }
      return result;
    } catch (err) {
      console.warn(
        `[ClaudeCodeRuntime] MCP materialization failed for instance #${instanceId}:`,
        err instanceof Error ? err.message : String(err),
      );
      // Deliberately non-fatal here: the readiness gate is what fails the run, and
      // it produces a far better diagnostic than an exception at dispatch time.
      return empty;
    }
  }

  private buildEnv(
    params: DispatchParams,
    config: NormalizedClaudeCodeRuntimeConfig,
    cwd: string,
  ): NodeJS.ProcessEnv {
    const agentHqEnv: Record<string, string> = {
      AGENT_HQ_INSTANCE_ID: params.instanceId != null ? String(params.instanceId) : '',
      AGENT_HQ_DURABLE_RUN_ID: params.durableRunId ?? '',
      AGENT_HQ_TASK_ID: params.taskId != null ? String(params.taskId) : '',
      AGENT_HQ_SESSION_KEY: params.sessionKey,
      AGENT_HQ_AGENT_SLUG: params.agentSlug,
      AGENT_HQ_WORKSPACE_ROOT: params.workspaceRoot ?? cwd,
      AGENT_HQ_ACTIVE_REPO_ROOT: params.activeRepoRoot ?? cwd,
    };

    if (config.claudeConfigDir) {
      // Isolates credentials, session history and settings per agent. Without it
      // every claude-code agent shares the API process's ~/.claude.
      agentHqEnv.CLAUDE_CONFIG_DIR = config.claudeConfigDir;
    }

    return {
      ...process.env,
      ...agentHqEnv,
      // Operator env last, matching Hermes — it can deliberately override.
      ...config.env,
    };
  }
}
