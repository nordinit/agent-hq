import type { Request } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NODE_BIN_DIR } from '../config';
import { buildRuntimeConfigDefaults } from './runtimeOnboarding';
import { getAgentHqBaseUrl } from './agentHqBaseUrl';
import {
  ATLAS_AGENT_NAME,
  ATLAS_SYSTEM_ROLE,
} from './atlasAgent';
import {
  buildCanonicalAgentMainSessionKey,
  slugifySessionKeyPart,
} from './sessionKeys';
import { ensureProjectBacklogSprint } from './starterSetup';
import {
  DEFAULT_PROJECT_NAME,
  LEGACY_STARTER_PROJECT_NAME,
  STARTER_AGENT_DEFINITIONS,
} from './starterCatalog';
import { applyDefaultInstallPackage } from './defaultInstallPackage';
import { type Db, type RunResult } from "../db/adapter/types";

export const DEFAULT_TENANT_SLUG = 'default';
export const DEFAULT_TENANT_NAME = 'Default Tenant';
export const DEFAULT_TENANT_SETTING_KEY = 'default_tenant_id';
export const ACTIVE_TENANT_SETTING_KEY = 'active_tenant_id';
const AGENT_HQ_MCP_SERVER_SLUG = 'agent-hq';

const TENANT_ATLAS_ROLE = 'Built-in assistant — task routing, coordination, and chat';
const TENANT_ATLAS_JOB_INSTRUCTIONS = [
  'You are Atlas, the built-in Agent HQ assistant for this tenant.',
  '',
  'Responsibilities:',
  '- Help operators understand projects, tasks, workflows, agents, and runtime activity in this tenant.',
  '- Keep tenant data isolated. Do not use or expose another tenant\'s projects, agents, workspaces, chats, or operational records.',
  '- Prefer concrete evidence from Agent HQ state before changing task or workflow state.',
  '- When asked to perform implementation, review, QA, or release work, follow the active Agent HQ task contract and record truthful evidence.',
  '',
  'Boundaries:',
  '- Do not assume access to host-specific paths, credentials, private infrastructure, or another tenant\'s defaults.',
  '- Ask before taking external actions such as sending messages outside the current workspace or publishing changes.',
].join('\n');

const TENANT_ATLAS_DOCS: Record<string, string> = {
  'SOUL.md': [
    '# SOUL.md - Atlas',
    '',
    'You are Atlas, the built-in Agent HQ assistant for this tenant.',
    '',
    '## Core Principles',
    '',
    '- Be direct, useful, and evidence-based.',
    '- Keep tenant data private and isolated.',
    '- Prefer explicit task state, logs, and review evidence over assumptions.',
    '- Leave durable notes when your work affects future operators or agents.',
    '',
  ].join('\n'),
  'IDENTITY.md': [
    '# IDENTITY.md - Atlas',
    '',
    '- **Name:** Atlas',
    '- **Role:** Built-in Agent HQ assistant',
    '- **Vibe:** Calm, pragmatic, and careful with evidence',
    '- **Emoji:**',
    '',
  ].join('\n'),
  'USER.md': [
    '# USER.md - Tenant Context',
    '',
    'Record tenant-specific preferences and operator context here as they are learned.',
    'Do not copy private context from other Agent HQ tenants.',
    '',
  ].join('\n'),
  'TOOLS.md': [
    '# TOOLS.md - Tenant Tools',
    '',
    'Record tenant-local tool notes, environment details, and operational shortcuts here.',
    'Do not include host-specific defaults or credentials unless an operator explicitly provides tenant-local information.',
    '',
  ].join('\n'),
  'MEMORY.md': [
    '# MEMORY.md - Atlas',
    '',
    'Curated durable memory for this tenant-local Atlas agent.',
    '',
  ].join('\n'),
  'AGENTS.md': [
    '# AGENTS.md - Atlas Workspace',
    '',
    'This workspace belongs to the tenant-local Atlas agent.',
    '',
    '## Operating Rules',
    '',
    '- Treat tenant isolation as a hard boundary.',
    '- Use Agent HQ task contracts and lifecycle tools when assigned workflow work.',
    '- Record meaningful progress, blockers, verification, and handoff evidence in durable task notes.',
    '- Do not reuse another tenant\'s workspace files, identity documents, runtime records, or operational notes.',
    '',
  ].join('\n'),
};

const STARTER_TOOL_CATALOG_ROWS: Array<{
  name: string;
  slug: string;
  description: string;
  implementation_type: 'bash' | 'script';
  implementation_body: string;
  input_schema: Record<string, unknown>;
  permissions: 'read_only' | 'read_write' | 'exec';
  tags: string[];
}> = [
  {
    name: 'Explore Codebase',
    slug: 'explore_codebase',
    description: 'Explore the codebase structure before making changes and return a concise file map.',
    implementation_type: 'script',
    implementation_body: JSON.stringify({
      command: 'python3',
      inline: [
        'import json, os',
        'from pathlib import Path',
        'root = Path(os.environ.get("WORKSPACE") or os.getcwd()).resolve()',
        'focus = os.environ.get("TOOL_FOCUS", "").strip()',
        'entries = []',
        'for current, dirs, files in os.walk(root):',
        '    dirs[:] = [d for d in sorted(dirs) if d not in {".git", "node_modules", "dist", "build", ".next", "coverage"}]',
        '    rel_depth = 0 if Path(current) == root else len(Path(current).relative_to(root).parts)',
        '    if rel_depth > 2:',
        '        dirs[:] = []',
        '        continue',
        '    for name in sorted(files):',
        '        rel = str((Path(current) / name).relative_to(root))',
        '        if not focus or focus.lower() in rel.lower():',
        '            entries.append(rel)',
        '        if len(entries) >= 80:',
        '            break',
        '    if len(entries) >= 80:',
        '        break',
        'print(json.dumps({"root": str(root), "focus": focus or None, "files": entries}, indent=2))',
      ].join('\n'),
    }),
    input_schema: {
      type: 'object',
      properties: {
        focus: { type: 'string', description: 'Optional path or text to filter returned files.' },
      },
      required: [],
    },
    permissions: 'read_only',
    tags: ['filesystem', 'exploration', 'devtools'],
  },
  {
    name: 'Bash',
    slug: 'bash',
    description: 'Execute a bash command for build steps, tests, git operations, and general automation.',
    implementation_type: 'bash',
    implementation_body: 'bash -lc "$TOOL_COMMAND"',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute.' },
      },
      required: ['command'],
    },
    permissions: 'exec',
    tags: ['shell', 'automation'],
  },
  {
    name: 'File Edit',
    slug: 'file_edit',
    description: 'Read, create, or edit a file at a given path. Supports full-file writes and patch-style edits.',
    implementation_type: 'bash',
    implementation_body: [
      'python3 - <<\'PY\'',
      'import json, os, pathlib, sys',
      'raw = os.environ.get("TOOL_INPUT", "{}")',
      'data = json.loads(raw)',
      'path = pathlib.Path(data.get("path") or "")',
      'if not path:',
      '    print(json.dumps({"ok": False, "error": "path is required"})); sys.exit(0)',
      'if not path.is_absolute():',
      '    path = pathlib.Path.cwd() / path',
      'mode = data.get("mode") or "read"',
      'if mode == "read":',
      '    print(path.read_text())',
      'elif mode == "write":',
      '    path.parent.mkdir(parents=True, exist_ok=True)',
      '    path.write_text(data.get("content") or "")',
      '    print(json.dumps({"ok": True, "path": str(path)}))',
      'else:',
      '    print(json.dumps({"ok": False, "error": "patch mode is not implemented by this basic starter tool"}))',
      'PY',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
        content: { type: 'string', description: 'New file content for write mode.' },
        mode: { type: 'string', enum: ['read', 'write', 'patch'], description: 'Operation mode.' },
      },
      required: ['path'],
    },
    permissions: 'read_write',
    tags: ['filesystem', 'editing'],
  },
];

