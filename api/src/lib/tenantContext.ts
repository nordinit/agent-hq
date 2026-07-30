import type Database from 'better-sqlite3';
import type { Request } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  foreignKeysEnabled,
  withForeignKeysDisabled,
} from '../db/foreignKeyGuard';
import { getRawDb } from '../db/client';
import { assertForeignKeyEnforcementEnabled } from '../db/startupVerifier';
import { NODE_BIN_DIR } from '../config';
import { seedTenantDefaultWorkflowEventMappings } from '../domains/routing/externalEventMappings';
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
  STARTER_SPRINT_TYPE_SEEDS,
} from './starterCatalog';
import { applyDefaultInstallPackage } from './defaultInstallPackage';
import { seedSprintTypeTaskStatuses } from '../domains/routing/policy/seed';
import { pruneUnexpectedStarterWorkflowRelationshipTypes, seedStarterWorkflowRelationshipTypes } from './taskRelationshipTypes';
import { type Db, type RunResult } from "../db/adapter/types";
import { tableExists as sharedTableExists, columnExists as sharedColumnExists, tableColumns as sharedTableColumns, indexExists as sharedIndexExists } from "../db/introspection";

export const DEFAULT_TENANT_SLUG = 'default';
export const DEFAULT_TENANT_NAME = 'Default Tenant';
const LEGACY_DEFAULT_TENANT_NAME = 'Default Company';
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
  'sprint_workflow_templates',
] as const;

const ensuredTenantSchemaDbs = new WeakSet<Db>();
const verifiedTenantSchemaDbs = new WeakSet<Db>();

// Foreign-key enforcement helpers live in db/foreignKeyGuard.ts so that schema.ts,
// this module and db/startupVerifier.ts can all share them without an import cycle.
// Re-exported here because this is where migration code already reaches for them.
export { foreignKeysEnabled, withForeignKeysDisabled };

/**
 * The raw better-sqlite3 connection behind a Db handle.
 *
 * `PRAGMA` is deliberately absent from the Db interface — it is SQLite-only and has no
 * PostgreSQL equivalent — but the foreign-key guard must toggle it on the SAME connection
 * the adapter writes through, or the toggle applies to a different connection and the
 * rebuild runs with enforcement still on. SqliteAdapter publishes `raw` for exactly this.
 * Every caller of this helper is a site the PostgreSQL migration still has to answer for.
 */
function rawConnectionFor(db: Db): Database.Database {
  const candidate = db as unknown as { raw?: Database.Database; pragma?: unknown };
  if (candidate.raw) return candidate.raw;
  // Some suites still hand this module a bare better-sqlite3 connection cast to Db.
  if (typeof candidate.pragma === 'function') return db as unknown as Database.Database;

  // Throws rather than falling back to getRawDb(). The fallback is what made the PostgreSQL
  // split-brain silent: handed a PostgresAdapter this returned a SQLite connection to a file the
  // rest of the process was not using, and callers happily ran SQLite DDL against it. Every
  // caller is now required to return early on `db.dialect === 'postgres'`, so reaching this line
  // means a new caller was added without that guard — and a loud failure in the one code path
  // that added it is far better than writes landing in the wrong database.
  throw new Error(
    'rawConnectionFor() was called with a non-SQLite Db. A raw better-sqlite3 connection has no '
    + 'meaning on PostgreSQL, and returning the SQLite file here would write to a database the '
    + 'process is not reading from. Guard the caller with `if (db.dialect === \'postgres\') return;` '
    + 'or express the operation through the Db interface.',
  );
}

/*
 * WHY THE REBUILDS BELOW ARE SYNCHRONOUS
 * --------------------------------------
 * `PRAGMA foreign_keys` is per-connection and db/client.ts hands out ONE process-wide
 * connection, so a disable window is a window for the WHOLE process, not just for the
 * caller that opened it.
 *
 * There must therefore be no `await` — of any kind — between the disable and the restore.
 * Every SqliteAdapter method is async, so awaiting inside the window yields to the event
 * loop and lets other in-flight request handlers resume THERE: their DELETEs run with
 * foreign keys off, ON DELETE CASCADE silently does not fire, and orphan rows accumulate
 * with nothing logged. Awaiting an already-resolved promise is enough to do it, so "the
 * callback body contains no awaits" is not a sufficient guard either — the wrapper itself
 * has to be synchronous. That is exactly the production defect this guard exists to
 * prevent, and it is why there is no async counterpart to withForeignKeysDisabled().
 *
 * So each rebuild does its work synchronously on rawConnectionFor(db) — raw.exec(),
 * raw.prepare().run(), raw.transaction()() — inside the SYNCHRONOUS
 * withForeignKeysDisabled() from db/foreignKeyGuard.ts. Any async introspection a rebuild
 * needs (tableExists, columnExpression, …) is resolved BEFORE the window opens.
 *
 * All four sites are SQLite-only table rebuilds and are deleted with SQLite; the
 * PostgreSQL path has no equivalent, because session-level foreign keys cannot be
 * switched off there at all.
 *
 * SQLite treats `PRAGMA foreign_keys` as a NO-OP inside a transaction, so the window must
 * stay OUTSIDE the transaction, never be opened from within one.
 */

async function tableExists(db: Db, table: string): Promise<boolean> {
    return await sharedTableExists(db, table);
}

async function tableHasColumn(db: Db, table: string, column: string): Promise<boolean> {
    return await sharedColumnExists(db, table, column);
}

async function columnExpression(db: Db, table: string, column: string, fallbackSql: string): Promise<string> {
  return await tableHasColumn(db, table, column) ? column : fallbackSql;
}

async function backfillOperationalTenantOwnership(db: Db): Promise<void> {
  if (await tableExists(db, 'job_instances') && await tableHasColumn(db, 'job_instances', 'tenant_id')) {
    if (await tableHasColumn(db, 'tasks', 'tenant_id')) {
      await db.run(`
        UPDATE job_instances
        SET tenant_id = (SELECT t.tenant_id FROM tasks t WHERE t.id = job_instances.task_id)
        WHERE tenant_id IS NULL
          AND task_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = job_instances.task_id AND t.tenant_id IS NOT NULL)
      `);
    }
    if (await tableHasColumn(db, 'agents', 'tenant_id')) {
      await db.run(`
        UPDATE job_instances
        SET tenant_id = (SELECT a.tenant_id FROM agents a WHERE a.id = job_instances.agent_id)
        WHERE tenant_id IS NULL
          AND agent_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM agents a WHERE a.id = job_instances.agent_id AND a.tenant_id IS NOT NULL)
      `);
    }
  }

  for (const table of ['task_history', 'task_notes', 'task_creation_events', 'task_outcome_metrics']) {
    if (!await tableHasColumn(db, table, 'tenant_id') || !await tableHasColumn(db, 'tasks', 'tenant_id')) continue;
    await db.run(`
      UPDATE ${table}
      SET tenant_id = (SELECT t.tenant_id FROM tasks t WHERE t.id = ${table}.task_id)
      WHERE tenant_id IS NULL
        AND task_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = ${table}.task_id AND t.tenant_id IS NOT NULL)
    `);
  }

  if (await tableHasColumn(db, 'sessions', 'tenant_id')) {
    if (await tableHasColumn(db, 'tasks', 'tenant_id')) {
      await db.run(`
        UPDATE sessions
        SET tenant_id = (SELECT t.tenant_id FROM tasks t WHERE t.id = sessions.task_id)
        WHERE tenant_id IS NULL
          AND task_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = sessions.task_id AND t.tenant_id IS NOT NULL)
      `);
    }
    if (await tableHasColumn(db, 'agents', 'tenant_id')) {
      await db.run(`
        UPDATE sessions
        SET tenant_id = (SELECT a.tenant_id FROM agents a WHERE a.id = sessions.agent_id)
        WHERE tenant_id IS NULL
          AND agent_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM agents a WHERE a.id = sessions.agent_id AND a.tenant_id IS NOT NULL)
      `);
    }
    if (await tableHasColumn(db, 'projects', 'tenant_id')) {
      await db.run(`
        UPDATE sessions
        SET tenant_id = (SELECT p.tenant_id FROM projects p WHERE p.id = sessions.project_id)
        WHERE tenant_id IS NULL
          AND project_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM projects p WHERE p.id = sessions.project_id AND p.tenant_id IS NOT NULL)
      `);
    }
    if (await tableHasColumn(db, 'job_instances', 'tenant_id')) {
      await db.run(`
        UPDATE sessions
        SET tenant_id = (SELECT ji.tenant_id FROM job_instances ji WHERE ji.id = sessions.instance_id)
        WHERE tenant_id IS NULL
          AND instance_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM job_instances ji WHERE ji.id = sessions.instance_id AND ji.tenant_id IS NOT NULL)
      `);
    }
  }

  if (await tableHasColumn(db, 'chat_messages', 'tenant_id')) {
    if (await tableHasColumn(db, 'job_instances', 'tenant_id')) {
      await db.run(`
        UPDATE chat_messages
        SET tenant_id = (SELECT ji.tenant_id FROM job_instances ji WHERE ji.id = chat_messages.instance_id)
        WHERE tenant_id IS NULL
          AND instance_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM job_instances ji WHERE ji.id = chat_messages.instance_id AND ji.tenant_id IS NOT NULL)
      `);
    }
    if (await tableHasColumn(db, 'agents', 'tenant_id')) {
      await db.run(`
        UPDATE chat_messages
        SET tenant_id = (SELECT a.tenant_id FROM agents a WHERE a.id = chat_messages.agent_id)
        WHERE tenant_id IS NULL
          AND agent_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM agents a WHERE a.id = chat_messages.agent_id AND a.tenant_id IS NOT NULL)
      `);
    }
  }

  if (await tableHasColumn(db, 'logs', 'tenant_id')) {
    if (await tableHasColumn(db, 'logs', 'instance_id') && await tableHasColumn(db, 'job_instances', 'tenant_id')) {
      await db.run(`
        UPDATE logs
        SET tenant_id = (SELECT ji.tenant_id FROM job_instances ji WHERE ji.id = logs.instance_id)
        WHERE tenant_id IS NULL
          AND instance_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM job_instances ji WHERE ji.id = logs.instance_id AND ji.tenant_id IS NOT NULL)
      `);
    }
    if (await tableHasColumn(db, 'logs', 'agent_id') && await tableHasColumn(db, 'agents', 'tenant_id')) {
      await db.run(`
        UPDATE logs
        SET tenant_id = (SELECT a.tenant_id FROM agents a WHERE a.id = logs.agent_id)
        WHERE tenant_id IS NULL
          AND agent_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM agents a WHERE a.id = logs.agent_id AND a.tenant_id IS NOT NULL)
      `);
    }
  }
}

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
  if (!await tableHasColumn(db, table, 'tenant_id')) {
    throw new Error(`Table ${table} is not directly tenant-scoped`);
  }
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
  if (!await tableHasColumn(db, table, 'tenant_id')) return 0;
  return (await db.run(`DELETE FROM ${table} WHERE tenant_id = ?`, tenantId)).changes;
}

