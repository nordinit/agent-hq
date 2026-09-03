import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db/client';
import {
  ATLAS_AGENT_NAME,
  ATLAS_AGENT_SLUG,
  ATLAS_SESSION_KEY,
  ATLAS_SYSTEM_ROLE,
  LEGACY_ATLAS_SESSION_KEY,
} from './atlasAgent';
import { resolveRuntimeAgentSlug } from './sessionKeys';
import { ensureTenantSchema, resolveTenantIdFromRequest, verifyTenantSchemaForStartup } from './tenantContext';
import { resolveRuntimeTenantId, tenantInsertColumns } from './runtimeTenantScope';
import { type Db } from "../db/adapter/types";
import { columnExists as sharedColumnExists, tableExists as sharedTableExists } from "../db/introspection";

/**
 * Authority carried by an MCP key. This is the ONLY source of MCP trust.
 *
 * It deliberately does not come from the agent record. Trust used to be derived there — from
 * system_role, slug, or a name equal to 'Atlas' — all of which are ordinary writable columns, so
 * any capability that could edit an agent was a latent privilege escalation and the authorization
 * layer had to defend itself by enumerating fields that were unsafe to write. Authority now comes
 * from the credential presented instead of from data that credential can edit.
 */
export type McpKeyRole = 'scoped' | 'admin' | 'super_admin';

export interface McpApiIdentity {
  keyId: number;
  agentId: number;
  tenantId: number;
  agentName: string;
  agentSlug: string;
  systemRole: string | null;
  /** Authority of the presented key. Never inferred from the agent record. */
  keyRole: McpKeyRole;
  globalAdminAccess: boolean;
  auditActor: string;
  authorityActor: string;
}

declare global {
  namespace Express {
    interface Request {
      mcpIdentity?: McpApiIdentity;
    }
  }
}

export class McpApiAuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 401,
    public readonly code = 'mcp_api_unauthorized',
  ) {
    super(message);
    this.name = 'McpApiAuthError';
  }
}

async function hasTable(db: Db, table: string): Promise<boolean> {
  try {
    return await sharedTableExists(db, table);
  } catch {
    return false;
  }
}

async function hasColumn(db: Db, table: string, column: string): Promise<boolean> {
  try {
    return await sharedColumnExists(db, `${table}`, column);
  } catch {
    return false;
  }
}

function readHeader(req: Request, name: string): string {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return String(value[0] ?? '').trim();
  return typeof value === 'string' ? value.trim() : '';
}

export function extractMcpApiKeyFromRequest(req: Request): { key: string | null; presented: boolean } {
  const mcpClientMarker = readHeader(req, 'x-agent-hq-mcp-client');
  const xApiKey = readHeader(req, 'x-api-key');
  if (xApiKey) return { key: xApiKey, presented: true };

  const auth = readHeader(req, 'authorization');
  if (auth && mcpClientMarker) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    return { key: match?.[1]?.trim() || null, presented: true };
  }

  return { key: null, presented: Boolean(mcpClientMarker) };
}

export function hashMcpApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

/**
 * Timestamps are stored as 'YYYY-MM-DD HH24:MI:SS' UTC strings throughout this schema, which
 * compare correctly lexicographically but are not what Date.parse() assumes — it reads a bare
 * datetime as local time. Appending the zone is what keeps an expiry check from being wrong by
 * the host's UTC offset.
 */