export type TenantRecord = {
  id: number;
  name: string;
  slug: string;
  is_default: number;
  created_at: string;
  updated_at: string;
};

export type DeleteTenantResult = {
  ok: true;
  deleted_tenant: TenantRecord;
  active_tenant_id: number;
  active_tenant_changed: boolean;
  deletion_semantics: 'hard_delete_tenant_owned_records';
  deleted_counts: Record<string, number>;
};

export type TenantRowVisibility = 'visible' | 'not_found' | 'forbidden';

export type TenantOwnedRowCheck = {
  visibility: TenantRowVisibility;
  tenant_id: number | null;
};

export type TenantRouteGuardOptions = {
  notFoundMessage?: string;
  revealForbidden?: boolean;
};

export type TenantScopedSqlOptions = {
  alias?: string;
  where?: string;
};

export type TenantScopedListOptions = TenantScopedSqlOptions & {
  sql: string;
  tenantId: number;
  params?: unknown[];
};

export type TenantScopedMutationOptions = {
  table: string;
  tenantId: number;
  id: number | string;
  idColumn?: string;
};

export type TenantScopedInsertOptions = {
  table: string;
  tenantId: number;
  values: Record<string, unknown>;
};

export type TenantScopedUpdateOptions = TenantScopedMutationOptions & {
  values: Record<string, unknown>;
};

const TENANT_OWNED_TABLES = [
  'projects',
  'agents',
  'tasks',
  'sprints',
  'job_instances',
  'logs',
  'chat_messages',
  'task_history',
  'task_notes',
  'task_events',
  'integrity_events',
  'task_creation_events',
  'task_outcome_metrics',
  'sessions',
  'routing_config',
  'sprint_task_routing_rules',
  'sprint_task_transitions',
  'sprint_task_transition_requirements',
  'story_point_model_routing',
  'provider_config',
  'github_identities',
  'external_event_mappings',
  'tools',
  'skills',
  'mcp_servers',
  'recurring_task_series',
];

const WORKFLOW_DEFINITION_CONFIG_TABLES = [
  'task_field_schemas',
  'sprint_type_task_types',
  'sprint_type_task_statuses',
  'sprint_type_outcomes',
  'sprint_type_relationship_types',
] as const;

const verifiedTenantSchemaDbs = new WeakSet<Db>();

