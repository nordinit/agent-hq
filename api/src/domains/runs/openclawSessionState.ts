import * as fs from 'fs';
import { backfillOpenClawJsonlTranscript } from './openclawJsonlBackfill';
import { type Db } from "../../db/adapter/types";

export const OPENCLAW_TERMINAL_QUIESCENCE_MS = 3 * 60 * 1000;
export const OPENCLAW_TOOL_USE_TIMEOUT_MS = 3 * 60 * 1000;

export type OpenClawSessionStateKind =
  | 'empty'
  | 'active'
  | 'active_tool_use'
  | 'final_answer'
  | 'stopped'
  | 'prompt_error'
  | 'assistant_error'
  | 'assistant_aborted'
  | 'trajectory_prompt_error'
  | 'trajectory_error'
  | 'trajectory_completed'
  | 'trajectory_aborted'
  | 'trajectory_timeout';

export interface OpenClawPendingToolCall {
  id: string | null;
  name: string | null;
  observedAt: string;
}

export interface OpenClawSessionState {
  sessionFile: string;
  trajectoryFile: string | null;
  kind: OpenClawSessionStateKind;
  lastEventAt: string | null;
  lastAssistantAt: string | null;
  lastAssistantStopReason: string | null;
  lastAssistantProvider: string | null;
  lastAssistantApi: string | null;
  lastAssistantPhases: string[];
  promptErrorAt: string | null;
  promptErrorMessage: string | null;
  trajectoryEndedAt: string | null;
  trajectoryStatus: string | null;
  trajectoryErrorAt: string | null;
  trajectoryErrorMessage: string | null;
  lastToolUseAt: string | null;
  pendingToolCalls: OpenClawPendingToolCall[];
  quietForMs: number | null;
  trajectorySessionId: string | null;
  trajectoryRunId: string | null;
  trajectoryTraceId: string | null;
}

interface OpenClawTrajectoryState {
  trajectoryFile: string;
  lastEventAt: string | null;
  endedAt: string | null;
  status: string | null;
  errorAt: string | null;
  errorMessage: string | null;
  sessionId: string | null;
  runId: string | null;
  traceId: string | null;
}

export interface OpenClawSessionTerminalDecision {
  terminal: boolean;
  success: boolean;
  reason: 'completed' | 'aborted' | 'timeout' | 'error';
  error?: string;
  deferReason?: string;
  retryAfterMs?: number;
  metadata: Record<string, unknown>;
}

export interface OpenClawInstanceSessionStateResult {
  state: OpenClawSessionState | null;
  decision: OpenClawSessionTerminalDecision | null;
  sessionFile: string | null;
  backfillReason: string | null;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeTimestamp(raw: unknown, fallback: Date): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw > 1_000_000_000_000 ? raw : raw * 1000;
    return new Date(ms).toISOString();
  }

  if (typeof raw === 'string' && raw.trim()) {
    const trimmed = raw.trim();
    const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
    const candidates = [normalized, normalized.endsWith('Z') ? normalized : `${normalized}Z`];
    for (const candidate of candidates) {
      const ms = Date.parse(candidate);
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    }
  }

  return fallback.toISOString();
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function maxIso(left: string | null, right: string | null): string | null {
  const leftMs = timestampMs(left);
  const rightMs = timestampMs(right);
  if (leftMs === null) return rightMs === null ? null : right;
  if (rightMs === null) return left;
  return rightMs > leftMs ? right : left;
}

function isAtOrAfter(left: string | null, right: string | null): boolean {
  const leftMs = timestampMs(left);
  const rightMs = timestampMs(right);
  if (leftMs === null || rightMs === null) return false;
  return leftMs >= rightMs;
}

function getRecordTimestamp(parsed: Record<string, unknown>, fallback: Date): string {
  const message = asRecord(parsed.message);
  return normalizeTimestamp(
    parsed.timestamp ?? message?.timestamp ?? parsed.createdAt ?? parsed.updatedAt,
    fallback,
  );
}

function normalizeBlockType(type: unknown): string {
  if (typeof type !== 'string') return '';
  return type
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[_\-\s]+/g, '_')
    .toLowerCase();
}

function extractTextSignaturePhase(block: Record<string, unknown>): string | null {
  const rawSignature = asNonEmptyString(block.textSignature);
  if (!rawSignature) return null;
  const parsed = parseJsonObject(rawSignature);
  return asNonEmptyString(parsed?.phase);
}

