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

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import { hostname } from 'os';

import type {
  AgentRuntime,
  DispatchParams,
  PrepareAuthProfilesParams,
  RuntimeAuthProfileSyncResult,
  RuntimeAbortResult,
  RuntimeEndEvent,
} from '../types';
import { applyRuntimeEndToJobInstance } from '../../domains/runs/runtimeEnd';
import { validateAndLogViolation } from '../../lib/workspaceBoundary';
import { nowTimestamp } from '../../lib/timestamps';
import { type Db } from '../../db/adapter/types';

import {
  ActiveClaudeCodeRun,
  parseClaudeCodeInstanceIdFromRunId,
  waitForClaudeCodeChildProcess,
  writePromptToStdin,
  type ProcessExitResult,
} from './abort';
import {
  localProcessGroupId,
  localProcessIdentity,
  localProcessSpawnOptions,
  localProcessSupervisor,
} from '../localProcessSupervisor';
import { normalizeClaudeCodeRuntimeConfig } from './config';
import { prepareClaudeCodeAuthProfiles, resolveEffectiveClaudeConfigHome } from './auth';
import { buildClaudeArgs } from './args';
import { resolveResumableSessionId } from './resume';
import { classifyClaudeRun } from './errors';
import { ClaudeStreamAccumulator, NdjsonDecoder, mcpToolName } from './streamJson';
import { decodeClaudeStreamEvent, promptTranscriptEvent } from './transcript';
import { RuntimeTranscriptWriter } from '../transcript/writer';
import { buildAgentRuntimeEnv, buildRunIdentityEnv } from '../environment';
import { resolveAllowedRuntimeExecutable } from '../executablePolicy';
import { guardLocalRuntimeDispatchContext } from '../dispatchContextGuard';
import { probeAllowedRuntimeCliVersion } from '../runtimeCliVersion';
import {
  cleanupOwnedProcessTree,
  OwnedProcessTreeCleanupError,
} from '../ownedProcessTreeCleanup';
import { redactSensitiveRuntimeText, sanitizeRuntimeLaunchArguments } from '../sensitiveText';
import {
  terminalRuntimeExecution,
  upsertRuntimeExecutionStart,
} from '../runtimeExecutionStore';
import { assertRuntimeBoundaryAssignmentsCurrent } from '../../services/runtimeBoundaryAssignments';
import type {
  LocalProcessExecutionHandleV1,
  SanitizedRuntimeLaunchSpecV1,
} from '../runtimeBoundary';
import {
  cleanupClaudeCodeMcpRunConfig,
  materializeClaudeCodeMcpConfig,
  readPreviousRunServers,
} from './mcpConfig';
import {
  buildMcpPreflightRequirements,
  describeMcpPreflightFailure,
  preflightMcpServers,
  resolveRequiredMcpPreflightServerNames,
} from './mcpPreflight';
import {
  CLAUDE_CODE_RUNTIME_END_MESSAGE_PREFIX,
  CLAUDE_CODE_RUN_ID_PREFIX,
  CLAUDE_CODE_SESSION_KEY_PREFIX,
  type ClaudeCodeRuntimeConfig,
  type ClaudeMcpMaterialization,
  type NormalizedClaudeCodeRuntimeConfig,
} from './types';

const MAX_STDERR_BYTES = 128 * 1024;

function safeRuntimeError(error: unknown): string {
  return redactSensitiveRuntimeText(error instanceof Error ? error.message : String(error));
}

export class ClaudeCodeRuntime implements AgentRuntime {
  private readonly baseConfig: ClaudeCodeRuntimeConfig;

  constructor(config: ClaudeCodeRuntimeConfig = {}) {
    this.baseConfig = config;
  }

  async prepareAuthProfiles(
    params: PrepareAuthProfilesParams,
  ): Promise<RuntimeAuthProfileSyncResult> {
    return prepareClaudeCodeAuthProfiles(this.baseConfig, params);
  }