function assertSafeSqlIdentifier(identifier: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe ${label}: ${identifier}`);
  }
}

function tenantColumn(alias?: string): string {
  if (!alias) return 'tenant_id';
  assertSafeSqlIdentifier(alias, 'tenant table alias');
  return `${alias}.tenant_id`;
}

function routeTenantGuardError(message: string, status: number, code: string): Error & { status?: number; code?: string } {
  const error = new Error(message) as Error & { status?: number; code?: string };
  error.status = status;
  error.code = code;
  return error;
}

export function tenantScopedWhere(options: TenantScopedSqlOptions = {}): string {
  const predicate = `${tenantColumn(options.alias)} = ?`;
  const extra = options.where?.trim();
  return extra ? `WHERE ${extra} AND ${predicate}` : `WHERE ${predicate}`;
}

export function tenantScopedParams(tenantId: number, params: unknown[] = []): unknown[] {
  return [...params, tenantId];
}

export async function listTenantScopedRows<T = Record<string, unknown>>(db: Db, options: TenantScopedListOptions): Promise<T[]> {
  return await db.all(`${options.sql} ${tenantScopedWhere(options)}`, ...tenantScopedParams(options.tenantId, options.params)) as T[];
}

export async function getTenantScopedRow<T = Record<string, unknown>>(db: Db, options: TenantScopedListOptions): Promise<T | undefined> {
  return await db.get(`${options.sql} ${tenantScopedWhere(options)} LIMIT 1`, ...tenantScopedParams(options.tenantId, options.params)) as T | undefined;
}

export async function checkTenantOwnedRow(
  db: Db,
  table: string,
  id: number | string,
  tenantId: number,
  idColumn = 'id',
): Promise<TenantOwnedRowCheck> {
  assertSafeSqlIdentifier(table, 'tenant-owned table');
  assertSafeSqlIdentifier(idColumn, 'tenant-owned id column');
  const row = await db.get(`SELECT tenant_id FROM ${table} WHERE ${idColumn} = ? LIMIT 1`, id) as { tenant_id: number | null } | undefined;
  if (!row) return { visibility: 'not_found', tenant_id: null };
  if (row.tenant_id === tenantId) return { visibility: 'visible', tenant_id: row.tenant_id };
  return { visibility: 'forbidden', tenant_id: row.tenant_id };
}

export async function requireTenantOwnedRow(
  db: Db,
  table: string,
  id: number | string,
  tenantId: number,
  options: TenantRouteGuardOptions & { idColumn?: string } = {},
): Promise<void> {
  const check = await checkTenantOwnedRow(db, table, id, tenantId, options.idColumn ?? 'id');
  if (check.visibility === 'visible') return;
  const notFoundMessage = options.notFoundMessage ?? 'Record not found';
  if (check.visibility === 'forbidden' && options.revealForbidden) {
    throw routeTenantGuardError('Record belongs to another tenant', 403, 'tenant_forbidden');
  }
  throw routeTenantGuardError(notFoundMessage, 404, 'tenant_scoped_not_found');
}

export async function runTenantScopedDelete(db: Db, options: TenantScopedMutationOptions): Promise<RunResult> {
  assertSafeSqlIdentifier(options.table, 'tenant-owned table');
  assertSafeSqlIdentifier(options.idColumn ?? 'id', 'tenant-owned id column');
  return await db.run(`DELETE FROM ${options.table} WHERE ${options.idColumn ?? 'id'} = ? AND tenant_id = ?`, options.id, options.tenantId);
}

export async function runTenantScopedInsert(db: Db, options: TenantScopedInsertOptions): Promise<RunResult> {
  assertSafeSqlIdentifier(options.table, 'tenant-owned table');
  const values: Record<string, unknown> = { ...options.values, tenant_id: options.tenantId };
  const columns = Object.keys(values);
  for (const column of columns) assertSafeSqlIdentifier(column, 'tenant-owned insert column');
  const placeholders = columns.map(() => '?').join(', ');
  return await db.run(`INSERT INTO ${options.table} (${columns.join(', ')}) VALUES (${placeholders})`, ...columns.map((column) => values[column]));
}

export async function runTenantScopedUpdate(db: Db, options: TenantScopedUpdateOptions): Promise<RunResult> {
  assertSafeSqlIdentifier(options.table, 'tenant-owned table');
  assertSafeSqlIdentifier(options.idColumn ?? 'id', 'tenant-owned id column');
  const columns = Object.keys(options.values);
  for (const column of columns) {
    assertSafeSqlIdentifier(column, 'tenant-owned update column');
    if (column === 'tenant_id') throw new Error('tenant_id cannot be updated through runTenantScopedUpdate');
  }
  if (columns.length === 0) {
    throw new Error('runTenantScopedUpdate requires at least one value');
  }
  const setSql = columns.map((column) => `${column} = ?`).join(', ');
  return await db.run(`UPDATE ${options.table} SET ${setSql} WHERE ${options.idColumn ?? 'id'} = ? AND tenant_id = ?`, ...columns.map((column) => options.values[column]), options.id, options.tenantId);
}

async function deleteByTenantId(db: Db, table: string, tenantId: number): Promise<number> {
  return (await db.run(`DELETE FROM ${table} WHERE tenant_id = ?`, tenantId)).changes;
}

async function deleteWhere(db: Db, table: string, whereSql: string, params: unknown[], countKey = table): Promise<Record<string, number>> {
  const changes = (await db.run(`DELETE FROM ${table} WHERE ${whereSql}`, ...params)).changes;
  return changes > 0 ? { [countKey]: changes } : { [countKey]: 0 };
}

function addCount(counts: Record<string, number>, table: string, changes: number): void {
  counts[table] = (counts[table] ?? 0) + changes;
}

function addCounts(counts: Record<string, number>, updates: Record<string, number>): void {
  for (const [key, value] of Object.entries(updates)) addCount(counts, key, value);
}

async function deleteTenantRows(db: Db, table: string, tenantId: number, counts: Record<string, number>): Promise<void> {
  addCount(counts, table, await deleteByTenantId(db, table, tenantId));
}

async function getSetting(db: Db, key: string): Promise<string | null> {
  return (await db.get(`SELECT value FROM app_settings WHERE key = ?`, key) as { value?: string } | undefined)?.value ?? null;
}

async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await db.run(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
    ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
  `, key, value);
}

function tenantMigrationRequired(message: string): Error & { code?: string } {
  const error = new Error(`Tenant install/migration required: ${message}`) as Error & { code?: string };
  error.code = 'tenant_migration_required';
  return error;
}

/**
 * Validates the tenant selection records without repairing them.
 *
 * Schema shape is owned by PostgreSQL migrations. Missing tables or columns therefore surface as
 * database errors; this module only validates data invariants that migrations cannot express.
 */
async function requireCurrentDefaultTenantId(db: Db): Promise<number> {
  const rawDefaultTenantId = await getSetting(db, DEFAULT_TENANT_SETTING_KEY);
  if (!rawDefaultTenantId) {
    throw tenantMigrationRequired(`${DEFAULT_TENANT_SETTING_KEY} is missing from app_settings`);
  }
  const defaultTenantId = Number(rawDefaultTenantId);
  if (!Number.isInteger(defaultTenantId) || defaultTenantId <= 0) {
    throw tenantMigrationRequired(`${DEFAULT_TENANT_SETTING_KEY} is not a positive integer`);
  }
  const defaultTenant = await db.get(`
    SELECT id
    FROM tenants
    WHERE id = ? AND is_default = 1
    LIMIT 1
  `, defaultTenantId) as { id: number } | undefined;
  if (!defaultTenant) {
    throw tenantMigrationRequired(`${DEFAULT_TENANT_SETTING_KEY} does not point at an existing default tenant`);
  }

  const activeTenantId = Number((await getSetting(db, ACTIVE_TENANT_SETTING_KEY)) ?? '');
  if (!Number.isInteger(activeTenantId) || activeTenantId <= 0) {
    throw tenantMigrationRequired(`${ACTIVE_TENANT_SETTING_KEY} is missing or invalid in app_settings`);
  }
  const activeTenant = await db.get(`SELECT id FROM tenants WHERE id = ? LIMIT 1`, activeTenantId) as { id: number } | undefined;
  if (!activeTenant) {
    throw tenantMigrationRequired(`${ACTIVE_TENANT_SETTING_KEY} does not point at an existing tenant`);
  }
  return defaultTenantId;
}

async function assertNoNullTenantOwnership(db: Db, table: string): Promise<void> {
  assertSafeSqlIdentifier(table, 'tenant-owned table');
  const nullTenantRow = await db.get(`SELECT 1 FROM ${table} WHERE tenant_id IS NULL LIMIT 1`);
  if (nullTenantRow) {
    throw tenantMigrationRequired(`${table} contains rows without tenant ownership`);
  }
}

/**
 * Read-only startup validation. It never creates tables, adds columns, backfills ownership, seeds
 * defaults, or reconciles generated configuration.
 */
export async function verifyTenantSchemaForStartup(db: Db): Promise<number> {
  if (verifiedTenantSchemaDbs.has(db)) return await requireCurrentDefaultTenantId(db);
  const defaultTenantId = await requireCurrentDefaultTenantId(db);
  for (const table of [...TENANT_OWNED_TABLES, 'sprint_types', ...WORKFLOW_DEFINITION_CONFIG_TABLES]) {
    await assertNoNullTenantOwnership(db, table);
  }
  verifiedTenantSchemaDbs.add(db);
  return defaultTenantId;
}

function slugifyTenantName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'tenant';
}

