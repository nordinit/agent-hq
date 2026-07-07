import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getDb } from '../db/client';
import { generateClaudeMd, OPENCLAW_SKILLS_PATH } from '../services/dispatcher';
import { OPENCLAW_CONFIG_PATH } from '../config';
import { ATLAS_SYSTEM_ROLE } from '../lib/atlasAgent';
import {
  normalizeRepoConfig,
  resolveRepoConfig,
  validateRepoConfig,
} from '../lib/repoConfig';
import {
  buildCanonicalAgentMainSessionKey,
  buildLegacyAgentMainSessionKey,
  normalizeAgentRoleLabel,
  parseAgentSessionKey,
  resolveRuntimeAgentSlug,
  slugifySessionKeyPart,
} from '../lib/sessionKeys';
import { resolveWorkspaceProvider } from '../lib/workspaceProvider';
import { seedSprintTaskPolicy } from '../domains/routing/policy/seed';
import { getAgentRoutingConfig, updateAgentRoutingConfig } from '../domains/routing/config';
import {
  defaultAgentModelForProvider,
  getConnectedProviderSlugs,
  resolveSchemaSafePreferredProvider,
  shouldSkipProviderValidationForRuntime,
  validateAgentProviderSelection,
} from '../domains/agents/providerSelection';
import {
  parseRuntimeConfigObject,
  validateAgentRuntimeConfig,
  type AgentRuntimeConfigPayload,
  type AgentRuntimeType,
} from '../domains/agents/runtimeConfig';
import { syncStarterRoutingForProject } from '../lib/starterSetup';
import { getSkillMaterializationAdapter } from '../runtimes/skillMaterialization';
import { syncAssignedMcpForAgent } from '../runtimes/mcpMaterialization';
import { resolveRuntime, type RuntimeAuthProfileSyncResult } from '../runtimes';
import { isValidTaskType } from '../lib/taskTypes';
import { ensureOpenClawGatewayAvailable, requireOpenClawOutput, runOpenClawSync } from '../lib/openclawCli';
import { syncAvailableOAuthProfilesToAuthFile } from '../lib/openclawOAuthProfiles';
import {
  getAgentMcpPermissionPolicy,
  replaceAgentMcpPermissionPolicy,
  resetAgentMcpPermissionPolicy,
} from '../lib/mcpApiAuth';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';

const router = Router();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function ensureOpenClawCodexRuntime(entry: Record<string, unknown>, model: string | null | undefined, provider: string | null | undefined): void {
  if (provider !== 'openai-codex' || !model) return;

  const models = isRecord(entry.models) ? entry.models : {};
  const modelConfig = isRecord(models[model]) ? models[model] as Record<string, unknown> : {};
  const agentRuntime = isRecord(modelConfig.agentRuntime) ? modelConfig.agentRuntime : {};
  modelConfig.agentRuntime = { ...agentRuntime, id: 'codex' };
  models[model] = modelConfig;
  entry.models = models;
}

type AgentReferenceCheck = {
  table: string;
  column: string;
  label: string;
  historical: boolean;
};

type AgentReferenceCount = AgentReferenceCheck & {
  count: number;
};

const AGENT_REFERENCE_CHECKS: AgentReferenceCheck[] = [
  { table: 'tasks', column: 'agent_id', label: 'assigned tasks', historical: true },
  { table: 'tasks', column: 'review_owner_agent_id', label: 'review owner tasks', historical: true },
  { table: 'job_instances', column: 'agent_id', label: 'job instances', historical: true },
  { table: 'sessions', column: 'agent_id', label: 'captured sessions', historical: true },
  { table: 'task_events', column: 'agent_id', label: 'task events', historical: true },
  { table: 'dispatch_log', column: 'agent_id', label: 'dispatch log entries', historical: true },
  { table: 'task_creation_events', column: 'agent_id', label: 'task creation events', historical: true },
  { table: 'task_outcome_metrics', column: 'agent_id', label: 'task outcome metrics', historical: true },
  { table: 'logs', column: 'agent_id', label: 'logs', historical: true },
  { table: 'chat_messages', column: 'agent_id', label: 'chat messages', historical: true },
  { table: 'chat_attachments', column: 'agent_id', label: 'chat attachments', historical: true },
  { table: 'canonical_chat_sessions', column: 'agent_id', label: 'canonical chat sessions', historical: true },
  { table: 'integrity_events', column: 'agent_id', label: 'integrity events', historical: true },
  { table: 'security_events', column: 'agent_id', label: 'security events', historical: true },
  { table: 'sprint_task_routing_rules', column: 'agent_id', label: 'routing rules', historical: false },
  { table: 'agent_tool_assignments', column: 'agent_id', label: 'tool assignments', historical: false },
  { table: 'agent_mcp_assignments', column: 'agent_id', label: 'MCP assignments', historical: false },
];

function makeStableSkillId(name: string): number {
  let hash = 0;
  for (const ch of name) hash = ((hash * 31) + ch.charCodeAt(0)) | 0;
  return Math.abs(hash) || 1;
}

function resolveSkillNameInput(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function tableHasColumn(db: ReturnType<typeof getDb>, table: string, column: string): boolean {
  try {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return columns.some((entry) => entry.name === column);
  } catch {
    return false;
  }
}

function getStoredJobInstructions(agent: Record<string, unknown>): string {
  return (agent.job_instructions as string | null | undefined) ?? '';
}

function getRequestedJobInstructions(body: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, 'job_instructions')) {
    return undefined;
  }
  const value = body.job_instructions;
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function getLegacyJobInstructionsFieldError(body: Record<string, unknown>): string | null {
  if (Object.prototype.hasOwnProperty.call(body, 'pre_instructions')) {
    return 'pre_instructions has been renamed to job_instructions';
  }
  return null;
}

function countAgentReferences(db: ReturnType<typeof getDb>, agentId: number): AgentReferenceCount[] {
  const counts: AgentReferenceCount[] = [];
  for (const check of AGENT_REFERENCE_CHECKS) {
    if (!tableHasColumn(db, check.table, check.column)) continue;
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${check.table} WHERE ${check.column} = ?`).get(agentId) as { n: number };
    counts.push({ ...check, count: Number(row.n ?? 0) });
  }
  return counts;
}

function buildArchivedSessionKey(agentId: number, existingSessionKey: unknown): string {
  const existing = typeof existingSessionKey === 'string' && existingSessionKey.trim()
    ? existingSessionKey.trim()
    : `agent:${agentId}`;
  return existing.startsWith(`deleted:${agentId}:`) ? existing : `deleted:${agentId}:${existing}`;
}

function archiveAgentForDeletion(db: ReturnType<typeof getDb>, agent: Record<string, unknown>, referenceCounts: AgentReferenceCount[]): void {
  const agentId = Number(agent.id);
  const archivedSessionKey = buildArchivedSessionKey(agentId, agent.session_key);
  const tx = db.transaction(() => {
    if (tableHasColumn(db, 'agent_tool_assignments', 'agent_id')) {
      db.prepare('DELETE FROM agent_tool_assignments WHERE agent_id = ?').run(agentId);
    }
    if (tableHasColumn(db, 'agent_mcp_assignments', 'agent_id')) {
      db.prepare('DELETE FROM agent_mcp_assignments WHERE agent_id = ?').run(agentId);
    }
    if (tableHasColumn(db, 'sprint_task_routing_rules', 'agent_id')) {
      db.prepare('DELETE FROM sprint_task_routing_rules WHERE agent_id = ?').run(agentId);
    }
    db.prepare(`
      UPDATE agents
      SET enabled = 0,
          status = 'idle',
          schedule = '',
          openclaw_agent_id = NULL,
          session_key = ?,
          deleted_at = COALESCE(deleted_at, datetime('now'))
      WHERE id = ?
    `).run(archivedSessionKey, agentId);
  });
  tx();

  const historicalSummary = referenceCounts
    .filter((entry) => entry.historical && entry.count > 0)
    .map((entry) => `${entry.label}: ${entry.count}`)
    .join(', ');
  console.log(`[agents] Archived agent #${agentId} instead of hard delete; preserved historical references${historicalSummary ? ` (${historicalSummary})` : ''}`);
}

function getProjectName(projectId: number | null | undefined): string | null {
  if (!projectId) return null;
  const db = getDb();
  if (!tableHasColumn(db, 'projects', 'name')) return null;
  const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string | null } | undefined;
  return row?.name?.trim() || null;
}

const AGENT_REPO_FIELDS = ['repo_path', 'repo_url', 'repo_access_mode'] as const;

function rejectAgentRepoPayload(body: Record<string, unknown>): { ok: true } | { ok: false; status: number; error: string; code: string; rejected_fields: string[] } {
  const rejectedFields = AGENT_REPO_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
  if (rejectedFields.length === 0) return { ok: true };

  return {
    ok: false,
    status: 400,
    error: 'Repository configuration is project-owned. Agent create/update flows no longer accept repo_path, repo_url, or repo_access_mode. Update the project instead.',
    code: 'agent_repo_fields_not_supported',
    rejected_fields: rejectedFields,
  };
}

function selectAgentWithProject(db: ReturnType<typeof getDb>, id: number | string, includeDeleted = false): Record<string, unknown> | undefined {
  const hasProjectsTable = tableHasColumn(db, 'projects', 'id');
  const hasProjectRepoColumns = ['repo_path', 'repo_url', 'repo_access_mode'].every((column) => tableHasColumn(db, 'projects', column));
  const hasDeletedAt = tableHasColumn(db, 'agents', 'deleted_at');
  return db.prepare(`
    SELECT a.*,
      ${hasProjectsTable ? 'p.name AS project_name,' : 'NULL AS project_name,'}
      ${hasProjectRepoColumns ? 'p.repo_path AS project_repo_path, p.repo_url AS project_repo_url, p.repo_access_mode AS project_repo_access_mode' : 'NULL AS project_repo_path, NULL AS project_repo_url, NULL AS project_repo_access_mode'}
    FROM agents a
    ${hasProjectsTable ? 'LEFT JOIN projects p ON p.id = a.project_id' : ''}
    WHERE a.id = ?
      ${hasDeletedAt ? 'AND (? = 1 OR a.deleted_at IS NULL)' : ''}
  `).get(...(hasDeletedAt ? [id, includeDeleted ? 1 : 0] : [id])) as Record<string, unknown> | undefined;
}

function selectAgentWithProjectForTenant(db: ReturnType<typeof getDb>, id: number | string, tenantId: number, includeDeleted = false): Record<string, unknown> | undefined {
  const agent = selectAgentWithProject(db, id, includeDeleted);
  if (!agent) return undefined;
  return Number(agent.tenant_id) === tenantId ? agent : undefined;
}

function requireAgentVisibleForTenant(db: ReturnType<typeof getDb>, agentId: number | string, tenantId: number): boolean {
  return Boolean(db.prepare(`SELECT id FROM agents WHERE id = ? AND tenant_id = ?`).get(agentId, tenantId));
}

function buildDefaultAgentSessionKey(params: {
  name: string;
  role?: string | null;
  projectId?: number | null;
  systemRole?: string | null;
}): string {
  if (params.systemRole === ATLAS_SYSTEM_ROLE) {
    return buildLegacyAgentMainSessionKey('atlas');
  }

  const projectName = getProjectName(params.projectId ?? null);
  const db = getDb();
  let candidate = buildCanonicalAgentMainSessionKey({
    projectName,
    projectSlug: slugifySessionKeyPart(projectName, 'unassigned'),
    agentName: params.name,
    role: params.role ?? null,
  });

  if (!db.prepare('SELECT id FROM agents WHERE session_key = ? LIMIT 1').get(candidate)) {
    return candidate;
  }

  const baseAgentSlug = slugifySessionKeyPart(params.name, 'agent');
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    candidate = buildCanonicalAgentMainSessionKey({
      projectName,
      projectSlug: slugifySessionKeyPart(projectName, 'unassigned'),
      agentNameSlug: `${baseAgentSlug}-${suffix}`,
      role: params.role ?? null,
    });
    if (!db.prepare('SELECT id FROM agents WHERE session_key = ? LIMIT 1').get(candidate)) {
      return candidate;
    }
  }

  return candidate;
}

type ProvisionPhaseStatus = 'created' | 'updated' | 'reused' | 'skipped' | 'synced' | 'verified' | 'failed';

interface ProvisionPhaseReport {
  ok: boolean;
  status: ProvisionPhaseStatus;
  details?: Record<string, unknown>;
  warnings?: string[];
  error?: string;
}

interface ProvisionFullRequest {
  name: string;
  role?: string | null;
  session_key?: string;
  workspace_path?: string;
  repo_path?: string | null;
  repo_url?: string | null;
  repo_access_mode?: 'worktree' | 'clone' | null;
  status?: string;
  runtime_type?: string;
  runtime_config?: AgentRuntimeConfigPayload;
  project_id?: number | null;
  preferred_provider?: string | null;
  model?: string | null;
  system_role?: string | null;
  hooks_url?: string | null;
  hooks_auth_header?: string | null;
  os_user?: string | null;
  enabled?: number | boolean;
  github_identity_id?: number | null;
  /** Legacy compatibility column; no longer active agent configuration. */
  job_title?: string;
  /** Deprecated legacy agent-run schedule. Ignored on writes; recurring task series are authoritative. */
  schedule?: string;
  job_instructions?: string | null;
  skill_names?: string[];
  timeout_seconds?: number | null;
  startup_grace_seconds?: number | null;
  heartbeat_stale_seconds?: number | null;
  stall_threshold_min?: number;
  max_retries?: number;
  sort_rules?: string[];
  openclaw_agent_id?: string;
  routing_rules?: Array<{
    sprint_id?: number | null;
    task_type: string;
    status: string;
    priority?: number;
  }>;
  tool_ids?: number[];
  mcp_server_ids?: number[];
  /** Deprecated legacy reflection schedule payload. Ignored; recurring task series are authoritative. */
  reflection?: {
    enabled?: boolean;
    schedule?: string;
  };
  restart_gateway?: boolean;
}