export function isMcpApiKeyExpired(expiresAt: unknown, now = Date.now()): boolean {
  if (typeof expiresAt !== 'string' || expiresAt.trim() === '') return false;
  const parsed = Date.parse(`${expiresAt.trim().replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed)) return false;
  return parsed <= now;
}

export function createMcpApiKeyValue(): string {
  return `ahq_mcp_${crypto.randomBytes(32).toString('base64url')}`;
}

export type AgentMcpDefaultPolicy = 'scoped_runtime' | 'trusted_admin';

export interface AgentMcpCapabilityDefinition {
  key: string;
  group: string;
  label: string;
  description: string;
  endpoints: readonly string[];
  defaultEnabled: Record<AgentMcpDefaultPolicy, boolean>;
}

export const AGENT_MCP_CAPABILITY_CATALOG = [
  {
    key: 'discovery.read_catalog',
    group: 'Discovery',
    label: 'Read MCP catalog',
    description: 'Allows the Agent HQ MCP catalog and health endpoints used for capability discovery.',
    endpoints: [
      'GET /api/v1/mcp/catalog',
      'GET /api/v1/mcp/catalog/health',
    ],
    defaultEnabled: {
      scoped_runtime: true,
      trusted_admin: true,
    },
  },
  {
    key: 'tasks.read_active_context',
    group: 'Task lifecycle',
    label: 'Read active task context',
    description: 'Allows reads for the agent\'s currently dispatched task, including context, notes, history, relationship inspection, and instance linkage.',
    endpoints: [
      'GET /api/v1/tasks/:id',
      'GET /api/v1/tasks/:id/context',
      'GET /api/v1/tasks/:id/notes',
      'GET /api/v1/tasks/:id/history',
      'GET /api/v1/tasks/:id/instances',
      'GET /api/v1/tasks/:id/relationships',
      'GET /api/v1/tasks/:id/relationship-types',
      'GET /api/v1/tasks/:id/active-owner',
    ],
    defaultEnabled: {
      scoped_runtime: true,
      trusted_admin: true,
    },
  },
  {
    key: 'tasks.read_project_context',
    group: 'Task lifecycle',
    label: 'Read project task context',
    description: 'Allows read-only access to task detail, canonical context, notes, history, run state, active-owner context, relationships, and relationship types for tasks in the agent\'s assigned project. The project scope comes from the agent identity, not caller-supplied parameters. Does not allow task writes, relationship mutation, admin routes, tenant-wide reads, or cross-tenant access.',
    endpoints: [
      'GET /api/v1/tasks/:id',
      'GET /api/v1/tasks/:id/context',
      'GET /api/v1/tasks/:id/notes',
      'GET /api/v1/tasks/:id/history',
      'GET /api/v1/tasks/:id/instances',
      'GET /api/v1/tasks/:id/relationships',
      'GET /api/v1/tasks/:id/relationship-types',
      'GET /api/v1/tasks/:id/active-owner',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'tasks.search_project_tasks',
    group: 'Task lifecycle',
    label: 'Search project tasks',
    description: 'Allows bounded read-only task search for exact deduplication within the agent\'s assigned project. The project scope is derived from the MCP agent identity, not caller-supplied parameters. Results are minimal summaries and do not allow task mutation, lifecycle writes, relationship mutation, tenant-wide listing, or cross-project discovery.',
    endpoints: [
      'POST /api/v1/tasks/project-search',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'tasks.write_active_custom_fields',
    group: 'Task lifecycle',
    label: 'Update own active task custom fields',
    description: 'Allows an agent that owns the active dispatched run to persist supported custom fields on that task, and nothing else. The request body may carry only custom_fields (plus changed_by); any attempt to change status, title, assignment, or other task columns is refused. Workflow field-schema validation, tenant scope, and audit history still apply. Does not allow edits to any other task, cross-project or cross-tenant writes, or the broad project task management routes.',
    endpoints: [
      'PUT /api/v1/tasks/:id',
    ],
    defaultEnabled: {
      scoped_runtime: true,
      trusted_admin: true,
    },
  },
  {
    key: 'tasks.write_active_lifecycle',
    group: 'Task lifecycle',
    label: 'Write active task lifecycle',
    description: 'Allows lifecycle notes, evidence, outcomes, and instance start/check-in callbacks for the active dispatched task.',
    endpoints: [
      'POST /api/v1/tasks/:id/notes',
      'PUT /api/v1/tasks/:id/review-evidence',
      'PUT /api/v1/tasks/:id/qa-evidence',
      'PUT /api/v1/tasks/:id/deploy-evidence',
      'PUT /api/v1/tasks/:id/live-verification',
      'POST /api/v1/tasks/:id/outcome',
      'PUT /api/v1/instances/:id/start',
      'POST /api/v1/instances/:id/check-in',
      'PUT /api/v1/instances/:id/complete',
    ],
    defaultEnabled: {
      scoped_runtime: true,
      trusted_admin: true,
    },
  },
  {
    key: 'tasks.create',
    group: 'Task lifecycle',
    label: 'Create Tasks',
    description: 'Legacy scoped create capability. Allows creating new Agent HQ tasks only inside the MCP agent\'s assigned project and tenant. Prefer Project task CRUD for create/read/update/delete access.',
    endpoints: [
      'POST /api/v1/tasks',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'tasks.manage_project_tasks',
    group: 'Task lifecycle',
    label: 'Project task CRUD',
    description: 'Allows creating, reading, updating, and deleting generic tasks and workflow-configured task relationships only inside the MCP agent\'s assigned project and tenant. Project scope is resolved from the agent identity and validated against project_id, sprint_id/workflow_id, relationship peer tasks, target task project, and assignment agent_id. Does not allow active-task lifecycle writes, admin outcomes, cross-project edits, cross-tenant access, or unrelated admin routes.',
    endpoints: [
      'GET /api/v1/tasks/:id',
      'POST /api/v1/tasks',
      'PUT /api/v1/tasks/:id',
      'DELETE /api/v1/tasks/:id',
      'POST /api/v1/tasks/:id/relationships',
      'DELETE /api/v1/tasks/:id/relationships/:relationshipId',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'tasks.write_project_notes',
    group: 'Task lifecycle',
    label: 'Write notes on project tasks',
    description: 'Allows adding notes to any task in the MCP agent\'s assigned project, without owning a dispatched run on it. Notes only: evidence, outcomes, and run check-ins remain scoped to the agent\'s active dispatched task under tasks.write_active_lifecycle, because those drive workflow transitions. Task CRUD is likewise unaffected — this grants no create, update, delete, or relationship access. Intended for remote/operator clients that comment on work they are not executing.',
    endpoints: [
      'POST /api/v1/tasks/:id/notes',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'routing_rules.manage_project_scope',
    group: 'Workflow',
    label: 'Manage project assignment rules',
    description: 'Allows reading, creating, updating, and deleting task assignment/routing rules only inside the MCP agent\'s assigned project and tenant. Does not allow all-project defaults, cross-project edits, cross-tenant edits, workflow transition changes, or unrelated admin routes.',
    endpoints: [
      'GET /api/v1/routing/rules',
      'GET /api/v1/routing/rules/:id',
      'POST /api/v1/routing/rules',
      'PUT /api/v1/routing/rules/:id',
      'DELETE /api/v1/routing/rules/:id',
      'GET /api/v1/routing/assignment-rules',
      'GET /api/v1/routing/assignment-rules/:id',
      'POST /api/v1/routing/assignment-rules',
      'PUT /api/v1/routing/assignment-rules/:id',
      'DELETE /api/v1/routing/assignment-rules/:id',
      'GET /api/v1/routing-rules',
      'GET /api/v1/routing-rules/:id',
      'POST /api/v1/routing-rules',
      'PUT /api/v1/routing-rules/:id',
      'DELETE /api/v1/routing-rules/:id',
      'GET /api/v1/assignment-rules',
      'GET /api/v1/assignment-rules/:id',
      'POST /api/v1/assignment-rules',
      'PUT /api/v1/assignment-rules/:id',
      'DELETE /api/v1/assignment-rules/:id',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'routing_transitions.manage_project_scope',
    group: 'Workflow',
    label: 'Manage project workflow transitions',
    description: 'Allows reading, creating, updating, and deleting automatic workflow transition rows only inside the MCP agent\'s assigned project and tenant, including workflow-type defaults and workflow-specific overrides. Does not allow assignment-rule edits, workflow-definition edits, transition requirement edits, cross-project edits, cross-tenant edits, or unrelated admin routes.',
    endpoints: [
      'GET /api/v1/routing/transitions',
      'GET /api/v1/routing/transitions/:id',
      'POST /api/v1/routing/transitions',
      'PUT /api/v1/routing/transitions/:id',
      'DELETE /api/v1/routing/transitions/:id',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'projects.read_active_project',
    group: 'Context',
    label: 'Read active project',
    description: 'Allows reading the project attached to the active dispatched task.',
    endpoints: [
      'GET /api/v1/projects/:id',
    ],
    defaultEnabled: {
      scoped_runtime: true,
      trusted_admin: true,
    },
  },
  {
    key: 'projects.read_project_board',
    group: 'Context',
    label: 'Read project board',
    description: 'Allows the collection reads a board view needs: the tenant project list, and task, workflow, and workflow-metadata listings scoped to the MCP agent\'s assigned project. Task, workflow, and metadata reads must name the assigned project (or a workflow inside it) explicitly and are refused otherwise, so this cannot enumerate another project\'s work. Grants no writes. Intended for remote/read-first clients — a phone connector needs to list a board, which every other read capability deliberately scopes to a single record or to the agent\'s own dispatched task.',
    endpoints: [
      'GET /api/v1/projects',
      'GET /api/v1/tasks',
      'GET /api/v1/sprints',
      'GET /api/v1/workflows',
      'GET /api/v1/sprints/workflow-metadata',
      'GET /api/v1/workflows/workflow-metadata',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'projects.manage_active_files',
    group: 'Context',
    label: 'Manage active project files',
    description: 'Allows listing, reading, uploading, downloading, replacing, and deleting files on the project attached to the active dispatched task.',
    endpoints: [
      'GET /api/v1/projects/:id/files',
      'POST /api/v1/projects/:id/files',
      'GET /api/v1/projects/:id/files/:fileId',
      'GET /api/v1/projects/:id/files/:fileId/download',
      'GET /api/v1/projects/:id/files/:fileId/versions',
      'PUT /api/v1/projects/:id/files/:fileId',
      'DELETE /api/v1/projects/:id/files/:fileId',
      'GET /api/v1/projects/:projectId/workflows/:workflowId/files',
      'POST /api/v1/projects/:projectId/workflows/:workflowId/files',
      'GET /api/v1/projects/:projectId/workflows/:workflowId/files/:fileId',
      'GET /api/v1/projects/:projectId/workflows/:workflowId/files/:fileId/download',
      'GET /api/v1/projects/:projectId/workflows/:workflowId/files/:fileId/versions',
      'PUT /api/v1/projects/:projectId/workflows/:workflowId/files/:fileId',
      'DELETE /api/v1/projects/:projectId/workflows/:workflowId/files/:fileId',
    ],
    defaultEnabled: {
      scoped_runtime: true,
      trusted_admin: true,
    },
  },
  {
    key: 'sprints.read_active_sprint',
    group: 'Context',
    label: 'Read active sprint',
    description: 'Allows reading the sprint attached to the active dispatched task.',
    endpoints: [
      'GET /api/v1/sprints/:id',
    ],
    defaultEnabled: {
      scoped_runtime: true,
      trusted_admin: true,
    },
  },
  {
    key: 'agents.manage_project_agents',
    group: 'Context',
    label: 'Manage project agents',
    description: 'Allows listing, reading, creating, updating and deleting agents inside the MCP agent\'s assigned project and tenant, including their job instructions, role, model, skills, workspace and routing configuration, and their docs bundle. Refuses any create or update that touches a field trust is derived from — system_role, global_mcp_admin, tenant_id or session_key — or that names the Atlas identity, because setting any of those turns a scoped agent into an administrative one. project_id must name the assigned project, so this cannot move an agent between projects or reach one outside it. Does not allow provisioning, workspace or MCP sync, capability-policy edits, or tool allowlists.',
    endpoints: [
      'GET /api/v1/agents',
      'POST /api/v1/agents',
      'GET /api/v1/agents/:id',
      'PUT /api/v1/agents/:id',
      'DELETE /api/v1/agents/:id',
      'GET /api/v1/agents/:id/docs',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'sprints.pause_active_sprint',
    group: 'Context',
    label: 'Pause and resume workflow',
    description: 'Allows moving a workflow between the non-terminal lifecycle statuses — planning, active, and paused — for the workflow attached to the MCP agent\'s active dispatched task, or, for a board-scoped client, any workflow inside its assigned project. The request body may carry nothing but status and an optional note: a patch that also touches name, goal, dates, repo configuration, or project_id is refused, so this cannot be used to reassign or reconfigure a workflow. Reversible by construction; it stamps no end date and stands down no agents. Does not allow completing or closing a workflow — that is sprints.complete_active_sprint.',
    endpoints: [
      'PUT /api/v1/sprints/:id',
      'PUT /api/v1/workflows/:id',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'sprints.complete_active_sprint',
    group: 'Context',
    label: 'Complete and close workflow',
    description: 'Allows ending an operating cycle — completing or closing the workflow attached to the MCP agent\'s active dispatched task, or, for a board-scoped client, any workflow inside its assigned project. Completing stamps ended_at and disables the workflow\'s agents; both write an audited status change naming the agent that asked. Held separately from sprints.pause_active_sprint because this is terminal for the cycle while pausing is reversible: an agent that may say "hold on" does not thereby get to say "this is finished". Reopening a completed or closed workflow needs sprints.pause_active_sprint.',
    endpoints: [
      'POST /api/v1/sprints/:id/complete',
      'POST /api/v1/sprints/:id/close',
      'POST /api/v1/workflows/:id/complete',
      'POST /api/v1/workflows/:id/close',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'workflow.read_active_configuration',
    group: 'Workflow',
    label: 'Read active workflow configuration',
    description: 'Allows reading workflow transitions and transition requirements for the active task\'s sprint and project.',
    endpoints: [
      'GET /api/v1/routing/transitions',
      'GET /api/v1/routing/transition-requirements',
    ],
    defaultEnabled: {
      scoped_runtime: true,
      trusted_admin: true,
    },
  },
  {
    key: 'workflow.analyze_routing_graph',
    group: 'Workflow',
    label: 'Analyze routing graph',
    description: 'Allows reading the routing configuration as a derived state machine — status nodes, transition edges, gate requirements, assigned agents and structural lint findings — plus hypothetical traces ("what happens on this outcome") and replays of a task\'s status history against that graph. Read-only analysis: it grants no ability to change rules, transitions, requirements or task state. Off by default for scoped runtime keys, because a graph spans a whole project and workflow type rather than the agent\'s own task.',
    endpoints: [
      'GET /api/v1/routing/graph',
      'GET /api/v1/routing/trace',
      'POST /api/v1/routing/trace',
      'GET /api/v1/tasks/:id/trace',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'workflow.edit_routing_config',
    group: 'Workflow',
    label: 'Edit routing config with preview and audit',
    description: 'Allows costing a routing change before making it and reading the routing config audit trail — the same contract the canvas gives a person. POST /routing/preview applies the real mutation inside a transaction that never commits and reports what it touched: rows written per table, how many workflows it reaches, and the lint findings it introduces or resolves. That last part is what makes it worth granting: gate resolution replaces rather than accumulates across task types, so a change can silently drop the gates it looks like it is adding to, and the preview is the only place that shows it before the change lands. This capability grants no writes on its own — the write itself still needs routing_rules, routing_transitions or transition_requirements manage_project_scope — so it is safe to enable wherever those already are.',
    endpoints: [
      'POST /api/v1/routing/preview',
      'GET /api/v1/routing/audit',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'workflow_definitions.read_project_scope',
    group: 'Workflow',
    label: 'Read project workflow definitions',
    description: 'Allows reading a whole workflow definition — the type, its task types, field schemas, statuses, outcomes, and relationship types — only when scoped to the MCP agent\'s assigned project and tenant. Does not allow tenant-wide, cross-project, cross-tenant, or mutation access.',
    endpoints: [
      'GET /api/v1/sprints/config',
      'GET /api/v1/sprints/types/list',
      'GET /api/v1/sprints/types/:key',
      'GET /api/v1/sprints/types/:key/task-types',
      'GET /api/v1/sprints/types/:key/field-schemas',
      'GET /api/v1/sprints/types/:key/field-schemas/:schemaId',
      'GET /api/v1/sprints/types/:key/statuses',
      'GET /api/v1/sprints/types/:key/statuses/:statusKey',
      'GET /api/v1/sprints/types/:key/outcomes',
      'GET /api/v1/sprints/types/:key/outcomes/:outcomeId',
      'GET /api/v1/sprints/types/:key/relationship-types',
      'GET /api/v1/sprints/types/:key/relationship-types/:relationshipTypeId',
      'GET /api/v1/workflows/config',
      'GET /api/v1/workflows/types/list',
      'GET /api/v1/workflows/types/:key',
      'GET /api/v1/workflows/types/:key/task-types',
      'GET /api/v1/workflows/types/:key/field-schemas',
      'GET /api/v1/workflows/types/:key/field-schemas/:schemaId',
      'GET /api/v1/workflows/types/:key/statuses',
      'GET /api/v1/workflows/types/:key/statuses/:statusKey',
      'GET /api/v1/workflows/types/:key/outcomes',
      'GET /api/v1/workflows/types/:key/outcomes/:outcomeId',
      'GET /api/v1/workflows/types/:key/relationship-types',
      'GET /api/v1/workflows/types/:key/relationship-types/:relationshipTypeId',
      'GET /api/v1/workflow-definitions/config',
      'GET /api/v1/workflow-definitions/types',
      'GET /api/v1/workflow-definitions/types/:key',
      'GET /api/v1/workflow-definitions/types/:key/task-types',
      'GET /api/v1/workflow-definitions/types/:key/field-schemas',
      'GET /api/v1/workflow-definitions/types/:key/field-schemas/:schemaId',
      'GET /api/v1/workflow-definitions/types/:key/statuses',
      'GET /api/v1/workflow-definitions/types/:key/statuses/:statusKey',
      'GET /api/v1/workflow-definitions/types/:key/outcomes',
      'GET /api/v1/workflow-definitions/types/:key/outcomes/:outcomeId',
      'GET /api/v1/workflow-definitions/types/:key/relationship-types',
      'GET /api/v1/workflow-definitions/types/:key/relationship-types/:relationshipTypeId',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'workflow_definitions.manage_project_scope',
    group: 'Workflow',
    label: 'Edit project workflow definitions',
    description: 'Allows creating, updating, and deleting every part of a workflow definition — the type itself, its task types, field schemas, statuses and their metadata, outcomes, and relationship types — only inside the MCP agent\'s assigned project and tenant. Statuses and outcomes shape the transition graph an agent moves tasks through, so this grants real authority over how work flows, not just how it is labelled. Does not allow tenant-wide definitions, global definitions, cross-project edits, cross-tenant edits, or unrelated admin routes.',
    endpoints: [
      'POST /api/v1/sprints/types',
      'PUT /api/v1/sprints/types/:key',
      'DELETE /api/v1/sprints/types/:key',
      'PUT /api/v1/sprints/types/:key/task-types',
      'POST /api/v1/sprints/types/:key/field-schemas',
      'PUT /api/v1/sprints/types/:key/field-schemas/:schemaId',
      'DELETE /api/v1/sprints/types/:key/field-schemas/:schemaId',
      'POST /api/v1/sprints/types/:key/statuses',
      'PUT /api/v1/sprints/types/:key/statuses/:statusKey',
      'DELETE /api/v1/sprints/types/:key/statuses/:statusKey',
      'POST /api/v1/sprints/types/:key/outcomes',
      'PUT /api/v1/sprints/types/:key/outcomes/:outcomeId',
      'DELETE /api/v1/sprints/types/:key/outcomes/:outcomeId',
      'POST /api/v1/sprints/types/:key/relationship-types',
      'PUT /api/v1/sprints/types/:key/relationship-types/:relationshipTypeId',
      'DELETE /api/v1/sprints/types/:key/relationship-types/:relationshipTypeId',
      'POST /api/v1/workflows/types',
      'PUT /api/v1/workflows/types/:key',
      'DELETE /api/v1/workflows/types/:key',
      'PUT /api/v1/workflows/types/:key/task-types',
      'POST /api/v1/workflows/types/:key/field-schemas',
      'PUT /api/v1/workflows/types/:key/field-schemas/:schemaId',
      'DELETE /api/v1/workflows/types/:key/field-schemas/:schemaId',
      'POST /api/v1/workflows/types/:key/statuses',
      'PUT /api/v1/workflows/types/:key/statuses/:statusKey',
      'DELETE /api/v1/workflows/types/:key/statuses/:statusKey',
      'POST /api/v1/workflows/types/:key/outcomes',
      'PUT /api/v1/workflows/types/:key/outcomes/:outcomeId',
      'DELETE /api/v1/workflows/types/:key/outcomes/:outcomeId',
      'POST /api/v1/workflows/types/:key/relationship-types',
      'PUT /api/v1/workflows/types/:key/relationship-types/:relationshipTypeId',
      'DELETE /api/v1/workflows/types/:key/relationship-types/:relationshipTypeId',
      'POST /api/v1/workflow-definitions/types',
      'PUT /api/v1/workflow-definitions/types/:key',
      'DELETE /api/v1/workflow-definitions/types/:key',
      'PUT /api/v1/workflow-definitions/types/:key/task-types',
      'POST /api/v1/workflow-definitions/types/:key/field-schemas',
      'PUT /api/v1/workflow-definitions/types/:key/field-schemas/:schemaId',
      'DELETE /api/v1/workflow-definitions/types/:key/field-schemas/:schemaId',
      'POST /api/v1/workflow-definitions/types/:key/statuses',
      'PUT /api/v1/workflow-definitions/types/:key/statuses/:statusKey',
      'DELETE /api/v1/workflow-definitions/types/:key/statuses/:statusKey',
      'POST /api/v1/workflow-definitions/types/:key/outcomes',
      'PUT /api/v1/workflow-definitions/types/:key/outcomes/:outcomeId',
      'DELETE /api/v1/workflow-definitions/types/:key/outcomes/:outcomeId',
      'POST /api/v1/workflow-definitions/types/:key/relationship-types',
      'PUT /api/v1/workflow-definitions/types/:key/relationship-types/:relationshipTypeId',
      'DELETE /api/v1/workflow-definitions/types/:key/relationship-types/:relationshipTypeId',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'recurring_task_series.read_project_scope',
    group: 'Recurring tasks',
    label: 'Read project recurring task series',
    description: 'Allows read-only access to recurring task series, their generated-run history, and schedule previews only inside the MCP agent\'s assigned project and tenant. Schedule previews are non-mutating. Does not allow creating, editing, enabling, disabling, running, or deleting series, and does not allow tenant-wide, cross-project, or cross-tenant reads.',
    endpoints: [
      'GET /api/v1/recurring-task-series',
      'GET /api/v1/recurring-task-series/:id',
      'GET /api/v1/recurring-task-series/:id/history',
      'POST /api/v1/recurring-task-series/preview',
      'POST /api/v1/recurring-task-series/:id/preview',
    ],
    defaultEnabled: {
      scoped_runtime: true,
      trusted_admin: true,
    },
  },
  {
    key: 'recurring_task_series.manage_project_scope',
    group: 'Recurring tasks',
    label: 'Manage project recurring task series',
    description: 'Allows creating, updating, enabling, disabling, running now, and deleting recurring task series only inside the MCP agent\'s assigned project and tenant. Running a series generates real tasks, so this is a write capability. Does not allow cross-project edits, cross-tenant edits, or unrelated admin routes.',
    endpoints: [
      'POST /api/v1/recurring-task-series',
      'PUT /api/v1/recurring-task-series/:id',
      'POST /api/v1/recurring-task-series/:id/enable',
      'POST /api/v1/recurring-task-series/:id/disable',
      'POST /api/v1/recurring-task-series/:id/run-now',
      'DELETE /api/v1/recurring-task-series/:id',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'transition_requirements.manage_project_scope',
    group: 'Workflow',
    label: 'Project transition requirement CRUD',
    description: 'Allows reading, creating, updating, and deleting workflow gate requirements only inside the MCP agent\'s assigned project and tenant. Requires explicit project_id plus sprint_type, or sprint_id/workflow_id scoped to the assigned project. Does not allow global defaults, cross-project edits, cross-tenant edits, workflow transition changes, or unrelated admin routes.',
    endpoints: [
      'GET /api/v1/routing/transition-requirements',
      'POST /api/v1/routing/transition-requirements',
      'PUT /api/v1/routing/transition-requirements/:id',
      'DELETE /api/v1/routing/transition-requirements/:id',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'external.write_task_events',
    group: 'Runtime',
    label: 'Post external task events',
    description: 'Allows lease-manager and runtime-style external task event callbacks.',
    endpoints: [
      'POST /api/v1/external/task-events',
    ],
    defaultEnabled: {
      scoped_runtime: true,
      trusted_admin: true,
    },
  },
  {
    key: 'external.manage_project_task_events',
    group: 'Runtime',
    label: 'Manage project external task events',
    description: 'Allows listing and reading external task-event receipts only for tasks in the MCP agent\'s assigned project and tenant. Does not allow posting callbacks, cross-project receipt access, cross-tenant receipt access, mapping mutation, or unrelated admin routes.',
    endpoints: [
      'GET /api/v1/external/task-events/receipts',
      'GET /api/v1/external/task-events/receipts/:receiptId',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'mcp_capability_policies.read',
    group: 'MCP capability policy',
    label: 'Read MCP capability policy',
    description: 'Allows reading effective Agent HQ MCP capability policy snapshots for agents in the caller agent\'s assigned project. Does not allow cross-project, cross-tenant, credential, secret, or policy mutation access.',
    endpoints: [
      'GET /api/v1/agents/:id/mcp-permissions',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'mcp_capability_policies.write',
    group: 'MCP capability policy',
    label: 'Edit MCP capability policy',
    description: 'Allows creating, replacing, and deleting explicit MCP capability policies for other agents in the caller agent\'s assigned project, limited to safe non-admin capabilities. Self-edits, admin escalation, policy-editor delegation, cross-project, cross-tenant, credential, secret, and unrelated admin mutation paths remain denied.',
    endpoints: [
      'POST /api/v1/agents/:id/mcp-permissions',
      'PUT /api/v1/agents/:id/mcp-permissions',
      'DELETE /api/v1/agents/:id/mcp-permissions',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'admin.full_access',
    group: 'Administration',
    label: 'Full Agent HQ MCP access',
    description: 'Allows broad administrative Agent HQ MCP access inside the MCP key tenant, including project, agent, routing, and registry writes.',
    endpoints: [
      'All other tenant-local /api/v1 Agent HQ MCP endpoints',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'admin.cross_tenant',
    group: 'Super administration',
    label: 'Cross-tenant MCP access',
    description: 'Allows deliberate super-admin Agent HQ MCP access across tenants. Ordinary MCP keys always resolve to their key tenant and cannot send tenant selectors, even with regular admin access.',
    endpoints: [
      'Tenant selection via tenant_id, company_id, x-agent-hq-tenant-id, or x-tenant-id',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: false,
    },
  },
] as const satisfies readonly AgentMcpCapabilityDefinition[];

export type AgentMcpCapabilityKey = typeof AGENT_MCP_CAPABILITY_CATALOG[number]['key'];

export interface AgentMcpCapabilityState extends AgentMcpCapabilityDefinition {
  enabled: boolean;
  default_enabled: boolean;
  explicit_enabled: boolean | null;
}

export interface AgentMcpPermissionPolicySnapshot {
  agent_id: number;
  agent_name: string;
  agent_slug: string;
  policy_mode: 'default' | 'explicit';
  default_policy: AgentMcpDefaultPolicy;
  capabilities: AgentMcpCapabilityState[];
  updated_at: string | null;
}

const AGENT_MCP_CAPABILITY_KEYS = new Set<AgentMcpCapabilityKey>(
  AGENT_MCP_CAPABILITY_CATALOG.map((capability) => capability.key),
);
const LEGACY_AGENT_MCP_CAPABILITY_KEYS = new Set(['tasks.read_any_context']);
const SCOPED_MCP_POLICY_MUTABLE_CAPABILITIES = new Set<AgentMcpCapabilityKey>([
  'discovery.read_catalog',
  'tasks.read_active_context',
  'tasks.read_project_context',
  'tasks.search_project_tasks',
  'tasks.write_active_lifecycle',
  'tasks.create',
  'tasks.manage_project_tasks',
  'projects.read_active_project',
  'projects.manage_active_files',
  'sprints.read_active_sprint',
  'workflow.read_active_configuration',
  'routing_transitions.manage_project_scope',
  'transition_requirements.manage_project_scope',
  'external.write_task_events',
  'external.manage_project_task_events',
  'mcp_capability_policies.read',
]);

/**
 * Descriptive identity only. isTrusted and isGlobalAdmin used to live here, derived from
 * system_role, slug and name; they now come from the key's role. system_role is still resolved
 * because the rest of the product uses it (Atlas dispatch behaviour, workspace provisioning), but
 * nothing in this file may read it to decide authority.
 */
type AgentIdentityFields = {
  agentName: string;
  agentSlug: string;
  systemRole: string | null;
};

function resolveAgentIdentityFields(row: Record<string, unknown>): AgentIdentityFields {
  const agentName = typeof row.agent_name === 'string' && row.agent_name.trim()
    ? row.agent_name.trim()
    : `Agent #${row.agent_id}`;
  const explicitSlug = typeof row.slug === 'string' && row.slug.trim()
    ? row.slug.trim()
    : null;
  const resolvedSlug = resolveRuntimeAgentSlug({
    openclaw_agent_id: typeof row.openclaw_agent_id === 'string' ? row.openclaw_agent_id : null,
    session_key: typeof row.session_key === 'string' ? row.session_key : null,
    name: explicitSlug ?? agentName,
  });
  const agentSlug = explicitSlug
    ?? resolvedSlug
    ?? agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    ?? `agent-${row.agent_id}`;
  const systemRole = typeof row.system_role === 'string' && row.system_role.trim() ? row.system_role.trim() : null;

  return {
    agentName,
    agentSlug,
    systemRole,
  };
}

/** Roles that carry administrative authority. Order matters: super_admin implies admin. */
const MCP_KEY_ROLE_RANK: Record<McpKeyRole, number> = { scoped: 0, admin: 1, super_admin: 2 };

export function normalizeMcpKeyRole(value: unknown): McpKeyRole {
  const role = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return role === 'admin' || role === 'super_admin' ? role : 'scoped';
}

function roleIsTrusted(role: McpKeyRole): boolean {
  return MCP_KEY_ROLE_RANK[role] >= MCP_KEY_ROLE_RANK.admin;
}

function resolveAgentMcpDefaultPolicy(isTrusted: boolean): AgentMcpDefaultPolicy {
  return isTrusted ? 'trusted_admin' : 'scoped_runtime';
}

/**
 * The highest authority any live key for this agent carries.
 *
 * Used only where there is no request to read a key from — the permissions UI and the policy
 * read/write endpoints, which describe an agent rather than a call. Request-time authorization
 * always uses the presented key's own role, never this.
 */
async function resolveAgentHighestKeyRole(db: Db, agentId: number): Promise<McpKeyRole> {
  if (!await hasTable(db, 'mcp_api_keys')) return 'scoped';
  if (!await hasColumn(db, 'mcp_api_keys', 'role')) return 'scoped';
  const rows = await db.all(`
    SELECT role FROM mcp_api_keys
    WHERE agent_id = ? AND enabled = 1 AND revoked_at IS NULL
  `, agentId) as Array<{ role: unknown }>;
  return rows
    .map((row) => normalizeMcpKeyRole(row.role))
    .reduce<McpKeyRole>((best, role) => (MCP_KEY_ROLE_RANK[role] > MCP_KEY_ROLE_RANK[best] ? role : best), 'scoped');
}

async function loadAgentPermissionContext(db: Db, agentId: number): Promise<{
  agentId: number;
  agentName: string;
  agentSlug: string;
  defaultPolicy: AgentMcpDefaultPolicy;
}> {
  const hasAgentSlug = await hasColumn(db, 'agents', 'slug');
  const hasOpenClawAgentId = await hasColumn(db, 'agents', 'openclaw_agent_id');
  const hasSessionKey = await hasColumn(db, 'agents', 'session_key');
  const hasSystemRole = await hasColumn(db, 'agents', 'system_role');

  const row = await db.get(`
    SELECT
      a.id AS agent_id,
      a.name AS agent_name,
      ${hasAgentSlug ? 'a.slug' : 'NULL'} AS slug,
      ${hasOpenClawAgentId ? 'a.openclaw_agent_id' : 'NULL'} AS openclaw_agent_id,
      ${hasSessionKey ? 'a.session_key' : 'NULL'} AS session_key,
      ${hasSystemRole ? 'a.system_role' : 'NULL'} AS system_role
    FROM agents a
    WHERE a.id = ?
    LIMIT 1
  `, agentId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new Error(`Agent #${agentId} not found`);
  }

  const fields = resolveAgentIdentityFields(row);
  return {
    agentId,
    agentName: fields.agentName,
    agentSlug: fields.agentSlug,
    // No key in hand here, so the agent is described by the strongest authority any of its live
    // keys carries. Request-time authorization never uses this — it reads the presented key.
    defaultPolicy: resolveAgentMcpDefaultPolicy(roleIsTrusted(await resolveAgentHighestKeyRole(db, agentId))),
  };
}

async function loadExplicitAgentMcpCapabilityRows(db: Db, agentId: number): Promise<Array<{ capability_key: string; enabled: number; updated_at: string | null }>> {
  return await db.all(`
    SELECT capability_key, enabled, updated_at
    FROM agent_mcp_capability_policies
    WHERE agent_id = ?
    ORDER BY capability_key ASC
  `, agentId) as Array<{ capability_key: string; enabled: number; updated_at: string | null }>;
}

async function buildAgentMcpPermissionPolicySnapshot(
  db: Db,
  context: { agentId: number; agentName: string; agentSlug: string; defaultPolicy: AgentMcpDefaultPolicy },
): Promise<AgentMcpPermissionPolicySnapshot> {
  const explicitRows = await loadExplicitAgentMcpCapabilityRows(db, context.agentId);
  const hasExplicitPolicy = explicitRows.length > 0;
  const explicitMap = new Map<AgentMcpCapabilityKey, boolean>();
  let updatedAt: string | null = null;

  for (const row of explicitRows) {
    if (!AGENT_MCP_CAPABILITY_KEYS.has(row.capability_key as AgentMcpCapabilityKey)) continue;
    explicitMap.set(row.capability_key as AgentMcpCapabilityKey, Number(row.enabled) === 1);
    if (row.updated_at && (!updatedAt || row.updated_at > updatedAt)) updatedAt = row.updated_at;
  }

  return {
    agent_id: context.agentId,
    agent_name: context.agentName,
    agent_slug: context.agentSlug,
    policy_mode: hasExplicitPolicy ? 'explicit' : 'default',
    default_policy: context.defaultPolicy,
    updated_at: updatedAt,
    capabilities: AGENT_MCP_CAPABILITY_CATALOG.map((capability) => {
      const defaultEnabled = capability.defaultEnabled[context.defaultPolicy];
      const explicitEnabled = explicitMap.has(capability.key)
        ? explicitMap.get(capability.key) ?? false
        : null;
      return {
        ...capability,
        enabled: hasExplicitPolicy ? explicitEnabled === true : defaultEnabled,
        default_enabled: defaultEnabled,
        explicit_enabled: explicitEnabled,
      };
    }),
  };
}

async function hasExplicitAgentMcpCapability(db: Db, agentId: number, capability: AgentMcpCapabilityKey): Promise<boolean> {
  if (!await hasTable(db, 'agent_mcp_capability_policies')) return false;
  const row = await db.get(`
    SELECT enabled
    FROM agent_mcp_capability_policies
    WHERE agent_id = ? AND capability_key = ?
    LIMIT 1
  `, agentId, capability) as { enabled: number } | undefined;
  return Number(row?.enabled ?? 0) === 1;
}

export interface AgentMcpServerToolAllowlist {
  mcp_server_id: number;
  server_name: string | null;
  server_slug: string | null;
  enabled: boolean;
  /** Empty array means every tool on the server is permitted. */
  tool_allowlist: string[];
  unrestricted: boolean;
}

function parseToolAllowlistOverrides(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const list = parsed?.tool_allowlist;
    if (!Array.isArray(list)) return [];
    return list.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * Per-agent MCP tool allowlists, one row per assigned server. These live in
 * agent_mcp_assignments.overrides rather than the capability policy table, so
 * they need their own read/write path to be editable outside direct SQL.
 */
export async function getAgentMcpServerToolAllowlists(db: Db, agentId: number): Promise<AgentMcpServerToolAllowlist[]> {
  const rows = await db.all(`
    SELECT a.mcp_server_id, a.overrides, a.enabled, s.name AS server_name, s.slug AS server_slug
    FROM agent_mcp_assignments a
    LEFT JOIN mcp_servers s ON s.id = a.mcp_server_id
    WHERE a.agent_id = ?
    ORDER BY COALESCE(s.name, ''), a.mcp_server_id
  `, agentId) as Array<{
    mcp_server_id: number;
    overrides: string | null;
    enabled: number | null;
    server_name: string | null;
    server_slug: string | null;
  }>;

  return rows.map((row) => {
    const allowlist = parseToolAllowlistOverrides(row.overrides);
    return {
      mcp_server_id: Number(row.mcp_server_id),
      server_name: row.server_name,
      server_slug: row.server_slug,
      enabled: Number(row.enabled ?? 1) === 1,
      tool_allowlist: allowlist,
      unrestricted: allowlist.length === 0,
    };
  });
}

/**
 * Replace one server's tool allowlist for an agent. An empty list clears the
 * restriction, which is how an unrestricted assignment is represented; other
 * override keys on the row are preserved.
 */
export async function replaceAgentMcpServerToolAllowlist(
  db: Db,
  agentId: number,
  mcpServerId: number,
  toolAllowlist: string[],
): Promise<AgentMcpServerToolAllowlist[]> {
  const row = await db.get(`
    SELECT overrides FROM agent_mcp_assignments WHERE agent_id = ? AND mcp_server_id = ?
  `, agentId, mcpServerId) as { overrides: string | null } | undefined;
  if (!row) {
    const error = new Error(`MCP server assignment not found for agent ${agentId}`) as Error & { status?: number };
    error.status = 404;
    throw error;
  }

  let overrides: Record<string, unknown> = {};
  if (typeof row.overrides === 'string' && row.overrides.trim().length > 0) {
    try {
      const parsed = JSON.parse(row.overrides) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) overrides = parsed;
    } catch {
      overrides = {};
    }
  }

  const cleaned = Array.from(new Set(
    toolAllowlist.map((entry) => entry.trim()).filter((entry) => entry.length > 0),
  ));
  if (cleaned.length === 0) delete overrides.tool_allowlist;
  else overrides.tool_allowlist = cleaned;

  await db.run(`
    UPDATE agent_mcp_assignments SET overrides = ? WHERE agent_id = ? AND mcp_server_id = ?
  `, JSON.stringify(overrides), agentId, mcpServerId);

  return await getAgentMcpServerToolAllowlists(db, agentId);
}

export async function getAgentMcpPermissionPolicy(db: Db, agentId: number): Promise<AgentMcpPermissionPolicySnapshot> {
  const context = await loadAgentPermissionContext(db, agentId);
  return await buildAgentMcpPermissionPolicySnapshot(db, context);
}

export async function replaceAgentMcpPermissionPolicy(
  db: Db,
  agentId: number,
  enabledCapabilityKeys: readonly string[],
): Promise<AgentMcpPermissionPolicySnapshot> {
  const context = await loadAgentPermissionContext(db, agentId);
  const normalized = new Set<AgentMcpCapabilityKey>();

  for (const rawKey of enabledCapabilityKeys) {
    if (!AGENT_MCP_CAPABILITY_KEYS.has(rawKey as AgentMcpCapabilityKey)) {
      if (LEGACY_AGENT_MCP_CAPABILITY_KEYS.has(rawKey)) {
        throw new Error(`Unknown Agent HQ MCP capability: ${rawKey} has been removed; use tasks.read_project_context for project-scoped task context reads`);
      }
      throw new Error(`Unknown Agent HQ MCP capability: ${rawKey}`);
    }
    normalized.add(rawKey as AgentMcpCapabilityKey);
  }

  await db.withTransaction(async (db) => {
    await db.run(`DELETE FROM agent_mcp_capability_policies WHERE agent_id = ?`, agentId);
    for (const capability of AGENT_MCP_CAPABILITY_CATALOG) {
      await db.run(`
        INSERT INTO agent_mcp_capability_policies (agent_id, capability_key, enabled)
        VALUES (?, ?, ?)
      `, agentId, capability.key, normalized.has(capability.key) ? 1 : 0);
    }
  });

  return await buildAgentMcpPermissionPolicySnapshot(db, context);
}

export async function resetAgentMcpPermissionPolicy(db: Db, agentId: number): Promise<AgentMcpPermissionPolicySnapshot> {
  const context = await loadAgentPermissionContext(db, agentId);
  await db.run(`DELETE FROM agent_mcp_capability_policies WHERE agent_id = ?`, agentId);
  return await buildAgentMcpPermissionPolicySnapshot(db, context);
}

async function resolveEffectiveAgentMcpPermissionState(db: Db, identity: McpApiIdentity): Promise<{
  policyMode: 'default' | 'explicit';
  defaultPolicy: AgentMcpDefaultPolicy;
  enabledCapabilities: Set<AgentMcpCapabilityKey>;
}> {
  const snapshot = await buildAgentMcpPermissionPolicySnapshot(db, {
      agentId: identity.agentId,
      agentName: identity.agentName,
      agentSlug: identity.agentSlug,
      defaultPolicy: resolveAgentMcpDefaultPolicy(isTrustedMcpIdentity(identity)),
    });

  return {
    policyMode: snapshot.policy_mode,
    defaultPolicy: snapshot.default_policy,
    enabledCapabilities: new Set<AgentMcpCapabilityKey>(
      snapshot.capabilities
        .filter((capability) => capability.enabled)
        .map((capability) => capability.key as AgentMcpCapabilityKey),
    ),
  };
}

async function shapeIdentity(db: Db, row: Record<string, unknown>): Promise<McpApiIdentity> {
  const { agentName, agentSlug, systemRole } = resolveAgentIdentityFields(row);
  const keyRole = normalizeMcpKeyRole(row.key_role);
  const isGlobalAdmin = keyRole === 'super_admin';
  const tenantId = parsePositiveInt(row.key_tenant_id) ?? parsePositiveInt(row.agent_tenant_id);
  if (!tenantId) {
    throw new McpApiAuthError('MCP API key is not bound to a tenant', 403, 'mcp_api_key_tenant_missing');
  }

  return {
    keyId: Number(row.key_id),
    agentId: Number(row.agent_id),
    tenantId,
    agentName,
    agentSlug,
    systemRole,
    keyRole,
    globalAdminAccess: isGlobalAdmin || await hasExplicitAgentMcpCapability(db, Number(row.agent_id), 'admin.cross_tenant'),
    auditActor: agentSlug,
    authorityActor: roleIsTrusted(keyRole) ? ATLAS_AGENT_NAME : agentSlug,
  };
}

export async function resolveMcpApiIdentityForKey(
  db: Db,
  apiKey: string,
  options: { updateLastUsed?: boolean } = {},
): Promise<McpApiIdentity> {
  await ensureTenantSchema(db);
  const normalizedKey = apiKey.trim();
  if (!normalizedKey) {
    throw new McpApiAuthError('MCP API key is required', 401, 'mcp_api_key_missing');
  }

  const hasAgentSlug = await hasColumn(db, 'agents', 'slug');
  const hasOpenClawAgentId = await hasColumn(db, 'agents', 'openclaw_agent_id');
  const hasSessionKey = await hasColumn(db, 'agents', 'session_key');
  const hasSystemRole = await hasColumn(db, 'agents', 'system_role');
  const hasAgentEnabled = await hasColumn(db, 'agents', 'enabled');
  const hasDeletedAt = await hasColumn(db, 'agents', 'deleted_at');
  const hasAgentTenant = await hasColumn(db, 'agents', 'tenant_id');
  const hasKeyExpiry = await hasColumn(db, 'mcp_api_keys', 'expires_at');
  // Probed rather than assumed so a build that boots against a database one migration behind
  // resolves every key as scoped — the least authority — instead of failing the query outright.
  const hasKeyRole = await hasColumn(db, 'mcp_api_keys', 'role');

  const row = await db.get(`
    SELECT
      k.id AS key_id,
      k.agent_id AS agent_id,
      k.tenant_id AS key_tenant_id,
      ${hasKeyRole ? 'k.role' : "'scoped'"} AS key_role,
      k.enabled AS key_enabled,
      k.revoked_at AS revoked_at,
      ${hasKeyExpiry ? 'k.expires_at' : 'NULL'} AS expires_at,
      a.name AS agent_name,
      ${hasAgentTenant ? 'a.tenant_id' : 'NULL'} AS agent_tenant_id,
      ${hasAgentSlug ? 'a.slug' : 'NULL'} AS slug,
      ${hasOpenClawAgentId ? 'a.openclaw_agent_id' : 'NULL'} AS openclaw_agent_id,
      ${hasSessionKey ? 'a.session_key' : 'NULL'} AS session_key,
      ${hasSystemRole ? 'a.system_role' : 'NULL'} AS system_role,
      ${hasAgentEnabled ? 'a.enabled' : '1'} AS agent_enabled,
      ${hasDeletedAt ? 'a.deleted_at' : 'NULL'} AS deleted_at
    FROM mcp_api_keys k
    LEFT JOIN agents a ON a.id = k.agent_id
    WHERE k.key_hash = ?
    LIMIT 1
  `, hashMcpApiKey(normalizedKey)) as Record<string, unknown> | undefined;

  if (!row) {
    throw new McpApiAuthError('Invalid MCP API key', 401, 'mcp_api_key_invalid');
  }
  if (Number(row.key_enabled) !== 1 || row.revoked_at != null) {
    throw new McpApiAuthError('MCP API key is disabled or revoked', 403, 'mcp_api_key_disabled');
  }
  // OAuth access tokens are mcp_api_keys rows with an expiry. Enforced here rather than at the
  // /mcp transport so a token cannot outlive its grant on any path that resolves a key — the
  // REST API included. Keys issued the older way leave expires_at NULL and never expire.
  if (isMcpApiKeyExpired(row.expires_at)) {
    throw new McpApiAuthError('MCP API key has expired', 401, 'mcp_api_key_expired');
  }
  if (!row.agent_id || !row.agent_name) {
    throw new McpApiAuthError('MCP API key is not mapped to an agent', 403, 'mcp_api_key_unmapped');
  }
  if (Number(row.agent_enabled) === 0 || row.deleted_at != null) {
    throw new McpApiAuthError('MCP API key is mapped to a disabled agent', 403, 'mcp_agent_disabled');
  }

  const rowTenantId = parsePositiveInt(row.key_tenant_id);
  const agentTenantId = parsePositiveInt(row.agent_tenant_id);
  // A key bound to a different tenant than its agent is only legitimate for a super_admin key,
  // which is permitted across tenants by definition. Reads the key's role, not the agent record.
  if (rowTenantId && agentTenantId && rowTenantId !== agentTenantId && normalizeMcpKeyRole(row.key_role) !== 'super_admin') {
    throw new McpApiAuthError('MCP API key tenant binding does not match its owning agent', 403, 'mcp_api_key_tenant_mismatch');
  }

  // Authentication is a read path, not a migration path. A legacy key without its own
  // tenant_id may inherit the owning agent's tenant for this request, but it is never repaired
  // as a side effect of being used. Explicit migration/provisioning owns persisted config.

  if (options.updateLastUsed !== false) {
    await db.run(`UPDATE mcp_api_keys SET last_used_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`, row.key_id);
  }

  return await shapeIdentity(db, row);
}

/**
 * Issue a key for an agent. `role` is the key's authority and defaults to 'scoped': a key is
 * ordinary unless someone deliberately asks for an administrative one, so no code path mints
 * administrative access by omission.
 */
export async function issueMcpApiKeyForAgent(
  db: Db,
  agentId: number,
  name = 'Agent HQ MCP',
  role: McpKeyRole = 'scoped',
): Promise<{ apiKey: string; keyId: number; keyPrefix: string; role: McpKeyRole }> {
  await ensureTenantSchema(db);
  const agent = await db.get(`SELECT id, tenant_id FROM agents WHERE id = ?`, agentId) as { id: number; tenant_id: number | null } | undefined;
  if (!agent) throw new Error(`Cannot issue MCP API key: agent #${agentId} not found`);
  const tenantId = parsePositiveInt(agent.tenant_id);
  if (!tenantId) throw new Error(`Cannot issue MCP API key: agent #${agentId} is not bound to a tenant`);

  const apiKey = createMcpApiKeyValue();
  const keyPrefix = apiKey.slice(0, 16);
  const hasKeyRole = await hasColumn(db, 'mcp_api_keys', 'role');
  if (role !== 'scoped' && !hasKeyRole) {
    throw new Error('Cannot issue an administrative MCP API key: mcp_api_keys.role is missing, so run migrations first.');
  }
  const result = hasKeyRole
    ? await db.run(`
        INSERT INTO mcp_api_keys (agent_id, tenant_id, name, key_prefix, key_hash, role)
        VALUES (?, ?, ?, ?, ?, ?)
      `, agentId, tenantId, name, keyPrefix, hashMcpApiKey(apiKey), role)
    : await db.run(`
        INSERT INTO mcp_api_keys (agent_id, tenant_id, name, key_prefix, key_hash)
        VALUES (?, ?, ?, ?, ?)
      `, agentId, tenantId, name, keyPrefix, hashMcpApiKey(apiKey));

  return {
    apiKey,
    keyId: Number(result.lastInsertId),
    keyPrefix,
    role: hasKeyRole ? role : 'scoped',
  };
}

async function findAgentIdForConfiguredRuntimeKey(
  db: Db,
  env: NodeJS.ProcessEnv,
): Promise<number | null> {
  const explicitId = Number.parseInt(env.AGENT_HQ_MCP_API_KEY_AGENT_ID ?? '', 10);
  if (Number.isInteger(explicitId) && explicitId > 0) {
    const row = await db.get(`SELECT id FROM agents WHERE id = ? LIMIT 1`, explicitId) as { id: number } | undefined;
    if (row?.id) return Number(row.id);
  }

  const hasAgentSlug = await hasColumn(db, 'agents', 'slug');
  const hasOpenClawAgentId = await hasColumn(db, 'agents', 'openclaw_agent_id');
  const hasSessionKey = await hasColumn(db, 'agents', 'session_key');
  const hasSystemRole = await hasColumn(db, 'agents', 'system_role');

  const configuredSlug = env.AGENT_HQ_MCP_API_KEY_AGENT_SLUG?.trim();
  if (hasAgentSlug && configuredSlug) {
    const row = await db.get(`SELECT id FROM agents WHERE slug = ? LIMIT 1`, configuredSlug) as { id: number } | undefined;
    if (row?.id) return Number(row.id);
  }

  const configuredOpenClawAgentId = env.AGENT_HQ_MCP_API_KEY_AGENT_OPENCLAW_ID?.trim();
  if (hasOpenClawAgentId && configuredOpenClawAgentId) {
    const row = await db.get(`SELECT id FROM agents WHERE openclaw_agent_id = ? LIMIT 1`, configuredOpenClawAgentId) as { id: number } | undefined;
    if (row?.id) return Number(row.id);
  }

  const configuredSessionKey = env.AGENT_HQ_MCP_API_KEY_AGENT_SESSION_KEY?.trim();
  if (hasSessionKey && configuredSessionKey) {
    const row = await db.get(`SELECT id FROM agents WHERE session_key = ? LIMIT 1`, configuredSessionKey) as { id: number } | undefined;
    if (row?.id) return Number(row.id);
  }

  if (hasSystemRole) {
    const atlasBySystemRole = await db.get(`SELECT id FROM agents WHERE system_role = ? ORDER BY id ASC LIMIT 1`, ATLAS_SYSTEM_ROLE) as { id: number } | undefined;
    if (atlasBySystemRole?.id) return Number(atlasBySystemRole.id);
  }

  if (hasOpenClawAgentId) {
    const atlasByOpenClawId = await db.get(`SELECT id FROM agents WHERE openclaw_agent_id = ? ORDER BY id ASC LIMIT 1`, ATLAS_AGENT_SLUG) as { id: number } | undefined;
    if (atlasByOpenClawId?.id) return Number(atlasByOpenClawId.id);
  }

  if (hasSessionKey) {
    const atlasBySessionKey = await db.get(`SELECT id FROM agents WHERE session_key = ? ORDER BY id ASC LIMIT 1`, ATLAS_SESSION_KEY) as { id: number } | undefined;
    if (atlasBySessionKey?.id) return Number(atlasBySessionKey.id);
  }

  const atlasByName = await db.get(`SELECT id FROM agents WHERE name = ? ORDER BY id ASC LIMIT 1`, ATLAS_AGENT_NAME) as { id: number } | undefined;
  if (atlasByName?.id) return Number(atlasByName.id);

  if (hasSessionKey) {
    const legacyAtlas = await db.get(`SELECT id FROM agents WHERE session_key = ? ORDER BY id ASC LIMIT 1`, LEGACY_ATLAS_SESSION_KEY) as { id: number } | undefined;
    if (legacyAtlas?.id) return Number(legacyAtlas.id);
  }

  return null;
}

export async function ensureConfiguredRuntimeMcpApiKey(
  db: Db = getDb(),
  env: NodeJS.ProcessEnv = process.env,
  options: { tenantMode?: 'repair' | 'verify' } = {},
): Promise<{ status: 'missing' | 'reused' | 'created'; agentId?: number; keyId?: number; keyPrefix?: string }> {
  if (options.tenantMode === 'verify') {
    await verifyTenantSchemaForStartup(db);
  } else {
    await ensureTenantSchema(db);
  }

  const configuredApiKey = env.AGENT_HQ_MCP_API_KEY?.trim();
  if (!configuredApiKey) return { status: 'missing' };

  try {
    const identity = await resolveMcpApiIdentityForKey(db, configuredApiKey, { updateLastUsed: false });
    return {
      status: 'reused',
      agentId: identity.agentId,
      keyId: identity.keyId,
      keyPrefix: configuredApiKey.slice(0, 16),
    };
  } catch (error) {
    if (!(error instanceof McpApiAuthError) || error.code !== 'mcp_api_key_invalid') {
      throw error;
    }
  }

  const agentId = await findAgentIdForConfiguredRuntimeKey(db, env);
  if (!agentId) {
    throw new Error('Configured AGENT_HQ_MCP_API_KEY could not be materialized because no bootstrap agent was found in the current database');
  }

  const keyPrefix = configuredApiKey.slice(0, 16);
  const agent = await db.get(`SELECT tenant_id FROM agents WHERE id = ?`, agentId) as { tenant_id: number | null } | undefined;
  const tenantId = parsePositiveInt(agent?.tenant_id);
  if (!tenantId) {
    throw new Error(`Configured AGENT_HQ_MCP_API_KEY could not be materialized because bootstrap agent #${agentId} is not bound to a tenant`);
  }
  // The configured bootstrap key is the one place an administrative key is minted from
  // environment rather than by hand, and it stays opt-in: without the flag it is scoped.
  const globalAdmin = ['1', 'true', 'yes', 'on'].includes(String(env.AGENT_HQ_MCP_API_KEY_GLOBAL_ADMIN ?? '').trim().toLowerCase()) ? 1 : 0;
  const role: McpKeyRole = globalAdmin === 1 ? 'super_admin' : 'scoped';
  const hasKeyRole = await hasColumn(db, 'mcp_api_keys', 'role');

  const result = hasKeyRole
    ? await db.run(`
        INSERT INTO mcp_api_keys (agent_id, tenant_id, name, key_prefix, key_hash, global_admin, role)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, agentId, tenantId, 'Configured runtime MCP API key', keyPrefix, hashMcpApiKey(configuredApiKey), globalAdmin, role)
    : await db.run(`
        INSERT INTO mcp_api_keys (agent_id, tenant_id, name, key_prefix, key_hash, global_admin)
        VALUES (?, ?, ?, ?, ?, ?)
      `, agentId, tenantId, 'Configured runtime MCP API key', keyPrefix, hashMcpApiKey(configuredApiKey), globalAdmin);

  return {
    status: 'created',
    agentId,
    keyId: Number(result.lastInsertId),
    keyPrefix,
  };
}

export async function ensureMaterializedMcpApiKeyForAgent(params: {
  db: Db;
  agentId: number;
  existingApiKey?: string | null;
  name?: string;
}): Promise<{ apiKey: string; reused: boolean; keyId?: number; keyPrefix?: string }> {
  const existingApiKey = params.existingApiKey?.trim();
  if (existingApiKey) {
    try {
      const identity = await resolveMcpApiIdentityForKey(params.db, existingApiKey, { updateLastUsed: false });
      if (identity.agentId === params.agentId) {
        return {
          apiKey: existingApiKey,
          reused: true,
          keyId: identity.keyId,
        };
      }
    } catch {
      // Replace missing, revoked, invalid, or mismatched materialized keys below.
    }
  }

  const issued = await issueMcpApiKeyForAgent(params.db, params.agentId, params.name);
  return {
    apiKey: issued.apiKey,
    reused: false,
    keyId: issued.keyId,
    keyPrefix: issued.keyPrefix,
  };
}

export function getMcpIdentityFromRequest(req: Request): McpApiIdentity | null {
  return req.mcpIdentity ?? null;
}

type ScopedTaskContext = {
  taskId: number;
  projectId: number | null;
  sprintId: number | null;
  activeInstanceId: number | null;
};

type ScopedInstanceContext = {
  instanceId: number;
  taskId: number | null;
  status: string | null;
  activeForTask: boolean;
};

function isTrustedMcpIdentity(identity: McpApiIdentity): boolean {
  return roleIsTrusted(identity.keyRole);
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function getScopedTaskContexts(db: Db, identity: McpApiIdentity): Promise<ScopedTaskContext[]> {
  return (await db.all(`
    SELECT DISTINCT
      t.id AS task_id,
      t.project_id AS project_id,
      t.sprint_id AS sprint_id,
      t.active_instance_id AS active_instance_id
    FROM tasks t
    LEFT JOIN job_instances active_ji ON active_ji.id = t.active_instance_id
    WHERE (
      t.active_instance_id IS NOT NULL
      AND active_ji.agent_id = ?
    )
      OR EXISTS (
        SELECT 1
        FROM job_instances ji
        WHERE ji.task_id = t.id
          AND ji.agent_id = ?
          AND ji.status IN ('queued', 'dispatched', 'running')
      )
  `, identity.agentId, identity.agentId)).map((row) => {
    const record = row as Record<string, unknown>;
    return {
      taskId: Number(record.task_id),
      projectId: parsePositiveInt(record.project_id),
      sprintId: parsePositiveInt(record.sprint_id),
      activeInstanceId: parsePositiveInt(record.active_instance_id),
    };
  });
}

/**
 * The instances a normal MCP key may write lifecycle callbacks for: those the calling agent owns
 * and that are either still running or still linked as their task's active instance.
 *
 * THE ALIASES MUST STAY QUOTED. PostgreSQL folds unquoted identifiers to lower case, so
 * `AS instanceId` returns a column named `instanceid`, `row.instanceId` below reads undefined, and
 * Number(undefined) is NaN. Every id in the returned set became NaN, so scopedInstanceIds.has(id)
 * was false for every instance and EVERY agent was denied lifecycle callbacks on its own run —
 * which is exactly what happened in production once it moved to PostgreSQL. SQLite preserves the
 * alias case, so the same code was correct there and nothing failed until the engine changed.
 *
 * Nothing threw and nothing logged: the query succeeded, the rows came back, and only the property
 * names differed. They are spelled out explicitly because PostgreSQL has no execution-time
 * dialect translator and this query decides an authorization outcome.
 *
 * NOTE: the status list is an allowlist of live statuses, but production job_instances only ever
 * hold done, failed, cancelled and dispatched — so two of the three values enumerated here never
 * occur, and any new non-terminal dispatch stage would silently cost the owning agent the right to
 * report on its own run. Inverting it to a denylist of terminal statuses is worth doing as
 * hardening, but it was NOT the cause of the production denial and is deliberately left alone here.
 */
async function getScopedInstanceContexts(db: Db, identity: McpApiIdentity): Promise<ScopedInstanceContext[]> {
  return (await db.all(`
    SELECT DISTINCT
      ji.id AS "instanceId",
      ji.task_id AS "taskId",
      ji.status AS status,
      CASE WHEN t.active_instance_id = ji.id THEN 1 ELSE 0 END AS "activeForTask"
    FROM job_instances ji
    LEFT JOIN tasks t ON t.id = ji.task_id
    WHERE ji.agent_id = ?
      AND (
        ji.status IN ('queued', 'dispatched', 'running')
        OR t.active_instance_id = ji.id
      )
  `, identity.agentId)).map((row) => ({
    instanceId: Number((row as Record<string, unknown>).instanceId),
    taskId: parsePositiveInt((row as Record<string, unknown>).taskId),
    status: typeof (row as Record<string, unknown>).status === 'string' ? String((row as Record<string, unknown>).status) : null,
    activeForTask: Number((row as Record<string, unknown>).activeForTask) === 1,
  }));
}

async function getCanonicalAgentProjectId(db: Db, identity: McpApiIdentity): Promise<number | null> {
  if (!await hasColumn(db, 'agents', 'project_id')) return null;
  const row = await db.get(`SELECT project_id FROM agents WHERE id = ? AND tenant_id = ? LIMIT 1`, identity.agentId, identity.tenantId) as { project_id: number | null } | undefined;
  return parsePositiveInt(row?.project_id);
}

async function getTenantAgentProjectId(db: Db, identity: McpApiIdentity, agentId: number): Promise<number | null | undefined> {
  if (!await hasColumn(db, 'agents', 'tenant_id') || !await hasColumn(db, 'agents', 'project_id')) return undefined;
  const row = await db.get(`SELECT project_id FROM agents WHERE id = ? AND tenant_id = ? LIMIT 1`, agentId, identity.tenantId) as { project_id: number | null } | undefined;
  if (!row) return undefined;
  return parsePositiveInt(row.project_id);
}

async function taskBelongsToProject(db: Db, identity: McpApiIdentity, taskId: number, projectId: number): Promise<boolean> {
  const row = await db.get(`SELECT tenant_id, project_id FROM tasks WHERE id = ? LIMIT 1`, taskId) as { tenant_id: number | null; project_id: number | null } | undefined;
  return parsePositiveInt(row?.tenant_id) === identity.tenantId && parsePositiveInt(row?.project_id) === projectId;
}

async function relationshipBelongsToProject(
  db: Db,
  identity: McpApiIdentity,
  relationshipId: number,
  sourceTaskId: number,
  projectId: number,
): Promise<boolean> {
  if (!await hasTable(db, 'task_relationships')) return false;
  const row = await db.get(`
    SELECT
      source.tenant_id AS source_tenant_id,
      source.project_id AS source_project_id,
      target.tenant_id AS target_tenant_id,
      target.project_id AS target_project_id
    FROM task_relationships tr
    JOIN tasks source ON source.id = tr.source_task_id
    JOIN tasks target ON target.id = tr.target_task_id
    WHERE tr.id = ? AND tr.source_task_id = ?
    LIMIT 1
  `, relationshipId, sourceTaskId) as Record<string, unknown> | undefined;
  if (!row) return false;
  return parsePositiveInt(row.source_tenant_id) === identity.tenantId
    && parsePositiveInt(row.target_tenant_id) === identity.tenantId
    && parsePositiveInt(row.source_project_id) === projectId
    && parsePositiveInt(row.target_project_id) === projectId;
}

/**
 * Fields an agent write must never carry under a project-scoped grant.
 *
 * These no longer confer MCP authority — that comes from the presented key's role, which is not
 * a column on agents and cannot be written through this API at all. This list is now defence in
 * depth over fields that still bind identity: `system_role` drives Atlas behaviour elsewhere in
 * the product, `session_key` is how a runtime identity is matched to a row, `tenant_id` moves an
 * agent between tenants, and `global_mcp_admin` is a legacy privilege column kept for rollback.
 *
 * Before the key-role model these WERE the escalation surface: renaming an agent to 'Atlas' or
 * setting system_role 'admin' made it trusted, so a connector could promote its own row. Trust
 * moved onto the credential precisely so that a data-editing capability could never be an
 * authority-granting one, and this list is no longer what stands between the two.
 */
const AGENT_TRUST_BEARING_FIELDS = ['system_role', 'global_mcp_admin', 'key_global_admin', 'tenant_id', 'session_key'] as const;

function agentTrustBearingFieldInPatch(body: Record<string, unknown>): string | null {
  return AGENT_TRUST_BEARING_FIELDS.find((field) => Object.prototype.hasOwnProperty.call(body, field)) ?? null;
}

/**
 * Kept after the key-role change, though it no longer guards authority: the Atlas name and slug
 * identify the built-in assistant that tenant provisioning looks up, so letting a project-scoped
 * client mint a second one invites a collision rather than an escalation.
 */
function agentIdentityNameIsReserved(body: Record<string, unknown>): boolean {
  const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : null;
  const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : null;
  return name === ATLAS_AGENT_NAME.toLowerCase() || slug === ATLAS_AGENT_SLUG.toLowerCase();
}

async function agentBelongsToProject(db: Db, identity: McpApiIdentity, agentId: number, projectId: number): Promise<boolean> {
  if (!await hasTable(db, 'agents')) return false;
  const hasAgentTenant = await hasColumn(db, 'agents', 'tenant_id');
  const row = await db.get(`
    SELECT project_id
    FROM agents
    WHERE id = ?
      ${hasAgentTenant ? 'AND tenant_id = ?' : ''}
    LIMIT 1
  `, agentId, ...(hasAgentTenant ? [identity.tenantId] : [])) as { project_id: number | null } | undefined;
  return parsePositiveInt(row?.project_id) === projectId;
}

async function sprintBelongsToProject(db: Db, identity: McpApiIdentity, sprintId: number, projectId: number): Promise<boolean> {
  if (!await hasTable(db, 'sprints')) return false;
  const hasSprintTenant = await hasColumn(db, 'sprints', 'tenant_id');
  const row = await db.get(`
    SELECT project_id
    FROM sprints
    WHERE id = ?
      ${hasSprintTenant ? 'AND tenant_id = ?' : ''}
    LIMIT 1
  `, sprintId, ...(hasSprintTenant ? [identity.tenantId] : [])) as { project_id: number | null } | undefined;
  return parsePositiveInt(row?.project_id) === projectId;
}

function requestBodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

async function validateProjectTaskCrudRequestScope(
  db: Db,
  identity: McpApiIdentity,
  body: Record<string, unknown>,
  projectId: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const requestedProjectId = parsePositiveInt(body.project_id);
  if (requestedProjectId != null && requestedProjectId !== projectId) {
    return { ok: false, reason: `Requested project_id ${requestedProjectId} is outside the assigned project for ${identity.agentSlug}.` };
  }

  const requestedSprintId = parsePositiveInt(firstPresent(body.sprint_id, body.workflow_id));
  if (requestedSprintId != null && !await sprintBelongsToProject(db, identity, requestedSprintId, projectId)) {
    return { ok: false, reason: `Requested sprint/workflow #${requestedSprintId} is outside the assigned project for ${identity.agentSlug}.` };
  }

  const requestedAgentId = parsePositiveInt(body.agent_id);
  if (requestedAgentId != null) {
    const targetAgentProjectId = await getTenantAgentProjectId(db, identity, requestedAgentId);
    if (targetAgentProjectId === undefined) {
      return { ok: false, reason: `Requested agent #${requestedAgentId} is outside the MCP key tenant or does not exist.` };
    }
    if (targetAgentProjectId !== projectId) {
      return { ok: false, reason: `Requested agent #${requestedAgentId} is outside the assigned project for ${identity.agentSlug}.` };
    }
  }

  return { ok: true };
}

function extractRequestedMcpPolicyCapabilities(body: unknown): string[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = (body as { enabled_capabilities?: unknown }).enabled_capabilities;
  if (!Array.isArray(value)) return null;
  if (!value.every((item) => typeof item === 'string')) return null;
  return value;
}

async function taskIdForInstance(db: Db, instanceId: number): Promise<number | null> {
  const row = await db.get(`SELECT task_id FROM job_instances WHERE id = ?`, instanceId) as { task_id: number | null } | undefined;
  return row?.task_id ?? null;
}

type RoutingRuleScopeContext = {
  projectId: number | null;
  sprintId: number | null;
  sprintType: string | null;
  source: 'request' | 'existing_rule';
};

type RoutingTransitionScopeContext = {
  projectId: number | null;
  sprintId: number | null;
  sprintType: string | null;
  source: 'request' | 'existing_transition';
};

function normalizeScopeString(value: unknown): string | null {
  if (Array.isArray(value)) return normalizeScopeString(value[0]);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstPresent(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

async function getRoutingRuleScopeFromRuleId(
  db: Db,
  ruleId: number,
  tenantId: number,
): Promise<RoutingRuleScopeContext | null> {
  if (!await hasTable(db, 'sprint_task_routing_rules')) return null;
  const hasRoutingProject = await hasColumn(db, 'sprint_task_routing_rules', 'project_id');
  const hasRoutingSprintType = await hasColumn(db, 'sprint_task_routing_rules', 'sprint_type');
  const hasRoutingTenant = await hasColumn(db, 'sprint_task_routing_rules', 'tenant_id');
  const hasSprintTenant = await hasColumn(db, 'sprints', 'tenant_id');
  const row = await db.get(`
    SELECT
      trr.id,
      ${hasRoutingProject ? 'trr.project_id' : 'NULL'} AS routing_project_id,
      trr.sprint_id AS routing_sprint_id,
      ${hasRoutingSprintType ? 'trr.sprint_type' : 'NULL'} AS routing_sprint_type,
      s.project_id AS sprint_project_id,
      s.sprint_type AS sprint_type
    FROM sprint_task_routing_rules trr
    LEFT JOIN sprints s ON s.id = trr.sprint_id
    WHERE trr.id = ?
      ${hasRoutingTenant ? 'AND trr.tenant_id = ?' : ''}
      ${!hasRoutingTenant && hasSprintTenant ? 'AND (s.tenant_id = ? OR s.id IS NULL)' : ''}
    LIMIT 1
  `, ruleId, ...((hasRoutingTenant || (!hasRoutingTenant && hasSprintTenant)) ? [tenantId] : [])) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    projectId: parsePositiveInt(row.routing_project_id) ?? parsePositiveInt(row.sprint_project_id),
    sprintId: parsePositiveInt(row.routing_sprint_id),
    sprintType: normalizeScopeString(row.routing_sprint_type) ?? normalizeScopeString(row.sprint_type),
    source: 'existing_rule',
  };
}

async function getRoutingRuleScopeFromRequest(
  db: Db,
  input: Record<string, unknown>,
  tenantId: number,
): Promise<RoutingRuleScopeContext | null> {
  const sprintId = parsePositiveInt(firstPresent(input.sprint_id, input.workflow_id));
  const requestedProjectId = parsePositiveInt(input.project_id);
  const requestedSprintType = normalizeScopeString(firstPresent(input.sprint_type, input.workflow_type));

  if (sprintId != null) {
    if (!await hasTable(db, 'sprints')) return { projectId: requestedProjectId, sprintId, sprintType: requestedSprintType, source: 'request' };
    const hasSprintTenant = await hasColumn(db, 'sprints', 'tenant_id');
    const sprint = await db.get(`
      SELECT id, project_id, sprint_type
      FROM sprints
      WHERE id = ?
        ${hasSprintTenant ? 'AND tenant_id = ?' : ''}
      LIMIT 1
    `, sprintId, ...(hasSprintTenant ? [tenantId] : [])) as { id: number; project_id: number | null; sprint_type: string | null } | undefined;
    if (!sprint) return { projectId: null, sprintId, sprintType: requestedSprintType, source: 'request' };
    return {
      projectId: parsePositiveInt(sprint.project_id),
      sprintId,
      sprintType: normalizeScopeString(sprint.sprint_type) ?? requestedSprintType,
      source: 'request',
    };
  }

  return {
    projectId: requestedProjectId,
    sprintId: null,
    sprintType: requestedSprintType,
    source: 'request',
  };
}

function routingRuleScopeMatchesAssignedProject(scope: RoutingRuleScopeContext | null, canonicalAgentProjectId: number | null): boolean {
  return canonicalAgentProjectId != null
    && scope?.projectId != null
    && scope.projectId === canonicalAgentProjectId;
}

async function getRoutingTransitionScopeFromTransitionId(
  db: Db,
  transitionId: number,
  tenantId: number,
): Promise<RoutingTransitionScopeContext | null> {
  if (!await hasTable(db, 'sprint_task_transitions')) return null;
  const hasTransitionProject = await hasColumn(db, 'sprint_task_transitions', 'project_id');
  const hasTransitionSprintType = await hasColumn(db, 'sprint_task_transitions', 'sprint_type');
  const hasTransitionTenant = await hasColumn(db, 'sprint_task_transitions', 'tenant_id');
  const hasSprintTenant = await hasColumn(db, 'sprints', 'tenant_id');
  const row = await db.get(`
    SELECT
      stt.id,
      ${hasTransitionProject ? 'stt.project_id' : 'NULL'} AS transition_project_id,
      stt.sprint_id AS transition_sprint_id,
      ${hasTransitionSprintType ? 'stt.sprint_type' : 'NULL'} AS transition_sprint_type,
      s.project_id AS sprint_project_id,
      s.sprint_type AS sprint_type
    FROM sprint_task_transitions stt
    LEFT JOIN sprints s ON s.id = stt.sprint_id
    WHERE stt.id = ?
      ${hasTransitionTenant ? 'AND stt.tenant_id = ?' : ''}
      ${!hasTransitionTenant && hasSprintTenant ? 'AND (s.tenant_id = ? OR s.id IS NULL)' : ''}
    LIMIT 1
  `, transitionId, ...((hasTransitionTenant || (!hasTransitionTenant && hasSprintTenant)) ? [tenantId] : [])) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    projectId: parsePositiveInt(row.transition_project_id) ?? parsePositiveInt(row.sprint_project_id),
    sprintId: parsePositiveInt(row.transition_sprint_id),
    sprintType: normalizeScopeString(row.transition_sprint_type) ?? normalizeScopeString(row.sprint_type),
    source: 'existing_transition',
  };
}

async function getRoutingTransitionScopeFromRequest(
  db: Db,
  input: Record<string, unknown>,
  tenantId: number,
): Promise<RoutingTransitionScopeContext | null> {
  const ruleScope = await getRoutingRuleScopeFromRequest(db, input, tenantId);
  if (!ruleScope) return null;
  return {
    projectId: ruleScope.projectId,
    sprintId: ruleScope.sprintId,
    sprintType: ruleScope.sprintType,
    source: 'request',
  };
}

function routingTransitionScopeMatchesAssignedProject(scope: RoutingTransitionScopeContext | null, canonicalAgentProjectId: number | null): boolean {
  return canonicalAgentProjectId != null
    && scope?.projectId != null
    && scope.projectId === canonicalAgentProjectId;
}

type WorkflowDefinitionScopeContext = {
  projectId: number | null;
  key: string | null;
  source: 'request' | 'existing_definition';
};

async function getWorkflowDefinitionScopeFromKey(
  db: Db,
  workflowDefinitionKey: string,
  tenantId: number,
): Promise<WorkflowDefinitionScopeContext | null> {
  if (!await hasTable(db, 'sprint_types')) return null;
  const hasTenant = await hasColumn(db, 'sprint_types', 'tenant_id');
  const hasProject = await hasColumn(db, 'sprint_types', 'project_id');
  const row = await db.get(`
    SELECT key, ${hasProject ? 'project_id' : 'NULL'} AS project_id
    FROM sprint_types
    WHERE key = ?
      ${hasTenant ? 'AND tenant_id = ?' : ''}
    LIMIT 1
  `, workflowDefinitionKey, ...(hasTenant ? [tenantId] : [])) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    projectId: parsePositiveInt(row.project_id),
    key: normalizeScopeString(row.key),
    source: 'existing_definition',
  };
}