async function deleteWhere(db: Db, table: string, whereSql: string, params: unknown[], countKey = table): Promise<Record<string, number>> {
  if (!await tableExists(db, table)) return {};
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

async function ensureAppSettingsTable(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

async function getSetting(db: Db, key: string): Promise<string | null> {
  return (await db.get(`SELECT value FROM app_settings WHERE key = ?`, key) as { value?: string } | undefined)?.value ?? null;
}

async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await db.run(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `, key, value);
}

function tenantMigrationRequired(message: string): Error & { code?: string } {
  const error = new Error(`Tenant install/migration required: ${message}`) as Error & { code?: string };
  error.code = 'tenant_migration_required';
  return error;
}

async function requireCurrentDefaultTenantId(db: Db): Promise<number> {
  if (!await tableExists(db, 'app_settings')) {
    throw tenantMigrationRequired('app_settings table is missing; run the database migration/tenant bootstrap command before starting the API');
  }
  if (!await tableExists(db, 'tenants')) {
    throw tenantMigrationRequired('tenants table is missing; run the database migration/tenant bootstrap command before starting the API');
  }
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
  if (!await tableExists(db, table)) return;
  if (!await tableHasColumn(db, table, 'tenant_id')) {
    throw tenantMigrationRequired(`${table}.tenant_id is missing`);
  }
  const nullTenantRow = await db.get(`SELECT 1 FROM ${table} WHERE tenant_id IS NULL LIMIT 1`);
  if (nullTenantRow) {
    throw tenantMigrationRequired(`${table} contains rows without tenant ownership`);
  }
}

/**
 * Tripwire run after tenant migrations finish. Any leaked `PRAGMA foreign_keys = OFF`
 * — from these migrations or from schema init before them — is reported unmissably and
 * force-restored, so deletes stop silently orphaning child rows.
 *
 * It deliberately does not throw: this also runs on the request path (every
 * resolveTenantIdFromRequest call re-enters the migrations), and a loud, self-healed
 * log is better than taking the API down. The strict, throwing assertion lives in
 * verifyStartupSchemaCurrent().
 */
function assertForeignKeysStillEnforced(db: Db): void {
  // PRAGMA foreign_keys is SQLite-only, so there is nothing here to check on PostgreSQL — and
  // without this guard there was something much worse than a useless check.
  //
  // This is the one rawConnectionFor() caller that was not dialect-guarded, and by its own
  // comment above it runs on the REQUEST path: every resolveTenantIdFromRequest re-enters the
  // tenant migrations. Under PostgreSQL rawConnectionFor() found neither a `raw` handle nor a
  // `pragma` method on the adapter and fell through to getRawDb(), which opened the SQLite file
  // and set `journal_mode = WAL` and `foreign_keys = ON` — both writes. So a production process
  // serving every request from PostgreSQL also held the SQLite file open read-write and created
  // a WAL beside it, and the assertion then read back the pragma getRawDb had just set, passed,
  // and logged nothing.
  //
  // No rows were written to SQLite: the three rawConnectionFor callers that actually rebuild
  // tables were already guarded. The damage was that the file being kept as the rollback artifact
  // stopped being quiescent while a live process held it open.
  if (db.dialect === 'postgres') return;

  // The RAW connection, not the Db adapter: the check reads and restores PRAGMA
  // foreign_keys, which the Db interface deliberately does not expose (SQLite-only).
  assertForeignKeyEnforcementEnabled(rawConnectionFor(db), 'tenant ownership migrations', {
    throwOnViolation: false,
    restore: true,
  });
}

export async function verifyTenantSchemaForStartup(db: Db): Promise<number> {
  if (verifiedTenantSchemaDbs.has(db)) return await requireCurrentDefaultTenantId(db);
  const defaultTenantId = await requireCurrentDefaultTenantId(db);
  for (const table of TENANT_OWNED_TABLES) {
    await assertNoNullTenantOwnership(db, table);
  }
  if (await tableExists(db, 'sprint_types')) {
    await assertNoNullTenantOwnership(db, 'sprint_types');
    const primaryKeyColumns = await tablePrimaryKeyColumns(db, 'sprint_types');
    if (primaryKeyColumns.length === 1 && primaryKeyColumns[0] === 'key') {
      throw tenantMigrationRequired('sprint_types still uses legacy global keys; run tenant ownership repair before starting the API');
    }
  }
  for (const table of WORKFLOW_DEFINITION_CONFIG_TABLES) {
    await assertNoNullTenantOwnership(db, table);
  }
  verifiedTenantSchemaDbs.add(db);
  return defaultTenantId;
}

async function backfillDefaultTenantForNullTenantRows(db: Db, defaultTenantId: number): Promise<void> {
  for (const table of TENANT_OWNED_TABLES) {
    if (!await tableHasColumn(db, table, 'tenant_id')) continue;
    const hasNullTenant = await db.get(`SELECT 1 FROM ${table} WHERE tenant_id IS NULL LIMIT 1`);
    if (!hasNullTenant) continue;
    await db.run(`UPDATE ${table} SET tenant_id = ? WHERE tenant_id IS NULL`, defaultTenantId);
  }
}

async function ensureTenantOwnedTableColumns(db: Db, defaultTenantId: number): Promise<void> {
  for (const table of TENANT_OWNED_TABLES) {
    if (!await tableExists(db, table)) continue;
    if (!await tableHasColumn(db, table, 'tenant_id')) {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE`);
    }
    await db.run(`UPDATE ${table} SET tenant_id = ? WHERE tenant_id IS NULL`, defaultTenantId);
    try {
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_tenant ON ${table}(tenant_id)`);
    } catch {
      // Index creation can fail on minimal legacy tables with incompatible state; the column/backfill is the critical migration.
    }
  }
}

async function ensureMcpServersTenantLocalSlugSchema(db: Db, defaultTenantId: number): Promise<void> {
  // SQLite-only. This is a table REBUILD migration: it reads the stored DDL text out of
  // sqlite_master to decide whether the tenant-local unique index is already in place, then
  // recreates the table if not. PostgreSQL stores no DDL text, and does not need this at all —
  // its schema comes from db/pg-baseline, which already declares the index.
  //
  // The guard matters because ensureTenantSchema() runs on EVERY request, so without it every
  // request queries sqlite_master and every route 500s.
  if (db.dialect === 'postgres') return;
  if (!await tableExists(db, 'mcp_servers') || !await tableHasColumn(db, 'mcp_servers', 'tenant_id')) return;
  const ddl = (await db.get(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = 'mcp_servers'
  `) as { sql?: string } | undefined)?.sql ?? '';
  const hasTenantSlugUnique = Boolean(await db.get(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'index'
      AND tbl_name = 'mcp_servers'
      AND sql IS NOT NULL
      AND lower(sql) LIKE '%unique%'
      AND lower(sql) LIKE '%tenant_id%'
      AND lower(sql) LIKE '%slug%'
    LIMIT 1
  `));
  const hasGlobalSlugUnique = /slug\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(ddl);
  if (!hasGlobalSlugUnique && hasTenantSlugUnique) return;
  if (!await tableHasColumn(db, 'mcp_servers', 'id') || !await tableHasColumn(db, 'mcp_servers', 'slug') || !await tableHasColumn(db, 'mcp_servers', 'command')) return;

  // Resolved BEFORE the disable window opens: every await here would otherwise hand the
  // event loop to another request handler while foreign keys are off for the whole process.
  const copyRowsSql = `
    INSERT OR IGNORE INTO mcp_servers_tenant_local (
      id, tenant_id, name, slug, description, transport, command, args, env, cwd, enabled, created_at, updated_at
    )
    SELECT
      id,
      COALESCE(tenant_id, ?),
      ${await columnExpression(db, 'mcp_servers', 'name', 'slug')},
      slug,
      ${await columnExpression(db, 'mcp_servers', 'description', "''")},
      CASE WHEN ${await columnExpression(db, 'mcp_servers', 'transport', "'stdio'")} = 'stdio' THEN 'stdio' ELSE 'stdio' END,
      command,
      ${await columnExpression(db, 'mcp_servers', 'args', "'[]'")},
      ${await columnExpression(db, 'mcp_servers', 'env', "'{}'")},
      ${await columnExpression(db, 'mcp_servers', 'cwd', 'NULL')},
      ${await columnExpression(db, 'mcp_servers', 'enabled', '1')},
      ${await columnExpression(db, 'mcp_servers', 'created_at', "datetime('now')")},
      ${await columnExpression(db, 'mcp_servers', 'updated_at', "datetime('now')")}
    FROM mcp_servers
    ORDER BY id ASC
  `;

  // Synchronous on the raw connection: see "WHY THE REBUILDS BELOW ARE SYNCHRONOUS" above.
  // The pragma must be toggled outside the transaction: inside one it is a no-op.
  const raw = rawConnectionFor(db);
  withForeignKeysDisabled(raw, () => {
    raw.transaction(() => {
      raw.exec(`DROP TABLE IF EXISTS mcp_servers_tenant_local`);
      raw.exec(`
      CREATE TABLE mcp_servers_tenant_local (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        slug          TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        transport     TEXT NOT NULL DEFAULT 'stdio' CHECK(transport IN ('stdio')),
        command       TEXT NOT NULL,
        args          TEXT NOT NULL DEFAULT '[]',
        env           TEXT NOT NULL DEFAULT '{}',
        cwd           TEXT,
        enabled       INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, slug)
      )
    `);
      raw.prepare(copyRowsSql).run(defaultTenantId);
      raw.exec(`DROP TABLE mcp_servers`);
      raw.exec(`ALTER TABLE mcp_servers_tenant_local RENAME TO mcp_servers`);
      raw.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_tenant_slug ON mcp_servers(tenant_id, slug);
      CREATE INDEX IF NOT EXISTS idx_mcp_servers_tenant ON mcp_servers(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_mcp_servers_slug ON mcp_servers(slug);
      CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled);
    `);
    })();
  });
}

