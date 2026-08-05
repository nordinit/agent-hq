#!/usr/bin/env node
/**
 * bin/agent-tool-mcp.ts — standalone stdio MCP server exposing one agent's
 * registry tools (the `tools` + `agent_tool_assignments` rows).
 *
 * Why this exists: api/src/runtimes/toolInjection.ts serves the same tools via
 * the Claude Agent SDK's `createSdkMcpServer()`, which only works while the
 * agent runs INSIDE that SDK process. The claude-code runtime is moving to the
 * CLI, so the tools have to travel over a real transport. Making it a separate
 * process also (a) lets Codex/Hermes mount the same server from their own
 * mcp-config, and (b) puts execution back in the run's cwd — in-process
 * execution inherited the API server's cwd and blurred the workspace boundary.
 *
 * Mount it from a run-scoped mcp-config.json:
 *   { "command": "node", "args": ["dist/bin/agent-tool-mcp.js", "--agent-id", "42"], "cwd": "<run cwd>" }
 *
 * NOTHING in this file may write to stdout. stdout is the JSON-RPC channel and
 * a stray console.log corrupts the protocol mid-session; every diagnostic goes
 * to console.error (same rule as src/mcp/server.ts).
 *
 * This module deliberately does NOT import '@anthropic-ai/claude-agent-sdk',
 * and does NOT import runtimes/toolInjection — the execution helpers below are
 * copied rather than imported. That import edge would drag the runtime
 * directory (and the SDK) into every process that mounts this server, and
 * several runtime test files replace 'child_process' wholesale
 * (`jest.mock('child_process', () => ({ spawn }))`), which would leave
 * toolInjection's execSync/execFileSync undefined for anything importing it.
 */

import { execFileSync, execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getDb } from '../db/client';
import { type Db } from '../db/adapter/types';
import { sanitizedRuntimeProcessEnv } from '../runtimes/environment';

export const SERVER_NAME = 'agent-hq-agent-tools';
export const SERVER_VERSION = '1.0.0';

const DEFAULT_TOOL_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * MCP tool names reach the model as `mcp__<server>__<tool>`; the Messages API
 * rejects anything outside `[A-Za-z0-9_-]{1,64}`, and a single bad name fails
 * the whole request rather than that one tool. Registry slugs are free text
 * (there is no slug validation on POST /api/v1/tools), so they are normalised
 * before registration. The bound is deliberately below 64 to leave room for the
 * server-name prefix the CLI prepends.
 */
const MAX_MCP_TOOL_NAME_LENGTH = 48;

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Shape returned by fetchAgentTools(). Copied from runtimes/toolInjection.ts
 * rather than imported — see the header note on the import edge.
 */
export interface AgentToolRecord {
  id: number;
  tenant_id: number;
  agent_tenant_id: number;
  assignment_id: number;
  name: string;
  slug: string;
  description: string;
  implementation_type: 'bash' | 'shell' | 'script' | 'mcp' | 'function' | 'http';
  implementation_body: string;
  input_schema: string; // JSON string
  permissions: 'read_only' | 'read_write' | 'exec' | 'network';
  tags: string; // JSON array string
  enabled: number;
  overrides: string; // JSON string
  assignment_enabled: number;
}

/** The MCP result shape every tool call resolves to. */
export interface McpTextResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/**
 * Input schemas are loose objects: declared properties are advertised to the
 * model, but unknown keys pass through untouched. Registry tools receive their
 * whole input as JSON in TOOL_INPUT, and a stored input_schema is frequently an
 * incomplete sketch — a strict object would silently strip arguments the tool
 * actually reads. The SDK server this replaces was permissive the same way
 * (`z.object({}).passthrough()`).
 */
export type AgentToolInputSchema = z.ZodType<Record<string, unknown>>;

export interface AgentToolDefinition {
  /** Sanitised name registered with McpServer. */
  name: string;
  description: string;
  inputSchema: AgentToolInputSchema;
  tool: AgentToolRecord;
}