function getWorkflowDefinitionScopeFromRequest(input: Record<string, unknown>): WorkflowDefinitionScopeContext | null {
  const projectId = parsePositiveInt(input.project_id);
  const key = normalizeScopeString(firstPresent(input.key, input.sprint_type_key, input.workflow_type_key, input.workflow_definition_key));
  if (projectId == null && key == null) return null;
  return {
    projectId,
    key,
    source: 'request',
  };
}

/**
 * Resolve the owning project for an existing recurring task series. Returns
 * null when the series does not exist, which callers treat as out of scope so
 * a missing series can never be reached through a project-scoped key.
 */
/**
 * True when a task update carries only supported custom fields. This is what
 * separates "an agent recording its own run evidence" from a general task
 * edit: anything that would move status, reassign, retitle, or otherwise
 * change task columns falls outside the narrow active-task write capability
 * and still requires the broad project task management grant.
 */
const ACTIVE_CUSTOM_FIELD_WRITE_ALLOWED_BODY_KEYS = new Set(['custom_fields', 'changed_by']);

function isActiveCustomFieldsOnlyUpdate(body: Record<string, unknown>): boolean {
  const keys = Object.keys(body);
  if (keys.length === 0) return false;
  if (!Object.prototype.hasOwnProperty.call(body, 'custom_fields')) return false;
  return keys.every((key) => ACTIVE_CUSTOM_FIELD_WRITE_ALLOWED_BODY_KEYS.has(key));
}