async function tablePrimaryKeyColumns(db: Db, table: string): Promise<string[]> {
  if (db.dialect === 'postgres') {
    const rows = await db.all<{ column_name: string }>(
      `SELECT a.attname AS column_name
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = to_regclass(?) AND i.indisprimary`,
      table,
    );
    return rows.map((r) => r.column_name);
  }

  if (!await tableExists(db, table)) return [];
  return (await db.all(`PRAGMA table_info(${table})`) as Array<{ name: string; pk: number }>)
    .filter((column) => Number(column.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((column) => column.name);
}

async function rebuildSprintTypesForTenantLocalKeys(db: Db, defaultTenantId: number): Promise<void> {
  // SQLite-only. This is a table REBUILD: create-copy-drop-rename, driven by PRAGMA
  // introspection of the existing declaration. PostgreSQL needs none of it — its schema comes
  // from db/pg-baseline, which already declares the tenant-local shape this migrates TO.
  //
  // The guard is load-bearing rather than tidy: ensureTenantSchema() runs on EVERY request, so
  // without it every request issues a PRAGMA and every route 500s.
  if (db.dialect === 'postgres') return;

  if (!await tableExists(db, 'sprint_types')) return;
  const hasTenantId = await tableHasColumn(db, 'sprint_types', 'tenant_id');
  const primaryKeyColumns = await tablePrimaryKeyColumns(db, 'sprint_types');
  const inferredTenantExpr = await tableExists(db, 'sprints') && await tableHasColumn(db, 'sprints', 'tenant_id')
    ? `(SELECT s.tenant_id FROM sprints s WHERE s.sprint_type = sprint_types.key AND s.tenant_id IS NOT NULL ORDER BY s.tenant_id ASC LIMIT 1)`
    : 'NULL';
  const raw = rawConnectionFor(db);
  if (hasTenantId && !(primaryKeyColumns.length === 1 && primaryKeyColumns[0] === 'key')) {
    // This is the steady-state path: it runs on every ensureTenantSchema() call, which
    // means on every request. It must never leave enforcement disabled behind it, and it
    // must not yield to the event loop while the window is open — the pragma is per
    // connection and the connection is shared by every concurrent handler. Hence raw and
    // synchronous.
    withForeignKeysDisabled(raw, () => {
      raw.prepare(`
        UPDATE sprint_types
        SET tenant_id = COALESCE(${inferredTenantExpr}, ?)
        WHERE tenant_id IS NULL
      `).run(defaultTenantId);
      raw.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sprint_types_tenant_key ON sprint_types(tenant_id, key);
        CREATE INDEX IF NOT EXISTS idx_sprint_types_system ON sprint_types(is_system);
      `);
    });
    return;
  }

  // Resolved BEFORE the disable window opens; sprint_types is untouched until the rebuild
  // starts, so its column set is the same inside the window.
  const columns = new Set(await sharedTableColumns(db, 'sprint_types'));
  const copyRowsSql = `
    INSERT OR IGNORE INTO sprint_types_tenant_local (
      tenant_id, key, name, description, is_system, status_seeded_at, created_at, updated_at
    )
    SELECT
      COALESCE(${columns.has('tenant_id') ? 'tenant_id' : 'NULL'}, ${inferredTenantExpr}, ?),
      key,
      name,
      COALESCE(${columns.has('description') ? 'description' : "''"}, ''),
      COALESCE(${columns.has('is_system') ? 'is_system' : '1'}, 1),
      ${columns.has('status_seeded_at') ? 'status_seeded_at' : 'NULL'},
      COALESCE(${columns.has('created_at') ? 'created_at' : 'NULL'}, datetime('now')),
      COALESCE(${columns.has('updated_at') ? 'updated_at' : 'NULL'}, datetime('now'))
    FROM sprint_types
  `;

  // Legacy routing tables could still contain single-column REFERENCES sprint_types(key)
  // while the tenant-local parent key is (tenant_id, key), so FK checks stay off for the
  // rebuild and the trailing compatibility DDL. Those legacy references are stripped by
  // initSchema's rebuildWithoutSprintTypeKeyForeignKey pass; enforcement is restored to
  // its prior state here regardless, because this connection is process-wide. The pragma
  // toggle stays outside the transaction: inside one it is a no-op.
  withForeignKeysDisabled(raw, () => {
    raw.transaction(() => {
      raw.exec(`
      CREATE TABLE sprint_types_tenant_local (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id        INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
        key              TEXT NOT NULL,
        name             TEXT NOT NULL,
        description      TEXT NOT NULL DEFAULT '',
        is_system        INTEGER NOT NULL DEFAULT 1,
        status_seeded_at TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, key)
      );
    `);
      raw.prepare(copyRowsSql).run(defaultTenantId);
      raw.exec(`DROP TABLE sprint_types`);
      raw.exec(`ALTER TABLE sprint_types_tenant_local RENAME TO sprint_types`);
    })();
    raw.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sprint_types_tenant_key ON sprint_types(tenant_id, key);
      CREATE INDEX IF NOT EXISTS idx_sprint_types_system ON sprint_types(is_system);
    `);
  });
}

function workflowConfigTableDefinition(table: string): string | null {
  switch (table) {
    case 'task_field_schemas':
      return `
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id        INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
        sprint_type_key  TEXT NOT NULL,
        task_type        TEXT,
        schema_json      TEXT NOT NULL DEFAULT '{}',
        is_system        INTEGER NOT NULL DEFAULT 1,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, sprint_type_key, task_type)
      `;
    case 'sprint_type_task_types':
      return `
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id        INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
        sprint_type_key  TEXT NOT NULL,
        task_type        TEXT NOT NULL,
        is_system        INTEGER NOT NULL DEFAULT 1,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, sprint_type_key, task_type)
      `;
    case 'sprint_type_task_statuses':
      return `
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id                INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        sprint_type_key          TEXT NOT NULL,
        status_key               TEXT NOT NULL,
        label                    TEXT NOT NULL,
        color                    TEXT NOT NULL DEFAULT 'slate',
        terminal                 INTEGER NOT NULL DEFAULT 0,
        is_system                INTEGER NOT NULL DEFAULT 0,
        allowed_transitions_json TEXT NOT NULL DEFAULT '[]',
        stage_order              INTEGER NOT NULL DEFAULT 0,
        is_default_entry         INTEGER NOT NULL DEFAULT 0,
        metadata_json            TEXT NOT NULL DEFAULT '{}',
        created_at               TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, sprint_type_key, status_key)
      `;
    case 'sprint_type_outcomes':
      return `
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id        INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
        sprint_type_key  TEXT NOT NULL,
        task_type        TEXT,
        outcome_key      TEXT NOT NULL,
        label            TEXT NOT NULL,
        description      TEXT NOT NULL DEFAULT '',
        enabled          INTEGER NOT NULL DEFAULT 1,
        behavior         TEXT NOT NULL DEFAULT 'base' CHECK(behavior IN ('base','extend','override','disable')),
        badge_variant    TEXT,
        stage_order      INTEGER NOT NULL DEFAULT 0,
        is_system        INTEGER NOT NULL DEFAULT 1,
        metadata_json    TEXT NOT NULL DEFAULT '{}',
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, sprint_type_key, task_type, outcome_key)
      `;
    case 'sprint_type_relationship_types':
      return `
        id                           INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id                    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        sprint_type_key              TEXT NOT NULL,
        key                          TEXT NOT NULL,
        label                        TEXT NOT NULL,
        inverse_label                TEXT NOT NULL DEFAULT '',
        category                     TEXT NOT NULL DEFAULT 'informational',
        affects_dispatch_eligibility INTEGER NOT NULL DEFAULT 0,
        direction_semantics          TEXT NOT NULL DEFAULT 'informational' CHECK(direction_semantics IN ('target_blocks_source','source_blocks_target','informational')),
        active_statuses_json         TEXT NOT NULL DEFAULT '[]',
        resolved_statuses_json       TEXT NOT NULL DEFAULT '[]',
        allow_create_related_task    INTEGER NOT NULL DEFAULT 0,
        default_related_task_type    TEXT,
        default_related_task_status  TEXT,
        is_system                    INTEGER NOT NULL DEFAULT 1,
        metadata_json                TEXT NOT NULL DEFAULT '{}',
        created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at                   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, sprint_type_key, key)
      `;
    case 'sprint_workflow_templates':
      return `
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id        INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
        sprint_type_key  TEXT NOT NULL,
        key              TEXT NOT NULL,
        name             TEXT NOT NULL,
        description      TEXT NOT NULL DEFAULT '',
        is_default       INTEGER NOT NULL DEFAULT 1,
        is_system        INTEGER NOT NULL DEFAULT 1,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, sprint_type_key, key)
      `;
    default:
      return null;
  }
}

async function migrateWorkflowConfigTable(db: Db, table: string, defaultTenantId: number): Promise<void> {
  // SQLite-only. This is a table REBUILD: create-copy-drop-rename, driven by PRAGMA
  // introspection of the existing declaration. PostgreSQL needs none of it — its schema comes
  // from db/pg-baseline, which already declares the tenant-local shape this migrates TO.
  //
  // The guard is load-bearing rather than tidy: ensureTenantSchema() runs on EVERY request, so
  // without it every request issues a PRAGMA and every route 500s.
  if (db.dialect === 'postgres') return;

  if (!await tableExists(db, table)) return;
  const definition = workflowConfigTableDefinition(table);
  if (!definition) return;
  const columns = new Set(await sharedTableColumns(db, `${table}`));
  const hasTenantId = columns.has('tenant_id');
  const hasNullTenantRows = hasTenantId
    ? ((await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id IS NULL`) as { n: number }).n > 0)
    : false;
  const tenantColumn = hasTenantId
    ? (await db.all(`PRAGMA table_info(${table})`) as Array<{ name: string; notnull: number }>).find((column) => column.name === 'tenant_id')
    : undefined;
  const needsRebuild = !hasTenantId || hasNullTenantRows || tenantColumn?.notnull !== 1;
  if (!needsRebuild) {
    return;
  }

  const oldTable = `${table}_legacy_global`;
  // Previously this restored 'OFF' instead of the prior value — a copy-paste bug that
  // disabled enforcement for the rest of the process lifetime. The pragma toggle stays
  // outside the transaction: inside one it is a no-op. The body is synchronous on the raw
  // connection so no other handler can resume inside the window — the pragma is
  // per-connection and the connection is process-wide.
  const raw = rawConnectionFor(db);
  withForeignKeysDisabled(raw, () => {
    raw.transaction(() => {
      raw.exec(`ALTER TABLE ${table} RENAME TO ${oldTable}`);
      raw.exec(`CREATE TABLE ${table} (${definition})`);
      const nextColumns = (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name).filter((column) => column !== 'id');
      const selectExpr = nextColumns.map((column) => {
        if (column === 'tenant_id') return `COALESCE(${hasTenantId ? 'legacy.tenant_id,' : ''} st.tenant_id, ?) AS tenant_id`;
        return columns.has(column) ? `legacy.${column}` : `NULL AS ${column}`;
      }).join(', ');
      raw.prepare(`
        INSERT OR IGNORE INTO ${table} (${nextColumns.join(', ')})
        SELECT ${selectExpr}
        FROM ${oldTable} legacy
        LEFT JOIN sprint_types st ON st.key = legacy.sprint_type_key
      `).run(defaultTenantId);
      raw.exec(`DROP TABLE ${oldTable}`);
    })();
  });
}

async function ensureWorkflowDefinitionConfigTenantScope(db: Db, defaultTenantId: number): Promise<void> {
  if (!await tableExists(db, 'sprint_types')) return;
  for (const table of WORKFLOW_DEFINITION_CONFIG_TABLES) {
    await migrateWorkflowConfigTable(db, table, defaultTenantId);
  }
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sprint_types_tenant_key ON sprint_types(tenant_id, key)`);
  if (await tableExists(db, 'task_field_schemas')) await db.exec(`CREATE INDEX IF NOT EXISTS idx_task_field_schemas_lookup ON task_field_schemas(tenant_id, sprint_type_key, task_type)`);
  if (await tableExists(db, 'sprint_type_task_types')) await db.exec(`CREATE INDEX IF NOT EXISTS idx_sprint_type_task_types_lookup ON sprint_type_task_types(tenant_id, sprint_type_key, task_type)`);
  if (await tableExists(db, 'sprint_type_task_statuses')) await db.exec(`CREATE INDEX IF NOT EXISTS idx_sprint_type_task_statuses_lookup ON sprint_type_task_statuses(tenant_id, sprint_type_key, status_key)`);
  if (await tableExists(db, 'sprint_type_outcomes')) await db.exec(`CREATE INDEX IF NOT EXISTS idx_sprint_type_outcomes_lookup ON sprint_type_outcomes(tenant_id, sprint_type_key, task_type, enabled, stage_order)`);
  if (await tableExists(db, 'sprint_type_relationship_types')) await db.exec(`CREATE INDEX IF NOT EXISTS idx_sprint_type_relationship_types_lookup ON sprint_type_relationship_types(tenant_id, sprint_type_key, key)`);
  if (await tableExists(db, 'sprint_workflow_templates')) await db.exec(`CREATE INDEX IF NOT EXISTS idx_sprint_workflow_templates_lookup ON sprint_workflow_templates(tenant_id, sprint_type_key, is_default)`);
}

async function copyWorkflowDefinitionConfig(db: Db, sourceKey: string, targetKey: string): Promise<void> {
  if (sourceKey === targetKey) return;

  if (await tableExists(db, 'task_field_schemas')) {
    await db.run(`
      INSERT OR IGNORE INTO task_field_schemas (sprint_type_key, task_type, schema_json, is_system, created_at, updated_at)
      SELECT ?, task_type, schema_json, is_system, datetime('now'), datetime('now')
      FROM task_field_schemas
      WHERE sprint_type_key = ?
    `, targetKey, sourceKey);
  }
  if (await tableExists(db, 'sprint_type_task_types')) {
    await db.run(`
      INSERT OR IGNORE INTO sprint_type_task_types (sprint_type_key, task_type, is_system, created_at, updated_at)
      SELECT ?, task_type, is_system, datetime('now'), datetime('now')
      FROM sprint_type_task_types
      WHERE sprint_type_key = ?
    `, targetKey, sourceKey);
  }
  if (await tableExists(db, 'sprint_type_outcomes')) {
    await db.run(`
      INSERT OR IGNORE INTO sprint_type_outcomes (
        sprint_type_key, task_type, outcome_key, label, description, enabled, behavior,
        badge_variant, stage_order, is_system, metadata_json, created_at, updated_at
      )
      SELECT ?, task_type, outcome_key, label, description, enabled, behavior,
        badge_variant, stage_order, is_system, metadata_json, datetime('now'), datetime('now')
      FROM sprint_type_outcomes
      WHERE sprint_type_key = ?
    `, targetKey, sourceKey);
  }
  if (await tableExists(db, 'sprint_type_relationship_types')) {
    await db.run(`
      INSERT OR IGNORE INTO sprint_type_relationship_types (
        sprint_type_key, key, label, inverse_label, category, affects_dispatch_eligibility,
        direction_semantics, active_statuses_json, resolved_statuses_json,
        allow_create_related_task, default_related_task_type, default_related_task_status,
        is_system, metadata_json, created_at, updated_at
      )
      SELECT ?, key, label, inverse_label, category, affects_dispatch_eligibility,
        direction_semantics, active_statuses_json, resolved_statuses_json,
        allow_create_related_task, default_related_task_type, default_related_task_status,
        is_system, metadata_json, datetime('now'), datetime('now')
      FROM sprint_type_relationship_types
      WHERE sprint_type_key = ?
    `, targetKey, sourceKey);
  }
  if (await tableExists(db, 'sprint_type_task_statuses')) {
    await db.run(`
      INSERT OR IGNORE INTO sprint_type_task_statuses (
        sprint_type_key, status_key, label, color, terminal, is_system,
        allowed_transitions_json, stage_order, is_default_entry, metadata_json,
        created_at, updated_at
      )
      SELECT ?, status_key, label, color, terminal, is_system,
        allowed_transitions_json, stage_order, is_default_entry, metadata_json,
        datetime('now'), datetime('now')
      FROM sprint_type_task_statuses
      WHERE sprint_type_key = ?
    `, targetKey, sourceKey);
  }
  if (await tableExists(db, 'sprint_workflow_templates')) {
    const templates = await db.all(`
      SELECT id, key, name, description, is_default, is_system
      FROM sprint_workflow_templates
      WHERE sprint_type_key = ?
      ORDER BY id ASC
    `, sourceKey) as Array<{ id: number; key: string; name: string; description: string; is_default: number; is_system: number }>;
    for (const template of templates) {
      const result = await db.run(`
        INSERT OR IGNORE INTO sprint_workflow_templates (sprint_type_key, key, name, description, is_default, is_system, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `, targetKey, template.key, template.name, template.description, template.is_default, template.is_system);
      const targetTemplate = await db.get(`
        SELECT id FROM sprint_workflow_templates WHERE sprint_type_key = ? AND key = ? LIMIT 1
      `, targetKey, template.key) as { id: number } | undefined;
      if (!targetTemplate) continue;
      if (await tableExists(db, 'sprint_workflow_statuses')) {
        await db.run(`
          INSERT OR IGNORE INTO sprint_workflow_statuses (
            template_id, status_key, label, color, stage_order, terminal,
            is_default_entry, metadata_json, created_at, updated_at
          )
          SELECT ?, status_key, label, color, stage_order, terminal,
            is_default_entry, metadata_json, datetime('now'), datetime('now')
          FROM sprint_workflow_statuses
          WHERE template_id = ?
        `, targetTemplate.id, template.id);
      }
      if (await tableExists(db, 'sprint_workflow_transitions')) {
        await db.run(`
          INSERT OR IGNORE INTO sprint_workflow_transitions (
            template_id, from_status_key, to_status_key, transition_key, label,
            outcome, stage_order, is_system, metadata_json, created_at, updated_at
          )
          SELECT ?, from_status_key, to_status_key, transition_key, label,
            outcome, stage_order, is_system, metadata_json, datetime('now'), datetime('now')
          FROM sprint_workflow_transitions
          WHERE template_id = ?
        `, targetTemplate.id, template.id);
      }
      void result;
    }
  }
}

async function rewriteWorkflowDefinitionReferences(db: Db, tenantId: number, fromKey: string, toKey: string): Promise<void> {
  if (fromKey === toKey) return;
  const scopedTables = [
    'sprints',
    'sprint_task_transitions',
    'sprint_task_transition_requirements',
    'sprint_task_routing_rules',
    'story_point_model_routing',
  ];
  for (const table of scopedTables) {
    if (!await tableExists(db, table) || !await tableHasColumn(db, table, 'sprint_type')) continue;
    if (await tableHasColumn(db, table, 'tenant_id')) {
      await db.run(`UPDATE ${table} SET sprint_type = ? WHERE tenant_id = ? AND sprint_type = ?`, toKey, tenantId, fromKey);
      continue;
    }
    if (await tableHasColumn(db, table, 'project_id') && await tableExists(db, 'projects')) {
      await db.run(`
        UPDATE ${table}
        SET sprint_type = ?
        WHERE sprint_type = ?
          AND project_id IN (SELECT id FROM projects WHERE tenant_id = ?)
      `, toKey, fromKey, tenantId);
    }
  }
}

async function createWorkflowDefinitionCopy(db: Db, sourceKey: string, targetKey: string, tenantId: number): Promise<void> {
  const source = await db.get(`SELECT key, name, description, is_system FROM sprint_types WHERE key = ? ORDER BY tenant_id IS NOT NULL ASC LIMIT 1`, sourceKey) as { key: string; name: string; description: string; is_system: number } | undefined;
  if (!source) return;
  await db.run(`
    INSERT OR IGNORE INTO sprint_types (tenant_id, key, name, description, is_system, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `, tenantId, targetKey, source.name, source.description, source.is_system);
  await copyWorkflowDefinitionConfig(db, sourceKey, targetKey);
}

async function ensureTenantDefaultWorkflowDefinitions(db: Db, tenantId: number): Promise<void> {
  if (!await tableExists(db, 'sprint_types') || !await tableHasColumn(db, 'sprint_types', 'tenant_id')) return;
  for (const starter of STARTER_SPRINT_TYPE_SEEDS) {
    await seedSprintTypeTaskStatuses(db, starter.key, { tenantId });
  }
  await pruneUnexpectedStarterWorkflowRelationshipTypes(db, { tenantId });

  const seededMarkerKey = `tenant_workflow_defaults_seeded:${tenantId}`;
  if (await getSetting(db, seededMarkerKey) === '1') return;

  for (const starter of STARTER_SPRINT_TYPE_SEEDS) {
    const baseKey = starter.key;
    const owned = await db.get(`
      SELECT key
      FROM sprint_types
      WHERE tenant_id = ?
        AND key = ?
      LIMIT 1
    `, tenantId, baseKey) as { key: string } | undefined;
    if (owned) continue;
    const targetKey = baseKey;
    const source = await db.get(`SELECT key FROM sprint_types WHERE key = ? ORDER BY tenant_id IS NOT NULL ASC LIMIT 1`, baseKey) as { key: string } | undefined;
    if (source) {
      await createWorkflowDefinitionCopy(db, baseKey, targetKey, tenantId);
    } else {
      await db.run(`
        INSERT INTO sprint_types (tenant_id, key, name, description, is_system, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))
      `, tenantId, targetKey, starter.name, starter.description);
    }
  }
  await seedStarterWorkflowRelationshipTypes(db, { tenantId });
  await setSetting(db, seededMarkerKey, '1');
}

async function backfillWorkflowDefinitionOwnership(db: Db, defaultTenantId: number): Promise<void> {
  if (!await tableExists(db, 'sprint_types') || !await tableHasColumn(db, 'sprint_types', 'tenant_id')) return;
  const nullOwned = await db.all(`SELECT key FROM sprint_types WHERE tenant_id IS NULL ORDER BY key ASC`) as Array<{ key: string }>;
  const tenantRefsSql = await tableExists(db, 'sprints') && await tableHasColumn(db, 'sprints', 'tenant_id')
    ? `SELECT DISTINCT tenant_id FROM sprints WHERE sprint_type = ? AND tenant_id IS NOT NULL ORDER BY tenant_id ASC`
    : null;
  await db.withTransaction(async (db) => {
    for (const row of nullOwned) {
      const tenantRefs = tenantRefsSql
        ? (await db.all(tenantRefsSql, row.key) as Array<{ tenant_id: number }>).map((entry) => entry.tenant_id)
        : [];
      const ownerTenantId = tenantRefs[0] ?? defaultTenantId;
      await db.run(`UPDATE sprint_types SET tenant_id = ?, updated_at = datetime('now') WHERE key = ? AND tenant_id IS NULL`, ownerTenantId, row.key);
      for (const tenantId of tenantRefs.slice(1)) {
        const copiedKey = row.key;
        await createWorkflowDefinitionCopy(db, row.key, copiedKey, tenantId);
        await rewriteWorkflowDefinitionReferences(db, tenantId, row.key, copiedKey);
      }
    }
    const tenants = await db.all(`SELECT id FROM tenants ORDER BY id ASC`) as Array<{ id: number }>;
    for (const tenant of tenants) {
      await ensureTenantDefaultWorkflowDefinitions(db, tenant.id);
    }
  });
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

  const deletedFilter = await tableHasColumn(db, 'agents', 'deleted_at') ? 'AND deleted_at IS NULL' : '';
  const existing = await db.get(`
    SELECT id
    FROM agents
    WHERE tenant_id = ?
      AND (
        system_role = ?
        OR session_key = ?
        OR openclaw_agent_id = ?
        OR lower(name) = lower(?)
      )
      ${deletedFilter}
    ORDER BY CASE WHEN system_role = ? THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `, tenantId, ATLAS_SYSTEM_ROLE, sessionKey, runtimeSlug, ATLAS_AGENT_NAME, ATLAS_SYSTEM_ROLE) as { id: number } | undefined;

  if (existing) {
    const hasJobInstructions = await tableHasColumn(db, 'agents', 'job_instructions');
    await db.run(`
      UPDATE agents
      SET project_id = COALESCE(project_id, ?),
          role = CASE WHEN role IS NULL OR trim(role) = '' THEN ? ELSE role END,
          job_title = CASE WHEN job_title IS NULL OR trim(job_title) = '' THEN ? ELSE job_title END,
          system_role = COALESCE(system_role, ?),
          runtime_type = COALESCE(runtime_type, 'openclaw'),
          openclaw_agent_id = CASE WHEN openclaw_agent_id IS NULL OR trim(openclaw_agent_id) = '' THEN ? ELSE openclaw_agent_id END,
          workspace_path = CASE WHEN workspace_path IS NULL OR trim(workspace_path) = '' THEN ? ELSE workspace_path END,
          ${hasJobInstructions ? `job_instructions = CASE WHEN job_instructions IS NULL OR trim(job_instructions) = '' THEN ? ELSE job_instructions END,` : ''}
          last_active = datetime('now')
      WHERE id = ?
    `, ...(hasJobInstructions
              ? [projectId, TENANT_ATLAS_ROLE, TENANT_ATLAS_ROLE, ATLAS_SYSTEM_ROLE, runtimeSlug, workspacePath, TENANT_ATLAS_JOB_INSTRUCTIONS, existing.id]
              : [projectId, TENANT_ATLAS_ROLE, TENANT_ATLAS_ROLE, ATLAS_SYSTEM_ROLE, runtimeSlug, workspacePath, existing.id]));
    return existing.id;
  }

  const columns = [
    'tenant_id', 'project_id', 'name', 'role', 'job_title', 'session_key', 'workspace_path', 'status',
    'openclaw_agent_id', 'runtime_type', 'runtime_config', 'preferred_provider', 'model',
    'system_role', 'enabled', 'timeout_seconds', 'skill_names', 'sort_rules',
  ];
  const values: unknown[] = [
    tenantId,
    projectId,
    ATLAS_AGENT_NAME,
    TENANT_ATLAS_ROLE,
    TENANT_ATLAS_ROLE,
    sessionKey,
    workspacePath,
    'idle',
    runtimeSlug,
    'openclaw',
    null,
    'anthropic',
    null,
    ATLAS_SYSTEM_ROLE,
    1,
    900,
    '[]',
    '[]',
  ];
  if (await tableHasColumn(db, 'agents', 'job_instructions')) {
    columns.push('job_instructions');
    values.push(TENANT_ATLAS_JOB_INSTRUCTIONS);
  }
  const placeholders = columns.map(() => '?').join(', ');
  const result = await db.run(`
    INSERT INTO agents (${columns.join(', ')})
    VALUES (${placeholders})
  `, ...values);
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
  if (!await tableExists(db, 'tools')) return;
  const insertToolSql = `
    INSERT OR IGNORE INTO tools (
      tenant_id, name, slug, description, implementation_type, implementation_body,
      input_schema, permissions, tags, enabled
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
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
  if (!await tableExists(db, 'tools') || !await tableExists(db, 'agent_tool_assignments')) return;
  const insertAssignmentSql = `
    INSERT OR IGNORE INTO agent_tool_assignments (agent_id, tool_id, overrides, enabled)
    SELECT ?, id, '{}', 1
    FROM tools
    WHERE tenant_id = (SELECT tenant_id FROM agents WHERE id = ?)
      AND slug = ?
      AND enabled = 1
  `;
  for (const slug of toolSlugs) await db.run(insertAssignmentSql, agentId, agentId, slug);
}

export async function ensureTenantAgentHqMcpServer(db: Db, tenantId: number): Promise<number | null> {
  if (!await tableExists(db, 'mcp_servers') || !await tableHasColumn(db, 'mcp_servers', 'tenant_id')) return null;
  const existing = await db.get(`
    SELECT id
    FROM mcp_servers
    WHERE tenant_id = ? AND slug = ?
    LIMIT 1
  `, tenantId, AGENT_HQ_MCP_SERVER_SLUG) as { id: number } | undefined;

  if (existing) {
    return existing.id;
  }

  const serverEntryScript = path.join(path.resolve(__dirname, '../..'), 'dist', 'mcp', 'server.js');
  const nodeExecutable = path.join(NODE_BIN_DIR, 'node');
  const args = JSON.stringify([serverEntryScript]);
  // Resolved from the environment, never hardcoded. This value is stored on the mcp_servers row
  // and ends up in the MCP bundle every dispatched agent loads, so it decides which Agent HQ API
  // the agent reports back to. A literal 3501 meant any non-production instance handed its agents
  // PRODUCTION's address: the PostgreSQL test instance on 3531 dispatched runs whose agents then
  // asked production about instance ids that existed only in the test database. Production
  // refused those writes correctly, but the required tool never appeared, the runs died at MCP
  // readiness, and each attempt still left a refusal audit row on a production task.
  const env = JSON.stringify({
    AGENT_HQ_API_URL: getAgentHqBaseUrl(`http://127.0.0.1:${process.env.PORT ?? 3501}`),
  });
  const cwd = path.resolve(__dirname, '../..');

  const inserted = await db.run(`
    INSERT INTO mcp_servers (tenant_id, name, slug, description, transport, command, args, env, cwd, enabled)
    VALUES (?, ?, ?, ?, 'stdio', ?, ?, ?, ?, 1)
  `, tenantId, 'Agent HQ MCP Server', AGENT_HQ_MCP_SERVER_SLUG, 'Tenant-local stdio MCP server exposing Agent HQ projects, sprints, tasks, and agents.', nodeExecutable, args, env, cwd);
  return Number(inserted.lastInsertId);
}