async function uniqueTenantSlug(db: Db, requested: string): Promise<string> {
  const base = slugifyTenantName(requested);
  let slug = base;
  let suffix = 2;
  while (await db.get(`SELECT id FROM tenants WHERE slug = ? LIMIT 1`, slug)) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

function buildTenantAtlasSessionKey(tenantSlug: string): string {
  return buildCanonicalAgentMainSessionKey({
    projectSlug: `${slugifySessionKeyPart(tenantSlug, 'tenant')}-${slugifySessionKeyPart(DEFAULT_PROJECT_NAME, 'default-project')}`,
    agentName: ATLAS_AGENT_NAME,
    role: 'General Assistant',
  });
}

function buildTenantAtlasRuntimeSlug(tenantSlug: string): string {
  const slug = slugifySessionKeyPart(tenantSlug, 'tenant');
  return slug === DEFAULT_TENANT_SLUG ? 'atlas' : `atlas-${slug}`;
}

function buildTenantAtlasWorkspacePath(tenantSlug: string): string {
  const home = process.env.HOME ?? os.homedir();
  const openclawRoot = process.env.WORKSPACE_PARENT ?? path.join(home, '.openclaw');
  return path.join(openclawRoot, `workspace-${buildTenantAtlasRuntimeSlug(tenantSlug)}`);
}

function buildStarterAgentRuntimeSlug(tenantSlug: string, definition: typeof STARTER_AGENT_DEFINITIONS[number]): string {
  const tenantPart = slugifySessionKeyPart(tenantSlug, 'tenant');
  const rolePart = definition.systemRole.split('.').pop() ?? definition.jobTitle;
  return `${tenantPart}-${slugifySessionKeyPart(rolePart, definition.jobTitle)}`;
}

function buildStarterAgentWorkspacePath(tenantSlug: string, definition: typeof STARTER_AGENT_DEFINITIONS[number]): string {
  const home = process.env.HOME ?? os.homedir();
  const openclawRoot = process.env.WORKSPACE_PARENT ?? path.join(home, '.openclaw');
  return path.join(openclawRoot, `workspace-${buildStarterAgentRuntimeSlug(tenantSlug, definition)}`);
}

function ensureTenantAtlasWorkspaceDocs(workspacePath: string): void {
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'memory'), { recursive: true });
  for (const [filename, content] of Object.entries(TENANT_ATLAS_DOCS)) {
    const target = path.join(workspacePath, filename);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, content, 'utf-8');
    }
  }
}

function ensureStarterAgentWorkspaceDocs(workspacePath: string, definition: typeof STARTER_AGENT_DEFINITIONS[number]): void {
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'memory'), { recursive: true });
  for (const [filename, content] of Object.entries(definition.identityDocs)) {
    const target = path.join(workspacePath, filename);
    if (fs.existsSync(target)) continue;
    const hydrated = content
      .replace('- **State:** Unprovisioned starter template', '- **State:** Provisioned tenant starter agent')
      .replace('- **Workspace:** Assigned during provisioning', `- **Workspace:** ${workspacePath}`);
    fs.writeFileSync(target, hydrated, 'utf-8');
  }
}

async function ensureTenantDefaultAtlasAgent(db: Db, tenantId: number, projectId: number): Promise<number> {
  const tenant = await db.get(`SELECT slug FROM tenants WHERE id = ? LIMIT 1`, tenantId) as { slug: string } | undefined;
  const tenantSlug = tenant?.slug ?? `tenant-${tenantId}`;
  const runtimeSlug = buildTenantAtlasRuntimeSlug(tenantSlug);
  const sessionKey = buildTenantAtlasSessionKey(tenantSlug);
  const workspacePath = buildTenantAtlasWorkspacePath(tenantSlug);
  ensureTenantAtlasWorkspaceDocs(workspacePath);

  const existing = await db.get(`
    SELECT id
    FROM agents
    WHERE tenant_id = ?
      AND deleted_at IS NULL
      AND (
        system_role = ?
        OR session_key = ?
        OR openclaw_agent_id = ?
        OR lower(name) = lower(?)
      )
    ORDER BY CASE WHEN system_role = ? THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `, tenantId, ATLAS_SYSTEM_ROLE, sessionKey, runtimeSlug, ATLAS_AGENT_NAME, ATLAS_SYSTEM_ROLE) as { id: number } | undefined;

  if (existing) {
    await db.run(`
      UPDATE agents
      SET project_id = COALESCE(project_id, ?),
          role = CASE WHEN role IS NULL OR trim(role) = '' THEN ? ELSE role END,
          job_title = CASE WHEN job_title IS NULL OR trim(job_title) = '' THEN ? ELSE job_title END,
          system_role = COALESCE(system_role, ?),
          runtime_type = COALESCE(runtime_type, 'openclaw'),
          openclaw_agent_id = CASE WHEN openclaw_agent_id IS NULL OR trim(openclaw_agent_id) = '' THEN ? ELSE openclaw_agent_id END,
          workspace_path = CASE WHEN workspace_path IS NULL OR trim(workspace_path) = '' THEN ? ELSE workspace_path END,
          job_instructions = CASE WHEN job_instructions IS NULL OR trim(job_instructions) = '' THEN ? ELSE job_instructions END,
          last_active = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = ?
    `, projectId, TENANT_ATLAS_ROLE, TENANT_ATLAS_ROLE, ATLAS_SYSTEM_ROLE, runtimeSlug, workspacePath, TENANT_ATLAS_JOB_INSTRUCTIONS, existing.id);
    return existing.id;
  }

  const result = await db.run(`
    INSERT INTO agents (
      tenant_id, project_id, name, role, job_title, session_key, workspace_path, status,
      openclaw_agent_id, runtime_type, runtime_config, preferred_provider, model,
      system_role, enabled, timeout_seconds, skill_names, sort_rules, job_instructions
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, 'openclaw', NULL, 'anthropic', NULL, ?, 1, 900, '[]', '[]', ?)
  `,
  tenantId,
  projectId,
  ATLAS_AGENT_NAME,
  TENANT_ATLAS_ROLE,
  TENANT_ATLAS_ROLE,
  sessionKey,
  workspacePath,
  runtimeSlug,
  ATLAS_SYSTEM_ROLE,
  TENANT_ATLAS_JOB_INSTRUCTIONS);
  return Number(result.lastInsertId);
}

