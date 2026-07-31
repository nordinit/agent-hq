import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type {
  AgentRuntime,
  DispatchParams,
  PrepareAuthProfilesParams,
  RuntimeAuthProfileSyncResult,
  RuntimeEndEvent,
} from "../types";
import { skippedRuntimeAuthProfileSync } from "../types";
import { applyRuntimeEndToJobInstance } from "../../domains/runs/runtimeEnd";
import { recordRunCheckIn } from "../../domains/runs/observability";
import {
  materializeAgentMcpConfig,
  materializeHermesMcpConfig,
} from "../mcpMaterialization";
import {
  resolveOAuthCredentialForProvider,
  type OpenClawOAuthCredential,
} from "../../lib/openclawOAuthProfiles";
import { detectProviderLimitFailureText } from "../providerLimitFailure";
import {
  ingestHermesTranscriptForRun,
  prependAgentHqRunContext,
} from "../hermesTranscriptIngestion";
import {
  normalizeHermesRuntimeConfig,
  type HermesRuntimeConfig,
  type NormalizedHermesRuntimeConfig,
} from "./config";
import {
  parseHermesInstanceIdFromRunId,
  stopHermesActiveRun,
  waitForHermesChildProcess,
  type ActiveHermesRun,
  type ProcessExitResult,
} from "./abort";
import { nowTimestamp } from '../../lib/timestamps';
import { type Db } from "../../db/adapter/types";

const HERMES_TRANSCRIPT_POLL_INTERVAL_MS = 2_000;

function extractFailureSummary(base: string, details: string): string {
  const trimmed = details.trim();
  if (!trimmed) return base;
  return `${base} — ${trimmed.replace(/\s+/g, " ").slice(0, 240)}`;
}

