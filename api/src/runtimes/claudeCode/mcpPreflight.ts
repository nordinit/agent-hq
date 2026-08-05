/**
 * runtimes/claudeCode/mcpPreflight.ts — verify a materialized MCP server can
 * actually start and serve tools, BEFORE the run is dispatched.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHY THE OBVIOUS APPROACH DOES NOT WORK
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A Claude Code run whose MCP servers failed to start does NOT fail. It exits 0
 * with `terminal_reason: 'completed'` and `subtype: 'success'` (verified, CLI
 * 2.1.220). So an agent that could not reach `agent_hq_post_task_outcome` looks
 * exactly like a healthy run, and Agent HQ would advance the workflow on it.
 *
 * The tempting fix is to read `system/init.mcp_servers[].status` from the
 * stream. That does not work, and the failure mode is the dangerous direction —
 * it fails HEALTHY runs. Measured against the real CLI:
 *
 *   - A fully healthy run emitted ONE `system/init`, with the server stuck at
 *     `status: 'pending'`, and never re-emitted it — while the agent went on to
 *     successfully call `mcp__agent-hq__agent-42__agent_hq_post_task_outcome`.
 *   - A run with a completely bogus server command ALSO reported `'pending'`.
 *
 * `pending` therefore means "unknown", not "broken", and `connected` only ever
 * shows up incidentally (a re-emitted init, e.g. after a background task). MCP
 * tools also do not appear in `init.tools` — they are discovered lazily through
 * ToolSearch — so the tool list is not a signal either.
 *
 * The only trustworthy check is to do the handshake ourselves: start the server
 * exactly as the CLI would, confirm it answers `initialize`, then verify its
 * `tools/list` response contains every lifecycle method required by this run.
 * That is deterministic, and doing it before spawn means a broken or incomplete
 * lifecycle server costs zero model spend instead of a full wasted run.
 */

import { spawn } from 'child_process';

import { buildRuntimeChildEnv } from '../environment';
import { localProcessGroupId, localProcessSpawnOptions } from '../localProcessSupervisor';
import { cleanupOwnedProcessTree } from '../ownedProcessTreeCleanup';
import type { RuntimeBoundaryV1 } from '../runtimeBoundary';
import { redactSensitiveRuntimeText } from '../sensitiveText';
import { REQUIRED_AGENT_HQ_LIFECYCLE_TOOL_NAMES } from './lifecycleTools';
export { REQUIRED_AGENT_HQ_LIFECYCLE_TOOL_NAMES } from './lifecycleTools';

/** JSON-RPC id used for the probe. Arbitrary but fixed, so replies are matchable. */
const INITIALIZE_ID = 1;
const TOOLS_LIST_ID = 2;

/** MCP protocol version to advertise. Servers echo or downgrade it. */
const PROTOCOL_VERSION = '2024-11-05';

export const DEFAULT_MCP_PREFLIGHT_TIMEOUT_MS = 10_000;

/**
 * Minimum lifecycle surface a direct local-runtime dispatch must prove when it
 * does not carry a versioned runtime boundary. Normal dispatcher calls carry
 * the same names in RuntimeBoundaryV1, but failing closed here keeps tests,
 * scripts, and future API call sites from silently degrading to handshake-only.
 */
export interface McpPreflightRequirement {
  serverName: string;
  requiredToolNames: string[];
}

export interface McpPreflightResult {
  serverName: string;
  ok: boolean;
  /** Tool names the server advertised, when it got as far as tools/list. */
  toolNames: string[];
  /** Names this dispatch required the server to expose. */
  requiredToolNames?: string[];
  /** Required names absent from the tools/list response. */
  missingToolNames?: string[];
  error?: string;
  durationMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringArrayEnv(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

function sortedUniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right));
}

function serverSlug(serverName: string): string {
  return serverName.replace(/__agent-\d+$/, '');
}

