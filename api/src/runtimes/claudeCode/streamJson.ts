/**
 * runtimes/claudeCode/streamJson.ts — incremental parser for Claude Code CLI
 * `--output-format stream-json` output.
 *
 * Pure module: no DB, no filesystem, no process handles. Everything here is
 * driven by stdout chunks so it can be unit-tested against captured fixtures.
 *
 * The event shapes below were captured empirically against Claude Code CLI
 * 2.1.220 (see docs/architecture/claude-code-runtime-v2.md, Phase 0). Three
 * observed behaviours drive the design and are easy to get wrong:
 *
 *  1. `system/init` can be emitted MORE THAN ONCE, so the LATEST one wins for
 *     model/tools/mcp status.
 *
 *     But do NOT use `mcp_servers[].status` to decide whether MCP is usable.
 *     Measured against the real CLI: a fully healthy run emitted ONE init with
 *     the server stuck at `'pending'` and never re-emitted it, while the agent
 *     went on to call that server's tools successfully; a run with a completely
 *     bogus server command also reported `'pending'`. The status is a snapshot at
 *     init time, `'pending'` means "unknown", and `'connected'` only appears
 *     incidentally. Readiness is established out-of-band by mcpPreflight.ts.
 *
 *  2. A process can emit MULTIPLE `result` events (background tasks / subagent
 *     continuation) on the same session_id. Terminal state is process exit, not
 *     the first result. The LAST result is authoritative.
 *
 *  3. `modelUsage` on a result event is the CUMULATIVE process-wide ledger,
 *     while the top-level `usage` object is PER-SEGMENT and undercounts badly
 *     (observed 43/1043 vs 620/1576 in the same run). Read `modelUsage`; never
 *     sum across result events and never trust top-level `usage`.
 */

// ── Raw event typing ─────────────────────────────────────────────────────────

/** A decoded stream-json line. Deliberately loose — the CLI adds fields over time. */
export type ClaudeStreamEvent = Record<string, unknown>;

export interface ClaudeMcpServerStatus {
  name: string;
  /** Observed: 'pending' | 'connected'. Treated as an open string set. */
  status: string;
}

export interface ClaudeStreamUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface ClaudeRateLimitInfo {
  status: string | null;
  resetsAt: number | null;
  rateLimitType: string | null;
  overageStatus: string | null;
  overageDisabledReason: string | null;
  isUsingOverage: boolean | null;
}

// ── Small helpers (kept local so this file stays dependency-free) ─────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asOptionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

// ── NDJSON decoder ───────────────────────────────────────────────────────────

/**
 * Line-buffered NDJSON decoder.
 *
 * The CLI writes one JSON object per line, but chunk boundaries land anywhere,
 * so a partial trailing line must be carried across `push()` calls. Lines that
 * fail to parse are surfaced via `malformedLines` rather than thrown — a single
 * bad line must never abort transcript capture for an otherwise healthy run.
 */
export class NdjsonDecoder {
  private buffer = '';
  private readonly malformed: string[] = [];

  push(chunk: string): ClaudeStreamEvent[] {
    this.buffer += chunk;
    const events: ClaudeStreamEvent[] = [];

    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        const decoded = this.decodeLine(line);
        if (decoded) events.push(decoded);
      }
      newlineIndex = this.buffer.indexOf('\n');
    }

    return events;
  }

  /** Drain any trailing line the process emitted without a final newline. */
  flush(): ClaudeStreamEvent[] {
    const line = this.buffer.trim();
    this.buffer = '';
    if (line.length === 0) return [];
    const decoded = this.decodeLine(line);
    return decoded ? [decoded] : [];
  }

  get malformedLines(): readonly string[] {
    return this.malformed;
  }

  private decodeLine(line: string): ClaudeStreamEvent | null {
    try {
      const parsed: unknown = JSON.parse(line);
      return isRecord(parsed) ? parsed : null;
    } catch {
      // Cap retained malformed lines so a runtime that spews non-JSON on stdout
      // (a wrapper script, a shell banner) cannot grow this unbounded.
      if (this.malformed.length < 20) this.malformed.push(line.slice(0, 500));
      return null;
    }
  }
}