async function buildStarterAgentRuntimeConfig(
  db: Db,
  definition: typeof STARTER_AGENT_DEFINITIONS[number],
  workspacePath: string,
  openclawAgentId: string,
): Promise<Record<string, unknown>> {
  return {
    provisioning_state: 'provisioned',
    provisioning_template: {
      template_version: 1,
      identity_doc_model: 'inline_runtime_config_documents',
      identity_docs: definition.identityDocs,
      workspace_path: workspacePath,
      openclaw_agent_id: openclawAgentId,
      role_instructions: definition.role,
      runtime_policy: definition.modelPolicy,
      workflow_assignments: definition.workflowTypes,
      contract_assignments: definition.contractTypes,
      task_type_assignments: definition.taskTypes,
      mcp_capabilities: definition.mcpCapabilities,
      mcp_server_slugs: definition.mcpServerSlugs,
      tool_slugs: definition.toolSlugs,
      skill_names: definition.skillNames,
      requirements: definition.requirements,
    },
    ...await buildRuntimeConfigDefaults(db),
  };
}

async function ensureStarterToolCatalogRows(db: Db, tenantId: number): Promise<void> {
  const insertToolSql = `
    INSERT INTO tools (
      tenant_id, name, slug, description, implementation_type, implementation_body,
      input_schema, permissions, tags, enabled
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT (tenant_id, slug) DO NOTHING
  `;
  for (const tool of STARTER_TOOL_CATALOG_ROWS) {
    await db.run(
      insertToolSql,
      tenantId,
      tool.name,
      tool.slug,
      tool.description,
      tool.implementation_type,
      tool.implementation_body,
      JSON.stringify(tool.input_schema),
      tool.permissions,
      JSON.stringify(tool.tags),
    );
  }
}

async function ensureStarterAgentToolAssignments(
  db: Db,
  agentId: number,
  toolSlugs: readonly string[],
): Promise<void> {
  const insertAssignmentSql = `
    INSERT INTO agent_tool_assignments (agent_id, tool_id, overrides, enabled)
    SELECT ?, id, '{}', 1
    FROM tools
    WHERE tenant_id = (SELECT tenant_id FROM agents WHERE id = ?)
      AND slug = ?
      AND enabled = 1
    ON CONFLICT (agent_id, tool_id) DO NOTHING
  `;
  for (const slug of toolSlugs) await db.run(insertAssignmentSql, agentId, agentId, slug);
}

export async function ensureTenantAgentHqMcpServer(db: Db, tenantId: number): Promise<number | null> {
  const existing = await db.get(`
    SELECT id
    FROM mcp_servers
    WHERE tenant_id = ? AND slug = ?
    LIMIT 1
  `, tenantId, AGENT_HQ_MCP_SERVER_SLUG) as { id: number } | undefined;
  if (existing) return existing.id;

  const serverEntryScript = path.join(path.resolve(__dirname, '../..'), 'dist', 'mcp', 'server.js');
  const nodeExecutable = path.join(NODE_BIN_DIR, 'node');
  const args = JSON.stringify([serverEntryScript]);
  const env = JSON.stringify({
    AGENT_HQ_API_URL: getAgentHqBaseUrl(`http://127.0.0.1:${process.env.PORT ?? 3501}`),
  });
  const cwd = path.resolve(__dirname, '../..');

  await db.run(`
    INSERT INTO mcp_servers (tenant_id, name, slug, description, transport, command, args, env, cwd, enabled)
    VALUES (?, ?, ?, ?, 'stdio', ?, ?, ?, ?, 1)
    ON CONFLICT (tenant_id, slug) DO NOTHING
  `, tenantId, 'Agent HQ MCP Server', AGENT_HQ_MCP_SERVER_SLUG, 'Tenant-local stdio MCP server exposing Agent HQ projects, sprints, tasks, and agents.', nodeExecutable, args, env, cwd);

  return (await db.get(`
    SELECT id FROM mcp_servers WHERE tenant_id = ? AND slug = ? LIMIT 1
  `, tenantId, AGENT_HQ_MCP_SERVER_SLUG) as { id: number } | undefined)?.id ?? null;
}

export async function repairAgentMcpAssignmentsForTenant(db: Db, tenantId: number, agentId: number): Promise<void> {
  await db.run(`
    DELETE FROM agent_mcp_assignments
    WHERE agent_id = ?
      AND mcp_server_id IN (
        SELECT id
        FROM mcp_servers
        WHERE tenant_id != ?
      )
  `, agentId, tenantId);
}

async function ensureStarterAgentMcpAssignments(
  db: Db,
  tenantId: number,
  agentId: number,
  mcpServerSlugs: readonly string[],
): Promise<void> {
  await repairAgentMcpAssignmentsForTenant(db, tenantId, agentId);
  if (mcpServerSlugs.includes(AGENT_HQ_MCP_SERVER_SLUG)) {
    await ensureTenantAgentHqMcpServer(db, tenantId);
  }
  const insertAssignmentSql = `
    INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id, overrides, enabled)
    SELECT ?, id, '{}', 1
    FROM mcp_servers
    WHERE slug = ?
      AND enabled = 1
      AND tenant_id = ?
    ON CONFLICT (agent_id, mcp_server_id) DO NOTHING
  `;
  for (const slug of mcpServerSlugs) {
    await db.run(insertAssignmentSql, agentId, slug, tenantId);
  }
}

async function replaceStarterAgentMcpPermissionPolicy(
  db: Db,
  agentId: number,
  enabledCapabilityKeys: readonly string[],
): Promise<void> {
  await db.run(`DELETE FROM agent_mcp_capability_policies WHERE agent_id = ?`, agentId);
  const insertSql = `
    INSERT INTO agent_mcp_capability_policies (agent_id, capability_key, enabled)
    VALUES (?, ?, 1)
  `;
  for (const capabilityKey of enabledCapabilityKeys) {
    await db.run(insertSql, agentId, capabilityKey);
  }
}