  async dispatch(params: DispatchParams): Promise<{ runId: string }> {
    // Layer-2 validation: throws before anything is spawned or written. The
    // create/update routes validate too, but a config written straight to the DB
    // (or predating a validation change) reaches here unchecked otherwise.
    const config = normalizeClaudeCodeRuntimeConfig({
      ...this.baseConfig,
      ...((params.runtimeConfig as ClaudeCodeRuntimeConfig | undefined) ?? {}),
    });
    const dispatchContext = await guardLocalRuntimeDispatchContext({
      runtimeType: 'claude-code',
      agentSlug: params.agentSlug,
      db: params.db,
      instanceId: params.instanceId,
      runtimeBoundary: params.runtimeBoundary,
      dispatchMode: params.dispatchMode,
    });
    const versionCheck = await probeAllowedRuntimeCliVersion({
      runtime: 'claude-code',
      command: config.claudeBin,
    });
    if (
      !versionCheck.ok
      || !versionCheck.executablePath
      || !versionCheck.executableFingerprint
    ) {
      throw new Error(`Claude Code CLI version verification failed: ${versionCheck.message}`);
    }
    const executable = {
      path: versionCheck.executablePath,
      fingerprint: versionCheck.executableFingerprint,
    };
    if (
      dispatchContext.mode === 'production'
      && dispatchContext.boundary.runtime.executableFingerprint !== executable.fingerprint
    ) {
      throw new Error(
        'Claude Code CLI executable fingerprint does not match the immutable runtime boundary',
      );
    }

    const instanceId = dispatchContext.instanceId;
    const runId = `${CLAUDE_CODE_RUN_ID_PREFIX}${instanceId ?? Date.now()}`;
    const db = dispatchContext.db;

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

    // Resolved before the session id, because where a resumable session would
    // have been recorded depends on it.
    const claudeConfigHome = resolveEffectiveClaudeConfigHome({
      config,
      providerConnectionId: params.providerConnectionId,
    });

    // Only a chat turn asks to continue a previous session; a task dispatch never
    // sets this and so always mints a fresh one. An id that cannot be resumed —
    // transcript cleaned up, or recorded against a different working directory —
    // degrades to a fresh session instead of failing the run.
    const resumeSessionId = resolveResumableSessionId({
      requested: params.resumeSessionId,
      cwd,
      claudeConfigHome,
    });

    // Mint the session id up front so session_key is truthful before the process
    // exists. The CLI honours --session-id exactly, so the on-disk transcript at
    // <config home>/projects/<slug>/<uuid>.jsonl is locatable from this moment on.
    // A resumed turn keeps the earlier id, which is what keeps one conversation
    // in one transcript file across turns.
    const sessionId = resumeSessionId ?? randomUUID();
    if (db && instanceId != null) {
      await db.run(
        'UPDATE job_instances SET session_key = ? WHERE id = ?',
        `${CLAUDE_CODE_SESSION_KEY_PREFIX}${sessionId}`,
        instanceId,
      );
    }

    const agentId = dispatchContext.agentId;
    const tenantId = dispatchContext.tenantId;
    const protectedInstanceIds = db
      ? await this.lookupActiveClaudeInstanceIds(db)
      : null;
    const mcp = await this.materializeMcp(
      db,
      tenantId,
      agentId,
      instanceId,
      sessionId,
      protectedInstanceIds,
      cwd,
    );

    let requiredMcpToolNames: string[];
    let args: string[];
    let childEnv: NodeJS.ProcessEnv;
    let child: ChildProcessWithoutNullStreams;
    try {
      requiredMcpToolNames = await this.preflightRequiredMcpServers(
        mcp,
        instanceId,
        params.runtimeBoundary,
      );
      args = buildClaudeArgs({
        config,
        sessionId,
        resume: resumeSessionId != null,
        model: params.model ?? null,
        mcpConfigPath: mcp.configPath,
        mcpAllowedToolNames: [...mcp.allowedToolNames, ...requiredMcpToolNames],
        addDirs: [],
      });

      childEnv = this.buildEnv(params, config, cwd, claudeConfigHome);
      if (dispatchContext.mode === 'production') {
        await assertRuntimeBoundaryAssignmentsCurrent({
          db: dispatchContext.db,
          boundary: dispatchContext.boundary,
          materializedMcpServerNames: mcp.serverNames,
        });
      }
      const currentExecutable = resolveAllowedRuntimeExecutable(
        'claude-code',
        config.claudeBin,
      );
      if (
        currentExecutable.path !== executable.path
        || currentExecutable.fingerprint !== executable.fingerprint
      ) {
        throw new Error('Claude Code CLI executable changed after version verification');
      }
      child = spawn(executable.path, args, {
        cwd,
        env: childEnv,
        // stdin MUST be a pipe: `--print -` reads the prompt from it.
        stdio: ['pipe', 'pipe', 'pipe'],
        // A separate POSIX process group lets stop terminate MCP/shell children
        // as well as the Claude CLI. Windows falls back to the direct child.
        ...localProcessSpawnOptions(),
      });
    } catch (error) {
      cleanupClaudeCodeMcpRunConfig(mcp.configPath);
      throw error;
    }
    const processGroupId = localProcessGroupId(child);
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

    // Live transcript. Rows are written as events arrive rather than at exit, so
    // a long run is observable while it is still running instead of appearing
    // silent until it finishes.
    const transcript =
      db && instanceId != null && agentId != null
        ? new RuntimeTranscriptWriter({
            db,
            agentId,
            instanceId,
            idPrefix: 'claude-code',
            sessionKey: `${CLAUDE_CODE_SESSION_KEY_PREFIX}${sessionId}`,
            durableRunId: params.durableRunId ?? null,
            tenantId,
          })
        : null;
    transcript?.enqueue([promptTranscriptEvent(params.message)]);

    child.stdout.on('data', (chunk: string) => {
      for (const event of decoder.push(chunk)) {
        accumulator.observe(event);
        transcript?.enqueue(decodeClaudeStreamEvent(event));
      }
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += chunk.slice(0, MAX_STDERR_BYTES - stderr.length);
      }
    });