// ── Accumulator ──────────────────────────────────────────────────────────────

/**
 * Folds a stream of events into the state the runtime needs at terminal time.
 *
 * `observe()` is called for every decoded event as it arrives, so the runtime
 * can also react mid-run (MCP readiness gate, live transcript writes) rather
 * than waiting for process exit.
 */
export class ClaudeStreamAccumulator {
  private sessionIdValue: string | null = null;
  private modelValue: string | null = null;
  private cliVersionValue: string | null = null;
  private permissionModeValue: string | null = null;
  private initCountValue = 0;
  private latestMcpServers: ClaudeMcpServerStatus[] = [];
  private availableToolsValue: string[] = [];
  private lastResultValue: ClaudeStreamEvent | null = null;
  private resultCountValue = 0;
  private turnsValue = 0;
  private latestRateLimit: ClaudeRateLimitInfo | null = null;
  private readonly assistantTextChunks: string[] = [];
  private readonly mcpToolCallNameSet = new Set<string>();

  observe(event: ClaudeStreamEvent): void {
    const sessionId = asOptionalString(event.session_id);
    if (sessionId && !this.sessionIdValue) this.sessionIdValue = sessionId;

    const type = asString(event.type);

    if (type === 'system' && asString(event.subtype) === 'init') {
      this.observeInit(event);
      return;
    }

    if (type === 'assistant') {
      this.observeAssistant(event);
      return;
    }

    if (type === 'rate_limit_event') {
      this.observeRateLimit(event);
      return;
    }

    if (type === 'result') {
      // Last result wins — see header note 2.
      this.lastResultValue = event;
      this.resultCountValue += 1;
      this.turnsValue += asNumber(event.num_turns, 0);
    }
  }

  private observeInit(event: ClaudeStreamEvent): void {
    this.initCountValue += 1;
    this.modelValue = asOptionalString(event.model) ?? this.modelValue;
    this.cliVersionValue = asOptionalString(event.claude_code_version) ?? this.cliVersionValue;
    this.permissionModeValue = asOptionalString(event.permissionMode) ?? this.permissionModeValue;

    if (Array.isArray(event.tools)) {
      this.availableToolsValue = event.tools.filter(
        (tool): tool is string => typeof tool === 'string',
      );
    }

    // Latest init wins — see header note 1.
    if (Array.isArray(event.mcp_servers)) {
      this.latestMcpServers = event.mcp_servers
        .filter(isRecord)
        .map((server) => ({
          name: asString(server.name),
          status: asString(server.status),
        }))
        .filter((server) => server.name.length > 0);
    }
  }

  private observeAssistant(event: ClaudeStreamEvent): void {
    const message = isRecord(event.message) ? event.message : null;
    if (!message || !Array.isArray(message.content)) return;

    for (const block of message.content) {
      if (!isRecord(block)) continue;
      const blockType = asString(block.type);

      if (blockType === 'text') {
        const text = asString(block.text);
        if (text.length > 0) this.assistantTextChunks.push(text);
        continue;
      }

      if (blockType === 'tool_use') {
        // A tool call namespaced `mcp__<server>__<tool>` is POSITIVE proof that
        // the server connected — unlike init.mcp_servers[].status, which sits at
        // 'pending' on healthy runs. Absence proves nothing (the agent may not
        // have needed the server), so this is observability, never a gate.
        const name = asString(block.name);
        if (name.startsWith('mcp__')) this.mcpToolCallNameSet.add(name);
      }
    }
  }