/**
 * The non-terminal workflow statuses. Reaching `complete` or `closed` through the sprint PUT is
 * deliberately excluded: those have their own endpoints, which stamp ended_at and stand down the
 * workflow's agents, and their own capability. A status field write to 'complete' would leave a
 * workflow that reads as finished but never ended.
 *
 * Note this list is what a reopen goes *to*, not what it comes *from*: moving a completed or
 * closed workflow back to active is a supported operator action and stays supported here.
 */
const PAUSE_CAPABILITY_TARGET_STATUSES = new Set(['planning', 'planned', 'active', 'paused']);
const SPRINT_STATUS_WRITE_ALLOWED_BODY_KEYS = new Set(['status', 'note']);

/**
 * True when a workflow update carries nothing but a non-terminal status (and an optional audit
 * note). This is the whole difference between "an agent pausing the cycle it is working in" and
 * a general workflow edit: without it, granting pause would also grant renaming a workflow,
 * rewriting its repo configuration, and — via project_id — moving it into another project.
 */
function isSprintStatusOnlyUpdate(body: Record<string, unknown>): boolean {
  const keys = Object.keys(body);
  if (keys.length === 0) return false;
  if (!Object.prototype.hasOwnProperty.call(body, 'status')) return false;
  if (!keys.every((key) => SPRINT_STATUS_WRITE_ALLOWED_BODY_KEYS.has(key))) return false;
  const status = typeof body.status === 'string' ? body.status.trim().toLowerCase() : '';
  return PAUSE_CAPABILITY_TARGET_STATUSES.has(status);
}