interface AgentInsertParams {
  tenantId: number | null;
  name: string;
  role: string;
  sessionKey: string;
  workspacePath: string;
  repoPath: string | null;
  repoUrl: string | null;
  repoAccessMode: 'worktree' | 'clone' | null;
  status: string;
  openclawAgentId: string | null;
  runtimeType: string;
  runtimeConfig: AgentRuntimeConfigPayload;
  projectId: number | null;
  preferredProvider: string;
  model: string | null;
  systemRole: string | null;
  hooksUrl: string | null;
  hooksAuthHeader: string | null;
  osUser: string | null;
  enabled: number;
  githubIdentityId: number | null;
  /** Legacy compatibility column; new agent configuration stores this blank. */
  jobTitle: string;
  /** Deprecated legacy agent-run schedule. Kept blank for compatibility with the agents table. */
  schedule: string;
  jobInstructions: string;
  skillNames: string[];
  timeoutSeconds: number;
  startupGraceSeconds: number | null;
  heartbeatStaleSeconds: number | null;
  stallThresholdMin: number;
  maxRetries: number;
  sortRules: string[];
}

interface WorkspaceScaffoldResult {
  workspacePath: string;
  memoryDir: string;
  docsWritten: string[];
}

interface OpenClawRegistrationResult {
  slug: string;
  workspacePath: string;
  agentDirPath: string;
  added: boolean;
  updated: boolean;
  gatewayRestarted: boolean;
  authProvidersSynced: string[];
}

function normalizeJsonArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function syncStoredProviderAuthProfiles(agentDirPath: string): string[] {
  return syncAvailableOAuthProfilesToAuthFile(agentDirPath);
}

function buildDefaultWorkspacePath(slug: string): string {
  return path.join(os.homedir(), '.openclaw', `workspace-${slug}`);
}

function buildDefaultAgentDirPath(slug: string): string {
  return path.join(os.homedir(), '.openclaw', 'agents', slug, 'agent');
}

function buildProvisionedDocTemplates(params: {
  name: string;
  role: string;
  projectName: string | null;
  sessionKey: string;
  runtimeSlug: string;
}): Record<string, string> {
  const projectLine = params.projectName ? `- **Project:** ${params.projectName}` : '- **Project:** Unassigned';
  return {
    'SOUL.md': `# SOUL.md — ${params.name}\n\nYou are ${params.name}${params.role ? `, ${params.role}` : ''}.\n\n## Core Principles\n- Be direct and useful.\n- Push back on weak assumptions.\n- Prefer concrete evidence over vague confidence.\n- Leave the workspace cleaner than you found it.\n`,
    'IDENTITY.md': `# IDENTITY.md — ${params.name}\n\n- **Name:** ${params.name}\n- **Role:** ${params.role || 'Agent'}\n${projectLine}\n- **Session Key:** ${params.sessionKey}\n- **Runtime Slug:** ${params.runtimeSlug}\n`,
    'USER.md': '# USER.md\n\nDocument the human/operator context this agent should learn over time.\n',
    'MEMORY.md': `# MEMORY.md — ${params.name}\n\nPersistent notes and durable context for future sessions.\n`,
    'TOOLS.md': `# TOOLS.md — ${params.name}\n\nEnvironment notes, operational shortcuts, and workspace-specific constraints.\n`,
    'HEARTBEAT.md': `# HEARTBEAT.md — ${params.name}\n\nWeekly reflection, execution notes, and operating cadence live here.\n`,
    'LESSONS.md': `# LESSONS.md — ${params.name}\n\nCapture failures, recoveries, and durable lessons worth reusing.\n`,
  };
}

function ensureWorkspaceScaffold(params: {
  name: string;
  role: string;
  projectName: string | null;
  sessionKey: string;
  runtimeSlug: string;
  workspacePath: string;
}): WorkspaceScaffoldResult {
  fs.mkdirSync(params.workspacePath, { recursive: true });
  const memoryDir = path.join(params.workspacePath, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });

  const docs = buildProvisionedDocTemplates(params);
  const docsWritten: string[] = [];
  for (const [filename, content] of Object.entries(docs)) {
    const target = path.join(params.workspacePath, filename);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, content, 'utf-8');
      docsWritten.push(filename);
    }
  }

  const canonicalAgentsPath = path.join(os.homedir(), '.openclaw', 'workspace', 'AGENTS.md');
  const agentsTarget = path.join(params.workspacePath, 'AGENTS.md');
  if (!fs.existsSync(agentsTarget)) {
    if (fs.existsSync(canonicalAgentsPath)) {
      fs.copyFileSync(canonicalAgentsPath, agentsTarget);
    } else {
      fs.writeFileSync(agentsTarget, `# AGENTS.md — ${params.name}\n\n1. Read SOUL.md\n2. Read IDENTITY.md\n3. Check MEMORY.md and LESSONS.md\n4. Execute the current assignment\n`, 'utf-8');
    }
    docsWritten.push('AGENTS.md');
  }

  return {
    workspacePath: params.workspacePath,
    memoryDir,
    docsWritten,
  };
}

function readOpenclawJsonOrDefault(): Record<string, unknown> {
  if (!fs.existsSync(resolveOpenClawJsonPath())) {
    return { agents: { list: [] } };
  }
  return readOpenclawJson();
}

function ensureOpenClawRegistration(params: {
  slug: string;
  workspacePath: string;
  model: string | null;
  restartGateway: boolean;
}): OpenClawRegistrationResult {
  const config = readOpenclawJsonOrDefault();
  const agentsConfig = (config.agents as Record<string, unknown> | undefined) ?? {};
  const list = (agentsConfig.list as Array<Record<string, unknown>> | undefined) ?? [];
  const agentDirPath = buildDefaultAgentDirPath(params.slug);
  fs.mkdirSync(agentDirPath, { recursive: true });
  const authProvidersSynced = syncStoredProviderAuthProfiles(agentDirPath);

  let added = false;
  let updated = false;
  const existing = list.find((entry) => entry.id === params.slug);
  if (existing) {
    existing.name = params.slug;
    existing.workspace = params.workspacePath;
    existing.agentDir = agentDirPath;
    if (params.model) existing.model = { primary: params.model };
    updated = true;
  } else {
    list.push({
      id: params.slug,
      name: params.slug,
      workspace: params.workspacePath,
      agentDir: agentDirPath,
      ...(params.model ? { model: { primary: params.model } } : {}),
    });
    added = true;
  }
  agentsConfig.list = list;
  config.agents = agentsConfig;
  writeOpenclawJson(config);

  let gatewayRestarted = false;
  if (params.restartGateway) {
    const gateway = ensureOpenClawGatewayAvailable();
    if (!gateway.ok) {
      throw new Error(gateway.message);
    }
    gatewayRestarted = true;
  }

  return {
    slug: params.slug,
    workspacePath: params.workspacePath,
    agentDirPath,
    added,
    updated,
    gatewayRestarted,
    authProvidersSynced,
  };
}

function insertProvisionedAgent(db: ReturnType<typeof getDb>, params: AgentInsertParams): number {
  const columns = [
    'tenant_id',
    'name', 'role', 'session_key', 'workspace_path', 'repo_path', 'repo_url', 'repo_access_mode', 'status', 'openclaw_agent_id',
    'runtime_type', 'runtime_config', 'project_id', 'preferred_provider', 'model', 'system_role',
    'hooks_url', 'hooks_auth_header', 'os_user', 'enabled', 'github_identity_id', 'job_title', 'schedule',
    'job_instructions', 'skill_names', 'timeout_seconds', 'startup_grace_seconds', 'heartbeat_stale_seconds',
    'stall_threshold_min', 'max_retries', 'sort_rules',
  ];

  const values: unknown[] = [
    params.tenantId,
    params.name,
    params.role,
    params.sessionKey,
    params.workspacePath,
    params.repoPath,
    params.repoUrl ?? null,
    params.repoAccessMode ?? (params.repoPath ? 'worktree' : null),
    params.status,
    params.openclawAgentId,
    params.runtimeType,
    params.runtimeConfig ? JSON.stringify(params.runtimeConfig) : null,
    params.projectId,
    params.preferredProvider,
    params.model,
    params.systemRole,
    params.hooksUrl,
    params.hooksAuthHeader,
    params.osUser,
    params.enabled,
    params.githubIdentityId,
    params.jobTitle,
    params.schedule,
    params.jobInstructions,
  ];
  values.push(
    JSON.stringify(params.skillNames),
    params.timeoutSeconds,
    params.startupGraceSeconds,
    params.heartbeatStaleSeconds,
    params.stallThresholdMin,
    params.maxRetries,
    JSON.stringify(params.sortRules),
  );

  const placeholders = columns.map(() => '?').join(', ');
  const result = db.prepare(`INSERT INTO agents (${columns.join(', ')}) VALUES (${placeholders})`).run(...values);
  return Number(result.lastInsertRowid);
}

function validateRoutingRules(routingRules: ProvisionFullRequest['routing_rules']): string[] {
  const errors: string[] = [];
  for (const rule of routingRules ?? []) {
    if (!rule.task_type || !rule.status) {
      errors.push('Each routing rule requires task_type and status');
      continue;
    }
    if (rule.sprint_id !== undefined && rule.sprint_id !== null && (!Number.isInteger(rule.sprint_id) || rule.sprint_id <= 0)) {
      errors.push(`Invalid sprint_id "${String(rule.sprint_id)}"`);
    }
    if (!isValidTaskType(rule.task_type)) {
      errors.push(`Invalid task_type "${rule.task_type}"`);
    }
  }
  return errors;
}

// GET /api/v1/agents
// Supports optional ?project_id=N filter.
// Each agent is enriched with project_id and project_name derived from their
// most-recently-updated job template (primary job). Agents with no jobs get nulls.
router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const projectId = req.query.project_id !== undefined ? Number(req.query.project_id) : null;
    const includeDeleted = req.query.include_deleted === '1' || req.query.include_deleted === 'true';

    const hasProjectsTable = tableHasColumn(db, 'projects', 'id');
    const hasProjectRepoColumns = ['repo_path', 'repo_url', 'repo_access_mode'].every((column) => tableHasColumn(db, 'projects', column));
    const hasDeletedAt = tableHasColumn(db, 'agents', 'deleted_at');

    // Task #594: agents table is the canonical entity.
    const baseQuery = `
      SELECT a.*,
        ${hasProjectsTable ? 'p.name                     AS project_name,' : 'NULL                       AS project_name,'}
        ${hasProjectRepoColumns ? 'p.repo_path                AS project_repo_path,\n        p.repo_url                 AS project_repo_url,\n        p.repo_access_mode         AS project_repo_access_mode' : 'NULL                        AS project_repo_path,\n        NULL                        AS project_repo_url,\n        NULL                        AS project_repo_access_mode'}
      FROM agents a
      ${hasProjectsTable ? 'LEFT JOIN projects p ON p.id = a.project_id' : ''}
    `;

    const visibleFilter = hasDeletedAt && !includeDeleted ? 'a.deleted_at IS NULL' : '';

    let agents: unknown[];
    if (projectId !== null) {
      const whereClause = [hasProjectsTable ? 'a.project_id = ?' : '1 = 0', visibleFilter, 'a.tenant_id = ?'].filter(Boolean).join(' AND ');
      agents = db.prepare(`${baseQuery} WHERE ${whereClause} ORDER BY a.created_at ASC`).all(projectId, tenantId);
    } else {
      const whereClause = [visibleFilter, 'a.tenant_id = ?'].filter(Boolean).join(' AND ');
      agents = db.prepare(`${baseQuery} WHERE ${whereClause} ORDER BY a.created_at ASC`).all(tenantId);
    }

    res.json(parseAgents(agents));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/agents/local-mlx/status — MUST be before /:id wildcard
// Proxies a health check to the local MLX server so the browser avoids CORS issues.
router.get('/local-mlx/status', async (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await new Promise<{ online: boolean; model?: string }>((resolve) => {
      const options = { hostname: '127.0.0.1', port: 8090, path: '/v1/models', method: 'GET', timeout: 8000 };
      const http = require('http');
      const request = http.request(options, (r: any) => {
        let body = '';
        r.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        r.on('end', () => {
          try {
            const json = JSON.parse(body);
            resolve({ online: true, model: json?.data?.[0]?.id ?? null });
          } catch {
            resolve({ online: r.statusCode === 200 });
          }
        });
      });
      request.on('error', () => resolve({ online: false }));
      request.on('timeout', () => { request.destroy(); resolve({ online: false }); });
      request.end();
    });
    res.json(result);
  } catch {
    res.json({ online: false });
  }
});