  private observeRateLimit(event: ClaudeStreamEvent): void {
    const info = isRecord(event.rate_limit_info) ? event.rate_limit_info : null;
    if (!info) return;
    this.latestRateLimit = {
      status: asOptionalString(info.status),
      resetsAt: asOptionalNumber(info.resetsAt),
      rateLimitType: asOptionalString(info.rateLimitType),
      overageStatus: asOptionalString(info.overageStatus),
      overageDisabledReason: asOptionalString(info.overageDisabledReason),
      isUsingOverage: asOptionalBoolean(info.isUsingOverage),
    };
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  get sessionId(): string | null {
    return this.sessionIdValue;
  }

  get model(): string | null {
    return this.modelValue;
  }

  get cliVersion(): string | null {
    return this.cliVersionValue;
  }

  get permissionMode(): string | null {
    return this.permissionModeValue;
  }

  /** How many `system/init` events have been seen. >1 means MCP status settled. */
  get initCount(): number {
    return this.initCountValue;
  }

  /** MCP server statuses from the most recent init event. */
  get mcpServers(): readonly ClaudeMcpServerStatus[] {
    return this.latestMcpServers;
  }

  /** Built-in tool names advertised by the most recent init event. */
  get availableTools(): readonly string[] {
    return this.availableToolsValue;
  }

  get resultCount(): number {
    return this.resultCountValue;
  }

  /** Summed `num_turns` across every result segment. */
  get totalTurns(): number {
    return this.turnsValue;
  }

  get rateLimit(): ClaudeRateLimitInfo | null {
    return this.latestRateLimit;
  }

  get sawResult(): boolean {
    return this.lastResultValue !== null;
  }

  /** `terminal_reason` from the last result — e.g. 'completed', 'max_turns'. */
  get terminalReason(): string | null {
    return this.lastResultValue ? asOptionalString(this.lastResultValue.terminal_reason) : null;
  }

  /** `subtype` from the last result — e.g. 'success', 'error_max_turns'. */
  get resultSubtype(): string | null {
    return this.lastResultValue ? asOptionalString(this.lastResultValue.subtype) : null;
  }

  get isError(): boolean {
    return this.lastResultValue ? this.lastResultValue.is_error === true : false;
  }

  get apiErrorStatus(): string | null {
    return this.lastResultValue ? asOptionalString(this.lastResultValue.api_error_status) : null;
  }

  /** Error strings the CLI attached to the last result. */
  get errors(): string[] {
    if (!this.lastResultValue || !Array.isArray(this.lastResultValue.errors)) return [];
    return this.lastResultValue.errors
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (isRecord(entry)) {
          return asString(entry.message) || asString(entry.error) || asString(entry.code);
        }
        return '';
      })
      .filter((entry) => entry.length > 0);
  }

  /**
   * Cumulative token usage for the whole process, summed across the per-model
   * ledger on the last result event.
   *
   * Cache-creation tokens are billed prompt tokens, so they count as input.
   * Returns null when no result event carried a usable ledger.
   */
  get usage(): ClaudeStreamUsage | null {
    const ledger = this.lastResultValue?.modelUsage;
    if (!isRecord(ledger)) return null;

    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let sawEntry = false;

    for (const entry of Object.values(ledger)) {
      if (!isRecord(entry)) continue;
      sawEntry = true;
      inputTokens += asNumber(entry.inputTokens) + asNumber(entry.cacheCreationInputTokens);
      outputTokens += asNumber(entry.outputTokens);
      cachedInputTokens += asNumber(entry.cacheReadInputTokens);
    }

    return sawEntry ? { inputTokens, outputTokens, cachedInputTokens } : null;
  }

  /** Cumulative USD cost from the last result event. */
  get costUsd(): number | null {
    if (!this.lastResultValue) return null;

    const topLevel = asOptionalNumber(this.lastResultValue.total_cost_usd);
    if (topLevel !== null) return topLevel;

    // Fall back to the per-model ledger if the top-level field is ever absent.
    const ledger = this.lastResultValue.modelUsage;
    if (!isRecord(ledger)) return null;
    let cost = 0;
    let sawEntry = false;
    for (const entry of Object.values(ledger)) {
      if (!isRecord(entry)) continue;
      const entryCost = asOptionalNumber(entry.costUSD);
      if (entryCost === null) continue;
      cost += entryCost;
      sawEntry = true;
    }
    return sawEntry ? cost : null;
  }

  /** Per-model breakdown, for run metadata. */
  get modelUsage(): Record<string, unknown> | null {
    const ledger = this.lastResultValue?.modelUsage;
    return isRecord(ledger) ? ledger : null;
  }

  /**
   * The agent's final text. Prefers the last result's `result` field and falls
   * back to concatenated assistant text blocks when the run died before one.
   */
  get finalText(): string {
    const fromResult = this.lastResultValue ? asString(this.lastResultValue.result).trim() : '';
    if (fromResult.length > 0) return fromResult;
    return this.assistantTextChunks.join('\n\n').trim();
  }

  /**
   * Fully-qualified `mcp__<server>__<tool>` names the agent actually invoked.
   *
   * Positive confirmation that those servers connected. Recorded for run
   * metadata; it must not be used as a readiness gate, because an agent that
   * never needed a server produces an empty set on a perfectly healthy run.
   */
  get mcpToolCallNames(): string[] {
    return [...this.mcpToolCallNameSet];
  }

  /** True when the agent successfully invoked at least one tool from `serverName`. */
  confirmedMcpServer(serverName: string): boolean {
    const prefix = `mcp__${serverName}__`;
    for (const name of this.mcpToolCallNameSet) {
      if (name.startsWith(prefix)) return true;
    }
    return false;
  }

  get lastResult(): ClaudeStreamEvent | null {
    return this.lastResultValue;
  }
}

