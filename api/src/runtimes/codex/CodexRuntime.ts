import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import { hostname } from 'os';
import path from 'path';
import type { Db } from '../../db/adapter/types';
import { applyRuntimeEndToJobInstance } from '../../domains/runs/runtimeEnd';
import { nowTimestamp } from '../../lib/timestamps';
import { validateAndLogViolation } from '../../lib/workspaceBoundary';
import {
  localProcessGroupId,
  localProcessIdentity,
  localProcessSpawnOptions,
  localProcessSupervisor,
} from '../localProcessSupervisor';
import {
  buildMcpPreflightRequirements,
  describeMcpPreflightFailure,
  preflightMcpServers,
  resolveRequiredMcpPreflightServerNames,
} from '../claudeCode/mcpPreflight';
import { RuntimeTranscriptWriter } from '../transcript/writer';
import { buildAgentRuntimeEnv, buildRunIdentityEnv } from '../environment';
import { resolveAllowedRuntimeExecutable } from '../executablePolicy';
import { guardLocalRuntimeDispatchContext } from '../dispatchContextGuard';
import { probeAllowedRuntimeCliVersion } from '../runtimeCliVersion';
import { redactSensitiveRuntimeText, sanitizeRuntimeLaunchArguments } from '../sensitiveText';
import {
  cleanupOwnedProcessTree,
  OwnedProcessTreeCleanupError,
} from '../ownedProcessTreeCleanup';
import {
  appendRuntimeCheckpoint,
  heartbeatRuntimeExecution,
  terminalRuntimeExecution,
  upsertRuntimeExecutionStart,
} from '../runtimeExecutionStore';
import type {
  LocalProcessExecutionHandleV1,
  SanitizedRuntimeLaunchSpecV1,
} from '../runtimeBoundary';
import type {
  AgentRuntime,
  DispatchParams,
  PrepareAuthProfilesParams,
  RuntimeAuthProfileSyncResult,
  RuntimeAbortResult,
  RuntimeEndEvent,
} from '../types';
import {
  parseCodexInstanceIdFromRunId,
  waitForCodexChildProcess,
  writeCodexPrompt,
  type ActiveCodexRun,
  type ProcessExitResult,
} from './abort';
import {
  buildCodexArgs,
  normalizeCodexModel,
  normalizeCodexReasoningEffort,
} from './args';
import {
  codexAuthReady,
  prepareCodexAuthProfiles,
  resolveEffectiveCodexHome,
} from './auth';
import { normalizeCodexRuntimeConfig } from './config';
import { classifyCodexRun } from './errors';
import { assertCodexResumeAllowed } from './resume';
import {
  materializeCodexMcpConfig,
  materializeEmptyCodexConfig,
  readCodexMcpSnapshot,
} from './mcpConfig';
import {
  allocateCodexAdHocRuntimeProfile,
  allocateCodexRuntimeProfile,
  removeCodexAdHocRuntimeProfile,
  removeCodexRuntimeProfile,
  scavengeStaleCodexRuntimeProfiles,
  type CodexAdHocRuntimeAllocation,
} from './profile';
import { assertNoCodexAmbientConfigLayers } from './projectConfig';
import { assertRuntimeBoundaryAssignmentsCurrent } from '../../services/runtimeBoundaryAssignments';
import { CodexJsonlDecoder, CodexStreamAccumulator } from './streamJson';
import { codexPromptTranscriptEvent, decodeCodexJsonEvent } from './transcript';
import {
  CODEX_RUN_ID_PREFIX,
  CODEX_RUNTIME_END_MESSAGE_PREFIX,
  CODEX_SESSION_KEY_PREFIX,
  type CodexMcpMaterialization,
  type CodexRuntimeConfig,
  type NormalizedCodexRuntimeConfig,
} from './types';

const MAX_STDERR_BYTES = 128 * 1024;

function safeRuntimeError(error: unknown): string {
  return redactSensitiveRuntimeText(error instanceof Error ? error.message : String(error));
}

function emptyMcp(
  codexHome: string,
  configPath: string,
  snapshotPath: string,
): CodexMcpMaterialization {
  return {
    codexHome,
    configPath,
    snapshotPath,
    serverNames: [],
    requiredServerNames: [],
    servers: {},
    warnings: [],
  };
}