/**
 * Enforce the immutable MCP assignment boundary before any runtime is spawned.
 *
 * This helper is intentionally pure and adapter-neutral: Codex and future
 * local drivers can use the same set-equality check after they materialize
 * secret-bearing configs. A boundaryless ad-hoc run has no assignments and may
 * therefore materialize no MCP servers.
 */
export function assertExactMcpServerBoundary(
  materializedServerNames: readonly string[],
  boundary: RuntimeBoundaryV1 | null | undefined,
): void {
  const materialized = sortedUniqueStrings(materializedServerNames);
  if (!boundary) {
    if (materialized.length > 0) {
      throw new Error(
        `Boundaryless runtime dispatch may not materialize MCP servers: ${materialized.join(', ')}`,
      );
    }
    return;
  }

  const assigned = sortedUniqueStrings(
    boundary.tools.mcpServers.map((assignment) => assignment.name),
  );
  const assignedSet = new Set(assigned);
  const materializedSet = new Set(materialized);
  const missing = assigned.filter((serverName) => !materializedSet.has(serverName));
  const extra = materialized.filter((serverName) => !assignedSet.has(serverName));
  if (missing.length === 0 && extra.length === 0) return;

  throw new Error(
    'Materialized MCP servers do not exactly match the runtime boundary '
      + `(missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}).`,
  );
}

/**
 * Resolve the complete set of servers that must be preflighted and reject a
 * boundary/materialization mismatch before any model process is started.
 */
export function resolveRequiredMcpPreflightServerNames(
  materializedServerNames: readonly string[],
  materializedRequiredServerNames: readonly string[],
  boundary: RuntimeBoundaryV1 | null | undefined,
): string[] {
  assertExactMcpServerBoundary(materializedServerNames, boundary);
  const available = new Set(sortedUniqueStrings(materializedServerNames));
  const required = new Set(sortedUniqueStrings(materializedRequiredServerNames));

  for (const assignment of boundary?.tools?.mcpServers ?? []) {
    if (assignment.requiredToolNames.length > 0) required.add(assignment.name);
  }

  const lifecycleTools = sortedUniqueStrings(boundary?.tools?.requiredLifecycleTools ?? []);
  if (lifecycleTools.length > 0) {
    const assignedAgentHq = (boundary?.tools?.mcpServers ?? [])
      .filter((assignment) => serverSlug(assignment.name) === 'agent-hq');
    const materializedAgentHq = [...available]
      .filter((serverName) => serverSlug(serverName) === 'agent-hq');
    if (assignedAgentHq.length !== 1 || materializedAgentHq.length !== 1) {
      throw new Error(
        'Runtime boundary requires Agent HQ lifecycle tools, but exactly one assigned and materialized agent-hq MCP server was not present.',
      );
    }
    if (assignedAgentHq[0].name !== materializedAgentHq[0]) {
      throw new Error(
        'Runtime boundary Agent HQ MCP assignment does not match the materialized server.',
      );
    }
    required.add(materializedAgentHq[0]);
  }

  const missing = [...required].filter((serverName) => !available.has(serverName));
  if (missing.length > 0) {
    throw new Error(`Required MCP server(s) were not materialized: ${missing.join(', ')}`);
  }
  return [...required].sort((left, right) => left.localeCompare(right));
}

/**
 * Resolve the secret-free boundary policy into concrete preflight inputs.
 *
 * The materialized server list says what must be reachable; the boundary says
 * which tools each of those servers must actually expose. Agent HQ's lifecycle
 * server gets a conservative fallback when a caller bypasses the dispatcher and
 * therefore has no boundary assignment.
 */
export function buildMcpPreflightRequirements(
  requiredServerNames: readonly string[],
  boundary: RuntimeBoundaryV1 | null | undefined,
): McpPreflightRequirement[] {
  const assignments = new Map(
    (boundary?.tools?.mcpServers ?? []).map((assignment) => [assignment.name, assignment]),
  );
  const lifecycleTools = boundary?.tools?.requiredLifecycleTools ?? [];

  return requiredServerNames.map((serverName) => {
    const assignedTools = assignments.get(serverName)?.requiredToolNames ?? [];
    const requiredToolNames = serverSlug(serverName) === 'agent-hq'
      ? sortedUniqueStrings([
          ...assignedTools,
          ...lifecycleTools,
          ...(assignedTools.length === 0 && lifecycleTools.length === 0
            ? REQUIRED_AGENT_HQ_LIFECYCLE_TOOL_NAMES
            : []),
        ])
      : sortedUniqueStrings(assignedTools);
    return { serverName, requiredToolNames };
  });
}