// ── Small helpers ────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readTimeoutMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_TOOL_TIMEOUT_MS;
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

// ── DB fetch ─────────────────────────────────────────────────────────────────

/**
 * All enabled tools assigned to an agent, tenant-scoped.
 *
 * The `t.tenant_id = a.tenant_id` join condition is the tenant boundary: an
 * assignment row that points at another tenant's tool yields nothing rather
 * than executing it. The follow-up count exists only to make such rows visible
 * in the log instead of vanishing silently.
 */
export async function fetchAgentTools(db: Db, agentId: number): Promise<AgentToolRecord[]> {
  const rows = await db.all(`
    SELECT ata.id as assignment_id, ata.overrides, ata.enabled as assignment_enabled,
           a.tenant_id as agent_tenant_id,
           t.*
    FROM agent_tool_assignments ata
    JOIN agents a ON a.id = ata.agent_id
    JOIN tools t ON t.id = ata.tool_id AND t.tenant_id = a.tenant_id
    WHERE ata.agent_id = ?
      AND ata.enabled = 1
      AND t.enabled = 1
    ORDER BY t.name ASC
  `, agentId) as AgentToolRecord[];

  try {
    const stale = await db.get(`
      SELECT COUNT(*) AS count
      FROM agent_tool_assignments ata
      JOIN agents a ON a.id = ata.agent_id
      JOIN tools t ON t.id = ata.tool_id
      WHERE ata.agent_id = ?
        AND ata.enabled = 1
        AND t.enabled = 1
        AND t.tenant_id <> a.tenant_id
    `, agentId) as { count?: number } | undefined;
    const count = Number(stale?.count ?? 0);
    if (count > 0) {
      console.error(`[agent-tool-mcp] Suppressed ${count} cross-tenant tool assignment(s) for agent #${agentId}`);
    }
  } catch { /* best-effort stale assignment evidence only */ }

  return rows;
}

// ── input_schema → MCP schema ────────────────────────────────────────────────

/**
 * The stored input_schema as a JSON Schema object.
 *
 * Absent, malformed and non-object values all collapse to an empty object
 * schema. A single tool with a broken schema must not take the whole server
 * down: the process serves every OTHER tool the agent was assigned, and this
 * one still runs — just without advertised properties.
 */
export function jsonSchemaFromInputSchema(value: string | null | undefined): Record<string, unknown> {
  const parsed = parseJsonRecord(value);
  return Object.keys(parsed).length > 0 ? parsed : { type: 'object' };
}

function zodForProperty(property: unknown): z.ZodType {
  if (!isRecord(property)) return z.unknown();

  const description = trimmedString(property.description);
  const base = ((): z.ZodType => {
    const enumValues = Array.isArray(property.enum)
      ? property.enum.filter((entry): entry is string => typeof entry === 'string')
      : [];
    if (enumValues.length > 0 && enumValues.length === (property.enum as unknown[]).length) {
      return z.enum(enumValues as [string, ...string[]]);
    }

    switch (property.type) {
      case 'string':
        return z.string();
      case 'number':
        return z.number();
      case 'integer':
        return z.number().int();
      case 'boolean':
        return z.boolean();
      case 'array':
        return z.array(zodForProperty(property.items));
      case 'object':
        return z.record(z.string(), z.unknown());
      default:
        // Unions, $ref, absent type: accept anything rather than guess wrong.
        return z.unknown();
    }
  })();

  return description ? base.describe(description) : base;
}

/**
 * Convert a JSON Schema object into the schema McpServer wants.
 *
 * McpServer accepts a Zod schema or raw shape only — it re-derives the JSON
 * Schema it advertises via `toJsonSchemaCompat`, so handing it the stored JSON
 * Schema directly throws ("inputSchema must be a Zod schema or raw shape").
 * Anything not representable degrades to a permissive member rather than
 * failing registration.
 */