function toStringEnv(
  values: Record<string, string | null | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function readJsonObject(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function writeJsonObjectAtomic(filePath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function resolveHermesAuthPath(config: NormalizedHermesRuntimeConfig): string {
  return path.join(resolveHermesProfileHome(config), "auth.json");
}

function resolveDefaultHermesRoot(): string {
  return path.join(os.homedir(), ".hermes");
}

/**
 * Profile home for a Hermes config — the directory containing `sessions/`.
 *
 * Exported so the transcript backfill can locate the same session files the
 * runtime ingests from, rather than re-deriving the layout and drifting.
 */
export function resolveHermesProfileHome(config: NormalizedHermesRuntimeConfig): string {
  const explicitHome = config.hermesHome?.trim();
  if (explicitHome) {
    const resolved = path.resolve(explicitHome);
    if (path.basename(resolved) === config.profile && path.basename(path.dirname(resolved)) === "profiles") {
      return resolved;
    }
    return path.join(resolved, "profiles", config.profile);
  }
  return path.join(resolveDefaultHermesRoot(), "profiles", config.profile);
}

function buildHermesCredentialId(credential: OpenClawOAuthCredential): string {
  const basis = credential.accountId ?? credential.email ?? credential.access ?? credential.refresh;
  let hash = 0;
  for (let i = 0; i < basis.length; i += 1) {
    hash = ((hash << 5) - hash + basis.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).slice(0, 6).padStart(6, "0");
}

function upsertHermesOpenAiCodexAuth(filePath: string, credential: OpenClawOAuthCredential): boolean {
  const existing = readJsonObject(filePath);
  const nowIso = new Date().toISOString();
  const providers = existing.providers && typeof existing.providers === "object" && !Array.isArray(existing.providers)
    ? existing.providers as Record<string, unknown>
    : {};
  const credentialPool = existing.credential_pool && typeof existing.credential_pool === "object" && !Array.isArray(existing.credential_pool)
    ? existing.credential_pool as Record<string, unknown>
    : {};

  const tokenPayload = {
    access_token: credential.access,
    refresh_token: credential.refresh,
    ...(credential.accountId ? { account_id: credential.accountId } : {}),
  };

  providers["openai-codex"] = {
    tokens: tokenPayload,
    last_refresh: nowIso,
    auth_mode: "chatgpt",
  };

  credentialPool["openai-codex"] = [
    {
      id: buildHermesCredentialId(credential),
      label: "agent-hq",
      auth_type: "oauth",
      priority: 0,
      source: "agent-hq",
      access_token: credential.access,
      refresh_token: credential.refresh,
      base_url: "https://chatgpt.com/backend-api/codex",
      last_refresh: nowIso,
      request_count: 0,
    },
  ];

  const next = {
    ...existing,
    version: 1,
    providers,
    credential_pool: credentialPool,
    updated_at: nowIso,
    active_provider: "openai-codex",
  };

  const previous = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
  const serialized = JSON.stringify(next, null, 2) + "\n";
  if (previous === serialized) return false;
  writeJsonObjectAtomic(filePath, next);
  return true;
}

function hermesOpenAiCodexAuthReady(filePath: string): boolean {
  const data = readJsonObject(filePath);
  const providers = data.providers && typeof data.providers === "object" && !Array.isArray(data.providers)
    ? data.providers as Record<string, unknown>
    : {};
  const provider = providers["openai-codex"];
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return false;
  const tokens = (provider as Record<string, unknown>).tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return false;
  const access = typeof (tokens as Record<string, unknown>).access_token === "string"
    ? ((tokens as Record<string, unknown>).access_token as string).trim()
    : "";
  const refresh = typeof (tokens as Record<string, unknown>).refresh_token === "string"
    ? ((tokens as Record<string, unknown>).refresh_token as string).trim()
    : "";
  return Boolean(access || refresh);
}

export class HermesRuntime implements AgentRuntime {
  private readonly baseConfig: HermesRuntimeConfig;
  private readonly activeRuns = new Map<number, ActiveHermesRun>();

  constructor(config: HermesRuntimeConfig = {}) {
    this.baseConfig = config;
  }

  async prepareAuthProfiles(params: PrepareAuthProfilesParams): Promise<RuntimeAuthProfileSyncResult> {
    const mergedConfig = normalizeHermesRuntimeConfig({
      ...this.baseConfig,
      ...((params.runtimeConfig as HermesRuntimeConfig | undefined) ?? {}),
    });
    const provider =
      mergedConfig.provider ??
      params.preferredProvider ??
      null;

    if (provider !== "openai-codex") {
      return skippedRuntimeAuthProfileSync("Hermes runtime auth sync is only required for openai-codex provider selection.");
    }

    const authPath = resolveHermesAuthPath(mergedConfig);
    const resolved = await resolveOAuthCredentialForProvider({ provider: "openai-codex" });
    if (!resolved.ok || !resolved.credential) {
      return {
        ok: false,
        status: "failed",
        providersSynced: [],
        runtimeAuthProvidersSynced: [],
        openclawAuthProvidersSynced: [],
        runtimeAuthPath: authPath,
        source: resolved.source,
        refreshed: resolved.refreshed,
        error: resolved.error ?? "No usable openai-codex OAuth credential was found for Hermes runtime auth.",
      };
    }

    upsertHermesOpenAiCodexAuth(authPath, resolved.credential);
    const ready = hermesOpenAiCodexAuthReady(authPath);
    return {
      ok: ready,
      status: ready ? "synced" : "failed",
      providersSynced: ready ? ["openai-codex"] : [],
      runtimeAuthProvidersSynced: ready ? ["openai-codex"] : [],
      openclawAuthProvidersSynced: [],
      runtimeAuthPath: authPath,
      source: resolved.source,
      refreshed: resolved.refreshed,
      details: {
        profile: mergedConfig.profile,
        auth_ready: ready,
        expires_at: resolved.expiresAt ?? null,
      },
      ...(ready ? {} : { error: `Hermes auth file ${authPath} does not contain usable openai-codex token state after sync.` }),
    };
  }

  async dispatch(params: DispatchParams): Promise<{ runId: string }> {
    const mergedConfig = normalizeHermesRuntimeConfig({
      ...this.baseConfig,
      ...((params.runtimeConfig as HermesRuntimeConfig | undefined) ?? {}),
      model:
        params.model ??
        (params.runtimeConfig as HermesRuntimeConfig | undefined)?.model ??
        this.baseConfig.model ??
        null,
      fastMode:
        params.fastMode ??
        (params.runtimeConfig as HermesRuntimeConfig | undefined)?.fastMode ??
        this.baseConfig.fastMode ??
        null,
    });
    const runId = `hermes:${params.instanceId ?? Date.now()}`;
    const cwd =
      params.activeRepoRoot ??
      mergedConfig.workingDirectory ??
      params.workspaceRoot ??
      null;

    if (!cwd) {
      throw new Error(
        "Hermes runtime requires activeRepoRoot, runtime_config.workingDirectory, or workspaceRoot",
      );
    }

    const prompt = params.message;
    const hermesProfileHome = resolveHermesProfileHome(mergedConfig);
    const hermesPrompt =
      params.instanceId != null
        ? prependAgentHqRunContext(prompt, {
            instanceId: params.instanceId,
            durableRunId: params.durableRunId ?? null,
            taskId: params.taskId ?? null,
            sessionKey: params.sessionKey,
          })
        : prompt;
    const transcriptConfig = { ...mergedConfig, hermesHome: hermesProfileHome };

    const db = params.db ?? null;
    const agentId = await this.materializeMcpConfigForRun(db, params.instanceId ?? null, cwd, hermesProfileHome);
    await this.persistUserPrompt(db, params.instanceId ?? null, prompt);

    const command = this.buildCommandArgs(mergedConfig, hermesPrompt);
    const env = {
      ...process.env,
      ...toStringEnv({
        AGENT_HQ_INSTANCE_ID:
          params.instanceId != null ? String(params.instanceId) : "",
        AGENT_HQ_DURABLE_RUN_ID: params.durableRunId ?? "",
        AGENT_HQ_TASK_ID: params.taskId != null ? String(params.taskId) : "",
        AGENT_HQ_SESSION_KEY: params.sessionKey,
        AGENT_HQ_AGENT_SLUG: params.agentSlug,
        AGENT_HQ_WORKSPACE_ROOT: params.workspaceRoot ?? cwd,
        AGENT_HQ_ACTIVE_REPO_ROOT: params.activeRepoRoot ?? cwd,
        AGENT_HQ_FAST_MODE:
          mergedConfig.fastMode == null ? "" : String(mergedConfig.fastMode),
        HERMES_FAST_MODE:
          mergedConfig.fastMode == null ? "" : String(mergedConfig.fastMode),
        HERMES_HOME: hermesProfileHome,
      }),
      ...mergedConfig.env,
    };

    const child = spawn(mergedConfig.hermesBin, command, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const processState: ActiveHermesRun = {
      child,
      killGraceMs: mergedConfig.killGraceMs,
      exited: false,
      aborted: false,
      timedOut: false,
    };

    const { spawned, exited } = waitForHermesChildProcess(child);

    try {
      await spawned;
    } catch (err) {
      const message = `Hermes runtime failed to launch: ${err instanceof Error ? err.message : String(err)}`;

      // Persist a terminal record before rethrowing. This path runs before
      // activeRuns.set and before monitorRun, so previously a launch failure
      // produced NO RuntimeEndEvent at all — no turn_end chat message and no
      // response.runtimeEnd. Those two rows are the only inputs to the
      // watchdog's crash-recovery path, so a Hermes agent whose binary was
      // missing left an instance the watchdog could not reason about.
      if (params.instanceId != null && db) {
        await this.handleRuntimeEnd(db, params.instanceId, {
          type: "runEnded",
          source: "hermes",
          sessionKey: params.sessionKey,
          runId,
          success: false,
          endedAt: nowTimestamp(),
          reason: "error",
          error: message,
          metadata: { spawn_failed: true, hermes_bin: mergedConfig.hermesBin },
        });
      }

      throw new Error(message);
    }

    if (params.instanceId != null) {
      this.activeRuns.set(params.instanceId, processState);
      await db?.run("UPDATE job_instances SET run_id = ? WHERE id = ?", runId, params.instanceId);
      if (db && agentId != null) {
        processState.transcriptPoller = this.startTranscriptPoller({
          db,
          agentId,
          instanceId: params.instanceId,
          durableRunId: params.durableRunId ?? null,
          sessionKey: params.sessionKey,
          config: transcriptConfig,
          state: processState,
        });
      }
    }

    const timeoutTimer =
      params.timeoutSeconds > 0
        ? setTimeout(() => {
            processState.timedOut = true;
            if (!processState.exited) {
              processState.child.kill("SIGTERM");
              setTimeout(() => {
                if (!processState.exited) {
                  processState.child.kill("SIGKILL");
                }
              }, mergedConfig.killGraceMs).unref();
            }
          }, params.timeoutSeconds * 1000)
        : null;

    // Runtime heartbeat.
    //
    // `heartbeatIntervalMs` was validated, normalized and defaulted to 60s, and
    // then never used — this line was literally `null`, so docs/hermes-runtime.md
    // documented a cadence that did not exist. The watchdog decides staleness
    // from instance_artifacts.last_agent_heartbeat_at, which only the AGENT
    // writes via check-ins, so a long run doing quiet work could be judged stale
    // while its process was perfectly healthy. This reports liveness of the
    // process itself, which is the one thing the runtime actually knows.
    //
    // suppressNote keeps it out of the task note stream; it is telemetry, not
    // progress the operator needs to read.
    const heartbeatTimer =
      params.instanceId != null && db && mergedConfig.heartbeatIntervalMs > 0
        ? setInterval(() => {
            if (processState.exited) return;
            void recordRunCheckIn(db, {
              instanceId: params.instanceId as number,
              durableRunId: params.durableRunId ?? null,
              stage: "heartbeat",
              sessionKey: params.sessionKey,
              suppressNote: true,
            }).catch((err: unknown) => {
              // Never let telemetry take down a healthy run.
              console.warn(
                `[HermesRuntime] heartbeat failed for instance #${params.instanceId}:`,
                err instanceof Error ? err.message : String(err),
              );
            });
          }, mergedConfig.heartbeatIntervalMs)
        : null;
    heartbeatTimer?.unref?.();

    void this.monitorRun({
      params,
      config: transcriptConfig,
      runId,
      db,
      state: processState,
      exited,
      getStdout: () => stdout,
      getStderr: () => stderr,
      timeoutTimer,
      heartbeatTimer,
    });

    return { runId };
  }

  async abort(runId: string, _sessionKey: string): Promise<void> {
    const instanceId = parseHermesInstanceIdFromRunId(runId);
    if (instanceId == null) return;

    const active = this.activeRuns.get(instanceId);
    if (!active || active.exited) return;

    stopHermesActiveRun(active);
  }

  private buildCommandArgs(
    config: NormalizedHermesRuntimeConfig,
    prompt: string,
  ): string[] {
    const args: string[] = ["--profile", config.profile];

    if (config.ignoreUserConfig) args.push("--ignore-user-config");
    if (config.ignoreRules) args.push("--ignore-rules");
    if (config.provider) args.push("--provider", config.provider);
    if (config.model) args.push("--model", config.model);
    args.push(...config.extraArgs);

    if (config.invocationMode === "chat-q") {
      args.push("chat", "-q", prompt);
    } else {
      args.push("-z", prompt);
    }

    return args;
  }

  private async monitorRun(args: {
    params: DispatchParams;
    config: NormalizedHermesRuntimeConfig;
    runId: string;
    db: Db | null;
    state: ActiveHermesRun;
    exited: Promise<ProcessExitResult>;
    getStdout: () => string;
    getStderr: () => string;
    timeoutTimer: ReturnType<typeof setTimeout> | null;
    heartbeatTimer: ReturnType<typeof setInterval> | null;
  }): Promise<void> {
    const {
      params,
      runId,
      db,
      state,
      exited,
      getStdout,
      getStderr,
      timeoutTimer,
      heartbeatTimer,
    } = args;

    let runtimeEndEvent: RuntimeEndEvent | null = null;

    try {
      const result = await exited;
      state.exited = true;
      if (params.instanceId != null) this.activeRuns.delete(params.instanceId);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (state.transcriptPoller) clearInterval(state.transcriptPoller);
      await this.ingestTranscriptOnce(db, params.instanceId ?? null, args.config, {
        durableRunId: params.durableRunId ?? null,
        sessionKey: params.sessionKey,
      });

      const stdout = getStdout();
      const stderr = getStderr();
      const transcriptOutput = stdout.trim() || stderr.trim();

      if (state.aborted) {
        if (transcriptOutput && !(await this.hasHermesJsonTranscriptRows(db, params.instanceId ?? null))) {
          await this.persistAssistantMessage(
            db,
            params.instanceId ?? null,
            transcriptOutput,
          );
        }
        runtimeEndEvent = {
          type: "runEnded",
          source: "hermes",
          sessionKey: params.sessionKey,
          runId,
          success: false,
          endedAt: nowTimestamp(),
          reason: "aborted",
          error: stderr.trim() || undefined,
        };
        return;
      }

      if (result.error || state.timedOut || result.code !== 0) {
        if (transcriptOutput && !(await this.hasHermesJsonTranscriptRows(db, params.instanceId ?? null))) {
          await this.persistAssistantMessage(
            db,
            params.instanceId ?? null,
            transcriptOutput,
          );
        }

        const combinedDetails = `${stderr}\n${stdout}`.trim();
        const summary = state.timedOut
          ? `Hermes run timed out after ${params.timeoutSeconds}s`
          : result.error
            ? extractFailureSummary(
                "Hermes runtime error",
                result.error.message,
              )
            : extractFailureSummary(
                `Hermes exited with code ${result.code ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}`,
                combinedDetails,
              );

        runtimeEndEvent = {
          type: "runEnded",
          source: "hermes",
          sessionKey: params.sessionKey,
          runId,
          success: false,
          endedAt: nowTimestamp(),
          reason: state.timedOut ? "timeout" : "error",
          error: summary,
          metadata: {
            exit_code: result.code,
            signal: result.signal,
            stderr: stderr || null,
            fast_mode: args.config.fastMode,
          },
        };
        return;
      }

      if (transcriptOutput && !(await this.hasHermesJsonTranscriptRows(db, params.instanceId ?? null))) {
        await this.persistAssistantMessage(
          db,
          params.instanceId ?? null,
          transcriptOutput,
        );
      }

      const providerLimitFailure = detectProviderLimitFailureText(
        `${stdout}\n${stderr}`,
      );
      if (providerLimitFailure) {
        runtimeEndEvent = {
          type: "runEnded",
          source: "hermes",
          sessionKey: params.sessionKey,
          runId,
          success: false,
          endedAt: nowTimestamp(),
          reason: "error",
          error: `Hermes provider/API limit failure: ${providerLimitFailure}`,
          metadata: {
            exit_code: result.code,
            signal: result.signal,
            stderr: stderr || null,
            fast_mode: args.config.fastMode,
            provider_limit_failure_detected: true,
            hermes_process_success: true,
          },
        };
        return;
      }

      runtimeEndEvent = {
        type: "runEnded",
        source: "hermes",
        sessionKey: params.sessionKey,
        runId,
        success: true,
        endedAt: nowTimestamp(),
        reason: "completed",
        metadata: {
          stderr: stderr || null,
          fast_mode: args.config.fastMode,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runtimeEndEvent = {
        type: "runEnded",
        source: "hermes",
        sessionKey: params.sessionKey,
        runId,
        success: false,
        endedAt: nowTimestamp(),
        reason: "error",
        error: message,
      };
    } finally {
      if (params.instanceId != null && runtimeEndEvent) {
        await this.handleRuntimeEnd(db, params.instanceId, runtimeEndEvent);
      }
      if (runtimeEndEvent) {
        await params.onRuntimeEnd?.(runtimeEndEvent);
      }
    }
  }

  private async handleRuntimeEnd(
    db: Db | null,
    instanceId: number,
    event: RuntimeEndEvent,
  ): Promise<void> {
    if (!db) return;

    await applyRuntimeEndToJobInstance(db, {
      instanceId,
      event,
      runtimeName: "Hermes",
      runtimeEndSource: event.source,
    });
    await this.persistRuntimeEndEvent(db, instanceId, event);
  }


  private async materializeMcpConfigForRun(
    db: Db | null,
    instanceId: number | null,
    cwd: string,
    hermesProfileHome: string,
  ): Promise<number | null> {
    if (!db || instanceId == null) return null;
    const agentId = await this.lookupAgentId(db, instanceId);
    if (agentId == null) return null;

    const targets = Array.from(new Set([cwd, hermesProfileHome].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)));
    for (const workingDirectory of targets) {
      const result = await materializeAgentMcpConfig({ db, agentId, workingDirectory });
      if (!result.ok) {
        console.warn(`[hermes-runtime] MCP materialization failed for ${workingDirectory}: ${result.error ?? 'unknown error'}`);
      }
      for (const warning of result.warnings) console.warn(`[hermes-runtime] ${warning}`);
    }

    const hermesConfig = await materializeHermesMcpConfig({
          db,
          agentId,
          hermesHome: hermesProfileHome,
        });
    if (!hermesConfig.ok) {
      console.warn(`[hermes-runtime] Hermes MCP config materialization failed for ${hermesConfig.path}: ${hermesConfig.error ?? 'unknown error'}`);
    }
    for (const warning of hermesConfig.warnings) console.warn(`[hermes-runtime] ${warning}`);
    return agentId;
  }

  private startTranscriptPoller(args: {
    db: Db;
    agentId: number;
    instanceId: number;
    durableRunId: string | null;
    sessionKey: string;
    config: NormalizedHermesRuntimeConfig;
    state: ActiveHermesRun;
  }): ReturnType<typeof setInterval> {
    // Deliberately fire-and-forget — this is a periodic poller and setInterval cannot
    // await. But ingestTranscriptOnce is async now, which adds two hazards a synchronous
    // poll did not have, so both are handled explicitly rather than left to chance:
    //   - a rejection with nothing attached is an unhandled rejection, which under Node's
    //     default --unhandled-rejections=throw terminates the process
    //   - an ingest slower than the poll interval would overlap the next one, and two
    //     concurrent ingests of the same transcript duplicate rows
    let ingestInFlight = false;
    const poll = () => {
      if (args.state.exited || args.state.aborted || args.state.timedOut) return;
      if (ingestInFlight) return;
      ingestInFlight = true;
      void this.ingestTranscriptOnce(args.db, args.instanceId, args.config, {
        agentId: args.agentId,
        durableRunId: args.durableRunId,
        sessionKey: args.sessionKey,
      })
        .catch((err) => {
          console.warn(`[hermes] transcript poll failed for instance ${args.instanceId}:`, err);
        })
        .finally(() => { ingestInFlight = false; });
    };
    poll();
    const timer = setInterval(poll, HERMES_TRANSCRIPT_POLL_INTERVAL_MS);
    timer.unref?.();
    return timer;
  }

  private async ingestTranscriptOnce(
    db: Db | null,
    instanceId: number | null,
    config: NormalizedHermesRuntimeConfig,
    identity: {
      agentId?: number | null;
      durableRunId?: string | null;
      sessionKey?: string | null;
    },
  ): Promise<void> {
    if (!db || instanceId == null) return;
    const agentId = identity.agentId ?? await this.lookupAgentId(db, instanceId);
    if (agentId == null) return;
    try {
      await ingestHermesTranscriptForRun({
                db,
                agentId,
                instanceId,
                durableRunId: identity.durableRunId ?? null,
                sessionKey: identity.sessionKey ?? '',
                profile: config.profile,
                hermesHome: config.hermesHome ?? null,
              });
    } catch (err) {
      console.warn('[hermes-runtime] Hermes transcript ingest failed:', err instanceof Error ? err.message : String(err));
    }
  }

  private async hasHermesJsonTranscriptRows(
    db: Db | null,
    instanceId: number | null,
  ): Promise<boolean> {
    if (!db || instanceId == null) return false;
    const row = await db.get(`
      SELECT 1 AS found
      FROM chat_messages
      WHERE instance_id = ? AND id LIKE ?
      LIMIT 1
    `, instanceId, `hermes-json-${instanceId}-%`) as { found?: number } | undefined;
    return Boolean(row?.found);
  }

  private async persistUserPrompt(
    db: Db | null,
    instanceId: number | null,
    prompt: string,
  ): Promise<void> {
    if (!db || instanceId == null) return;
    const agentId = await this.lookupAgentId(db, instanceId);
    if (agentId == null) return;

    await db.run(`
      INSERT OR IGNORE INTO chat_messages (id, agent_id, instance_id, role, content, timestamp)
      VALUES (?, ?, ?, 'user', ?, ?)
    `, `hermes-user-${instanceId}`, agentId, instanceId, prompt, nowTimestamp());
  }

  private async persistAssistantMessage(
    db: Db | null,
    instanceId: number | null,
    content: string,
  ): Promise<void> {
    if (!db || instanceId == null || !content) return;
    const agentId = await this.lookupAgentId(db, instanceId);
    if (agentId == null) return;

    await db.run(`
      INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp)
      VALUES (?, ?, ?, 'assistant', ?, ?)
      ON CONFLICT(id) DO UPDATE SET content = excluded.content, timestamp = excluded.timestamp
    `, `hermes-asst-${instanceId}`, agentId, instanceId, content, nowTimestamp());
  }

  private async persistRuntimeEndEvent(
    db: Db | null,
    instanceId: number,
    event: RuntimeEndEvent,
  ): Promise<void> {
    if (!db) return;

    await db.run(`
      INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp, event_type, event_meta)
      SELECT ?, agent_id, id, 'system', ?, ?, 'turn_end', ?
      FROM job_instances
      WHERE id = ?
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        timestamp = excluded.timestamp,
        event_type = excluded.event_type,
        event_meta = excluded.event_meta
    `, `hermes-runtime-end-${instanceId}`, `Runtime ${event.type} (${event.reason ?? (event.success ? "completed" : "error")})`, event.endedAt, JSON.stringify({
              runtime_end_type: event.type,
              terminal_reason:
                event.reason ?? (event.success ? "completed" : "error"),
              session_key: event.sessionKey,
              run_id: event.runId ?? null,
              success: event.success,
              error: event.error ?? null,
              ...(event.metadata ?? {}),
            }), instanceId);

    await db.run(`
      UPDATE job_instances
      SET response = json_set(COALESCE(response, '{}'), '$.runtimeEnd', json(?))
      WHERE id = ?
    `, JSON.stringify(event), instanceId);
  }

  private async lookupAgentId(
    db: Db,
    instanceId: number,
  ): Promise<number | null> {
    const row = await db.get("SELECT agent_id FROM job_instances WHERE id = ?", instanceId) as { agent_id?: number } | undefined;
    return typeof row?.agent_id === "number" ? row.agent_id : null;
  }
}