export class CodexRuntime implements AgentRuntime {
  constructor(private readonly baseConfig: CodexRuntimeConfig = {}) {}

  async prepareAuthProfiles(
    params: PrepareAuthProfilesParams,
  ): Promise<RuntimeAuthProfileSyncResult> {
    return prepareCodexAuthProfiles(this.baseConfig, params);
  }

  async dispatch(params: DispatchParams): Promise<{ runId: string }> {
    const config = normalizeCodexRuntimeConfig({
      ...this.baseConfig,
      ...((params.runtimeConfig as CodexRuntimeConfig | undefined) ?? {}),
    });
    const dispatchContext = await guardLocalRuntimeDispatchContext({
      runtimeType: 'codex',
      agentSlug: params.agentSlug,
      db: params.db,
      instanceId: params.instanceId,
      runtimeBoundary: params.runtimeBoundary,
      dispatchMode: params.dispatchMode,
    });
    const versionCheck = await probeAllowedRuntimeCliVersion({
      runtime: 'codex',
      command: config.codexBin,
    });
    if (
      !versionCheck.ok
      || !versionCheck.executablePath
      || !versionCheck.executableFingerprint
    ) {
      throw new Error(`Codex CLI version verification failed: ${versionCheck.message}`);
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
        'Codex CLI executable fingerprint does not match the immutable runtime boundary',
      );
    }
    const instanceId = dispatchContext.instanceId;
    const runId = `${CODEX_RUN_ID_PREFIX}${instanceId ?? Date.now()}`;
    const db = dispatchContext.db;
    if (config.resumeSessionId) {
      await assertCodexResumeAllowed({
        db,
        boundary: params.runtimeBoundary,
        instanceId,
        sessionId: config.resumeSessionId,
      });
    }
    const cwd = params.activeRepoRoot ?? config.workingDirectory ?? params.workspaceRoot ?? null;
    if (!cwd) {
      throw new Error(
        'Codex runtime requires activeRepoRoot, runtime_config.workingDirectory, or workspaceRoot',
      );
    }
    if (params.workspaceRoot && db) {
      await validateAndLogViolation(db, params.workspaceRoot, cwd, {
        instanceId: instanceId ?? undefined,
      });
    }
    assertNoCodexAmbientConfigLayers(cwd);