export async function repairAgentMcpAssignmentsForTenant(db: Db, tenantId: number, agentId: number): Promise<void> {
  if (!await tableExists(db, 'mcp_servers') || !await tableExists(db, 'agent_mcp_assignments')) return;
  if (!await tableHasColumn(db, 'mcp_servers', 'tenant_id')) return;
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

async function repairTenantAgentHqMcpServersAndAssignments(db: Db): Promise<void> {
  if (!await tableExists(db, 'tenants') || !await tableExists(db, 'agents') || !await tableExists(db, 'mcp_servers') || !await tableExists(db, 'agent_mcp_assignments')) return;
  if (!await tableHasColumn(db, 'agents', 'tenant_id') || !await tableHasColumn(db, 'mcp_servers', 'tenant_id')) return;

  const tenantIds = await db.all(`SELECT id FROM tenants ORDER BY id ASC`) as Array<{ id: number }>;
  for (const tenant of tenantIds) {
    await ensureTenantAgentHqMcpServer(db, tenant.id);
  }

  const staleAssignments = await db.all(`
    SELECT
      ama.id AS assignment_id,
      ama.agent_id,
      a.tenant_id AS agent_tenant_id,
      COALESCE(ama.overrides, '{}') AS overrides,
      COALESCE(ama.enabled, 1) AS enabled
    FROM agent_mcp_assignments ama
    JOIN agents a ON a.id = ama.agent_id
    JOIN mcp_servers s ON s.id = ama.mcp_server_id
    WHERE s.slug = ?
      AND s.tenant_id != a.tenant_id
    ORDER BY ama.id ASC
  `, AGENT_HQ_MCP_SERVER_SLUG) as Array<{
    assignment_id: number;
    agent_id: number;
    agent_tenant_id: number;
    overrides: string;
    enabled: number;
  }>;
  if (staleAssignments.length === 0) return;

  const findLocalSql = `
    SELECT id, enabled
    FROM agent_mcp_assignments
    WHERE agent_id = ? AND mcp_server_id = ?
    ORDER BY id ASC
    LIMIT 1
  `;
  const insertLocalSql = `
    INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id, overrides, enabled)
    VALUES (?, ?, ?, ?)
  `;
  const enableLocalSql = `
    UPDATE agent_mcp_assignments
    SET overrides = ?, enabled = 1
    WHERE id = ?
  `;
  const deleteStaleSql = `DELETE FROM agent_mcp_assignments WHERE id = ?`;
  const localServerByTenant = new Map<number, number>();

  for (const assignment of staleAssignments) {
    let localServerId = localServerByTenant.get(assignment.agent_tenant_id);
    if (!localServerId) {
      const ensuredLocalServerId = await ensureTenantAgentHqMcpServer(db, assignment.agent_tenant_id);
      if (!ensuredLocalServerId) continue;
      localServerId = ensuredLocalServerId;
      localServerByTenant.set(assignment.agent_tenant_id, localServerId);
    }
    const existingLocal = await db.get(findLocalSql, assignment.agent_id, localServerId) as { id: number; enabled: number } | undefined;
    if (existingLocal) {
      if (assignment.enabled === 1 && existingLocal.enabled !== 1) {
        await db.run(enableLocalSql, assignment.overrides, existingLocal.id);
      }
    } else {
      await db.run(insertLocalSql, assignment.agent_id, localServerId, assignment.overrides, assignment.enabled);
    }
    await db.run(deleteStaleSql, assignment.assignment_id);
  }
}

async function ensureStarterAgentMcpAssignments(
  db: Db,
  tenantId: number,
  agentId: number,
  mcpServerSlugs: readonly string[],
): Promise<void> {
  if (!await tableExists(db, 'mcp_servers') || !await tableExists(db, 'agent_mcp_assignments')) return;
  await repairAgentMcpAssignmentsForTenant(db, tenantId, agentId);
  if (mcpServerSlugs.includes(AGENT_HQ_MCP_SERVER_SLUG)) {
    await ensureTenantAgentHqMcpServer(db, tenantId);
  }
  const mcpServersAreTenantScoped = await tableHasColumn(db, 'mcp_servers', 'tenant_id');
  const insertAssignmentSql = `
    INSERT OR IGNORE INTO agent_mcp_assignments (agent_id, mcp_server_id, overrides, enabled)
    SELECT ?, id, '{}', 1
    FROM mcp_servers
    WHERE slug = ?
      AND enabled = 1
      AND (${mcpServersAreTenantScoped ? 'tenant_id = ?' : '1 = 1'})
  `;
  for (const slug of mcpServerSlugs) {
    if (mcpServersAreTenantScoped) await db.run(insertAssignmentSql, agentId, slug, tenantId);
    else await db.run(insertAssignmentSql, agentId, slug);
  }
}

async function replaceStarterAgentMcpPermissionPolicy(
  db: Db,
  agentId: number,
  enabledCapabilityKeys: readonly string[],
): Promise<void> {
  await db.exec(`
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
  const hasJobInstructions = await tableHasColumn(db, 'agents', 'job_instructions');
  const hasEnabled = await tableHasColumn(db, 'agents', 'enabled');
  const hasSkillNames = await tableHasColumn(db, 'agents', 'skill_names');
  const hasSortRules = await tableHasColumn(db, 'agents', 'sort_rules');
  const hasTimeoutSeconds = await tableHasColumn(db, 'agents', 'timeout_seconds');
  const deletedFilter = await tableHasColumn(db, 'agents', 'deleted_at') ? 'AND deleted_at IS NULL' : '';

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
        AND (
          system_role = ?
          OR session_key = ?
          OR lower(name) = lower(?)
        )
        ${deletedFilter}
      ORDER BY CASE WHEN system_role = ? THEN 0 ELSE 1 END, id ASC
      LIMIT 1
    `, tenantId, definition.systemRole, sessionKey, definition.name, definition.systemRole) as { id: number } | undefined;

    if (existing) {
      const setParts = [
        'project_id = ?',
        'name = CASE WHEN system_role = ? THEN name ELSE ? END',
        'role = ?',
        'job_title = ?',
        'session_key = ?',
        'runtime_type = ?',
        'runtime_config = ?',
        'preferred_provider = ?',
        'model = ?',
        'system_role = ?',
        "openclaw_agent_id = CASE WHEN openclaw_agent_id IS NULL OR trim(openclaw_agent_id) = '' THEN ? ELSE openclaw_agent_id END",
        "workspace_path = CASE WHEN workspace_path IS NULL OR trim(workspace_path) = '' THEN ? ELSE workspace_path END",
      ];
      const params: unknown[] = [
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
      ];
      if (hasEnabled) {
        setParts.push('enabled = 0');
      }
      if (hasJobInstructions) {
        setParts.push('job_instructions = ?');
        params.push(definition.role);
      }
      if (hasSkillNames) {
        setParts.push('skill_names = ?');
        params.push(JSON.stringify(definition.skillNames));
      }
      params.push(existing.id);
      await db.run(`
        UPDATE agents
        SET ${setParts.join(', ')}
        WHERE id = ?
      `, ...params);
      await replaceStarterAgentMcpPermissionPolicy(db, existing.id, definition.mcpCapabilities);
      await ensureStarterAgentToolAssignments(db, existing.id, definition.toolSlugs);
      await ensureStarterAgentMcpAssignments(db, tenantId, existing.id, definition.mcpServerSlugs);
      agentIds.push(existing.id);
      continue;
    }

    const columns = [
      'tenant_id', 'project_id', 'name', 'role', 'job_title', 'session_key', 'workspace_path', 'status',
      'openclaw_agent_id', 'runtime_type', 'runtime_config', 'preferred_provider', 'model', 'system_role',
    ];
    const values: unknown[] = [
      tenantId,
      projectId,
      definition.name,
      definition.role,
      definition.jobTitle,
      sessionKey,
      workspacePath,
      'idle',
      openclawAgentId,
      definition.modelPolicy.runtime_type,
      JSON.stringify(runtimeConfig),
      definition.modelPolicy.preferred_provider,
      definition.modelPolicy.model,
      definition.systemRole,
    ];
    if (hasEnabled) {
      columns.push('enabled');
      values.push(0);
    }
    if (hasTimeoutSeconds) {
      columns.push('timeout_seconds');
      values.push(900);
    }
    if (hasSkillNames) {
      columns.push('skill_names');
      values.push(JSON.stringify(definition.skillNames));
    }
    if (hasSortRules) {
      columns.push('sort_rules');
      values.push(JSON.stringify(definition.taskTypes));
    }
    if (hasJobInstructions) {
      columns.push('job_instructions');
      values.push(definition.role);
    }
    const placeholders = columns.map(() => '?').join(', ');
    const result = await db.run(`
      INSERT INTO agents (${columns.join(', ')})
      VALUES (${placeholders})
    `, ...values);
    const agentId = Number(result.lastInsertId);
    await replaceStarterAgentMcpPermissionPolicy(db, agentId, definition.mcpCapabilities);
    await ensureStarterAgentToolAssignments(db, agentId, definition.toolSlugs);
    await ensureStarterAgentMcpAssignments(db, tenantId, agentId, definition.mcpServerSlugs);
    agentIds.push(agentId);
  }

  return agentIds;
}

