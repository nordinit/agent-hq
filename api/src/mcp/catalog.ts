import {
  VALID_TASK_PRIORITIES,
  VALID_TASK_STATUSES,
  VALID_TASK_STORY_POINTS,
} from './apiClient';
import { toJSONSchema, type ZodTypeAny, z } from 'zod';

export interface McpCatalogArg {
  name: string;
  required: boolean;
  description?: string;
  schema?: unknown;
}

export interface McpCatalogTool {
  canonical_name: string;
  aliases: string[];
  description: string;
  args: McpCatalogArg[];
  domain: string;
  rest_paths?: string[];
}

export interface McpCatalogResource {
  id: string;
  uri: string;
  description: string;
}

const tools = new Map<string, McpCatalogTool>();
const resources: McpCatalogResource[] = [
  {
    id: 'agent-hq-workflow-statuses',
    uri: 'agent-hq://workflow/statuses',
    description: 'Legacy/default workflow status seed reference only. Resolve tenant/workflow/task-specific task statuses with agent_hq_get_workflow_metadata.',
  },
  {
    id: 'agent-hq-workflow-task-types',
    uri: 'agent-hq://workflow/task-types',
    description: 'Legacy/default task type seed reference plus global system enums for task priority and story points. Resolve tenant/workflow task types with agent_hq_get_workflow_metadata.',
  },
  {
    id: 'agent-hq-projects-summary',
    uri: 'agent-hq://projects/summary',
    description: 'Live project summary snapshot.',
  },
  {
    id: 'agent-hq-catalog',
    uri: 'agent-hq://catalog',
    description: 'Typed MCP capability catalog for Agent HQ.',
  },
];

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

export function registerCatalogTool(def: {
  names: string[];
  description: string;
  schema: Record<string, ZodTypeAny>;
  domain: string;
  rest_paths?: string[];
}) {
  const [canonical_name, ...aliases] = def.names;
  tools.set(canonical_name, {
    canonical_name,
    aliases,
    description: def.description,
    args: serializeArgs(def.schema),
    domain: def.domain,
    rest_paths: def.rest_paths,
  });
}

export function resetMcpCatalogTools() {
  tools.clear();
}

export function getMcpCatalog() {
  return {
    server: {
      name: 'agent-hq',
      version: '1.0.0',
      transports: ['stdio', 'streamable-http'],
      discoverability: {
        catalog_endpoint: '/api/v1/mcp/catalog',
        health_endpoint: '/api/v1/mcp/catalog/health',
        notes: [
          'This catalog enumerates the typed Agent HQ MCP tools and resources exposed by the bundled MCP server.',
          'Every tool has exactly one name. The aliases field is retained for schema compatibility and is always empty.',
          'rest_paths are informational mappings to the backing Agent HQ API surface. Clients should prefer typed MCP tools when available.',
        ],
      },
    },
    domains: [
      'projects',
      'project_files',
      'workflows',
      'workflow_files',
      'tasks',
      'lifecycle',
      'recurring_task_series',
      'assignment_rules',
      'routing_transitions',
      'routing_graph',
      'model_routing',
      'external_task_events',
      'task_definitions',
      'agents',
      'teams',
      'skills',
      'tools',
      'mcp_servers',
      'advanced',
    ],
    enums: {
      default_task_statuses: VALID_TASK_STATUSES,
      task_statuses_source: 'workflow_metadata',
      task_statuses_metadata_tool: 'agent_hq_get_workflow_metadata',
      task_priorities: VALID_TASK_PRIORITIES,
      task_priorities_source: 'global_system_enum',
      task_story_points: VALID_TASK_STORY_POINTS,
      task_story_points_source: 'global_system_enum',
      task_types_source: 'workflow_definition_config',
      task_types_metadata_tool: 'agent_hq_get_workflow_metadata',
      workflow_lifecycle_statuses: ['planning', 'active', 'paused', 'complete', 'closed'],
      workflow_lifecycle_statuses_source: 'global_system_enum',
    },
    resources,
    tools: [...tools.values()].sort((a, b) => a.canonical_name.localeCompare(b.canonical_name)),
  };
}