async function ensureTenantStarterAgents(db: Db, tenantId: number, projectId: number, tenantSlug: string): Promise<number[]> {
  const agentIds: number[] = [];
  await ensureStarterToolCatalogRows(db, tenantId);

  for (const definition of STARTER_AGENT_DEFINITIONS) {
    const openclawAgentId = buildStarterAgentRuntimeSlug(tenantSlug, definition);
    const workspacePath = buildStarterAgentWorkspacePath(tenantSlug, definition);
    ensureStarterAgentWorkspaceDocs(workspacePath, definition);
    const sessionKey = buildCanonicalAgentMainSessionKey({
      projectName: DEFAULT_PROJECT_NAME,
      projectSlug: `${slugifySessionKeyPart(tenantSlug, `tenant-${tenantId}`)}-${slugifySessionKeyPart(DEFAULT_PROJECT_NAME, 'default-project')}`,
      agentName: definition.name,
      role: definition.jobTitle,
    });
    const runtimeConfig = await buildStarterAgentRuntimeConfig(db, definition, workspacePath, openclawAgentId);
    const existing = await db.get(`
      SELECT id
      FROM agents
      WHERE tenant_id = ?
        AND deleted_at IS NULL
        AND (
          system_role = ?
          OR session_key = ?
          OR lower(name) = lower(?)
        )
      ORDER BY CASE WHEN system_role = ? THEN 0 ELSE 1 END, id ASC
      LIMIT 1
    `, tenantId, definition.systemRole, sessionKey, definition.name, definition.systemRole) as { id: number } | undefined;

    if (existing) {
      await db.run(`
        UPDATE agents
        SET project_id = ?,
            name = CASE WHEN system_role = ? THEN name ELSE ? END,
            role = ?,
            job_title = ?,
            session_key = ?,
            runtime_type = ?,
            runtime_config = ?,
            preferred_provider = ?,
            model = ?,
            system_role = ?,
            openclaw_agent_id = CASE WHEN openclaw_agent_id IS NULL OR trim(openclaw_agent_id) = '' THEN ? ELSE openclaw_agent_id END,
            workspace_path = CASE WHEN workspace_path IS NULL OR trim(workspace_path) = '' THEN ? ELSE workspace_path END,
            enabled = 0,
            job_instructions = ?,
            skill_names = ?
        WHERE id = ?
      `,
      projectId,
      definition.systemRole,
      definition.name,
      definition.role,
      definition.jobTitle,
      sessionKey,
      definition.modelPolicy.runtime_type,
      JSON.stringify(runtimeConfig),
      definition.modelPolicy.preferred_provider,
      definition.modelPolicy.model,
      definition.systemRole,
      openclawAgentId,
      workspacePath,
      definition.role,
      JSON.stringify(definition.skillNames),
      existing.id);
      await replaceStarterAgentMcpPermissionPolicy(db, existing.id, definition.mcpCapabilities);
      await ensureStarterAgentToolAssignments(db, existing.id, definition.toolSlugs);
      await ensureStarterAgentMcpAssignments(db, tenantId, existing.id, definition.mcpServerSlugs);
      agentIds.push(existing.id);
      continue;
    }

    const result = await db.run(`
      INSERT INTO agents (
        tenant_id, project_id, name, role, job_title, session_key, workspace_path, status,
        openclaw_agent_id, runtime_type, runtime_config, preferred_provider, model, system_role,
        enabled, timeout_seconds, skill_names, sort_rules, job_instructions
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, 0, 900, ?, ?, ?)
    `,
    tenantId,
    projectId,
    definition.name,
    definition.role,
    definition.jobTitle,
    sessionKey,
    workspacePath,
    openclawAgentId,
    definition.modelPolicy.runtime_type,
    JSON.stringify(runtimeConfig),
    definition.modelPolicy.preferred_provider,
    definition.modelPolicy.model,
    definition.systemRole,
    JSON.stringify(definition.skillNames),
    JSON.stringify(definition.taskTypes),
    definition.role);
    const agentId = Number(result.lastInsertId);
    await replaceStarterAgentMcpPermissionPolicy(db, agentId, definition.mcpCapabilities);
    await ensureStarterAgentToolAssignments(db, agentId, definition.toolSlugs);
    await ensureStarterAgentMcpAssignments(db, tenantId, agentId, definition.mcpServerSlugs);
    agentIds.push(agentId);
  }

  return agentIds;
}

async function provisionTenantDefaultWorkspace(db: Db, tenantId: number): Promise<void> {
  // The install package owns all starter configuration, including workflow-event mappings.
  // Calling individual seeders again here used to make tenant creation a second reconciliation
  // pass over configuration that had already been installed.
  await applyDefaultInstallPackage(db, tenantId);
  const tenant = await db.get(`SELECT slug FROM tenants WHERE id = ? LIMIT 1`, tenantId) as { slug: string } | undefined;
  const tenantSlug = tenant?.slug ?? `tenant-${tenantId}`;
  const existingProject = await db.get(`
    SELECT id, name
    FROM projects
    WHERE tenant_id = ? AND lower(name) IN (lower(?), lower(?))
    ORDER BY CASE WHEN lower(name) = lower(?) THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `, tenantId, DEFAULT_PROJECT_NAME, LEGACY_STARTER_PROJECT_NAME, DEFAULT_PROJECT_NAME) as { id: number; name: string } | undefined;
  const projectId = existingProject?.id ?? Number((await db.run(`
    INSERT INTO projects (tenant_id, name, description, context_md)
    VALUES (?, ?, ?, ?)
  `, tenantId, DEFAULT_PROJECT_NAME, 'Reusable starter workspace project.', 'Clean starter workspace for this tenant.')).lastInsertId);
  if (existingProject?.name === LEGACY_STARTER_PROJECT_NAME) {
    await db.run(`
      UPDATE projects
      SET name = ?,
          description = CASE WHEN description = '' OR description = ? THEN ? ELSE description END
      WHERE id = ?
    `, DEFAULT_PROJECT_NAME, 'Default Agent HQ workspace project.', 'Reusable starter workspace project.', projectId);
  }

  await ensureProjectBacklogSprint(db, projectId);
  const atlasAgentId = await ensureTenantDefaultAtlasAgent(db, tenantId, projectId);
  await ensureStarterAgentMcpAssignments(db, tenantId, atlasAgentId, [AGENT_HQ_MCP_SERVER_SLUG]);
  await ensureTenantStarterAgents(db, tenantId, projectId, tenantSlug);
}

export async function repairTenantOwnershipForMigration(db: Db): Promise<number> {
  const existingTenant = await db.get(`SELECT id FROM tenants ORDER BY id ASC LIMIT 1`) as { id: number } | undefined;
  if (existingTenant) {
    // Explicit migration is intentionally non-reconciling once tenant-owned configuration exists.
    // Existing rows are user-owned; validate them and leave them byte-for-byte alone.
    return await verifyTenantSchemaForStartup(db);
  }

  const defaultTenantId = await db.withTransaction(async (tx) => {
    const result = await tx.run(`
      INSERT INTO tenants (name, slug, is_default)
      VALUES (?, ?, 1)
    `, DEFAULT_TENANT_NAME, DEFAULT_TENANT_SLUG);
    const tenantId = Number(result.lastInsertId);
    await setSetting(tx, DEFAULT_TENANT_SETTING_KEY, String(tenantId));
    await setSetting(tx, ACTIVE_TENANT_SETTING_KEY, String(tenantId));
    await provisionTenantDefaultWorkspace(tx, tenantId);
    return tenantId;
  });

  verifiedTenantSchemaDbs.delete(db);
  return await verifyTenantSchemaForStartup(db);
}