    const { spawned, exited } = waitForClaudeCodeChildProcess(child);

    try {
      await spawned;
    } catch (err) {
      const message = safeRuntimeError(err);
      const cleanupError = await this.cleanupFailedLaunch({
        child,
        processGroupId,
        mcp,
        graceMs: config.killGraceMs,
      });
      // Mirrors Hermes: a launch failure is surfaced to the dispatcher, which
      // owns infra_failed vs runtime_failed classification for throwing dispatches.
      throw new Error(
        `Claude Code runtime failed to launch: ${message}`
          + (cleanupError ? `; cleanup failed: ${cleanupError}` : ''),
      );
    }

    let supervisorRegistered = false;
    try {
      localProcessSupervisor.register({
        runId,
        runtimeType: 'claude-code',
        instanceId,
        state,
        processGroupId,
      });
      supervisorRegistered = true;
      if (instanceId != null) {
        await db?.run('UPDATE job_instances SET run_id = ? WHERE id = ?', runId, instanceId);
      }
      if (db && params.runtimeBoundary) {
        if (typeof child.pid !== 'number') {
          throw new Error('spawned process did not expose a durable local-process pid');
        }
        const startedAt = nowTimestamp();
        const processIdentity = localProcessIdentity(child.pid);
        if (!processIdentity) {
          throw new Error('spawned process has no durable birth fingerprint; this host cannot safely reconcile or stop it after restart');
        }
        const handle: LocalProcessExecutionHandleV1 = {
          version: 1,
          kind: 'local-process',
          pid: child.pid,
          processGroupId,
          processIdentity,
          hostname: hostname(),
          startedAt,
        };
        const launchSpec: SanitizedRuntimeLaunchSpecV1 = {
          version: 1,
          command: executable.path,
          executableFingerprint: executable.fingerprint,
          args: sanitizeRuntimeLaunchArguments(args),
          cwd,
          // Names only: resolved provider credentials must never enter durable
          // execution records or operator-visible diagnostics.
          envKeys: Object.keys(childEnv).sort(),
        };
        const start = await upsertRuntimeExecutionStart(db, {
          boundary: params.runtimeBoundary,
          driver: 'claude-code',
          backend: 'local-process',
          state: 'running',
          launchSpec,
          handle,
          sessionId,
          startedAt,
          checkpointData: { runId },
        });
        if (
          start.status !== 'persisted'
          || start.executionId == null
          || start.checkpointId == null
        ) {
          throw new Error(`runtime execution start was not persisted (status=${start.status})`);
        }
      }
    } catch (executionStateError) {
      // If register rejected a duplicate run id, that id still belongs to the
      // existing authoritative child. Never signal it while cleaning this new,
      // unclaimed process.
      if (supervisorRegistered) localProcessSupervisor.terminate(runId, 'claude-code');
      const cleanupError = await this.cleanupFailedLaunch({
        child,
        processGroupId,
        mcp,
        graceMs: config.killGraceMs,
      });
      if (supervisorRegistered) localProcessSupervisor.unregister(runId, child);
      throw new Error(
        `Claude Code runtime refused to start without durable execution state: ${safeRuntimeError(executionStateError)}`
          + (cleanupError ? `; cleanup failed: ${cleanupError}` : ''),
      );
    }

    const timeoutTimer =
      params.timeoutSeconds > 0
        ? setTimeout(() => {
            state.timedOut = true;
            localProcessSupervisor.terminate(runId, 'claude-code');
          }, params.timeoutSeconds * 1000)
        : null;

