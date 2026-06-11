import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AgentHqApiClient, AgentHqApiError } from './apiClient';
import { registerCatalogTool } from './catalog';

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

export function createMcpRegistrar(server: McpServer): McpRegistrar {
  return {
    registerTool(names, description, schema, handler, options) {
      for (const name of names) {
        server.tool(name, description, schema, handler);
      }
      registerCatalogTool({
        names,
        description,
        schema,
        domain: options?.domain ?? 'general',
        rest_paths: options?.rest_paths,
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