    const ownership = {
      agentId: dispatchContext.agentId,
      tenantId: dispatchContext.tenantId,
    };
    let adHocAllocation: CodexAdHocRuntimeAllocation | null = null;
    let codexHome: string;
    if (dispatchContext.mode === 'ad-hoc') {
      if (params.providerConnectionId == null) {
        throw new Error(
          'Boundaryless Codex ad-hoc dispatch requires an explicit provider connection; ambient or shared credentials are not allowed',
        );
      }
      if (!config.codexHome || !config.providerConnectionExternalRef) {
        throw new Error(
          'Boundaryless Codex ad-hoc dispatch requires runtime_config.codexHome and providerConnectionExternalRef from the selected provider connection',
        );
      }
      const providerHome = resolveEffectiveCodexHome({
        agentSlug: params.agentSlug,
        config,
        providerConnectionId: params.providerConnectionId,
      });
      const providerAuthPath = path.join(providerHome, 'auth.json');
      if (!codexAuthReady(providerAuthPath)) {
        throw new Error(
          'Boundaryless Codex ad-hoc dispatch could not resolve authenticated auth.json from the explicit provider connection',
        );
      }
      adHocAllocation = allocateCodexAdHocRuntimeProfile({ providerAuthPath });
      codexHome = adHocAllocation.codexHome;
    } else {
      codexHome = resolveEffectiveCodexHome({
        agentSlug: params.agentSlug,
        config,
        providerConnectionId: params.providerConnectionId,
        tenantId: ownership.tenantId,
        agentId: ownership.agentId,
      });
    }
    const userConfigOverrides = {
      model:
        normalizeCodexModel(params.model) !== null
        || normalizeCodexModel(config.model) !== null,
      reasoningEffort:
        normalizeCodexReasoningEffort(params.thinking) !== null
        || config.reasoningEffort !== null,
      // buildCodexArgs always emits either `fast` or the explicit `default` tier.
      serviceTier: true,
    };
    let runtimeProfile: ReturnType<typeof allocateCodexRuntimeProfile>;
    try {
      fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
      fs.chmodSync(codexHome, 0o700);
      assertNoCodexAmbientConfigLayers(cwd, {
        credentialHome: codexHome,
        userConfigOverrides,
      });
      const protectedInstanceIds = await this.lookupActiveCodexInstanceIds(db);
      if (protectedInstanceIds !== null) {
        const scavenged = scavengeStaleCodexRuntimeProfiles(codexHome, { protectedInstanceIds });
        if (scavenged.failures.length > 0) {
          throw new Error(
            `Codex stale runtime profile cleanup failed: ${scavenged.failures.map((failure) => failure.name).join(', ')}`,
          );
        }
      }
      runtimeProfile = adHocAllocation?.profile ?? allocateCodexRuntimeProfile({
        agentSlug: params.agentSlug,
        config,
        credentialHome: codexHome,
        providerConnectionId: params.providerConnectionId,
        tenantId: ownership.tenantId,
        agentId: ownership.agentId,
        instanceId,
      });
    } catch (error) {
      if (adHocAllocation) removeCodexAdHocRuntimeProfile(adHocAllocation);
      throw error;
    }
    let profileRemoved = false;
    const cleanupRuntimeProfile = (strict = false): void => {
      if (profileRemoved) return;
      try {
        if (adHocAllocation) removeCodexAdHocRuntimeProfile(adHocAllocation);
        else removeCodexRuntimeProfile(codexHome, runtimeProfile);
        profileRemoved = true;
      } catch (error) {
        if (strict) throw error;
        console.warn('[CodexRuntime] failed to remove ephemeral runtime profile:', safeRuntimeError(error));
      }
    };

    let mcp: CodexMcpMaterialization;
    try {
      mcp =
        db && ownership.agentId != null && instanceId != null
          ? await materializeCodexMcpConfig({
              db,
              agentId: ownership.agentId,
              instanceId,
              codexHome,
              configPath: runtimeProfile.configPath,
              snapshotPath: runtimeProfile.snapshotPath,
              preserveExistingConfig: false,
              previousServers: readCodexMcpSnapshot(runtimeProfile.snapshotPath),
            })
          : emptyMcp(
              codexHome,
              materializeEmptyCodexConfig(
                codexHome,
                instanceId ?? 0,
                false,
                runtimeProfile.configPath,
              ),
              runtimeProfile.snapshotPath,
            );
      for (const warning of mcp.warnings) console.warn(`[CodexRuntime] ${warning}`);
      await this.preflightRequiredMcpServers(mcp, instanceId, params.runtimeBoundary);
    } catch (error) {
      cleanupRuntimeProfile(dispatchContext.mode === 'ad-hoc');
      throw error;
    }

    if (db && instanceId != null && config.resumeSessionId) {
      await this.persistNativeSessionId(db, instanceId, config.resumeSessionId);
    }