export function zodInputSchema(jsonSchema: Record<string, unknown>): AgentToolInputSchema {
  const properties = isRecord(jsonSchema.properties) ? jsonSchema.properties : {};
  const required = new Set(
    Array.isArray(jsonSchema.required)
      ? jsonSchema.required.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );

  const shape: Record<string, z.ZodType> = {};
  for (const [key, property] of Object.entries(properties)) {
    const member = zodForProperty(property);
    shape[key] = required.has(key) ? member : member.optional();
  }

  return z.looseObject(shape) as unknown as AgentToolInputSchema;
}

// ── Tool definitions ─────────────────────────────────────────────────────────

/**
 * Registry slug → a name the Messages API will accept. Falls back to the tool
 * id when a slug sanitises down to nothing, so an unnamed tool is still
 * reachable instead of being dropped.
 */
export function mcpToolNameFromSlug(slug: string, toolId: number): string {
  const sanitized = slug
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, MAX_MCP_TOOL_NAME_LENGTH);
  return sanitized.length > 0 ? sanitized : `tool_${toolId}`;
}

/**
 * The assignment row's `overrides` JSON is presentation-only here: it may
 * restate the description the model sees, and nothing else. Execution fields
 * are never read from it, because an assignment must not be able to change
 * which command runs on the host — that decision belongs to the tool row a
 * tenant admin curated.
 */
function toolDescription(tool: AgentToolRecord): string {
  const overrides = parseJsonRecord(tool.overrides);
  return trimmedString(overrides.description) ?? tool.description ?? '';
}

/**
 * Build one MCP tool definition per assigned tool.
 *
 * Two names are dropped rather than registered:
 *  - slugs shadowing a CLI built-in (`hardcodedToolSlugs`, matched
 *    case-insensitively) — the built-in wins, as it did under the SDK server;
 *  - a name already claimed by an earlier tool. Sanitisation can map two
 *    distinct slugs onto one name, and McpServer THROWS on duplicate
 *    registration, which would take down every tool instead of one.
 */
export function buildToolDefinitions(
  tools: readonly AgentToolRecord[],
  options: { hardcodedToolSlugs?: ReadonlySet<string> } = {},
): AgentToolDefinition[] {
  const definitions: AgentToolDefinition[] = [];
  const claimedBy = new Map<string, string>();

  for (const tool of tools) {
    if (options.hardcodedToolSlugs?.has(tool.slug.toLowerCase())) {
      console.error(`[agent-tool-mcp] Skipping registry tool "${tool.slug}" — built-in tool takes precedence`);
      continue;
    }

    const name = mcpToolNameFromSlug(tool.slug, tool.id);
    const owner = claimedBy.get(name);
    if (owner !== undefined) {
      console.error(`[agent-tool-mcp] Skipping registry tool "${tool.slug}" — MCP name "${name}" already claimed by "${owner}"`);
      continue;
    }
    claimedBy.set(name, tool.slug);

    definitions.push({
      name,
      // No "Input schema: {...}" suffix: the SDK server appended one because it
      // could only express `passthrough()`. This server advertises the real
      // JSON Schema, so restating it in prose is duplicate context.
      description: toolDescription(tool),
      inputSchema: zodInputSchema(jsonSchemaFromInputSchema(tool.input_schema)),
      tool,
    });
  }

  return definitions;
}

// ── Execution ────────────────────────────────────────────────────────────────

function toolExecutionEnv(input: Record<string, unknown>): NodeJS.ProcessEnv {
  return {
    ...sanitizedRuntimeProcessEnv(),
    TOOL_INPUT: JSON.stringify(input),
    ...Object.fromEntries(
      Object.entries(input).map(([k, v]) => [
        `TOOL_${k.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`,
        typeof v === 'string' ? v : JSON.stringify(v),
      ]),
    ),
  };
}

