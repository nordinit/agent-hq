import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AgentHqApiClient, AgentHqApiError } from './apiClient';
import { registerCatalogTool } from './catalog';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getToolPermissionRequirement } from './toolPermissions';

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
  getCatalog?: () => Promise<unknown>;
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
  catalog?: boolean;
  authorizeTool: (name: string) => Promise<void>;
  authenticateResource: () => Promise<void>;
}

export function createMcpRegistrar(server: McpServer, options: McpRegistrarOptions): McpRegistrar & { tools: Tool[] } {
  const tools: Tool[] = [];

  return {
    tools,
    registerTool(names, description, schema, handler, toolOptions) {
      for (const name of names) {
        getToolPermissionRequirement(name); // Missing metadata fails registration, including for admins.
        tools.push({ name, description, inputSchema: z.toJSONSchema(z.object(schema), { io: 'input' }) as Tool['inputSchema'] });
        server.tool(name, description, schema, async (args) => {
          try { await options.authorizeTool(name); } catch (error) {
            return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(formatMcpToolError(error)) }] };
          }
          return handler(args);
        });
      }
      if (!options.catalog) return;
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
        server.resource(id, uri, async () => {
          await options.authenticateResource();
          return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: await textFactory(),
            },
          ],
          };
        });
      }
    },
  };
}
