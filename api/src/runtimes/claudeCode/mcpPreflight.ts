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
 * exactly as the CLI would and confirm it answers `initialize`. That is
 * deterministic, and doing it before spawn means a broken lifecycle server costs
 * zero model spend instead of a full wasted run.
 */

import { spawn } from 'child_process';

/** JSON-RPC id used for the probe. Arbitrary but fixed, so replies are matchable. */
const INITIALIZE_ID = 1;
const TOOLS_LIST_ID = 2;

/** MCP protocol version to advertise. Servers echo or downgrade it. */
const PROTOCOL_VERSION = '2024-11-05';

export const DEFAULT_MCP_PREFLIGHT_TIMEOUT_MS = 10_000;

export interface McpPreflightResult {
  serverName: string;
  ok: boolean;
  /** Tool names the server advertised, when it got as far as tools/list. */
  toolNames: string[];
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

/**
 * Start one server, complete an `initialize` handshake, and ask for its tools.
 *
 * Never throws and never leaves the child running: every exit path goes through
 * `finish()`, which clears the timer and SIGKILLs the probe. A preflight that
 * leaked processes would be worse than no preflight.
 */
export function preflightMcpServer(
  serverName: string,
  serverConfig: Record<string, unknown>,
  timeoutMs: number = DEFAULT_MCP_PREFLIGHT_TIMEOUT_MS,
): Promise<McpPreflightResult> {
  const startedAt = Date.now();

  return new Promise<McpPreflightResult>((resolve) => {
    const command = typeof serverConfig.command === 'string' ? serverConfig.command : '';
    if (!command) {
      resolve({
        serverName,
        ok: false,
        toolNames: [],
        error: 'server has no command',
        durationMs: 0,
      });
      return;
    }

    const args = Array.isArray(serverConfig.args)
      ? serverConfig.args.filter((arg): arg is string => typeof arg === 'string')
      : [];
    const cwd = typeof serverConfig.cwd === 'string' && serverConfig.cwd ? serverConfig.cwd : undefined;

    let settled = false;
    let child: ReturnType<typeof spawn>;
    let stderr = '';
    let buffer = '';
    let initialized = false;
    let toolNames: string[] = [];

    const finish = (result: Omit<McpPreflightResult, 'serverName' | 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve({
        serverName,
        durationMs: Date.now() - startedAt,
        ...result,
      });
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
        env: { ...process.env, ...readStringArrayEnv(serverConfig.env) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
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
        // A server that completes initialize is up. tools/list is a bonus: it
        // tells us what the agent will actually see, but a server that refuses
        // it is still reachable, so it must not flip the verdict.
        write({ jsonrpc: '2.0', method: 'notifications/initialized' });
        write({ jsonrpc: '2.0', id: TOOLS_LIST_ID, method: 'tools/list' });
        return;
      }

      if (message.id === TOOLS_LIST_ID) {
        const result = isRecord(message.result) ? message.result : null;
        const tools = result && Array.isArray(result.tools) ? result.tools : [];
        toolNames = tools
          .filter(isRecord)
          .map((tool) => (typeof tool.name === 'string' ? tool.name : ''))
          .filter((name) => name.length > 0);
        finish({ ok: true, toolNames });
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

/** Preflight several servers concurrently. Order of results follows `serverNames`. */
export async function preflightMcpServers(
  servers: Record<string, Record<string, unknown>>,
  serverNames: readonly string[],
  timeoutMs: number = DEFAULT_MCP_PREFLIGHT_TIMEOUT_MS,
): Promise<McpPreflightResult[]> {
  return Promise.all(
    serverNames.map((name) => {
      const config = servers[name];
      if (!config) {
        return Promise.resolve<McpPreflightResult>({
          serverName: name,
          ok: false,
          toolNames: [],
          error: 'server was not materialized',
          durationMs: 0,
        });
      }
      return preflightMcpServer(name, config, timeoutMs);
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
  return (
    'Agent HQ MCP server(s) failed preflight and the agent would have been unable to ' +
    `reach Agent HQ lifecycle tools: ${detail}`
  );
}