function extractAssistantPhases(message: Record<string, unknown>): string[] {
  const phases = new Set<string>();
  const content = message.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      const block = asRecord(item);
      if (!block) continue;
      const phase = extractTextSignaturePhase(block);
      if (phase) phases.add(phase);
    }
  }
  return [...phases].sort();
}

function extractToolCalls(message: Record<string, unknown>, observedAt: string): OpenClawPendingToolCall[] {
  const calls: OpenClawPendingToolCall[] = [];
  const content = message.content;
  if (!Array.isArray(content)) return calls;

  for (const item of content) {
    const block = asRecord(item);
    if (!block) continue;
    const blockType = normalizeBlockType(block.type ?? block.kind);
    if (blockType !== 'tool_call' && blockType !== 'tool_use' && blockType !== 'toolcall') continue;
    calls.push({
      id: asNonEmptyString(block.id),
      name: asNonEmptyString(block.name ?? block.tool_name),
      observedAt,
    });
  }

  return calls;
}

function stringifyErrorValue(value: unknown): string | null {
  if (typeof value === 'string') return asNonEmptyString(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return asNonEmptyString(record.message)
      ?? asNonEmptyString(record.error)
      ?? JSON.stringify(value);
  }
  return null;
}

function extractPromptErrorMessage(parsed: Record<string, unknown>): string | null {
  const data = asRecord(parsed.data);
  const nestedError = asRecord(data?.error ?? parsed.error);
  return stringifyErrorValue(data?.promptError)
    ?? stringifyErrorValue(data?.error)
    ?? stringifyErrorValue(data?.message)
    ?? stringifyErrorValue(parsed.promptError)
    ?? stringifyErrorValue(parsed.error)
    ?? stringifyErrorValue(parsed.message)
    ?? asNonEmptyString(nestedError?.message);
}

function extractTrajectoryPromptErrorMessage(parsed: Record<string, unknown>): string | null {
  const data = asRecord(parsed.data);
  const promptError = stringifyErrorValue(data?.promptError);
  if (promptError) {
    const promptErrorObject = parseJsonObject(promptError);
    const nestedError = asRecord(promptErrorObject?.error);
    return asNonEmptyString(nestedError?.message)
      ?? asNonEmptyString(promptErrorObject?.message)
      ?? promptError;
  }
  return extractPromptErrorMessage(parsed);
}

function resolveTrajectoryFile(sessionFile: string): string | null {
  const ext = pathExtname(sessionFile);
  const withoutExt = ext ? sessionFile.slice(0, -ext.length) : sessionFile;
  const candidates = uniqueStrings([
    `${withoutExt}.trajectory.jsonl`,
    `${sessionFile}.trajectory.jsonl`,
  ]);
  return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
}

function pathExtname(file: string): string {
  const lastSlash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\\\'));
  const lastDot = file.lastIndexOf('.');
  return lastDot > lastSlash ? file.slice(lastDot) : '';
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function evaluateOpenClawTrajectoryFile(trajectoryFile: string, now: Date): OpenClawTrajectoryState {
  const raw = fs.existsSync(trajectoryFile) ? fs.readFileSync(trajectoryFile, 'utf-8') : '';
  let lastEventAt: string | null = null;
  let endedAt: string | null = null;
  let status: string | null = null;
  let errorAt: string | null = null;
  let errorMessage: string | null = null;
  let sessionId: string | null = null;
  let runId: string | null = null;
  let traceId: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseJsonObject(line);
    if (!parsed) continue;

    const timestamp = normalizeTimestamp(parsed.ts ?? parsed.timestamp ?? parsed.createdAt ?? parsed.updatedAt, now);
    lastEventAt = maxIso(lastEventAt, timestamp);
    const data = asRecord(parsed.data);
    const type = asNonEmptyString(parsed.type)?.toLowerCase() ?? '';
    const customType = asNonEmptyString(parsed.customType)?.toLowerCase() ?? '';
    sessionId = asNonEmptyString(parsed.sessionId) ?? sessionId;
    runId = asNonEmptyString(parsed.runId) ?? runId;
    traceId = asNonEmptyString(parsed.traceId) ?? traceId;

    if (type === 'session.ended') {
      endedAt = timestamp;
      status = asNonEmptyString(data?.status ?? parsed.status)?.toLowerCase() ?? null;
      const message = extractTrajectoryPromptErrorMessage(parsed);
      if (status === 'error' || message) {
        errorAt = timestamp;
        errorMessage = message ?? 'OpenClaw trajectory ended with an error';
      }
      continue;
    }

    const isPromptError = customType === 'openclaw:prompt-error'
      || (type.includes('prompt') && type.includes('error'));
    if (isPromptError) {
      errorAt = timestamp;
      errorMessage = extractTrajectoryPromptErrorMessage(parsed) ?? 'OpenClaw trajectory recorded a prompt error';
    }
  }

  return { trajectoryFile, lastEventAt, endedAt, status, errorAt, errorMessage, sessionId, runId, traceId };
}