/** Compatibility name retained for callers; this is validation-only and never repairs schema. */
export async function ensureTenantSchema(db: Db): Promise<number> {
  return await verifyTenantSchemaForStartup(db);
}

export async function getDefaultTenantId(db: Db): Promise<number> {
  return await requireCurrentDefaultTenantId(db);
}

export async function getActiveTenantId(db: Db): Promise<number> {
  await requireCurrentDefaultTenantId(db);
  return Number(await getSetting(db, ACTIVE_TENANT_SETTING_KEY));
}

export async function setActiveTenantId(db: Db, tenantId: number): Promise<TenantRecord> {
  await verifyTenantSchemaForStartup(db);
  const tenant = await db.get(`SELECT * FROM tenants WHERE id = ? LIMIT 1`, tenantId) as TenantRecord | undefined;
  if (!tenant) {
    const error = new Error('Tenant not found') as Error & { status?: number };
    error.status = 404;
    throw error;
  }
  await setSetting(db, ACTIVE_TENANT_SETTING_KEY, String(tenantId));
  return tenant;
}

export async function resolveTenantIdFromRequest(db: Db, req: Request): Promise<number> {
  await verifyTenantSchemaForStartup(db);
  const headerValue = req.header('x-agent-hq-tenant-id') ?? req.header('x-tenant-id');
  const raw = req.query.tenant_id ?? req.query.company_id ?? headerValue;
  const candidate = Array.isArray(raw) ? raw[0] : raw;

  const requireTenant = async (tenantId: number): Promise<void> => {
    const tenant = Number.isInteger(tenantId) && tenantId > 0
      ? await db.get(`SELECT id FROM tenants WHERE id = ? LIMIT 1`, tenantId)
      : null;
    if (!tenant) {
      const error = new Error('Tenant not found') as Error & { status?: number };
      error.status = 404;
      throw error;
    }
  };

  const enforceMcpTenantScope = (requestedTenantId: number, source: 'explicit' | 'active' | 'identity'): void => {
    const identity = req.mcpIdentity;
    if (!identity) return;
    if (source === 'identity') {
      if (identity.tenantId === requestedTenantId) return;
    } else if (identity.globalAdminAccess) {
      return;
    }
    const error = new Error(
      source === 'explicit'
        ? 'MCP API key is not authorized to select a tenant; assign the admin.cross_tenant super-admin MCP capability for tenant selection'
        : source === 'active'
          ? 'MCP API key is not authorized for the active tenant; assign the admin.cross_tenant super-admin MCP capability for cross-tenant access'
          : 'MCP API key tenant does not match the resolved tenant',
    ) as Error & { status?: number; code?: string; details?: Record<string, unknown> };
    error.status = 403;
    error.code = 'mcp_tenant_scope_denied';
    error.details = {
      agent_id: identity.agentId,
      agent_slug: identity.agentSlug,
      key_tenant_id: identity.tenantId,
      requested_tenant_id: requestedTenantId,
      tenant_source: source,
      required_capability: 'admin.cross_tenant',
      super_admin_mcp_access: false,
    };
    throw error;
  };

  if (candidate !== undefined && candidate !== null && String(candidate).trim() !== '') {
    const id = Number(candidate);
    if (!req.mcpIdentity) {
      const error = new Error('Explicit tenant selectors are not allowed for this request context') as Error & { status?: number; code?: string };
      error.status = 400;
      error.code = 'tenant_selector_not_allowed';
      throw error;
    }
    // Deny explicit tenant selectors for non-super-admin MCP keys BEFORE checking that
    // the tenant exists. Otherwise an unauthorized key could probe which tenant IDs
    // exist by distinguishing 404 (no such tenant) from 403 (exists, not authorized);
    // enforcing scope first returns an identical 403 either way.
    enforceMcpTenantScope(id, 'explicit');
    // MUST be awaited: requireTenant became async, and an unawaited call means the
    // tenant-existence check never runs before the id is returned — a nonexistent or
    // unauthorized tenant id would be accepted.
    await requireTenant(id);
    return id;
  }

  if (req.mcpIdentity) {
    await requireTenant(req.mcpIdentity.tenantId);
    enforceMcpTenantScope(req.mcpIdentity.tenantId, 'identity');
    return req.mcpIdentity.tenantId;
  }

  const activeTenantId = await getActiveTenantId(db);
  enforceMcpTenantScope(activeTenantId, 'active');
  return activeTenantId;
}

export async function createTenantWithDefaults(db: Db, input: { name?: unknown; slug?: unknown; set_active?: unknown }): Promise<TenantRecord> {
  await verifyTenantSchemaForStartup(db);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) {
    const error = new Error('name is required') as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  const requestedSlug = typeof input.slug === 'string' && input.slug.trim() ? input.slug.trim() : name;
  const normalizedRequestedSlug = slugifyTenantName(requestedSlug);
  const existingBySlug = await db.get(`SELECT * FROM tenants WHERE slug = ? LIMIT 1`, normalizedRequestedSlug) as TenantRecord | undefined;
  if (existingBySlug) {
    await db.withTransaction(async (db) => {
      if (input.set_active === true || input.set_active === 'true' || input.set_active === 1 || input.set_active === '1') {
        await setSetting(db, ACTIVE_TENANT_SETTING_KEY, String(existingBySlug.id));
      }
    });
    return await db.get(`SELECT * FROM tenants WHERE id = ?`, existingBySlug.id) as TenantRecord;
  }
  const slug = await uniqueTenantSlug(db, requestedSlug);

  const tenant = await db.withTransaction(async (db) => {
    const result = await db.run(`INSERT INTO tenants (name, slug, is_default) VALUES (?, ?, 0)`, name, slug);
    const tenantId = Number(result.lastInsertId);
    await provisionTenantDefaultWorkspace(db, tenantId);
    if (input.set_active === true || input.set_active === 'true' || input.set_active === 1 || input.set_active === '1') {
      await setSetting(db, ACTIVE_TENANT_SETTING_KEY, String(tenantId));
    }
    return await db.get(`SELECT * FROM tenants WHERE id = ?`, tenantId) as TenantRecord;
  });

  return tenant;
}