// ── Batch convenience ────────────────────────────────────────────────────────

/**
 * Parse a complete stdout buffer in one pass.
 *
 * Used by tests and by any backfill path that has the whole transcript already;
 * the live runtime uses NdjsonDecoder + ClaudeStreamAccumulator directly.
 */
export function parseClaudeStreamJson(stdout: string): ClaudeStreamAccumulator {
  const decoder = new NdjsonDecoder();
  const accumulator = new ClaudeStreamAccumulator();
  for (const event of decoder.push(stdout)) accumulator.observe(event);
  for (const event of decoder.flush()) accumulator.observe(event);
  return accumulator;
}

// ── MCP readiness ────────────────────────────────────────────────────────────

/** Status string the CLI reports once an MCP server has completed its handshake. */
export const MCP_STATUS_CONNECTED = 'connected';
/** Status string the CLI reports before the handshake has resolved. */
export const MCP_STATUS_PENDING = 'pending';

export interface McpReadinessVerdict {
  /** True when every required server reached `connected`. */
  ready: boolean;
  /** Required servers that are present but not yet connected. */
  pending: ClaudeMcpServerStatus[];
  /** Required servers the CLI never mentioned at all. */
  missing: string[];
  /** Required servers that settled on a status other than connected/pending. */
  failed: ClaudeMcpServerStatus[];
}

/**
 * Evaluate whether the servers Agent HQ materialized actually came up.
 *
 * This exists because a Claude Code run whose MCP servers failed to start still
 * exits 0 with `terminal_reason: 'completed'` — the failure is completely silent
 * (verified against CLI 2.1.220). Without this gate an agent that cannot reach
 * `agent_hq_post_task_outcome` looks like a successful run.
 */
export function evaluateMcpReadiness(
  observed: readonly ClaudeMcpServerStatus[],
  requiredServerNames: readonly string[],
): McpReadinessVerdict {
  const byName = new Map(observed.map((server) => [server.name, server]));
  const pending: ClaudeMcpServerStatus[] = [];
  const missing: string[] = [];
  const failed: ClaudeMcpServerStatus[] = [];

  for (const name of requiredServerNames) {
    const server = byName.get(name);
    if (!server) {
      missing.push(name);
    } else if (server.status === MCP_STATUS_CONNECTED) {
      // healthy
    } else if (server.status === MCP_STATUS_PENDING) {
      pending.push(server);
    } else {
      failed.push(server);
    }
  }

  return {
    ready: pending.length === 0 && missing.length === 0 && failed.length === 0,
    pending,
    missing,
    failed,
  };
}

/**
 * Fully-qualified name the CLI gives a tool exposed by a materialized MCP
 * server: `mcp__<serverName>__<toolName>`.
 */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}