// POST /api/v1/agents/provision-full
// Atomic end-to-end OpenClaw agent provisioning with structured phase reporting.
router.post('/provision-full', async (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body as ProvisionFullRequest;
  const report: Record<string, ProvisionPhaseReport> = {};

  try {
    if (!body.name?.trim()) {
      return res.status(400).json({
        ok: false,
        report: {
          validation: { ok: false, status: 'failed', error: 'name is required' },
        },
      });
    }

    const runtimeType = body.runtime_type ?? 'openclaw';
    if (runtimeType !== 'openclaw' && runtimeType !== 'hermes') {
      return res.status(400).json({
        ok: false,
        report: {
          validation: { ok: false, status: 'failed', error: 'provision-full currently supports runtime_type=openclaw or hermes' },
        },
      });
    }

    const runtimeConfigValidationError = validateAgentRuntimeConfig(runtimeType, body.runtime_config ?? null);
    if (runtimeConfigValidationError) {
      return res.status(400).json({
        ok: false,
        report: {
          validation: { ok: false, status: 'failed', error: runtimeConfigValidationError },
        },
      });
    }

    const routingErrors = validateRoutingRules(body.routing_rules);
    if (routingErrors.length > 0) {
      return res.status(400).json({
        ok: false,
        report: {
          validation: { ok: false, status: 'failed', error: routingErrors.join('; ') },
        },
      });
    }

    const tenantId = resolveTenantIdFromRequest(db, req);
    const projectId = body.project_id ?? null;
    const projectName = getProjectName(projectId);
    const projectTenant = projectId == null ? null : db.prepare(`SELECT id FROM projects WHERE id = ? AND tenant_id = ?`).get(projectId, tenantId);
    if (projectId && (!projectName || !projectTenant)) {
      return res.status(404).json({
        ok: false,
        report: {
          validation: { ok: false, status: 'failed', error: `project_id ${projectId} not found` },
        },
      });
    }

    const resolvedSystemRole = body.system_role === ATLAS_SYSTEM_ROLE ? ATLAS_SYSTEM_ROLE : null;
    const resolvedRole = normalizeAgentRoleLabel(body.role ?? '', 'Agent');
    const runtimeSlug = body.openclaw_agent_id?.trim() || toSlug(body.name);
    const openclawAgentId = runtimeType === 'openclaw' ? runtimeSlug : null;
    const sessionKey = body.session_key || buildDefaultAgentSessionKey({
      name: body.name,
      role: resolvedRole,
      projectId,
      systemRole: resolvedSystemRole,
    });
    const workspacePath = body.workspace_path || buildDefaultWorkspacePath(runtimeSlug);
    const repoPayloadCheck = rejectAgentRepoPayload(body as unknown as Record<string, unknown>);
    if (!repoPayloadCheck.ok) {
      return res.status(repoPayloadCheck.status).json({
        ok: false,
        code: repoPayloadCheck.code,
        rejected_fields: repoPayloadCheck.rejected_fields,
        report: {
          validation: { ok: false, status: 'failed', error: repoPayloadCheck.error },
        },
      });
    }
    const schedule = '';
    const connectedProviders = getConnectedProviderSlugs(tenantId);
    const preferredProvider = runtimeType === 'hermes'
      ? (body.preferred_provider ?? resolveSchemaSafePreferredProvider(connectedProviders))
      : (body.preferred_provider ?? (connectedProviders.includes('openai') ? 'openai' : connectedProviders[0] ?? 'openai'));
    const resolvedModel = runtimeType === 'hermes'
      ? (body.model ?? null)
      : (body.model ?? defaultAgentModelForProvider(preferredProvider));
    if (!shouldSkipProviderValidationForRuntime(runtimeType, body.preferred_provider)) {
      const providerValidationError = validateAgentProviderSelection(tenantId, preferredProvider, resolvedModel);
      if (providerValidationError) {
        return res.status(400).json({
          ok: false,
          report: {
            validation: { ok: false, status: 'failed', error: providerValidationError },
          },
        });
      }
    }

    const duplicateName = db.prepare('SELECT id FROM agents WHERE lower(name) = lower(?) AND deleted_at IS NULL LIMIT 1').get(body.name) as { id: number } | undefined;
    if (duplicateName) {
      return res.status(409).json({
        ok: false,
        report: {
          validation: { ok: false, status: 'failed', error: `agent name "${body.name}" already exists` },
        },
      });
    }

    if (openclawAgentId) {
      const duplicateSlug = db.prepare('SELECT id FROM agents WHERE openclaw_agent_id = ? AND deleted_at IS NULL LIMIT 1').get(openclawAgentId) as { id: number } | undefined;
      if (duplicateSlug) {
        return res.status(409).json({
          ok: false,
          report: {
            validation: { ok: false, status: 'failed', error: `openclaw_agent_id "${openclawAgentId}" already exists` },
          },
        });
      }
    }

    const duplicateSession = db.prepare('SELECT id FROM agents WHERE session_key = ? AND deleted_at IS NULL LIMIT 1').get(sessionKey) as { id: number } | undefined;
    if (duplicateSession) {
      return res.status(409).json({
        ok: false,
        report: {
          validation: { ok: false, status: 'failed', error: `session_key "${sessionKey}" already exists` },
        },
      });
    }

    const toolIds = Array.isArray(body.tool_ids) ? body.tool_ids.map(Number).filter(id => Number.isFinite(id)) : [];
    const mcpServerIds = Array.isArray(body.mcp_server_ids) ? body.mcp_server_ids.map(Number).filter(id => Number.isFinite(id)) : [];
    for (const toolId of toolIds) {
      const row = db.prepare('SELECT id FROM tools WHERE id = ? AND tenant_id = ? AND enabled = 1').get(toolId, tenantId);
      if (!row) {
        return res.status(404).json({
          ok: false,
          report: {
            validation: { ok: false, status: 'failed', error: `tool_id ${toolId} not found or disabled` },
          },
        });
      }
    }
    for (const mcpServerId of mcpServerIds) {
      const row = db.prepare('SELECT id FROM mcp_servers WHERE id = ? AND tenant_id = ? AND enabled = 1').get(mcpServerId, tenantId);
      if (!row) {
        return res.status(404).json({
          ok: false,
          report: {
            validation: { ok: false, status: 'failed', error: `mcp_server_id ${mcpServerId} not found or disabled` },
          },
        });
      }
    }

    report.validation = {
      ok: true,
      status: 'verified',
      details: {
        runtime_type: runtimeType,
        project_id: projectId,
        session_key: sessionKey,
        runtime_slug: runtimeSlug,
      },
    };

    const openclawJsonPath = resolveOpenClawJsonPath();
    const openclawJsonExisted = fs.existsSync(openclawJsonPath);
    const openclawJsonBackup = openclawJsonExisted ? fs.readFileSync(openclawJsonPath, 'utf-8') : null;
    const workspaceExisted = fs.existsSync(workspacePath);
    const agentDirPath = buildDefaultAgentDirPath(runtimeSlug);
    const agentDirExisted = fs.existsSync(agentDirPath);
    let agentId: number | null = null;
    let createdRoutingRuleIds: number[] = [];
    let createdToolAssignmentIds: number[] = [];
    let createdMcpAssignmentIds: number[] = [];
    let workspaceResult: WorkspaceScaffoldResult | null = null;
    let openclawResult: OpenClawRegistrationResult | null = null;
    let runtimeAuthResult: RuntimeAuthProfileSyncResult | null = null;
    const legacyJobInstructionsError = getLegacyJobInstructionsFieldError(body as unknown as Record<string, unknown>);
    if (legacyJobInstructionsError) {
      return res.status(400).json({ error: legacyJobInstructionsError, field: 'job_instructions' });
    }
    const requestedJobInstructions = getRequestedJobInstructions(body as unknown as Record<string, unknown>) ?? '';

    const tx = db.transaction(() => {
      agentId = insertProvisionedAgent(db, {
        tenantId,
        name: body.name,
        role: resolvedRole,
        sessionKey,
        workspacePath,
        repoPath: null,
        repoUrl: null,
        repoAccessMode: null,
        status: body.status ?? 'idle',
        openclawAgentId,
        runtimeType,
        runtimeConfig: body.runtime_config ?? null,
        projectId,
        preferredProvider,
        model: resolvedModel,
        systemRole: resolvedSystemRole,
        hooksUrl: body.hooks_url ?? null,
        hooksAuthHeader: body.hooks_auth_header ?? null,
        osUser: body.os_user ?? null,
        enabled: body.enabled === undefined ? 1 : (body.enabled ? 1 : 0),
        githubIdentityId: body.github_identity_id ?? null,
        jobTitle: '',
        schedule,
        jobInstructions: requestedJobInstructions,
        skillNames: normalizeJsonArray(body.skill_names),
        timeoutSeconds: body.timeout_seconds ?? 900,
        startupGraceSeconds: body.startup_grace_seconds ?? null,
        heartbeatStaleSeconds: body.heartbeat_stale_seconds ?? null,
        stallThresholdMin: body.stall_threshold_min ?? 30,
        maxRetries: body.max_retries ?? 3,
        sortRules: normalizeJsonArray(body.sort_rules),
      });
      report.agent = {
        ok: true,
        status: 'created',
        details: { agent_id: agentId, runtime_slug: runtimeSlug, session_key: sessionKey },
      };

      workspaceResult = ensureWorkspaceScaffold({
        name: body.name,
        role: resolvedRole,
        projectName,
        sessionKey,
        runtimeSlug,
        workspacePath,
      });
      report.workspace = {
        ok: true,
        status: workspaceExisted ? 'updated' : 'created',
        details: {
          workspace_path: workspaceResult.workspacePath,
          memory_dir: workspaceResult.memoryDir,
          docs_written: workspaceResult.docsWritten,
        },
      };

      if (runtimeType === 'openclaw') {
        openclawResult = ensureOpenClawRegistration({
          slug: runtimeSlug,
          workspacePath,
          model: body.model ?? null,
          restartGateway: body.restart_gateway === true,
        });
        report.openclaw = {
          ok: true,
          status: openclawResult.added ? 'created' : 'updated',
          details: {
            openclaw_agent_id: openclawResult.slug,
            agent_dir: openclawResult.agentDirPath,
            gateway_restarted: openclawResult.gatewayRestarted,
            auth_providers_synced: openclawResult.authProvidersSynced,
            openclaw_auth_providers_synced: openclawResult.authProvidersSynced,
          },
        };
      } else {
        fs.mkdirSync(agentDirPath, { recursive: true });
        report.openclaw = {
          ok: true,
          status: 'skipped',
          details: {
            reason: `${runtimeType} agents are not registered as OpenClaw native agents`,
          },
        };
        report.runtime = {
          ok: true,
          status: agentDirExisted ? 'reused' : 'created',
          details: {
            runtime_type: runtimeType,
            agent_dir: agentDirPath,
          },
        };
      }

      const sprintRoutingStmt = db.prepare(`
        INSERT INTO sprint_task_routing_rules (sprint_id, task_type, status, agent_id, priority)
        VALUES (?, ?, ?, ?, ?)
      `);
      const activeProjectSprintIds = body.project_id == null
        ? []
        : db.prepare(`
            SELECT id
            FROM sprints
            WHERE project_id = ?
              AND status IN ('planning', 'active', 'paused')
          `).all(body.project_id).map((row: any) => Number(row.id));
      for (const rule of body.routing_rules ?? []) {
        const targetSprintIds = rule.sprint_id != null
          ? [Number(rule.sprint_id)]
          : activeProjectSprintIds;
        if (targetSprintIds.length === 0) {
          throw new Error('routing_rules entries must include sprint_id or the agent project must have at least one non-closed sprint');
        }
        for (const sprintId of targetSprintIds) {
          seedSprintTaskPolicy(db, sprintId);
          const result = sprintRoutingStmt.run(sprintId, rule.task_type, rule.status, agentId, rule.priority ?? 0);
          createdRoutingRuleIds.push(Number(result.lastInsertRowid));
        }
      }
      report.routing = {
        ok: true,
        status: createdRoutingRuleIds.length > 0 ? 'created' : 'skipped',
        details: { rule_ids: createdRoutingRuleIds },
      };

      const toolStmt = db.prepare(`
        INSERT INTO agent_tool_assignments (agent_id, tool_id, overrides, enabled)
        VALUES (?, ?, '{}', 1)
      `);
      for (const toolId of toolIds) {
        const result = toolStmt.run(agentId, toolId);
        createdToolAssignmentIds.push(Number(result.lastInsertRowid));
      }

      const mcpStmt = db.prepare(`
        INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id, overrides, enabled)
        VALUES (?, ?, '{}', 1)
      `);
      for (const mcpServerId of mcpServerIds) {
        const result = mcpStmt.run(agentId, mcpServerId);
        createdMcpAssignmentIds.push(Number(result.lastInsertRowid));
      }

      const adapter = getSkillMaterializationAdapter(runtimeType);
      const skillResult = adapter.materialize({
        workingDirectory: workspacePath,
        skillNames: normalizeJsonArray(body.skill_names),
        skillsBasePath: OPENCLAW_SKILLS_PATH,
        hooksUrl: body.hooks_url ?? null,
        runtimeConfig: (body.runtime_config as Record<string, unknown> | null | undefined) ?? null,
        db,
        tenantId,
      });
      if (!skillResult.ok) {
        throw new Error(skillResult.error ?? `${runtimeType} skill materialization failed`);
      }

      const mcpResult = syncAssignedMcpForAgent({
        db,
        agentId,
        workingDirectory: workspacePath,
        materializeOpenClawGlobalConfig: true,
      });
      if (!mcpResult.ok) {
        throw new Error(mcpResult.error ?? `${runtimeType} MCP materialization failed`);
      }

      report.capabilities = {
        ok: true,
        status: (createdToolAssignmentIds.length > 0 || createdMcpAssignmentIds.length > 0 || normalizeJsonArray(body.skill_names).length > 0) ? 'created' : 'skipped',
        details: {
          skill_names: normalizeJsonArray(body.skill_names),
          skill_materialization_count: skillResult.count,
          mcp_materialization_count: mcpResult.count,
          mcp_materialization_path: mcpResult.path ?? null,
          tool_assignment_ids: createdToolAssignmentIds,
          mcp_assignment_ids: createdMcpAssignmentIds,
        },
        warnings: [...skillResult.warnings, ...mcpResult.warnings],
      };
    });

    try {
      tx();
    } catch (err) {
      if (!workspaceExisted && fs.existsSync(workspacePath)) {
        fs.rmSync(workspacePath, { recursive: true, force: true });
      }
      if (!agentDirExisted && fs.existsSync(agentDirPath)) {
        fs.rmSync(agentDirPath, { recursive: true, force: true });
      }
      if (openclawJsonBackup !== null) {
        fs.writeFileSync(openclawJsonPath, openclawJsonBackup, 'utf-8');
      } else if (!openclawJsonExisted && fs.existsSync(openclawJsonPath)) {
        fs.rmSync(openclawJsonPath, { force: true });
      }
      report.provision = {
        ok: false,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
      return res.status(500).json({
        ok: false,
        agent_id: agentId,
        report,
      });
    }

    runtimeAuthResult = await resolveRuntime({
      runtime_type: runtimeType,
      runtime_config: body.runtime_config ?? null,
    }).prepareAuthProfiles({
      agentSlug: runtimeSlug,
      preferredProvider,
      runtimeConfig: body.runtime_config ?? null,
    });
    report.auth = {
      ok: runtimeAuthResult.ok,
      status: runtimeAuthResult.status,
      ...(runtimeAuthResult.error ? { error: runtimeAuthResult.error } : {}),
      details: {
        providers_synced: runtimeAuthResult.providersSynced,
        runtime_auth_providers_synced: runtimeAuthResult.runtimeAuthProvidersSynced,
        openclaw_auth_providers_synced: runtimeAuthResult.openclawAuthProvidersSynced,
        runtime_auth_path: runtimeAuthResult.runtimeAuthPath ?? null,
        openclaw_auth_path: runtimeAuthResult.openclawAuthPath ?? null,
        source: runtimeAuthResult.source ?? null,
        refreshed: runtimeAuthResult.refreshed ?? false,
        ...(runtimeAuthResult.details ?? {}),
      },
    };
    if (!runtimeAuthResult.ok) {
      report.provision = {
        ok: false,
        status: 'failed',
        error: runtimeAuthResult.error ?? `${runtimeType} runtime auth profile preparation failed`,
      };
      return res.status(500).json({
        ok: false,
        agent_id: agentId,
        report,
      });
    }

    const agent = selectAgentWithProject(db, Number(agentId), true);

    let openclawRegistered = false;
    try {
      const config = readOpenclawJsonOrDefault();
      const agentsCfg = (config.agents as Record<string, unknown> | undefined) ?? {};
      const list = (agentsCfg.list as Array<Record<string, unknown>> | undefined) ?? [];
      openclawRegistered = list.some(entry => entry.id === runtimeSlug);
    } catch {
      openclawRegistered = false;
    }

    const requiredWorkspaceDocs = ['SOUL.md', 'AGENTS.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md', 'MEMORY.md', 'LESSONS.md'];
    const workspaceDocsPresent = requiredWorkspaceDocs.every(doc => fs.existsSync(path.join(workspacePath, doc)));
    report.verification = {
      ok: Boolean(
        agent
        && fs.existsSync(workspacePath)
        && workspaceDocsPresent
        && fs.existsSync(path.join(workspacePath, 'memory'))
        && (runtimeType !== 'openclaw' || openclawRegistered),
      ),
      status: 'verified',
      details: {
        agent_id: agentId,
        workspace_exists: fs.existsSync(workspacePath),
        workspace_docs_present: workspaceDocsPresent,
        required_workspace_docs: requiredWorkspaceDocs,
        memory_dir_exists: fs.existsSync(path.join(workspacePath, 'memory')),
        openclaw_registered: openclawRegistered,
        runtime_auth_status: runtimeAuthResult.status,
        runtime_auth_path: runtimeAuthResult.runtimeAuthPath ?? null,
        runtime_auth_providers_synced: runtimeAuthResult.runtimeAuthProvidersSynced,
        openclaw_auth_providers_synced: runtimeAuthResult.openclawAuthProvidersSynced,
        routing_rule_count: createdRoutingRuleIds.length,
        tool_assignment_count: createdToolAssignmentIds.length,
        mcp_assignment_count: createdMcpAssignmentIds.length,
      },
    };

    return res.status(201).json({
      ok: true,
      agent: agent ? parseAgentRuntimeConfig(agent) : null,
      created_resource_ids: {
        agent_id: agentId,
        routing_rule_ids: createdRoutingRuleIds,
        tool_assignment_ids: createdToolAssignmentIds,
        mcp_assignment_ids: createdMcpAssignmentIds,
      },
      report,
    });
  } catch (err) {
    report.provision = {
      ok: false,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
    return res.status(500).json({ ok: false, report });
  }
});

router.get('/:id/mcp-permissions', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const agentId = Number(req.params.id);
    if (!Number.isInteger(agentId) || agentId <= 0) {
      return res.status(400).json({ error: 'Invalid agent id' });
    }
    if (!requireAgentVisibleForTenant(db, agentId, tenantId)) return res.status(404).json({ error: 'Agent not found' });
    return res.json(getAgentMcpPermissionPolicy(db, agentId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) return res.status(404).json({ error: message });
    return res.status(500).json({ error: message });
  }
});

router.put('/:id/mcp-permissions', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const agentId = Number(req.params.id);
    if (!Number.isInteger(agentId) || agentId <= 0) {
      return res.status(400).json({ error: 'Invalid agent id' });
    }

    const body = req.body as { enabled_capabilities?: unknown };
    if (!Array.isArray(body.enabled_capabilities) || !body.enabled_capabilities.every((value) => typeof value === 'string')) {
      return res.status(400).json({ error: 'enabled_capabilities must be an array of capability keys' });
    }

    return res.json(replaceAgentMcpPermissionPolicy(db, agentId, body.enabled_capabilities));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) return res.status(404).json({ error: message });
    if (message.includes('Unknown Agent HQ MCP capability')) return res.status(400).json({ error: message });
    return res.status(500).json({ error: message });
  }
});