export async function deleteTenant(db: Db, tenantId: number, input: { confirmation?: unknown } = {}): Promise<DeleteTenantResult> {
  await verifyTenantSchemaForStartup(db);
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    const error = new Error('Tenant id must be a positive integer') as Error & { status?: number };
    error.status = 400;
    throw error;
  }

  const tenant = await db.get(`SELECT * FROM tenants WHERE id = ? LIMIT 1`, tenantId) as TenantRecord | undefined;
  if (!tenant) {
    const error = new Error('Tenant not found') as Error & { status?: number };
    error.status = 404;
    throw error;
  }
  if (tenant.is_default === 1) {
    const error = new Error('Default tenant cannot be deleted from Settings') as Error & { status?: number };
    error.status = 409;
    throw error;
  }

  const confirmation = typeof input.confirmation === 'string' ? input.confirmation.trim() : '';
  if (confirmation !== tenant.name) {
    const error = new Error('Tenant deletion requires typing the exact tenant name') as Error & { status?: number };
    error.status = 400;
    throw error;
  }

  const replacementTenant = await db.get(`
    SELECT id
    FROM tenants
    WHERE id != ?
    ORDER BY is_default DESC, created_at ASC, id ASC
    LIMIT 1
  `, tenantId) as { id: number } | undefined;
  if (!replacementTenant) {
    const error = new Error('Cannot delete the only tenant') as Error & { status?: number };
    error.status = 409;
    throw error;
  }

  const activeBefore = await getActiveTenantId(db);
  const counts: Record<string, number> = {};

  await db.withTransaction(async (db) => {
    for (const [table, whereSql] of [
      ['session_messages', `session_id IN (SELECT id FROM sessions WHERE tenant_id = ?)`],
      ['chat_messages', `agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`],
      ['canonical_chat_sessions', `agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`],
      ['external_task_event_receipts', `task_id IN (SELECT id FROM tasks WHERE tenant_id = ?)`],
      ['logs', `agent_id IN (SELECT id FROM agents WHERE tenant_id = ?) OR instance_id IN (
        SELECT id FROM job_instances
        WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)
           OR task_id IN (SELECT id FROM tasks WHERE tenant_id = ?)
      )`],
      ['security_events', `agent_id IN (SELECT id FROM agents WHERE tenant_id = ?) OR task_id IN (SELECT id FROM tasks WHERE tenant_id = ?) OR instance_id IN (
        SELECT id FROM job_instances
        WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)
           OR task_id IN (SELECT id FROM tasks WHERE tenant_id = ?)
      )`],
    ] as Array<[string, string]>) {
      const params = Array((whereSql.match(/\?/g) ?? []).length).fill(tenantId);
      addCounts(counts, await deleteWhere(db, table, whereSql, params));
    }

    addCounts(counts, await deleteWhere(db, 'job_instances', `agent_id IN (SELECT id FROM agents WHERE tenant_id = ?) OR task_id IN (SELECT id FROM tasks WHERE tenant_id = ?)`, [tenantId, tenantId]));
    addCounts(counts, await deleteWhere(db, 'task_relationships', `source_task_id IN (SELECT id FROM tasks WHERE tenant_id = ?) OR target_task_id IN (SELECT id FROM tasks WHERE tenant_id = ?)`, [tenantId, tenantId]));
    addCounts(counts, await deleteWhere(db, 'task_dependencies', `blocked_id IN (SELECT id FROM tasks WHERE tenant_id = ?) OR blocker_id IN (SELECT id FROM tasks WHERE tenant_id = ?)`, [tenantId, tenantId]));
    addCounts(counts, await deleteWhere(db, 'recurring_task_runs', `series_id IN (SELECT id FROM recurring_task_series WHERE tenant_id = ?) OR created_task_id IN (SELECT id FROM tasks WHERE tenant_id = ?)`, [tenantId, tenantId]));
    for (const table of ['agent_tool_assignments', 'agent_mcp_assignments', 'mcp_api_keys']) {
      addCounts(counts, await deleteWhere(db, table, `agent_id IN (SELECT id FROM agents WHERE tenant_id = ?)`, [tenantId]));
    }
    addCounts(counts, await deleteWhere(db, 'agent_mcp_assignments', `mcp_server_id IN (SELECT id FROM mcp_servers WHERE tenant_id = ?)`, [tenantId], 'agent_mcp_assignments'));
    addCounts(counts, await deleteWhere(db, 'agent_tool_assignments', `tool_id IN (SELECT id FROM tools WHERE tenant_id = ?)`, [tenantId], 'agent_tool_assignments'));
    addCounts(counts, await deleteWhere(db, 'project_audit_log', `project_id IN (SELECT id FROM projects WHERE tenant_id = ?)`, [tenantId]));
    addCounts(counts, await deleteWhere(db, 'routing_config', `project_id IN (SELECT id FROM projects WHERE tenant_id = ?)`, [tenantId]));
    addCounts(counts, await deleteWhere(db, 'sprint_task_statuses', `sprint_id IN (SELECT id FROM sprints WHERE tenant_id = ?)`, [tenantId]));

    for (const table of [
      'sessions',
      'external_event_mappings',
      'story_point_model_routing',
      'sprint_task_transition_requirements',
      'sprint_task_transitions',
      'sprint_task_routing_rules',
      'recurring_task_series',
      'tasks',
      'sprints',
      'tools',
      'skills',
      'mcp_servers',
      'provider_config',
      'github_identities',
      'agents',
      'projects',
    ]) {
      await deleteTenantRows(db, table, tenantId, counts);
    }

    addCount(counts, 'tenants', (await db.run(`DELETE FROM tenants WHERE id = ? AND is_default = 0`, tenantId)).changes);

    if (activeBefore === tenantId) {
      await setSetting(db, ACTIVE_TENANT_SETTING_KEY, String(replacementTenant.id));
    }
  });

  return {
    ok: true,
    deleted_tenant: tenant,
    active_tenant_id: activeBefore === tenantId ? replacementTenant.id : activeBefore,
    active_tenant_changed: activeBefore === tenantId,
    deletion_semantics: 'hard_delete_tenant_owned_records',
    deleted_counts: counts,
  };
}

export async function listTenants(db: Db): Promise<Array<TenantRecord & { project_count: number; task_count: number; agent_count: number; is_active: number }>> {
  const activeTenantId = await getActiveTenantId(db);
  return await db.all(`
    SELECT t.*,
      CASE WHEN t.id = ? THEN 1 ELSE 0 END AS is_active,
      (SELECT COUNT(*) FROM projects p WHERE p.tenant_id = t.id) AS project_count,
      (SELECT COUNT(*) FROM tasks tk WHERE tk.tenant_id = t.id) AS task_count,
      (SELECT COUNT(*) FROM agents a WHERE a.tenant_id = t.id) AS agent_count
    FROM tenants t
    ORDER BY t.is_default DESC, t.created_at ASC, t.id ASC
  `, activeTenantId) as Array<TenantRecord & { project_count: number; task_count: number; agent_count: number; is_active: number }>;
}