/**
 * A shell tool's command plus its declared timeout.
 *
 * Two stored forms are in the wild for bash/shell rows: the raw command as
 * plain text, and the capability-tool payload `{command, timeoutMs, ...}` that
 * src/capability-tools/materialize.ts reads (see its `shell` tests). Both are
 * accepted. `cwd` and `env` from that payload are deliberately ignored — the
 * point of running out-of-process is that tools execute in the run's cwd, and
 * honouring a stored cwd would hand that boundary back to the tool row.
 */
function resolveShellCommand(implementationBody: string): { command: string; timeout: number } {
  const body = parseJsonRecord(implementationBody);
  const declared = trimmedString(body.command);
  if (declared) return { command: declared, timeout: readTimeoutMs(body.timeoutMs) };
  return { command: implementationBody, timeout: DEFAULT_TOOL_TIMEOUT_MS };
}

/**
 * Run a tool implementation and return an MCP result.
 *
 * Never throws: a thrown error would cross the JSON-RPC boundary as a protocol
 * error and abort the model's turn, where `isError: true` lets the model read
 * the failure and retry. Stderr is appended because the exit status of a failed
 * shell tool is otherwise unactionable.
 */
export function executeAgentTool(
  tool: AgentToolRecord,
  input: Record<string, unknown>,
  workingDirectory?: string,
): McpTextResult {
  try {
    switch (tool.implementation_type) {
      // 'shell' shares this branch with 'bash'. toolInjection's switch omitted
      // it, so every stored shell tool failed at call time as "unsupported"
      // even though the schema CHECK, the capability materializer and the
      // OpenClaw endpoint all treat shell as a shell command.
      case 'bash':
      case 'shell': {
        const { command, timeout } = resolveShellCommand(tool.implementation_body);
        if (!command) {
          return {
            content: [{ type: 'text', text: 'Error: tool has no implementation body' }],
            isError: true,
          };
        }

        const result = execSync(command, {
          encoding: 'utf-8',
          timeout,
          cwd: workingDirectory || process.cwd(),
          env: toolExecutionEnv(input),
          maxBuffer: MAX_OUTPUT_BYTES,
        });

        return { content: [{ type: 'text', text: result }] };
      }

      case 'script': {
        const body = parseJsonRecord(tool.implementation_body);
        const command = trimmedString(body.command);
        const inline = typeof body.inline === 'string' && body.inline.trim() ? body.inline : undefined;
        const args = Array.isArray(body.args)
          ? body.args.filter((entry): entry is string => typeof entry === 'string')
          : [];
        const timeout = readTimeoutMs(body.timeoutMs);
        const cwd = workingDirectory || process.cwd();
        const env = toolExecutionEnv(input);

        if (command && !inline) {
          const result = execFileSync(command, args, {
            encoding: 'utf-8',
            timeout,
            cwd,
            env,
            maxBuffer: MAX_OUTPUT_BYTES,
          });
          return { content: [{ type: 'text', text: result }] };
        }

        if (!inline) {
          return {
            content: [{ type: 'text', text: 'Error: script tool has no inline body or command' }],
            isError: true,
          };
        }

        const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agent-hq-tool-'));
        const tempFile = path.join(tempDir, 'inline-script');
        try {
          writeFileSync(tempFile, inline, 'utf8');
          const result = execFileSync(command || '/bin/sh', [tempFile, ...args], {
            encoding: 'utf-8',
            timeout,
            cwd,
            env,
            maxBuffer: MAX_OUTPUT_BYTES,
          });
          return { content: [{ type: 'text', text: result }] };
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      }

      case 'function': {
        return {
          content: [{ type: 'text', text: 'Error: function tools are not yet supported at runtime' }],
          isError: true,
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `Error: unsupported implementation type "${tool.implementation_type}"` }],
          isError: true,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: unknown })?.stderr;
    const errorText = stderr ? `${message}\n\nStderr:\n${stderr}` : message;

    return {
      content: [{ type: 'text', text: `Error executing tool "${tool.slug}": ${errorText}` }],
      isError: true,
    };
  }
}

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * The slice of McpServer this module uses. Structural so the registration pass
 * can be exercised without standing up a transport.
 */
