import type { AgentToolRecord } from '../runtimes/toolInjection';
import type {
  CapabilityToolExecutionDefinition,
  HttpExecutionDefinition,
  MaterializedAssignedCapabilityTool,
  OpenClawMaterializedAssignedTool,
  ScriptExecutionDefinition,
  ShellExecutionDefinition,
} from './types';

export const DEFAULT_MATERIALIZED_TOOL_TIMEOUT_MS = 180_000;

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

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function parseInputSchema(value: string | null | undefined): Record<string, unknown> {
  const parsed = parseJsonRecord(value);
  return Object.keys(parsed).length > 0
    ? parsed
    : { type: 'object', additionalProperties: true };
}

function toStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .filter(([, item]) => typeof item === 'string')
    .map(([key, item]) => [key, String(item)] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function readTimeoutMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function materializedTimeoutMs(value: unknown): number {
  return readTimeoutMs(value) ?? DEFAULT_MATERIALIZED_TOOL_TIMEOUT_MS;
}

function materializeShellExecution(tool: AgentToolRecord): ShellExecutionDefinition {
  const body = parseJsonRecord(tool.implementation_body);
  const command = typeof body.command === 'string' && body.command.trim()
    ? body.command.trim()
    : tool.implementation_body.trim();

  return {
    type: 'shell',
    command,
    cwd: typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : undefined,
    env: toStringMap(body.env),
    timeoutMs: materializedTimeoutMs(body.timeoutMs),
  };
}

function materializeScriptExecution(tool: AgentToolRecord): ScriptExecutionDefinition {
  const body = parseJsonRecord(tool.implementation_body);
  const inline = typeof body.inline === 'string' && body.inline.trim()
    ? body.inline
    : (!body.command && tool.implementation_body.trim() ? tool.implementation_body : undefined);
  const args = Array.isArray(body.args)
    ? body.args.filter((entry): entry is string => typeof entry === 'string')
    : undefined;

  return {
    type: 'script',
    command: typeof body.command === 'string' && body.command.trim() ? body.command.trim() : undefined,
    inline,
    args,
    cwd: typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : undefined,
    env: toStringMap(body.env),
    timeoutMs: materializedTimeoutMs(body.timeoutMs),
  };
}

function materializeHttpExecution(tool: AgentToolRecord): HttpExecutionDefinition {
  const body = parseJsonRecord(tool.implementation_body);
  const fallbackUrl = typeof tool.implementation_body === 'string' ? tool.implementation_body.trim() : '';

  return {
    type: 'http',
    url: typeof body.url === 'string' && body.url.trim() ? body.url.trim() : fallbackUrl,
    method: typeof body.method === 'string' && body.method.trim() ? body.method.trim().toUpperCase() : undefined,
    headers: toStringMap(body.headers),
    body: body.body,
    timeoutMs: materializedTimeoutMs(body.timeoutMs),
  };
}

export function materializeExecutionDefinition(tool: AgentToolRecord): CapabilityToolExecutionDefinition {
  switch (tool.implementation_type) {
    case 'bash':
    case 'shell':
      return materializeShellExecution(tool);
    case 'script':
      return materializeScriptExecution(tool);
    case 'http':
      return materializeHttpExecution(tool);
    default:
      throw new Error(`Unsupported tool implementation_type for capability materialization: ${tool.implementation_type}`);
  }
}

export function materializeAssignedCapabilityTool(tool: AgentToolRecord): MaterializedAssignedCapabilityTool {
  return {
    metadata: {
      assignmentId: tool.assignment_id,
      toolId: tool.id,
      name: tool.name,
      slug: tool.slug,
      description: tool.description,
      permissions: tool.permissions,
      tags: parseStringArray(tool.tags),
    },
    inputSchema: parseInputSchema(tool.input_schema),
    execution: materializeExecutionDefinition(tool),
  };
}

export function materializeAssignedToolForOpenClaw(tool: AgentToolRecord): OpenClawMaterializedAssignedTool {
  const materialized = materializeAssignedCapabilityTool(tool);
  return {
    id: materialized.metadata.toolId,
    tool_id: materialized.metadata.toolId,
    assignment_id: materialized.metadata.assignmentId,
    name: materialized.metadata.name,
    slug: materialized.metadata.slug,
    description: materialized.metadata.description,
    input_schema: materialized.inputSchema,
    tags: materialized.metadata.tags,
    permissions: materialized.metadata.permissions,
    enabled: tool.enabled === 1,
    assignment_enabled: tool.assignment_enabled === 1,
    execution_type: materialized.execution.type,
    execution_payload: materialized.execution,
  };
}