    void this.monitorRun({
      params,
      config,
      runId,
      db,
      tenantId,
      state,
      exited,
      accumulator,
      decoder,
      transcript,
      getStderr: () => stderr,
      isMcpReady: () => true,
      mcp,
      processGroupId,
      timeoutTimer,
    }).catch((err: unknown) => {
      console.error('[ClaudeCodeRuntime] unhandled error in monitorRun', safeRuntimeError(err));
    });

    // The CLI waits for stdin. Attach terminal supervision (and its rejection
    // handler) before the final operation that can fail between durable launch
    // and model execution. A synchronous stream failure then still has a live
    // monitor and timeout responsible for confirmed process-tree cleanup.
    try {
      writePromptToStdin(child, params.message);
    } catch (error) {
      localProcessSupervisor.terminate(runId, 'claude-code');
      throw new Error(`Claude Code prompt delivery failed: ${safeRuntimeError(error)}`);
    }

    return { runId };
  }

  async abort(runId: string, _sessionKey: string): Promise<RuntimeAbortResult> {
    const instanceId = parseClaudeCodeInstanceIdFromRunId(runId);
    if (instanceId == null) {
      return {
        attempted: false,
        ok: false,
        confirmed: false,
        status: 'not_found',
        error: `Invalid Claude Code run id: ${runId}`,
      };
    }
    const result = localProcessSupervisor.stop(runId, 'claude-code');
    return {
      attempted: true,
      ok: result.status !== 'not_found',
      // Delivering SIGTERM is an attempted stop, not proof that the process
      // group exited. The terminal monitor/reconciler owns confirmation.
      confirmed: result.status === 'already_gone',
      status: result.status,
      ...(result.status === 'not_found'
        ? { error: `No supervised Claude Code process exists for ${runId}` }
        : {}),
    };
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
    boundary: DispatchParams['runtimeBoundary'],
  ): Promise<string[]> {
    const requiredServerNames = resolveRequiredMcpPreflightServerNames(
      mcp.serverNames,
      mcp.requiredServerNames,
      boundary,
    );
    if (requiredServerNames.length === 0) return [];
    if (!mcp.configPath) {
      throw new Error('Required MCP servers have no readable materialized configuration.');
    }

    let servers: Record<string, Record<string, unknown>>;
    try {
      servers = readPreviousRunServers(mcp.configPath);
    } catch (error) {
      throw new Error(
        `Required MCP configuration could not be read: ${safeRuntimeError(error)}`,
      );
    }

    const requirements = buildMcpPreflightRequirements(requiredServerNames, boundary);
    const results = await preflightMcpServers(servers, requirements);
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
    return requirements.flatMap((requirement) =>
      requirement.requiredToolNames.map((toolName) => mcpToolName(requirement.serverName, toolName)),
    );
  }

  // ── Run monitor ────────────────────────────────────────────────────────────

  private async monitorRun(args: {
    params: DispatchParams;
    config: NormalizedClaudeCodeRuntimeConfig;
    runId: string;
    db: Db | null;
    tenantId: number | null;
    state: ActiveClaudeCodeRun;
    exited: Promise<ProcessExitResult>;
    accumulator: ClaudeStreamAccumulator;
    decoder: NdjsonDecoder;
    transcript: RuntimeTranscriptWriter | null;
    getStderr: () => string;
    isMcpReady: () => boolean;
    mcp: ClaudeMcpMaterialization;
    processGroupId: number | null;
    timeoutTimer: ReturnType<typeof setTimeout> | null;
  }): Promise<void> {
    const { params, runId, db, state, exited, accumulator, decoder, transcript, mcp } = args;
    const instanceId = params.instanceId ?? null;
    let runtimeEndEvent: RuntimeEndEvent | null = null;

    try {
      const result = await exited;
      state.exited = true;
      localProcessSupervisor.unregister(runId, state.child);
      if (args.timeoutTimer) clearTimeout(args.timeoutTimer);

      localProcessSupervisor.cancelDeferredProcessGroupEscalation(args.processGroupId);
      const treeCleanup = await cleanupOwnedProcessTree({
        child: state.child,
        processGroupId: args.processGroupId,
        graceMs: args.config.killGraceMs,
      });
      if (!treeCleanup.confirmed) {
        throw new OwnedProcessTreeCleanupError(
          `Claude Code leader exited but descendant cleanup was not confirmed: ${treeCleanup.error ?? 'unknown process-tree state'}`,
        );
      }
      localProcessSupervisor.confirmProcessGroupAbsent(args.processGroupId);
      // The file can contain third-party MCP credentials. Keep it available for
      // the full owned process-tree lifetime, then remove it before recording a
      // terminal result.
      cleanupClaudeCodeMcpRunConfig(mcp.configPath);

      // A process can exit without a trailing newline; drain the partial line.
      for (const event of decoder.flush()) {
        accumulator.observe(event);
        transcript?.enqueue(decodeClaudeStreamEvent(event));
      }
      const transcriptResult = await transcript?.drain();

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

      // Mirrors Hermes: only persist a single flattened answer when the richer
      // streamed rows are absent, so a healthy run does not store its final text
      // twice under two different ids.
      if (!transcriptResult || transcriptResult.written === 0) {
        await this.persistAssistantMessage(db, instanceId, accumulator.finalText);
      }
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
        ...(success ? {} : { error: redactSensitiveRuntimeText(classification.summary) }),
        metadata: {
          exit_code: result.code,
          signal: result.signal,
          stderr: redactSensitiveRuntimeText(args.getStderr()).trim() || null,
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
          transcript_rows_written: transcriptResult?.written ?? 0,
          transcript_rows_failed: transcriptResult?.failed ?? 0,
          process_group_id: args.processGroupId,
          process_tree_cleanup_confirmed: true,
          process_tree_cleanup_escalated: treeCleanup.escalated,
        },
      };
    } catch (err) {
      if (err instanceof OwnedProcessTreeCleanupError) {
        // Keep the durable execution active. The reconciler will quarantine a
        // leaderless live PGID; terminalizing here would hide credential-bearing
        // descendants behind a false completed/failed state.
        console.error('[ClaudeCodeRuntime] process tree quarantined:', safeRuntimeError(err));
        runtimeEndEvent = null;
      } else {
        runtimeEndEvent = {
          type: 'runEnded',
          source: 'claude-code',
          sessionKey: params.sessionKey,
          runId,
          success: false,
          endedAt: nowTimestamp(),
          reason: 'error',
          error: redactSensitiveRuntimeText(err instanceof Error ? err.message : String(err)),
        };
      }
    } finally {
      if (instanceId != null && args.tenantId != null && runtimeEndEvent) {
        try {
          await this.handleRuntimeEnd(db, instanceId, args.tenantId, runtimeEndEvent, accumulator);
        } catch (error) {
          // Durable terminal state is repaired into job_instances by the runtime
          // reconciler. No persistence failure may reject this detached monitor
          // promise or suppress the caller's terminal notification.
          console.warn(
            `[ClaudeCodeRuntime] unexpected terminal delivery failure for instance #${instanceId}:`,
            safeRuntimeError(error),
          );
        }
      }
      if (runtimeEndEvent && params.onRuntimeEnd) {
        try {
          await params.onRuntimeEnd(runtimeEndEvent);
        } catch (error) {
          console.warn('[ClaudeCodeRuntime] runtime-end callback failed:', safeRuntimeError(error));
        }
      }
    }
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private async handleRuntimeEnd(
    db: Db | null,
    instanceId: number,
    tenantId: number,
    event: RuntimeEndEvent,
    accumulator: ClaudeStreamAccumulator,
  ): Promise<void> {
    if (!db) return;

    try {
      await terminalRuntimeExecution(db, {
        instanceId,
        tenantId,
        state: event.reason === 'aborted' ? 'cancelled' : event.success ? 'succeeded' : 'failed',
        reason: event.reason ?? (event.success ? 'completed' : 'error'),
        error: event.error ?? null,
        metadata: event.metadata ?? {},
        endedAt: event.endedAt,
      });
    } catch (executionStateError) {
      console.warn(
        `[ClaudeCodeRuntime] failed to persist runtime execution terminal state for instance #${instanceId}:`,
        safeRuntimeError(executionStateError),
      );
    }

    const usage = accumulator.usage;
    try {
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
    } catch (projectionError) {
      // The durable execution above is authoritative. Its terminal/nonterminal
      // projection mismatch is a deliberate retry signal for the reconciler.
      console.warn(
        `[ClaudeCodeRuntime] failed to project runtime terminal state for instance #${instanceId}:`,
        safeRuntimeError(projectionError),
      );
    }
    try {
      await this.persistRuntimeEndEvent(db, instanceId, event);
    } catch (eventError) {
      console.warn(
        `[ClaudeCodeRuntime] unexpected runtime-end evidence failure for instance #${instanceId}:`,
        safeRuntimeError(eventError),
      );
    }
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
        INSERT INTO chat_messages (id, tenant_id, agent_id, instance_id, role, content, timestamp, event_type, event_meta)
        SELECT ?, tenant_id, agent_id, id, 'system', ?, ?, 'turn_end', ?
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
        SET response = jsonb_set((COALESCE(response, '{}'))::jsonb, '{runtimeEnd}', (?)::jsonb)
        WHERE id = ?
      `,
        JSON.stringify(event),
        instanceId,
      );
    } catch (err) {
      console.warn(
        `[ClaudeCodeRuntime] failed to persist runtime-end records for instance #${instanceId}:`,
        safeRuntimeError(err),
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
        safeRuntimeError(err),
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
        INSERT INTO chat_messages (id, tenant_id, agent_id, instance_id, role, content, timestamp, event_type)
        SELECT ?, tenant_id, agent_id, id, 'assistant', ?, ?, 'text'
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
        safeRuntimeError(err),
      );
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async lookupActiveClaudeInstanceIds(db: Db): Promise<ReadonlySet<number> | null> {
    try {
      const rows = await db.all<{ instance_id: number }>(`
        SELECT instance_id
        FROM runtime_executions
        WHERE driver = 'claude-code'
          AND backend = 'local-process'
          AND state IN ('preparing', 'starting', 'running', 'interrupting')
      `);
      return new Set(
        rows
          .map((row) => Number(row.instance_id))
          .filter((value) => Number.isSafeInteger(value) && value > 0),
      );
    } catch {
      // Without durable visibility, skip age-based scavenging entirely. Guessing
      // that no run is active could delete a config still needed after restart.
      return null;
    }
  }

  private async cleanupFailedLaunch(params: {
    child: ChildProcessWithoutNullStreams;
    processGroupId: number | null;
    mcp: ClaudeMcpMaterialization;
    graceMs: number;
  }): Promise<string | null> {
    try {
      // A POSIX spawn failure has no PGID. On Windows, a child with a pid cannot
      // be declared tree-clean without a Job Object and its config stays put.
      const requiresTreeCleanup = params.processGroupId != null
        || (process.platform === 'win32' && typeof params.child.pid === 'number');
      if (requiresTreeCleanup) {
        localProcessSupervisor.cancelDeferredProcessGroupEscalation(params.processGroupId);
        const cleanup = await cleanupOwnedProcessTree({
          child: params.child,
          processGroupId: params.processGroupId,
          graceMs: params.graceMs,
        });
        if (!cleanup.confirmed) {
          return cleanup.error ?? 'Claude process-tree cleanup was not confirmed.';
        }
        localProcessSupervisor.confirmProcessGroupAbsent(params.processGroupId);
      }
      cleanupClaudeCodeMcpRunConfig(params.mcp.configPath);
      return null;
    } catch (error) {
      return safeRuntimeError(error);
    }
  }

  private async materializeMcp(
    db: Db | null,
    tenantId: number | null,
    agentId: number | null,
    instanceId: number | null,
    runKey: string,
    protectedInstanceIds: ReadonlySet<number> | null,
    workingDirectory: string | null,
  ): Promise<ClaudeMcpMaterialization> {
    const empty: ClaudeMcpMaterialization = {
      configPath: null,
      serverNames: [],
      requiredServerNames: [],
      allowedToolNames: [],
      warnings: [],
    };
    if (!db) return empty;
    if (tenantId == null || agentId == null || instanceId == null) {
      throw new Error('Claude MCP materialization requires trusted tenant, agent, and instance identity.');
    }

    const result = await materializeClaudeCodeMcpConfig({
      workingDirectory,
      db,
      tenantId,
      agentId,
      instanceId,
      runKey,
      protectedInstanceIds,
    });
    for (const warning of result.warnings) {
      console.warn(`[ClaudeCodeRuntime] ${warning}`);
    }
    return result;
  }

  private buildEnv(
    params: DispatchParams,
    config: NormalizedClaudeCodeRuntimeConfig,
    cwd: string,
    claudeConfigHome: string,
  ): NodeJS.ProcessEnv {
    return buildAgentRuntimeEnv({
      agentConfig: config.env,
      injectedSecrets: params.secretEnv,
      runIdentity: buildRunIdentityEnv(params, cwd),
      // Always pin the exact home validated for the selected opaque provider
      // reference; never let ambient process state retarget the launch.
      adapterOwned: { CLAUDE_CONFIG_DIR: claudeConfigHome },
    });
  }
}