export interface ToolRegistrarLike {
  registerTool(
    name: string,
    config: { description?: string; inputSchema?: unknown },
    cb: (args: Record<string, unknown>) => Promise<McpTextResult> | McpTextResult,
  ): unknown;
}

export function registerAgentTools(
  server: ToolRegistrarLike,
  definitions: readonly AgentToolDefinition[],
  workingDirectory?: string,
): void {
  for (const definition of definitions) {
    server.registerTool(
      definition.name,
      { description: definition.description, inputSchema: definition.inputSchema },
      async (args: Record<string, unknown>) => executeAgentTool(definition.tool, isRecord(args) ? args : {}, workingDirectory),
    );
  }
}

// ── Process bootstrap ────────────────────────────────────────────────────────

function readFlag(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const entry = argv[i];
    if (entry === flag) return argv[i + 1];
    if (entry.startsWith(`${flag}=`)) return entry.slice(flag.length + 1);
  }
  return undefined;
}

/** Agent id from `--agent-id <n>` or AGENT_HQ_TOOL_AGENT_ID; null when unusable. */
export function resolveAgentId(argv: readonly string[], env: NodeJS.ProcessEnv): number | null {
  const raw = readFlag(argv, '--agent-id') ?? env.AGENT_HQ_TOOL_AGENT_ID;
  if (raw === undefined) return null;
  const agentId = Number(String(raw).trim());
  return Number.isSafeInteger(agentId) && agentId > 0 ? agentId : null;
}

/**
 * Where tools execute. Defaults to the process cwd, which is the run's cwd
 * because the CLI spawns MCP servers there — the `--cwd` flag exists only for
 * hosts that cannot set a child's working directory.
 */
export function resolveWorkingDirectory(argv: readonly string[], env: NodeJS.ProcessEnv): string {
  return trimmedString(readFlag(argv, '--cwd')) ?? trimmedString(env.AGENT_HQ_TOOL_CWD) ?? process.cwd();
}

/**
 * Slugs the host already exposes as built-ins, comma-separated. The spawning
 * runtime is the only party that knows the CLI's built-in tool set, so it
 * passes it in rather than this process guessing.
 */
export function resolveHardcodedToolSlugs(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    String(env.AGENT_HQ_TOOL_SKIP_SLUGS ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

const USAGE = 'Usage: agent-hq-tool-mcp --agent-id <positive integer> [--cwd <path>]  (or set AGENT_HQ_TOOL_AGENT_ID)';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const agentId = resolveAgentId(argv, process.env);
  if (agentId === null) {
    console.error(`[agent-tool-mcp] A positive agent id is required.\n${USAGE}`);
    process.exit(2);
  }

  const workingDirectory = resolveWorkingDirectory(argv, process.env);
  const tools = await fetchAgentTools(getDb(), agentId);
  const definitions = buildToolDefinitions(tools, { hardcodedToolSlugs: resolveHardcodedToolSlugs(process.env) });

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerAgentTools(server as unknown as ToolRegistrarLike, definitions, workingDirectory);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Serving zero tools is a legitimate state (an agent with no assignments), so
  // it is logged rather than treated as a startup failure — exiting here would
  // surface to the CLI as a dead MCP server.
  console.error(
    `[agent-tool-mcp] agent #${agentId}: serving ${definitions.length} tool(s) from ${workingDirectory}` +
    (definitions.length > 0 ? `: ${definitions.map((definition) => definition.name).join(', ')}` : ''),
  );

  const shutdown = async (signal: string) => {
    console.error(`[agent-tool-mcp] Received ${signal}, shutting down...`);
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[agent-tool-mcp] Fatal error:', err);
    process.exit(1);
  });
}
