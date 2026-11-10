#!/usr/bin/env node
import {executionBrokerClient} from '../domains/execution/brokerClient';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export const SERVER_NAME = 'agent-hq-agent-tools';
export const SERVER_VERSION = '1.0.0';

/** Standalone stdio bridge: discovery and execution use an authenticated broker.
 * This process has no database client or local code executor. stdout is JSON-RPC only. */
const MAX_MCP_TOOL_NAME_LENGTH = 48;

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Registry metadata shape retained for schema/name normalization. The live bridge
 * receives only broker discovery metadata and never loads executable bodies.
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

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
 * Compatibility parser for older launch configurations. Tool working directories
 * are now selected by the published broker definition; this flag grants no authority.
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

  const broker=executionBrokerClient();
  const payload=await broker('GET','/agent-tools');
  if(Number(payload.agent_id)!==agentId)throw new Error('Execution broker identity does not match this run.');
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for(const definition of buildToolDefinitions(payload.tools??[],{hardcodedToolSlugs:resolveHardcodedToolSlugs(process.env)})) {
    const tool=definition.tool as AgentToolRecord & {revision_id:number};
    server.registerTool(definition.name,{description:definition.description,inputSchema:definition.inputSchema},async(input:Record<string,unknown>)=>{
      try{return await broker('POST','/invoke',{tool_id:tool.id,revision_id:tool.revision_id,input});}
      catch{return {isError:true,content:[{type:'text' as const,text:'Execution broker refused the invocation.'}]};}
    });
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[agent-tool-mcp] Serving approved tools through the execution broker.');

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