router.delete('/:id/mcp-permissions', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const agentId = Number(req.params.id);
    if (!Number.isInteger(agentId) || agentId <= 0) {
      return res.status(400).json({ error: 'Invalid agent id' });
    }
    if (!requireAgentVisibleForTenant(db, agentId, tenantId)) return res.status(404).json({ error: 'Agent not found' });
    return res.json(resetAgentMcpPermissionPolicy(db, agentId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) return res.status(404).json({ error: message });
    return res.status(500).json({ error: message });
  }
});

// GET /api/v1/agents/:id
// Phase 4 (T#459): agents table has job-template columns; enrich with project_name + job_template_id
router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const agent = selectAgentWithProjectForTenant(
      db,
      req.params.id,
      tenantId,
      req.query.include_deleted === '1' || req.query.include_deleted === 'true',
    );
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    return res.json(parseAgentRuntimeConfig(agent));
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// POST /api/v1/agents
router.post('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const rawBody = req.body as Record<string, unknown>;
    const legacyJobInstructionsError = getLegacyJobInstructionsFieldError(rawBody);
    if (legacyJobInstructionsError) {
      return res.status(400).json({ error: legacyJobInstructionsError, field: 'job_instructions' });
    }
    const requestedJobInstructions = getRequestedJobInstructions(rawBody) ?? '';
    const { 
      name, role, session_key, workspace_path, repo_path, repo_url, repo_access_mode, status, provision_openclaw,
      runtime_type, runtime_config, project_id, preferred_provider, model, system_role,
      hooks_url, hooks_auth_header, os_user, enabled, github_identity_id,
      schedule: _legacySchedule, skill_names, timeout_seconds,
      startup_grace_seconds, heartbeat_stale_seconds, stall_threshold_min, max_retries, sort_rules,
    } = req.body as {
      name: string;
      role?: string;
      session_key?: string;
      workspace_path?: string;
      repo_path?: string | null;
      repo_url?: string | null;
      repo_access_mode?: 'worktree' | 'clone' | null;
      status?: string;
      provision_openclaw?: boolean;
      runtime_type?: string;
      runtime_config?: AgentRuntimeConfigPayload;
      project_id?: number | null;
      preferred_provider?: string | null;
      model?: string | null;
      system_role?: string | null;
      hooks_url?: string | null;
      hooks_auth_header?: string | null;
      os_user?: string | null;
      enabled?: number | boolean;
      github_identity_id?: number | null;
      /** Deprecated legacy agent-run schedule. Ignored on create; recurring task series are authoritative. */
      schedule?: string;
      job_instructions?: string | null;
      skill_names?: string[];
      timeout_seconds?: number | null;
      startup_grace_seconds?: number | null;
      heartbeat_stale_seconds?: number | null;
      stall_threshold_min?: number;
      max_retries?: number;
      sort_rules?: string[];
    };
    const connectedProviders = getConnectedProviderSlugs(tenantId);
    const resolvedRole = normalizeAgentRoleLabel(role ?? '', 'Agent');

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const projectTenant = project_id == null ? null : db.prepare(`SELECT id FROM projects WHERE id = ? AND tenant_id = ?`).get(project_id, tenantId);
    if (project_id && (!getProjectName(project_id) || !projectTenant)) {
      return res.status(404).json({ error: `project_id ${project_id} not found` });
    }

    const effectiveRuntimeTypeCreate = runtime_type ?? 'openclaw';
    const runtimeConfigValidationError = validateAgentRuntimeConfig(
      effectiveRuntimeTypeCreate,
      runtime_config ?? null,
    );
    if (runtimeConfigValidationError) {
      return res.status(400).json({ error: runtimeConfigValidationError });
    }

    const schemaSafePreferredProvider = resolveSchemaSafePreferredProvider(connectedProviders);
    // agents.preferred_provider is NOT NULL in the live schema. Hermes agents
    // carry their runtime-specific provider/model inside runtime_config, so when
    // the top-level preferred_provider is omitted keep CRUD schema-safe without
    // forcing disconnected provider validation through an unrelated field.
    const resolvedPreferredProvider = preferred_provider
      ?? schemaSafePreferredProvider;

    const resolvedCreateModel = effectiveRuntimeTypeCreate === 'hermes'
      ? (model ?? null)
      : (model ?? defaultAgentModelForProvider(resolvedPreferredProvider));
    if (!shouldSkipProviderValidationForRuntime(effectiveRuntimeTypeCreate, preferred_provider)) {
      const providerValidationError = validateAgentProviderSelection(tenantId, resolvedPreferredProvider, resolvedCreateModel);
      if (providerValidationError) {
        return res.status(400).json({ error: providerValidationError });
      }
    }

    const resolvedSystemRole = system_role === ATLAS_SYSTEM_ROLE ? ATLAS_SYSTEM_ROLE : null;

    // Optionally provision an OpenClaw native agent (only when runtime is openclaw)
    let openclawAgentId: string | null = null;
    let resolvedSessionKey = session_key
      || buildDefaultAgentSessionKey({
        name,
        role: resolvedRole,
        projectId: project_id ?? null,
        systemRole: resolvedSystemRole,
      });
    let resolvedWorkspacePath = workspace_path ?? '';

    if (provision_openclaw && effectiveRuntimeTypeCreate === 'openclaw') {
      // Derive a clean agent ID from the name (lowercase, hyphens)
      const agentId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const homedir = process.env.HOME ?? os.homedir();
      resolvedWorkspacePath = workspace_path || path.join(homedir, '.openclaw', `workspace-${agentId}`);
      // Create workspace dir first
      fs.mkdirSync(resolvedWorkspacePath, { recursive: true });
      try {
        requireOpenClawOutput(
          ['agents', 'add', agentId, '--non-interactive', '--workspace', resolvedWorkspacePath],
          { stdio: 'pipe', timeout: 30000 },
        );
        console.log(`[agents] Provisioned OpenClaw agent: ${agentId}`);
      } catch (provErr) {
        const msg = provErr instanceof Error ? (provErr as NodeJS.ErrnoException & { stderr?: Buffer }).stderr?.toString() ?? provErr.message : String(provErr);
        console.warn(`[agents] openclaw agents add ${agentId}: ${msg}`);
        // Non-fatal — still create the DB record
      }
      openclawAgentId = agentId;
      // Use canonical Agent HQ identity by default; keep the runtime slug separate.
      resolvedSessionKey = session_key || buildDefaultAgentSessionKey({
        name,
        role: resolvedRole,
        projectId: project_id ?? null,
        systemRole: resolvedSystemRole,
      });
    }

    const repoPayloadCheck = rejectAgentRepoPayload(rawBody);
    if (!repoPayloadCheck.ok) {
      return res.status(repoPayloadCheck.status).json({
        error: repoPayloadCheck.error,
        code: repoPayloadCheck.code,
        rejected_fields: repoPayloadCheck.rejected_fields,
      });
    }

    const createdAgentId = insertProvisionedAgent(db, {
      tenantId,
      name,
      role: resolvedRole,
      sessionKey: resolvedSessionKey,
      workspacePath: resolvedWorkspacePath,
      repoPath: null,
      repoUrl: null,
      repoAccessMode: null,
      status: status ?? 'idle',
      openclawAgentId,
      runtimeType: effectiveRuntimeTypeCreate,
      runtimeConfig: runtime_config ?? null,
      projectId: project_id ?? null,
      preferredProvider: resolvedPreferredProvider,
      model: resolvedCreateModel,
      systemRole: resolvedSystemRole,
      hooksUrl: hooks_url ?? null,
      hooksAuthHeader: hooks_auth_header ?? null,
      osUser: os_user ?? null,
      enabled: enabled === undefined ? 1 : (enabled ? 1 : 0),
      githubIdentityId: github_identity_id ?? null,
      jobTitle: '',
      schedule: '',
      jobInstructions: requestedJobInstructions,
      skillNames: normalizeJsonArray(skill_names),
      timeoutSeconds: timeout_seconds ?? 900,
      startupGraceSeconds: startup_grace_seconds ?? null,
      heartbeatStaleSeconds: heartbeat_stale_seconds ?? null,
      stallThresholdMin: stall_threshold_min ?? 30,
      maxRetries: max_retries ?? 3,
      sortRules: normalizeJsonArray(sort_rules),
    });

    const agent = selectAgentWithProject(db, createdAgentId, true) as Record<string, unknown>;
    syncStarterRoutingForProject(db, project_id ?? null);
    if ((agent.runtime_type as string | null) === 'openclaw' && (agent.workspace_path as string | null)) {
      setImmediate(() => {
        try {
          const mcpResult = syncAssignedMcpForAgent({
            db,
            agentId: createdAgentId,
            workingDirectory: agent.workspace_path as string,
            materializeOpenClawGlobalConfig: true,
          });
          for (const warn of mcpResult.warnings) console.warn(`[agents.post] ${warn}`);
        } catch (mcpErr) {
          console.warn(
            `[agents.post] MCP materialization failed for agent #${String(createdAgentId)}:`,
            mcpErr instanceof Error ? mcpErr.message : String(mcpErr),
          );
        }
      });
    }
    return res.status(201).json(parseAgentRuntimeConfig(agent));
  } catch (err) {
    const msg = String(err);
    if (msg.includes('UNIQUE')) return res.status(409).json({ error: 'session_key already exists' });
    return res.status(500).json({ error: msg });
  }
});