async function repairProvisionedTenantOwnership(db: Db, tenantId: number, projectId: number, agentId: number): Promise<void> {
  for (const table of [
    'sprint_task_routing_rules',
    'sprint_task_transitions',
    'sprint_task_transition_requirements',
    'story_point_model_routing',
    'external_event_mappings',
  ]) {
    if (!await tableHasColumn(db, table, 'tenant_id')) continue;
    if (await tableHasColumn(db, table, 'project_id')) {
      await db.run(`UPDATE ${table} SET tenant_id = ? WHERE tenant_id IS NULL AND project_id = ?`, tenantId, projectId);
    }
    if (await tableHasColumn(db, table, 'agent_id')) {
      await db.run(`UPDATE ${table} SET tenant_id = ? WHERE tenant_id IS NULL AND agent_id = ?`, tenantId, agentId);
    }
  }
}

async function provisionTenantDefaultWorkspace(db: Db, tenantId: number, options: { seedWorkflowEvents?: boolean } = {}): Promise<void> {
  const seedWorkflowEvents = options.seedWorkflowEvents !== false;
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
  await ensureTenantDefaultWorkflowDefinitions(db, tenantId);
  await ensureProjectBacklogSprint(db, projectId);
  const agentId = await ensureTenantDefaultAtlasAgent(db, tenantId, projectId);
  await ensureStarterAgentMcpAssignments(db, tenantId, agentId, [AGENT_HQ_MCP_SERVER_SLUG]);
  // Routing for these agents is declared in defaultInstallPackage.ensureRouting,
  // which ran above and already points at these same rows (ensureTenantStarterAgents
  // matches the install package's agents by name and updates them in place). Nothing
  // infers routing from agent job titles — declared seeds are the only source.
  const starterAgentIds = await ensureTenantStarterAgents(db, tenantId, projectId, tenantSlug);
  await repairProvisionedTenantOwnership(db, tenantId, projectId, agentId);
  for (const starterAgentId of starterAgentIds) {
    await repairProvisionedTenantOwnership(db, tenantId, projectId, starterAgentId);
  }
  if (seedWorkflowEvents) {
    await seedTenantDefaultWorkflowEventMappings(db, tenantId);
  }
}