async function getRecurringTaskSeriesProjectId(db: Db, seriesId: number): Promise<number | null> {
  try {
    const row = await db.get(`SELECT project_id FROM recurring_task_series WHERE id = ?`, seriesId) as
      { project_id: number | null } | undefined;
    const projectId = Number(row?.project_id);
    return Number.isInteger(projectId) && projectId > 0 ? projectId : null;
  } catch {
    return null;
  }
}

function workflowDefinitionScopeMatchesAssignedProject(scope: WorkflowDefinitionScopeContext | null, canonicalAgentProjectId: number | null): boolean {
  return canonicalAgentProjectId != null
    && scope?.projectId != null
    && scope.projectId === canonicalAgentProjectId;
}

type TransitionRequirementScopeContext = {
  projectId: number | null;
  sprintId: number | null;
  sprintType: string | null;
  source: 'request' | 'existing_requirement';
};

async function getTransitionRequirementScopeFromRequirementId(
  db: Db,
  requirementId: number,
  tenantId: number,
): Promise<TransitionRequirementScopeContext | null> {
  if (!await hasTable(db, 'sprint_task_transition_requirements')) return null;
  const hasRequirementProject = await hasColumn(db, 'sprint_task_transition_requirements', 'project_id');
  const hasRequirementSprintType = await hasColumn(db, 'sprint_task_transition_requirements', 'sprint_type');
  const hasRequirementTenant = await hasColumn(db, 'sprint_task_transition_requirements', 'tenant_id');
  const hasSprintTenant = await hasColumn(db, 'sprints', 'tenant_id');
  const row = await db.get(`
    SELECT
      req.id,
      ${hasRequirementProject ? 'req.project_id' : 'NULL'} AS requirement_project_id,
      req.sprint_id AS requirement_sprint_id,
      ${hasRequirementSprintType ? 'req.sprint_type' : 'NULL'} AS requirement_sprint_type,
      s.project_id AS sprint_project_id,
      s.sprint_type AS sprint_type
    FROM sprint_task_transition_requirements req
    LEFT JOIN sprints s ON s.id = req.sprint_id
    WHERE req.id = ?
      ${hasRequirementTenant ? 'AND req.tenant_id = ?' : ''}
      ${!hasRequirementTenant && hasSprintTenant ? 'AND (s.tenant_id = ? OR s.id IS NULL)' : ''}
    LIMIT 1
  `, requirementId, ...((hasRequirementTenant || (!hasRequirementTenant && hasSprintTenant)) ? [tenantId] : [])) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    projectId: parsePositiveInt(row.requirement_project_id) ?? parsePositiveInt(row.sprint_project_id),
    sprintId: parsePositiveInt(row.requirement_sprint_id),
    sprintType: normalizeScopeString(row.requirement_sprint_type) ?? normalizeScopeString(row.sprint_type),
    source: 'existing_requirement',
  };
}

async function getTransitionRequirementScopeFromRequest(
  db: Db,
  input: Record<string, unknown>,
  tenantId: number,
): Promise<TransitionRequirementScopeContext | null> {
  const sprintId = parsePositiveInt(firstPresent(input.sprint_id, input.workflow_id));
  const requestedProjectId = parsePositiveInt(input.project_id);
  const requestedSprintType = normalizeScopeString(firstPresent(input.sprint_type, input.workflow_type));

  if (sprintId != null) {
    if (!await hasTable(db, 'sprints')) return { projectId: requestedProjectId, sprintId, sprintType: requestedSprintType, source: 'request' };
    const hasSprintTenant = await hasColumn(db, 'sprints', 'tenant_id');
    const sprint = await db.get(`
      SELECT id, project_id, sprint_type
      FROM sprints
      WHERE id = ?
        ${hasSprintTenant ? 'AND tenant_id = ?' : ''}
      LIMIT 1
    `, sprintId, ...(hasSprintTenant ? [tenantId] : [])) as { id: number; project_id: number | null; sprint_type: string | null } | undefined;
    if (!sprint) return { projectId: null, sprintId, sprintType: requestedSprintType, source: 'request' };
    return {
      projectId: parsePositiveInt(sprint.project_id),
      sprintId,
      sprintType: normalizeScopeString(sprint.sprint_type) ?? requestedSprintType,
      source: 'request',
    };
  }

  if (requestedProjectId == null && requestedSprintType == null) return null;
  return {
    projectId: requestedProjectId,
    sprintId: null,
    sprintType: requestedSprintType,
    source: 'request',
  };
}

function transitionRequirementScopeMatchesAssignedProject(scope: TransitionRequirementScopeContext | null, canonicalAgentProjectId: number | null): boolean {
  return canonicalAgentProjectId != null
    && scope?.projectId != null
    && scope.projectId === canonicalAgentProjectId
    && scope.sprintType != null;
}

