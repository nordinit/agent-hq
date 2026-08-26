import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AgentHqApiClient, AgentHqApiError } from './apiClient';
import { registerCatalogTool } from './catalog';
import { McpToolProfile, selectProfileToolNames } from './toolProfiles';

export type McpToolResult = { content: Array<{ type: 'text'; text: string }> };
export type McpToolHandler = (args: any) => Promise<McpToolResult>;
export type McpResourceRef = { id: string; uri: string };

export interface McpRegistrar {
  registerTool(
    names: string[],
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    handler: McpToolHandler,
    options?: { domain?: string; rest_paths?: string[] },
  ): void;
  registerResource(names: McpResourceRef[], textFactory: () => Promise<string> | string): void;
}

export interface McpDomainContext extends McpRegistrar {
  api: AgentHqApiClient;
  wrap<T>(fn: () => Promise<T>): () => Promise<McpToolResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function formatMcpToolError(err: unknown): Record<string, unknown> {
  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof AgentHqApiError && isRecord(err.body)) {
    const { error: _apiError, message: _apiMessage, ok: _apiOk, data: _apiData, ...details } = err.body;
    return {
      ok: false,
      error: message,
      ...details,
    };
  }

  return { ok: false, error: message };
}

export interface McpRegistrarOptions {
  /** Restricts which tools are exposed. Defaults to every tool. */
  profile?: McpToolProfile | null;
  /**
   * Whether to describe registered tools in the process-wide MCP catalog.
   *
   * The catalog is a single static map served from /api/v1/mcp/catalog, and it documents the
   * whole product rather than one client's view of it. A profile-scoped server therefore stays
   * out of it — otherwise a narrow remote connector would rewrite the catalog for every reader,
   * and the per-request servers behind the HTTP transport would do it on every request.
   */
  catalog?: boolean;
}

export function createMcpRegistrar(server: McpServer, options: McpRegistrarOptions = {}): McpRegistrar {
  const profile = options.profile ?? null;
  const describeInCatalog = options.catalog ?? profile == null;

  return {
    registerTool(names, description, schema, handler, toolOptions) {
      const exposed = profile ? selectProfileToolNames(profile, names) : names;
      if (exposed.length === 0) return;

      for (const name of exposed) {
        server.tool(name, description, schema, handler);
      }
      if (!describeInCatalog) return;
      registerCatalogTool({
        names,
        description,
        schema,
        domain: toolOptions?.domain ?? 'general',
        rest_paths: toolOptions?.rest_paths,
      });
    },
    registerResource(names, textFactory) {
      for (const { id, uri } of names) {
        server.resource(id, uri, async () => ({
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: await textFactory(),
            },
          ],
        }));
      }
    },
  };
}
