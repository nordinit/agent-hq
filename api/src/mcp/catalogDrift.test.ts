import { toJSONSchema, type ZodTypeAny, z } from 'zod';
import { AgentHqApiClient } from './apiClient';
import { getMcpCatalog, type McpCatalogArg, type McpCatalogTool } from './catalog';
import { registerAgentHqMcpCatalog } from './registerCatalog';
import { registerAgentHqMcpDomains } from './registerDomains';
import { McpRegistrar, McpToolResult } from './registrar';

type JsonSchemaObject = {
  properties?: Record<string, unknown>;
  required?: string[];
};

function serializeArgs(schema: Record<string, ZodTypeAny>): McpCatalogArg[] {
  const objectSchema = z.object(schema);
  const jsonSchema = toJSONSchema(objectSchema) as JsonSchemaObject;
  const required = new Set(jsonSchema.required ?? []);
  const properties = jsonSchema.properties ?? {};

  return Object.entries(schema).map(([name, value]) => {
    const propertySchema = properties[name] ?? {};
    const description = typeof value.description === 'string'
      ? value.description
      : typeof (propertySchema as { description?: unknown }).description === 'string'
        ? (propertySchema as { description?: string }).description
        : undefined;

    return {
      name,
      required: required.has(name),
      description,
      schema: propertySchema,
    };
  });
}

function sortTool(tool: McpCatalogTool): McpCatalogTool {
  return {
    ...tool,
    aliases: [...tool.aliases].sort(),
    args: [...tool.args].sort((a, b) => a.name.localeCompare(b.name)),
    rest_paths: tool.rest_paths ? [...tool.rest_paths].sort() : undefined,
  };
}

function collectLiveRegistry() {
  const tools: McpCatalogTool[] = [];
  const resources: Array<{ id: string; uri: string }> = [];
  const registrar: McpRegistrar = {
    registerTool(names, description, schema, _handler, options) {
      const [canonical_name, ...aliases] = names;
      tools.push({
        canonical_name,
        aliases,
        description,
        args: serializeArgs(schema),
        domain: options?.domain ?? 'general',
        rest_paths: options?.rest_paths,
      });
    },
    registerResource(names) {
      resources.push(...names);
    },
  };

  registerAgentHqMcpDomains({
    api: {} as AgentHqApiClient,
    wrap: <T>(_fn: () => Promise<T>): (() => Promise<McpToolResult>) => async () => ({
      content: [{ type: 'text' as const, text: '{}' }],
    }),
    ...registrar,
  });

  return {
    tools: tools.map(sortTool).sort((a, b) => a.canonical_name.localeCompare(b.canonical_name)),
    resources: resources.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

describe('Agent HQ MCP catalog drift guard', () => {
  beforeEach(() => {
    registerAgentHqMcpCatalog();
  });

  it('matches the live domain tool registrations', () => {
    const catalog = getMcpCatalog();
    const live = collectLiveRegistry();

    expect(catalog.tools.map(sortTool)).toEqual(live.tools);
  });

  it('keeps static catalog resources aligned with live resource registration', () => {
    const catalogResources = getMcpCatalog().resources
      .map(({ id, uri }) => ({ id, uri }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const live = collectLiveRegistry();

    expect(catalogResources).toEqual(live.resources);
  });
});