function stateKindFor(params: {
  lastAssistantStopReason: string | null;
  lastAssistantPhases: string[];
  promptErrorAt: string | null;
  trajectoryErrorAt: string | null;
  lastAssistantAt: string | null;
  pendingToolCalls: OpenClawPendingToolCall[];
  lastEventAt: string | null;
  trajectoryStatus: string | null;
  trajectoryEndedAt: string | null;
  trajectoryErrorMessage: string | null;
}): OpenClawSessionStateKind {
  if (params.trajectoryEndedAt) {
    const status = (params.trajectoryStatus ?? '').toLowerCase();
    if (status === 'completed' || status === 'success' || status === 'ok') return 'trajectory_completed';
    if (status === 'aborted' || status === 'cancelled' || status === 'canceled') return 'trajectory_aborted';
    if (status === 'timeout' || status === 'timed_out') return 'trajectory_timeout';
    if (params.trajectoryErrorMessage) return 'trajectory_prompt_error';
    return 'trajectory_error';
  }

  if (!params.lastEventAt) return 'empty';

  const stopReason = params.lastAssistantStopReason;
  const promptErrorApplies = params.promptErrorAt
    && (!params.lastAssistantAt || isAtOrAfter(params.promptErrorAt, params.lastAssistantAt));
  const trajectoryErrorApplies = params.trajectoryErrorAt
    && (!params.lastAssistantAt || isAtOrAfter(params.trajectoryErrorAt, params.lastAssistantAt));

  if (trajectoryErrorApplies) return 'trajectory_error';

  if (promptErrorApplies && (stopReason === 'aborted' || stopReason === 'error' || !stopReason)) {
    return 'prompt_error';
  }

  if (stopReason === 'aborted') return 'assistant_aborted';
  if (stopReason === 'error') return 'assistant_error';
  if (stopReason === 'stop') {
    return params.lastAssistantPhases.includes('final_answer') ? 'final_answer' : 'stopped';
  }
  if (stopReason === 'tooluse' || stopReason === 'tool_use' || stopReason === 'tool-use') {
    return 'active_tool_use';
  }
  if (params.pendingToolCalls.length > 0) return 'active_tool_use';
  return 'active';
}

function buildTerminalMetadata(state: OpenClawSessionState): Record<string, unknown> {
  return {
    raw_session_state: state.kind,
    raw_session_file: state.sessionFile,
    raw_trajectory_file: state.trajectoryFile,
    raw_last_event_at: state.lastEventAt,
    raw_last_assistant_at: state.lastAssistantAt,
    raw_last_assistant_stop_reason: state.lastAssistantStopReason,
    raw_last_assistant_provider: state.lastAssistantProvider,
    raw_last_assistant_api: state.lastAssistantApi,
    raw_last_assistant_phases: state.lastAssistantPhases,
    raw_prompt_error_at: state.promptErrorAt,
    raw_trajectory_ended_at: state.trajectoryEndedAt,
    raw_trajectory_status: state.trajectoryStatus,
    raw_trajectory_error_at: state.trajectoryErrorAt,
    raw_trajectory_error_message: state.trajectoryErrorMessage,
    raw_quiet_for_ms: state.quietForMs,
    raw_pending_tool_calls: state.pendingToolCalls,
    trajectory_file: state.trajectoryFile,
    trajectory_ended_at: state.trajectoryEndedAt,
    trajectory_status: state.trajectoryStatus,
    trajectory_session_id: state.trajectorySessionId,
    trajectory_run_id: state.trajectoryRunId,
    trajectory_trace_id: state.trajectoryTraceId,
  };
}