async function canProvisionTenantDefaultWorkspace(db: Db): Promise<boolean> {
  return await tableExists(db, 'projects')
    && await tableExists(db, 'agents')
    // applyDefaultInstallPackage provisions skills, workflow types, statuses,
    // routing, and field schemas — all of these must exist before it can run.
    && await tableExists(db, 'skills')
    && await tableExists(db, 'sprints')
    && await tableExists(db, 'sprint_types')
    && await tableExists(db, 'sprint_type_task_types')
    && await tableExists(db, 'sprint_type_outcomes')
    && await tableExists(db, 'sprint_task_transitions')
    && await tableExists(db, 'sprint_task_routing_rules')
    && await tableExists(db, 'task_field_schemas')
    && await tableExists(db, 'story_point_model_routing')
    && await tableHasColumn(db, 'projects', 'tenant_id')
    && await tableHasColumn(db, 'projects', 'description')
    && await tableHasColumn(db, 'projects', 'context_md')
    && await tableHasColumn(db, 'agents', 'project_id')
    && await tableHasColumn(db, 'agents', 'system_role')
    && await tableHasColumn(db, 'agents', 'runtime_type')
    && await tableHasColumn(db, 'agents', 'runtime_config')
    && await tableHasColumn(db, 'agents', 'preferred_provider')
    && await tableHasColumn(db, 'agents', 'model')
    && await tableHasColumn(db, 'agents', 'job_title');
}