async function insertMcpScopeDeniedNote(db: Db, params: {
  taskId: number | null;
  identity: McpApiIdentity;
  reason: string;
}): Promise<void> {
  if (!params.taskId) return;
  const tenantId = await resolveRuntimeTenantId(db, { taskId: params.taskId });
  const tenant = await tenantInsertColumns(db, 'task_notes', tenantId);
  await db.run(`
    INSERT INTO task_notes (${tenant.columnSql}task_id, author, content)
    VALUES (${tenant.valueSql}?, ?, ?)
  `, ...tenant.values, params.taskId, 'agent-hq-mcp-auth', `Scoped MCP write refused for ${params.identity.auditActor}: ${params.reason}`);
}

async function sendMcpScopeDenied(res: Response, params: {
  db: Db;
  identity: McpApiIdentity;
  reason: string;
  requiredCapability: AgentMcpCapabilityKey;
  policyMode: 'default' | 'explicit';
  defaultPolicy: AgentMcpDefaultPolicy;
  allowedCapabilities: Set<AgentMcpCapabilityKey>;
  taskId?: number | null;
  instanceId?: number | null;
  path: string;
}): Promise<void> {
  // The audit note is best-effort; the 403 is not. Letting a failed insert propagate would
  // mean the most common denial of all — an agent naming a task that does not exist — returns
  // nothing at all, because task_notes.task_id REFERENCES tasks(id) and that insert cannot
  // succeed. The caller would get a hung socket instead of "you lack this capability", so the
  // refusal is logged and swallowed while the denial itself always goes out.
  try {
    await insertMcpScopeDeniedNote(params.db, {
      taskId: params.taskId ?? (params.instanceId ? await taskIdForInstance(params.db, params.instanceId) : null),
      identity: params.identity,
      reason: params.reason,
    });
  } catch (err) {
    console.warn(
      `[mcp-auth] could not record the MCP scope refusal for ${params.identity.auditActor} on ${params.path}:`,
      err,
    );
  }

  res.status(403).json({
    error: params.reason,
    code: 'mcp_scope_denied',
    details: {
      agent_id: params.identity.agentId,
      agent_slug: params.identity.agentSlug,
      path: params.path,
      task_id: params.taskId ?? null,
      instance_id: params.instanceId ?? null,
      required_capability: params.requiredCapability,
      policy_mode: params.policyMode,
      default_policy: params.defaultPolicy,
      allowed_capabilities: Array.from(params.allowedCapabilities),
    },
  });
}

function sendMcpTenantScopeDenied(res: Response, params: {
  identity: McpApiIdentity;
  reason: string;
  requestedTenantId: number | null;
  tenantSource: string | null;
  path: string;
}): void {
  res.status(403).json({
    error: params.reason,
    code: 'mcp_tenant_scope_denied',
    details: {
      agent_id: params.identity.agentId,
      agent_slug: params.identity.agentSlug,
      key_tenant_id: params.identity.tenantId,
      requested_tenant_id: params.requestedTenantId,
      tenant_source: params.tenantSource,
      path: params.path,
      global_admin: params.identity.globalAdminAccess,
      required_capability: 'admin.cross_tenant',
      super_admin_mcp_access: params.identity.globalAdminAccess,
    },
  });
}

