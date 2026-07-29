import crypto from 'crypto';
import type Database from 'better-sqlite3';
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

export interface McpApiIdentity {
  keyId: number;
  agentId: number;
  tenantId: number;
  agentName: string;
  agentSlug: string;
  systemRole: string | null;
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

function hasTable(db: Database.Database, table: string): boolean {
  try {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { name: string } | undefined;
    return Boolean(row);
  } catch {
    return false;
  }
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
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

export function createMcpApiKeyValue(): string {
  return `ahq_mcp_${crypto.randomBytes(32).toString('base64url')}`;
}

export function ensureMcpApiKeyTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_api_keys (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id     INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name         TEXT NOT NULL DEFAULT '',
      key_prefix   TEXT NOT NULL DEFAULT '',
      key_hash     TEXT NOT NULL UNIQUE,
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_agent ON mcp_api_keys(agent_id);
    CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_enabled ON mcp_api_keys(enabled);
  `);

  if (!hasColumn(db, 'mcp_api_keys', 'tenant_id')) {
    // Do not add a REFERENCES constraint here: initSchema may call this helper before
    // the tenants table exists in fresh/test databases. Tenant scope is enforced in
    // MCP auth, and tenant rows are validated through tenantContext at request time.
    db.exec(`ALTER TABLE mcp_api_keys ADD COLUMN tenant_id INTEGER`);
  }
  if (!hasColumn(db, 'mcp_api_keys', 'global_admin')) {
    db.exec(`ALTER TABLE mcp_api_keys ADD COLUMN global_admin INTEGER NOT NULL DEFAULT 0`);
  }

  const agentsTableReady = hasTable(db, 'agents');
  if (agentsTableReady && !hasColumn(db, 'agents', 'global_mcp_admin')) {
    db.exec(`ALTER TABLE agents ADD COLUMN global_mcp_admin INTEGER NOT NULL DEFAULT 0`);
  }

  if (agentsTableReady && hasColumn(db, 'agents', 'tenant_id')) {
    db.prepare(`
      UPDATE mcp_api_keys
      SET tenant_id = (
        SELECT a.tenant_id
        FROM agents a
        WHERE a.id = mcp_api_keys.agent_id
      )
      WHERE tenant_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM agents a
          WHERE a.id = mcp_api_keys.agent_id
            AND a.tenant_id IS NOT NULL
        )
    `).run();
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_tenant ON mcp_api_keys(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_global_admin ON mcp_api_keys(global_admin);
  `);
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
    key: 'workflow_definitions.read_project_scope',
    group: 'Workflow',
    label: 'Read project workflow definitions',
    description: 'Allows reading workflow definitions and configurable metadata only when scoped to the MCP agent\'s assigned project and tenant. Does not allow tenant-wide, cross-project, cross-tenant, or mutation access.',
    endpoints: [
      'GET /api/v1/sprints/config',
      'GET /api/v1/sprints/types/list',
      'GET /api/v1/sprints/types/:key',
      'GET /api/v1/sprints/types/:key/task-types',
      'GET /api/v1/sprints/types/:key/field-schemas',
      'GET /api/v1/sprints/types/:key/field-schemas/:schemaId',
      'GET /api/v1/workflows/config',
      'GET /api/v1/workflows/types/list',
      'GET /api/v1/workflows/types/:key',
      'GET /api/v1/workflows/types/:key/task-types',
      'GET /api/v1/workflows/types/:key/field-schemas',
      'GET /api/v1/workflows/types/:key/field-schemas/:schemaId',
      'GET /api/v1/workflow-definitions/config',
      'GET /api/v1/workflow-definitions/types',
      'GET /api/v1/workflow-definitions/types/:key',
      'GET /api/v1/workflow-definitions/types/:key/task-types',
      'GET /api/v1/workflow-definitions/types/:key/field-schemas',
      'GET /api/v1/workflow-definitions/types/:key/field-schemas/:schemaId',
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
    description: 'Allows creating, updating, and deleting workflow definitions only inside the MCP agent\'s assigned project and tenant. Does not allow tenant-wide definitions, global definitions, cross-project edits, cross-tenant edits, or unrelated admin routes.',
    endpoints: [
      'POST /api/v1/sprints/types',
      'PUT /api/v1/sprints/types/:key',
      'DELETE /api/v1/sprints/types/:key',
      'PUT /api/v1/sprints/types/:key/task-types',
      'POST /api/v1/sprints/types/:key/field-schemas',
      'PUT /api/v1/sprints/types/:key/field-schemas/:schemaId',
      'DELETE /api/v1/sprints/types/:key/field-schemas/:schemaId',
      'POST /api/v1/workflows/types',
      'PUT /api/v1/workflows/types/:key',
      'DELETE /api/v1/workflows/types/:key',
      'PUT /api/v1/workflows/types/:key/task-types',
      'POST /api/v1/workflows/types/:key/field-schemas',
      'PUT /api/v1/workflows/types/:key/field-schemas/:schemaId',
      'DELETE /api/v1/workflows/types/:key/field-schemas/:schemaId',
      'POST /api/v1/workflow-definitions/types',
      'PUT /api/v1/workflow-definitions/types/:key',
      'DELETE /api/v1/workflow-definitions/types/:key',
      'PUT /api/v1/workflow-definitions/types/:key/task-types',
      'POST /api/v1/workflow-definitions/types/:key/field-schemas',
      'PUT /api/v1/workflow-definitions/types/:key/field-schemas/:schemaId',
      'DELETE /api/v1/workflow-definitions/types/:key/field-schemas/:schemaId',
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

function ensureAgentMcpCapabilityPolicyTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_mcp_capability_policies (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id       INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      capability_key TEXT NOT NULL,
      enabled        INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(agent_id, capability_key)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_mcp_capability_policies_agent
      ON agent_mcp_capability_policies(agent_id);
  `);
}

type AgentIdentityFields = {
  agentName: string;
  agentSlug: string;
  systemRole: string | null;
  isTrusted: boolean;
  isGlobalAdmin: boolean;
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
  const isTrusted = systemRole === ATLAS_SYSTEM_ROLE || systemRole === 'admin' || agentSlug === ATLAS_AGENT_SLUG || agentName === ATLAS_AGENT_NAME;
  const isGlobalAdmin = Number(row.key_global_admin ?? 0) === 1 || Number(row.agent_global_mcp_admin ?? 0) === 1;

  return {
    agentName,
    agentSlug,
    systemRole,
    isTrusted,
    isGlobalAdmin,
  };
}

function resolveAgentMcpDefaultPolicy(isTrusted: boolean): AgentMcpDefaultPolicy {
  return isTrusted ? 'trusted_admin' : 'scoped_runtime';
}

function loadAgentPermissionContext(db: Database.Database, agentId: number): {
  agentId: number;
  agentName: string;
  agentSlug: string;
  defaultPolicy: AgentMcpDefaultPolicy;
} {
  const hasAgentSlug = hasColumn(db, 'agents', 'slug');
  const hasOpenClawAgentId = hasColumn(db, 'agents', 'openclaw_agent_id');
  const hasSessionKey = hasColumn(db, 'agents', 'session_key');
  const hasSystemRole = hasColumn(db, 'agents', 'system_role');

  const row = db.prepare(`
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
  `).get(agentId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new Error(`Agent #${agentId} not found`);
  }

  const fields = resolveAgentIdentityFields(row);
  return {
    agentId,
    agentName: fields.agentName,
    agentSlug: fields.agentSlug,
    defaultPolicy: resolveAgentMcpDefaultPolicy(fields.isTrusted),
  };
}

function loadExplicitAgentMcpCapabilityRows(db: Database.Database, agentId: number): Array<{ capability_key: string; enabled: number; updated_at: string | null }> {
  ensureAgentMcpCapabilityPolicyTable(db);
  return db.prepare(`
    SELECT capability_key, enabled, updated_at
    FROM agent_mcp_capability_policies
    WHERE agent_id = ?
    ORDER BY capability_key ASC
  `).all(agentId) as Array<{ capability_key: string; enabled: number; updated_at: string | null }>;
}

function buildAgentMcpPermissionPolicySnapshot(
  db: Database.Database,
  context: { agentId: number; agentName: string; agentSlug: string; defaultPolicy: AgentMcpDefaultPolicy },
): AgentMcpPermissionPolicySnapshot {
  const explicitRows = loadExplicitAgentMcpCapabilityRows(db, context.agentId);
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

function hasExplicitAgentMcpCapability(db: Database.Database, agentId: number, capability: AgentMcpCapabilityKey): boolean {
  if (!hasTable(db, 'agent_mcp_capability_policies')) return false;
  const row = db.prepare(`
    SELECT enabled
    FROM agent_mcp_capability_policies
    WHERE agent_id = ? AND capability_key = ?
    LIMIT 1
  `).get(agentId, capability) as { enabled: number } | undefined;
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
export function getAgentMcpServerToolAllowlists(db: Database.Database, agentId: number): AgentMcpServerToolAllowlist[] {
  const rows = db.prepare(`
    SELECT a.mcp_server_id, a.overrides, a.enabled, s.name AS server_name, s.slug AS server_slug
    FROM agent_mcp_assignments a
    LEFT JOIN mcp_servers s ON s.id = a.mcp_server_id
    WHERE a.agent_id = ?
    ORDER BY COALESCE(s.name, ''), a.mcp_server_id
  `).all(agentId) as Array<{
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
export function replaceAgentMcpServerToolAllowlist(
  db: Database.Database,
  agentId: number,
  mcpServerId: number,
  toolAllowlist: string[],
): AgentMcpServerToolAllowlist[] {
  const row = db.prepare(`
    SELECT overrides FROM agent_mcp_assignments WHERE agent_id = ? AND mcp_server_id = ?
  `).get(agentId, mcpServerId) as { overrides: string | null } | undefined;
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

  db.prepare(`
    UPDATE agent_mcp_assignments SET overrides = ? WHERE agent_id = ? AND mcp_server_id = ?
  `).run(JSON.stringify(overrides), agentId, mcpServerId);

  return getAgentMcpServerToolAllowlists(db, agentId);
}

export function getAgentMcpPermissionPolicy(db: Database.Database, agentId: number): AgentMcpPermissionPolicySnapshot {
  const context = loadAgentPermissionContext(db, agentId);
  return buildAgentMcpPermissionPolicySnapshot(db, context);
}

export function replaceAgentMcpPermissionPolicy(
  db: Database.Database,
  agentId: number,
  enabledCapabilityKeys: readonly string[],
): AgentMcpPermissionPolicySnapshot {
  const context = loadAgentPermissionContext(db, agentId);
  ensureAgentMcpCapabilityPolicyTable(db);
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

  const save = db.transaction(() => {
    db.prepare(`DELETE FROM agent_mcp_capability_policies WHERE agent_id = ?`).run(agentId);
    const insert = db.prepare(`
      INSERT INTO agent_mcp_capability_policies (agent_id, capability_key, enabled)
      VALUES (?, ?, ?)
    `);
    for (const capability of AGENT_MCP_CAPABILITY_CATALOG) {
      insert.run(agentId, capability.key, normalized.has(capability.key) ? 1 : 0);
    }
  });
  save();

  return buildAgentMcpPermissionPolicySnapshot(db, context);
}

export function resetAgentMcpPermissionPolicy(db: Database.Database, agentId: number): AgentMcpPermissionPolicySnapshot {
  const context = loadAgentPermissionContext(db, agentId);
  ensureAgentMcpCapabilityPolicyTable(db);
  db.prepare(`DELETE FROM agent_mcp_capability_policies WHERE agent_id = ?`).run(agentId);
  return buildAgentMcpPermissionPolicySnapshot(db, context);
}

function resolveEffectiveAgentMcpPermissionState(db: Database.Database, identity: McpApiIdentity): {
  policyMode: 'default' | 'explicit';
  defaultPolicy: AgentMcpDefaultPolicy;
  enabledCapabilities: Set<AgentMcpCapabilityKey>;
} {
  const snapshot = buildAgentMcpPermissionPolicySnapshot(db, {
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

function shapeIdentity(db: Database.Database, row: Record<string, unknown>): McpApiIdentity {
  const { agentName, agentSlug, systemRole, isTrusted, isGlobalAdmin } = resolveAgentIdentityFields(row);
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
    globalAdminAccess: isGlobalAdmin || hasExplicitAgentMcpCapability(db, Number(row.agent_id), 'admin.cross_tenant'),
    auditActor: agentSlug,
    authorityActor: isTrusted ? ATLAS_AGENT_NAME : agentSlug,
  };
}

export function resolveMcpApiIdentityForKey(
  db: Database.Database,
  apiKey: string,
  options: { updateLastUsed?: boolean } = {},
): McpApiIdentity {
  ensureMcpApiKeyTable(db);
  ensureTenantSchema(db);
  const normalizedKey = apiKey.trim();
  if (!normalizedKey) {
    throw new McpApiAuthError('MCP API key is required', 401, 'mcp_api_key_missing');
  }

  const hasAgentSlug = hasColumn(db, 'agents', 'slug');
  const hasOpenClawAgentId = hasColumn(db, 'agents', 'openclaw_agent_id');
  const hasSessionKey = hasColumn(db, 'agents', 'session_key');
  const hasSystemRole = hasColumn(db, 'agents', 'system_role');
  const hasAgentEnabled = hasColumn(db, 'agents', 'enabled');
  const hasDeletedAt = hasColumn(db, 'agents', 'deleted_at');
  const hasAgentTenant = hasColumn(db, 'agents', 'tenant_id');
  const hasAgentGlobalMcpAdmin = hasColumn(db, 'agents', 'global_mcp_admin');

  const row = db.prepare(`
    SELECT
      k.id AS key_id,
      k.agent_id AS agent_id,
      k.tenant_id AS key_tenant_id,
      k.global_admin AS key_global_admin,
      k.enabled AS key_enabled,
      k.revoked_at AS revoked_at,
      a.name AS agent_name,
      ${hasAgentTenant ? 'a.tenant_id' : 'NULL'} AS agent_tenant_id,
      ${hasAgentGlobalMcpAdmin ? 'a.global_mcp_admin' : '0'} AS agent_global_mcp_admin,
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
  `).get(hashMcpApiKey(normalizedKey)) as Record<string, unknown> | undefined;

  if (!row) {
    throw new McpApiAuthError('Invalid MCP API key', 401, 'mcp_api_key_invalid');
  }
  if (Number(row.key_enabled) !== 1 || row.revoked_at != null) {
    throw new McpApiAuthError('MCP API key is disabled or revoked', 403, 'mcp_api_key_disabled');
  }
  if (!row.agent_id || !row.agent_name) {
    throw new McpApiAuthError('MCP API key is not mapped to an agent', 403, 'mcp_api_key_unmapped');
  }
  if (Number(row.agent_enabled) === 0 || row.deleted_at != null) {
    throw new McpApiAuthError('MCP API key is mapped to a disabled agent', 403, 'mcp_agent_disabled');
  }

  const rowTenantId = parsePositiveInt(row.key_tenant_id);
  const agentTenantId = parsePositiveInt(row.agent_tenant_id);
  if (rowTenantId && agentTenantId && rowTenantId !== agentTenantId && Number(row.key_global_admin) !== 1 && Number(row.agent_global_mcp_admin ?? 0) !== 1) {
    throw new McpApiAuthError('MCP API key tenant binding does not match its owning agent', 403, 'mcp_api_key_tenant_mismatch');
  }

  if (!rowTenantId && agentTenantId) {
    db.prepare(`UPDATE mcp_api_keys SET tenant_id = ?, updated_at = datetime('now') WHERE id = ?`).run(agentTenantId, row.key_id);
    row.key_tenant_id = agentTenantId;
  }

  if (options.updateLastUsed !== false) {
    db.prepare(`UPDATE mcp_api_keys SET last_used_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(row.key_id);
  }

  return shapeIdentity(db, row);
}

export function issueMcpApiKeyForAgent(
  db: Database.Database,
  agentId: number,
  name = 'Agent HQ MCP',
): { apiKey: string; keyId: number; keyPrefix: string } {
  ensureMcpApiKeyTable(db);
  ensureTenantSchema(db);
  const agent = db.prepare(`SELECT id, tenant_id FROM agents WHERE id = ?`).get(agentId) as { id: number; tenant_id: number | null } | undefined;
  if (!agent) throw new Error(`Cannot issue MCP API key: agent #${agentId} not found`);
  const tenantId = parsePositiveInt(agent.tenant_id);
  if (!tenantId) throw new Error(`Cannot issue MCP API key: agent #${agentId} is not bound to a tenant`);

  const apiKey = createMcpApiKeyValue();
  const keyPrefix = apiKey.slice(0, 16);
  const result = db.prepare(`
    INSERT INTO mcp_api_keys (agent_id, tenant_id, name, key_prefix, key_hash)
    VALUES (?, ?, ?, ?, ?)
  `).run(agentId, tenantId, name, keyPrefix, hashMcpApiKey(apiKey));

  return {
    apiKey,
    keyId: Number(result.lastInsertRowid),
    keyPrefix,
  };
}

function findAgentIdForConfiguredRuntimeKey(
  db: Database.Database,
  env: NodeJS.ProcessEnv,
): number | null {
  const explicitId = Number.parseInt(env.AGENT_HQ_MCP_API_KEY_AGENT_ID ?? '', 10);
  if (Number.isInteger(explicitId) && explicitId > 0) {
    const row = db.prepare(`SELECT id FROM agents WHERE id = ? LIMIT 1`).get(explicitId) as { id: number } | undefined;
    if (row?.id) return Number(row.id);
  }

  const hasAgentSlug = hasColumn(db, 'agents', 'slug');
  const hasOpenClawAgentId = hasColumn(db, 'agents', 'openclaw_agent_id');
  const hasSessionKey = hasColumn(db, 'agents', 'session_key');
  const hasSystemRole = hasColumn(db, 'agents', 'system_role');

  const configuredSlug = env.AGENT_HQ_MCP_API_KEY_AGENT_SLUG?.trim();
  if (hasAgentSlug && configuredSlug) {
    const row = db.prepare(`SELECT id FROM agents WHERE slug = ? LIMIT 1`).get(configuredSlug) as { id: number } | undefined;
    if (row?.id) return Number(row.id);
  }

  const configuredOpenClawAgentId = env.AGENT_HQ_MCP_API_KEY_AGENT_OPENCLAW_ID?.trim();
  if (hasOpenClawAgentId && configuredOpenClawAgentId) {
    const row = db.prepare(`SELECT id FROM agents WHERE openclaw_agent_id = ? LIMIT 1`).get(configuredOpenClawAgentId) as { id: number } | undefined;
    if (row?.id) return Number(row.id);
  }

  const configuredSessionKey = env.AGENT_HQ_MCP_API_KEY_AGENT_SESSION_KEY?.trim();
  if (hasSessionKey && configuredSessionKey) {
    const row = db.prepare(`SELECT id FROM agents WHERE session_key = ? LIMIT 1`).get(configuredSessionKey) as { id: number } | undefined;
    if (row?.id) return Number(row.id);
  }

  if (hasSystemRole) {
    const atlasBySystemRole = db.prepare(`SELECT id FROM agents WHERE system_role = ? ORDER BY id ASC LIMIT 1`).get(ATLAS_SYSTEM_ROLE) as { id: number } | undefined;
    if (atlasBySystemRole?.id) return Number(atlasBySystemRole.id);
  }

  if (hasOpenClawAgentId) {
    const atlasByOpenClawId = db.prepare(`SELECT id FROM agents WHERE openclaw_agent_id = ? ORDER BY id ASC LIMIT 1`).get(ATLAS_AGENT_SLUG) as { id: number } | undefined;
    if (atlasByOpenClawId?.id) return Number(atlasByOpenClawId.id);
  }

  if (hasSessionKey) {
    const atlasBySessionKey = db.prepare(`SELECT id FROM agents WHERE session_key = ? ORDER BY id ASC LIMIT 1`).get(ATLAS_SESSION_KEY) as { id: number } | undefined;
    if (atlasBySessionKey?.id) return Number(atlasBySessionKey.id);
  }

  const atlasByName = db.prepare(`SELECT id FROM agents WHERE name = ? ORDER BY id ASC LIMIT 1`).get(ATLAS_AGENT_NAME) as { id: number } | undefined;
  if (atlasByName?.id) return Number(atlasByName.id);

  if (hasSessionKey) {
    const legacyAtlas = db.prepare(`SELECT id FROM agents WHERE session_key = ? ORDER BY id ASC LIMIT 1`).get(LEGACY_ATLAS_SESSION_KEY) as { id: number } | undefined;
    if (legacyAtlas?.id) return Number(legacyAtlas.id);
  }

  return null;
}

export function ensureConfiguredRuntimeMcpApiKey(
  db: Database.Database = getDb(),
  env: NodeJS.ProcessEnv = process.env,
  options: { tenantMode?: 'repair' | 'verify' } = {},
): { status: 'missing' | 'reused' | 'created'; agentId?: number; keyId?: number; keyPrefix?: string } {
  ensureMcpApiKeyTable(db);
  if (options.tenantMode === 'verify') {
    verifyTenantSchemaForStartup(db);
  } else {
    ensureTenantSchema(db);
  }

  const configuredApiKey = env.AGENT_HQ_MCP_API_KEY?.trim();
  if (!configuredApiKey) return { status: 'missing' };

  try {
    const identity = resolveMcpApiIdentityForKey(db, configuredApiKey, { updateLastUsed: false });
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

  const agentId = findAgentIdForConfiguredRuntimeKey(db, env);
  if (!agentId) {
    throw new Error('Configured AGENT_HQ_MCP_API_KEY could not be materialized because no bootstrap agent was found in the current database');
  }

  const keyPrefix = configuredApiKey.slice(0, 16);
  const agent = db.prepare(`SELECT tenant_id FROM agents WHERE id = ?`).get(agentId) as { tenant_id: number | null } | undefined;
  const tenantId = parsePositiveInt(agent?.tenant_id);
  if (!tenantId) {
    throw new Error(`Configured AGENT_HQ_MCP_API_KEY could not be materialized because bootstrap agent #${agentId} is not bound to a tenant`);
  }
  const globalAdmin = ['1', 'true', 'yes', 'on'].includes(String(env.AGENT_HQ_MCP_API_KEY_GLOBAL_ADMIN ?? '').trim().toLowerCase()) ? 1 : 0;

  const result = db.prepare(`
    INSERT INTO mcp_api_keys (agent_id, tenant_id, name, key_prefix, key_hash, global_admin)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(agentId, tenantId, 'Configured runtime MCP API key', keyPrefix, hashMcpApiKey(configuredApiKey), globalAdmin);

  return {
    status: 'created',
    agentId,
    keyId: Number(result.lastInsertRowid),
    keyPrefix,
  };
}

export function ensureMaterializedMcpApiKeyForAgent(params: {
  db: Database.Database;
  agentId: number;
  existingApiKey?: string | null;
  name?: string;
}): { apiKey: string; reused: boolean; keyId?: number; keyPrefix?: string } {
  const existingApiKey = params.existingApiKey?.trim();
  if (existingApiKey) {
    try {
      const identity = resolveMcpApiIdentityForKey(params.db, existingApiKey, { updateLastUsed: false });
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

  const issued = issueMcpApiKeyForAgent(params.db, params.agentId, params.name);
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
  return identity.systemRole === ATLAS_SYSTEM_ROLE
    || identity.systemRole === 'admin'
    || identity.agentSlug === ATLAS_AGENT_SLUG
    || identity.agentName === ATLAS_AGENT_NAME;
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getScopedTaskContexts(db: Database.Database, identity: McpApiIdentity): ScopedTaskContext[] {
  return db.prepare(`
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
  `).all(identity.agentId, identity.agentId).map((row) => {
    const record = row as Record<string, unknown>;
    return {
      taskId: Number(record.task_id),
      projectId: parsePositiveInt(record.project_id),
      sprintId: parsePositiveInt(record.sprint_id),
      activeInstanceId: parsePositiveInt(record.active_instance_id),
    };
  });
}

function getScopedInstanceContexts(db: Database.Database, identity: McpApiIdentity): ScopedInstanceContext[] {
  return db.prepare(`
    SELECT DISTINCT
      ji.id AS instanceId,
      ji.task_id AS taskId,
      ji.status AS status,
      CASE WHEN t.active_instance_id = ji.id THEN 1 ELSE 0 END AS activeForTask
    FROM job_instances ji
    LEFT JOIN tasks t ON t.id = ji.task_id
    WHERE ji.agent_id = ?
      AND (
        ji.status IN ('queued', 'dispatched', 'running')
        OR t.active_instance_id = ji.id
      )
  `).all(identity.agentId).map((row) => ({
    instanceId: Number((row as Record<string, unknown>).instanceId),
    taskId: parsePositiveInt((row as Record<string, unknown>).taskId),
    status: typeof (row as Record<string, unknown>).status === 'string' ? String((row as Record<string, unknown>).status) : null,
    activeForTask: Number((row as Record<string, unknown>).activeForTask) === 1,
  }));
}

function getCanonicalAgentProjectId(db: Database.Database, identity: McpApiIdentity): number | null {
  if (!hasColumn(db, 'agents', 'project_id')) return null;
  const row = db.prepare(`SELECT project_id FROM agents WHERE id = ? AND tenant_id = ? LIMIT 1`).get(identity.agentId, identity.tenantId) as { project_id: number | null } | undefined;
  return parsePositiveInt(row?.project_id);
}

function getTenantAgentProjectId(db: Database.Database, identity: McpApiIdentity, agentId: number): number | null | undefined {
  if (!hasColumn(db, 'agents', 'tenant_id') || !hasColumn(db, 'agents', 'project_id')) return undefined;
  const row = db.prepare(`SELECT project_id FROM agents WHERE id = ? AND tenant_id = ? LIMIT 1`).get(agentId, identity.tenantId) as { project_id: number | null } | undefined;
  if (!row) return undefined;
  return parsePositiveInt(row.project_id);
}

function taskBelongsToProject(db: Database.Database, identity: McpApiIdentity, taskId: number, projectId: number): boolean {
  const row = db.prepare(`SELECT tenant_id, project_id FROM tasks WHERE id = ? LIMIT 1`).get(taskId) as { tenant_id: number | null; project_id: number | null } | undefined;
  return parsePositiveInt(row?.tenant_id) === identity.tenantId && parsePositiveInt(row?.project_id) === projectId;
}

function relationshipBelongsToProject(
  db: Database.Database,
  identity: McpApiIdentity,
  relationshipId: number,
  sourceTaskId: number,
  projectId: number,
): boolean {
  if (!hasTable(db, 'task_relationships')) return false;
  const row = db.prepare(`
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
  `).get(relationshipId, sourceTaskId) as Record<string, unknown> | undefined;
  if (!row) return false;
  return parsePositiveInt(row.source_tenant_id) === identity.tenantId
    && parsePositiveInt(row.target_tenant_id) === identity.tenantId
    && parsePositiveInt(row.source_project_id) === projectId
    && parsePositiveInt(row.target_project_id) === projectId;
}

function sprintBelongsToProject(db: Database.Database, identity: McpApiIdentity, sprintId: number, projectId: number): boolean {
  if (!hasTable(db, 'sprints')) return false;
  const hasSprintTenant = hasColumn(db, 'sprints', 'tenant_id');
  const row = db.prepare(`
    SELECT project_id
    FROM sprints
    WHERE id = ?
      ${hasSprintTenant ? 'AND tenant_id = ?' : ''}
    LIMIT 1
  `).get(sprintId, ...(hasSprintTenant ? [identity.tenantId] : [])) as { project_id: number | null } | undefined;
  return parsePositiveInt(row?.project_id) === projectId;
}

function requestBodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

function validateProjectTaskCrudRequestScope(
  db: Database.Database,
  identity: McpApiIdentity,
  body: Record<string, unknown>,
  projectId: number,
): { ok: true } | { ok: false; reason: string } {
  const requestedProjectId = parsePositiveInt(body.project_id);
  if (requestedProjectId != null && requestedProjectId !== projectId) {
    return { ok: false, reason: `Requested project_id ${requestedProjectId} is outside the assigned project for ${identity.agentSlug}.` };
  }

  const requestedSprintId = parsePositiveInt(firstPresent(body.sprint_id, body.workflow_id));
  if (requestedSprintId != null && !sprintBelongsToProject(db, identity, requestedSprintId, projectId)) {
    return { ok: false, reason: `Requested sprint/workflow #${requestedSprintId} is outside the assigned project for ${identity.agentSlug}.` };
  }

  const requestedAgentId = parsePositiveInt(body.agent_id);
  if (requestedAgentId != null) {
    const targetAgentProjectId = getTenantAgentProjectId(db, identity, requestedAgentId);
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

function taskIdForInstance(db: Database.Database, instanceId: number): number | null {
  const row = db.prepare(`SELECT task_id FROM job_instances WHERE id = ?`).get(instanceId) as { task_id: number | null } | undefined;
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

function getRoutingRuleScopeFromRuleId(
  db: Database.Database,
  ruleId: number,
  tenantId: number,
): RoutingRuleScopeContext | null {
  if (!hasTable(db, 'sprint_task_routing_rules')) return null;
  const hasRoutingProject = hasColumn(db, 'sprint_task_routing_rules', 'project_id');
  const hasRoutingSprintType = hasColumn(db, 'sprint_task_routing_rules', 'sprint_type');
  const hasRoutingTenant = hasColumn(db, 'sprint_task_routing_rules', 'tenant_id');
  const hasSprintTenant = hasColumn(db, 'sprints', 'tenant_id');
  const row = db.prepare(`
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
  `).get(ruleId, ...((hasRoutingTenant || (!hasRoutingTenant && hasSprintTenant)) ? [tenantId] : [])) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    projectId: parsePositiveInt(row.routing_project_id) ?? parsePositiveInt(row.sprint_project_id),
    sprintId: parsePositiveInt(row.routing_sprint_id),
    sprintType: normalizeScopeString(row.routing_sprint_type) ?? normalizeScopeString(row.sprint_type),
    source: 'existing_rule',
  };
}

function getRoutingRuleScopeFromRequest(
  db: Database.Database,
  input: Record<string, unknown>,
  tenantId: number,
): RoutingRuleScopeContext | null {
  const sprintId = parsePositiveInt(firstPresent(input.sprint_id, input.workflow_id));
  const requestedProjectId = parsePositiveInt(input.project_id);
  const requestedSprintType = normalizeScopeString(firstPresent(input.sprint_type, input.workflow_type));

  if (sprintId != null) {
    if (!hasTable(db, 'sprints')) return { projectId: requestedProjectId, sprintId, sprintType: requestedSprintType, source: 'request' };
    const hasSprintTenant = hasColumn(db, 'sprints', 'tenant_id');
    const sprint = db.prepare(`
      SELECT id, project_id, sprint_type
      FROM sprints
      WHERE id = ?
        ${hasSprintTenant ? 'AND tenant_id = ?' : ''}
      LIMIT 1
    `).get(sprintId, ...(hasSprintTenant ? [tenantId] : [])) as { id: number; project_id: number | null; sprint_type: string | null } | undefined;
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

function getRoutingTransitionScopeFromTransitionId(
  db: Database.Database,
  transitionId: number,
  tenantId: number,
): RoutingTransitionScopeContext | null {
  if (!hasTable(db, 'sprint_task_transitions')) return null;
  const hasTransitionProject = hasColumn(db, 'sprint_task_transitions', 'project_id');
  const hasTransitionSprintType = hasColumn(db, 'sprint_task_transitions', 'sprint_type');
  const hasTransitionTenant = hasColumn(db, 'sprint_task_transitions', 'tenant_id');
  const hasSprintTenant = hasColumn(db, 'sprints', 'tenant_id');
  const row = db.prepare(`
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
  `).get(transitionId, ...((hasTransitionTenant || (!hasTransitionTenant && hasSprintTenant)) ? [tenantId] : [])) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    projectId: parsePositiveInt(row.transition_project_id) ?? parsePositiveInt(row.sprint_project_id),
    sprintId: parsePositiveInt(row.transition_sprint_id),
    sprintType: normalizeScopeString(row.transition_sprint_type) ?? normalizeScopeString(row.sprint_type),
    source: 'existing_transition',
  };
}

function getRoutingTransitionScopeFromRequest(
  db: Database.Database,
  input: Record<string, unknown>,
  tenantId: number,
): RoutingTransitionScopeContext | null {
  const ruleScope = getRoutingRuleScopeFromRequest(db, input, tenantId);
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

function getWorkflowDefinitionScopeFromKey(
  db: Database.Database,
  workflowDefinitionKey: string,
  tenantId: number,
): WorkflowDefinitionScopeContext | null {
  if (!hasTable(db, 'sprint_types')) return null;
  const hasTenant = hasColumn(db, 'sprint_types', 'tenant_id');
  const hasProject = hasColumn(db, 'sprint_types', 'project_id');
  const row = db.prepare(`
    SELECT key, ${hasProject ? 'project_id' : 'NULL'} AS project_id
    FROM sprint_types
    WHERE key = ?
      ${hasTenant ? 'AND tenant_id = ?' : ''}
    LIMIT 1
  `).get(workflowDefinitionKey, ...(hasTenant ? [tenantId] : [])) as Record<string, unknown> | undefined;
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

function getRecurringTaskSeriesProjectId(db: Database.Database, seriesId: number): number | null {
  try {
    const row = db.prepare(`SELECT project_id FROM recurring_task_series WHERE id = ?`).get(seriesId) as
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

function getTransitionRequirementScopeFromRequirementId(
  db: Database.Database,
  requirementId: number,
  tenantId: number,
): TransitionRequirementScopeContext | null {
  if (!hasTable(db, 'sprint_task_transition_requirements')) return null;
  const hasRequirementProject = hasColumn(db, 'sprint_task_transition_requirements', 'project_id');
  const hasRequirementSprintType = hasColumn(db, 'sprint_task_transition_requirements', 'sprint_type');
  const hasRequirementTenant = hasColumn(db, 'sprint_task_transition_requirements', 'tenant_id');
  const hasSprintTenant = hasColumn(db, 'sprints', 'tenant_id');
  const row = db.prepare(`
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
  `).get(requirementId, ...((hasRequirementTenant || (!hasRequirementTenant && hasSprintTenant)) ? [tenantId] : [])) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    projectId: parsePositiveInt(row.requirement_project_id) ?? parsePositiveInt(row.sprint_project_id),
    sprintId: parsePositiveInt(row.requirement_sprint_id),
    sprintType: normalizeScopeString(row.requirement_sprint_type) ?? normalizeScopeString(row.sprint_type),
    source: 'existing_requirement',
  };
}

function getTransitionRequirementScopeFromRequest(
  db: Database.Database,
  input: Record<string, unknown>,
  tenantId: number,
): TransitionRequirementScopeContext | null {
  const sprintId = parsePositiveInt(firstPresent(input.sprint_id, input.workflow_id));
  const requestedProjectId = parsePositiveInt(input.project_id);
  const requestedSprintType = normalizeScopeString(firstPresent(input.sprint_type, input.workflow_type));

  if (sprintId != null) {
    if (!hasTable(db, 'sprints')) return { projectId: requestedProjectId, sprintId, sprintType: requestedSprintType, source: 'request' };
    const hasSprintTenant = hasColumn(db, 'sprints', 'tenant_id');
    const sprint = db.prepare(`
      SELECT id, project_id, sprint_type
      FROM sprints
      WHERE id = ?
        ${hasSprintTenant ? 'AND tenant_id = ?' : ''}
      LIMIT 1
    `).get(sprintId, ...(hasSprintTenant ? [tenantId] : [])) as { id: number; project_id: number | null; sprint_type: string | null } | undefined;
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

function insertMcpScopeDeniedNote(db: Database.Database, params: {
  taskId: number | null;
  identity: McpApiIdentity;
  reason: string;
}): void {
  if (!params.taskId) return;
  db.prepare(`
    INSERT INTO task_notes (task_id, author, content)
    VALUES (?, ?, ?)
  `).run(
    params.taskId,
    'agent-hq-mcp-auth',
    `Scoped MCP write refused for ${params.identity.auditActor}: ${params.reason}`,
  );
}

function sendMcpScopeDenied(res: Response, params: {
  db: Database.Database;
  identity: McpApiIdentity;
  reason: string;
  requiredCapability: AgentMcpCapabilityKey;
  policyMode: 'default' | 'explicit';
  defaultPolicy: AgentMcpDefaultPolicy;
  allowedCapabilities: Set<AgentMcpCapabilityKey>;
  taskId?: number | null;
  instanceId?: number | null;
  path: string;
}): void {
  insertMcpScopeDeniedNote(params.db, {
    taskId: params.taskId ?? (params.instanceId ? taskIdForInstance(params.db, params.instanceId) : null),
    identity: params.identity,
    reason: params.reason,
  });

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

export function authorizeMcpApiRequestIfPresent(req: Request, res: Response, next: NextFunction): void {
  const identity = getMcpIdentityFromRequest(req);
  if (!identity) return next();

  const db = getDb();
  const method = req.method.toUpperCase();
  const requestPath = req.path;

  try {
    const resolvedTenantId = resolveTenantIdFromRequest(db, req);
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

  const permissionState = resolveEffectiveAgentMcpPermissionState(db, identity);
  const taskScopes = getScopedTaskContexts(db, identity);
  const instanceScopes = getScopedInstanceContexts(db, identity);
  const scopedTaskIds = new Set(taskScopes.map((row) => row.taskId));
  const scopedProjectIds = new Set(taskScopes.map((row) => row.projectId).filter((value): value is number => value != null));
  const scopedSprintIds = new Set(taskScopes.map((row) => row.sprintId).filter((value): value is number => value != null));
  const scopedInstanceIds = new Set(instanceScopes.map((row) => row.instanceId));
  const canonicalAgentProjectId = getCanonicalAgentProjectId(db, identity);

  if (permissionState.enabledCapabilities.has('admin.full_access')) return next();

  const deny = (params: {
    reason: string;
    requiredCapability: AgentMcpCapabilityKey;
    taskId?: number | null;
    instanceId?: number | null;
  }): void => {
    console.warn(
      `[mcp-auth] denied ${identity.agentSlug} ${method} ${requestPath} (requires ${params.requiredCapability}; policy=${permissionState.policyMode}/${permissionState.defaultPolicy})`,
    );
    sendMcpScopeDenied(res, {
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

  const requireCapability = (
    capability: AgentMcpCapabilityKey,
    reason: string,
    resource?: { taskId?: number | null; instanceId?: number | null },
  ): boolean => {
    if (permissionState.enabledCapabilities.has(capability)) return true;
    deny({
      reason,
      requiredCapability: capability,
      taskId: resource?.taskId,
      instanceId: resource?.instanceId,
    });
    return false;
  };

  if (requestPath === '/mcp/catalog' || requestPath === '/mcp/catalog/health') {
    if (!requireCapability(
      'discovery.read_catalog',
      `Agent HQ MCP catalog discovery is disabled for ${identity.agentSlug}.`,
    )) return;
    return next();
  }

  if (requestPath === '/external/task-events' && method === 'POST') {
    if (!requireCapability(
      'external.write_task_events',
      `External task event callbacks are disabled for ${identity.agentSlug}.`,
    )) return;
    return next();
  }

  if (requestPath === '/external/task-events/receipts' && method === 'GET') {
    if (!requireCapability(
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
    if (!requireCapability(
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
    if (!requireCapability(
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
    const scope = validateProjectTaskCrudRequestScope(db, identity, body, canonicalAgentProjectId);
    if (!scope.ok) {
      return deny({
        reason: scope.reason,
        requiredCapability,
      });
    }
    return next();
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

    if (!requireCapability(
      requiredCapability,
      `MCP capability policy ${isWrite ? 'mutation' : 'readback'} is disabled for ${identity.agentSlug}.`,
    )) return;

    const targetProjectId = getTenantAgentProjectId(db, identity, targetAgentId);
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
    if (!requireCapability(
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
    if (hasProjectRead && canonicalAgentProjectId != null && taskBelongsToProject(db, identity, taskId, canonicalAgentProjectId)) {
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

    if (!requireCapability(requiredCapability, `${identity.agentSlug} is not allowed to ${readAllowed ? 'read' : 'write'} active task MCP routes.`, { taskId })) {
      return;
    }

    if ((readAllowed && (hasProjectTaskRead || hasProjectTaskCrud)) || projectCrudAllowed || relationshipCrudAllowed) {
      if (canonicalAgentProjectId == null) {
        return deny({
          reason: `${identity.agentSlug} does not have an assigned project for project task ${projectCrudAllowed || relationshipCrudAllowed ? 'CRUD' : 'context reads'}.`,
          requiredCapability,
          taskId,
        });
      }
      if (!taskBelongsToProject(db, identity, taskId, canonicalAgentProjectId)) {
        return deny({
          reason: `Task #${taskId} is outside the assigned project for ${identity.agentSlug}.`,
          requiredCapability,
          taskId,
        });
      }
      if (method === 'PUT') {
        const scope = validateProjectTaskCrudRequestScope(db, identity, requestBodyRecord(req.body), canonicalAgentProjectId);
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
        if (targetTaskId != null && !taskBelongsToProject(db, identity, targetTaskId, canonicalAgentProjectId)) {
          return deny({
            reason: `Relationship target task #${targetTaskId} is outside the assigned project for ${identity.agentSlug}.`,
            requiredCapability,
            taskId,
          });
        }
      }
      if (relationshipCrudAllowed && method === 'DELETE') {
        const relationshipId = parsePositiveInt(taskRelationshipMutationMatch?.[2]);
        if (relationshipId == null || !relationshipBelongsToProject(db, identity, relationshipId, taskId, canonicalAgentProjectId)) {
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
    if (!requireCapability(
      'tasks.write_active_lifecycle',
      `Lifecycle callback writes are disabled for ${identity.agentSlug}.`,
      { instanceId },
    )) return;
    const allow = scopedInstanceIds.has(instanceId)
      && ((action === 'start' && method === 'PUT') || (action === 'check-in' && method === 'POST') || (action === 'complete' && method === 'PUT'));
    if (allow) return next();
    return deny({
      reason: `Normal Agent HQ MCP keys can only write lifecycle callbacks for the active dispatched instance owned by ${identity.agentSlug}.`,
      requiredCapability: 'tasks.write_active_lifecycle',
      instanceId,
    });
  }

  const projectMatch = requestPath.match(/^\/projects\/(\d+)$/);
  if (projectMatch && method === 'GET') {
    const projectId = Number(projectMatch[1]);
    if (!requireCapability(
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
    if (!requireCapability(
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
    if (!requireCapability(
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

  const sprintMatch = requestPath.match(/^\/sprints\/(\d+)$/);
  if (sprintMatch && method === 'GET') {
    const sprintId = Number(sprintMatch[1]);
    if (!requireCapability(
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
    if (!requireCapability(
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
    const existingScope = ruleId != null ? getRoutingRuleScopeFromRuleId(db, ruleId, identity.tenantId) : null;
    const requestHasScope = firstPresent(
      requestInput.project_id,
      requestInput.sprint_id,
      requestInput.workflow_id,
      requestInput.sprint_type,
      requestInput.workflow_type,
    ) !== undefined;
    const requestedScope = requestHasScope ? getRoutingRuleScopeFromRequest(db, requestInput, identity.tenantId) : null;
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
    if (!requireCapability(
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
    const existingScope = transitionId != null ? getRoutingTransitionScopeFromTransitionId(db, transitionId, identity.tenantId) : null;
    const requestHasScope = firstPresent(
      requestInput.project_id,
      requestInput.sprint_id,
      requestInput.workflow_id,
      requestInput.sprint_type,
      requestInput.workflow_type,
    ) !== undefined;
    const requestedScope = requestHasScope ? getRoutingTransitionScopeFromRequest(db, requestInput, identity.tenantId) : null;
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

  const workflowDefinitionMatch = requestPath.match(/^\/(?:sprints|workflows|workflow-definitions)\/(?:config|types(?:\/list)?|types\/([^/]+)(?:\/(?:task-types|field-schemas(?:\/[^/]+)?))?)$/);
  if (workflowDefinitionMatch && ['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    const requiredCapability: AgentMcpCapabilityKey = method === 'GET'
      ? 'workflow_definitions.read_project_scope'
      : 'workflow_definitions.manage_project_scope';
    if (!requireCapability(
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
    const existingScope = workflowDefinitionKey ? getWorkflowDefinitionScopeFromKey(db, workflowDefinitionKey, identity.tenantId) : null;
    const requestScope = getWorkflowDefinitionScopeFromRequest(requestInput);
    const scopesToAuthorize = [
      ...(existingScope ? [existingScope] : []),
      ...(requestScope ? [requestScope] : []),
    ].filter((scope) => (
      scope.projectId != null
      || scope.source !== 'existing_definition'
      || requestScope == null
    ));

    if (workflowDefinitionKey && existingScope == null && method !== 'POST') {
      return deny({
        reason: `Workflow definition "${workflowDefinitionKey}" is outside the MCP key tenant or does not exist.`,
        requiredCapability,
      });
    }

    if (method === 'POST' && requestScope == null) {
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
    if (!requireCapability(
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
    const existingScope = requirementId != null ? getTransitionRequirementScopeFromRequirementId(db, requirementId, identity.tenantId) : null;
    const requestScope = getTransitionRequirementScopeFromRequest(db, requestInput, identity.tenantId);
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
    if (!requireCapability(
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
    if (!requireCapability(
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
      ? getRecurringTaskSeriesProjectId(db, seriesId)
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

  return deny({
    reason: `Normal Agent HQ MCP keys cannot access ${method} ${requestPath}. Full administrative MCP access is required for this route.`,
    requiredCapability: 'admin.full_access',
  });
}

export function authenticateMcpApiKeyIfPresent(req: Request, res: Response, next: NextFunction): void {
  try {
    const { key, presented } = extractMcpApiKeyFromRequest(req);
    if (!presented) return next();
    if (!key) throw new McpApiAuthError('MCP API key is required', 401, 'mcp_api_key_missing');

    req.mcpIdentity = resolveMcpApiIdentityForKey(getDb(), key);
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