    const argv = buildCodexArgs({
      config,
      model: params.model ?? null,
      reasoningEffort: params.thinking ?? null,
      fastMode: params.fastMode ?? null,
      configProfile: runtimeProfile.name,
    });
    let child: ChildProcessWithoutNullStreams;
    try {
      // Close the materialization/preflight TOCTOU window: an MCP process or a
      // concurrent writer must not add a higher-precedence layer before spawn.
      assertNoCodexAmbientConfigLayers(cwd, {
        credentialHome: codexHome,
        userConfigOverrides,
      });
      if (dispatchContext.mode === 'production') {
        await assertRuntimeBoundaryAssignmentsCurrent({
          db: dispatchContext.db,
          boundary: dispatchContext.boundary,
          materializedMcpServerNames: mcp.serverNames,
        });
      }
      // The zero-spend probe fixes the only path this launch may execute.
      // Re-resolve at the last possible moment so a replaced binary cannot use
      // the earlier supported version result.
      const currentExecutable = resolveAllowedRuntimeExecutable('codex', config.codexBin);
      if (
        currentExecutable.path !== executable.path
        || currentExecutable.fingerprint !== executable.fingerprint
      ) {
        throw new Error('Codex CLI executable changed after version verification');
      }
      child = spawn(executable.path, argv, {
        cwd,
        env: this.buildEnv(params, config, cwd, codexHome),
        stdio: ['pipe', 'pipe', 'pipe'],
        ...localProcessSpawnOptions(),
      });
    } catch (error) {
      cleanupRuntimeProfile(dispatchContext.mode === 'ad-hoc');
      throw error;
    }
    if (dispatchContext.mode === 'production') {
      child.once('error', () => cleanupRuntimeProfile());
      child.once('close', () => cleanupRuntimeProfile());
    }
    const processGroupId = localProcessGroupId(child);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const state: ActiveCodexRun = {
      child,
      killGraceMs: config.killGraceMs,
      exited: false,
      aborted: false,
      timedOut: false,
    };
    const accumulator = new CodexStreamAccumulator();
    const decoder = new CodexJsonlDecoder();
    let stderr = '';
    let persistedThreadId = config.resumeSessionId;
    let threadPersist: Promise<void> = Promise.resolve();
    let threadPersistenceFailure: Error | null = null;
    let executionId: number | null = null;

    const transcript =
      db && instanceId != null && ownership.agentId != null
        ? new RuntimeTranscriptWriter({
            db,
            agentId: ownership.agentId,
            instanceId,
            idPrefix: 'codex',
            sessionKey: config.resumeSessionId
              ? `${CODEX_SESSION_KEY_PREFIX}${config.resumeSessionId}`
              : params.sessionKey,
            durableRunId: params.durableRunId ?? null,
            tenantId: ownership.tenantId,
          })
        : null;
    transcript?.enqueue([codexPromptTranscriptEvent(params.message)]);