// PUT /api/v1/agents/:id
router.put('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const rawBody = req.body as Record<string, unknown>;
    const legacyJobInstructionsError = getLegacyJobInstructionsFieldError(rawBody);
    if (legacyJobInstructionsError) {
      return res.status(400).json({ error: legacyJobInstructionsError, field: 'job_instructions' });
    }
    const requestedJobInstructions = getRequestedJobInstructions(rawBody);
    const {
      name, role, session_key, workspace_path, repo_path, repo_url, repo_access_mode, status, model,
      runtime_type, runtime_config, hooks_url, hooks_auth_header,
      preferred_provider, os_user, enabled, github_identity_id,
      schedule: _legacySchedule, skill_names, timeout_seconds,
      // Watchdog per-agent timeout overrides (T#681)
      startup_grace_seconds, heartbeat_stale_seconds,
      // Routing config fields (T#594/T#596): absorbed from former routing_config_legacy
      stall_threshold_min, max_retries, sort_rules,
      // Project association
      project_id,
      system_role,
    } = req.body as {
      name?: string;
      role?: string;
      session_key?: string;
      workspace_path?: string;
      /**
       * repo_path — absolute path to the git repository used for worktree isolation (T#365).
       * When set, the dispatcher creates an isolated worktree per task under this repo so agents
       * never touch the main checkout. Set to null/empty to disable worktree isolation.
       */
      repo_path?: string | null;
      repo_url?: string | null;
      repo_access_mode?: 'worktree' | 'clone' | null;
      status?: string;
      model?: string | null;
      runtime_type?: string;
      runtime_config?: AgentRuntimeConfigPayload;
      /**
       * Remote Gateway URL. Stored in hooks_url for compatibility with existing records.
       * When null the dispatcher falls back to the host gateway.
       */
      hooks_url?: string | null;
      /**
       * Remote Gateway Auth Header. Stored in hooks_auth_header for compatibility.
       * e.g. "Bearer <token>". When set, dispatcher uses this instead of the global HOOKS_TOKEN.
       */
      hooks_auth_header?: string | null;
      /** preferred_provider — which AI provider to prefer for model routing (default: 'anthropic') */
      preferred_provider?: string | null;
      /** os_user — dedicated macOS OS user for filesystem isolation (e.g. "agent-forge"). Null = no isolation. */
      os_user?: string | null;
      /** enabled — whether this agent is eligible for routing (1 = enabled, 0 = disabled) */
      enabled?: number | boolean;
      /** github_identity_id — FK to github_identities for per-agent GitHub credentials (task #613) */
      github_identity_id?: number | null;
      /** Deprecated legacy agent-run schedule. Ignored on update; recurring task series are authoritative. */
      schedule?: string;
      /** job_instructions — canonical pre-task instructions appended to dispatch payload (T#619/T#407) */
      job_instructions?: string | null;
      /** skill_names — JSON array of skill names (T#619) */
      skill_names?: string[];
      /** timeout_seconds — job timeout in seconds (T#619) */
      timeout_seconds?: number | null;
      /** startup_grace_seconds — watchdog startup grace override per-agent (T#681). NULL = global default. */
      startup_grace_seconds?: number | null;
      /** heartbeat_stale_seconds — watchdog heartbeat stale override per-agent (T#681). NULL = global default. */
      heartbeat_stale_seconds?: number | null;
      /** stall_threshold_min — stall detection threshold in minutes (T#594) */
      stall_threshold_min?: number;
      /** max_retries — max dispatch retry count (T#594) */
      max_retries?: number;
      /** sort_rules — JSON array of sort criteria for candidate selection (T#594) */
      sort_rules?: string[];
      /** project_id — associate agent with a project (T#27) */
      project_id?: number | null;
      /** system_role — reserved built-in role identity */
      system_role?: string | null;
    };

    const agent = db.prepare('SELECT * FROM agents WHERE id = ? AND tenant_id = ?').get(req.params.id, tenantId) as Record<string, unknown> | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const previousProjectId = (agent.project_id as number | null | undefined) ?? null;
    const resolvedRole = role !== undefined
      ? normalizeAgentRoleLabel(role, 'Agent')
      : String(agent.role ?? '');
    const resolvedProjectId = project_id !== undefined ? project_id : (agent.project_id as number | null | undefined) ?? null;
    const resolvedName = name ?? String(agent.name ?? '');
    const currentSessionKey = String(agent.session_key ?? '');

    const resolvedProjectTenant = resolvedProjectId == null
      ? null
      : db.prepare(`SELECT id FROM projects WHERE id = ? AND tenant_id = ?`).get(resolvedProjectId, tenantId);
    if (resolvedProjectId && (!getProjectName(resolvedProjectId) || !resolvedProjectTenant)) {
      return res.status(404).json({ error: `project_id ${resolvedProjectId} not found` });
    }

    const effectiveRuntimeType = typeof runtime_type === 'string'
      ? runtime_type
      : (typeof agent.runtime_type === 'string' ? agent.runtime_type : 'openclaw');
    const effectiveRuntimeConfig = runtime_config !== undefined
      ? runtime_config
      : parseRuntimeConfigObject(agent.runtime_config);
    const runtimeConfigValidationError = validateAgentRuntimeConfig(
      effectiveRuntimeType,
      (effectiveRuntimeConfig as AgentRuntimeConfigPayload) ?? null,
    );
    if (runtimeConfigValidationError) {
      return res.status(400).json({ error: runtimeConfigValidationError });
    }

    const schemaSafePreferredProvider = resolveSchemaSafePreferredProvider(getConnectedProviderSlugs(tenantId));
    const existingPreferredProvider = (agent.preferred_provider as string | null | undefined) ?? null;
    const resolvedPreferredProvider = preferred_provider !== undefined
      ? (preferred_provider ?? existingPreferredProvider ?? schemaSafePreferredProvider)
      : (existingPreferredProvider ?? schemaSafePreferredProvider);
    const resolvedModelInput = model !== undefined ? model : (agent.model as string | null | undefined);
    const resolvedModel = effectiveRuntimeType === 'hermes'
      ? (resolvedModelInput ?? null)
      : (resolvedModelInput ?? defaultAgentModelForProvider(resolvedPreferredProvider));
    if (!shouldSkipProviderValidationForRuntime(effectiveRuntimeType, preferred_provider)) {
      const providerValidationError = validateAgentProviderSelection(tenantId, resolvedPreferredProvider, resolvedModel);
      if (providerValidationError) {
        return res.status(400).json({ error: providerValidationError });
      }
    }

    const repoPayloadCheck = rejectAgentRepoPayload(rawBody);
    if (!repoPayloadCheck.ok) {
      return res.status(repoPayloadCheck.status).json({
        error: repoPayloadCheck.error,
        code: repoPayloadCheck.code,
        rejected_fields: repoPayloadCheck.rejected_fields,
      });
    }

    // Resolve skill_names as JSON
    const resolvedSkillNames = skill_names !== undefined
      ? JSON.stringify(Array.isArray(skill_names) ? skill_names : [])
      : (agent.skill_names as string | null) ?? '[]';

    // Resolve sort_rules as JSON (T#594)
    const resolvedSortRules = sort_rules !== undefined
      ? JSON.stringify(Array.isArray(sort_rules) ? sort_rules : [])
      : (agent.sort_rules as string | null) ?? '[]';

    const resolvedSystemRole = system_role === undefined
      ? (agent.system_role as string | null) ?? null
      : (system_role === ATLAS_SYSTEM_ROLE ? ATLAS_SYSTEM_ROLE : null);
    const resolvedSessionKey = session_key !== undefined
      ? session_key
      : currentSessionKey;
    const jobInstructionsProvided = requestedJobInstructions !== undefined;
    const resolvedJobInstructions = requestedJobInstructions ?? getStoredJobInstructions(agent);

    const updateClauses = [
      'name = ?',
      'role = ?',
      'session_key = ?',
      'workspace_path = ?',
      'status = ?',
      'model = ?',
      'runtime_type = ?',
      'runtime_config = ?',
      'hooks_url = ?',
      'hooks_auth_header = ?',
      'preferred_provider = ?',
      'os_user = ?',
      'enabled = ?',
      'github_identity_id = ?',
      'schedule = ?',
      'job_instructions = ?',
      'skill_names = ?',
      'timeout_seconds = ?',
      'startup_grace_seconds = ?',
      'heartbeat_stale_seconds = ?',
      'stall_threshold_min = ?',
      'max_retries = ?',
      'sort_rules = ?',
      'project_id = ?',
      'system_role = ?',
      `last_active = datetime('now')`,
    ];
    const updateValues: unknown[] = [
      resolvedName,
      resolvedRole,
      resolvedSessionKey,
      workspace_path ?? agent.workspace_path,
      status ?? agent.status,
      resolvedModel,
      runtime_type !== undefined ? runtime_type : (agent.runtime_type ?? 'openclaw'),
      runtime_config !== undefined
        ? (runtime_config != null ? JSON.stringify(runtime_config) : null)
        : agent.runtime_config,
      hooks_url !== undefined ? hooks_url : agent.hooks_url,
      hooks_auth_header !== undefined ? hooks_auth_header : (agent.hooks_auth_header ?? null),
      resolvedPreferredProvider,
      os_user !== undefined ? os_user : (agent.os_user ?? null),
      enabled !== undefined ? (enabled ? 1 : 0) : agent.enabled,
      github_identity_id !== undefined ? github_identity_id : (agent.github_identity_id ?? null),
      '',
      resolvedJobInstructions,
      resolvedSkillNames,
      timeout_seconds !== undefined ? timeout_seconds : (agent.timeout_seconds as number | null) ?? 900,
      startup_grace_seconds !== undefined ? startup_grace_seconds : (agent.startup_grace_seconds as number | null) ?? null,
      heartbeat_stale_seconds !== undefined ? heartbeat_stale_seconds : (agent.heartbeat_stale_seconds as number | null) ?? null,
      stall_threshold_min !== undefined ? stall_threshold_min : (agent.stall_threshold_min as number | null) ?? 30,
      max_retries !== undefined ? max_retries : (agent.max_retries as number | null) ?? 3,
      resolvedSortRules,
      resolvedProjectId,
      resolvedSystemRole,
    ];
    updateValues.push(req.params.id);

    db.prepare(`UPDATE agents SET ${updateClauses.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...updateValues, tenantId);

    // Track job_instructions changes for prompt effectiveness analytics (#586)
    if (jobInstructionsProvided && resolvedJobInstructions !== getStoredJobInstructions(agent)) {
      try {
        const agentCols = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>;
        const hasUpdatedAt = agentCols.some((c: { name: string }) => c.name === 'job_instructions_updated_at');
        const hasVersion = agentCols.some((c: { name: string }) => c.name === 'instructions_version');
        if (hasUpdatedAt || hasVersion) {
          const clauses: string[] = [];
          if (hasUpdatedAt) clauses.push(`job_instructions_updated_at = datetime('now')`);
          if (hasVersion) clauses.push(`instructions_version = instructions_version + 1`);
          db.prepare(`UPDATE agents SET ${clauses.join(', ')} WHERE id = ?`).run(req.params.id);
        }
      } catch { /* non-fatal */ }
    }

    const updated = selectAgentWithProject(db, req.params.id, true) as Record<string, unknown>;
    const nextProjectId = (updated.project_id as number | null | undefined) ?? null;
    syncStarterRoutingForProject(db, previousProjectId);
    if (nextProjectId !== previousProjectId) {
      syncStarterRoutingForProject(db, nextProjectId);
    }

    // Keep OpenClaw agent config in sync for provisioned openclaw-runtime agents.
    // Without this, Agent HQ can update the DB model/provider while ~/.openclaw/openclaw.json
    // still points at an older model, causing openclaw status and fresh defaulted sessions to drift.
    if ((updated.runtime_type as string | null) === 'openclaw') {
      try {
        const slug = resolveSlug(updated);
        const config = readOpenclawJson();
        const agentsConfig = (config.agents as Record<string, unknown> | undefined) ?? {};
        const list = (agentsConfig.list as Array<Record<string, unknown>> | undefined) ?? [];
        const entry = list.find((a) => a.id === slug);
        if (entry) {
          entry.name = slug;
          if (updated.workspace_path) entry.workspace = updated.workspace_path as string;
          const homedir = os.homedir();
          entry.agentDir = path.join(homedir, '.openclaw', 'agents', slug, 'agent');
          const modelValue = (updated.model as string | null | undefined)?.trim();
          if (modelValue) {
            entry.model = { primary: modelValue };
            ensureOpenClawCodexRuntime(entry, modelValue, updated.preferred_provider as string | null | undefined);
          } else if (entry.model && typeof entry.model === 'object') {
            delete (entry.model as Record<string, unknown>).primary;
          }
          agentsConfig.list = list;
          config.agents = agentsConfig;
          writeOpenclawJson(config);
          setImmediate(() => {
            try {
              const gateway = ensureOpenClawGatewayAvailable();
              if (!gateway.ok) {
                throw new Error(gateway.message);
              }
            } catch (restartErr) {
              console.warn(
                `[agents.put] openclaw gateway restart failed after syncing agent #${req.params.id}:`,
                restartErr instanceof Error ? restartErr.message : String(restartErr),
              );
            }
          });
        }
      } catch (syncErr) {
        console.warn(
          `[agents.put] failed to sync openclaw.json for agent #${req.params.id}:`,
          syncErr instanceof Error ? syncErr.message : String(syncErr),
        );
      }
    }

    // ── Task #644: propagate skill assignment changes to runtime artifacts ──
    // When skill_names changes, re-materialize runtime artifacts in the background
    // so the workspace reflects the updated assignment without requiring a full dispatch.
    if (skill_names !== undefined && (updated.workspace_path as string | null)) {
      const workingDirectory = updated.workspace_path as string;
      const runtimeType = (updated.runtime_type as string | null) ?? 'openclaw';
      let rematerializeRuntimeConfig: Record<string, unknown> | null = null;
      try {
        rematerializeRuntimeConfig = typeof updated.runtime_config === 'string'
          ? JSON.parse(updated.runtime_config as string)
          : (updated.runtime_config as Record<string, unknown> | null);
      } catch {
        rematerializeRuntimeConfig = null;
      }
      let syncSkillNames: string[] = [];
      try {
        const parsed = JSON.parse(resolvedSkillNames);
        if (Array.isArray(parsed)) syncSkillNames = parsed.filter((s): s is string => typeof s === 'string');
      } catch { /* ignore */ }

      setImmediate(() => {
        try {
          const adapter = getSkillMaterializationAdapter(runtimeType);
          const result = adapter.materialize({
            workingDirectory,
            skillNames: syncSkillNames,
            skillsBasePath: OPENCLAW_SKILLS_PATH,
            hooksUrl: (updated.hooks_url as string | null) ?? null,
            runtimeConfig: rematerializeRuntimeConfig,
            db,
            tenantId: Number(updated.tenant_id ?? 0) || null,
          });
          for (const warn of result.warnings) console.warn(`[agents.put] ${warn}`);
          if (result.count > 0 || result.details.length > 0) {
            console.log(
              `[agents.put] skill re-materialization (${adapter.adapterName}) for agent #${req.params.id}: ${result.count} artifact(s) updated`,
            );
          }
        } catch (matErr) {
          console.warn(
            `[agents.put] skill re-materialization failed for agent #${req.params.id}:`,
            matErr instanceof Error ? matErr.message : String(matErr),
          );
        }
      });
    }

    // Keep workspace/global MCP config in sync when OpenClaw routing identity
    // changes so fresh sessions see assigned MCP servers without waiting for
    // dispatcher materialization.
    if (
      ((agent.runtime_type as string | null) === 'openclaw' || (updated.runtime_type as string | null) === 'openclaw')
      && (workspace_path !== undefined || session_key !== undefined || runtime_type !== undefined)
    ) {
      setImmediate(() => {
        try {
          const result = syncAssignedMcpForAgent({
            db,
            agentId: Number(req.params.id),
            workingDirectory: (updated.workspace_path as string | null) ?? null,
            materializeOpenClawGlobalConfig: true,
          });
          for (const warn of result.warnings) console.warn(`[agents.put] ${warn}`);
          if (result.skipped === 'missing_workspace') return;
          if (!result.ok && result.error) {
            console.warn(`[agents.put] MCP re-materialization failed for agent #${req.params.id}: ${result.error}`);
            return;
          }
          console.log(
            `[agents.put] MCP re-materialization for agent #${req.params.id}: ${result.count} server(s) updated`,
          );
        } catch (mcpErr) {
          console.warn(
            `[agents.put] MCP re-materialization failed for agent #${req.params.id}:`,
            mcpErr instanceof Error ? mcpErr.message : String(mcpErr),
          );
        }
      });
    }

    // ── Sync model to openclaw.json for openclaw-runtime agents ──
    // When preferred_provider or model changes, update the agent's model.primary
    // in the host openclaw.json so the gateway picks up the change on next session.
    // Bug fix: use resolveSlug(updated) — the agents table has no 'slug' column;
    // the correct slug is derived from openclaw_agent_id or session_key.
    if (model !== undefined || preferred_provider !== undefined) {
      const runtimeType = (updated.runtime_type as string | null) ?? 'openclaw';
      const agentSlug = resolveSlug(updated);
      const provider = (updated.preferred_provider as string | null) ?? resolveSchemaSafePreferredProvider(getConnectedProviderSlugs(tenantId));
      const newModel = (updated.model as string | null) ?? defaultAgentModelForProvider(provider);
      if (runtimeType === 'openclaw' && agentSlug && newModel) {
        try {
          const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8');
          const ocConfig = JSON.parse(raw);
          // Resolve the OpenClaw provider prefix — check models.providers keys for a match
          let ocProvider = provider;
          if (!newModel.includes('/')) {
            const providerKeys = Object.keys(ocConfig?.models?.providers ?? {});
            // Prefer exact match, then prefix match (e.g. 'minimax' → 'minimax-portal')
            const match = providerKeys.find(k => k === provider) ?? providerKeys.find(k => k.startsWith(provider));
            if (match) ocProvider = match;
          }
          const qualifiedModel = newModel.includes('/') ? newModel : `${ocProvider}/${newModel}`;
          const agentsList = ocConfig?.agents?.list as Array<Record<string, unknown>> | undefined;
          if (agentsList) {
            const ocAgent = agentsList.find((a: Record<string, unknown>) => a.id === agentSlug);
            if (ocAgent) {
              if (!ocAgent.model || typeof ocAgent.model !== 'object') ocAgent.model = {};
              (ocAgent.model as Record<string, unknown>).primary = qualifiedModel;
              ensureOpenClawCodexRuntime(ocAgent, qualifiedModel, provider);
              fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(ocConfig, null, 2));
              console.log(`[agents.put] synced model "${qualifiedModel}" to openclaw.json for agent "${agentSlug}"`);
            }
          }
        } catch (err) {
          console.warn(`[agents.put] failed to sync model to openclaw.json:`, err instanceof Error ? err.message : String(err));
        }
      }
    }

    return res.json(parseAgentRuntimeConfig(updated));
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/v1/agents/:id/docs
// Task #469: Uses WorkspaceProvider so remote agents (Custom etc.) serve docs
// through the same endpoint without special-case logic.
router.get('/:id/docs', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const agent = db.prepare('SELECT id FROM agents WHERE id = ? AND tenant_id = ?').get(req.params.id, tenantId) as Record<string, unknown> | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const docFiles = ['SOUL.md', 'AGENTS.md', 'USER.md', 'IDENTITY.md', 'MEMORY.md', 'TOOLS.md', 'HEARTBEAT.md', 'LESSONS.md'];
    const provider = resolveWorkspaceProvider(req.params.id);
    const docs = await provider.readDocs(docFiles);

    return res.json(docs);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Helper: derive a clean slug from an agent name
// ---------------------------------------------------------------------------
function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Helper: resolve the best available slug for an agent record.
// Priority: openclaw_agent_id > session-key utility > toSlug(name)
// ---------------------------------------------------------------------------
function resolveSlug(agent: Record<string, unknown>): string {
  const fromSession = resolveRuntimeAgentSlug({
    openclaw_agent_id: agent.openclaw_agent_id as string | null | undefined,
    session_key: agent.session_key as string | null | undefined,
    name: agent.name as string | null | undefined,
  });
  if (fromSession) return fromSession;
  return toSlug(agent.name as string);
}

// ---------------------------------------------------------------------------
// Helper: read + parse openclaw.json safely
// ---------------------------------------------------------------------------
function resolveOpenClawJsonPath(): string {
  return process.env.OPENCLAW_CONFIG_PATH ?? path.join(os.homedir(), '.openclaw', 'openclaw.json');
}

function readOpenclawJson(): Record<string, unknown> {
  const raw = fs.readFileSync(resolveOpenClawJsonPath(), 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function writeOpenclawJson(data: Record<string, unknown>): void {
  const openClawJsonPath = resolveOpenClawJsonPath();
  fs.mkdirSync(path.dirname(openClawJsonPath), { recursive: true });
  fs.writeFileSync(openClawJsonPath, JSON.stringify(data, null, 4), 'utf-8');
}

// ---------------------------------------------------------------------------
// GET /api/v1/agents/:id/provision-status
// OpenClaw-specific endpoint — only meaningful for agents with runtime_type = 'openclaw'
// ---------------------------------------------------------------------------
router.get('/:id/provision-status', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const agent = db.prepare('SELECT * FROM agents WHERE id = ? AND tenant_id = ?').get(req.params.id, tenantId) as Record<string, unknown> | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // Non-OpenClaw runtimes don't use workspace/openclaw.json provisioning
    if (agent.runtime_type && agent.runtime_type !== 'openclaw') {
      return res.json({
        provisioned: false,
        not_applicable: true,
        runtime_type: agent.runtime_type,
        message: `Provisioning is only available for openclaw runtime agents. This agent uses '${agent.runtime_type}'.`,
      });
    }

    const slug = resolveSlug(agent);
    const homedir = os.homedir();
    const workspacePath = (agent.workspace_path as string) || path.join(homedir, '.openclaw', `workspace-${slug}`);
    const agentDirPath = path.join(homedir, '.openclaw', 'agents', slug, 'agent');

    const workspaceExists = fs.existsSync(workspacePath);

    // Check openclaw.json for this agent entry
    let openclawRegistered = false;
    try {
      const config = readOpenclawJson();
      const agents = (config.agents as Record<string, unknown> | undefined) ?? {};
      const list = (agents.list as Array<Record<string, unknown>> | undefined) ?? [];
      openclawRegistered = list.some((a) => a.id === slug);
    } catch {
      openclawRegistered = false;
    }

    return res.json({
      provisioned: workspaceExists && openclawRegistered,
      workspace_exists: workspaceExists,
      workspace_path: workspacePath,
      openclaw_registered: openclawRegistered,
      agent_dir: agentDirPath,
      slug,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/provision
// OpenClaw-specific endpoint — only applicable when runtime_type = 'openclaw'
// ---------------------------------------------------------------------------
router.post('/:id/provision', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const { restart_gateway } = req.body as { restart_gateway?: boolean };
    const agent = db.prepare('SELECT * FROM agents WHERE id = ? AND tenant_id = ?').get(req.params.id, tenantId) as Record<string, unknown> | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // Provisioning is an OpenClaw-specific operation
    if (agent.runtime_type && agent.runtime_type !== 'openclaw') {
      return res.status(400).json({
        error: `Provisioning is only available for openclaw runtime agents. This agent uses '${agent.runtime_type}'.`,
        runtime_type: agent.runtime_type,
      });
    }

    const homedir = os.homedir();
    const slug = resolveSlug(agent);
    const agentModel = (agent.model as string) || 'anthropic/claude-sonnet-4-6';
    const workspacePath = (agent.workspace_path as string) || path.join(homedir, '.openclaw', `workspace-${slug}`);
    const agentDirPath = path.join(homedir, '.openclaw', 'agents', slug, 'agent');
    const sessionKey = (agent.session_key as string) || buildCanonicalAgentMainSessionKey({
      projectName: agent.project_name as string | null | undefined,
      agentName: agent.name as string | null | undefined,
      role: agent.role as string | null | undefined,
    });
    const shouldRestartGateway = restart_gateway === true;

    // --- 1. Create workspace dir ------------------------------------------------
    fs.mkdirSync(workspacePath, { recursive: true });

    // --- 2. Scaffold identity files --------------------------------------------

    // SOUL.md — role-based persona
    const soulPath = path.join(workspacePath, 'SOUL.md');
    if (!fs.existsSync(soulPath)) {
      const roleLine = agent.role ? `You are a ${agent.role}.` : `You are ${agent.name as string}.`;
      fs.writeFileSync(soulPath, `# SOUL.md — ${agent.name as string}\n\n${roleLine}\n\n## Core Principles\n- Be genuinely helpful, not performatively helpful.\n- Have opinions and push back when something doesn't make sense.\n- Be resourceful before asking.\n- Write clean, well-documented work.\n- Deliver results — no fluff, no filler.\n`, 'utf-8');
    }

    // AGENTS.md — copy from workspace base
    const agentsMdPath = path.join(workspacePath, 'AGENTS.md');
    if (!fs.existsSync(agentsMdPath)) {
      const baseAgentsMd = path.join(homedir, '.openclaw', 'workspace', 'AGENTS.md');
      if (fs.existsSync(baseAgentsMd)) {
        fs.copyFileSync(baseAgentsMd, agentsMdPath);
      } else {
        fs.writeFileSync(agentsMdPath, `# AGENTS.md — ${agent.name as string}\n\n## Every Session\n1. Read \`SOUL.md\`\n2. Check task queue\n3. Work the task\n`, 'utf-8');
      }
    }

    // TOOLS.md — blank
    const toolsMdPath = path.join(workspacePath, 'TOOLS.md');
    if (!fs.existsSync(toolsMdPath)) {
      fs.writeFileSync(toolsMdPath, `# TOOLS.md — ${agent.name as string}\n\nEnvironment-specific notes. Add as needed.\n`, 'utf-8');
    }

    // MEMORY.md — blank
    const memoryMdPath = path.join(workspacePath, 'MEMORY.md');
    if (!fs.existsSync(memoryMdPath)) {
      fs.writeFileSync(memoryMdPath, `# MEMORY.md — ${agent.name as string}\n\nLong-term memory. Updated during sessions.\n`, 'utf-8');
    }

    // --- 3. Create agentDir ----------------------------------------------------
    fs.mkdirSync(agentDirPath, { recursive: true });
    const authProvidersSynced = syncStoredProviderAuthProfiles(agentDirPath);

    // --- 4. Patch openclaw.json ------------------------------------------------
    let gatewayRestarted = false;
    let gatewayError: string | null = null;

    try {
      const config = readOpenclawJsonOrDefault();
      const agentsConfig = (config.agents as Record<string, unknown> | undefined) ?? {};
      const list = (agentsConfig.list as Array<Record<string, unknown>> | undefined) ?? [];

      const alreadyRegistered = list.some((a) => a.id === slug);
      if (!alreadyRegistered) {
        const newEntry: Record<string, unknown> = {
          id: slug,
          name: slug,
          workspace: workspacePath,
          agentDir: agentDirPath,
          model: { primary: agentModel },
        };
        list.push(newEntry);
        agentsConfig.list = list;
        config.agents = agentsConfig;
        writeOpenclawJson(config);
      }
    } catch (jsonErr) {
      return res.status(500).json({ error: `Failed to patch openclaw.json: ${String(jsonErr)}` });
    }

    // --- 5. Update DB record ---------------------------------------------------
    db.prepare(`
      UPDATE agents SET
        workspace_path = ?,
        openclaw_agent_id = ?,
        session_key = ?
      WHERE id = ?
    `).run(workspacePath, slug, sessionKey, req.params.id);

    let pairingApproved = false;
    let pairingMessage: string | null = shouldRestartGateway ? null : 'Skipped: gateway restart deferred.';
    if (shouldRestartGateway) {
      // --- 6. Restart gateway ---------------------------------------------------
      try {
        const gateway = ensureOpenClawGatewayAvailable();
        gatewayRestarted = gateway.ok;
        if (!gateway.ok) {
          gatewayError = gateway.message;
        }
      } catch (restartErr) {
        gatewayError = restartErr instanceof Error ? restartErr.message : String(restartErr);
      // Non-fatal — workspace + config are already set up
    }
      pairingApproved = false;
      pairingMessage = 'Pairing is manual. If the restarted gateway asks for pairing, approve the pending request with `openclaw devices list` and `openclaw devices approve <requestId>`.';

    }

    return res.json({
      ok: true,
      provisioned: true,
      slug,
      session_key: sessionKey,
      workspace_path: workspacePath,
      workspace: workspacePath,
      agent_dir: agentDirPath,
      model: agentModel,
      openclaw_agent_id: slug,
      auth_providers_synced: authProvidersSynced,
      gateway_restarted: gatewayRestarted,
      gateway_error: gatewayError,
      restart_required: !shouldRestartGateway,
      message: shouldRestartGateway
        ? (gatewayError ? 'Agent provisioned, but gateway restart did not complete.' : 'Agent provisioned and gateway restart attempted.')
        : 'Agent provisioned. OpenClaw can pick up the new agent configuration without a manual restart.',
      pairing_approved: pairingApproved,
      pairing_message: pairingMessage,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// CLAUDE.md endpoints (claude-code runtime only)
// ---------------------------------------------------------------------------

/**
 * Shared helper: fetch agent, verify it is claude-code runtime, and return
 * the workingDirectory from runtime_config.
 * Returns { agent, workingDirectory } on success, or sends an error response
 * and returns null.
 */
function resolveClaudeCodeAgent(
  req: Request,
  res: Response,
): { agent: Record<string, unknown>; workingDirectory: string } | null {
  const db = getDb();
  const tenantId = resolveTenantIdFromRequest(db, req);
  const agent = db.prepare('SELECT * FROM agents WHERE id = ? AND tenant_id = ?').get(req.params.id, tenantId) as Record<string, unknown> | undefined;
  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return null;
  }

  if ((agent.runtime_type as string) !== 'claude-code') {
    res.status(400).json({ error: 'Agent is not a claude-code runtime agent' });
    return null;
  }

  let runtimeConfig: Record<string, unknown> | null = null;
  try {
    runtimeConfig = typeof agent.runtime_config === 'string'
      ? JSON.parse(agent.runtime_config as string)
      : (agent.runtime_config as Record<string, unknown> | null);
  } catch {
    runtimeConfig = null;
  }

  const workingDirectory = (runtimeConfig as Record<string, unknown> | null)?.workingDirectory as string | undefined;
  if (!workingDirectory) {
    res.status(400).json({ error: 'Agent runtime_config is missing workingDirectory' });
    return null;
  }

  return { agent, workingDirectory };
}

// GET /api/v1/agents/:id/claude-md
router.get('/:id/claude-md', (req: Request, res: Response) => {
  try {
    const resolved = resolveClaudeCodeAgent(req, res);
    if (!resolved) return;
    const { workingDirectory } = resolved;

    const claudeMdPath = path.join(workingDirectory, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      return res.status(404).json({ error: 'CLAUDE.md does not exist for this agent' });
    }

    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    const stat = fs.statSync(claudeMdPath);
    return res.json({
      content,
      lastModified: stat.mtime.toISOString(),
      path: claudeMdPath,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// PUT /api/v1/agents/:id/claude-md
router.put('/:id/claude-md', (req: Request, res: Response) => {
  try {
    const resolved = resolveClaudeCodeAgent(req, res);
    if (!resolved) return;
    const { workingDirectory } = resolved;

    const { content } = req.body as { content?: unknown };
    if (typeof content !== 'string' || content.trim() === '') {
      return res.status(400).json({ error: 'content must be a non-empty string' });
    }

    const claudeMdPath = path.join(workingDirectory, 'CLAUDE.md');
    fs.mkdirSync(workingDirectory, { recursive: true });
    fs.writeFileSync(claudeMdPath, content, 'utf-8');

    const stat = fs.statSync(claudeMdPath);
    return res.json({
      content,
      lastModified: stat.mtime.toISOString(),
      path: claudeMdPath,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// POST /api/v1/agents/:id/claude-md/regen
router.post('/:id/claude-md/regen', (req: Request, res: Response) => {
  try {
    const resolved = resolveClaudeCodeAgent(req, res);
    if (!resolved) return;
    const { agent, workingDirectory } = resolved;

    // Task #596: read skill_names from agents table directly (canonical source)
    const db = getDb();
    let skillNames: string[] = [];
    try {
      const agentRow = db.prepare(`SELECT skill_names FROM agents WHERE id = ?`).get(agent.id) as { skill_names: string | null } | undefined;
      if (agentRow?.skill_names) {
        const parsed = JSON.parse(agentRow.skill_names);
        if (Array.isArray(parsed)) {
          skillNames = parsed.filter((s): s is string => typeof s === 'string');
        }
      }
    } catch { /* ignore — skill_names is optional */ }

    fs.mkdirSync(workingDirectory, { recursive: true });
    generateClaudeMd({
      workingDirectory,
      skillNames,
      hooksUrl: (agent.hooks_url as string | null) ?? null,
    });

    const claudeMdPath = path.join(workingDirectory, 'CLAUDE.md');
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    const stat = fs.statSync(claudeMdPath);
    return res.json({
      content,
      lastModified: stat.mtime.toISOString(),
      path: claudeMdPath,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Agent skill assignment relations
// ---------------------------------------------------------------------------
const resolveAgentSkillNames = (raw: unknown): string[] => {
  try {
    return typeof raw === 'string' ? normalizeJsonArray(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
};

const findSkillNameByIdentifier = (skillIdentifier: string, availableSkillNames: string[]): string | null => {
  if (!skillIdentifier) return null;

  const byName = availableSkillNames.find((name) => name === skillIdentifier);
  if (byName) return byName;

  const numericId = Number(skillIdentifier);
  if (Number.isInteger(numericId) && numericId > 0) {
    const byId = availableSkillNames.find((name) => makeStableSkillId(name) === numericId);
    if (byId) return byId;
  }

  return null;
};

const resolveExistingSkillName = (db: ReturnType<typeof getDb>, tenantId: number, skillId: number): string | null => {
  const row = db.prepare('SELECT name FROM skills WHERE id = ? AND tenant_id = ?').get(skillId, tenantId) as { name: string } | undefined;
  return row?.name ?? null;
};

const getTenantSkillByName = (db: ReturnType<typeof getDb>, tenantId: number, name: string): { id: number; name: string } | null => {
  return (db.prepare('SELECT id, name FROM skills WHERE tenant_id = ? AND name = ?').get(tenantId, name) as { id: number; name: string } | undefined) ?? null;
};

const filterTenantSkillNames = (db: ReturnType<typeof getDb>, tenantId: number, skillNames: string[]): string[] => {
  return skillNames.filter((name) => Boolean(getTenantSkillByName(db, tenantId, name)));
};

const materializeAgentSkills = (
  db: ReturnType<typeof getDb>,
  agent: Record<string, unknown>,
  skillNames: string[],
): Record<string, unknown> | null => {
  const workingDirectory = (agent.workspace_path as string | null) ?? null;
  if (!workingDirectory) return null;

  const runtimeType = (agent.runtime_type as string | null) ?? 'openclaw';
  const adapter = getSkillMaterializationAdapter(runtimeType);
  const result = adapter.materialize({
    workingDirectory,
    skillNames,
    skillsBasePath: OPENCLAW_SKILLS_PATH,
    hooksUrl: (agent.hooks_url as string | null) ?? null,
    db,
    tenantId: Number(agent.tenant_id ?? 0) || null,
  });

  return {
    ok: result.ok,
    adapter: adapter.adapterName,
    count: result.count,
    details: result.details,
    warnings: result.warnings,
    ...(result.error ? { error: result.error } : {}),
  };
};

router.get('/:id/skills', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const agent = db.prepare('SELECT id, skill_names FROM agents WHERE id = ? AND tenant_id = ?').get(req.params.id, tenantId) as { id: number; skill_names: string | null } | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const skillNames = filterTenantSkillNames(db, tenantId, resolveAgentSkillNames(agent.skill_names));

    return res.json({
      agent_id: agent.id,
      skills: skillNames.map((name) => ({
        id: getTenantSkillByName(db, tenantId, name)?.id ?? makeStableSkillId(name),
        name,
      })),
      skill_names: skillNames,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.post('/:id/skills', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const agent = db.prepare('SELECT * FROM agents WHERE id = ? AND tenant_id = ?').get(req.params.id, tenantId) as Record<string, unknown> | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const requestedSkillName = resolveSkillNameInput(req.body?.skill_name);
    const requestedSkillId = Number.isInteger(req.body?.skill_id) ? Number(req.body.skill_id) : null;

    let skillName = requestedSkillName;
    if (!skillName && requestedSkillId) {
      skillName = resolveExistingSkillName(db, tenantId, requestedSkillId) ?? '';
      if (!skillName) {
        return res.status(404).json({ error: `Skill with id '${requestedSkillId}' not found` });
      }
    }

    if (!skillName) {
      return res.status(400).json({ error: 'skill_name or skill_id is required' });
    }

    const tenantSkill = getTenantSkillByName(db, tenantId, skillName);
    if (!tenantSkill) {
      return res.status(404).json({ error: `Skill '${skillName}' not found` });
    }

    const skillNames = resolveAgentSkillNames(agent.skill_names);
    if (skillNames.includes(skillName)) {
      return res.status(409).json({ error: `Skill '${skillName}' is already assigned to this agent` });
    }

    const nextSkillNames = [...skillNames, skillName].sort((a, b) => a.localeCompare(b));
    db.prepare(`UPDATE agents SET skill_names = ? WHERE id = ?`).run(JSON.stringify(nextSkillNames), req.params.id);

    return res.status(201).json({
      ok: true,
      agent_id: Number(req.params.id),
      skill: {
        id: tenantSkill.id,
        name: tenantSkill.name,
      },
      skills: nextSkillNames.map((name) => ({
        id: getTenantSkillByName(db, tenantId, name)?.id ?? makeStableSkillId(name),
        name,
      })),
      skill_names: nextSkillNames,
      sync: materializeAgentSkills(db, agent, nextSkillNames),
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.delete('/:id/skills/:skillName', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const agent = db.prepare('SELECT * FROM agents WHERE id = ? AND tenant_id = ?').get(req.params.id, tenantId) as Record<string, unknown> | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const skillNames = resolveAgentSkillNames(agent.skill_names);
    const skillIdentifier = resolveSkillNameInput(req.params.skillName) || resolveSkillNameInput(req.body?.skill_name) || resolveSkillNameInput(req.body?.skill_id);
    const skillName = findSkillNameByIdentifier(skillIdentifier, skillNames);

    if (!skillIdentifier) {
      return res.status(400).json({
        error: 'skillName path param or skill_name/skill_id body field is required',
        supported_fields: ['skillName', 'skill_name', 'skill_id'],
      });
    }
    if (!skillName) {
      return res.status(404).json({ error: `Skill '${skillIdentifier}' is not assigned to this agent` });
    }

    const nextSkillNames = skillNames.filter((name) => name !== skillName);
    db.prepare(`UPDATE agents SET skill_names = ? WHERE id = ?`).run(JSON.stringify(nextSkillNames), req.params.id);

    return res.json({
      ok: true,
      agent_id: Number(req.params.id),
      removed_skill: {
        id: makeStableSkillId(skillName),
        name: skillName,
      },
      removed_skill_name: skillName,
      skills: nextSkillNames.map((name) => ({
        id: makeStableSkillId(name),
        name,
      })),
      skill_names: nextSkillNames,
      sync: materializeAgentSkills(db, agent, nextSkillNames),
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/skills/sync — task #644: on-demand skill materialization
//
// Triggers runtime-aware skill materialization for the agent without requiring
// a full dispatch. Useful when skills are added/removed/updated and the runtime
// workspace should be updated immediately.
//
// The adapter is selected based on the agent's runtime_type so the correct
// artifacts are created for each runtime (symlinks for claude-code/openclaw,
// no-op for remote runtimes).
// ---------------------------------------------------------------------------
router.post('/:id/skills/sync', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const agent = db.prepare(`SELECT * FROM agents WHERE id = ? AND tenant_id = ?`).get(req.params.id, tenantId) as Record<string, unknown> | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // Resolve working directory: prefer explicit body override, then workspace_path
    const bodyWorkDir = typeof (req.body as Record<string, unknown>)?.working_directory === 'string'
      ? (req.body as Record<string, unknown>).working_directory as string
      : null;
    const workingDirectory = bodyWorkDir ?? (agent.workspace_path as string | null) ?? null;

    if (!workingDirectory) {
      return res.status(400).json({ error: 'Agent has no workspace_path and no working_directory was provided' });
    }

    // Resolve skill names: prefer body override (for testing), then agent record
    let skillNames: string[] = [];
    const bodySkills = (req.body as Record<string, unknown>)?.skill_names;
    if (Array.isArray(bodySkills)) {
      skillNames = bodySkills.filter((s): s is string => typeof s === 'string');
    } else if (agent.skill_names && typeof agent.skill_names === 'string') {
      try {
        const parsed = JSON.parse(agent.skill_names);
        if (Array.isArray(parsed)) {
          skillNames = parsed.filter((s): s is string => typeof s === 'string');
        }
      } catch { /* ignore */ }
    }

    const runtimeType = (agent.runtime_type as string | null) ?? 'openclaw';
    const adapter = getSkillMaterializationAdapter(runtimeType);

    let runtimeConfig: Record<string, unknown> | null = null;
    try {
      runtimeConfig = typeof agent.runtime_config === 'string'
        ? JSON.parse(agent.runtime_config as string)
        : (agent.runtime_config as Record<string, unknown> | null);
    } catch {
      runtimeConfig = null;
    }

    const result = adapter.materialize({
      workingDirectory,
      skillNames,
      skillsBasePath: OPENCLAW_SKILLS_PATH,
      hooksUrl: (agent.hooks_url as string | null) ?? null,
      runtimeConfig,
      db,
      tenantId: Number(agent.tenant_id ?? 0) || null,
    });

    return res.json({
      ok: result.ok,
      adapter: adapter.adapterName,
      runtime_type: runtimeType,
      working_directory: workingDirectory,
      skill_names: skillNames,
      count: result.count,
      details: result.details,
      warnings: result.warnings,
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/mcp/sync — on-demand OpenClaw MCP materialization
//
// Writes the effective assigned MCP server set into the agent's parent
// workspace immediately so direct chat sessions and future OpenClaw bootstraps
// do not depend on dispatcher-side materialization.
// ---------------------------------------------------------------------------
router.post('/:id/mcp/sync', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const agent = db.prepare(`SELECT * FROM agents WHERE id = ? AND tenant_id = ?`).get(req.params.id, tenantId) as Record<string, unknown> | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const bodyWorkDir = typeof (req.body as Record<string, unknown>)?.working_directory === 'string'
      ? (req.body as Record<string, unknown>).working_directory as string
      : null;
    const runtimeType = (agent.runtime_type as string | null) ?? 'openclaw';

    const result = syncAssignedMcpForAgent({
      db,
      agentId: Number(req.params.id),
      workingDirectory: bodyWorkDir ?? (agent.workspace_path as string | null) ?? null,
      materializeOpenClawGlobalConfig: true,
    });

    if (result.skipped === 'agent_not_found') {
      return res.status(404).json({ error: result.error ?? 'Agent not found' });
    }
    if (result.skipped === 'missing_workspace') {
      return res.status(400).json({ error: result.error ?? 'Agent has no workspace_path and no working_directory was provided' });
    }

    return res.json({
      ok: result.ok,
      runtime_type: runtimeType,
      working_directory: result.workingDirectory,
      count: result.count,
      path: result.path ?? null,
      bundle_path: result.bundlePath ?? null,
      openclaw_config_path: result.openClawConfigPath ?? null,
      warnings: result.warnings,
      skipped: result.skipped ?? null,
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/agents/:id/instances — agent-native instance list (Task #594)
// Replaces GET /api/v1/jobs/:id/instances
// ---------------------------------------------------------------------------
router.get('/:id/instances', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    if (!requireAgentVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Agent not found' });
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const instances = db.prepare(`
      SELECT ji.*, a.job_title as job_title, a.name as agent_name,
             ia.current_stage, ia.last_agent_heartbeat_at, ia.last_meaningful_output_at,
             ia.latest_commit_hash, ia.branch_name, ia.changed_files_json, ia.changed_files_count,
             ia.summary as artifact_summary, ia.blocker_reason, ia.outcome as artifact_outcome,
             ia.stale as run_is_stale, ia.stale_at,
             ji.task_outcome,
             ji.runtime_ended_at,
             ji.runtime_completed_at,
             ji.runtime_end_success,
             ji.runtime_end_error,
             ji.runtime_end_source,
             ji.lifecycle_handoff_status,
             ji.semantic_outcome_missing,
             ji.lifecycle_outcome_posted_at
      FROM job_instances ji
      LEFT JOIN agents a ON a.id = ji.agent_id
      LEFT JOIN instance_artifacts ia ON ia.instance_id = ji.id
      WHERE ji.agent_id = ?
      ORDER BY ji.created_at DESC
      LIMIT ?
    `).all(req.params.id, limit);
    return res.json(instances);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/agents/:id/routing-config — agent-native routing config (Task #594)
// Replaces GET /api/v1/routing/config/:job_id
// ---------------------------------------------------------------------------
router.get('/:id/routing-config', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    if (!requireAgentVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Agent not found' });
    return res.json(getAgentRoutingConfig(db, req.params.id));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/v1/agents/:id/routing-config — update agent routing config (Task #594)
// Replaces PUT /api/v1/routing/config/:job_id
// ---------------------------------------------------------------------------
router.put('/:id/routing-config', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    if (!requireAgentVisibleForTenant(db, req.params.id, tenantId)) return res.status(404).json({ error: 'Agent not found' });
    return res.json(updateAgentRoutingConfig(db, req.params.id, (req.body ?? {}) as Record<string, unknown>));
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 500;
    return res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// DELETE /api/v1/agents/:id
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const tenantId = resolveTenantIdFromRequest(db, req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid agent id' });
    }
    const agent = db.prepare('SELECT * FROM agents WHERE id = ? AND tenant_id = ?').get(id, tenantId) as Record<string, unknown> | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const previousProjectId = (agent.project_id as number | null | undefined) ?? null;

    // Idle guard — only allow deletion of idle agents
    if (agent.status !== 'idle') {
      return res.status(409).json({
        error: `Cannot delete agent while status is "${agent.status}". Wait until agent is idle.`,
      });
    }

    // OpenClaw native cleanup (if provisioned)
    if (agent.openclaw_agent_id) {
      const result = runOpenClawSync(
        ['agents', 'delete', '--force', agent.openclaw_agent_id as string],
        { stdio: 'pipe' },
      );
      if (result.status !== 0) {
        console.warn(`[agents] openclaw agents delete ${agent.openclaw_agent_id}: ${(result.stderr ?? '').toString().trim()}`);
      } else {
        console.log(`[agents] Deleted OpenClaw agent: ${agent.openclaw_agent_id}`);
      }
    }

    // Workspace cleanup — only delete dirs under ~/.openclaw/workspace-*
    const workspacePath = agent.workspace_path as string;
    const safePrefix = os.homedir() + '/.openclaw/workspace-';
    if (workspacePath && workspacePath.startsWith(safePrefix) && fs.existsSync(workspacePath)) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
      console.log(`[agents] Removed workspace: ${workspacePath}`);
    }

    const referenceCounts = countAgentReferences(db, id);
    const nonZeroReferences = referenceCounts.filter((entry) => entry.count > 0);
    const historicalReferences = nonZeroReferences.filter((entry) => entry.historical);

    if (historicalReferences.length > 0) {
      archiveAgentForDeletion(db, agent, referenceCounts);
      syncStarterRoutingForProject(db, previousProjectId);
      return res.json({
        ok: true,
        deleted: true,
        hard_deleted: false,
        archived: true,
        message: 'Agent was archived instead of hard-deleted because historical task, run, chat, or audit records still reference it.',
        dependency_counts: nonZeroReferences,
      });
    }

    db.prepare('DELETE FROM agents WHERE id = ?').run(id);
    syncStarterRoutingForProject(db, previousProjectId);

    return res.json({
      ok: true,
      deleted: true,
      hard_deleted: true,
      archived: false,
      dependency_counts: nonZeroReferences,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('FOREIGN KEY constraint failed')) {
      return res.status(409).json({
        error: 'Cannot hard-delete agent because existing records still reference it. Disable or archive the agent instead.',
        detail: message,
      });
    }
    return res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers: parse runtime_config JSON + normalize agent records
// ---------------------------------------------------------------------------

/**
 * Parse runtime_config from a raw DB row (stored as JSON string or null).
 */
export function parseAgentRuntimeConfig(agent: Record<string, unknown>): Record<string, unknown> {
  const raw = agent.runtime_config;
  const parsed = parseRuntimeConfigObject(raw) as AgentRuntimeConfigPayload;

  // Phase 4 (T#459): parse skill_names JSON string from job_templates join
  let skillNames: string[] = [];
  const rawSkillNames = agent.skill_names;
  if (typeof rawSkillNames === 'string' && rawSkillNames) {
    try {
      const arr = JSON.parse(rawSkillNames);
      if (Array.isArray(arr)) skillNames = arr.filter((s: unknown): s is string => typeof s === 'string');
    } catch { /* ignore */ }
  }

  // Parse sort_rules JSON string
  let sortRules: string[] = [];
  const rawSortRules = agent.sort_rules;
  if (typeof rawSortRules === 'string' && rawSortRules) {
    try {
      const arr = JSON.parse(rawSortRules);
      if (Array.isArray(arr)) sortRules = arr.filter((s: unknown): s is string => typeof s === 'string');
    } catch { /* ignore */ }
  }

  // Do not default runtime_type to 'openclaw' in API responses — surface the actual stored value
  // so callers can distinguish "explicitly set to openclaw" from "never configured".
  // The dispatcher falls back to openclaw internally; the API should be honest about the stored value.
  const legacyRepoConfig = normalizeRepoConfig({
    repo_path: agent.repo_path,
    repo_url: agent.repo_url,
    repo_access_mode: agent.repo_access_mode,
  });
  const effectiveRepoConfig = resolveRepoConfig({
    project: {
      repo_path: agent.project_repo_path,
      repo_url: agent.project_repo_url,
      repo_access_mode: agent.project_repo_access_mode,
    },
    agent: legacyRepoConfig,
  });

  const canonicalJobInstructions = getStoredJobInstructions(agent) || null;

  const result: Record<string, unknown> = {
    ...agent,
    runtime_type: (agent.runtime_type as string | undefined) ?? 'openclaw',
    runtime_config: parsed,
    skill_names: skillNames,
    sort_rules: sortRules,
    repo_path: effectiveRepoConfig.repo_path,
    repo_url: effectiveRepoConfig.repo_url,
    repo_access_mode: effectiveRepoConfig.repo_access_mode,
    repo_config_source: effectiveRepoConfig.repo_config_source,
    legacy_repo_path: legacyRepoConfig.repo_path,
    legacy_repo_url: legacyRepoConfig.repo_url,
    legacy_repo_access_mode: legacyRepoConfig.repo_access_mode,
    job_instructions: canonicalJobInstructions,
  };
  // Remove deprecated fields from API responses. job_title remains in the DB
  // only as legacy compatibility for old logs/migrations and is not active
  // agent configuration.
  delete result.dispatch_mode;
  delete result.job_title;
  // Task #605: agents are project-scoped. The DB column may exist as a
  // legacy/internal migration artifact, but API consumers should use routing
  // rules for sprint-specific dispatch.
  delete result.sprint_id;
  return result;
}

/**
 * Parse an array of raw DB rows, normalizing runtime fields on each.
 */
function parseAgents(agents: unknown[]): Record<string, unknown>[] {
  return (agents as Record<string, unknown>[]).map(parseAgentRuntimeConfig);
}

export default router;