export async function authorizeMcpApiRequestIfPresent(req: Request, res: Response, next: NextFunction): Promise<void> {
  const identity = getMcpIdentityFromRequest(req);
  if (!identity) return next();

  const db = getDb();
  const method = req.method.toUpperCase();
  const requestPath = req.path;

  try {
    const resolvedTenantId = await resolveTenantIdFromRequest(db, req);
    if (identity.globalAdminAccess && resolvedTenantId !== identity.tenantId) {
      console.warn(
        `[mcp-auth] super-admin cross-tenant allowed ${identity.agentSlug} ${method} ${requestPath} (key tenant=${identity.tenantId}; requested tenant=${resolvedTenantId}; capability=admin.cross_tenant)`,
      );
    }
  } catch (err) {
    const candidate = err as { status?: number; code?: string; message?: string; details?: Record<string, unknown> };
    if (candidate.status === 403 && candidate.code === 'mcp_tenant_scope_denied') {
      const details = candidate.details ?? {};
      console.warn(
        `[mcp-auth] tenant denied ${identity.agentSlug} ${method} ${requestPath} (key tenant=${identity.tenantId}; requested tenant=${details.requested_tenant_id ?? 'unknown'}; required_capability=admin.cross_tenant; super_admin=${identity.globalAdminAccess ? 'true' : 'false'})`,
      );
      return sendMcpTenantScopeDenied(res, {
        identity,
        path: requestPath,
        reason: candidate.message || 'MCP API key is not authorized for the requested tenant',
        requestedTenantId: parsePositiveInt(details.requested_tenant_id),
        tenantSource: typeof details.tenant_source === 'string' ? details.tenant_source : null,
      });
    }
    if (candidate.status === 404) {
      res.status(404).json({ error: candidate.message || 'Tenant not found', code: 'tenant_not_found' });
      return;
    }
    throw err;
  }

  const permissionState = await resolveEffectiveAgentMcpPermissionState(db, identity);
  const taskScopes = await getScopedTaskContexts(db, identity);
  const instanceScopes = await getScopedInstanceContexts(db, identity);
  const scopedTaskIds = new Set(taskScopes.map((row) => row.taskId));
  const scopedProjectIds = new Set(taskScopes.map((row) => row.projectId).filter((value): value is number => value != null));
  const scopedSprintIds = new Set(taskScopes.map((row) => row.sprintId).filter((value): value is number => value != null));
  const scopedInstanceIds = new Set(instanceScopes.map((row) => row.instanceId));
  const canonicalAgentProjectId = await getCanonicalAgentProjectId(db, identity);

  if (permissionState.enabledCapabilities.has('admin.full_access')) return next();

  const deny = async (params: {
    reason: string;
    requiredCapability: AgentMcpCapabilityKey;
    taskId?: number | null;
    instanceId?: number | null;
  }): Promise<void> => {
    console.warn(
      `[mcp-auth] denied ${identity.agentSlug} ${method} ${requestPath} (requires ${params.requiredCapability}; policy=${permissionState.policyMode}/${permissionState.defaultPolicy})`,
    );
    await sendMcpScopeDenied(res, {
            db,
            identity,
            path: requestPath,
            reason: params.reason,
            requiredCapability: params.requiredCapability,
            policyMode: permissionState.policyMode,
            defaultPolicy: permissionState.defaultPolicy,
            allowedCapabilities: permissionState.enabledCapabilities,
            taskId: params.taskId,
            instanceId: params.instanceId,
          });
  };

  // Async, and every call site awaits it. This guard used to be synchronous, which was fine
  // while deny() was too — but deny() now writes the refusal to task_notes before sending the
  // 403, so a synchronous guard has nowhere to put the returned promise and simply drops it.
  //
  // Dropping it is not a latency question, it is a crash. task_notes.task_id is NOT NULL
  // REFERENCES tasks(id), the taskId reaching deny() is parsed straight out of the request
  // path with no existence check, and denial is exactly the path taken when an agent names a
  // task it has no business naming — including one that does not exist. The insert then
  // violates the foreign key, the rejection has no handler anywhere in this process, and Node
  // terminates on it. pm2 restarts the API, dropping every in-flight request for every tenant,
  // and the caller can repeat it at will. Awaiting keeps the rejection inside the middleware,
  // where it is one failed request rather than an outage.
  const requireCapability = async (
    capability: AgentMcpCapabilityKey,
    reason: string,
    resource?: { taskId?: number | null; instanceId?: number | null },
  ): Promise<boolean> => {
    if (permissionState.enabledCapabilities.has(capability)) return true;
    await deny({
      reason,
      requiredCapability: capability,
      taskId: resource?.taskId,
      instanceId: resource?.instanceId,
    });
    return false;
  };

  if (requestPath === '/mcp/catalog' || requestPath === '/mcp/catalog/health') {
    if (!await requireCapability(
      'discovery.read_catalog',
      `Agent HQ MCP catalog discovery is disabled for ${identity.agentSlug}.`,
    )) return;
    return next();
  }

  if (requestPath === '/external/task-events' && method === 'POST') {
    if (!await requireCapability(
      'external.write_task_events',
      `External task event callbacks are disabled for ${identity.agentSlug}.`,
    )) return;
    return next();
  }

  if (requestPath === '/external/task-events/receipts' && method === 'GET') {
    if (!await requireCapability(
      'external.manage_project_task_events',
      `External task-event receipt management is disabled for ${identity.agentSlug}.`,
    )) return;
    if (canonicalAgentProjectId == null) {
      return deny({
        reason: `${identity.agentSlug} does not have an assigned project for external task-event management.`,
        requiredCapability: 'external.manage_project_task_events',
      });
    }
    return next();
  }

  const externalTaskEventReceiptMatch = requestPath.match(/^\/external\/task-events\/receipts\/(\d+)$/);
  if (externalTaskEventReceiptMatch && method === 'GET') {
    if (!await requireCapability(
      'external.manage_project_task_events',
      `External task-event receipt management is disabled for ${identity.agentSlug}.`,
    )) return;
    if (canonicalAgentProjectId == null) {
      return deny({
        reason: `${identity.agentSlug} does not have an assigned project for external task-event management.`,
        requiredCapability: 'external.manage_project_task_events',
      });
    }
    return next();
  }

  if (requestPath === '/tasks' && method === 'POST') {
    const requiredCapability: AgentMcpCapabilityKey = permissionState.enabledCapabilities.has('tasks.manage_project_tasks')
      ? 'tasks.manage_project_tasks'
      : 'tasks.create';
    if (!await requireCapability(
      requiredCapability,
      `Project task creation is disabled for ${identity.agentSlug}.`,
    )) return;
    if (canonicalAgentProjectId == null) {
      return deny({
        reason: `${identity.agentSlug} does not have an assigned project for project task creation.`,
        requiredCapability,
      });
    }
    const body = requestBodyRecord(req.body);
    if (parsePositiveInt(body.project_id) == null) {
      return deny({
        reason: `Project-scoped task creation requires project_id within the assigned project for ${identity.agentSlug}.`,
        requiredCapability,
      });
    }
    const scope = await validateProjectTaskCrudRequestScope(db, identity, body, canonicalAgentProjectId);
    if (!scope.ok) {
      return deny({
        reason: scope.reason,
        requiredCapability,
      });
    }
    return next();
  }

  // Agent CRUD inside the assigned project: the roster, each agent's record — job instructions,
  // role, model, skills, workspace and routing config — and its docs bundle.
  //
  // Deliberately not here: /provision, /provision-full and /mcp/sync, which build workspaces and
  // credentials; /mcp-permissions and /mcp-tool-allowlists, which decide what an agent may do
  // over MCP and have their own capability below. This grant edits what an agent is told to do,
  // not what it is allowed to do.
  const agentDocsMatch = requestPath.match(/^\/agents\/(\d+)\/docs$/);
  const agentRecordMatch = requestPath.match(/^\/agents\/(\d+)$/);
  const agentCollection = requestPath === '/agents' && (method === 'GET' || method === 'POST');
  if (agentCollection
    || (agentRecordMatch && ['GET', 'PUT', 'DELETE'].includes(method))
    || (agentDocsMatch && method === 'GET')) {
    const requiredCapability: AgentMcpCapabilityKey = 'agents.manage_project_agents';
    if (!await requireCapability(
      requiredCapability,
      `Project agent management is disabled for ${identity.agentSlug}.`,
    )) return;

    if (canonicalAgentProjectId == null) {
      return deny({
        reason: `${identity.agentSlug} does not have an assigned project for agent management.`,
        requiredCapability,
      });
    }

    if (method === 'POST' || method === 'PUT') {
      const body = requestBodyRecord(req.body);

      const trustField = agentTrustBearingFieldInPatch(body);
      if (trustField) {
        return deny({
          reason: `Normal Agent HQ MCP keys cannot set "${trustField}" on an agent: trust is derived from it, so writing it would grant administrative access rather than manage a project agent.`,
          requiredCapability,
        });
      }
      if (agentIdentityNameIsReserved(body)) {
        return deny({
          reason: `Normal Agent HQ MCP keys cannot name an agent after the Atlas identity: an agent carrying that name or slug resolves as trusted.`,
          requiredCapability,
        });
      }

      const requestedProjectId = parsePositiveInt(body.project_id);
      if (method === 'POST' && requestedProjectId == null) {
        return deny({
          reason: `Creating an agent requires project_id naming the assigned project for ${identity.agentSlug}.`,
          requiredCapability,
        });
      }
      if (requestedProjectId != null && requestedProjectId !== canonicalAgentProjectId) {
        return deny({
          reason: `Normal Agent HQ MCP keys can only place an agent in their assigned project.`,
          requiredCapability,
        });
      }
    }

    if (agentCollection) {
      if (method === 'POST') return next();
      const listProjectId = parsePositiveInt(req.query.project_id);
      if (listProjectId === canonicalAgentProjectId) return next();
      return deny({
        reason: `Agent listing requires project_id scoped to the assigned project for ${identity.agentSlug}.`,
        requiredCapability,
      });
    }

    const targetAgentId = Number((agentRecordMatch ?? agentDocsMatch)![1]);
    if (await agentBelongsToProject(db, identity, targetAgentId, canonicalAgentProjectId)) return next();
    return deny({
      reason: `Normal Agent HQ MCP keys can only manage agents inside their assigned project.`,
      requiredCapability,
    });
  }

  const agentMcpPolicyMatch = requestPath.match(/^\/agents\/(\d+)\/mcp-permissions$/);
  if (agentMcpPolicyMatch && ['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    const targetAgentId = Number(agentMcpPolicyMatch[1]);
    const isWrite = method !== 'GET';
    const requiredCapability: AgentMcpCapabilityKey = isWrite
      ? 'mcp_capability_policies.write'
      : permissionState.enabledCapabilities.has('mcp_capability_policies.read')
        ? 'mcp_capability_policies.read'
        : 'mcp_capability_policies.write';

    if (!await requireCapability(
      requiredCapability,
      `MCP capability policy ${isWrite ? 'mutation' : 'readback'} is disabled for ${identity.agentSlug}.`,
    )) return;

    const targetProjectId = await getTenantAgentProjectId(db, identity, targetAgentId);
    if (targetProjectId === undefined) {
      return deny({
        reason: `Agent #${targetAgentId} is outside the MCP key tenant or does not exist.`,
        requiredCapability,
      });
    }
    if (canonicalAgentProjectId == null) {
      return deny({
        reason: `${identity.agentSlug} does not have an assigned project for MCP capability policy access.`,
        requiredCapability,
      });
    }
    if (targetProjectId !== canonicalAgentProjectId) {
      return deny({
        reason: `Agent #${targetAgentId} is outside the assigned project for ${identity.agentSlug}.`,
        requiredCapability,
      });
    }

    if (!isWrite) return next();

    if (targetAgentId === identity.agentId) {
      return deny({
        reason: `${identity.agentSlug} cannot edit its own MCP capability policy.`,
        requiredCapability: 'mcp_capability_policies.write',
      });
    }

    if (method !== 'DELETE') {
      const requestedCapabilities = extractRequestedMcpPolicyCapabilities(req.body);
      if (!requestedCapabilities) {
        return deny({
          reason: 'MCP capability policy mutation requires enabled_capabilities as an array of capability keys.',
          requiredCapability: 'mcp_capability_policies.write',
        });
      }
      const unsafeCapability = requestedCapabilities.find((key) => (
        !AGENT_MCP_CAPABILITY_KEYS.has(key as AgentMcpCapabilityKey)
        || !SCOPED_MCP_POLICY_MUTABLE_CAPABILITIES.has(key as AgentMcpCapabilityKey)
      ));
      if (unsafeCapability) {
        return deny({
          reason: `Scoped MCP policy editors cannot grant or set capability "${unsafeCapability}".`,
          requiredCapability: 'mcp_capability_policies.write',
        });
      }
    }

    return next();
  }

  if (requestPath === '/tasks/project-search' && method === 'POST') {
    if (!await requireCapability(
      'tasks.search_project_tasks',
      `Project task search is disabled for ${identity.agentSlug}.`,
    )) return;
    if (canonicalAgentProjectId == null) {
      return deny({
        reason: `${identity.agentSlug} does not have an assigned project for project task search.`,
        requiredCapability: 'tasks.search_project_tasks',
      });
    }
    return next();
  }

  const activeOwnerMatch = requestPath.match(/^\/tasks\/(\d+)\/active-owner$/);
  if (activeOwnerMatch && method === 'GET') {
    const taskId = Number(activeOwnerMatch[1]);
    const hasActiveRead = permissionState.enabledCapabilities.has('tasks.read_active_context');
    const hasProjectRead = permissionState.enabledCapabilities.has('tasks.read_project_context');
    if (!hasActiveRead && !hasProjectRead) {
      return deny({
        reason: `${identity.agentSlug} is not allowed to read task MCP routes.`,
        requiredCapability: 'tasks.read_project_context',
        taskId,
      });
    }
    if (hasActiveRead && scopedTaskIds.has(taskId)) return next();
    if (hasProjectRead && canonicalAgentProjectId != null && await taskBelongsToProject(db, identity, taskId, canonicalAgentProjectId)) {
      return next();
    }
    if (hasProjectRead && canonicalAgentProjectId == null) {
      return deny({
        reason: `${identity.agentSlug} does not have an assigned project for project task context reads.`,
        requiredCapability: 'tasks.read_project_context',
        taskId,
      });
    }
    return deny({
      reason: hasProjectRead
        ? `Task #${taskId} is outside the assigned project for ${identity.agentSlug}.`
        : `Normal Agent HQ MCP keys can only access the active dispatched task for ${identity.agentSlug}.`,
      requiredCapability: hasProjectRead ? 'tasks.read_project_context' : 'tasks.read_active_context',
      taskId,
    });
  }

  const taskRelationshipMutationMatch = requestPath.match(/^\/tasks\/(\d+)\/relationships(?:\/(\d+))?$/);
  const taskMatch = requestPath.match(/^\/tasks\/(\d+)(?:\/(context|notes|history|instances|relationships|relationship-types|review-evidence|qa-evidence|deploy-evidence|live-verification|outcome))?$/);
  if (taskMatch || taskRelationshipMutationMatch) {
    const taskId = Number((taskMatch ?? taskRelationshipMutationMatch)?.[1]);
    const suffix = taskRelationshipMutationMatch ? 'relationships' : taskMatch?.[2] ?? '';
    const readAllowed = method === 'GET' && (suffix === '' || suffix === 'context' || suffix === 'notes' || suffix === 'history' || suffix === 'instances' || suffix === 'relationships' || suffix === 'relationship-types');
    const writeAllowed = (
      (suffix === 'notes' && method === 'POST')
      || (suffix === 'review-evidence' && method === 'PUT')
      || (suffix === 'qa-evidence' && method === 'PUT')
      || (suffix === 'deploy-evidence' && method === 'PUT')
      || (suffix === 'live-verification' && method === 'PUT')
      || (suffix === 'outcome' && method === 'POST')
    );
    const hasProjectTaskRead = permissionState.enabledCapabilities.has('tasks.read_project_context');
    const hasProjectTaskCrud = permissionState.enabledCapabilities.has('tasks.manage_project_tasks');
    const relationshipCrudAllowed = hasProjectTaskCrud
      && taskRelationshipMutationMatch != null
      && ((method === 'POST' && taskRelationshipMutationMatch[2] == null) || (method === 'DELETE' && taskRelationshipMutationMatch[2] != null));
    const projectCrudAllowed = suffix === '' && (method === 'PUT' || method === 'DELETE');
    // Notes are part of the lifecycle reporting stream, so they stay out of task CRUD: managing a
    // project's tasks deliberately does not imply writing into that stream. tasks.write_project_notes
    // is the separate, explicit grant for a client that files notes across the project without
    // owning a dispatched run — and it stops at notes. Evidence and outcomes fall through to the
    // dispatch-scoped path below, because those drive workflow transitions and belong to the agent
    // executing the run.
    const projectNoteWriteAllowed = permissionState.enabledCapabilities.has('tasks.write_project_notes')
      && suffix === 'notes'
      && method === 'POST';

    // An agent that owns the active dispatched run may persist supported custom
    // fields on that task without holding the broad project-task management
    // grant. Narrow by construction: it must be the agent's own active task,
    // and the body may carry nothing but custom_fields. Field-schema, tenant,
    // and audit enforcement still run downstream in the write model.
    if (
      suffix === ''
      && method === 'PUT'
      && scopedTaskIds.has(taskId)
      && permissionState.enabledCapabilities.has('tasks.write_active_custom_fields')
      && isActiveCustomFieldsOnlyUpdate(requestBodyRecord(req.body))
    ) {
      return next();
    }
    const requiredCapability: AgentMcpCapabilityKey | null = readAllowed
      ? hasProjectTaskCrud
        ? 'tasks.manage_project_tasks'
        : hasProjectTaskRead
        ? 'tasks.read_project_context'
        : 'tasks.read_active_context'
      : projectCrudAllowed || relationshipCrudAllowed
        ? 'tasks.manage_project_tasks'
      : projectNoteWriteAllowed
        ? 'tasks.write_project_notes'
      : writeAllowed
        ? 'tasks.write_active_lifecycle'
        : null;

    if (!requiredCapability) {
      return deny({
        reason: `Normal Agent HQ MCP keys cannot perform ${method} on ${requestPath} without full administrative access.`,
        requiredCapability: 'admin.full_access',
        taskId,
      });
    }

    if (!await requireCapability(requiredCapability, `${identity.agentSlug} is not allowed to ${readAllowed ? 'read' : 'write'} active task MCP routes.`, { taskId })) {
      return;
    }

    if ((readAllowed && (hasProjectTaskRead || hasProjectTaskCrud)) || projectCrudAllowed || relationshipCrudAllowed || projectNoteWriteAllowed) {
      if (canonicalAgentProjectId == null) {
        return deny({
          reason: `${identity.agentSlug} does not have an assigned project for project task ${projectCrudAllowed || relationshipCrudAllowed || projectNoteWriteAllowed ? 'CRUD' : 'context reads'}.`,
          requiredCapability,
          taskId,
        });
      }
      if (!await taskBelongsToProject(db, identity, taskId, canonicalAgentProjectId)) {
        return deny({
          reason: `Task #${taskId} is outside the assigned project for ${identity.agentSlug}.`,
          requiredCapability,
          taskId,
        });
      }
      if (method === 'PUT') {
        const scope = await validateProjectTaskCrudRequestScope(db, identity, requestBodyRecord(req.body), canonicalAgentProjectId);
        if (!scope.ok) {
          return deny({
            reason: scope.reason,
            requiredCapability,
            taskId,
          });
        }
      }
      if (relationshipCrudAllowed && method === 'POST') {
        const targetTaskId = parsePositiveInt(requestBodyRecord(req.body).target_task_id);
        if (targetTaskId != null && !await taskBelongsToProject(db, identity, targetTaskId, canonicalAgentProjectId)) {
          return deny({
            reason: `Relationship target task #${targetTaskId} is outside the assigned project for ${identity.agentSlug}.`,
            requiredCapability,
            taskId,
          });
        }
      }
      if (relationshipCrudAllowed && method === 'DELETE') {
        const relationshipId = parsePositiveInt(taskRelationshipMutationMatch?.[2]);
        if (relationshipId == null || !await relationshipBelongsToProject(db, identity, relationshipId, taskId, canonicalAgentProjectId)) {
          return deny({
            reason: `Relationship #${relationshipId ?? 'unknown'} is outside the assigned project for ${identity.agentSlug}.`,
            requiredCapability,
            taskId,
          });
        }
      }
      return next();
    }

    if (!scopedTaskIds.has(taskId)) {
      return deny({
        reason: `Normal Agent HQ MCP keys can only access the active dispatched task for ${identity.agentSlug}.`,
        requiredCapability,
        taskId,
      });
    }

    if (readAllowed || writeAllowed) return next();
    return deny({
      reason: `Normal Agent HQ MCP keys cannot perform ${method} on ${requestPath}.`,
      requiredCapability: 'admin.full_access',
      taskId,
    });
  }

  const instanceMatch = requestPath.match(/^\/instances\/(\d+)\/(start|check-in|complete)$/);
  if (instanceMatch) {
    const instanceId = Number(instanceMatch[1]);
    const action = instanceMatch[2];
    if (!await requireCapability(
      'tasks.write_active_lifecycle',
      `Lifecycle callback writes are disabled for ${identity.agentSlug}.`,
      { instanceId },
    )) return;
    const inScope = scopedInstanceIds.has(instanceId);
    const methodMatches = (action === 'start' && method === 'PUT')
      || (action === 'check-in' && method === 'POST')
      || (action === 'complete' && method === 'PUT');
    if (inScope && methodMatches) return next();

    // This denial states WHICH condition failed, and for the scope case dumps the state the
    // decision was made from.
    //
    // It is here because a production agent was refused this exact call and the refusal could
    // not be explained afterwards: by the time anyone looked, the instance had reached a terminal
    // status and the task's active_instance_id had moved on, so every input to the decision had
    // already changed. The reason string alone conflates two independent failures — an instance
    // outside the caller's scope, and a correct instance reached with the wrong HTTP method — and
    // gives no way to tell them apart, let alone to see which scope condition was false.
    const scopeDetail = inScope
      ? 'in scope'
      : `not in scope; caller agent=${identity.agentId} owns instances [${Array.from(scopedInstanceIds).join(', ') || 'none'}]`;
    console.warn(
      `[mcp-auth] lifecycle denial for ${identity.agentSlug} ${method} ${requestPath}: ` +
      `instance=${instanceId} ${scopeDetail}; method ${methodMatches ? 'matches' : `does NOT match (${action} requires ${action === 'check-in' ? 'POST' : 'PUT'})`}`,
    );
    return deny({
      reason: methodMatches
        ? `Normal Agent HQ MCP keys can only write lifecycle callbacks for the active dispatched instance owned by ${identity.agentSlug}.`
        : `${method} is not the correct method for the ${action} lifecycle callback.`,
      requiredCapability: 'tasks.write_active_lifecycle',
      instanceId,
    });
  }

  const projectMatch = requestPath.match(/^\/projects\/(\d+)$/);
  if (projectMatch && method === 'GET') {
    const projectId = Number(projectMatch[1]);
    if (!await requireCapability(
      'projects.read_active_project',
      `Project reads are disabled for ${identity.agentSlug}.`,
    )) return;
    if (scopedProjectIds.has(projectId)) return next();
    return deny({
      reason: `Normal Agent HQ MCP keys can only read the project attached to their active dispatched task.`,
      requiredCapability: 'projects.read_active_project',
    });
  }

  const projectFileMatch = requestPath.match(/^\/projects\/(\d+)\/files(?:\/(\d+)(?:\/(?:download|versions))?)?$/);
  if (projectFileMatch && ['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    const projectId = Number(projectFileMatch[1]);
    if (!await requireCapability(
      'projects.manage_active_files',
      `Project file access is disabled for ${identity.agentSlug}.`,
    )) return;
    if (scopedProjectIds.has(projectId)) return next();
    return deny({
      reason: `Normal Agent HQ MCP keys can only manage files for the project attached to their active dispatched task.`,
      requiredCapability: 'projects.manage_active_files',
    });
  }

  const workflowFileMatch = requestPath.match(/^\/projects\/(\d+)\/workflows\/(\d+)\/files(?:\/(\d+)(?:\/(?:download|versions))?)?$/);
  if (workflowFileMatch && ['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    const projectId = Number(workflowFileMatch[1]);
    const sprintId = Number(workflowFileMatch[2]);
    if (!await requireCapability(
      'projects.manage_active_files',
      `Workflow file access is disabled for ${identity.agentSlug}.`,
    )) return;
    if (scopedProjectIds.has(projectId) && scopedSprintIds.has(sprintId)) return next();
    return deny({
      reason: `Normal Agent HQ MCP keys can only manage workflow files for the project and workflow attached to their active dispatched task.`,
      requiredCapability: 'projects.manage_active_files',
      taskId: scopedTaskIds.values().next().value ?? null,
    });
  }

  // Workflow lifecycle writes — pause, resume, complete, close.
  //
  // Both path spellings are matched because req.path is not alias-normalized:
  // normalizeWorkflowRequestAliases folds workflow_id into sprint_id in the body and query only,
  // and /api/v1/workflows mounts the same router as /api/v1/sprints.
  //
  // Scope resolves in two tiers, which is what lets one branch serve both kinds of caller: a
  // dispatched agent reaches the workflow attached to its own active task, while a board-scoped
  // client — a phone connector owning no dispatched task, whose scopedSprintIds is empty by
  // construction — reaches any workflow inside its assigned project.
  const sprintLifecycleInScope = async (sprintId: number): Promise<boolean> => {
    if (scopedSprintIds.has(sprintId)) return true;
    if (canonicalAgentProjectId == null) return false;
    return await sprintBelongsToProject(db, identity, sprintId, canonicalAgentProjectId);
  };

  const sprintLifecycleMatch = requestPath.match(/^\/(?:sprints|workflows)\/(\d+)\/(close|complete)$/);
  if (sprintLifecycleMatch && method === 'POST') {
    const sprintId = Number(sprintLifecycleMatch[1]);
    if (!await requireCapability(
      'sprints.complete_active_sprint',
      `Workflow completion is disabled for ${identity.agentSlug}.`,
    )) return;
    if (await sprintLifecycleInScope(sprintId)) return next();
    return deny({
      reason: `Normal Agent HQ MCP keys can only complete or close a workflow attached to their active dispatched task or inside their assigned project.`,
      requiredCapability: 'sprints.complete_active_sprint',
    });
  }

  // A status-only patch to a non-terminal status. Anything else in the body — a rename, repo
  // configuration, or a project_id that would move the workflow to another project — is not this
  // capability and falls through to the administrative deny below.
  const sprintStatusMatch = requestPath.match(/^\/(?:sprints|workflows)\/(\d+)$/);
  if (sprintStatusMatch && method === 'PUT' && isSprintStatusOnlyUpdate(requestBodyRecord(req.body))) {
    const sprintId = Number(sprintStatusMatch[1]);
    if (!await requireCapability(
      'sprints.pause_active_sprint',
      `Workflow pause and resume are disabled for ${identity.agentSlug}.`,
    )) return;
    if (await sprintLifecycleInScope(sprintId)) return next();
    return deny({
      reason: `Normal Agent HQ MCP keys can only pause or resume a workflow attached to their active dispatched task or inside their assigned project.`,
      requiredCapability: 'sprints.pause_active_sprint',
    });
  }

  const sprintMatch = requestPath.match(/^\/(?:sprints|workflows)\/(\d+)$/);
  if (sprintMatch && method === 'GET') {
    const sprintId = Number(sprintMatch[1]);
    if (!await requireCapability(
      'sprints.read_active_sprint',
      `Sprint reads are disabled for ${identity.agentSlug}.`,
    )) return;
    if (scopedSprintIds.has(sprintId)) return next();
    return deny({
      reason: `Normal Agent HQ MCP keys can only read the sprint attached to their active dispatched task.`,
      requiredCapability: 'sprints.read_active_sprint',
    });
  }

  const routingRuleMatch = requestPath.match(/^\/(?:routing\/(?:rules|assignment-rules)|routing-rules|assignment-rules)(?:\/(\d+))?$/);
  if (routingRuleMatch && ['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    const requiredCapability: AgentMcpCapabilityKey = 'routing_rules.manage_project_scope';
    if (!await requireCapability(
      requiredCapability,
      `Assignment rule management is disabled for ${identity.agentSlug}.`,
    )) return;

    if (canonicalAgentProjectId == null) {
      return deny({
        reason: `${identity.agentSlug} does not have an assigned project for assignment rule management.`,
        requiredCapability,
      });
    }

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    const requestInput = { ...req.query, ...body } as Record<string, unknown>;
    const ruleId = parsePositiveInt(routingRuleMatch[1]);
    const existingScope = ruleId != null ? await getRoutingRuleScopeFromRuleId(db, ruleId, identity.tenantId) : null;
    const requestHasScope = firstPresent(
      requestInput.project_id,
      requestInput.sprint_id,
      requestInput.workflow_id,
      requestInput.sprint_type,
      requestInput.workflow_type,
    ) !== undefined;
    const requestedScope = requestHasScope ? await getRoutingRuleScopeFromRequest(db, requestInput, identity.tenantId) : null;
    const scopesToAuthorize = [
      ...(existingScope ? [existingScope] : []),
      ...(requestedScope ? [requestedScope] : []),
    ];

    if (ruleId != null && existingScope == null) {
      return deny({
        reason: `Assignment rule #${ruleId} is outside the MCP key tenant or does not exist.`,
        requiredCapability,
      });
    }

    if (method === 'POST' && requestedScope == null) {
      return deny({
        reason: `Assignment rule creation requires project_id or sprint_id within the assigned project for ${identity.agentSlug}.`,
        requiredCapability,
      });
    }

    if (method === 'GET' && ruleId == null && requestedScope == null) {
      return deny({
        reason: `Assignment rule listing requires project_id or sprint_id within the assigned project for ${identity.agentSlug}.`,
        requiredCapability,
      });
    }

    if (scopesToAuthorize.length === 0 || scopesToAuthorize.some((scope) => !routingRuleScopeMatchesAssignedProject(scope, canonicalAgentProjectId))) {
      return deny({
        reason: `Normal Agent HQ MCP keys can only manage assignment rules inside the assigned project for ${identity.agentSlug}.`,
        requiredCapability,
      });
    }

    return next();
  }

  const routingTransitionMatch = requestPath.match(/^\/routing\/transitions(?:\/(\d+))?$/);
  if (routingTransitionMatch && ['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    const requiredCapability: AgentMcpCapabilityKey = 'routing_transitions.manage_project_scope';
    if (!await requireCapability(
      requiredCapability,
      `Workflow transition management is disabled for ${identity.agentSlug}.`,
    )) return;

    if (canonicalAgentProjectId == null) {
      return deny({
        reason: `${identity.agentSlug} does not have an assigned project for workflow transition management.`,
        requiredCapability,
      });
    }

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    const requestInput = { ...req.query, ...body } as Record<string, unknown>;
    const transitionId = parsePositiveInt(routingTransitionMatch[1]);
    const existingScope = transitionId != null ? await getRoutingTransitionScopeFromTransitionId(db, transitionId, identity.tenantId) : null;
    const requestHasScope = firstPresent(
      requestInput.project_id,
      requestInput.sprint_id,
      requestInput.workflow_id,
      requestInput.sprint_type,
      requestInput.workflow_type,
    ) !== undefined;
    const requestedScope = requestHasScope ? await getRoutingTransitionScopeFromRequest(db, requestInput, identity.tenantId) : null;
    const scopesToAuthorize = [
      ...(existingScope ? [existingScope] : []),
      ...(requestedScope ? [requestedScope] : []),
    ];

    if (transitionId != null && existingScope == null) {
      return deny({
        reason: `Workflow transition #${transitionId} is outside the MCP key tenant or does not exist.`,
        requiredCapability,
      });
    }

    if (method === 'POST' && requestedScope == null) {
      return deny({
        reason: `Workflow transition creation requires project_id with sprint_type or sprint_id within the assigned project for ${identity.agentSlug}.`,
        requiredCapability,
      });
    }

    if (method === 'GET' && transitionId == null && requestedScope == null) {
      return deny({
        reason: `Workflow transition listing requires project_id with sprint_type or sprint_id within the assigned project for ${identity.agentSlug}.`,
        requiredCapability,
      });
    }

    if (scopesToAuthorize.length === 0 || scopesToAuthorize.some((scope) => !routingTransitionScopeMatchesAssignedProject(scope, canonicalAgentProjectId))) {
      return deny({
        reason: `Normal Agent HQ MCP keys can only manage workflow transitions inside the assigned project for ${identity.agentSlug}.`,
        requiredCapability,
      });
    }

    return next();
  }

  // A workflow definition is the type plus everything hanging off it: its task types, its field
  // schemas, its statuses (and their metadata), the outcomes that drive transitions, and the
  // relationship types its tasks can use. All of it is one editable object on the canvas and all
  // of it resolves to the project that owns the type, so the whole tree is authorized here.
  // task-types is listed separately because it is a collection PUT with no child rows.
  const workflowDefinitionMatch = requestPath.match(/^\/(?:sprints|workflows|workflow-definitions)\/(?:config|types(?:\/list)?|types\/([^/]+)(?:\/(?:task-types|(?:field-schemas|statuses|outcomes|relationship-types)(?:\/[^/]+)?))?)$/);
  if (workflowDefinitionMatch && ['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    const requiredCapability: AgentMcpCapabilityKey = method === 'GET'
      ? 'workflow_definitions.read_project_scope'
      : 'workflow_definitions.manage_project_scope';
    if (!await requireCapability(
      requiredCapability,
      `Project-scoped workflow definition ${method === 'GET' ? 'reads are' : 'edits are'} disabled for ${identity.agentSlug}.`,
    )) return;

    if (canonicalAgentProjectId == null) {
      return deny({
        reason: `${identity.agentSlug} does not have an assigned project for workflow definition access.`,
        requiredCapability,
      });
    }

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    const requestInput = { ...req.query, ...body } as Record<string, unknown>;
    const encodedKey = workflowDefinitionMatch[1];
    const workflowDefinitionKey = encodedKey ? decodeURIComponent(encodedKey) : null;
    const existingScope = workflowDefinitionKey ? await getWorkflowDefinitionScopeFromKey(db, workflowDefinitionKey, identity.tenantId) : null;
    const requestScope = getWorkflowDefinitionScopeFromRequest(requestInput);
    const scopesToAuthorize = [
      ...(existingScope ? [existingScope] : []),
      ...(requestScope ? [requestScope] : []),
    ].filter((scope) => (
      scope.projectId != null
      || scope.source !== 'existing_definition'
      || requestScope == null
    ));

    // A key in the path must resolve to a definition in this tenant whatever the method. POST is
    // no longer the exception it was when the only keyless create was POST /types: creating a
    // status, outcome, or relationship type posts *under* an existing key, and a POST naming a
    // definition that does not exist here must not fall through on a request-supplied scope.
    if (workflowDefinitionKey && existingScope == null) {
      return deny({
        reason: `Workflow definition "${workflowDefinitionKey}" is outside the MCP key tenant or does not exist.`,
        requiredCapability,
      });
    }

    // Only the keyless create — POST /types, which brings a definition into being — has to name
    // its project explicitly. A child row inherits the scope of the type in its path.
    if (method === 'POST' && workflowDefinitionKey == null && requestScope == null) {
      return deny({
        reason: `Workflow definition creation requires project_id within the assigned project for ${identity.agentSlug}.`,
        requiredCapability,
      });
    }

    if (method === 'GET' && requestPath.match(/^\/(?:sprints|workflows|workflow-definitions)\/(?:config|types(?:\/list)?)$/) && requestScope == null) {
      return deny({
        reason: `Workflow definition readback requires project_id within the assigned project for ${identity.agentSlug}.`,
        requiredCapability,
      });
    }

    if (scopesToAuthorize.length === 0 || scopesToAuthorize.some((scope) => !workflowDefinitionScopeMatchesAssignedProject(scope, canonicalAgentProjectId))) {
      return deny({
        reason: `Normal Agent HQ MCP keys can only access workflow definitions inside the assigned project for ${identity.agentSlug}.`,
        requiredCapability,
      });
    }

    return next();
  }

  const transitionRequirementMatch = requestPath.match(/^\/routing\/transition-requirements(?:\/(\d+))?$/);
  if (transitionRequirementMatch && ['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    const hasManageTransitionRequirements = permissionState.enabledCapabilities.has('transition_requirements.manage_project_scope');
    if (method === 'GET' && !hasManageTransitionRequirements && permissionState.enabledCapabilities.has('workflow.read_active_configuration')) {
      const sprintId = parsePositiveInt(req.query.sprint_id);
      const projectId = parsePositiveInt(req.query.project_id);
      const sprintAllowed = sprintId != null && scopedSprintIds.has(sprintId);
      const projectAllowed = projectId != null && scopedProjectIds.has(projectId);
      if (sprintAllowed && projectAllowed) return next();
      return deny({
        reason: `Normal Agent HQ MCP keys can only read workflow configuration scoped to the active task's sprint and project.`,
        requiredCapability: 'workflow.read_active_configuration',
      });
    }

    const requiredCapability: AgentMcpCapabilityKey = 'transition_requirements.manage_project_scope';
    if (!await requireCapability(
      requiredCapability,
      `Project-scoped transition requirement CRUD is disabled for ${identity.agentSlug}.`,
    )) return;

    if (canonicalAgentProjectId == null) {
      return deny({
        reason: `${identity.agentSlug} does not have an assigned project for transition requirement CRUD.`,
        requiredCapability,
      });
    }

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    const requestInput = { ...req.query, ...body } as Record<string, unknown>;
    const requirementId = parsePositiveInt(transitionRequirementMatch[1]);
    const existingScope = requirementId != null ? await getTransitionRequirementScopeFromRequirementId(db, requirementId, identity.tenantId) : null;
    const requestScope = await getTransitionRequirementScopeFromRequest(db, requestInput, identity.tenantId);
    const isCollectionRead = method === 'GET' && requirementId == null;

    if (requirementId != null && existingScope == null) {
      return deny({
        reason: `Transition requirement #${requirementId} is outside the MCP key tenant or does not exist.`,
        requiredCapability,
      });
    }

    if (requestScope == null) {
      const action = isCollectionRead
        ? 'listing'
        : method === 'POST'
          ? 'creation'
          : method === 'PUT'
            ? 'update'
            : 'delete';
      return deny({
        reason: `Transition requirement ${action} requires explicit project_id plus sprint_type, or sprint_id/workflow_id within the assigned project for ${identity.agentSlug}.`,
        requiredCapability,
      });
    }

    const scopesToAuthorize = [
      ...(existingScope ? [existingScope] : []),
      requestScope,
    ];
    if (scopesToAuthorize.some((scope) => !transitionRequirementScopeMatchesAssignedProject(scope, canonicalAgentProjectId))) {
      return deny({
        reason: `Normal Agent HQ MCP keys can only manage transition requirements inside the assigned project for ${identity.agentSlug}.`,
        requiredCapability,
      });
    }

    return next();
  }

  if ((requestPath === '/routing/transitions' || requestPath === '/routing/transition-requirements') && method === 'GET') {
    if (!await requireCapability(
      'workflow.read_active_configuration',
      `Workflow configuration reads are disabled for ${identity.agentSlug}.`,
    )) return;
    const sprintId = parsePositiveInt(req.query.sprint_id);
    const projectId = parsePositiveInt(req.query.project_id);
    const sprintAllowed = sprintId != null && scopedSprintIds.has(sprintId);
    const projectAllowed = projectId != null && scopedProjectIds.has(projectId);
    if (sprintAllowed && projectAllowed) return next();
    return deny({
      reason: `Normal Agent HQ MCP keys can only read workflow configuration scoped to the active task's sprint and project.`,
      requiredCapability: 'workflow.read_active_configuration',
    });
  }

  // Routing graph, traces, preview and audit all name a project or a workflow and are confined
  // to it. Scope resolves in two tiers, as it does for workflow lifecycle: the dispatched task's
  // project or workflow first, then the assigned project.
  //
  // The second tier is not a widening. Both branches below already told the caller they were
  // "scoped to their assigned project", but only ever checked the dispatch-derived sets, which
  // getScopedTaskContexts builds from tasks the agent has queued, dispatched or running. Those
  // are empty between runs, so an agent could analyze the graph it routes through only while
  // mid-run, and a board-scoped client — which owns no dispatched task at all — never could.
  const routingScopeInScope = async (projectId: number | null, sprintId: number | null): Promise<boolean> => {
    if (projectId != null && scopedProjectIds.has(projectId)) return true;
    if (sprintId != null && scopedSprintIds.has(sprintId)) return true;
    if (canonicalAgentProjectId == null) return false;
    if (projectId != null && projectId === canonicalAgentProjectId) return true;
    if (sprintId != null) return await sprintBelongsToProject(db, identity, sprintId, canonicalAgentProjectId);
    return false;
  };

  if ((requestPath === '/routing/graph' || requestPath === '/routing/trace')
    && (method === 'GET' || (method === 'POST' && requestPath === '/routing/trace'))) {
    if (!await requireCapability(
      'workflow.analyze_routing_graph',
      `Routing graph analysis is disabled for ${identity.agentSlug}.`,
    )) return;
    const graphSprintId = parsePositiveInt(req.query.sprint_id ?? req.query.workflow_id);
    const graphProjectId = parsePositiveInt(req.query.project_id);
    if (await routingScopeInScope(graphProjectId, graphSprintId)) return next();
    return deny({
      reason: `Normal Agent HQ MCP keys can only analyze routing graphs scoped to their assigned project or the active task's workflow.`,
      requiredCapability: 'workflow.analyze_routing_graph',
    });
  }

  // Previewing a routing change, and reading the audit trail of changes already made.
  // Preview runs the real mutation in a transaction that never commits, so it reads like a
  // write and is scoped like one: the key must own the project or workflow it names.
  if ((requestPath === '/routing/preview' && method === 'POST')
    || (requestPath === '/routing/audit' && method === 'GET')) {
    if (!await requireCapability(
      'workflow.edit_routing_config',
      `Routing config preview and audit are disabled for ${identity.agentSlug}.`,
    )) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const previewProjectId = parsePositiveInt(body.project_id ?? req.query.project_id);
    const previewSprintId = parsePositiveInt(
      body.sprint_id ?? body.workflow_id ?? req.query.sprint_id ?? req.query.workflow_id,
    );
    if (await routingScopeInScope(previewProjectId, previewSprintId)) return next();
    return deny({
      reason: `Normal Agent HQ MCP keys can only preview or audit routing changes inside their assigned project or the active task's workflow.`,
      requiredCapability: 'workflow.edit_routing_config',
    });
  }

  // Replaying a task's path is a routing-graph analysis of that task, so it needs the
  // analyze capability on top of the ordinary task-read scoping applied below.
  const taskTraceMatch = requestPath.match(/^\/tasks\/(\d+)\/trace$/);
  if (taskTraceMatch && method === 'GET') {
    const taskId = Number(taskTraceMatch[1]);
    if (!await requireCapability(
      'workflow.analyze_routing_graph',
      `Routing graph analysis is disabled for ${identity.agentSlug}.`,
      { taskId },
    )) return;
    if (scopedTaskIds.has(taskId)) return next();
    if (permissionState.enabledCapabilities.has('tasks.read_project_context')
      || permissionState.enabledCapabilities.has('tasks.manage_project_tasks')) {
      if (canonicalAgentProjectId == null) {
        return deny({
          reason: `${identity.agentSlug} does not have an assigned project for task path replay.`,
          requiredCapability: 'workflow.analyze_routing_graph',
          taskId,
        });
      }
      if (!await taskBelongsToProject(db, identity, taskId, canonicalAgentProjectId)) {
        return deny({
          reason: `Task #${taskId} is outside the assigned project for ${identity.agentSlug}.`,
          requiredCapability: 'workflow.analyze_routing_graph',
          taskId,
        });
      }
      return next();
    }
    return deny({
      reason: `Normal Agent HQ MCP keys can only replay tasks they can already read.`,
      requiredCapability: 'workflow.analyze_routing_graph',
      taskId,
    });
  }

  const recurringTaskSeriesMatch = requestPath.match(/^\/recurring-task-series(?:\/(preview|\d+)(?:\/(history|preview|enable|disable|run-now))?)?$/);
  if (recurringTaskSeriesMatch && ['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    const idSegment = recurringTaskSeriesMatch[1] ?? null;
    const subResource = recurringTaskSeriesMatch[2] ?? null;
    const seriesId = idSegment && idSegment !== 'preview' ? Number(idSegment) : null;
    // Schedule previews are non-mutating even though they are POSTed, so they
    // sit with reads. Everything else that is not a GET mutates series state or
    // generates real tasks (run-now) and requires the manage capability.
    const isPreview = idSegment === 'preview' || subResource === 'preview';
    const requiredCapability: AgentMcpCapabilityKey = method === 'GET' || isPreview
      ? 'recurring_task_series.read_project_scope'
      : 'recurring_task_series.manage_project_scope';
    if (!await requireCapability(
      requiredCapability,
      `Project-scoped recurring task series ${requiredCapability.endsWith('read_project_scope') ? 'reads are' : 'management is'} disabled for ${identity.agentSlug}.`,
    )) return;

    if (canonicalAgentProjectId == null) {
      return deny({
        reason: `${identity.agentSlug} does not have an assigned project for recurring task series access.`,
        requiredCapability,
      });
    }

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    // For an existing series the authoritative scope is the stored project, not
    // anything the caller supplied. For list/create the caller must name the
    // project explicitly so a scoped key can never enumerate other projects.
    const scopedProjectId = seriesId != null
      ? await getRecurringTaskSeriesProjectId(db, seriesId)
      : parsePositiveInt(body.project_id ?? req.query.project_id);

    if (scopedProjectId == null) {
      return deny({
        reason: seriesId != null
          ? `Recurring task series ${seriesId} is not visible to ${identity.agentSlug}.`
          : `Normal Agent HQ MCP keys must supply an explicit project_id scoped to the assigned project for recurring task series access.`,
        requiredCapability,
      });
    }

    if (scopedProjectId !== canonicalAgentProjectId) {
      return deny({
        reason: `Normal Agent HQ MCP keys can only access recurring task series inside the assigned project for ${identity.agentSlug}.`,
        requiredCapability,
      });
    }

    return next();
  }

  // Board collection reads.
  //
  // Every other read capability resolves to a single record or to the agent's own dispatched
  // task, which leaves no way to answer "what is on my board" — the first thing a remote client
  // asks and the last thing a runtime agent needs. These are the collection endpoints, gated on
  // their own capability and, wherever the route can name a project, required to name the
  // assigned one. `workflow_id` has already been folded into `sprint_id` by
  // normalizeWorkflowRequestAliases, so only the sprint spelling is read here.
  if (method === 'GET' && (
    requestPath === '/projects'
    || requestPath === '/tasks'
    || requestPath === '/sprints'
    || requestPath === '/workflows'
    || requestPath === '/sprints/workflow-metadata'
    || requestPath === '/workflows/workflow-metadata'
  )) {
    if (!await requireCapability(
      'projects.read_project_board',
      `Project board reads are disabled for ${identity.agentSlug}.`,
    )) return;

    // The project list is tenant-filtered downstream and carries no task content, so the
    // assigned-project scope adds nothing to it.
    if (requestPath === '/projects') return next();

    if (canonicalAgentProjectId == null) {
      return deny({
        reason: `${identity.agentSlug} does not have an assigned project for project board reads.`,
        requiredCapability: 'projects.read_project_board',
      });
    }

    if (requestPath === '/sprints/workflow-metadata' || requestPath === '/workflows/workflow-metadata') {
      const metadataSprintId = parsePositiveInt(req.query.sprint_id);
      // With no workflow selector the response is tenant-level workflow-type configuration —
      // the same shape workflow_definitions.read_project_scope already exposes. With one, it
      // must resolve inside the assigned project.
      if (metadataSprintId == null) return next();
      if (!await sprintBelongsToProject(db, identity, metadataSprintId, canonicalAgentProjectId)) {
        return deny({
          reason: `Workflow #${metadataSprintId} is outside the assigned project for ${identity.agentSlug}.`,
          requiredCapability: 'projects.read_project_board',
        });
      }
      return next();
    }

    const boardProjectId = parsePositiveInt(req.query.project_id);
    if (boardProjectId == null) {
      return deny({
        reason: `Project board reads require an explicit project_id scoped to the assigned project for ${identity.agentSlug}.`,
        requiredCapability: 'projects.read_project_board',
      });
    }
    if (boardProjectId !== canonicalAgentProjectId) {
      return deny({
        reason: `Project board reads are limited to the assigned project for ${identity.agentSlug}.`,
        requiredCapability: 'projects.read_project_board',
      });
    }
    return next();
  }

  return deny({
    reason: `Normal Agent HQ MCP keys cannot access ${method} ${requestPath}. Full administrative MCP access is required for this route.`,
    requiredCapability: 'admin.full_access',
  });
}

export async function authenticateMcpApiKeyIfPresent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { key, presented } = extractMcpApiKeyFromRequest(req);
    if (!presented) return next();
    if (!key) throw new McpApiAuthError('MCP API key is required', 401, 'mcp_api_key_missing');

    req.mcpIdentity = await resolveMcpApiIdentityForKey(getDb(), key);
    next();
  } catch (err) {
    const authErr = err instanceof McpApiAuthError
      ? err
      : new McpApiAuthError(err instanceof Error ? err.message : String(err));
    res.status(authErr.statusCode).json({
      error: authErr.message,
      code: authErr.code,
    });
  }
}