export function evaluateOpenClawSessionFile(
  sessionFile: string,
  now = new Date(),
): OpenClawSessionState {
  const raw = fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf-8') : '';
  let lastEventAt: string | null = null;
  let lastAssistantAt: string | null = null;
  let lastAssistantStopReason: string | null = null;
  let lastAssistantProvider: string | null = null;
  let lastAssistantApi: string | null = null;
  let lastAssistantPhases: string[] = [];
  let promptErrorAt: string | null = null;
  let promptErrorMessage: string | null = null;
  let lastToolUseAt: string | null = null;
  let pendingToolCalls: OpenClawPendingToolCall[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseJsonObject(line);
    if (!parsed) continue;

    const timestamp = getRecordTimestamp(parsed, now);
    lastEventAt = maxIso(lastEventAt, timestamp);

    if (parsed.type === 'custom' && parsed.customType === 'openclaw:prompt-error') {
      promptErrorAt = timestamp;
      promptErrorMessage = extractPromptErrorMessage(parsed);
      continue;
    }

    if (parsed.type !== 'message') continue;
    const message = asRecord(parsed.message);
    if (!message || message.role !== 'assistant') continue;

    lastAssistantAt = timestamp;
    const stopReason = asNonEmptyString(message.stopReason)?.toLowerCase() ?? null;
    lastAssistantStopReason = stopReason;
    lastAssistantProvider = asNonEmptyString(message.provider);
    lastAssistantApi = asNonEmptyString(message.api);
    lastAssistantPhases = extractAssistantPhases(message);
    pendingToolCalls = extractToolCalls(message, timestamp);
    if (stopReason === 'tooluse' || stopReason === 'tool_use' || stopReason === 'tool-use' || pendingToolCalls.length > 0) {
      lastToolUseAt = timestamp;
    }
  }

  const trajectoryFile = resolveTrajectoryFile(sessionFile);
  const trajectory = trajectoryFile ? evaluateOpenClawTrajectoryFile(trajectoryFile, now) : null;
  lastEventAt = maxIso(lastEventAt, trajectory?.lastEventAt ?? null);
  if (trajectory?.errorAt) {
    promptErrorAt = maxIso(promptErrorAt, trajectory.errorAt);
    promptErrorMessage = trajectory.errorMessage ?? promptErrorMessage;
  }

  const quietForMs = lastEventAt ? Math.max(0, now.getTime() - (timestampMs(lastEventAt) ?? now.getTime())) : null;
  const kind = stateKindFor({
    lastAssistantStopReason,
    lastAssistantPhases,
    promptErrorAt,
    trajectoryErrorAt: trajectory?.errorAt ?? null,
    lastAssistantAt,
    pendingToolCalls,
    lastEventAt,
    trajectoryStatus: trajectory?.status ?? null,
    trajectoryEndedAt: trajectory?.endedAt ?? null,
    trajectoryErrorMessage: trajectory?.errorMessage ?? null,
  });

  return {
    sessionFile,
    trajectoryFile,
    kind,
    lastEventAt,
    lastAssistantAt,
    lastAssistantStopReason,
    lastAssistantProvider,
    lastAssistantApi,
    lastAssistantPhases,
    promptErrorAt,
    promptErrorMessage,
    trajectoryEndedAt: trajectory?.endedAt ?? null,
    trajectoryStatus: trajectory?.status ?? null,
    trajectoryErrorAt: trajectory?.errorAt ?? null,
    trajectoryErrorMessage: trajectory?.errorMessage ?? null,
    lastToolUseAt,
    pendingToolCalls,
    quietForMs,
    trajectorySessionId: trajectory?.sessionId ?? null,
    trajectoryRunId: trajectory?.runId ?? null,
    trajectoryTraceId: trajectory?.traceId ?? null,
  };
}