/**
 * Start one server, complete an `initialize` handshake, and validate its tools.
 *
 * Never throws and never leaves the child running: every exit path goes through
 * `finish()`, which clears the timer and SIGKILLs the probe. A preflight that
 * leaked processes would be worse than no preflight.
 */
export function preflightMcpServer(
  serverName: string,
  serverConfig: Record<string, unknown>,
  timeoutMs: number = DEFAULT_MCP_PREFLIGHT_TIMEOUT_MS,
  requiredToolNamesInput: readonly string[] = [],
): Promise<McpPreflightResult> {
  const startedAt = Date.now();
  const requiredToolNames = sortedUniqueStrings(requiredToolNamesInput);

  return new Promise<McpPreflightResult>((resolve) => {
    const command = typeof serverConfig.command === 'string' ? serverConfig.command : '';
    if (!command) {
      resolve({
        serverName,
        ok: false,
        toolNames: [],
        requiredToolNames,
        missingToolNames: requiredToolNames,
        error: 'server has no command',
        durationMs: 0,
      });
      return;
    }

    const args = Array.isArray(serverConfig.args)
      ? serverConfig.args.filter((arg): arg is string => typeof arg === 'string')
      : [];
    const cwd = typeof serverConfig.cwd === 'string' && serverConfig.cwd ? serverConfig.cwd : undefined;

    let settling = false;
    let child: ReturnType<typeof spawn>;
    let processGroupId: number | null = null;
    let stderr = '';
    let buffer = '';
    let initialized = false;
    let toolNames: string[] = [];

    const finish = (result: Omit<McpPreflightResult, 'serverName' | 'durationMs'>) => {
      if (settling) return;
      settling = true;
      clearTimeout(timer);
      void (async () => {
        const cleanup = child?.pid
          ? await cleanupOwnedProcessTree({
              child,
              processGroupId,
              graceMs: 250,
            })
          : { confirmed: true, escalated: false, scope: 'none' as const };
        const cleanupError = cleanup.confirmed
          ? null
          : cleanup.error ?? 'MCP preflight process-tree teardown was not confirmed.';
        const error = [result.error, cleanupError].filter(Boolean).join('; ');
        const ok = result.ok && cleanup.confirmed;
        resolve({
          serverName,
          durationMs: Date.now() - startedAt,
          requiredToolNames,
          missingToolNames: result.missingToolNames
            ?? (ok ? [] : requiredToolNames),
          ...result,
          ok,
          ...(error ? { error: redactSensitiveRuntimeText(error) } : {}),
        });
      })();
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        toolNames,
        error: initialized
          ? `server did not answer tools/list within ${timeoutMs}ms`
          : `server did not answer initialize within ${timeoutMs}ms`,
      });
    }, timeoutMs);
    timer.unref?.();

    try {
      child = spawn(command, args, {
        cwd,
        env: buildRuntimeChildEnv(readStringArrayEnv(serverConfig.env)),
        stdio: ['pipe', 'pipe', 'pipe'],
        ...localProcessSpawnOptions(),
      });
      processGroupId = localProcessGroupId(child);
    } catch (err) {
      finish({
        ok: false,
        toolNames: [],
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    child.on('error', (err) => {
      finish({ ok: false, toolNames, error: err.message });
    });

    child.on('close', (code) => {
      // Reaching here before a successful handshake means the server died.
      finish({
        ok: false,
        toolNames,
        error: `server exited with code ${code ?? 'null'}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''}`,
      });
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      // Many MCP servers log to stderr on startup; only surfaced on failure.
      if (stderr.length < 4000) stderr += chunk;
    });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) handleLine(line);
        index = buffer.indexOf('\n');
      }
    });

    function handleLine(line: string): void {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return; // non-JSON chatter on stdout is not fatal to the probe
      }
      if (!isRecord(message)) return;

      if (message.id === INITIALIZE_ID && !initialized) {
        if (isRecord(message.error)) {
          finish({ ok: false, toolNames, error: `initialize failed: ${JSON.stringify(message.error)}` });
          return;
        }
        initialized = true;
        // Reachability alone is insufficient. A server can initialize normally
        // while omitting the lifecycle methods this run needs, so tools/list is
        // part of the gate rather than optional discovery metadata.
        write({ jsonrpc: '2.0', method: 'notifications/initialized' });
        write({ jsonrpc: '2.0', id: TOOLS_LIST_ID, method: 'tools/list' });
        return;
      }

      if (message.id === TOOLS_LIST_ID) {
        if (isRecord(message.error)) {
          finish({
            ok: false,
            toolNames,
            missingToolNames: requiredToolNames,
            error: `tools/list failed: ${JSON.stringify(message.error)}`,
          });
          return;
        }
        const result = isRecord(message.result) ? message.result : null;
        const tools = result && Array.isArray(result.tools) ? result.tools : [];
        toolNames = tools
          .filter(isRecord)
          .map((tool) => (typeof tool.name === 'string' ? tool.name : ''))
          .filter((name) => name.length > 0);
        const advertised = new Set(toolNames);
        const missingToolNames = requiredToolNames.filter((name) => !advertised.has(name));
        if (missingToolNames.length > 0) {
          finish({
            ok: false,
            toolNames,
            missingToolNames,
            error: `server did not advertise required tool(s): ${missingToolNames.join(', ')}`,
          });
          return;
        }
        finish({ ok: true, toolNames, missingToolNames: [] });
      }
    }

    function write(payload: unknown): void {
      try {
        child.stdin?.write(`${JSON.stringify(payload)}\n`);
      } catch {
        /* the close/error handlers report this */
      }
    }

    child.stdin?.on('error', () => undefined);
    write({
      jsonrpc: '2.0',
      id: INITIALIZE_ID,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'agent-hq-preflight', version: '1.0.0' },
      },
    });
  });
}