export async function repairTenantOwnershipForMigration(db: Db): Promise<number> {
  verifiedTenantSchemaDbs.delete(db);
  if (ensuredTenantSchemaDbs.has(db)) {
    const rawDefaultTenantId = await getSetting(db, DEFAULT_TENANT_SETTING_KEY);
    const defaultTenantId = rawDefaultTenantId ? Number(rawDefaultTenantId) : NaN;
    const defaultTenant = Number.isInteger(defaultTenantId) && defaultTenantId > 0
      ? await db.get(`SELECT id FROM tenants WHERE id = ? LIMIT 1`, defaultTenantId)
      : null;
    if (defaultTenant) {
      await ensureTenantOwnedTableColumns(db, defaultTenantId);
      await ensureMcpServersTenantLocalSlugSchema(db, defaultTenantId);
      await backfillDefaultTenantForNullTenantRows(db, defaultTenantId);
      await rebuildSprintTypesForTenantLocalKeys(db, defaultTenantId);
      await ensureWorkflowDefinitionConfigTenantScope(db, defaultTenantId);
      await backfillWorkflowDefinitionOwnership(db, defaultTenantId);
      await repairTenantAgentHqMcpServersAndAssignments(db);
      assertForeignKeysStillEnforced(db);
      return defaultTenantId;
    }
    ensuredTenantSchemaDbs.delete(db);
  }

  await ensureAppSettingsTable(db);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      slug       TEXT NOT NULL UNIQUE,
      is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_single_default ON tenants(is_default) WHERE is_default = 1;
  `);

  let defaultTenant = await db.get(`SELECT id FROM tenants WHERE is_default = 1 ORDER BY id ASC LIMIT 1`) as { id: number } | undefined;
  let createdDefaultTenant = false;
  if (!defaultTenant) {
    const existing = await db.get(`SELECT id FROM tenants WHERE slug = ? LIMIT 1`, DEFAULT_TENANT_SLUG) as { id: number } | undefined;
    if (existing) {
      await db.run(`UPDATE tenants SET is_default = 1, updated_at = datetime('now') WHERE id = ?`, existing.id);
      defaultTenant = existing;
    } else {
      const result = await db.run(`
        INSERT INTO tenants (name, slug, is_default)
        VALUES (?, ?, 1)
      `, DEFAULT_TENANT_NAME, DEFAULT_TENANT_SLUG);
      defaultTenant = { id: Number(result.lastInsertId) };
      createdDefaultTenant = true;
    }
  }
  await db.run(`
    UPDATE tenants
    SET name = ?, updated_at = datetime('now')
    WHERE id = ?
      AND slug = ?
      AND is_default = 1
      AND name = ?
  `, DEFAULT_TENANT_NAME, defaultTenant.id, DEFAULT_TENANT_SLUG, LEGACY_DEFAULT_TENANT_NAME);

  await setSetting(db, DEFAULT_TENANT_SETTING_KEY, String(defaultTenant.id));
  if (!await getSetting(db, ACTIVE_TENANT_SETTING_KEY)) {
    await setSetting(db, ACTIVE_TENANT_SETTING_KEY, String(defaultTenant.id));
  }

  await ensureTenantOwnedTableColumns(db, defaultTenant.id);
  await ensureMcpServersTenantLocalSlugSchema(db, defaultTenant.id);
  await backfillOperationalTenantOwnership(db);

  await rebuildSprintTypesForTenantLocalKeys(db, defaultTenant.id);
  await ensureWorkflowDefinitionConfigTenantScope(db, defaultTenant.id);
  await backfillWorkflowDefinitionOwnership(db, defaultTenant.id);
  await repairTenantAgentHqMcpServersAndAssignments(db);
  if (createdDefaultTenant && await canProvisionTenantDefaultWorkspace(db)) {
    await provisionTenantDefaultWorkspace(db, defaultTenant.id, { seedWorkflowEvents: false });
  }

  ensuredTenantSchemaDbs.add(db);
  verifiedTenantSchemaDbs.delete(db);
  assertForeignKeysStillEnforced(db);
  return defaultTenant.id;
}

export async function ensureTenantSchema(db: Db): Promise<number> {
  return await repairTenantOwnershipForMigration(db);
}

export async function getDefaultTenantId(db: Db): Promise<number> {
  return await ensureTenantSchema(db);
}

export async function getActiveTenantId(db: Db): Promise<number> {
  const defaultTenantId = await ensureTenantSchema(db);
  const raw = await getSetting(db, ACTIVE_TENANT_SETTING_KEY);
  const id = raw ? Number(raw) : defaultTenantId;
  const tenant = Number.isInteger(id) && id > 0
    ? await db.get(`SELECT id FROM tenants WHERE id = ? LIMIT 1`, id)
    : null;
  return tenant ? id : defaultTenantId;
}

export async function setActiveTenantId(db: Db, tenantId: number): Promise<TenantRecord> {
  await ensureTenantSchema(db);
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
  await ensureTenantSchema(db);
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
  await repairTenantOwnershipForMigration(db);
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
  await ensureTenantSchema(db);
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
      'sprint_task_statuses',
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