    child.stdout.on('data', (chunk: string) => {
      for (const event of decoder.push(chunk)) {
        accumulator.observe(event);
        transcript?.enqueue(decodeCodexJsonEvent(event));
        const threadId = accumulator.threadId;
        if (
          threadId
          && threadId !== persistedThreadId
          && db
          && instanceId != null
          && !threadPersistenceFailure
        ) {
          persistedThreadId = threadId;
          threadPersist = threadPersist
            .then(async () => {
              if (threadPersistenceFailure) throw threadPersistenceFailure;
              await this.persistNativeSessionId(db, instanceId, threadId);
              if (!params.runtimeBoundary) return;
              if (executionId == null) {
                throw new Error('durable runtime execution id is unavailable');
              }
              const heartbeat = await heartbeatRuntimeExecution(db, {
                instanceId,
                tenantId: params.runtimeBoundary.identity.tenantId,
                sessionId: threadId,
              });
              if (heartbeat.status !== 'persisted' || heartbeat.executionId == null) {
                throw new Error(
                  `runtime thread heartbeat was not persisted (status=${heartbeat.status})`,
                );
              }
              const checkpoint = await appendRuntimeCheckpoint(db, {
                executionId,
                kind: 'session',
                state: 'running',
                sessionId: threadId,
                data: { runId },
              });
              if (checkpoint.status !== 'persisted' || checkpoint.checkpointId == null) {
                throw new Error(
                  `runtime thread checkpoint was not persisted (status=${checkpoint.status})`,
                );
              }
            })
            .catch((error: unknown) => {
              if (!threadPersistenceFailure) {
                threadPersistenceFailure = new Error(
                  `Codex thread durability failed: ${safeRuntimeError(error)}`,
                );
              }
              // Attach the rejection handler in the same turn that creates the
              // promise, then stop model/tool work immediately. monitorRun reads
              // the captured failure and persists a truthful failed runtime end.
              localProcessSupervisor.terminate(runId, 'codex');
            });
        }
      }
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += chunk.slice(0, MAX_STDERR_BYTES - stderr.length);
      }
    });

    const { spawned, exited } = waitForCodexChildProcess(child);
    try {
      await spawned;
    } catch (error) {
      if (dispatchContext.mode === 'ad-hoc') cleanupRuntimeProfile(true);
      const message = safeRuntimeError(error);
      throw new Error(`Codex runtime failed to launch: ${message}`);
    }

    let supervisorRegistered = false;
    try {
      localProcessSupervisor.register({
        runId,
        runtimeType: 'codex',
        instanceId,
        state,
        processGroupId,
      });
      supervisorRegistered = true;
      if (db && instanceId != null) {
        await db.run('UPDATE job_instances SET run_id = ? WHERE id = ?', runId, instanceId);
      }
      if (db && params.runtimeBoundary) {
        if (typeof child.pid !== 'number') {
          throw new Error('spawned process did not expose a durable local-process pid');
        }
        const processIdentity = localProcessIdentity(child.pid);
        if (!processIdentity) {
          throw new Error('spawned process did not expose a durable local-process birth identity');
        }
        const startedAt = nowTimestamp();
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
          args: sanitizeRuntimeLaunchArguments(argv),
          cwd,
          // Environment names are auditable; resolved values and credentials
          // are deliberately excluded from the durable execution record.
          envKeys: Object.keys(this.buildEnv(params, config, cwd, codexHome)).sort(),
        };
        const start = await upsertRuntimeExecutionStart(db, {
          boundary: params.runtimeBoundary,
          driver: 'codex',
          backend: 'local-process',
          state: 'running',
          launchSpec,
          handle,
          sessionId: config.resumeSessionId,
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
        executionId = start.executionId;
      }
    } catch (executionStateError) {
      if (supervisorRegistered) localProcessSupervisor.terminate(runId, 'codex');
      localProcessSupervisor.cancelDeferredProcessGroupEscalation(processGroupId);
      const cleanup = await cleanupOwnedProcessTree({
        child,
        processGroupId,
        graceMs: config.killGraceMs,
      });
      if (cleanup.confirmed) {
        localProcessSupervisor.confirmProcessGroupAbsent(processGroupId);
      }
      if (supervisorRegistered) localProcessSupervisor.unregister(runId, child);
      if (cleanup.confirmed && dispatchContext.mode === 'ad-hoc') {
        cleanupRuntimeProfile(true);
      }
      throw new Error(
        `Codex runtime refused to start without durable execution state: ${safeRuntimeError(executionStateError)}`
          + (cleanup.confirmed
            ? ''
            : `; process-tree cleanup was not confirmed: ${cleanup.error ?? 'unknown process-tree state'}`),
      );
    }

    const timeoutTimer = params.timeoutSeconds > 0
      ? setTimeout(() => {
          state.timedOut = true;
          localProcessSupervisor.terminate(runId, 'codex');
        }, params.timeoutSeconds * 1000)
      : null;

    void this.monitorRun({
      params,
      runId,
      db,
      tenantId: ownership.tenantId,
      state,
      exited,
      accumulator,
      decoder,
      transcript,
      mcp,
      resumedThread: Boolean(config.resumeSessionId),
      processGroupId,
      timeoutTimer,
      getStderr: () => stderr,
      waitForThreadPersist: () => threadPersist,
      getThreadPersistenceFailure: () => threadPersistenceFailure,
      cleanupAfterConfirmedExit: dispatchContext.mode === 'ad-hoc'
        ? () => cleanupRuntimeProfile(true)
        : null,
    }).catch((error: unknown) => {
      console.error('[CodexRuntime] unhandled monitor error', safeRuntimeError(error));
    });

    // Codex cannot begin the model turn until stdin closes. Attach terminal
    // supervision and its same-turn rejection handler before this last
    // post-spawn operation, so a synchronous stream failure cannot strand a
    // supervised/durable process without cleanup ownership.
    try {
      writeCodexPrompt(child, params.message);
    } catch (error) {
      localProcessSupervisor.terminate(runId, 'codex');
      throw new Error(`Codex prompt delivery failed: ${safeRuntimeError(error)}`);
    }

    return { runId };
  }

  async abort(runId: string, _sessionKey: string): Promise<RuntimeAbortResult> {
    if (parseCodexInstanceIdFromRunId(runId) == null) {
      return {
        attempted: false,
        ok: false,
        confirmed: false,
        status: 'not_found',
        error: `Invalid Codex run id: ${runId}`,
      };
    }
    const result = localProcessSupervisor.stop(runId, 'codex');
    return {
      attempted: true,
      ok: result.status !== 'not_found',
      confirmed: result.status === 'already_gone',
      status: result.status,
      ...(result.status === 'not_found'
        ? { error: `No supervised Codex process exists for ${runId}` }
        : {}),
    };
  }

  private async preflightRequiredMcpServers(
    mcp: CodexMcpMaterialization,
    instanceId: number | null,
    boundary: DispatchParams['runtimeBoundary'],
  ): Promise<void> {
    const requiredServerNames = resolveRequiredMcpPreflightServerNames(
      mcp.serverNames,
      mcp.requiredServerNames,
      boundary,
    );
    if (requiredServerNames.length === 0) return;
    const requirements = buildMcpPreflightRequirements(requiredServerNames, boundary);
    const results = await preflightMcpServers(mcp.servers, requirements);
    const failure = describeMcpPreflightFailure(results);
    if (failure) {
      throw new Error(`Codex instance #${instanceId ?? '?'}: ${failure}`);
    }
  }

  private async monitorRun(args: {
    params: DispatchParams;
    runId: string;
    db: Db | null;
    tenantId: number | null;
    state: ActiveCodexRun;
    exited: Promise<ProcessExitResult>;
    accumulator: CodexStreamAccumulator;
    decoder: CodexJsonlDecoder;
    transcript: RuntimeTranscriptWriter | null;
    mcp: CodexMcpMaterialization;
    resumedThread: boolean;
    processGroupId: number | null;
    timeoutTimer: ReturnType<typeof setTimeout> | null;
    getStderr: () => string;
    waitForThreadPersist: () => Promise<void>;
    getThreadPersistenceFailure: () => Error | null;
    cleanupAfterConfirmedExit: (() => void) | null;
  }): Promise<void> {
    const { params, runId, db, state, accumulator, decoder, transcript, mcp } = args;
    const instanceId = params.instanceId ?? null;
    let event: RuntimeEndEvent | null = null;
    try {
      const result = await args.exited;
      state.exited = true;
      localProcessSupervisor.unregister(runId, state.child);
      if (args.timeoutTimer) clearTimeout(args.timeoutTimer);
      localProcessSupervisor.cancelDeferredProcessGroupEscalation(args.processGroupId);
      const treeCleanup = await cleanupOwnedProcessTree({
        child: state.child,
        processGroupId: args.processGroupId,
        graceMs: state.killGraceMs,
      });
      if (!treeCleanup.confirmed) {
        throw new OwnedProcessTreeCleanupError(
          `Codex leader exited but descendant cleanup was not confirmed: ${treeCleanup.error ?? 'unknown process-tree state'}`,
        );
      }
      localProcessSupervisor.confirmProcessGroupAbsent(args.processGroupId);
      args.cleanupAfterConfirmedExit?.();
      for (const raw of decoder.flush()) {
        accumulator.observe(raw);
        transcript?.enqueue(decodeCodexJsonEvent(raw));
      }
      await args.waitForThreadPersist();
      const threadPersistenceFailure = args.getThreadPersistenceFailure();
      if (threadPersistenceFailure) throw threadPersistenceFailure;
      const transcriptResult = await transcript?.drain();
      const rawStderr = args.getStderr();
      const classification = classifyCodexRun({
        accumulator,
        exitCode: result.code,
        signal: result.signal,
        spawnError: result.error ?? null,
        timedOut: state.timedOut,
        aborted: state.aborted,
        stderr: rawStderr,
        malformedLineCount: decoder.malformedLines.length,
        timeoutSeconds: params.timeoutSeconds,
      });
      if ((!transcriptResult || transcriptResult.written <= 1) && accumulator.finalText) {
        await this.persistAssistantMessage(db, instanceId, accumulator.finalText);
      }
      await this.persistTokenUsage(db, instanceId, accumulator);

      const success = classification.family === 'none' && !state.aborted;
      event = {
        type: 'runEnded',
        source: 'codex',
        sessionKey: params.sessionKey,
        runId,
        success,
        endedAt: nowTimestamp(),
        reason: state.aborted ? 'aborted' : state.timedOut ? 'timeout' : success ? 'completed' : 'error',
        ...(success ? {} : { error: redactSensitiveRuntimeText(classification.summary) }),
        metadata: {
          exit_code: result.code,
          signal: result.signal,
          stderr: redactSensitiveRuntimeText(rawStderr).trim() || null,
          error_code: classification.code,
          error_family: classification.family,
          codex_thread_id: accumulator.threadId,
          resumed_thread: args.resumedThread,
          json_event_count: accumulator.eventCount,
          malformed_stdout_lines: decoder.malformedLines.length,
          cached_input_tokens: accumulator.usage?.cachedInputTokens ?? null,
          mcp_servers: mcp.serverNames,
          mcp_required_servers: mcp.requiredServerNames,
          mcp_preflight_ok: mcp.requiredServerNames.length > 0 ? true : null,
          mcp_servers_used: accumulator.mcpServersUsed,
          transcript_rows_written: transcriptResult?.written ?? 0,
          transcript_rows_failed: transcriptResult?.failed ?? 0,
          process_group_id: args.processGroupId,
          process_tree_cleanup_confirmed: true,
          process_tree_cleanup_escalated: treeCleanup.escalated,
        },
      };
    } catch (error) {
      if (error instanceof OwnedProcessTreeCleanupError) {
        console.error('[CodexRuntime] process tree quarantined:', safeRuntimeError(error));
        event = null;
      } else {
        event = {
          type: 'runEnded',
          source: 'codex',
          sessionKey: params.sessionKey,
          runId,
          success: false,
          endedAt: nowTimestamp(),
          reason: 'error',
          error: redactSensitiveRuntimeText(error instanceof Error ? error.message : String(error)),
        };
      }
    } finally {
      state.exited = true;
      localProcessSupervisor.unregister(runId, state.child);
      if (args.timeoutTimer) clearTimeout(args.timeoutTimer);
      if (instanceId != null && args.tenantId != null && event) {
        try {
          await this.handleRuntimeEnd(db, instanceId, args.tenantId, event, accumulator);
        } catch (error) {
          // Terminal delivery is deliberately best-effort at this boundary. A
          // durable terminal execution is repaired into job_instances by the
          // runtime reconciler; no persistence failure may reject the detached
          // monitor promise or suppress the caller's terminal callback.
          console.warn(
            `[CodexRuntime] unexpected terminal delivery failure for instance #${instanceId}:`,
            safeRuntimeError(error),
          );
        }
      }
      if (event && params.onRuntimeEnd) {
        try {
          await params.onRuntimeEnd(event);
        } catch (error) {
          console.warn('[CodexRuntime] runtime-end callback failed:', safeRuntimeError(error));
        }
      }
    }
  }

  private async handleRuntimeEnd(
    db: Db | null,
    instanceId: number,
    tenantId: number,
    event: RuntimeEndEvent,
    accumulator: CodexStreamAccumulator,
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
        `[CodexRuntime] failed to persist runtime execution terminal state for instance #${instanceId}:`,
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
        runtimeName: 'Codex',
        runtimeEndSource: event.source,
      });
    } catch (projectionError) {
      // The durable execution above is authoritative. Leaving it terminal while
      // the job projection is active is intentional: the reconciler detects and
      // retries precisely this recoverable half-commit.
      console.warn(
        `[CodexRuntime] failed to project runtime terminal state for instance #${instanceId}:`,
        safeRuntimeError(projectionError),
      );
    }
    try {
      await this.persistRuntimeEndEvent(db, instanceId, event);
    } catch (eventError) {
      console.warn(
        `[CodexRuntime] unexpected runtime-end evidence failure for instance #${instanceId}:`,
        safeRuntimeError(eventError),
      );
    }
  }

  private async persistRuntimeEndEvent(db: Db, instanceId: number, event: RuntimeEndEvent): Promise<void> {
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
        `INSERT INTO chat_messages (id, tenant_id, agent_id, instance_id, role, content, timestamp, event_type, event_meta)
         SELECT ?, tenant_id, agent_id, id, 'system', ?, ?, 'turn_end', ? FROM job_instances WHERE id = ?
         ON CONFLICT(id) DO UPDATE SET content = excluded.content, timestamp = excluded.timestamp,
           event_type = excluded.event_type, event_meta = excluded.event_meta`,
        `${CODEX_RUNTIME_END_MESSAGE_PREFIX}${instanceId}`,
        `Runtime ${event.type} (${meta.terminal_reason})`,
        event.endedAt,
        JSON.stringify(meta),
        instanceId,
      );
      await db.run(
        `UPDATE job_instances
         SET response = jsonb_set((COALESCE(response, '{}'))::jsonb, '{runtimeEnd}', (?)::jsonb)
         WHERE id = ?`,
        JSON.stringify(event),
        instanceId,
      );
    } catch (error) {
      console.warn(`[CodexRuntime] failed to persist runtime end for #${instanceId}:`, safeRuntimeError(error));
    }
  }

  private async persistNativeSessionId(db: Db, instanceId: number, threadId: string): Promise<void> {
    try {
      await db.run(
        'UPDATE job_instances SET session_key = ? WHERE id = ?',
        `${CODEX_SESSION_KEY_PREFIX}${threadId}`,
        instanceId,
      );
    } catch (error) {
      console.warn(`[CodexRuntime] failed to persist thread id for #${instanceId}:`, safeRuntimeError(error));
    }
  }

  private async persistTokenUsage(
    db: Db | null,
    instanceId: number | null,
    accumulator: CodexStreamAccumulator,
  ): Promise<void> {
    const usage = accumulator.usage;
    if (!db || instanceId == null || !usage) return;
    try {
      await db.run(
        'UPDATE job_instances SET token_input = ?, token_output = ?, token_total = ? WHERE id = ?',
        usage.inputTokens,
        usage.outputTokens,
        usage.inputTokens + usage.outputTokens,
        instanceId,
      );
    } catch (error) {
      console.warn(`[CodexRuntime] failed to persist token usage for #${instanceId}:`, safeRuntimeError(error));
    }
  }

  private async persistAssistantMessage(
    db: Db | null,
    instanceId: number | null,
    content: string,
  ): Promise<void> {
    if (!db || instanceId == null || !content.trim()) return;
    try {
      await db.run(
        `INSERT INTO chat_messages (id, tenant_id, agent_id, instance_id, role, content, timestamp, event_type)
         SELECT ?, tenant_id, agent_id, id, 'assistant', ?, ?, 'text' FROM job_instances WHERE id = ?
         ON CONFLICT(id) DO UPDATE SET content = excluded.content, timestamp = excluded.timestamp`,
        `codex-asst-${instanceId}`,
        content,
        nowTimestamp(),
        instanceId,
      );
    } catch (error) {
      console.warn(`[CodexRuntime] failed to persist assistant message for #${instanceId}:`, safeRuntimeError(error));
    }
  }

  private async lookupActiveCodexInstanceIds(db: Db | null): Promise<ReadonlySet<number> | null> {
    if (!db) return null;
    try {
      const rows = await db.all<{ instance_id: number }>(
        `SELECT instance_id FROM runtime_executions
         WHERE driver = 'codex'
           AND state IN ('preparing', 'starting', 'running', 'interrupting')`,
      );
      return new Set(
        rows
          .map((row) => Number(row.instance_id))
          .filter((value) => Number.isSafeInteger(value) && value > 0),
      );
    } catch {
      // Without durable visibility, skip age-based scavenging entirely. A
      // transient read failure must not delete a profile that a long active run
      // still owns after an API restart.
      return null;
    }
  }

  private buildEnv(
    params: DispatchParams,
    config: NormalizedCodexRuntimeConfig,
    cwd: string,
    codexHome: string,
  ): NodeJS.ProcessEnv {
    // Adapter-owned values are last so runtime_config.env cannot escape the
    // managed CODEX_HOME or forge Agent HQ run identity.
    return buildAgentRuntimeEnv({
      agentConfig: config.env,
      injectedSecrets: params.secretEnv,
      runIdentity: buildRunIdentityEnv(params, cwd),
      adapterOwned: { CODEX_HOME: codexHome },
    });
  }
}