export function decideOpenClawSessionTerminal(
  state: OpenClawSessionState,
  options: {
    terminalQuiescenceMs?: number;
    toolUseTimeoutMs?: number;
  } = {},
): OpenClawSessionTerminalDecision {
  const terminalQuiescenceMs = options.terminalQuiescenceMs ?? OPENCLAW_TERMINAL_QUIESCENCE_MS;
  const toolUseTimeoutMs = options.toolUseTimeoutMs ?? OPENCLAW_TOOL_USE_TIMEOUT_MS;
  const quietForMs = state.quietForMs ?? 0;
  const metadata = buildTerminalMetadata(state);

  if (state.kind === 'trajectory_completed') {
    return { terminal: true, success: true, reason: 'completed', metadata };
  }

  if (state.kind === 'trajectory_prompt_error' || state.kind === 'trajectory_error' || state.kind === 'trajectory_aborted' || state.kind === 'trajectory_timeout') {
    const aborted = state.kind === 'trajectory_aborted';
    const timedOut = state.kind === 'trajectory_timeout';
    return {
      terminal: true,
      success: false,
      reason: timedOut ? 'timeout' : aborted ? 'aborted' : 'error',
      error: state.trajectoryErrorMessage ?? state.promptErrorMessage ?? (aborted ? 'OpenClaw session was aborted' : timedOut ? 'OpenClaw session timed out' : 'OpenClaw session failed'),
      metadata: {
        ...metadata,
        trajectory_terminal_authority: true,
      },
    };
  }

  if (state.kind === 'final_answer') {
    return { terminal: true, success: true, reason: 'completed', metadata };
  }

  if (state.kind === 'stopped') {
    if (quietForMs >= terminalQuiescenceMs) {
      return { terminal: true, success: true, reason: 'completed', metadata };
    }
    return {
      terminal: false,
      success: false,
      reason: 'completed',
      deferReason: 'openclaw_stop_waiting_for_quiescence',
      retryAfterMs: terminalQuiescenceMs - quietForMs,
      metadata,
    };
  }

  if (state.kind === 'prompt_error' || state.kind === 'assistant_error' || state.kind === 'assistant_aborted') {
    if (quietForMs >= terminalQuiescenceMs) {
      const aborted = state.kind === 'assistant_aborted';
      return {
        terminal: true,
        success: false,
        reason: aborted ? 'aborted' : 'error',
        error: state.promptErrorMessage ?? (aborted ? 'OpenClaw prompt was aborted' : 'OpenClaw prompt failed'),
        metadata,
      };
    }
    return {
      terminal: false,
      success: false,
      reason: state.kind === 'assistant_aborted' ? 'aborted' : 'error',
      deferReason: 'openclaw_failure_waiting_for_quiescence',
      retryAfterMs: terminalQuiescenceMs - quietForMs,
      metadata,
    };
  }

  if (state.kind === 'active_tool_use') {
    if (quietForMs >= toolUseTimeoutMs) {
      const toolNames = state.pendingToolCalls.map(call => call.name).filter(Boolean).join(', ');
      return {
        terminal: true,
        success: false,
        reason: 'timeout',
        error: toolNames
          ? `OpenClaw tool call timed out waiting for result: ${toolNames}`
          : 'OpenClaw tool call timed out waiting for result',
        metadata,
      };
    }
    return {
      terminal: false,
      success: false,
      reason: 'timeout',
      deferReason: 'openclaw_tool_use_still_active',
      retryAfterMs: toolUseTimeoutMs - quietForMs,
      metadata,
    };
  }

  return {
    terminal: false,
    success: false,
    reason: 'error',
    deferReason: 'openclaw_session_not_terminal',
    retryAfterMs: terminalQuiescenceMs,
    metadata,
  };
}

export async function evaluateOpenClawInstanceSessionState(
  db: Db,
  instanceId: number,
  options: {
    now?: Date;
    openclawHome?: string;
    forceFull?: boolean;
    terminalQuiescenceMs?: number;
    toolUseTimeoutMs?: number;
  } = {},
): Promise<OpenClawInstanceSessionStateResult> {
  const backfill = await backfillOpenClawJsonlTranscript(db, instanceId, {
      now: options.now,
      openclawHome: options.openclawHome,
      forceFull: options.forceFull,
    });

  if (!backfill.sessionFile) {
    if (backfill.reason === 'durable_session_file_not_found') {
      const retryAfterMs = options.terminalQuiescenceMs ?? OPENCLAW_TERMINAL_QUIESCENCE_MS;
      return {
        state: null,
        decision: {
          terminal: false,
          success: false,
          reason: 'completed',
          deferReason: 'openclaw_durable_session_not_indexed',
          retryAfterMs,
          metadata: {
            raw_session_state: null,
            raw_session_file: null,
            raw_backfill_reason: backfill.reason,
          },
        },
        sessionFile: null,
        backfillReason: backfill.reason,
      };
    }

    return {
      state: null,
      decision: null,
      sessionFile: null,
      backfillReason: backfill.reason,
    };
  }

  const state = evaluateOpenClawSessionFile(backfill.sessionFile, options.now ?? new Date());
  const decision = decideOpenClawSessionTerminal(state, {
    terminalQuiescenceMs: options.terminalQuiescenceMs,
    toolUseTimeoutMs: options.toolUseTimeoutMs,
  });

  return {
    state,
    decision,
    sessionFile: backfill.sessionFile,
    backfillReason: backfill.reason,
  };
}
