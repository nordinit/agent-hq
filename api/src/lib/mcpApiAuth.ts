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
    description: 'Allows reads for the agent\'s currently dispatched task, including context, notes, history, and instance linkage.',
    endpoints: [
      'GET /api/v1/tasks/:id',
      'GET /api/v1/tasks/:id/context',
      'GET /api/v1/tasks/:id/notes',
      'GET /api/v1/tasks/:id/history',
      'GET /api/v1/tasks/:id/instances',
      'GET /api/v1/tasks/:id/active-owner',
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
    description: 'Allows creating new Agent HQ tasks through the task creation MCP tool without granting broader administrative task management.',
    endpoints: [
      'POST /api/v1/tasks',
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
    key: 'mcp_servers.read',
    group: 'Administration',
    label: 'Read MCP server registry',
    description: 'Allows tenant-local MCP server inventory, detail, and per-agent MCP assignment readback without exposing MCP environment values or allowing assignment changes.',
    endpoints: [
      'GET /api/v1/mcp-servers',
      'GET /api/v1/mcp-servers/:id',
      'GET /api/v1/agents/:id/mcp-servers',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'agents.read',
    group: 'Administration',
    label: 'Read agent registry',
    description: 'Allows tenant-local agent inventory, detail, and Agent HQ MCP capability-assignment readback without allowing agent or assignment mutation.',
    endpoints: [
      'GET /api/v1/agents',
      'GET /api/v1/agents/:id',
      'GET /api/v1/agents/:id/mcp-permissions',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'tools.read',
    group: 'Administration',
    label: 'Read tool registry',
    description: 'Allows tenant-local tool registry inventory, detail, duplicate-tool audit readback, and per-agent tool assignment readback without allowing tool or assignment mutation.',
    endpoints: [
      'GET /api/v1/tools',
      'GET /api/v1/tools/:id',
      'GET /api/v1/tools/audit/duplicates',
      'GET /api/v1/agents/:id/tools',
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

export function mcpIdentityHasCapability(
  db: Database.Database,
  identity: McpApiIdentity,
  capability: AgentMcpCapabilityKey,
): boolean {
  return resolveEffectiveAgentMcpPermissionState(db, identity).enabledCapabilities.has(capability);
}

export function mcpRequestHasCapability(
  req: Request,
  capability: AgentMcpCapabilityKey,
  db: Database.Database = getDb(),
): boolean {
  const identity = getMcpIdentityFromRequest(req);
  return Boolean(identity && mcpIdentityHasCapability(db, identity, capability));
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

function taskIdForInstance(db: Database.Database, instanceId: number): number | null {
  const row = db.prepare(`SELECT task_id FROM job_instances WHERE id = ?`).get(instanceId) as { task_id: number | null } | undefined;
  return row?.task_id ?? null;
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

  if (requestPath === '/tasks' && method === 'POST') {
    if (!requireCapability(
      'tasks.create',
      `Task creation is disabled for ${identity.agentSlug}.`,
    )) return;
    return next();
  }

  const activeOwnerMatch = requestPath.match(/^\/tasks\/(\d+)\/active-owner$/);
  if (activeOwnerMatch && method === 'GET') {
    const taskId = Number(activeOwnerMatch[1]);
    if (!requireCapability(
      'tasks.read_active_context',
      `${identity.agentSlug} is not allowed to read active task MCP routes.`,
      { taskId },
    )) return;
    return next();
  }

  const taskMatch = requestPath.match(/^\/tasks\/(\d+)(?:\/(context|notes|history|instances|review-evidence|qa-evidence|deploy-evidence|live-verification|outcome))?$/);
  if (taskMatch) {
    const taskId = Number(taskMatch[1]);
    const suffix = taskMatch[2] ?? '';
    const readAllowed = method === 'GET' && (suffix === '' || suffix === 'context' || suffix === 'notes' || suffix === 'history' || suffix === 'instances');
    const writeAllowed = (
      (suffix === 'notes' && method === 'POST')
      || (suffix === 'review-evidence' && method === 'PUT')
      || (suffix === 'qa-evidence' && method === 'PUT')
      || (suffix === 'deploy-evidence' && method === 'PUT')
      || (suffix === 'live-verification' && method === 'PUT')
      || (suffix === 'outcome' && method === 'POST')
    );
    const requiredCapability: AgentMcpCapabilityKey | null = readAllowed
      ? 'tasks.read_active_context'
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

  if ((requestPath === '/routing/transitions' || requestPath === '/routing/transition-requirements') && method === 'GET') {
    if (!requireCapability(
      'workflow.read_active_configuration',
      `Workflow configuration reads are disabled for ${identity.agentSlug}.`,
    )) return;
    const sprintId = parsePositiveInt(req.query.sprint_id);
    const projectId = parsePositiveInt(req.query.project_id);
    const sprintAllowed = sprintId != null && scopedSprintIds.has(sprintId);
    const projectAllowed = requestPath === '/routing/transition-requirements'
      ? true
      : projectId != null && scopedProjectIds.has(projectId);
    if (sprintAllowed && projectAllowed) return next();
    return deny({
      reason: `Normal Agent HQ MCP keys can only read workflow configuration scoped to the active task's sprint and project.`,
      requiredCapability: 'workflow.read_active_configuration',
    });
  }

  const mcpServerReadMatch = requestPath === '/mcp-servers'
    || /^\/mcp-servers\/\d+$/.test(requestPath)
    || /^\/agents\/\d+\/mcp-servers$/.test(requestPath);
  if (mcpServerReadMatch && method === 'GET') {
    if (!requireCapability(
      'mcp_servers.read',
      `MCP server registry reads are disabled for ${identity.agentSlug}.`,
    )) return;
    return next();
  }

  const agentReadMatch = requestPath === '/agents'
    || /^\/agents\/\d+$/.test(requestPath)
    || /^\/agents\/\d+\/mcp-permissions$/.test(requestPath);
  if (agentReadMatch && method === 'GET') {
    if (!requireCapability(
      'agents.read',
      `Agent registry reads are disabled for ${identity.agentSlug}.`,
    )) return;
    return next();
  }

  const toolReadMatch = requestPath === '/tools'
    || requestPath === '/tools/audit/duplicates'
    || /^\/tools\/\d+$/.test(requestPath)
    || /^\/agents\/\d+\/tools$/.test(requestPath);
  if (toolReadMatch && method === 'GET') {
    if (!requireCapability(
      'tools.read',
      `Tool registry reads are disabled for ${identity.agentSlug}.`,
    )) return;
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