/** Preflight several servers concurrently. Result order follows `requirements`. */
export async function preflightMcpServers(
  servers: Record<string, Record<string, unknown>>,
  requirements: readonly (string | McpPreflightRequirement)[],
  timeoutMs: number = DEFAULT_MCP_PREFLIGHT_TIMEOUT_MS,
): Promise<McpPreflightResult[]> {
  return Promise.all(
    requirements.map((requirement) => {
      const normalized = typeof requirement === 'string'
        ? { serverName: requirement, requiredToolNames: [] }
        : {
            serverName: requirement.serverName,
            requiredToolNames: sortedUniqueStrings(requirement.requiredToolNames),
          };
      const config = servers[normalized.serverName];
      if (!config) {
        return Promise.resolve<McpPreflightResult>({
          serverName: normalized.serverName,
          ok: false,
          toolNames: [],
          requiredToolNames: normalized.requiredToolNames,
          missingToolNames: normalized.requiredToolNames,
          error: 'server was not materialized',
          durationMs: 0,
        });
      }
      return preflightMcpServer(
        normalized.serverName,
        config,
        timeoutMs,
        normalized.requiredToolNames,
      );
    }),
  );
}

/** One-line summary suitable for `runtime_end_error`. */
export function describeMcpPreflightFailure(results: readonly McpPreflightResult[]): string {
  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) return '';
  const detail = failed
    .map((result) => `${result.serverName} (${result.error ?? 'unknown error'})`)
    .join('; ');
  return redactSensitiveRuntimeText(
    'Agent HQ MCP server(s) failed preflight and the agent would have been unable to ' +
      `reach Agent HQ lifecycle tools: ${detail}`,
  );
}
