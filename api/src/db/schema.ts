import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'fs';
// schema.ts is the SQLite schema-migration engine: it reads PRAGMA table_info, toggles
// PRAGMA foreign_keys around table rebuilds, and performs SQLite's create-copy-drop-rename
// dance. None of that is expressible through the Db interface — deliberately, since none
// of it has a PostgreSQL equivalent. It therefore holds the raw driver. This whole module
// is replaced by the generated Postgres baseline and deleted by task #766.
import { getRawDb } from './client';
import { NODE_BIN_DIR } from '../config';
import { RELEASE_TASK_STATUSES, taskStatusesSqlList } from '../lib/taskStatuses';
import { extractTokenUsage } from '../domains/runs/tokenUsage';
import os from 'os';
import path from 'path';
import {
  ATLAS_AGENT_NAME,
  ATLAS_AGENT_SLUG,
  ATLAS_SESSION_KEY,
  ATLAS_SYSTEM_ROLE,
  ATLAS_TELEGRAM_PREFIX,
  ATLAS_WORKSPACE_PATH,
  LEGACY_ATLAS_SESSION_KEY,
  LEGACY_ATLAS_TELEGRAM_PREFIX,
  LEGACY_MAIN_WORKSPACE_PATH,
  getAtlasAgentRecord,
} from '../lib/atlasAgent';
import {
  buildCanonicalAgentMainSessionKey,
  normalizeAgentRoleLabel,
  resolveRuntimeAgentSlug,
  slugifySessionKeyPart,
} from '../lib/sessionKeys';
import { hasRepoConfig, normalizeRepoConfig } from '../lib/repoConfig';
import { ensureDefaultProjectId } from '../lib/defaultProject';
import {
  STARTER_FIELD_SCHEMA_SEEDS,
  INLINE_EVIDENCE_FIELD_KEYS,
  STARTER_SPRINT_OUTCOME_SEEDS,
  STARTER_SPRINT_TYPE_SEEDS,
  STARTER_SPRINT_TYPE_TASK_TYPE_SEEDS,
} from '../lib/starterCatalog';
import { pruneUnexpectedStarterWorkflowRelationshipTypes, seedStarterWorkflowRelationshipTypes } from '../lib/taskRelationshipTypes';
import { normalizeSprintTaskRoutingRuleTaskTypes } from '../domains/routing/policy/backfill';
import { seedSprintTypeTaskStatuses } from '../domains/routing/policy/seed';
import { ensureMcpApiKeyTable } from '../lib/mcpApiAuth';
import { ensureTenantSchema, verifyTenantSchemaForStartup } from '../lib/tenantContext';
import { beginIntentionalForeignKeyDisable, endIntentionalForeignKeyDisable, withForeignKeysDisabled } from './foreignKeyGuard';
import { tableHasColumn } from '../lib/durableRunIdentity';
import { syncAllTaskActiveAgentsFromInstances } from '../domains/tasks/ownership';
import { ensureNotificationTables } from '../lib/notifications';
import { SqliteAdapter } from "./adapter/SqliteAdapter";
import { type Db } from "./adapter/types";
// Aliased: this module already has its own tableExists() over the raw better-sqlite3 handle.
import { tableExists as dbTableExists } from "./introspection";

const HOME = process.env.HOME ?? os.homedir();
const OPENCLAW_DIR = process.env.WORKSPACE_PARENT ?? `${HOME}/.openclaw`;
const ATLAS_MIGRATION_SETTING_KEY = 'migration.task25.atlas_cutover.completed';
const LEGACY_TASK_EVIDENCE_COLUMNS = [...INLINE_EVIDENCE_FIELD_KEYS, 'evidence_json'] as const;
let activeTenantMode: 'repair' | 'verify' = 'repair';

const TASKS_STATUS_CHECK_RE = /\s+CHECK\s*\(\s*status\s+IN\s*\([^)]*\)\s*\)/i;

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`).get(table) as { name?: string } | undefined)?.name);
}

async function ensureTableColumn(db: Database.Database, table: string, column: string, ddl: string): Promise<void> {
  if (await tableHasColumn(new SqliteAdapter(db), table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  console.log(`[schema] Migrated: added ${table}.${column}`);
}

function ensureTasksRequireWorkflow(db: Database.Database): void {
  if (!tableExists(db, 'tasks')) return;

  const taskColumns = (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string; notnull: number }>).map((col) => col.name);
  if (!taskColumns.includes('sprint_id')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN sprint_id INTEGER REFERENCES sprints(id) ON DELETE SET NULL`);
    console.log('[schema] Migrated: added sprint_id to tasks');
  }

  const orphaned = db.prepare(`
    DELETE FROM tasks
    WHERE sprint_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM sprints WHERE sprints.id = tasks.sprint_id)
  `).run();
  if (orphaned.changes > 0) {
    console.log(`[schema] Task #855: removed ${orphaned.changes} task(s) without a valid workflow`);
  }

  const columns = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string; notnull: number }>;
  const sprintColumn = columns.find((col) => col.name === 'sprint_id');
  const sprintFk = (db.prepare(`PRAGMA foreign_key_list(tasks)`).all() as Array<{ from: string; table: string; on_delete: string }>)
    .find((fk) => fk.from === 'sprint_id' && fk.table === 'sprints');
  const alreadyRequired = sprintColumn?.notnull === 1 && sprintFk?.on_delete?.toUpperCase() === 'CASCADE';
  if (alreadyRequired) return;

  const tasksDdl = (db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`
  ).get() as { sql: string } | undefined)?.sql ?? '';
  if (!tasksDdl) return;

  const colList = columns.map((col) => col.name).join(', ');
  const rebuiltDdl = tasksDdl
    .replace(/CREATE TABLE\s+"?tasks"?/, 'CREATE TABLE tasks_workflow_required')
    .replace(
      /^(\s*"?sprint_id"?\s+)[^,\n]*(,?)/mi,
      '$1INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE$2',
    );
  if (rebuiltDdl === tasksDdl || !rebuiltDdl.includes('tasks_workflow_required')) {
    throw new Error('Unable to rebuild tasks.sprint_id workflow constraint');
  }

  const indexSql = (db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'index'
      AND tbl_name = 'tasks'
      AND sql IS NOT NULL
    ORDER BY name
  `).all() as Array<{ sql: string }>).map((row) => row.sql);

  db.pragma('foreign_keys = OFF');
  try {
    const migrate = db.transaction(() => {
      db.prepare(rebuiltDdl).run();
      db.prepare(`INSERT INTO tasks_workflow_required (${colList}) SELECT ${colList} FROM tasks`).run();
      db.prepare(`DROP TABLE tasks`).run();
      db.prepare(`ALTER TABLE tasks_workflow_required RENAME TO tasks`).run();
      for (const sql of indexSql) db.prepare(sql).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)`).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id)`).run();
    });
    migrate();
    console.log('[schema] Task #855: rebuilt tasks.sprint_id as NOT NULL ON DELETE CASCADE');
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function tasksDdlHasStatusCheck(ddl: string): boolean {
  return TASKS_STATUS_CHECK_RE.test(ddl);
}

function stripTasksStatusCheck(ddl: string): string {
  return ddl.replace(TASKS_STATUS_CHECK_RE, '');
}

async function tenantDefaultIdForSchemaInit(db: Database.Database): Promise<number> {
  return activeTenantMode === 'verify'
    ? await verifyTenantSchemaForStartup(new SqliteAdapter(db))
    : await ensureTenantSchema(new SqliteAdapter(db));
}

async function backfillJobInstanceDurableRunIds(db: Database.Database): Promise<void> {
  if (!await tableHasColumn(new SqliteAdapter(db), 'job_instances', 'durable_run_id')) return;
  const rows = db.prepare(`
    SELECT id
    FROM job_instances
    WHERE durable_run_id IS NULL OR TRIM(durable_run_id) = ''
  `).all() as Array<{ id: number }>;
  if (rows.length === 0) return;

  const update = db.prepare(`UPDATE job_instances SET durable_run_id = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const row of rows) update.run(randomUUID(), row.id);
  });
  tx();
  console.log(`[schema] Backfilled durable_run_id for ${rows.length} job instance(s)`);
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function removeDeprecatedRuntimeLifecycleConfig(db: Database.Database): void {
  const agentColumns = new Set(
    (db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>).map((col) => col.name),
  );
  if (!agentColumns.has('runtime_type') || !agentColumns.has('runtime_config')) return;

  const rows = db.prepare(`
    SELECT id, runtime_type, runtime_config
    FROM agents
    WHERE runtime_config IS NOT NULL
  `).all() as Array<{ id: number; runtime_type: string | null; runtime_config: string | null }>;

  const update = db.prepare(`UPDATE agents SET runtime_config = ? WHERE id = ?`);
  let changedCount = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const config = parseJsonObject(row.runtime_config);
      let changed = false;

      if (row.runtime_type === 'webhook' && Object.prototype.hasOwnProperty.call(config, 'lifecycleProxy')) {
        delete config.lifecycleProxy;
        changed = true;
      }

      if (row.runtime_type === 'hermes' && Object.prototype.hasOwnProperty.call(config, 'lifecycleMode')) {
        delete config.lifecycleMode;
        changed = true;
      }

      if (changed) {
        update.run(JSON.stringify(config), row.id);
        changedCount += 1;
      }
    }
  });
  tx();

  if (changedCount > 0) {
    console.log(`[schema] Task #558: removed deprecated runtime lifecycle config from ${changedCount} agent(s)`);
  }
}

function normalizeTaskFieldSchemaDocument(raw: unknown): { fields: Array<Record<string, unknown>> } {
  const parsed = typeof raw === 'string' ? parseJsonObject(raw) : (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {});
  const fields = Array.isArray(parsed.fields) ? parsed.fields : [];
  return {
    fields: fields
      .filter((field): field is Record<string, unknown> => Boolean(field && typeof field === 'object' && !Array.isArray(field)))
      .map((field) => {
        const { source: _source, gate_requirement: _gateRequirement, ...rest } = field;
        return rest;
      }),
  };
}

function normalizeStoredTaskFieldSchemas(db: Database.Database): void {
  const rows = db.prepare(`SELECT id, schema_json FROM task_field_schemas`).all() as Array<{ id: number; schema_json: string }>;
  const update = db.prepare(`UPDATE task_field_schemas SET schema_json = ?, updated_at = datetime('now') WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const row of rows) {
      const normalized = normalizeTaskFieldSchemaDocument(row.schema_json);
      const next = JSON.stringify(normalized);
      if (next !== row.schema_json) update.run(next, row.id);
    }
  });
  tx();
}

function ensureTaskRelationshipModel(
  db: Database.Database,
  options: { sprintTypesTenantScoped?: boolean; rebuildWithoutSprintTypeKeyForeignKey?: (table: string) => void } = {},
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sprint_type_relationship_types (
      id                           INTEGER PRIMARY KEY AUTOINCREMENT,
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
      UNIQUE(sprint_type_key, key)
    );
    CREATE INDEX IF NOT EXISTS idx_sprint_type_relationship_types_lookup
      ON sprint_type_relationship_types(sprint_type_key, key);

    CREATE TABLE IF NOT EXISTS task_relationships (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      source_task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      target_task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      relationship_type_key TEXT NOT NULL,
      metadata_json         TEXT NOT NULL DEFAULT '{}',
      created_by            TEXT NOT NULL DEFAULT 'system',
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(source_task_id != target_task_id),
      UNIQUE(source_task_id, target_task_id, relationship_type_key)
    );
    CREATE INDEX IF NOT EXISTS idx_task_relationships_source ON task_relationships(source_task_id);
    CREATE INDEX IF NOT EXISTS idx_task_relationships_target ON task_relationships(target_task_id);
    CREATE INDEX IF NOT EXISTS idx_task_relationships_type ON task_relationships(relationship_type_key);
  `);
  if (options.sprintTypesTenantScoped) {
    options.rebuildWithoutSprintTypeKeyForeignKey?.('sprint_type_relationship_types');
  }

  try {
    db.prepare(`
      INSERT OR IGNORE INTO task_relationships (source_task_id, target_task_id, relationship_type_key, metadata_json, created_by, created_at, updated_at)
      SELECT blocked_id, blocker_id, 'blocked_by', '{}', 'legacy-task_dependencies', created_at, created_at
      FROM task_dependencies
      WHERE blocked_id != blocker_id
    `).run();
  } catch (err) {
    console.warn('[schema] Task relationship blocker backfill skipped:', err);
  }

  try {
    const taskCols = new Set((db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map(col => col.name));
    if (taskCols.has('origin_task_id')) {
      const metadataExpr = taskCols.has('defect_type')
        ? `CASE WHEN defect_type IS NULL OR defect_type = '' THEN '{}' ELSE json_object('legacy_defect_type', defect_type) END`
        : `'{}'`;
      db.prepare(`
        INSERT OR IGNORE INTO task_relationships (source_task_id, target_task_id, relationship_type_key, metadata_json, created_by)
        SELECT id, origin_task_id, 'defect_of', ${metadataExpr}, 'legacy-origin_task_id'
        FROM tasks
        WHERE origin_task_id IS NOT NULL AND origin_task_id != id
      `).run();
    }
  } catch (err) {
    console.warn('[schema] Task relationship defect backfill skipped:', err);
  }
}

function backfillEvidenceFieldsIntoCustomFields(db: Database.Database): void {
  const columns = new Set((db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map(col => col.name));
  if (!columns.has('custom_fields_json')) return;
  const availableEvidenceFields = INLINE_EVIDENCE_FIELD_KEYS.filter(field => columns.has(field));
  if (availableEvidenceFields.length === 0) return;

  const selectColumns = ['id', 'custom_fields_json', ...availableEvidenceFields].join(', ');
  const rows = db.prepare(`SELECT ${selectColumns} FROM tasks`).all() as Array<Record<string, unknown>>;
  const update = db.prepare(`UPDATE tasks SET custom_fields_json = ?, updated_at = updated_at WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const row of rows) {
      const customFields = parseJsonObject(row.custom_fields_json);
      let changed = false;
      for (const field of availableEvidenceFields) {
        if (customFields[field] !== undefined && customFields[field] !== null && customFields[field] !== '') continue;
        const value = row[field];
        if (value === null || value === undefined || value === '') continue;
        customFields[field] = value;
        changed = true;
      }
      if (changed) update.run(JSON.stringify(customFields), row.id);
    }
  });
  tx();
}

function rebuildTasksWithoutLegacyEvidenceColumns(db: Database.Database): void {
  if (!tableExists(db, 'tasks')) return;
  const columns = (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map((col) => col.name);
  const removableColumns = LEGACY_TASK_EVIDENCE_COLUMNS.filter((column) => columns.includes(column));
  if (removableColumns.length === 0) return;

  const tasksDdl = (db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`
  ).get() as { sql?: string } | undefined)?.sql ?? '';
  if (!tasksDdl) return;

  let rebuiltDdl = tasksDdl.replace(/CREATE TABLE\s+"?tasks"?/, 'CREATE TABLE tasks_lifecycle_evidence_pruned');
  for (const column of removableColumns) {
    rebuiltDdl = rebuiltDdl.replace(new RegExp(`,\\s*"?${column}"?\\s+[^,\\n\\r)]+`, 'i'), '');
  }

  const keptColumns = columns.filter((column) => !removableColumns.includes(column as typeof LEGACY_TASK_EVIDENCE_COLUMNS[number]));
  const keptColumnList = keptColumns.join(', ');
  db.pragma('foreign_keys = OFF');
  const migrate = db.transaction(() => {
    db.prepare(rebuiltDdl).run();
    db.prepare(`INSERT INTO tasks_lifecycle_evidence_pruned (${keptColumnList}) SELECT ${keptColumnList} FROM tasks`).run();
    db.prepare(`DROP TABLE tasks`).run();
    db.prepare(`ALTER TABLE tasks_lifecycle_evidence_pruned RENAME TO tasks`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned_agent ON tasks(assigned_agent_id)`).run();
  });
  migrate();
  db.pragma('foreign_keys = ON');
  console.log(`[schema] Migrated: removed legacy task evidence columns (${removableColumns.join(', ')})`);
}

/**
 * ensureRoutingLegacyConfigTable — NO-OP (Task #596).
 * The routing_config_legacy table has been removed. This function is kept as a
 * stub so that existing callers don't break during the transition.
 */
export function ensureRoutingLegacyConfigTable(_db?: Database.Database): void {
  // No-op: routing_config_legacy table has been dropped (task #596)
}

function migrateAgentSessionKeysToCanonical(db: Database.Database): void {
  const agentColumns = new Set(
    (db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>).map((col) => col.name),
  );
  const hasProjectId = agentColumns.has('project_id');
  const hasOpenclawAgentId = agentColumns.has('openclaw_agent_id');
  const hasSystemRole = agentColumns.has('system_role');

  const query = hasProjectId
    ? `
      SELECT a.id, a.name, a.role, a.session_key,
             ${hasOpenclawAgentId ? 'a.openclaw_agent_id' : 'NULL AS openclaw_agent_id'},
             ${hasSystemRole ? 'a.system_role' : 'NULL AS system_role'},
             p.name AS project_name
      FROM agents a
      LEFT JOIN projects p ON p.id = a.project_id
      ORDER BY a.id ASC
    `
    : `
      SELECT a.id, a.name, a.role, a.session_key,
             ${hasOpenclawAgentId ? 'a.openclaw_agent_id' : 'NULL AS openclaw_agent_id'},
             ${hasSystemRole ? 'a.system_role' : 'NULL AS system_role'},
             NULL AS project_name
      FROM agents a
      ORDER BY a.id ASC
    `;

  const rows = db.prepare(query).all() as Array<{
    id: number;
    name: string | null;
    role: string | null;
    session_key: string | null;
    openclaw_agent_id: string | null;
    system_role: string | null;
    project_name: string | null;
  }>;

  const update = db.prepare(`
    UPDATE agents
    SET role = ?, session_key = ?, openclaw_agent_id = ?
    WHERE id = ?
  `);
  const sessionKeyOwner = db.prepare(`
    SELECT id FROM agents WHERE session_key = ? AND id != ? LIMIT 1
  `);

  for (const row of rows) {
    const nextRole = normalizeAgentRoleLabel(
      row.role,
      row.system_role === ATLAS_SYSTEM_ROLE ? 'General Assistant' : 'Agent',
    );

    const nextRuntimeSlug = resolveRuntimeAgentSlug({
      openclaw_agent_id: row.openclaw_agent_id,
      session_key: row.session_key,
      name: row.name,
    });
    let nextSessionKey = row.session_key;
    if (row.system_role !== ATLAS_SYSTEM_ROLE) {
      nextSessionKey = buildCanonicalAgentMainSessionKey({
        projectName: row.project_name,
        agentName: row.name,
        role: nextRole,
      });
      const collision = sessionKeyOwner.get(nextSessionKey, row.id) as { id: number } | undefined;
      if (collision) {
        nextSessionKey = buildCanonicalAgentMainSessionKey({
          projectName: row.project_name,
          agentNameSlug: `${slugifySessionKeyPart(row.name, 'agent')}-${row.id}`,
          role: nextRole,
        });
      }
    }

    const needsRoleUpdate = row.role !== nextRole;
    const needsSessionUpdate = row.system_role !== ATLAS_SYSTEM_ROLE && row.session_key !== nextSessionKey;
    const needsSlugUpdate = !row.openclaw_agent_id && !!nextRuntimeSlug;
    if (!needsRoleUpdate && !needsSessionUpdate && !needsSlugUpdate) continue;

    update.run(
      needsRoleUpdate ? nextRole : row.role,
      needsSessionUpdate ? nextSessionKey : row.session_key,
      nextRuntimeSlug ?? row.openclaw_agent_id,
      row.id,
    );
  }
}

function backfillProjectRepoConfigs(db: Database.Database): void {
  const projectColumns = new Set(
    (db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>).map((col) => col.name),
  );
  const agentColumns = new Set(
    (db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>).map((col) => col.name),
  );

  if (!projectColumns.has('repo_path') || !projectColumns.has('repo_url') || !projectColumns.has('repo_access_mode')) {
    return;
  }
  if (!agentColumns.has('project_id') || !agentColumns.has('repo_path') || !agentColumns.has('repo_url') || !agentColumns.has('repo_access_mode')) {
    return;
  }

  const projects = db.prepare(`
    SELECT id, repo_path, repo_url, repo_access_mode
    FROM projects
    ORDER BY id ASC
  `).all() as Array<{ id: number; repo_path: string | null; repo_url: string | null; repo_access_mode: string | null }>;

  const projectAgents = db.prepare(`
    SELECT project_id, repo_path, repo_url, repo_access_mode
    FROM agents
    WHERE project_id IS NOT NULL
    ORDER BY id ASC
  `).all() as Array<{ project_id: number; repo_path: string | null; repo_url: string | null; repo_access_mode: string | null }>;

  const configsByProject = new Map<number, Map<string, { repo_path: string | null; repo_url: string | null; repo_access_mode: 'worktree' | 'clone' | null }>>();

  for (const row of projectAgents) {
    const normalized = normalizeRepoConfig(row);
    if (!normalized.repo_access_mode) continue;
    const serialized = JSON.stringify(normalized);
    let bucket = configsByProject.get(row.project_id);
    if (!bucket) {
      bucket = new Map();
      configsByProject.set(row.project_id, bucket);
    }
    bucket.set(serialized, normalized);
  }

  const update = db.prepare(`
    UPDATE projects
    SET repo_path = ?,
        repo_url = ?,
        repo_access_mode = ?
    WHERE id = ?
  `);

  for (const project of projects) {
    if (hasRepoConfig(project)) continue;
    const configs = configsByProject.get(project.id);
    if (!configs || configs.size === 0) continue;
    if (configs.size > 1) {
      console.warn(`[schema] Skipped repo config backfill for project #${project.id}: conflicting legacy agent repo configs`);
      continue;
    }

    const nextConfig = [...configs.values()][0];
    update.run(nextConfig.repo_path, nextConfig.repo_url, nextConfig.repo_access_mode, project.id);
    console.log(`[schema] Backfilled project #${project.id} repo config from legacy agent settings`);
  }
}

function backfillWorkflowRepoConfigs(db: Database.Database): void {
  const sprintColumns = new Set(
    (db.prepare(`PRAGMA table_info(sprints)`).all() as Array<{ name: string }>).map((col) => col.name),
  );
  const projectColumns = new Set(
    (db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>).map((col) => col.name),
  );
  const sprintTypeColumns = tableExists(db, 'sprint_types')
    ? new Set((db.prepare(`PRAGMA table_info(sprint_types)`).all() as Array<{ name: string }>).map((col) => col.name))
    : new Set<string>();

  if (!sprintColumns.has('repo_path') || !sprintColumns.has('repo_url') || !sprintColumns.has('repo_access_mode')) return;
  if (!projectColumns.has('repo_path') || !projectColumns.has('repo_url') || !projectColumns.has('repo_access_mode')) return;

  const canUseRepoRequiredMetadata = sprintTypeColumns.has('repo_required');
  const canJoinSprintTypes = tableExists(db, 'sprint_types') && sprintTypeColumns.has('key');
  const typeTenantJoin = canJoinSprintTypes && sprintTypeColumns.has('tenant_id') && sprintColumns.has('tenant_id')
    ? 'AND (st.tenant_id IS NULL OR st.tenant_id = s.tenant_id)'
    : '';
  const typeTenantOrder = sprintTypeColumns.has('tenant_id') ? 'ORDER BY st.tenant_id IS NULL ASC' : '';
  const repoRequiredSelect = canUseRepoRequiredMetadata
    ? `COALESCE((
        SELECT st.repo_required
        FROM sprint_types st
        WHERE st.key = s.sprint_type
          ${typeTenantJoin}
        ${typeTenantOrder}
        LIMIT 1
      ), 0) AS repo_required`
    : `CASE WHEN s.sprint_type = 'dev' THEN 1 ELSE 0 END AS repo_required`;

  const rows = db.prepare(`
    SELECT s.id AS workflow_id,
           s.name AS workflow_name,
           s.sprint_type,
           s.repo_path AS workflow_repo_path,
           s.repo_url AS workflow_repo_url,
           s.repo_access_mode AS workflow_repo_access_mode,
           p.id AS project_id,
           p.name AS project_name,
           p.repo_path AS project_repo_path,
           p.repo_url AS project_repo_url,
           p.repo_access_mode AS project_repo_access_mode,
           ${repoRequiredSelect}
    FROM sprints s
    LEFT JOIN projects p ON p.id = s.project_id
    ORDER BY p.id ASC, s.id ASC
  `).all() as Array<{
    workflow_id: number;
    workflow_name: string | null;
    sprint_type: string | null;
    workflow_repo_path: string | null;
    workflow_repo_url: string | null;
    workflow_repo_access_mode: string | null;
    project_id: number | null;
    project_name: string | null;
    project_repo_path: string | null;
    project_repo_url: string | null;
    project_repo_access_mode: string | null;
    repo_required: number | null;
  }>;

  const update = db.prepare(`
    UPDATE sprints
    SET repo_path = ?,
        repo_url = ?,
        repo_access_mode = ?
    WHERE id = ?
      AND (repo_access_mode IS NULL OR repo_access_mode = '')
  `);

  let backfilled = 0;
  let skippedExplicit = 0;
  let skippedNonDev = 0;
  let manualConfigRequired = 0;

  for (const row of rows) {
    const workflowConfig = normalizeRepoConfig({
      repo_path: row.workflow_repo_path,
      repo_url: row.workflow_repo_url,
      repo_access_mode: row.workflow_repo_access_mode,
    });
    if (workflowConfig.repo_access_mode) {
      skippedExplicit++;
      console.log(`[schema] Workflow repo backfill skipped explicit config: project #${row.project_id ?? 'none'} workflow #${row.workflow_id} (${row.workflow_name ?? 'unnamed'})`);
      continue;
    }

    if (row.repo_required !== 1) {
      skippedNonDev++;
      console.log(`[schema] Workflow repo backfill skipped non-repo workflow: project #${row.project_id ?? 'none'} workflow #${row.workflow_id} type=${row.sprint_type ?? 'generic'}`);
      continue;
    }

    const projectConfig = normalizeRepoConfig({
      repo_path: row.project_repo_path,
      repo_url: row.project_repo_url,
      repo_access_mode: row.project_repo_access_mode,
    });
    if (!projectConfig.repo_access_mode) {
      manualConfigRequired++;
      console.warn(`[schema] Workflow repo backfill requires manual config: project #${row.project_id ?? 'none'} workflow #${row.workflow_id} (${row.workflow_name ?? 'unnamed'}) has repo_required type=${row.sprint_type ?? 'generic'} but no legacy project repo config`);
      continue;
    }

    const result = update.run(projectConfig.repo_path, projectConfig.repo_url, projectConfig.repo_access_mode, row.workflow_id);
    if (result.changes > 0) {
      backfilled++;
      console.log(`[schema] Workflow repo backfilled: project #${row.project_id ?? 'none'} workflow #${row.workflow_id} from legacy project repo config`);
    }
  }

  if (backfilled > 0 || skippedExplicit > 0 || skippedNonDev > 0 || manualConfigRequired > 0) {
    console.log(`[schema] Workflow repo backfill summary: backfilled=${backfilled} skipped_explicit=${skippedExplicit} skipped_non_repo=${skippedNonDev} manual_config_required=${manualConfigRequired}`);
  }
}

export type InitSchemaOptions = {
  tenantMode?: 'repair' | 'verify';
};

/**
 * Repairs foreign keys left pointing at a `<table>_legacy_global` name that no longer
 * exists, by re-targeting them at `<table>`.
 *
 * SQLite does not validate foreign-key TARGETS at DDL time — only at DML time, and only
 * when enforcement is on. The tenant-ownership rebuilds renamed some global tables to
 * `<name>_legacy_global` before replacing them, and two child tables kept the old name
 * in their REFERENCES clause. That went unnoticed for as long as enforcement was
 * leaking off. With enforcement restored, every INSERT and UPDATE on those children
 * fails with `no such table: main.<name>_legacy_global`, while SELECTs still work.
 *
 * Detection is data-driven rather than hardcoded to the two known tables, so a future
 * rebuild that leaks the same pattern is repaired automatically. A dangling reference
 * is only rewritten when stripping the suffix names a table that actually exists.
 */
function repairDanglingLegacyGlobalReferences(db: Database.Database): void {
  const tableNames = new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[])
      .map((r) => r.name)
  );

  for (const table of tableNames) {
    let fks: { table: string }[];
    try {
      fks = db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as { table: string }[];
    } catch {
      continue;
    }

    const broken = [...new Set(fks.map((fk) => fk.table))].filter((target) => !tableNames.has(target));
    if (broken.length === 0) continue;

    const rewrites = broken
      .map((missing) => ({ missing, replacement: missing.replace(/_legacy_global$/, '') }))
      .filter((r) => r.replacement !== r.missing && tableNames.has(r.replacement));

    if (rewrites.length !== broken.length) {
      console.error(
        `[schema] ${table} references missing table(s) ${broken.join(', ')} with no known ` +
        `replacement. Writes to ${table} will fail while foreign keys are enforced.`
      );
      continue;
    }

    const originalDdl = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`
    ).get(table) as { sql?: string } | undefined)?.sql;
    if (!originalDdl) continue;

    // Refuse to drop rows: if any child points at a parent id that is absent from the
    // replacement table, re-targeting would turn a dangling reference into real data
    // loss. Report and leave the table alone for a human to reconcile.
    let safe = true;
    for (const { missing, replacement } of rewrites) {
      for (const fk of (db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as { table: string; from: string; to: string | null }[])) {
        if (fk.table !== missing) continue;
        const parentKey = fk.to ?? 'id';
        const unmatched = (db.prepare(
          `SELECT COUNT(*) AS c FROM "${table}" c
           LEFT JOIN "${replacement}" p ON p."${parentKey}" = c."${fk.from}"
           WHERE c."${fk.from}" IS NOT NULL AND p."${parentKey}" IS NULL`
        ).get() as { c: number }).c;
        if (unmatched > 0) {
          console.error(
            `[schema] Cannot re-target ${table}.${fk.from} from ${missing} to ${replacement}: ` +
            `${unmatched} row(s) have no matching parent. Leaving the reference dangling.`
          );
          safe = false;
        }
      }
    }
    if (!safe) continue;

    let rebuiltDdl = originalDdl;
    for (const { missing, replacement } of rewrites) {
      rebuiltDdl = rebuiltDdl.replace(
        new RegExp(`"${missing}"|\\b${missing}\\b`, 'g'),
        `"${replacement}"`
      );
    }
    const tempName = `${table}_fkfix`;
    const rebuiltAsTemp = rebuiltDdl.replace(
      new RegExp(`CREATE TABLE\\s+"?${table}"?`, 'i'),
      `CREATE TABLE "${tempName}"`
    );
    if (rebuiltAsTemp === rebuiltDdl) {
      console.error(`[schema] Could not rename ${table} in its own DDL; skipping FK repair.`);
      continue;
    }

    const columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[])
      .map((c) => `"${c.name}"`)
      .join(', ');
    const indexDdl = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`
    ).all(table) as { sql: string }[]).map((r) => r.sql);

    // The rebuild must run with enforcement off (dropping the original briefly breaks
    // any reference to it) and inside a transaction so a failure leaves the table intact.
    withForeignKeysDisabled(db, () => {
      db.transaction(() => {
        db.exec(`DROP TABLE IF EXISTS "${tempName}"`);
        db.exec(rebuiltAsTemp);
        db.exec(`INSERT INTO "${tempName}" (${columns}) SELECT ${columns} FROM "${table}"`);
        db.exec(`DROP TABLE "${table}"`);
        db.exec(`ALTER TABLE "${tempName}" RENAME TO "${table}"`);
        for (const ddl of indexDdl) db.exec(ddl);
      })();
    });

    console.log(
      `[schema] Repaired dangling foreign key(s) on ${table}: ` +
      rewrites.map((r) => `${r.missing} -> ${r.replacement}`).join(', ')
    );
  }
}

export async function initSchema(options: InitSchemaOptions = {}): Promise<void> {
  const db = getRawDb();
  const tenantMode = options.tenantMode ?? 'repair';
  activeTenantMode = tenantMode;

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id    INTEGER,
      name         TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      context_md   TEXT NOT NULL DEFAULT '',
      repo_path    TEXT,
      repo_url     TEXT,
      repo_access_mode TEXT CHECK(repo_access_mode IN ('worktree','clone')),
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agents (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   INTEGER,
      name        TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT '',
      session_key TEXT NOT NULL UNIQUE,
      workspace_path TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','running','blocked')),
      last_active TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- job_templates table removed (Task #579 — jobs→agents unification)

    CREATE TABLE IF NOT EXISTS job_instances (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id                  INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      task_id                   INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      status                    TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','dispatched','running','done','failed','cancelled')),
      session_key               TEXT,
      created_at                TEXT NOT NULL DEFAULT (datetime('now')),
      dispatched_at             TEXT,
      started_at                TEXT,
      completed_at              TEXT,
      payload_sent              TEXT,
      response                  TEXT,
      error                     TEXT,
      durable_run_id            TEXT,
      run_id                    TEXT,
      abort_attempted_at        TEXT,
      abort_status              TEXT,
      abort_error               TEXT,
      runtime_ended_at          TEXT,
      runtime_end_success       INTEGER,
      runtime_end_error         TEXT,
      runtime_end_source        TEXT,
      runtime_completed_at      TEXT,
      lifecycle_handoff_status  TEXT,
      semantic_outcome_missing  INTEGER NOT NULL DEFAULT 0,
      lifecycle_outcome_posted_at TEXT,
      token_input               INTEGER,
      token_output              INTEGER,
      token_total               INTEGER
    );

    CREATE TABLE IF NOT EXISTS logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER REFERENCES job_instances(id) ON DELETE SET NULL,
      agent_id    INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      job_title   TEXT NOT NULL DEFAULT '',
      level       TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('info','warn','error','debug')),
      message     TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_logs_agent ON logs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_logs_instance ON logs(instance_id);
    CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_instances_agent ON job_instances(agent_id);
    CREATE INDEX IF NOT EXISTS idx_instances_status ON job_instances(status);
  `);

  // Legacy job_templates migrations removed — Task #579 (table dropped)

  // Safe migration: add model column to agents
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN model TEXT`);
    console.log('[schema] Migrated: added model to agents');
  } catch { /* already exists */ }

  // Safe migration: add openclaw_agent_id column to agents
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN openclaw_agent_id TEXT`);
    console.log('[schema] Migrated: added openclaw_agent_id to agents');
  } catch (_) { /* column already exists */ }

  // Safe migration: add runtime_type and runtime_config to agents
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN runtime_type TEXT NOT NULL DEFAULT 'openclaw'`);
    console.log('[schema] Migrated: added runtime_type to agents');
  } catch (_) { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN runtime_config JSON`);
    console.log('[schema] Migrated: added runtime_config to agents');
  } catch (_) { /* column already exists */ }
  removeDeprecatedRuntimeLifecycleConfig(db);

  // Safe migration: add Remote Gateway URL compatibility column to agents (task #288).
  // Used for Docker/container routing — when set, the dispatcher POSTs to
  // <hooks_url>/hooks/agent instead of the host gateway. Null = host gateway.
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN hooks_url TEXT`);
    console.log('[schema] Migrated: added hooks_url to agents');
  } catch (_) { /* column already exists */ }

  // Safe migration: add Remote Gateway Auth Header compatibility column to agents (task #431).
  // Per-agent Authorization header for Remote Gateway URL dispatch.
  // When set, dispatcher uses this instead of the global HOOKS_TOKEN.
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN hooks_auth_header TEXT`);
    console.log('[schema] Migrated: added hooks_auth_header to agents');
  } catch (_) { /* column already exists */ }

  // Canonical session/transcript store (task #599)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      external_key  TEXT NOT NULL UNIQUE,
      runtime       TEXT NOT NULL,
      agent_id      INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      instance_id   INTEGER REFERENCES job_instances(id) ON DELETE SET NULL,
      project_id    INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','failed','abandoned')),
      title         TEXT NOT NULL DEFAULT '',
      started_at    TEXT,
      ended_at      TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      token_input   INTEGER,
      token_output  INTEGER,
      metadata      TEXT NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_instance ON sessions(instance_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_runtime_status ON sessions(runtime, status, started_at DESC);

    CREATE TABLE IF NOT EXISTS session_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      ordinal     INTEGER NOT NULL,
      role        TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
      event_type  TEXT NOT NULL DEFAULT 'text',
      content     TEXT NOT NULL DEFAULT '',
      event_meta  TEXT NOT NULL DEFAULT '{}',
      raw_payload TEXT,
      timestamp   TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_id, ordinal)
    );

    CREATE INDEX IF NOT EXISTS idx_session_messages_session_ts ON session_messages(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_session_messages_event_type ON session_messages(event_type);
  `);

  // Safe migration: create chat_messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id          TEXT PRIMARY KEY,
      agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      role        TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
      content     TEXT NOT NULL DEFAULT '',
      timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
      session_key TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_agent ON chat_messages(agent_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp);
  `);

  // Canonical current direct-chat session per agent/channel so all UI clients
  // converge on the same conversation and New Chat can rotate one shared key.
  db.exec(`
    CREATE TABLE IF NOT EXISTS canonical_chat_sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      channel     TEXT NOT NULL,
      session_key TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(agent_id, channel)
    );

    CREATE INDEX IF NOT EXISTS idx_canonical_chat_sessions_agent_channel
      ON canonical_chat_sessions(agent_id, channel);
  `);

  // Safe migration: add event_type column to chat_messages (task #532)
  // Valid event_type values: 'text' | 'thought' | 'tool_call' | 'tool_result' | 'turn_start' | 'system' | 'error'
  try {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN event_type TEXT NOT NULL DEFAULT 'text'`);
    console.log('[schema] Migrated: added event_type to chat_messages');
  } catch (_) { /* column already exists */ }

  // Safe migration: add event_meta column to chat_messages (task #532)
  // JSON blob for structured attributes (tool name, args, output, turn number, etc.)
  try {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN event_meta TEXT NOT NULL DEFAULT '{}'`);
    console.log('[schema] Migrated: added event_meta to chat_messages');
  } catch (_) { /* column already exists */ }

  // Safe migration: add instance_id column to chat_messages (task #468)
  // Links chat messages to a specific job instance for per-run transcript views.
  try {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN instance_id INTEGER REFERENCES job_instances(id) ON DELETE SET NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_instance ON chat_messages(instance_id)`);
    console.log('[schema] Migrated: added instance_id to chat_messages');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN durable_run_id TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_durable_run ON chat_messages(durable_run_id)`);
    console.log('[schema] Migrated: added durable_run_id to chat_messages');
  } catch (_) { /* column already exists */ }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_key_ts
      ON chat_messages(session_key, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_instance_ts
      ON chat_messages(instance_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_agent_session_ts
      ON chat_messages(agent_id, session_key, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_agent_instance_ts
      ON chat_messages(agent_id, instance_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_agent_instance_session_ts
      ON chat_messages(agent_id, instance_id, session_key, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_agent_durable_instance_session_ts
      ON chat_messages(agent_id, durable_run_id, instance_id, session_key, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_project_activity
      ON sessions(project_id, updated_at DESC, ended_at DESC, started_at DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_agent_project_activity
      ON sessions(agent_id, project_id, updated_at DESC, ended_at DESC, started_at DESC, created_at DESC);
  `);

  // Safe migration: expand chat_messages.role CHECK to support structured transcript rows.
  // OpenClaw/Custom transcript capture can emit tool/system events, and older DBs with
  // role IN ('user','assistant') reject those rows during history import/live capture.
  // IMPORTANT: live DBs have drifted over time (for example an older session_key column).
  // Rebuild from the current sqlite_master DDL so we preserve every existing column
  // instead of assuming a hardcoded table shape.
  try {
    const chatMessagesDdl = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='chat_messages'`
    ).get() as { sql: string } | undefined)?.sql ?? '';
    if (chatMessagesDdl && !chatMessagesDdl.includes("'tool'")) {
      const cols = (db.prepare(`PRAGMA table_info(chat_messages)`).all() as { name: string }[]).map(c => c.name);
      const colList = cols.join(', ');
      const rebuiltDdl = chatMessagesDdl
        .replace(/CREATE TABLE\s+"?chat_messages"?/, 'CREATE TABLE chat_messages_new')
        .replace(
          /CHECK\s*\(\s*role\s+IN\s*\([^)]*\)\s*\)/,
          "CHECK(role IN ('user','assistant','system','tool'))"
        );

      db.pragma('foreign_keys = OFF');
      const migrate = db.transaction(() => {
        db.prepare(rebuiltDdl).run();
        db.prepare(`INSERT INTO chat_messages_new (${colList}) SELECT ${colList} FROM chat_messages`).run();
        db.prepare(`DROP TABLE chat_messages`).run();
        db.prepare(`ALTER TABLE chat_messages_new RENAME TO chat_messages`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_agent ON chat_messages(agent_id)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp)`).run();
        if (cols.includes('instance_id')) {
          db.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_instance ON chat_messages(instance_id)`).run();
        }
        if (cols.includes('durable_run_id')) {
          db.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_durable_run ON chat_messages(durable_run_id)`).run();
        }
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_session_key_ts ON chat_messages(session_key, timestamp DESC)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_instance_ts ON chat_messages(instance_id, timestamp DESC)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_agent_session_ts ON chat_messages(agent_id, session_key, timestamp DESC)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_agent_instance_ts ON chat_messages(agent_id, instance_id, timestamp DESC)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_agent_instance_session_ts ON chat_messages(agent_id, instance_id, session_key, timestamp DESC)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_agent_durable_instance_session_ts ON chat_messages(agent_id, durable_run_id, instance_id, session_key, timestamp DESC)`).run();
      });
      migrate();
      db.pragma('foreign_keys = ON');
      console.log('[schema] Migrated: expanded chat_messages.role CHECK to include system/tool');
    }
  } catch (err) {
    db.pragma('foreign_keys = ON');
    console.error('[schema] Failed to migrate chat_messages role constraint:', err);
  }

  // Task #884 cleanup: post-final chat.history snapshots duplicated direct-chat
  // user/assistant rows under oc-hist-* ids. Direct chats now ingest structured
  // rows from JSONL instead, so these snapshot rows should not remain visible.
  try {
    const removed = db.prepare(`
      DELETE FROM chat_messages
      WHERE id LIKE 'oc-hist-%'
        AND session_key LIKE 'agent:%:direct:%'
    `).run();
    if (removed.changes > 0) {
      console.log(`[schema] Task #884: removed ${removed.changes} duplicated direct-chat history row(s)`);
    }
  } catch (err) {
    console.warn('[schema] Task #884 direct-chat history cleanup skipped:', err);
  }

  // Safe migration: create tasks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id    INTEGER,
      title        TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'todo',
      priority     TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
      project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      sprint_id    INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
      agent_id     INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      assigned_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      dispatched_at TEXT,
      active_instance_id INTEGER REFERENCES job_instances(id) ON DELETE SET NULL,
      task_type    TEXT,
      story_points INTEGER,
      recurring_series_id INTEGER,
      scheduled_for TEXT,
      schedule_run_id INTEGER,
      generated_from TEXT,
      custom_fields_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_log (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id            INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      agent_id           INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      routing_reason     TEXT,
      candidate_count    INTEGER NOT NULL DEFAULT 0,
      candidates_skipped TEXT NOT NULL DEFAULT '[]',
      dispatched_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_log_task ON dispatch_log(task_id);
    CREATE INDEX IF NOT EXISTS idx_dispatch_log_agent ON dispatch_log(agent_id);
    CREATE INDEX IF NOT EXISTS idx_dispatch_log_dispatched_at ON dispatch_log(dispatched_at);
  `);

  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN assigned_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL`);
    console.log('[schema] Migrated: added assigned_agent_id to tasks and backfilled from agent_id');
  } catch (_) { /* column already exists */ }
  try {
    db.exec(`UPDATE tasks SET assigned_agent_id = agent_id WHERE assigned_agent_id IS NULL`);
    await syncAllTaskActiveAgentsFromInstances(new SqliteAdapter(db));
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned_agent ON tasks(assigned_agent_id)`);
  } catch (_) { /* minimal schema or transient migration ordering */ }

  // Safe migration: add recurring column to tasks
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN recurring INTEGER NOT NULL DEFAULT 0`);
    console.log('[schema] Migrated: added recurring to tasks');
  } catch (_) { /* column already exists */ }

  // Safe migration: add dispatched_at to tasks for legacy/minimal DBs.
  // Background dispatch/watchdog code still reads this timestamp.
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN dispatched_at TEXT`);
    console.log('[schema] Migrated: added dispatched_at to tasks');
  } catch (_) { /* column already exists */ }

  // Safe migration: add task_type column to tasks
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN task_type TEXT`);
    console.log('[schema] Migrated: added task_type to tasks');
  } catch (_) { /* column already exists */ }

  // Safe migration: add story_points column to tasks
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN story_points INTEGER`);
    console.log('[schema] Migrated: added story_points to tasks');
  } catch (_) { /* column already exists */ }

  for (const column of [
    { name: 'recurring_series_id', sql: `ALTER TABLE tasks ADD COLUMN recurring_series_id INTEGER REFERENCES recurring_task_series(id) ON DELETE SET NULL` },
    { name: 'scheduled_for', sql: `ALTER TABLE tasks ADD COLUMN scheduled_for TEXT` },
    { name: 'schedule_run_id', sql: `ALTER TABLE tasks ADD COLUMN schedule_run_id INTEGER REFERENCES recurring_task_runs(id) ON DELETE SET NULL` },
    { name: 'generated_from', sql: `ALTER TABLE tasks ADD COLUMN generated_from TEXT` },
  ]) {
    try {
      db.exec(column.sql);
      console.log(`[schema] Migrated: added ${column.name} to tasks`);
    } catch (_) { /* column already exists */ }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_generated_lookup
      ON tasks(recurring_series_id, scheduled_for)
      WHERE recurring_series_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tasks_schedule_run
      ON tasks(schedule_run_id)
      WHERE schedule_run_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_generated_occurrence_unique
      ON tasks(recurring_series_id, scheduled_for)
      WHERE recurring_series_id IS NOT NULL
        AND scheduled_for IS NOT NULL
        AND generated_from = 'recurring_task_series';
  `);

  // Safe migration: sprints table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sprints (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id    INTEGER,
      project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      goal         TEXT NOT NULL DEFAULT '',
      sprint_type  TEXT NOT NULL DEFAULT 'generic',
      repo_path    TEXT,
      repo_url     TEXT,
      repo_access_mode TEXT CHECK(repo_access_mode IN ('worktree','clone')),
      status       TEXT NOT NULL DEFAULT 'planning' CHECK(status IN ('planning','active','paused','complete','closed')),
      length_kind  TEXT NOT NULL DEFAULT 'time' CHECK(length_kind IN ('time','runs')),
      length_value TEXT NOT NULL DEFAULT '',
      started_at   TEXT,
      ended_at     TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sprints_project ON sprints(project_id);
    CREATE INDEX IF NOT EXISTS idx_sprints_status ON sprints(status);
  `);

  // Safe migration: ensure sprints includes sprint_type and closed status.
  // SQLite requires table rebuild to alter CHECK constraints or add missing columns safely
  // while preserving existing rows.
  try {
    const sprintsDdl = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='sprints'`
    ).get() as { sql: string } | undefined)?.sql ?? '';
    const allSprintCols = (db.prepare(`PRAGMA table_info(sprints)`).all() as {name:string}[]).map(c => c.name);
    // workflow_template_key pointed at the removed workflow-template model and was never
    // read. Excluding it from the copy is what actually drops it: the rebuild below
    // copies by column name, so a legacy database sheds the column on the next boot and
    // then stops rebuilding because the trigger condition no longer holds.
    const sprintCols = allSprintCols.filter(column => column !== 'workflow_template_key');
    const needsSprintsRebuild = Boolean(sprintsDdl) && (
      !sprintsDdl.includes("'closed'")
      || !sprintCols.includes('sprint_type')
      || allSprintCols.includes('workflow_template_key')
    );
    if (needsSprintsRebuild) {
      db.pragma('foreign_keys = OFF');
      const migrate = db.transaction(() => {
        db.prepare(`
          CREATE TABLE sprints_new (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            goal         TEXT NOT NULL DEFAULT '',
            sprint_type  TEXT NOT NULL DEFAULT 'generic',
            repo_path    TEXT,
            repo_url     TEXT,
            repo_access_mode TEXT CHECK(repo_access_mode IN ('worktree','clone')),
            status       TEXT NOT NULL DEFAULT 'planning' CHECK(status IN ('planning','active','paused','complete','closed')),
            length_kind  TEXT NOT NULL DEFAULT 'time' CHECK(length_kind IN ('time','runs')),
            length_value TEXT NOT NULL DEFAULT '',
            started_at   TEXT,
            ended_at     TEXT,
            created_at   TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `).run();

        const hasSprintType = sprintCols.includes('sprint_type');
        const selectCols = sprintCols.join(', ');
        const extraInsertCols = [
          ...(hasSprintType ? [] : ['sprint_type']),
          ...(sprintCols.includes('repo_path') ? [] : ['repo_path']),
          ...(sprintCols.includes('repo_url') ? [] : ['repo_url']),
          ...(sprintCols.includes('repo_access_mode') ? [] : ['repo_access_mode']),
        ];
        const insertCols = extraInsertCols.length > 0 ? `${selectCols}, ${extraInsertCols.join(', ')}` : selectCols;
        const extraSelectExpr = [
          ...(hasSprintType ? [] : [`'generic' AS sprint_type`]),
          ...(sprintCols.includes('repo_path') ? [] : ['NULL AS repo_path']),
          ...(sprintCols.includes('repo_url') ? [] : ['NULL AS repo_url']),
          ...(sprintCols.includes('repo_access_mode') ? [] : ['NULL AS repo_access_mode']),
        ];
        const selectExpr = extraSelectExpr.length > 0 ? `${selectCols}, ${extraSelectExpr.join(', ')}` : selectCols;

        db.prepare(`INSERT INTO sprints_new (${insertCols}) SELECT ${selectExpr} FROM sprints`).run();
        db.prepare(`DROP TABLE sprints`).run();
        db.prepare(`ALTER TABLE sprints_new RENAME TO sprints`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_sprints_project ON sprints(project_id)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_sprints_status ON sprints(status)`).run();
      });
      migrate();
      db.pragma('foreign_keys = ON');
      console.log('[schema] Migrated: sprints schema updated with sprint_type + closed status support');
    }
  } catch (err) {
    db.pragma('foreign_keys = ON');
    console.warn('[schema] Sprints constraint migration skipped:', err);
  }

  // Sprint type registry + baseline field schema templates (task #2)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sprint_types (
      key         TEXT PRIMARY KEY,
      project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      is_system   INTEGER NOT NULL DEFAULT 1,
      repo_required INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sprint_types_system ON sprint_types(is_system);

    CREATE TABLE IF NOT EXISTS task_field_schemas (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key  TEXT NOT NULL,
      task_type        TEXT,
      schema_json      TEXT NOT NULL DEFAULT '{}',
      is_system        INTEGER NOT NULL DEFAULT 1,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(sprint_type_key, task_type)
    );
    CREATE INDEX IF NOT EXISTS idx_task_field_schemas_lookup ON task_field_schemas(sprint_type_key, task_type);

    CREATE TABLE IF NOT EXISTS sprint_type_task_types (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key  TEXT NOT NULL,
      task_type        TEXT NOT NULL,
      is_system        INTEGER NOT NULL DEFAULT 1,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(sprint_type_key, task_type)
    );
    CREATE INDEX IF NOT EXISTS idx_sprint_type_task_types_lookup ON sprint_type_task_types(sprint_type_key, task_type);

    CREATE TABLE IF NOT EXISTS sprint_type_outcomes (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
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
      UNIQUE(sprint_type_key, task_type, outcome_key)
    );
    CREATE INDEX IF NOT EXISTS idx_sprint_type_outcomes_lookup ON sprint_type_outcomes(sprint_type_key, task_type, enabled, stage_order);

  `);

  const ensureColumn = (table: string, column: string, ddl: string): void => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some(col => col.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };
  const rebuildWithoutSprintTypeKeyForeignKey = (table: string): void => {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { sql?: string } | undefined;
    const ddl = row?.sql ?? '';
    if (!ddl.includes('REFERENCES sprint_types(key)')) return;

    const indexes = db.prepare(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'index'
        AND tbl_name = ?
        AND sql IS NOT NULL
    `).all(table) as Array<{ name: string; sql: string }>;
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const columnList = columns.map(column => column.name).join(', ');
    const tempTable = `${table}__sprint_type_fk_migration`;
    const rebuiltDdl = ddl
      .replace(new RegExp(`CREATE TABLE(?: IF NOT EXISTS)?\\s+"?${table}"?`, 'i'), `CREATE TABLE ${tempTable}`)
      .replace(/\s+REFERENCES sprint_types\(key\) ON DELETE CASCADE/gi, '');

    const restoreForeignKeys = (db.pragma('foreign_keys', { simple: true }) as number) === 1;
    if (restoreForeignKeys) db.pragma('foreign_keys = OFF');
    try {
      const rebuild = db.transaction(() => {
        db.prepare(`DROP TABLE IF EXISTS ${tempTable}`).run();
        db.prepare(rebuiltDdl).run();
        db.prepare(`INSERT INTO ${tempTable} (${columnList}) SELECT ${columnList} FROM ${table}`).run();
        db.prepare(`DROP TABLE ${table}`).run();
        db.prepare(`ALTER TABLE ${tempTable} RENAME TO ${table}`).run();
        for (const index of indexes) {
          const indexSql = index.sql.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+/i, (_match, uniquePrefix: string | undefined) => (
            `CREATE ${uniquePrefix ?? ''}INDEX IF NOT EXISTS `
          ));
          db.prepare(indexSql).run();
        }
      });
      rebuild();
      console.log(`[schema] Migrated: removed tenant-incompatible sprint_types(key) foreign key from ${table}`);
    } finally {
      if (restoreForeignKeys) db.pragma('foreign_keys = ON');
    }
  };

  ensureColumn('sprints', 'task_policy_seeded_at', `task_policy_seeded_at TEXT`);
  ensureColumn('sprint_types', 'description', `description TEXT NOT NULL DEFAULT ''`);
  ensureColumn('sprint_types', 'is_system', `is_system INTEGER NOT NULL DEFAULT 1`);
  ensureColumn('sprint_types', 'project_id', `project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE`);
  ensureColumn('sprint_types', 'created_at', `created_at TEXT`);
  ensureColumn('sprint_types', 'updated_at', `updated_at TEXT`);
  ensureColumn('sprint_types', 'status_seeded_at', `status_seeded_at TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sprint_types_project ON sprint_types(project_id)`);
  db.exec(`UPDATE sprint_types SET description = COALESCE(description, ''), is_system = COALESCE(is_system, 1), created_at = COALESCE(created_at, datetime('now')), updated_at = COALESCE(updated_at, datetime('now'))`);
  const sprintTypesTenantScoped = await tableHasColumn(new SqliteAdapter(db), 'sprint_types', 'tenant_id');
  if (sprintTypesTenantScoped) {
    for (const table of [
      'task_field_schemas',
      'sprint_type_task_types',
      'sprint_type_outcomes',
      'sprint_type_task_statuses',
      'sprint_task_transitions',
      'sprint_task_transition_requirements',
      'sprint_task_routing_rules',
      'story_point_model_routing',
    ]) {
      rebuildWithoutSprintTypeKeyForeignKey(table);
    }
  }
  let restoreSprintTypeForeignKeys = false;
  if (!sprintTypesTenantScoped) {
    const duplicateSprintTypeKeys = db.prepare(`
      SELECT key
      FROM sprint_types
      WHERE key IS NOT NULL
      GROUP BY key
      HAVING COUNT(*) > 1
    `).all() as Array<{ key: string }>;
    if (duplicateSprintTypeKeys.length > 0) {
      restoreSprintTypeForeignKeys = (db.pragma('foreign_keys', { simple: true }) as number) === 1;
      if (restoreSprintTypeForeignKeys) db.pragma('foreign_keys = OFF');
      // sprint_types has no surrogate id and its `key` is duplicated here by definition, so
      // there is no per-row identifier to delete by. rowid is SQLite-only, so instead of
      // deleting losers by rowid we read the winning row, delete every row for the key, and
      // re-insert the winner. Foreign keys are already disabled around this block.
      const sprintTypeColumns = (db.prepare(`PRAGMA table_info(sprint_types)`).all() as Array<{ name: string }>)
        .map((column) => column.name);
      const selectSprintTypeRows = db.prepare(`
        SELECT *
        FROM sprint_types
        WHERE key = ?
        ORDER BY COALESCE(is_system, 1) ASC,
                 COALESCE(updated_at, created_at, datetime('now')) DESC,
                 COALESCE(created_at, '') DESC
      `);
      const deleteSprintTypesByKey = db.prepare(`DELETE FROM sprint_types WHERE key = ?`);
      const reinsertSprintType = db.prepare(`
        INSERT INTO sprint_types (${sprintTypeColumns.map((column) => `"${column}"`).join(', ')})
        VALUES (${sprintTypeColumns.map(() => '?').join(', ')})
      `);
      const dedupeSprintTypes = db.transaction(() => {
        for (const { key } of duplicateSprintTypeKeys) {
          const rows = selectSprintTypeRows.all(key) as Array<Record<string, unknown>>;
          if (rows.length <= 1) continue;
          const keep = rows[0];
          deleteSprintTypesByKey.run(key);
          reinsertSprintType.run(...sprintTypeColumns.map((column) => keep[column] ?? null));
        }
      });
      dedupeSprintTypes();
      console.log(`[schema] Deduplicated sprint_types rows for ${duplicateSprintTypeKeys.length} key(s)`);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sprint_types_key_unique ON sprint_types(key)`);
  }
  if (restoreSprintTypeForeignKeys) db.pragma('foreign_keys = ON');
  ensureColumn('task_field_schemas', 'is_system', `is_system INTEGER NOT NULL DEFAULT 1`);
  ensureColumn('task_field_schemas', 'updated_at', `updated_at TEXT`);
  db.exec(`UPDATE task_field_schemas SET updated_at = COALESCE(updated_at, datetime('now'))`);
  const taskFieldSchemasHasTenantId = (db.prepare(`PRAGMA table_info(task_field_schemas)`).all() as Array<{ name: string }>).some((row) => row.name === 'tenant_id');
  if (taskFieldSchemasHasTenantId) {
    db.exec(`DROP INDEX IF EXISTS idx_task_field_schemas_base_unique`);
  }
  const duplicateBaseSchemaSprintTypes = db.prepare(`
    SELECT ${taskFieldSchemasHasTenantId ? 'tenant_id,' : 'NULL AS tenant_id,'} sprint_type_key
    FROM task_field_schemas
    WHERE task_type IS NULL
    GROUP BY ${taskFieldSchemasHasTenantId ? 'tenant_id, sprint_type_key' : 'sprint_type_key'}
    HAVING COUNT(*) > 1
  `).all() as Array<{ tenant_id: number | null; sprint_type_key: string }>;
  if (duplicateBaseSchemaSprintTypes.length > 0) {
    const selectBaseSchemaRows = db.prepare(`
      SELECT id
      FROM task_field_schemas
      WHERE sprint_type_key = ? AND task_type IS NULL
        ${taskFieldSchemasHasTenantId ? 'AND (tenant_id = ? OR (tenant_id IS NULL AND ? IS NULL))' : ''}
      ORDER BY COALESCE(updated_at, created_at, datetime('now')) DESC, id DESC
    `);
    const deleteFieldSchema = db.prepare(`DELETE FROM task_field_schemas WHERE id = ?`);
    const dedupeBaseFieldSchemas = db.transaction(() => {
      for (const { tenant_id, sprint_type_key } of duplicateBaseSchemaSprintTypes) {
        const rows = (taskFieldSchemasHasTenantId
          ? selectBaseSchemaRows.all(sprint_type_key, tenant_id, tenant_id)
          : selectBaseSchemaRows.all(sprint_type_key)) as Array<{ id: number }>;
        for (const row of rows.slice(1)) {
          deleteFieldSchema.run(row.id);
        }
      }
    });
    dedupeBaseFieldSchemas();
    console.log(`[schema] Deduplicated task_field_schemas base rows for ${duplicateBaseSchemaSprintTypes.length} sprint type(s)`);
  }
  if (!taskFieldSchemasHasTenantId) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_field_schemas_base_unique
      ON task_field_schemas(sprint_type_key)
      WHERE task_type IS NULL
    `);
  }
  normalizeStoredTaskFieldSchemas(db);
  ensureColumn('sprint_type_task_types', 'is_system', `is_system INTEGER NOT NULL DEFAULT 1`);
  ensureColumn('sprint_type_task_types', 'updated_at', `updated_at TEXT`);
  db.exec(`UPDATE sprint_type_task_types SET updated_at = COALESCE(updated_at, datetime('now'))`);
  ensureColumn('sprint_type_outcomes', 'description', `description TEXT NOT NULL DEFAULT ''`);
  ensureColumn('sprint_type_outcomes', 'enabled', `enabled INTEGER NOT NULL DEFAULT 1`);
  ensureColumn('sprint_type_outcomes', 'behavior', `behavior TEXT NOT NULL DEFAULT 'base'`);
  ensureColumn('sprint_type_outcomes', 'badge_variant', `badge_variant TEXT`);
  ensureColumn('sprint_type_outcomes', 'stage_order', `stage_order INTEGER NOT NULL DEFAULT 0`);
  ensureColumn('sprint_type_outcomes', 'is_system', `is_system INTEGER NOT NULL DEFAULT 1`);
  ensureColumn('sprint_type_outcomes', 'metadata_json', `metadata_json TEXT NOT NULL DEFAULT '{}'`);
  ensureColumn('sprint_type_outcomes', 'updated_at', `updated_at TEXT`);
  db.exec(`UPDATE sprint_type_outcomes SET description = COALESCE(description, ''), enabled = COALESCE(enabled, 1), behavior = COALESCE(NULLIF(behavior, ''), 'base'), stage_order = COALESCE(stage_order, 0), is_system = COALESCE(is_system, 1), metadata_json = COALESCE(metadata_json, '{}'), updated_at = COALESCE(updated_at, datetime('now'))`);
  const defaultTenantIdSql = `(SELECT id FROM tenants WHERE is_default = 1 ORDER BY id ASC LIMIT 1)`;
  const sprintTypesHasTenantId = await tableHasColumn(new SqliteAdapter(db), 'sprint_types', 'tenant_id');
  const workflowConfigTenantPredicate = async (tableName: string): Promise<string> => await tableHasColumn(new SqliteAdapter(db), tableName, 'tenant_id')
    ? `AND (tenant_id IS NULL OR tenant_id = ${defaultTenantIdSql})`
    : '';

  ensureColumn('sprint_types', 'repo_required', `repo_required INTEGER NOT NULL DEFAULT 0`);
  const sprintTypesTenantPredicate = await workflowConfigTenantPredicate('sprint_types');
  const syncStarterRepoRequirement = db.prepare(`
    UPDATE sprint_types
    SET repo_required = ?, updated_at = datetime('now')
    WHERE key = ?
      AND COALESCE(is_system, 0) = 1
      ${sprintTypesTenantPredicate}
  `);
  for (const sprintType of STARTER_SPRINT_TYPE_SEEDS) {
    syncStarterRepoRequirement.run(sprintType.repoRequired ? 1 : 0, sprintType.key);
  }

  const updateStarterSprintType = db.prepare(`
    UPDATE sprint_types
    SET name = ?, description = ?, repo_required = ?, is_system = 1, updated_at = datetime('now')
    WHERE key = ?
      ${sprintTypesTenantPredicate}
  `);
  const insertStarterSprintType = db.prepare(sprintTypesHasTenantId
    ? `
      INSERT INTO sprint_types (tenant_id, key, name, description, repo_required, is_system)
      VALUES (${defaultTenantIdSql}, ?, ?, ?, ?, 1)
    `
    : `
      INSERT INTO sprint_types (key, name, description, repo_required, is_system)
      VALUES (?, ?, ?, ?, 1)
    `);
  const upsertSprintType = (key: string, name: string, description: string, repoRequired = false): void => {
    const result = updateStarterSprintType.run(name, description, repoRequired ? 1 : 0, key);
    if (result.changes === 0) {
      insertStarterSprintType.run(key, name, description, repoRequired ? 1 : 0);
    }
  };

  const taskFieldSchemasTenantPredicate = await workflowConfigTenantPredicate('task_field_schemas');
  const updateBaseFieldSchema = db.prepare(`
    UPDATE task_field_schemas
    SET schema_json = ?, is_system = 1, updated_at = datetime('now')
    WHERE sprint_type_key = ? AND task_type IS NULL
      ${taskFieldSchemasTenantPredicate}
  `);
  const insertBaseFieldSchema = db.prepare(taskFieldSchemasHasTenantId
    ? `
      INSERT INTO task_field_schemas (tenant_id, sprint_type_key, task_type, schema_json, is_system)
      VALUES (${defaultTenantIdSql}, ?, NULL, ?, 1)
    `
    : `
      INSERT INTO task_field_schemas (sprint_type_key, task_type, schema_json, is_system)
      VALUES (?, NULL, ?, 1)
    `);
  const upsertBaseFieldSchema = (sprintTypeKey: string, schemaJson: string): void => {
    const result = updateBaseFieldSchema.run(schemaJson, sprintTypeKey);
    if (result.changes === 0) {
      insertBaseFieldSchema.run(sprintTypeKey, schemaJson);
    }
  };

  const sprintTypeTaskTypesHasTenantId = await tableHasColumn(new SqliteAdapter(db), 'sprint_type_task_types', 'tenant_id');
  const sprintTypeTaskTypesTenantPredicate = await workflowConfigTenantPredicate('sprint_type_task_types');
  const updateSprintTypeTaskType = db.prepare(`
    UPDATE sprint_type_task_types
    SET is_system = 1, updated_at = datetime('now')
    WHERE sprint_type_key = ? AND task_type = ?
      ${sprintTypeTaskTypesTenantPredicate}
  `);
  const insertSprintTypeTaskType = db.prepare(sprintTypeTaskTypesHasTenantId
    ? `
      INSERT INTO sprint_type_task_types (tenant_id, sprint_type_key, task_type, is_system)
      VALUES (${defaultTenantIdSql}, ?, ?, 1)
    `
    : `
      INSERT INTO sprint_type_task_types (sprint_type_key, task_type, is_system)
      VALUES (?, ?, 1)
    `);
  const upsertSprintTypeTaskType = (sprintTypeKey: string, taskType: string): void => {
    const result = updateSprintTypeTaskType.run(sprintTypeKey, taskType);
    if (result.changes === 0) {
      insertSprintTypeTaskType.run(sprintTypeKey, taskType);
    }
  };

  const sprintTypeOutcomesHasTenantId = await tableHasColumn(new SqliteAdapter(db), 'sprint_type_outcomes', 'tenant_id');
  const sprintTypeOutcomesTenantPredicate = await workflowConfigTenantPredicate('sprint_type_outcomes');
  const updateSprintOutcome = db.prepare(`
    UPDATE sprint_type_outcomes
    SET label = ?, description = ?, enabled = ?, behavior = ?, badge_variant = ?, stage_order = ?, is_system = 1, metadata_json = ?, updated_at = datetime('now')
    WHERE sprint_type_key = ?
      AND (task_type = ? OR (task_type IS NULL AND ? IS NULL))
      AND outcome_key = ?
      ${sprintTypeOutcomesTenantPredicate}
  `);
  const insertSprintOutcome = db.prepare(sprintTypeOutcomesHasTenantId
    ? `
      INSERT INTO sprint_type_outcomes (tenant_id, sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, badge_variant, stage_order, is_system, metadata_json, created_at, updated_at)
      VALUES (${defaultTenantIdSql}, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'))
    `
    : `
      INSERT INTO sprint_type_outcomes (sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, badge_variant, stage_order, is_system, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'))
    `);
  const upsertSprintOutcome = (
    sprintTypeKey: string,
    taskType: string | null,
    outcomeKey: string,
    label: string,
    description: string,
    enabled: number,
    behavior: string,
    badgeVariant: string | null,
    stageOrder: number,
    metadataJson: string,
  ): void => {
    const result = updateSprintOutcome.run(label, description, enabled, behavior, badgeVariant, stageOrder, metadataJson, sprintTypeKey, taskType, taskType, outcomeKey);
    if (result.changes === 0) {
      insertSprintOutcome.run(sprintTypeKey, taskType, outcomeKey, label, description, enabled, behavior, badgeVariant, stageOrder, metadataJson);
    }
  };
  const dedupeStarterSprintOutcomes = (): void => {
    if (!tableExists(db, 'sprint_type_outcomes')) return;
    const tenantSelect = sprintTypeOutcomesHasTenantId ? 'COALESCE(tenant_id, 0) AS tenant_key,' : '';
    const tenantGroup = sprintTypeOutcomesHasTenantId ? 'COALESCE(tenant_id, 0),' : '';
    const tenantWhere = sprintTypeOutcomesHasTenantId ? 'AND COALESCE(candidate.tenant_id, 0) = duplicate.tenant_key' : '';
    const seedPairs = sprintOutcomeSeeds.flatMap((seed) => seed.outcomes.map((outcome) => ({
      sprintType: seed.sprintType,
      taskType: outcome.task_type ?? null,
      outcomeKey: outcome.outcome_key,
    })));
    const dedupeOne = db.prepare(`
      DELETE FROM sprint_type_outcomes
      WHERE id IN (
        SELECT candidate.id
        FROM sprint_type_outcomes candidate
        JOIN (
          SELECT ${tenantSelect}
                 sprint_type_key,
                 COALESCE(task_type, '') AS task_type_key,
                 outcome_key,
                 MIN(id) AS keep_id
          FROM sprint_type_outcomes
          WHERE sprint_type_key = ?
            AND (task_type = ? OR (task_type IS NULL AND ? IS NULL))
            AND outcome_key = ?
            AND COALESCE(is_system, 0) = 1
          GROUP BY ${tenantGroup} sprint_type_key, COALESCE(task_type, ''), outcome_key
          HAVING COUNT(*) > 1
        ) duplicate
          ON candidate.sprint_type_key = duplicate.sprint_type_key
         AND COALESCE(candidate.task_type, '') = duplicate.task_type_key
         AND candidate.outcome_key = duplicate.outcome_key
         ${tenantWhere}
        WHERE candidate.id != duplicate.keep_id
          AND COALESCE(candidate.is_system, 0) = 1
      )
    `);
    const tx = db.transaction(() => {
      for (const seed of seedPairs) {
        dedupeOne.run(seed.sprintType, seed.taskType, seed.taskType, seed.outcomeKey);
      }
    });
    tx();
  };

  const sprintTypeSeeds = STARTER_SPRINT_TYPE_SEEDS;
  const fieldSchemaSeeds = STARTER_FIELD_SCHEMA_SEEDS;
  const sprintTypeTaskTypeSeeds = STARTER_SPRINT_TYPE_TASK_TYPE_SEEDS;
  const sprintOutcomeSeeds = STARTER_SPRINT_OUTCOME_SEEDS;
  const shouldSeedStarterSprintDefinitions = ((db.prepare(`SELECT COUNT(*) AS n FROM sprint_types`).get() as { n: number }).n ?? 0) === 0;
  let shouldSeedStarterSprintTypeStatuses = false;

  if (shouldSeedStarterSprintDefinitions) {
    const sprintTypeSeedTx = db.transaction(() => {
      for (const sprintType of sprintTypeSeeds) {
        upsertSprintType(sprintType.key, sprintType.name, sprintType.description, sprintType.repoRequired);
      }
      for (const seed of sprintTypeTaskTypeSeeds) {
        for (const taskType of seed.taskTypes) {
          upsertSprintTypeTaskType(seed.sprintType, taskType);
        }
      }
      for (const template of fieldSchemaSeeds) {
        upsertBaseFieldSchema(template.sprintType, JSON.stringify(template.schema));
      }
      for (const seed of sprintOutcomeSeeds) {
        for (const outcome of seed.outcomes) {
          upsertSprintOutcome(
            seed.sprintType,
            outcome.task_type ?? null,
            outcome.outcome_key,
            outcome.label,
            outcome.description,
            outcome.enabled ?? 1,
            outcome.behavior ?? (outcome.task_type ? 'extend' : 'base'),
            outcome.badge_variant ?? null,
            outcome.stage_order,
            JSON.stringify(outcome.metadata ?? {}),
          );
        }
      }
    });
    sprintTypeSeedTx();
    shouldSeedStarterSprintTypeStatuses = true;
  }
  dedupeStarterSprintOutcomes();

  try {
    const deprecatedSprintTypes = ['bugs', 'enhancements', 'pm'];
    const updateDeprecatedSprints = db.prepare(`
      UPDATE sprints
      SET sprint_type = 'dev'
      WHERE sprint_type = ?
    `);
    const deleteDeprecatedSprintType = db.prepare(`DELETE FROM sprint_types WHERE key = ?`);
    const migrateDeprecatedSprintTypes = db.transaction(() => {
      for (const sprintType of deprecatedSprintTypes) {
        updateDeprecatedSprints.run(sprintType);
        deleteDeprecatedSprintType.run(sprintType);
      }
    });
    migrateDeprecatedSprintTypes();
  } catch (err) {
    console.warn('[schema] Deprecated sprint type cleanup skipped:', err);
  }

  try {
    const result = db.prepare(`
      UPDATE sprints
      SET sprint_type = 'dev'
      WHERE project_id IN (
        SELECT id FROM projects WHERE lower(name) = 'agent hq'
      )
        AND status = 'active'
        AND sprint_type != 'dev'
    `).run();
    if (result.changes > 0) {
      console.log(`[schema] Migrated ${result.changes} active Agent HQ sprint(s) to dev sprint type`);
    }
  } catch (err) {
    console.warn('[schema] Active Agent HQ sprint type migration skipped:', err);
  }

  // sprint_job_schedules, sprint_job_assignments, and job_templates sprint_id removed — Task #579 (tables dropped)

  // Safe migration: add sprint_id to tasks. Task #855 later rebuilds this column
  // as NOT NULL ON DELETE CASCADE after all legacy task-table migrations run.
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN sprint_id INTEGER REFERENCES sprints(id) ON DELETE SET NULL`);
    console.log('[schema] Migrated: added sprint_id to tasks');
  } catch (_) { /* column already exists */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS recurring_task_series (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id           INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      sprint_id            INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
      title_template       TEXT NOT NULL,
      description_template TEXT NOT NULL DEFAULT '',
      task_type            TEXT NOT NULL,
      priority             TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
      story_points         INTEGER NOT NULL,
      status_on_create     TEXT NOT NULL CHECK(status_on_create IN (${taskStatusesSqlList()})),
      schedule_expression  TEXT NOT NULL,
      timezone             TEXT NOT NULL,
      enabled              INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      next_run_at          TEXT,
      last_run_at          TEXT,
      overlap_policy       TEXT NOT NULL DEFAULT 'skip_if_active' CHECK(overlap_policy IN ('skip_if_active','create_anyway')),
      agent_id             INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      created_by           TEXT NOT NULL DEFAULT 'system',
      updated_by           TEXT NOT NULL DEFAULT 'system',
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_recurring_task_series_due
      ON recurring_task_series(enabled, next_run_at)
      WHERE enabled = 1 AND next_run_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_recurring_task_series_project
      ON recurring_task_series(project_id, sprint_id);
    CREATE INDEX IF NOT EXISTS idx_recurring_task_series_agent
      ON recurring_task_series(agent_id)
      WHERE agent_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS recurring_task_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      series_id       INTEGER NOT NULL REFERENCES recurring_task_series(id) ON DELETE CASCADE,
      scheduled_for   TEXT NOT NULL,
      created_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      status          TEXT NOT NULL CHECK(status IN ('started','created','skipped','failed')),
      error_message   TEXT,
      started_at      TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at     TEXT,
      idempotency_key TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(series_id, scheduled_for),
      UNIQUE(idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_recurring_task_runs_series_history
      ON recurring_task_runs(series_id, scheduled_for DESC);
    CREATE INDEX IF NOT EXISTS idx_recurring_task_runs_created_task
      ON recurring_task_runs(created_task_id)
      WHERE created_task_id IS NOT NULL;
  `);

  // Legacy sprint scheduling tables were removed in task #596.
  // Do not recreate sprint_schedule_fires here, especially on older/minimal DBs,
  // because it references sprint_job_schedules, which no longer exists.

  // Task dependencies (blocker → blocked)
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_dependencies (
      blocker_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      blocked_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (blocker_id, blocked_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_deps_blocker ON task_dependencies(blocker_id);
    CREATE INDEX IF NOT EXISTS idx_task_deps_blocked ON task_dependencies(blocked_id);
  `);
  ensureTaskRelationshipModel(db, { sprintTypesTenantScoped, rebuildWithoutSprintTypeKeyForeignKey });
  if (!sprintTypesTenantScoped) {
    await pruneUnexpectedStarterWorkflowRelationshipTypes(new SqliteAdapter(db));
  }
  if (shouldSeedStarterSprintDefinitions) {
    await seedStarterWorkflowRelationshipTypes(new SqliteAdapter(db));
  }

  // Safe migration: add branch_url to tasks
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN branch_url TEXT`);
    console.log('[schema] Migrated: added branch_url to tasks');
  } catch (_) { /* column already exists */ }

  // Safe migration: add custom_fields_json to tasks
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN custom_fields_json TEXT NOT NULL DEFAULT '{}'`);
    console.log('[schema] Migrated: added custom_fields_json to tasks');
  } catch (_) { /* column already exists */ }

  backfillEvidenceFieldsIntoCustomFields(db);
  rebuildTasksWithoutLegacyEvidenceColumns(db);

  // Project files table
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_files (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      filename     TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type    TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes   INTEGER NOT NULL DEFAULT 0,
      file_path    TEXT NOT NULL,
      uploaded_by  TEXT NOT NULL DEFAULT 'manual',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by   TEXT NOT NULL DEFAULT 'manual',
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      current_version INTEGER NOT NULL DEFAULT 1,
      current_version_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project_id);

    CREATE TABLE IF NOT EXISTS project_file_versions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id    INTEGER NOT NULL,
      project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file_id      INTEGER NOT NULL REFERENCES project_files(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      filename     TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type    TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes   INTEGER NOT NULL DEFAULT 0,
      file_path    TEXT NOT NULL,
      created_by   TEXT NOT NULL DEFAULT 'manual',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      change_source TEXT NOT NULL DEFAULT 'api',
      UNIQUE(file_id, version_number)
    );
    CREATE INDEX IF NOT EXISTS idx_project_file_versions_file ON project_file_versions(file_id, version_number DESC);
    CREATE INDEX IF NOT EXISTS idx_project_file_versions_tenant_project ON project_file_versions(tenant_id, project_id, file_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_files (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id    INTEGER NOT NULL,
      project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      workflow_id  INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
      filename     TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type    TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes   INTEGER NOT NULL DEFAULT 0,
      file_path    TEXT NOT NULL,
      uploaded_by  TEXT NOT NULL DEFAULT 'manual',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by   TEXT NOT NULL DEFAULT 'manual',
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      current_version INTEGER NOT NULL DEFAULT 1,
      current_version_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_files_workflow ON workflow_files(tenant_id, project_id, workflow_id);

    CREATE TABLE IF NOT EXISTS workflow_file_versions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id    INTEGER NOT NULL,
      project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      workflow_id  INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
      file_id      INTEGER NOT NULL REFERENCES workflow_files(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      filename     TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type    TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes   INTEGER NOT NULL DEFAULT 0,
      file_path    TEXT NOT NULL,
      created_by   TEXT NOT NULL DEFAULT 'manual',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      change_source TEXT NOT NULL DEFAULT 'api',
      UNIQUE(file_id, version_number)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_file_versions_file ON workflow_file_versions(file_id, version_number DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_file_versions_scope ON workflow_file_versions(tenant_id, project_id, workflow_id, file_id);
  `);

  const projectFileColumns: Array<{ name: string; sql: string; log: string }> = [
    { name: 'updated_by', sql: `ALTER TABLE project_files ADD COLUMN updated_by TEXT NOT NULL DEFAULT 'manual'`, log: 'updated_by' },
    { name: 'updated_at', sql: `ALTER TABLE project_files ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`, log: 'updated_at' },
    { name: 'current_version', sql: `ALTER TABLE project_files ADD COLUMN current_version INTEGER NOT NULL DEFAULT 1`, log: 'current_version' },
    { name: 'current_version_id', sql: `ALTER TABLE project_files ADD COLUMN current_version_id INTEGER`, log: 'current_version_id' },
  ];

  for (const column of projectFileColumns) {
    try {
      db.exec(column.sql);
      console.log(`[schema] Migrated: added ${column.log} to project_files`);
    } catch (_) { /* column already exists */ }
  }

  await backfillProjectFileVersionHistory(db);

  // Task history / audit log
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      changed_by TEXT NOT NULL DEFAULT 'system',
      field      TEXT NOT NULL,
      old_value  TEXT,
      new_value  TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_history_task ON task_history(task_id);
  `);

  // Task notes
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      author     TEXT NOT NULL DEFAULT 'system',
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_notes(task_id);
  `);

  // Structured run observability artifacts
  db.exec(`
    CREATE TABLE IF NOT EXISTS instance_artifacts (
      instance_id                INTEGER PRIMARY KEY REFERENCES job_instances(id) ON DELETE CASCADE,
      task_id                    INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      current_stage              TEXT NOT NULL DEFAULT 'dispatch' CHECK(current_stage IN ('dispatch','start','heartbeat','progress','blocker','completion')),
      summary                    TEXT,
      latest_commit_hash         TEXT,
      branch_name                TEXT,
      changed_files_json         TEXT NOT NULL DEFAULT '[]',
      changed_files_count        INTEGER,
      blocker_reason             TEXT,
      outcome                    TEXT,
      last_agent_heartbeat_at    TEXT,
      last_meaningful_output_at  TEXT,
      started_at                 TEXT,
      completed_at               TEXT,
      stale                      INTEGER NOT NULL DEFAULT 0,
      stale_at                   TEXT,
      session_key                TEXT,
      last_note_at               TEXT,
      updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_instance_artifacts_task ON instance_artifacts(task_id);
    CREATE INDEX IF NOT EXISTS idx_instance_artifacts_stale ON instance_artifacts(stale, updated_at);
  `);

  // Incremental cursor for materializing raw OpenClaw JSONL session logs into chat_messages.
  db.exec(`
    CREATE TABLE IF NOT EXISTS openclaw_transcript_ingest_state (
      instance_id INTEGER PRIMARY KEY REFERENCES job_instances(id) ON DELETE CASCADE,
      session_file TEXT NOT NULL,
      last_line_index INTEGER NOT NULL DEFAULT 0,
      last_event_at TEXT,
      last_heartbeat_at TEXT,
      last_meaningful_output_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Task attachments
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_attachments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      filename     TEXT NOT NULL,
      filepath     TEXT NOT NULL,
      mime_type    TEXT NOT NULL DEFAULT '',
      size         INTEGER NOT NULL DEFAULT 0,
      uploaded_by  TEXT NOT NULL DEFAULT 'system',
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments(task_id);
  `);

  // Chat attachments (task #658)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_attachments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id  INTEGER REFERENCES job_instances(id) ON DELETE CASCADE,
      agent_id     INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      filename     TEXT NOT NULL,
      filepath     TEXT NOT NULL,
      mime_type    TEXT NOT NULL DEFAULT 'application/octet-stream',
      size         INTEGER NOT NULL DEFAULT 0,
      uploaded_by  TEXT NOT NULL DEFAULT 'user',
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chat_attachments_instance ON chat_attachments(instance_id);
  `);

  // job_templates timeout_seconds migration removed — Task #579 (table dropped)

  // Safe migrations: observability columns for instances/tasks
  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN session_key TEXT`);
    console.log('[schema] Migrated: added session_key to job_instances');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL`);
    console.log('[schema] Migrated: added task_id to job_instances');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN started_at TEXT`);
    console.log('[schema] Migrated: added started_at to job_instances');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN run_id TEXT`);
    console.log('[schema] Migrated: added run_id to job_instances');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN durable_run_id TEXT`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_job_instances_durable_run_id ON job_instances(durable_run_id) WHERE durable_run_id IS NOT NULL`);
    console.log('[schema] Migrated: added durable_run_id to job_instances');
  } catch (_) { /* column already exists */ }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_job_instances_durable_run_id ON job_instances(durable_run_id) WHERE durable_run_id IS NOT NULL`);
  await backfillJobInstanceDurableRunIds(db);

  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN abort_attempted_at TEXT`);
    console.log('[schema] Migrated: added abort_attempted_at to job_instances');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN abort_status TEXT`);
    console.log('[schema] Migrated: added abort_status to job_instances');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN abort_error TEXT`);
    console.log('[schema] Migrated: added abort_error to job_instances');
  } catch (_) { /* column already exists */ }

  for (const column of [
    { name: 'runtime_ended_at', sql: `ALTER TABLE job_instances ADD COLUMN runtime_ended_at TEXT` },
    { name: 'runtime_end_success', sql: `ALTER TABLE job_instances ADD COLUMN runtime_end_success INTEGER` },
    { name: 'runtime_end_error', sql: `ALTER TABLE job_instances ADD COLUMN runtime_end_error TEXT` },
    { name: 'runtime_end_source', sql: `ALTER TABLE job_instances ADD COLUMN runtime_end_source TEXT` },
    { name: 'runtime_completed_at', sql: `ALTER TABLE job_instances ADD COLUMN runtime_completed_at TEXT` },
    { name: 'lifecycle_handoff_status', sql: `ALTER TABLE job_instances ADD COLUMN lifecycle_handoff_status TEXT` },
    { name: 'semantic_outcome_missing', sql: `ALTER TABLE job_instances ADD COLUMN semantic_outcome_missing INTEGER NOT NULL DEFAULT 0` },
    { name: 'lifecycle_outcome_posted_at', sql: `ALTER TABLE job_instances ADD COLUMN lifecycle_outcome_posted_at TEXT` },
    { name: 'token_input', sql: `ALTER TABLE job_instances ADD COLUMN token_input INTEGER` },
    { name: 'token_output', sql: `ALTER TABLE job_instances ADD COLUMN token_output INTEGER` },
    { name: 'token_total', sql: `ALTER TABLE job_instances ADD COLUMN token_total INTEGER` },
  ]) {
    try {
      db.exec(column.sql);
      console.log(`[schema] Migrated: added ${column.name} to job_instances`);
    } catch (_) { /* column already exists */ }
  }

  // Safe migration: add task_outcome column to job_instances
  // Separates the task workflow outcome (qa_fail, blocked, completed_for_review, etc.)
  // from the execution status (done/failed). A run can complete execution cleanly (done)
  // while reporting a task outcome of qa_fail or blocked — these are not runtime failures.
  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN task_outcome TEXT`);
    console.log('[schema] Migrated: added task_outcome to job_instances');
  } catch (_) { /* column already exists */ }

  for (const column of [
    { name: 'runtime_ended_at', sql: `ALTER TABLE job_instances ADD COLUMN runtime_ended_at TEXT` },
    { name: 'runtime_end_success', sql: `ALTER TABLE job_instances ADD COLUMN runtime_end_success INTEGER` },
    { name: 'runtime_end_error', sql: `ALTER TABLE job_instances ADD COLUMN runtime_end_error TEXT` },
    { name: 'runtime_end_source', sql: `ALTER TABLE job_instances ADD COLUMN runtime_end_source TEXT` },
    { name: 'runtime_completed_at', sql: `ALTER TABLE job_instances ADD COLUMN runtime_completed_at TEXT` },
    { name: 'lifecycle_handoff_status', sql: `ALTER TABLE job_instances ADD COLUMN lifecycle_handoff_status TEXT` },
    { name: 'semantic_outcome_missing', sql: `ALTER TABLE job_instances ADD COLUMN semantic_outcome_missing INTEGER NOT NULL DEFAULT 0` },
    { name: 'lifecycle_outcome_posted_at', sql: `ALTER TABLE job_instances ADD COLUMN lifecycle_outcome_posted_at TEXT` },
  ]) {
    try {
      db.exec(column.sql);
      console.log(`[schema] Migrated: added ${column.name} to job_instances`);
    } catch (_) { /* column already exists */ }
  }

  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN active_instance_id INTEGER REFERENCES job_instances(id) ON DELETE SET NULL`);
    console.log('[schema] Migrated: added active_instance_id to tasks');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN review_owner_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL`);
    console.log('[schema] Migrated: added review_owner_agent_id to tasks');
  } catch (_) { /* column already exists */ }

  // Safe migration: remove legacy tasks.status CHECK. Workflow status validity is
  // enforced by the write model so tenant/workflow-defined status keys can be
  // stored without rebuilding SQLite schema for every workflow.
  try {
    const tasksDdl = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`
    ).get() as { sql: string } | undefined)?.sql ?? '';
    if (tasksDdlHasStatusCheck(tasksDdl)) {
      const cols = (db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map(c => c.name);
      const colList = cols.join(', ');
      const rebuiltDdl = stripTasksStatusCheck(tasksDdl)
        .replace(/CREATE TABLE\s+"?tasks"?/, 'CREATE TABLE tasks_status_unchecked');
      db.pragma('foreign_keys = OFF');
      const migrate = db.transaction(() => {
        db.prepare(rebuiltDdl).run();
        db.prepare(`INSERT INTO tasks_status_unchecked (${colList}) SELECT ${colList} FROM tasks`).run();
        db.prepare(`DROP TABLE tasks`).run();
        db.prepare(`ALTER TABLE tasks_status_unchecked RENAME TO tasks`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id)`).run();
      });
      migrate();
      db.pragma('foreign_keys = ON');
      console.log('[schema] Migrated: removed tasks.status CHECK constraint for workflow-defined statuses');
    }
  } catch (err) {
    db.pragma('foreign_keys = ON');
    console.error('[schema] Failed to remove tasks status constraint:', err);
  }

  // Safe migration: expand tasks.status CHECK to include 'cancelled'
  try {
    const tasksDdl = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`
    ).get() as { sql: string } | undefined)?.sql ?? '';
    if (tasksDdlHasStatusCheck(tasksDdl) && !tasksDdl.includes("'cancelled'")) {
      const cols = (db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map(c => c.name);
      const colList = cols.join(', ');
      const rebuiltDdl = tasksDdl
        .replace(/CREATE TABLE\s+"?tasks"?/, 'CREATE TABLE tasks_new')
        .replace(
          /CHECK\s*\(\s*status\s+IN\s*\([^)]*\)\s*\)/,
          "CHECK(status IN ('todo','in_progress','review','done','cancelled'))"
        );
      // Disable FK enforcement, run migration, re-enable
      db.pragma('foreign_keys = OFF');
      const migrate = db.transaction(() => {
        db.prepare(rebuiltDdl).run();
        db.prepare(`INSERT INTO tasks_new (${colList}) SELECT ${colList} FROM tasks`).run();
        db.prepare(`DROP TABLE tasks`).run();
        db.prepare(`ALTER TABLE tasks_new RENAME TO tasks`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)`).run();

        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id)`).run();
      });
      migrate();
      db.pragma('foreign_keys = ON');
      console.log('[schema] Migrated: added cancelled to tasks.status CHECK constraint');
    }
  } catch (err) {
    console.error('[schema] Failed to migrate tasks status constraint:', err);
  }

  // Telemetry: task_creation_events table
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_creation_events (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id           INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      sprint_id         INTEGER REFERENCES sprints(id) ON DELETE SET NULL,
      -- Creation metadata
      source            TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','skill','agent','api','import')),
      routing           TEXT NOT NULL DEFAULT '',        -- intended agent/job routing
      confidence        TEXT NOT NULL DEFAULT '' CHECK(confidence IN ('','low','medium','high')),
      scope_size        TEXT NOT NULL DEFAULT '' CHECK(scope_size IN ('','xs','small','medium','large','xl')),
      assumptions       TEXT NOT NULL DEFAULT '',        -- free text or JSON array
      open_questions    TEXT NOT NULL DEFAULT '',        -- free text or JSON array
      needs_split       INTEGER NOT NULL DEFAULT 0,      -- 0=false, 1=true
      expected_artifact TEXT NOT NULL DEFAULT '',        -- e.g. "API endpoint", "migration", "UI component"
      success_mode      TEXT NOT NULL DEFAULT '',        -- e.g. "tests pass", "manual verify", "deployed"
      raw_input         TEXT NOT NULL DEFAULT '',        -- original user/agent request text
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tce_task      ON task_creation_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_tce_project   ON task_creation_events(project_id);
    CREATE INDEX IF NOT EXISTS idx_tce_sprint    ON task_creation_events(sprint_id);
    CREATE INDEX IF NOT EXISTS idx_tce_source    ON task_creation_events(source);
    CREATE INDEX IF NOT EXISTS idx_tce_created   ON task_creation_events(created_at);
  `);

  // Telemetry: task_outcome_metrics table
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_outcome_metrics (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id                 INTEGER NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
      project_id              INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      sprint_id               INTEGER REFERENCES sprints(id) ON DELETE SET NULL,
      -- Outcome signals
      first_pass_qa           INTEGER NOT NULL DEFAULT 0,   -- 1 = passed review on first submission
      reopened_count          INTEGER NOT NULL DEFAULT 0,
      rerouted_count          INTEGER NOT NULL DEFAULT 0,
      split_after_creation    INTEGER NOT NULL DEFAULT 0,   -- 1 = was split into subtasks after creation
      blocked_after_creation  INTEGER NOT NULL DEFAULT 0,   -- 1 = became blocked after work started
      clarification_count     INTEGER NOT NULL DEFAULT 0,   -- number of clarification exchanges needed
      notes_count             INTEGER NOT NULL DEFAULT 0,   -- total notes on the task at completion
      cycle_time_hours        REAL,                         -- wall-clock hours from todo → done
      outcome_quality         TEXT NOT NULL DEFAULT '' CHECK(outcome_quality IN ('','good','acceptable','poor')),
      failure_reasons         TEXT NOT NULL DEFAULT '[]',   -- JSON array using taxonomy: misrouted|underspecified|too_large|hidden_dependency|wrong_priority|wrong_sprint|env_issue|execution_issue
      outcome_summary         TEXT NOT NULL DEFAULT '',     -- free-text post-mortem note
      recorded_at             TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tom_task      ON task_outcome_metrics(task_id);
    CREATE INDEX IF NOT EXISTS idx_tom_project   ON task_outcome_metrics(project_id);
    CREATE INDEX IF NOT EXISTS idx_tom_sprint    ON task_outcome_metrics(sprint_id);
    CREATE INDEX IF NOT EXISTS idx_tom_quality   ON task_outcome_metrics(outcome_quality);
    CREATE INDEX IF NOT EXISTS idx_tom_recorded  ON task_outcome_metrics(recorded_at);
  `);

  // Safe migration: expand tasks.status CHECK to include lifecycle + release-truth statuses
  try {
    const tasksDdl2 = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`
    ).get() as { sql: string } | undefined)?.sql ?? '';
    if (tasksDdlHasStatusCheck(tasksDdl2) && !tasksDdl2.includes("'qa_pass'")) {
      const cols = (db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map(c => c.name);
      const colList = cols.join(', ');
      const rebuiltDdl = tasksDdl2
        .replace(/CREATE TABLE\s+"?tasks"?/, 'CREATE TABLE tasks_new2')
        .replace(
          /CHECK\s*\(\s*status\s+IN\s*\([^)]*\)\s*\)/,
          `CHECK(status IN (${taskStatusesSqlList(RELEASE_TASK_STATUSES.filter(status => status !== 'blocked'))}))`
        );
      db.pragma('foreign_keys = OFF');
      const migrate = db.transaction(() => {
        db.prepare(rebuiltDdl).run();
        db.prepare(`INSERT INTO tasks_new2 (${colList}) SELECT ${colList} FROM tasks`).run();
        db.prepare(`DROP TABLE tasks`).run();
        db.prepare(`ALTER TABLE tasks_new2 RENAME TO tasks`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)`).run();

        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id)`).run();
      });
      migrate();
      db.pragma('foreign_keys = ON');
      console.log('[schema] Migrated: added release-truth statuses to tasks.status CHECK constraint');
    }
  } catch (err) {
    console.error('[schema] Failed to migrate tasks status v2 constraint:', err);
  }

  // Safe migration: sync tasks.status CHECK constraint to the canonical release list.
  // Some DBs were migrated far enough to include 'blocked' but still missed
  // 'needs_attention', which caused raw SQLite CHECK failures on refused outcomes.
  // Uses dynamic DDL to mirror all existing columns (avoids hardcoded column drift).
  try {
    const tasksDdl3 = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`
    ).get() as { sql: string } | undefined)?.sql ?? '';
    const missingCanonicalTaskStatus = tasksDdlHasStatusCheck(tasksDdl3)
      && RELEASE_TASK_STATUSES.some(status => !tasksDdl3.includes(`'${status}'`));
    if (missingCanonicalTaskStatus) {
      const cols = (db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map(c => c.name);
      const colList = cols.join(', ');
      db.pragma('foreign_keys = OFF');
      const migrate = db.transaction(() => {
        const newDdl = tasksDdl3
          .replace(
            /CHECK\(status IN \([^)]*\)\)/,
            `CHECK(status IN (${taskStatusesSqlList(RELEASE_TASK_STATUSES)}))`
          )
          .replace(/CREATE TABLE\s+"?tasks"?/, 'CREATE TABLE tasks_status_fix');
        db.prepare(newDdl).run();
        db.prepare(`INSERT INTO tasks_status_fix (${colList}) SELECT ${colList} FROM tasks`).run();
        db.prepare(`DROP TABLE tasks`).run();
        db.prepare(`ALTER TABLE tasks_status_fix RENAME TO tasks`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)`).run();

        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id)`).run();
      });
      migrate();
      db.pragma('foreign_keys = ON');
      console.log('[schema] Migrated: synced tasks.status CHECK constraint to canonical release statuses');
    }
  } catch (err) {
    console.error('[schema] Failed to migrate tasks status v3 constraint sync:', err);
  }

  // Routing config v2: state-machine transitions table
  // Migrate from old routing_config (job-level config) to new (state transitions)
  try {
    const rcCols = (db.prepare(`PRAGMA table_info(routing_config)`).all() as { name: string }[]).map(c => c.name);
    if (rcCols.includes('job_id') && !rcCols.includes('from_status')) {
      // Old schema — rename and recreate
      db.exec(`ALTER TABLE routing_config RENAME TO routing_config_legacy`);
      console.log('[schema] Renamed old routing_config to routing_config_legacy');
    }
  } catch (_) { /* table may not exist at all */ }

  ensureRoutingLegacyConfigTable(db);

  repairDanglingLegacyGlobalReferences(db);

  // Tenant-local workflow definitions use (tenant_id, key) ownership. Some legacy
  // workflow-policy tables still contain single-column REFERENCES sprint_types(key)
  // declarations, which SQLite treats as foreign-key mismatches once key is no
  // longer globally unique. Keep FK checks disabled around this compatibility DDL
  // until those legacy references are rebuilt as tenant-aware/composite references.
  //
  // This disable MUST be undone before initSchema() returns. db/client.ts hands out a
  // process-wide singleton connection, and `PRAGMA foreign_keys` is per-connection, so
  // leaking OFF here disables ON DELETE CASCADE for every query the API runs afterwards.
  // That is exactly what happened in production: deletes stopped cascading and orphan
  // rows accumulated silently. The restore lives at the end of initSchema() — see
  // "restore foreign-key enforcement" below. Do not narrow it to this block; the
  // compatibility DDL that needs enforcement off continues for several hundred lines.
  let foreignKeysDisabledForLegacyWorkflowDdl = false;
  if (await tableHasColumn(new SqliteAdapter(db), 'sprint_types', 'tenant_id')) {
    db.pragma('foreign_keys = OFF');
    // Register the window so the startup tripwire does not mistake this deliberate
    // disable for a leak. It matters because initSchema() calls ensureTenantSchema()
    // further down, still inside this window, and that path checks enforcement.
    beginIntentionalForeignKeyDisable();
    foreignKeysDisabledForLegacyWorkflowDdl = true;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS routing_config (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      from_status TEXT NOT NULL,
      outcome     TEXT NOT NULL,
      to_status   TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_routing_config_project ON routing_config(project_id);
    CREATE INDEX IF NOT EXISTS idx_routing_config_from ON routing_config(from_status, outcome);

    CREATE TABLE IF NOT EXISTS sprint_task_statuses (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id                INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
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
      UNIQUE(sprint_id, status_key)
    );
    CREATE INDEX IF NOT EXISTS idx_sprint_task_statuses_lookup ON sprint_task_statuses(sprint_id, stage_order);

    CREATE TABLE IF NOT EXISTS sprint_type_task_statuses (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
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
      UNIQUE(sprint_type_key, status_key)
    );
    CREATE INDEX IF NOT EXISTS idx_sprint_type_task_statuses_lookup
      ON sprint_type_task_statuses(sprint_type_key, stage_order);

    CREATE TABLE IF NOT EXISTS sprint_task_transitions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id    INTEGER REFERENCES sprints(id) ON DELETE CASCADE,
      project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      sprint_type  TEXT,
      task_type    TEXT,
      from_status  TEXT NOT NULL,
      outcome      TEXT NOT NULL,
      to_status    TEXT NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      priority     INTEGER NOT NULL DEFAULT 0,
      is_protected INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sprint_task_transitions_lookup
      ON sprint_task_transitions(sprint_id, from_status, outcome, task_type);

    CREATE TABLE IF NOT EXISTS sprint_task_transition_requirements (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id        INTEGER REFERENCES sprints(id) ON DELETE CASCADE,
      project_id       INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      sprint_type      TEXT,
      task_type        TEXT,
      outcome          TEXT NOT NULL,
      field_name       TEXT NOT NULL,
      requirement_type TEXT NOT NULL DEFAULT 'required'
                       CHECK(requirement_type IN ('required','match','from_status')),
      match_field      TEXT,
      severity         TEXT NOT NULL DEFAULT 'block'
                       CHECK(severity IN ('block','warn')),
      message          TEXT NOT NULL DEFAULT '',
      enabled          INTEGER NOT NULL DEFAULT 1,
      priority         INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sprint_task_transition_requirements_lookup
      ON sprint_task_transition_requirements(sprint_id, outcome, task_type);

    CREATE TABLE IF NOT EXISTS sprint_task_routing_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_id   INTEGER REFERENCES sprints(id) ON DELETE CASCADE,
      project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      sprint_type TEXT,
      task_type   TEXT,
      status      TEXT NOT NULL,
      agent_id    INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      priority    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sprint_task_routing_rules_lookup
      ON sprint_task_routing_rules(sprint_id, task_type, status);
  `);
  if (sprintTypesTenantScoped) {
    for (const table of [
      'sprint_type_task_statuses',
      'sprint_task_transitions',
      'sprint_task_transition_requirements',
      'sprint_task_routing_rules',
    ]) {
      rebuildWithoutSprintTypeKeyForeignKey(table);
    }
  }

  if (!sprintTypesTenantScoped || shouldSeedStarterSprintTypeStatuses) {
    for (const sprintType of sprintTypeSeeds) {
      await seedSprintTypeTaskStatuses(new SqliteAdapter(db), sprintType.key);
    }
  }
  ensureColumn('sprint_task_transitions', 'project_id', `project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE`);
  ensureColumn('sprint_task_transitions', 'sprint_type', `sprint_type TEXT`);
  db.exec(`
    UPDATE sprint_task_transitions
    SET project_id = COALESCE(project_id, (SELECT s.project_id FROM sprints s WHERE s.id = sprint_task_transitions.sprint_id)),
        sprint_type = COALESCE(sprint_type, (SELECT s.sprint_type FROM sprints s WHERE s.id = sprint_task_transitions.sprint_id))
    WHERE sprint_id IS NOT NULL
      AND (project_id IS NULL OR sprint_type IS NULL)
      AND EXISTS (SELECT 1 FROM sprints s WHERE s.id = sprint_task_transitions.sprint_id)
      AND EXISTS (SELECT 1 FROM projects p WHERE p.id = (SELECT s.project_id FROM sprints s WHERE s.id = sprint_task_transitions.sprint_id))
      AND EXISTS (SELECT 1 FROM sprint_types st WHERE st.key = (SELECT s.sprint_type FROM sprints s WHERE s.id = sprint_task_transitions.sprint_id))
  `);
  const taskTransitionsDdlRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sprint_task_transitions'`).get() as { sql?: string } | undefined;
  const taskTransitionsDdl = taskTransitionsDdlRow?.sql ?? '';
  if (/sprint_id\s+INTEGER\s+NOT\s+NULL/i.test(taskTransitionsDdl)) {
    db.exec(`
      BEGIN TRANSACTION;
      CREATE TABLE sprint_task_transitions__new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        sprint_id    INTEGER REFERENCES sprints(id) ON DELETE CASCADE,
        project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        sprint_type  TEXT,
        task_type    TEXT,
        from_status  TEXT NOT NULL,
        outcome      TEXT NOT NULL,
        to_status    TEXT NOT NULL,
        enabled      INTEGER NOT NULL DEFAULT 1,
        priority     INTEGER NOT NULL DEFAULT 0,
        is_protected INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO sprint_task_transitions__new (id, sprint_id, project_id, sprint_type, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at)
      SELECT id, sprint_id, project_id, sprint_type, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at
      FROM sprint_task_transitions;
      DROP TABLE sprint_task_transitions;
      ALTER TABLE sprint_task_transitions__new RENAME TO sprint_task_transitions;
      COMMIT;
    `);
    console.log('[schema] Migrated: sprint_task_transitions.sprint_id now allows NULL for sprint-type defaults');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sprint_task_transitions_lookup
      ON sprint_task_transitions(sprint_id, from_status, outcome, task_type);
    CREATE INDEX IF NOT EXISTS idx_sprint_task_transitions_scope_lookup
      ON sprint_task_transitions(project_id, sprint_type, sprint_id, from_status, outcome, task_type);
  `);
  for (const tableName of ['routing_config', 'sprint_task_transitions']) {
    try {
      const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
      if (columns.some(column => column.name === 'lane')) {
        db.exec(`ALTER TABLE ${tableName} DROP COLUMN lane`);
        console.log(`[schema] Task #743: dropped legacy ${tableName}.lane column`);
      }
    } catch (err) {
      console.error(`[schema] Task #743: failed to drop legacy ${tableName}.lane column:`, err);
    }
  }
  ensureColumn('sprint_task_transition_requirements', 'project_id', `project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE`);
  ensureColumn('sprint_task_transition_requirements', 'sprint_type', `sprint_type TEXT`);
  db.exec(`
    UPDATE sprint_task_transition_requirements
    SET project_id = COALESCE(project_id, (SELECT s.project_id FROM sprints s WHERE s.id = sprint_task_transition_requirements.sprint_id)),
        sprint_type = COALESCE(sprint_type, (SELECT s.sprint_type FROM sprints s WHERE s.id = sprint_task_transition_requirements.sprint_id))
    WHERE sprint_id IS NOT NULL
      AND (project_id IS NULL OR sprint_type IS NULL)
      AND EXISTS (SELECT 1 FROM sprints s WHERE s.id = sprint_task_transition_requirements.sprint_id)
      AND EXISTS (SELECT 1 FROM projects p WHERE p.id = (SELECT s.project_id FROM sprints s WHERE s.id = sprint_task_transition_requirements.sprint_id))
      AND EXISTS (SELECT 1 FROM sprint_types st WHERE st.key = (SELECT s.sprint_type FROM sprints s WHERE s.id = sprint_task_transition_requirements.sprint_id))
  `);
  const taskTransitionRequirementsDdlRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sprint_task_transition_requirements'`).get() as { sql?: string } | undefined;
  const taskTransitionRequirementsDdl = taskTransitionRequirementsDdlRow?.sql ?? '';
  if (/sprint_id\s+INTEGER\s+NOT\s+NULL/i.test(taskTransitionRequirementsDdl)) {
    db.exec(`
      BEGIN TRANSACTION;
      CREATE TABLE sprint_task_transition_requirements__new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        sprint_id        INTEGER REFERENCES sprints(id) ON DELETE CASCADE,
        project_id       INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        sprint_type      TEXT,
        task_type        TEXT,
        outcome          TEXT NOT NULL,
        field_name       TEXT NOT NULL,
        requirement_type TEXT NOT NULL DEFAULT 'required'
                         CHECK(requirement_type IN ('required','match','from_status')),
        match_field      TEXT,
        severity         TEXT NOT NULL DEFAULT 'block'
                         CHECK(severity IN ('block','warn')),
        message          TEXT NOT NULL DEFAULT '',
        enabled          INTEGER NOT NULL DEFAULT 1,
        priority         INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO sprint_task_transition_requirements__new (id, sprint_id, project_id, sprint_type, task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority, created_at, updated_at)
      SELECT id, sprint_id, project_id, sprint_type, task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority, created_at, updated_at
      FROM sprint_task_transition_requirements;
      DROP TABLE sprint_task_transition_requirements;
      ALTER TABLE sprint_task_transition_requirements__new RENAME TO sprint_task_transition_requirements;
      COMMIT;
    `);
    console.log('[schema] Migrated: sprint_task_transition_requirements.sprint_id now allows NULL for sprint-type defaults');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sprint_task_transition_requirements_lookup
      ON sprint_task_transition_requirements(sprint_id, outcome, task_type);
    CREATE INDEX IF NOT EXISTS idx_sprint_task_transition_requirements_scope_lookup
      ON sprint_task_transition_requirements(project_id, sprint_type, sprint_id, outcome, task_type);
  `);
  ensureColumn('sprint_task_routing_rules', 'is_system', `is_system INTEGER NOT NULL DEFAULT 0`);
  ensureColumn('sprint_task_routing_rules', 'enabled', `enabled INTEGER NOT NULL DEFAULT 1`);
  ensureColumn('sprint_task_routing_rules', 'project_id', `project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE`);
  ensureColumn('sprint_task_routing_rules', 'sprint_type', `sprint_type TEXT`);
  db.exec(`
    UPDATE sprint_task_routing_rules
    SET project_id = COALESCE(project_id, (SELECT s.project_id FROM sprints s WHERE s.id = sprint_task_routing_rules.sprint_id)),
        sprint_type = COALESCE(sprint_type, (SELECT s.sprint_type FROM sprints s WHERE s.id = sprint_task_routing_rules.sprint_id))
    WHERE sprint_id IS NOT NULL
      AND (project_id IS NULL OR sprint_type IS NULL)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sprint_task_routing_rules_scope_lookup
      ON sprint_task_routing_rules(project_id, sprint_type, sprint_id, task_type, status)
  `);
  db.exec(`DROP INDEX IF EXISTS idx_sprint_task_routing_rules_scope_unique`);
  // The grouping keys are the COALESCE expressions, so the projection selects those same
  // expressions rather than the bare columns: a bare column that is neither aggregated nor
  // grouped is accepted by SQLite but rejected by Postgres. Matching rows back below uses the
  // identical COALESCE expressions, which keeps the NULL-vs-sentinel semantics unchanged and
  // avoids SQLite-only `IS ?` NULL-safe comparisons.
  const duplicateScopedRoutingRules = db.prepare(`
    SELECT project_id,
           sprint_type,
           COALESCE(sprint_id, -1) AS sprint_key,
           COALESCE(task_type, '') AS task_type_key,
           status,
           COALESCE(agent_id, -1) AS agent_key,
           priority,
           COUNT(*) as row_count
    FROM sprint_task_routing_rules
    WHERE project_id IS NOT NULL
      AND sprint_type IS NOT NULL
    GROUP BY project_id, sprint_type, COALESCE(sprint_id, -1), COALESCE(task_type, ''), status, COALESCE(agent_id, -1), priority
    HAVING COUNT(*) > 1
  `).all() as Array<{
    project_id: number;
    sprint_type: string;
    sprint_key: number;
    task_type_key: string;
    status: string;
    agent_key: number;
    priority: number;
    row_count: number;
  }>;
  if (duplicateScopedRoutingRules.length > 0) {
    const selectScopedRoutingRuleIds = db.prepare(`
      SELECT id
      FROM sprint_task_routing_rules
      WHERE project_id = ?
        AND sprint_type = ?
        AND COALESCE(sprint_id, -1) = ?
        AND COALESCE(task_type, '') = ?
        AND status = ?
        AND COALESCE(agent_id, -1) = ?
        AND priority = ?
      ORDER BY COALESCE(updated_at, created_at, datetime('now')) DESC, id DESC
    `);
    const deleteScopedRoutingRule = db.prepare(`DELETE FROM sprint_task_routing_rules WHERE id = ?`);
    const dedupeScopedRoutingRules = db.transaction(() => {
      for (const row of duplicateScopedRoutingRules) {
        const ids = selectScopedRoutingRuleIds.all(
          row.project_id,
          row.sprint_type,
          row.sprint_key,
          row.task_type_key,
          row.status,
          row.agent_key,
          row.priority,
        ) as Array<{ id: number }>;
        for (const duplicateRow of ids.slice(1)) {
          deleteScopedRoutingRule.run(duplicateRow.id);
        }
      }
    });
    dedupeScopedRoutingRules();
    console.log(`[schema] Deduplicated exact sprint_task_routing_rules scoped rows for ${duplicateScopedRoutingRules.length} key(s)`);
  }
  const routingRulesDdlRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sprint_task_routing_rules'`).get() as { sql?: string } | undefined;
  const routingRulesDdl = routingRulesDdlRow?.sql ?? '';
  const sprintRoutingNeedsNullSprintIdMigration = /sprint_id\s+INTEGER\s+NOT\s+NULL/i.test(routingRulesDdl);
  const sprintRoutingNeedsNullTaskTypeMigration = /task_type\s+TEXT\s+NOT\s+NULL/i.test(routingRulesDdl);
  if (sprintRoutingNeedsNullSprintIdMigration || sprintRoutingNeedsNullTaskTypeMigration) {
    db.exec(`
      BEGIN TRANSACTION;
      CREATE TABLE sprint_task_routing_rules__new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        sprint_id   INTEGER REFERENCES sprints(id) ON DELETE CASCADE,
        project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        sprint_type TEXT,
        task_type   TEXT,
        status      TEXT NOT NULL,
        agent_id    INTEGER REFERENCES agents(id) ON DELETE SET NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        priority    INTEGER NOT NULL DEFAULT 0,
        is_system   INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO sprint_task_routing_rules__new (id, sprint_id, project_id, sprint_type, task_type, status, agent_id, enabled, priority, is_system, created_at, updated_at)
      SELECT id, sprint_id, project_id, sprint_type, task_type, status, agent_id, COALESCE(enabled, 1), priority, COALESCE(is_system, 0), created_at, updated_at
      FROM sprint_task_routing_rules;
      DROP TABLE sprint_task_routing_rules;
      ALTER TABLE sprint_task_routing_rules__new RENAME TO sprint_task_routing_rules;
      COMMIT;
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sprint_task_routing_rules_lookup
        ON sprint_task_routing_rules(sprint_id, task_type, status);
      CREATE INDEX IF NOT EXISTS idx_sprint_task_routing_rules_scope_lookup
        ON sprint_task_routing_rules(project_id, sprint_type, sprint_id, task_type, status);
    `);
    console.log('[schema] Migrated: sprint_task_routing_rules.sprint_id now allows NULL for sprint-type defaults');
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sprint_task_routing_rules_candidate_unique
      ON sprint_task_routing_rules(
        project_id,
        sprint_type,
        COALESCE(sprint_id, -1),
        COALESCE(task_type, ''),
        status,
        COALESCE(agent_id, -1),
        priority
      )
      WHERE project_id IS NOT NULL AND sprint_type IS NOT NULL;
  `);
  await normalizeSprintTaskRoutingRuleTaskTypes(new SqliteAdapter(db));
  db.exec(`
    UPDATE sprints
    SET task_policy_seeded_at = COALESCE(task_policy_seeded_at, datetime('now'))
    WHERE id IN (
      SELECT sprint_id FROM sprint_task_statuses
      UNION
      SELECT sprint_id FROM sprint_task_transitions
      UNION
      SELECT sprint_id FROM sprint_task_transition_requirements
      UNION
      SELECT sprint_id FROM sprint_task_routing_rules
    )
  `);

  const disabledGlobalRoutingConfig = db.prepare(`
    UPDATE routing_config
    SET enabled = 0
    WHERE enabled = 1
      AND project_id IS NULL
  `).run();
  if (disabledGlobalRoutingConfig.changes > 0) {
    console.log(`[schema] Disabled ${disabledGlobalRoutingConfig.changes} null-scoped routing_config transition(s)`);
  }

  const validStatusesSql = taskStatusesSqlList(RELEASE_TASK_STATUSES);
  const disabledRoutingResult = db.prepare(`
    UPDATE routing_config
    SET enabled = 0
    WHERE enabled = 1
      AND (
        from_status NOT IN (${validStatusesSql})
        OR to_status NOT IN (${validStatusesSql})
        OR (from_status = 'review' AND outcome = 'qa_pass' AND to_status = 'done')
        OR (from_status = 'in_progress' AND outcome = 'completed_done')
      )
  `).run();
  if (disabledRoutingResult.changes > 0) {
    console.log(`[schema] Disabled ${disabledRoutingResult.changes} obsolete routing_config transition(s)`);
  }

  ensureAgencyDevOpsReleaseLane();
  backfillJobInstanceTokenUsage();

  // Deterministic task routing metadata
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN task_type TEXT`);
    console.log('[schema] Migrated: added task_type to tasks');
  } catch (_) { /* already exists */ }

  // Second task_routing_rules CREATE removed — table already created above without job_id
  // Note: alignAgencyReleaseJobInstructions() requires agents.job_instructions (added in Task #459 Phase 0
  // migration below), so it is called after that migration block rather than here.
  ensureSecurityEventsTable();
  ensureProjectAuditLogTable();
  ensureAppSettingsTable();
  if (activeTenantMode !== 'verify') {
    await ensureDefaultProjectId(new SqliteAdapter(db));
  }
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN system_role TEXT`);
    console.log('[schema] Migrated: added system_role to agents');
  } catch (_) { /* column already exists */ }
  ensureDefectTrackingColumns();
  ensureTaskRelationshipModel(db, { sprintTypesTenantScoped, rebuildWithoutSprintTypeKeyForeignKey });
  ensureToolRegistryTables();
  await ensureProviderConfigTable();
  ensureProviderConnectionsTable();
  await ensureGitHubIdentitiesTable();
  ensureFailureDetailAndWorkflowColumns();
  await seedInitialData();
  await ensureMcpApiKeyTable(new SqliteAdapter(db));
  await ensureMcpRegistryTables();
  ensureLifecycleRulesTable();
  ensureDataMigration593();

  // Safe migration: expand job_instances.status CHECK to include 'cancelled'
  // Instances aborted via task cancel/stop should show as 'cancelled', not 'done'.
  try {
    const instancesDdl = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='job_instances'`
    ).get() as { sql: string } | undefined)?.sql ?? '';
    if (instancesDdl && !instancesDdl.includes("'cancelled'")) {
      const cols = (db.prepare(`PRAGMA table_info(job_instances)`).all() as { name: string }[]).map(c => c.name);
      const colList = cols.join(', ');
      const rebuiltDdl = instancesDdl
        .replace(/CREATE TABLE\s+"?job_instances"?/, 'CREATE TABLE job_instances_new')
        .replace(
          /CHECK\s*\(\s*status\s+IN\s*\([^)]*\)\s*\)/,
          "CHECK(status IN ('queued','dispatched','running','done','failed','cancelled'))"
        );
      db.pragma('foreign_keys = OFF');
      const migrate = db.transaction(() => {
        db.prepare(rebuiltDdl).run();
        db.prepare(`INSERT INTO job_instances_new (${colList}) SELECT ${colList} FROM job_instances`).run();
        db.prepare(`DROP TABLE job_instances`).run();
        db.prepare(`ALTER TABLE job_instances_new RENAME TO job_instances`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_instances_status ON job_instances(status)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_instances_task ON job_instances(task_id)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_instances_agent ON job_instances(agent_id)`).run();
      });
      migrate();
      db.pragma('foreign_keys = ON');
      console.log('[schema] Migrated: added cancelled to job_instances.status CHECK constraint');
    }
  } catch (err) {
    console.error('[schema] Failed to migrate job_instances status constraint:', err);
  }

  // Safe migration: add preferred_provider to agents
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN preferred_provider TEXT NOT NULL DEFAULT 'anthropic'`);
    console.log('[schema] Migrated: added preferred_provider to agents');
  } catch (_) { /* column already exists */ }

  // Safe migration: add agent-native routing config columns (Task #594/596)
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN stall_threshold_min INTEGER NOT NULL DEFAULT 30`);
    console.log('[schema] Migrated: added stall_threshold_min to agents');
  } catch (_) { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3`);
    console.log('[schema] Migrated: added max_retries to agents');
  } catch (_) { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN sort_rules TEXT NOT NULL DEFAULT '[]'`);
    console.log('[schema] Migrated: added sort_rules to agents');
  } catch (_) { /* column already exists */ }

  // Safe migration: add os_user column to agents (task #377)
  // Stores the dedicated macOS OS user for this agent (e.g. "agent-forge").
  // When set, the agent process runs as this OS user for filesystem isolation.
  // Null = no OS-level isolation (legacy behaviour).
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN os_user TEXT`);
    console.log('[schema] Migrated: added os_user to agents');
  } catch (_) { /* column already exists */ }

  // Backfill os_user on known agents (must run after os_user column exists)
  backfillAgentOsUsers();
  await migrateAtlasToDedicatedAgent();

  // Safe migration: add effective_model to job_instances
  // Stores the model actually used (or selected at dispatch time) for that run.
  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN effective_model TEXT`);
    console.log('[schema] Migrated: added effective_model to job_instances');
  } catch (_) { /* column already exists */ }

  // Safe migration: add effective_thinking_level to job_instances
  // Stores the resolved thinking level used at dispatch time for audit/debugging.
  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN effective_thinking_level TEXT`);
    console.log('[schema] Migrated: added effective_thinking_level to job_instances');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN effective_fast_mode INTEGER CHECK(effective_fast_mode IN (0, 1))`);
    console.log('[schema] Migrated: added effective_fast_mode to job_instances');
  } catch (_) { /* column already exists */ }

  // Safe migration: add worktree_path to job_instances (task #365)
  // Stores the git worktree path used by the agent for this run.
  // Enables cleanup on completion and orphan detection by the watchdog.
  try {
    db.exec(`ALTER TABLE job_instances ADD COLUMN worktree_path TEXT`);
    console.log('[schema] Migrated: added worktree_path to job_instances');
  } catch (_) { /* column already exists */ }

  // Safe migration: project-level repo ownership (task #438)
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN repo_path TEXT`);
    console.log('[schema] Migrated: added repo_path to projects');
  } catch (_) { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN repo_url TEXT`);
    console.log('[schema] Migrated: added repo_url to projects');
  } catch (_) { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN repo_access_mode TEXT CHECK(repo_access_mode IN ('worktree','clone'))`);
    console.log('[schema] Migrated: added repo_access_mode to projects');
  } catch (_) { /* column already exists */ }

  // Safe migration: add repo_path to agents (task #365)
  // The canonical local git repository path used for worktree operations.
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN repo_path TEXT`);
    console.log('[schema] Migrated: added repo_path to agents');
  } catch (_) { /* column already exists */ }

  // Safe migration: explicit repo source fields for worktree vs clone dispatch (task #373)
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN repo_url TEXT`);
    console.log('[schema] Migrated: added repo_url to agents');
  } catch (_) { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN repo_access_mode TEXT CHECK(repo_access_mode IN ('worktree','clone'))`);
    console.log('[schema] Migrated: added repo_access_mode to agents');
  } catch (_) { /* column already exists */ }
  try {
    db.exec(`UPDATE agents SET repo_access_mode = 'worktree' WHERE repo_access_mode IS NULL AND repo_path IS NOT NULL AND repo_path != ''`);
  } catch (_) { /* ignore */ }

  await ensureTableColumn(db, 'sprints', 'repo_path', `repo_path TEXT`);
  await ensureTableColumn(db, 'sprints', 'repo_url', `repo_url TEXT`);
  await ensureTableColumn(db, 'sprints', 'repo_access_mode', `repo_access_mode TEXT CHECK(repo_access_mode IN ('worktree','clone'))`);

  backfillProjectRepoConfigs(db);
  backfillWorkflowRepoConfigs(db);

  // Create story_point_model_routing table
  db.exec(`
    CREATE TABLE IF NOT EXISTS story_point_model_routing (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id      INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      sprint_id       INTEGER REFERENCES sprints(id) ON DELETE CASCADE,
      sprint_type     TEXT,
      max_points      INTEGER NOT NULL,
      provider        TEXT,
      model           TEXT NOT NULL,
      fallback_model  TEXT,
      max_turns       INTEGER,
      max_budget_usd  REAL,
      thinking_level  TEXT,
      fast_mode       INTEGER CHECK(fast_mode IN (0, 1)),
      enabled         INTEGER NOT NULL DEFAULT 1,
      label           TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_spmr_provider_points ON story_point_model_routing(provider, max_points);
  `);

  try {
    db.exec(`ALTER TABLE story_point_model_routing ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE`);
    console.log('[schema] Migrated: added project_id to story_point_model_routing');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE story_point_model_routing ADD COLUMN sprint_id INTEGER REFERENCES sprints(id) ON DELETE CASCADE`);
    console.log('[schema] Migrated: added sprint_id to story_point_model_routing');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE story_point_model_routing ADD COLUMN sprint_type TEXT`);
    console.log('[schema] Migrated: added sprint_type to story_point_model_routing');
  } catch (_) { /* column already exists */ }
  if (sprintTypesTenantScoped) {
    rebuildWithoutSprintTypeKeyForeignKey('story_point_model_routing');
  }

  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_spmr_scope_points ON story_point_model_routing(project_id, sprint_id, sprint_type, provider, max_points)`);
  } catch (_) { /* ignore */ }

  // Safe migration: allow provider-agnostic model routing rules.
  // Older DBs created story_point_model_routing.provider as NOT NULL DEFAULT 'anthropic',
  // but scoped routing still allows provider-agnostic rows within an explicit project/sprint scope.
  try {
    const routingDdl = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='story_point_model_routing'`
    ).get() as { sql: string } | undefined)?.sql ?? '';
    if (/provider\s+TEXT\s+NOT\s+NULL/i.test(routingDdl)) {
      const cols = (db.prepare(`PRAGMA table_info(story_point_model_routing)`).all() as { name: string }[]).map(c => c.name);
      const colList = cols.join(', ');
      const rebuiltDdl = routingDdl
        .replace(/CREATE TABLE\s+"?story_point_model_routing"?/, 'CREATE TABLE story_point_model_routing_new')
        .replace(/provider\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'anthropic'/i, 'provider TEXT')
        .replace(/provider\s+TEXT\s+NOT\s+NULL/i, 'provider TEXT');

      db.pragma('foreign_keys = OFF');
      const migrate = db.transaction(() => {
        db.prepare(rebuiltDdl).run();
        db.prepare(`INSERT INTO story_point_model_routing_new (${colList}) SELECT ${colList} FROM story_point_model_routing`).run();
        db.prepare(`DROP TABLE story_point_model_routing`).run();
        db.prepare(`ALTER TABLE story_point_model_routing_new RENAME TO story_point_model_routing`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_spmr_provider_points ON story_point_model_routing(provider, max_points)`).run();
      });
      migrate();
      db.pragma('foreign_keys = ON');
      console.log('[schema] Migrated: story_point_model_routing.provider is nullable');
    }
  } catch (err) {
    db.pragma('foreign_keys = ON');
    console.error('[schema] Failed to migrate story_point_model_routing provider nullability:', err);
  }

  try {
    db.exec(`ALTER TABLE story_point_model_routing ADD COLUMN thinking_level TEXT`);
    console.log('[schema] Migrated: added thinking_level to story_point_model_routing');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE story_point_model_routing ADD COLUMN fast_mode INTEGER CHECK(fast_mode IN (0, 1))`);
    console.log('[schema] Migrated: added fast_mode to story_point_model_routing');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE story_point_model_routing ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`);
    console.log('[schema] Migrated: added enabled to story_point_model_routing');
  } catch (_) { /* column already exists */ }

  try {
    const result = db.prepare(`
      UPDATE story_point_model_routing
      SET provider = CASE
            WHEN provider = 'openai' AND (model LIKE 'openai-codex/%' OR fallback_model LIKE 'openai-codex/%') THEN 'openai-codex'
            ELSE provider
          END,
          model = CASE
            WHEN model LIKE 'openai-codex/%' THEN 'openai/' || substr(model, length('openai-codex/') + 1)
            ELSE model
          END,
          fallback_model = CASE
            WHEN fallback_model LIKE 'openai-codex/%' THEN 'openai/' || substr(fallback_model, length('openai-codex/') + 1)
            ELSE fallback_model
          END,
          updated_at = datetime('now')
      WHERE model LIKE 'openai-codex/%'
         OR fallback_model LIKE 'openai-codex/%'
    `).run();
    if (result.changes > 0) {
      console.log(`[schema] Migrated ${result.changes} OpenAI Codex model routing row(s) to OpenClaw model IDs`);
    }
  } catch (_) { /* older DBs may not have all columns yet */ }

  try {
    const result = db.prepare(`
      UPDATE agents
      SET preferred_provider = CASE
            WHEN preferred_provider = 'openai' THEN 'openai-codex'
            ELSE preferred_provider
          END,
          model = 'openai/' || substr(model, length('openai-codex/') + 1)
      WHERE model LIKE 'openai-codex/%'
    `).run();
    if (result.changes > 0) {
      console.log(`[schema] Migrated ${result.changes} OpenAI Codex agent model row(s) to OpenClaw model IDs`);
    }
  } catch (_) { /* older DBs may not have model yet */ }


  // ── Task #459: Merge job templates into agents (Phase 0) ──────────────
  // Add legacy job-template columns to agents table for compatibility with
  // historical job_templates rows. job_title is no longer active agent config.
  const phase0Columns: Array<{ name: string; sql: string }> = [
    { name: 'job_title',         sql: `ALTER TABLE agents ADD COLUMN job_title TEXT NOT NULL DEFAULT ''` },
    { name: 'project_id',       sql: `ALTER TABLE agents ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL` },
    // Task #605: legacy/internal only. Agents are project-scoped; sprint-specific
    // dispatch is expressed through sprint_task_routing_rules.
    { name: 'sprint_id',        sql: `ALTER TABLE agents ADD COLUMN sprint_id INTEGER REFERENCES sprints(id) ON DELETE SET NULL` },
    { name: 'schedule',         sql: `ALTER TABLE agents ADD COLUMN schedule TEXT NOT NULL DEFAULT ''` },
    { name: 'dispatch_mode',    sql: `ALTER TABLE agents ADD COLUMN dispatch_mode TEXT NOT NULL DEFAULT 'agentTurn'` },
    // Task #407 owns the canonical job_instructions migration below so legacy pre_instructions data can be renamed/backfilled first.
    { name: 'skill_name',       sql: `ALTER TABLE agents ADD COLUMN skill_name TEXT` },
    { name: 'skill_names',      sql: `ALTER TABLE agents ADD COLUMN skill_names TEXT NOT NULL DEFAULT '[]'` },
    { name: 'enabled',          sql: `ALTER TABLE agents ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1` },
    { name: 'timeout_seconds',  sql: `ALTER TABLE agents ADD COLUMN timeout_seconds INTEGER NOT NULL DEFAULT 900` },
  ];
  let phase0Added = 0;
  for (const col of phase0Columns) {
    try {
      db.exec(col.sql);
      phase0Added++;
    } catch { /* column already exists */ }
  }
  if (phase0Added > 0) {
    console.log(`[schema] Task #459 Phase 0: added ${phase0Added} job-template columns to agents`);
  }

  // Ensure job_instructions is the canonical stored column, upgrading legacy pre_instructions when present.
  try {
    const agentCols407 = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>;
    const hasJobInstructions407 = agentCols407.some((c) => c.name === 'job_instructions');
    const hasLegacyPreInstructions407 = agentCols407.some((c) => c.name === 'pre_instructions');

    if (!hasJobInstructions407 && hasLegacyPreInstructions407) {
      db.exec(`ALTER TABLE agents RENAME COLUMN pre_instructions TO job_instructions`);
      console.log('[schema] Task #407: renamed agents.pre_instructions to job_instructions');
    } else if (!hasJobInstructions407) {
      db.exec(`ALTER TABLE agents ADD COLUMN job_instructions TEXT NOT NULL DEFAULT ''`);
      console.log('[schema] Task #407: added job_instructions to agents');
    }

    try {
      db.exec(`UPDATE agents SET job_instructions = pre_instructions WHERE COALESCE(job_instructions, '') = '' AND COALESCE(pre_instructions, '') != ''`);
    } catch {
      /* legacy column may not exist once the rename/drop migration has run */
    }
  } catch (err) {
    console.error('[schema] Task #407: failed to canonicalize agents.job_instructions:', err);
  }

  // Task #586 / Task #407 cleanup needs the canonical agents.job_instructions column to exist first.
  await ensurePipelineIntelligenceTelemetry();

  // Now that agents.job_instructions exists, align instructions.
  alignAgencyReleaseJobInstructions();
  normalizeAgentHqProjectLifecycleInstructions();

  // Task #459 Phase 0 backfill from job_templates removed — Task #579 (table dropped).
  // Agent rows already have their job-template fields populated from prior migrations.

  // ── Task #459 Phase 3: Redirect FK columns from job_templates → agents ──
  // All backfills from job_templates removed — Task #579 (table dropped).
  // agent_id columns on these tables were already populated by prior Phase 3 runs.

  // 3e. Ensure agent_id column exists on task_creation_events
  try {
    db.exec(`ALTER TABLE task_creation_events ADD COLUMN agent_id INTEGER REFERENCES agents(id)`);
    console.log(`[schema] Task #459 Phase 3: added agent_id to task_creation_events`);
  } catch { /* column already exists */ }

  // 3f. Ensure agent_id column exists on task_outcome_metrics
  try {
    db.exec(`ALTER TABLE task_outcome_metrics ADD COLUMN agent_id INTEGER REFERENCES agents(id)`);
    console.log(`[schema] Task #459 Phase 3: added agent_id to task_outcome_metrics`);
  } catch { /* column already exists */ }

  // 3g. Ensure agent_id column exists on dispatch_log
  try {
    db.exec(`ALTER TABLE dispatch_log ADD COLUMN agent_id INTEGER REFERENCES agents(id)`);
    console.log(`[schema] Task #459 Phase 3: added agent_id to dispatch_log`);
  } catch { /* column already exists */ }

  try {
    const defaultTenantId = await tenantDefaultIdForSchemaInit(db);
    await ensureDefaultProjectId(new SqliteAdapter(db));
  } catch (err) {
    console.error('[schema] Failed to ensure default project:', err);
  }

  // Restore foreign-key enforcement disabled for the legacy workflow-policy DDL above.
  //
  // Before this existed, the disable leaked out of initSchema() and stayed off for the
  // life of the process, because the only `foreign_keys = ON` after it sits inside a
  // one-time job_instances migration that has long since run and no longer executes.
  // Enforcement must be back on by the time the API serves its first request.
  if (foreignKeysDisabledForLegacyWorkflowDdl) {
    endIntentionalForeignKeyDisable();
    db.pragma('foreign_keys = ON');
    if (Number(db.pragma('foreign_keys', { simple: true })) !== 1) {
      console.error(
        '[schema] FAILED to restore PRAGMA foreign_keys = ON after schema init' +
        `${db.inTransaction ? ' (still inside a transaction, where the pragma is a no-op)' : ''}` +
        ' — ON DELETE CASCADE will not run and deletes will orphan child rows.'
      );
    }
  }
}

function ensureAgencyDevOpsReleaseLane(): void {
  // No-op: job_templates table has been dropped (task #579)
}

function backfillJobInstanceTokenUsage(): void {
  const db = getRawDb();
  const rows = db.prepare(`
    SELECT id, response, payload_sent, error
    FROM job_instances
    WHERE token_input IS NULL AND token_output IS NULL AND token_total IS NULL
  `).all() as Array<{ id: number; response: string | null; payload_sent: string | null; error: string | null }>;

  const update = db.prepare(`
    UPDATE job_instances
    SET token_input = ?, token_output = ?, token_total = ?
    WHERE id = ?
  `);

  let backfilled = 0;
  for (const row of rows) {
    const parsedSources = [row.response, row.payload_sent, row.error]
      .map(value => {
        if (!value) return null;
        try { return JSON.parse(value); } catch { return null; }
      })
      .filter(Boolean);

    for (const source of parsedSources) {
      const usage = extractTokenUsage(source);
      if (!usage) continue;
      update.run(usage.input, usage.output, usage.total, row.id);
      backfilled += 1;
      break;
    }
  }

  if (backfilled > 0) {
    console.log(`[schema] Backfilled token usage for ${backfilled} job instance(s)`);
  }
}

/**
 * Rewrites any legacy hardcoded /Users/<username>/.openclaw/ references that
 * may exist in DB rows from earlier schema versions. The rawInstructionsByTitle
 * templates now use OPENCLAW_DIR directly, so this is a safety-net for
 * existing DB data migrated from older installs.
 */
function rewriteInstructionPaths(text: string): string {
  // Replace any /Users/<any-user>/.openclaw/ prefix with the runtime path
  return text.replace(/\/Users\/[^/]+\/\.openclaw\//g, `${OPENCLAW_DIR}/`);
}

function alignAgencyReleaseJobInstructions(): void {
  const db = getRawDb();
  const rawInstructionsByTitle: Record<string, string> = {
    'Agency — Frontend': `You are Pixel, the Agency Frontend Engineer. Your session is starting because a frontend task has been assigned.

STARTUP SEQUENCE:
1. Read ${OPENCLAW_DIR}/workspace-agency-frontend/SOUL.md
2. Read ${OPENCLAW_DIR}/workspace-agency-frontend/AGENTS.md
3. Read ${OPENCLAW_DIR}/workspace-agency-frontend/TOOLS.md — your design toolkit

## Your assigned task
The dispatcher has already attached the specific task context above these instructions and Agent HQ already claimed the task for you. Do not change the task status with the generic PUT /tasks/:id endpoint.
Do not scan the task queue — the dispatcher handles task selection.

## Agent HQ environment discipline
- Agent HQ internal work is deployed to a lease-managed Dev/review environment. The lease manager may assign either agent-hq-dev on UI/API ports 3510/3511 or agent-hq-dev-2 on UI/API ports 3520/3521.
- Agent HQ production is the live system on UI/API ports 3500/3501. Production is only for deployed or live-verified work, never normal feature development.
- Do not assume a single Dev target. Use the environment id and review URL returned by the Dev Environment Lease Manager as the handoff target.
- Before starting an Agent HQ task, pull latest origin and create or switch to a feature branch/worktree. Do normal feature work on that branch/worktree, not directly on main.
- For Agent HQ tasks, work in ${OPENCLAW_DIR}/workspace-agency-frontend/agent-hq.
- Start by running: git -C ${OPENCLAW_DIR}/workspace-agency-frontend/agent-hq fetch origin --prune && git -C ${OPENCLAW_DIR}/workspace-agency-frontend/agent-hq pull --ff-only origin main
- Use the Dev Environment Lease Manager MCP tool dev_env_deploy_worktree with queue_if_busy=true before posting implementation handoff. If the shared Dev environment is leased and the deploy is queued, post outcome=dev_deploy_queued instead of blocked.
- Validate and record review evidence against Dev with branch name, commit SHA, and a non-production Dev URL only after Dev is serving the reviewed commit. Do not use main or a production URL as normal feature-review proof.

## Completion workflow
When implementation is ready for QA:
- record structured review evidence with the Agent HQ MCP tool agent_hq_record_review_evidence
- if deploy is queued by the lease manager, use agent_hq_post_task_outcome with outcome=dev_deploy_queued and queue/lease/environment evidence instead of blocked
- then use agent_hq_post_task_outcome with outcome=completed_for_review (this is the ONE AND ONLY exit step — posting this outcome automatically closes the instance)`,
    'Agency — Backend': `You are Forge, the Agency Backend Engineer. Your session is starting because a backend task has been assigned.

STARTUP SEQUENCE:
1. Read ${OPENCLAW_DIR}/workspace-agency-backend/SOUL.md
2. Read ${OPENCLAW_DIR}/workspace-agency-backend/AGENTS.md

## Your assigned task
The dispatcher has already attached the specific task context above these instructions and Agent HQ already claimed the task for you. Do not change the task status with the generic PUT /tasks/:id endpoint.
Do not scan the task queue — the dispatcher handles task selection.

## Agent HQ environment discipline
- Agent HQ internal work is deployed to a lease-managed Dev/review environment. The lease manager may assign either agent-hq-dev on UI/API ports 3510/3511 or agent-hq-dev-2 on UI/API ports 3520/3521.
- Agent HQ production is the live system on UI/API ports 3500/3501. Production is only for deployed or live-verified work, never normal feature development.
- Do not assume a single Dev target. Use the environment id and review URL returned by the Dev Environment Lease Manager as the handoff target.
- Before starting an Agent HQ task, pull latest origin and create or switch to a feature branch/worktree. Do normal feature work on that branch/worktree, not directly on main.
- For Agent HQ tasks, work in ${OPENCLAW_DIR}/workspace-agency-backend/agent-hq.
- Start by running: git -C ${OPENCLAW_DIR}/workspace-agency-backend/agent-hq fetch origin --prune && git -C ${OPENCLAW_DIR}/workspace-agency-backend/agent-hq pull --ff-only origin main
- Use the Dev Environment Lease Manager MCP tool dev_env_deploy_worktree with queue_if_busy=true before posting implementation handoff. If the shared Dev environment is leased and the deploy is queued, post outcome=dev_deploy_queued instead of blocked.
- Implement, validate, and record review evidence against Dev with branch name, commit SHA, and a non-production Dev URL only after Dev is serving the reviewed commit. Do not use main or a production URL as normal feature-review proof.

## Completion workflow
When implementation is ready for QA:
- record structured review evidence with the Agent HQ MCP tool agent_hq_record_review_evidence
- if deploy is queued by the lease manager, use agent_hq_post_task_outcome with outcome=dev_deploy_queued and queue/lease/environment evidence instead of blocked
- then use agent_hq_post_task_outcome with outcome=completed_for_review (this is the ONE AND ONLY exit step — posting this outcome automatically closes the instance)`,
    'Agency — QA': `You are Scout, the Agency QA Engineer. Your session is starting because a review task has been assigned.

STARTUP SEQUENCE:
1. Read ${OPENCLAW_DIR}/workspace-agency-qa/SOUL.md
2. Read ${OPENCLAW_DIR}/workspace-agency-qa/AGENTS.md

## Your assigned task
The dispatcher has already attached the specific review task context above these instructions.
Keep the task in review while you test it. Do not use the generic PUT /tasks/:id endpoint to mark the task done or in_progress.

## Agent HQ environment discipline
- Agent HQ QA/review work must use the lease-selected Dev environment recorded for the task, not a hard-coded port or checkout.
- Valid lease-managed Dev targets are agent-hq-dev on UI/API ports 3510/3511 and agent-hq-dev-2 on UI/API ports 3520/3521.
- Agent HQ production is the live system on UI/API ports 3500/3501. Production is only for deployed or live-verified work, not normal QA proof.
- QA should validate the reviewed branch/commit in the lease-selected Dev environment for Agent HQ internal tasks, not main on production.
- Use the task review URL, task history/workflow-event environment id, and Dev Environment Lease Manager validation/status data to identify the target environment.
- Do not assume 3510/3511 or /Users/nordini/agent-hq-dev. If the lease points at agent-hq-dev-2, use 3520/3521 and /Users/nordini/agent-hq-dev-2.
- Validate the active Dev lease/queue evidence recorded on the task; do not compare the reviewed commit to your QA worktree HEAD.
- If review evidence points to main or a production URL, flag it and fail the handoff unless the task is explicitly a production verification task.

## QA workflow
On PASS:
- record QA evidence with the Agent HQ MCP tool agent_hq_record_qa_evidence using the tested QA URL and verified commit SHA
- use agent_hq_post_task_outcome with outcome=qa_pass (this is the ONE AND ONLY exit step — posting this outcome automatically closes the instance)

On FAIL:
- add a precise task note with repro steps, expected vs actual, severity, tested URL, and verified branch/commit
- use agent_hq_post_task_outcome with outcome=qa_fail (this is the ONE AND ONLY exit step — posting this outcome automatically closes the instance)

Never mark a QA pass as done directly. Agent HQ routes in_progress -> review -> ready_to_merge -> deployed -> done. QA reports outcome=qa_pass from review, which advances the task directly to ready_to_merge.

## How to test
- For Agent HQ internal tasks, prefer the Dev environment first.
- Only use production for explicit live verification after deployment ownership has moved to DevOps / Release.
- Confirm the commit under test matches review evidence before passing the task.`,
    'Agency — DevOps / Release': `You are Harbor, the Agency DevOps / Release engineer. Your session is starting because a ready_to_merge Agent HQ task has been assigned.

STARTUP SEQUENCE:
1. Read ${OPENCLAW_DIR}/workspace-agency-devops/SOUL.md
2. Read ${OPENCLAW_DIR}/workspace-agency-devops/AGENTS.md

## Your assigned task
The dispatcher has already attached the specific task context above these instructions and Agent HQ already claimed the task for you. Do not do normal feature implementation in this workflow state.
Do not scan the task queue — the dispatcher handles task selection.

## Release ownership
You own the release leg only: ready_to_merge -> deployed -> done.
Before release, treat the backend deterministic gate model as the source of truth.
Do not infer QA requirements from status alone.
Instead, confirm the task satisfies its configured transition requirements for release, including:
- review branch evidence
- review commit evidence
- any task-type-specific evidence required by the deterministic gate for deployed_live
- a clear merge/deploy summary
PM-family tasks ('pm', 'pm_analysis', 'pm_operational') intentionally skip QA evidence when their configured transition requirements do not require it.

## Agent HQ environment discipline
- Dev/review targets are lease-managed. Agent HQ internal tasks may have been reviewed on agent-hq-dev on UI/API ports 3510/3511 or agent-hq-dev-2 on UI/API ports 3520/3521.
- Production = UI/API ports 3500/3501. Production runs main and is only for deployed/live-verified work.
- Before release lease transitions, use the lease id and environment id from QA/review evidence; do not assume all review evidence came from agent-hq-dev.
- Merge reviewed work into main, deploy to production, record deploy evidence, then perform live verification.

## Release workflow
1. Confirm the ticket is truly ready_to_merge.
2. Merge the reviewed branch into main.
3. Deploy to production.
4. Record deploy evidence with the Agent HQ MCP tool agent_hq_record_deploy_evidence including merged commit, deployed commit, deploy target, and deployed timestamp.
5. Perform live verification against production.
6. Use agent_hq_post_task_outcome with outcome=deployed_live. (this is the FINAL exit step — posting deployed_live automatically closes the instance and terminates your session)

NOTE: PUT /instances/:id/complete is no longer required. Posting the outcome is the only exit step.
If merge or deploy fails, add a precise task note, report the appropriate failed/blocked outcome (which automatically closes the instance), and do not mark the task done.`,
    'Agency — PM': `You are Wren, the Agency Product Manager / spec lead. Your session is starting because a PM/spec task has been assigned.

STARTUP SEQUENCE:
1. Read ${OPENCLAW_DIR}/workspace-agency-pm/SOUL.md
2. Read ${OPENCLAW_DIR}/workspace-agency-pm/AGENTS.md

## Your assigned task
The dispatcher has already attached the specific task context above these instructions and Agent HQ has already claimed the task for you. Do not scan the task queue — the dispatcher handles task selection.

## What good output looks like
Your job is to turn ambiguity into decisions. For PM/spec tasks, inspect the current product behavior, relevant docs, and nearby task history before finalizing your answer. Produce implementation-ready scope, dependencies, edge cases, and acceptance criteria.

## Typical deliverables
- product/spec notes added back to the task
- clarified implementation plan or ticket split
- explicit edge cases and acceptance criteria
- recommendations on sequencing, dependencies, and tradeoffs

## Completion workflow
When your PM/spec work is complete:
1. Add a concise task note capturing the finished spec / decisions / open questions
   Use agent_hq_add_task_note with author=wren-pm and the spec summary / decisions / edge cases / dependencies.
2. Post the configured PM/spec outcome for the active workflow using agent_hq_post_task_outcome. Do not assume a hardcoded approved_for_merge skip-QA shortcut exists.
3. If the active workflow explicitly routes PM/spec completion straight to ready_to_merge, use that configured outcome. Otherwise use the workflow's resolved PM completion outcome and leave a truthful note summarizing the decision.

## Blocker escalation
If blocked by missing product direction or unclear constraints:
1. Use agent_hq_add_task_note with author=wren-pm and content "BLOCKED: [reason]".
2. Use agent_hq_post_task_outcome with outcome=blocked and summary="BLOCKED: [reason]". Put any workflow-specific blocker details in payload.
3. Use Agent HQ MCP tools for any escalation note; do not call lifecycle HTTP endpoints directly.

## Safety rules
- Do not invent provider/auth capabilities that have not been verified
- Prefer narrower, shippable v1 recommendations over sprawling speculative scope
- Keep implementation and review paths clear enough that frontend/backend agents can execute without guessing`
  };

  // Rewrite any hardcoded /Users/<user>/.openclaw/ paths to the runtime home dir
  const instructionsByTitle: Record<string, string> = Object.fromEntries(
    Object.entries(rawInstructionsByTitle).map(([title, text]) => [title, rewriteInstructionPaths(text)])
  );

  // Task #579: job_templates dropped — update agents.job_instructions directly.
  // Match agents by job_title (which was backfilled from job_templates.title in Phase 0).
  const update = db.prepare(`
    UPDATE agents
    SET job_instructions = ?
    WHERE job_title = ?
      AND job_instructions != ?
  `);

  let changed = 0;
  for (const [title, instructions] of Object.entries(instructionsByTitle)) {
    changed += update.run(instructions, title, instructions).changes;
  }

  if (changed > 0) {
    console.log(`[schema] Updated ${changed} Agency release-pipeline job instruction template(s)`);
  }
}

function normalizeAgentHqProjectLifecycleInstructions(): void {
  const db = getRawDb();
  try {
    const agentColumns = new Set(
      (db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>).map((col) => col.name),
    );
    if (!agentColumns.has('job_instructions') || !agentColumns.has('project_id')) return;

    const projectColumns = new Set(
      (db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>).map((col) => col.name),
    );
    if (!projectColumns.has('id') || !projectColumns.has('name')) return;

    const deletedFilter = agentColumns.has('deleted_at') ? 'AND a.deleted_at IS NULL' : '';
    const rows = db.prepare(`
      SELECT a.id, a.job_instructions
      FROM agents a
      JOIN projects p ON p.id = a.project_id
      WHERE p.name = 'Agent HQ'
        ${deletedFilter}
        AND COALESCE(a.job_instructions, '') != ''
    `).all() as Array<{ id: number; job_instructions: string }>;

    const replacements: Array<[string, string]> = [
      [
        'Lifecycle callbacks are separate control-plane writes; use the Agent HQ MCP task contract tools for notes, evidence, check-ins, and outcomes rather than raw HTTP callback examples.',
        'Lifecycle writes are separate control-plane writes; use the Agent HQ MCP task contract tools for notes, evidence, check-ins, and outcomes rather than raw HTTP callback examples.',
      ],
      [
        'Lifecycle callbacks are separate control-plane writes; use the Agent HQ Task Contract Base URL for notes, evidence, check-ins, and outcomes.',
        'Lifecycle writes are separate control-plane writes; use Agent HQ MCP lifecycle/task tools for notes, evidence, check-ins, and outcomes rather than raw HTTP callback endpoints.',
      ],
      [
        '- Lifecycle/control-plane writes are not product QA proof. For task notes, QA evidence, check-ins, and outcomes, use the Base URL from the Agent HQ Task Contract. Do not substitute the dev API under test unless the contract Base URL explicitly says to.',
        '- Lifecycle/control-plane writes are not product QA proof. For task notes, QA evidence, check-ins, and outcomes, use Agent HQ MCP lifecycle/task tools. Do not substitute the dev API under test for Agent HQ lifecycle writes.',
      ],
      [
        'Canonical task truth comes from the Agent HQ Task Contract Base URL and Agent HQ MCP task context, not from the lease-selected dev environment database.',
        'Canonical task truth comes from Agent HQ MCP task context and Agent HQ MCP lifecycle/task tools, not from the lease-selected dev environment database.',
      ],
      [
        'Lifecycle callbacks to the contract Base URL are required control-plane writes and are not QA proof.',
        'Agent HQ MCP lifecycle writes are required control-plane writes and are not QA proof.',
      ],
      [
        'Use your QA task worktree only for helper scripts, local test setup, and lifecycle callbacks.',
        'Use your QA task worktree only for helper scripts, local test setup, and lifecycle MCP writes.',
      ],
    ];

    const setUpdatedAt = agentColumns.has('job_instructions_updated_at')
      ? ", job_instructions_updated_at = datetime('now')"
      : '';
    const update = db.prepare(`
      UPDATE agents
      SET job_instructions = ?${setUpdatedAt}
      WHERE id = ?
    `);

    let changed = 0;
    for (const row of rows) {
      let next = row.job_instructions;
      for (const [from, to] of replacements) {
        next = next.split(from).join(to);
      }
      if (next === row.job_instructions) continue;
      update.run(next, row.id);
      changed += 1;
    }

    if (changed > 0) {
      console.log(`[schema] Normalized lifecycle wording for ${changed} Agent HQ project agent instruction(s)`);
    }
  } catch (err) {
    console.warn('[schema] Failed to normalize Agent HQ project lifecycle instructions:', err);
  }
}

/**
 * ensureSecurityEventsTable — create the security_events table if it does not
 * exist (task #364 — workspace path boundary enforcement).
 *
 * This table is the Agent HQ audit log for workspace boundary violations.
 * Every time an agent (or any code using the workspaceBoundary utility) attempts
 * to access a path outside its assigned workspace, a row is inserted here.
 *
 * Fields:
 *   event_type  — 'workspace_boundary_violation' (extensible for future events)
 *   agent_id    — FK to agents.id (nullable: violations may occur before dispatch)
 *   instance_id — FK to job_instances.id (nullable)
 *   task_id     — FK to tasks.id (nullable)
 *   details     — JSON blob with attempted_path, resolved_path, workspace_root, detail
 */
function ensureSecurityEventsTable(): void {
  const db = getRawDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS security_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type  TEXT NOT NULL DEFAULT 'workspace_boundary_violation',
      agent_id    INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      instance_id INTEGER REFERENCES job_instances(id) ON DELETE SET NULL,
      task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      details     TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_security_events_agent ON security_events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_security_events_instance ON security_events(instance_id);
    CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type, created_at);
  `);

  console.log('[schema] security_events table ensured');
}

/**
 * backfillAgentOsUsers — set os_user on agents based on their session_key slug.
 *
 * Convention: agents with session_key "agent:<slug>:main" get os_user "agent-<name>"
 * where <name> is the human-friendly slug derived from the agent's name.
 *
 * Known mapping (task #377):
 *   agency-backend  → agent-forge
 *   agency-frontend → agent-pixel
 *   agency-qa       → agent-scout
 *   agency-qa2      → agent-rook
 *   agency-devops   → agent-harbor
 *   agency-pm       → agent-wren
 *   software-engineer → agent-kai
 *   trader          → agent-rex
 *   pulse           → agent-pulse
 *
 * Only sets os_user where it is currently NULL (idempotent, respects manual overrides).
 */
function backfillAgentOsUsers(): void {
  const db = getRawDb();

  const mapping: Record<string, string> = {
    'agent:agency-backend:main':    'agent-forge',
    'agent:agency-frontend:main':   'agent-pixel',
    'agent:agency-qa:main':         'agent-scout',
    'agent:agency-qa2:main':        'agent-rook',
    'agent:agency-devops:main':     'agent-harbor',
    'agent:agency-pm:main':         'agent-wren',
    'agent:software-engineer:main': 'agent-kai',
    'agent:trader:main':            'agent-rex',
    'agent:pulse:main':             'agent-pulse',
  };

  const update = db.prepare(`
    UPDATE agents SET os_user = ? WHERE session_key = ? AND os_user IS NULL
  `);

  let updated = 0;
  for (const [sessionKey, osUser] of Object.entries(mapping)) {
    updated += update.run(osUser, sessionKey).changes;
  }

  if (updated > 0) {
    console.log(`[schema] Backfilled os_user on ${updated} agent(s)`);
  }
}

/**
 * ensureProjectAuditLogTable — create the project_audit_log table if it does
 * not exist (task #457 — project-level audit history).
 *
 * Records audit events for projects, sprints, and job templates so that
 * every structural change to the project hierarchy is traceable.
 *
 * Fields:
 *   project_id  — FK to projects.id (the owning project)
 *   entity_type — 'project' | 'sprint' | 'job_template'
 *   entity_id   — PK of the entity that was changed
 *   action      — 'created' | 'updated' | 'deleted'
 *   actor       — who made the change (user, agent slug, 'system', 'api')
 *   changes     — JSON blob with field-level diffs ({ field: { old, new } })
 */
function ensureProjectAuditLogTable(): void {
  const db = getRawDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS project_audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('project', 'sprint', 'job_template')),
      entity_id   INTEGER NOT NULL,
      action      TEXT NOT NULL CHECK(action IN ('created', 'updated', 'deleted')),
      actor       TEXT NOT NULL DEFAULT 'system',
      changes     TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_project_audit_log_project ON project_audit_log(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_audit_log_entity ON project_audit_log(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_project_audit_log_created ON project_audit_log(created_at);
  `);
}

/**
 * ensureRoutingConfigAuditLogTable — create routing_config_audit_log if it does not exist.
 *
 * Mirrors db/pg-migrations/14-routing-config-audit-log.sql. It is deliberately NOT folded
 * into project_audit_log: that table pins entity_type to ('project','sprint','job_template'),
 * requires a project_id, and has no tenant_id, while routing rows are tenant-scoped and are
 * legitimately project-less. Its CREATE TABLE IF NOT EXISTS above can never widen an existing
 * table anyway, so a second table is the only way either engine gets these columns.
 *
 * Takes a Db rather than the raw driver so the same DDL builds the table on PostgreSQL, where
 * the test template carries db/pg-baseline only and therefore does not include migration 14.
 */
export async function ensureRoutingConfigAuditLogTable(db: Db): Promise<void> {
  // The workflow table is still `sprints` on SQLite and on any PostgreSQL database that has
  // not applied the rename in migration 10, and `workflows` on one that has. A missing FK
  // target aborts the whole CREATE on PostgreSQL, so resolve it rather than name it.
  const workflowTable = await dbTableExists(db, 'workflows') ? 'workflows' : 'sprints';

  await db.exec(`
    CREATE TABLE IF NOT EXISTS routing_config_audit_log (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id               INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      project_id              INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      workflow_type           TEXT NOT NULL,
      workflow_id             INTEGER REFERENCES ${workflowTable}(id) ON DELETE SET NULL,
      entity_table            TEXT NOT NULL,
      entity_id               INTEGER,
      entity_key              TEXT NOT NULL DEFAULT '',
      action                  TEXT NOT NULL,
      actor                   TEXT NOT NULL DEFAULT 'unknown',
      actor_kind              TEXT NOT NULL DEFAULT 'unknown',
      before_json             TEXT NOT NULL DEFAULT 'null',
      after_json              TEXT NOT NULL DEFAULT 'null',
      changes                 TEXT NOT NULL DEFAULT '{}',
      batch_id                TEXT NOT NULL DEFAULT '',
      affected_workflow_count INTEGER,
      created_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_routing_config_audit_log_tenant ON routing_config_audit_log(tenant_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_routing_config_audit_log_project ON routing_config_audit_log(project_id);
    CREATE INDEX IF NOT EXISTS idx_routing_config_audit_log_entity ON routing_config_audit_log(entity_table, entity_id);
    CREATE INDEX IF NOT EXISTS idx_routing_config_audit_log_batch ON routing_config_audit_log(batch_id);
    CREATE INDEX IF NOT EXISTS idx_routing_config_audit_log_created ON routing_config_audit_log(created_at);
  `);
}

/**
 * ensureDefectTrackingColumns — Task #535: add origin_task_id + defect_type
 * to tasks, spawned_defects to task_outcome_metrics, and backfill task #534.
 */
function ensureDefectTrackingColumns(): void {
  const db = getRawDb();

  // 1. Add origin_task_id to tasks
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN origin_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_origin ON tasks(origin_task_id)`);
    console.log('[schema] Migrated: added origin_task_id to tasks');
  } catch (_) { /* column already exists */ }

  // 2. Add defect_type to tasks
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN defect_type TEXT DEFAULT NULL`);
    console.log('[schema] Migrated: added defect_type to tasks');
  } catch (_) { /* column already exists */ }

  // 3. Add spawned_defects to task_outcome_metrics
  try {
    db.exec(`ALTER TABLE task_outcome_metrics ADD COLUMN spawned_defects INTEGER NOT NULL DEFAULT 0`);
    console.log('[schema] Migrated: added spawned_defects to task_outcome_metrics');
  } catch (_) { /* column already exists */ }

  // Ensure index exists (idempotent)
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_origin ON tasks(origin_task_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_defect_type ON tasks(defect_type)`);
  } catch (_) { /* already exists */ }

  // 4. Backfill task #534 → origin_task_id=532, defect_type=qa_miss
  try {
    const task534 = db.prepare(`SELECT id, origin_task_id FROM tasks WHERE id = 534`).get() as { id: number; origin_task_id: number | null } | undefined;
    if (task534 && task534.origin_task_id === null) {
      // Check task 532 exists
      const task532 = db.prepare(`SELECT id FROM tasks WHERE id = 532`).get() as { id: number } | undefined;
      if (task532) {
        db.prepare(`UPDATE tasks SET origin_task_id = 532, defect_type = 'qa_miss' WHERE id = 534`).run();
        // Upsert spawned_defects on task 532's outcome metrics
        const existingMetrics = db.prepare(`SELECT id FROM task_outcome_metrics WHERE task_id = 532`).get() as { id: number } | undefined;
        if (existingMetrics) {
          db.prepare(`UPDATE task_outcome_metrics SET spawned_defects = spawned_defects + 1 WHERE task_id = 532`).run();
        } else {
          db.prepare(`
            INSERT INTO task_outcome_metrics (task_id, spawned_defects)
            VALUES (532, 1)
          `).run();
        }
        console.log('[schema] Backfilled: task #534 origin_task_id=532, defect_type=qa_miss');
      }
    }
  } catch (err) {
    console.warn('[schema] Defect backfill skipped:', err);
  }
}

function ensureAppSettingsTable(): void {
  const db = getRawDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

type RegistryProvisionOptions = {
  provisionDefaults?: boolean;
};

/**
 * ensureToolRegistryTables — Task #557: tools + agent_tool_assignments tables.
 *
 * Normal API startup must only ensure table shape. Default tool rows and agent
 * assignments are explicit bootstrap/admin provisioning, not restart side effects.
 */
export function ensureToolRegistryTables(options: RegistryProvisionOptions = {}): void {
  const db = getRawDb();

  const tableExists = (name: string): boolean => {
    const row = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
    return Boolean(row);
  };
  const getTableSql = (name: string): string => {
    return (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) as { sql?: string } | undefined)?.sql ?? '';
  };
  const getColumns = (name: string): string[] => {
    return (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).map((col) => col.name);
  };
  const getDefaultTenantId = (): number => {
    try {
      const fromSetting = db.prepare(`SELECT value FROM app_settings WHERE key = 'default_tenant_id' LIMIT 1`).get() as { value?: string } | undefined;
      const configured = Number(fromSetting?.value ?? '');
      if (Number.isInteger(configured) && configured > 0) return configured;
    } catch { /* app_settings may not exist in legacy/minimal bootstrap tests */ }
    try {
      const defaultTenant = db.prepare(`SELECT id FROM tenants WHERE is_default = 1 ORDER BY id ASC LIMIT 1`).get() as { id?: number } | undefined;
      const candidate = Number(defaultTenant?.id ?? 0);
      if (Number.isInteger(candidate) && candidate > 0) return candidate;
    } catch { /* tenants may not exist in legacy/minimal bootstrap tests */ }
    return 1;
  };
  const hasUniqueIndexExactly = (tableName: string, columns: string[]): boolean => {
    try {
      const indexes = db.prepare(`PRAGMA index_list(${tableName})`).all() as Array<{ name: string; unique: number }>;
      return indexes.some((index) => {
        if (!index.unique) return false;
        const indexedColumns = (db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>).map((col) => col.name);
        return indexedColumns.length === columns.length && indexedColumns.every((column, idx) => column === columns[idx]);
      });
    } catch {
      return false;
    }
  };
  const assignmentToolForeignKeyTargetsTools = (): boolean => {
    try {
      const foreignKeys = db.prepare(`PRAGMA foreign_key_list(agent_tool_assignments)`).all() as Array<{ from: string; table: string }>;
      const toolForeignKey = foreignKeys.find((fk) => fk.from === 'tool_id');
      return toolForeignKey?.table === 'tools';
    } catch {
      return false;
    }
  };
  const createToolsTableSql = `
    CREATE TABLE IF NOT EXISTS tools (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id            INTEGER NOT NULL DEFAULT 1,
      name                 TEXT NOT NULL,
      slug                 TEXT NOT NULL,
      description          TEXT NOT NULL DEFAULT '',
      implementation_type  TEXT NOT NULL DEFAULT 'bash' CHECK(implementation_type IN ('bash','shell','script','mcp','function','http')),
      implementation_body  TEXT NOT NULL DEFAULT '',
      input_schema         TEXT NOT NULL DEFAULT '{}',
      permissions          TEXT NOT NULL DEFAULT 'read_only' CHECK(permissions IN ('read_only','read_write','exec','network')),
      tags                 TEXT NOT NULL DEFAULT '[]',
      enabled              INTEGER NOT NULL DEFAULT 1,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, slug)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tools_tenant_slug ON tools(tenant_id, slug);
    CREATE INDEX IF NOT EXISTS idx_tools_slug ON tools(slug);
    CREATE INDEX IF NOT EXISTS idx_tools_tenant ON tools(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_tools_enabled ON tools(enabled);
  `;

  const rebuildToolsTable = (): void => {
    const sourceColumns = new Set(getColumns('tools'));
    const tempTable = `tools_rebuild_${Date.now()}`;
    const targetColumns = [
      'id',
      'tenant_id',
      'name',
      'slug',
      'description',
      'implementation_type',
      'implementation_body',
      'input_schema',
      'permissions',
      'tags',
      'enabled',
      'created_at',
      'updated_at',
    ];
    const selectExpressionByColumn: Record<string, string> = {
      id: sourceColumns.has('id') ? 'id' : 'NULL AS id',
      tenant_id: sourceColumns.has('tenant_id') ? `COALESCE(tenant_id, ${getDefaultTenantId()}) AS tenant_id` : `${getDefaultTenantId()} AS tenant_id`,
      name: sourceColumns.has('name') && sourceColumns.has('slug')
        ? 'COALESCE(name, slug, \'Tool \' || id) AS name'
        : sourceColumns.has('name')
          ? 'COALESCE(name, \'Tool \' || id) AS name'
          : sourceColumns.has('slug')
            ? 'slug AS name'
            : "'Tool ' || id AS name",
      slug: sourceColumns.has('slug')
        ? 'COALESCE(slug, \'tool-\' || id) AS slug'
        : "'tool-' || id AS slug",
      description: sourceColumns.has('description') ? 'COALESCE(description, \'\') AS description' : "'' AS description",
      implementation_type: sourceColumns.has('implementation_type')
        ? `
          CASE implementation_type
            WHEN 'bash' THEN 'bash'
            WHEN 'shell' THEN 'shell'
            WHEN 'script' THEN 'script'
            WHEN 'mcp' THEN 'mcp'
            WHEN 'function' THEN 'function'
            WHEN 'http' THEN 'http'
            ELSE 'bash'
          END AS implementation_type
        `
        : "'bash' AS implementation_type",
      implementation_body: sourceColumns.has('implementation_body') ? 'COALESCE(implementation_body, \'\') AS implementation_body' : "'' AS implementation_body",
      input_schema: sourceColumns.has('input_schema') ? 'COALESCE(input_schema, \'{}\') AS input_schema' : "'{}' AS input_schema",
      permissions: sourceColumns.has('permissions')
        ? `
          CASE permissions
            WHEN 'read_only' THEN 'read_only'
            WHEN 'read_write' THEN 'read_write'
            WHEN 'exec' THEN 'exec'
            WHEN 'network' THEN 'network'
            ELSE 'read_only'
          END AS permissions
        `
        : "'read_only' AS permissions",
      tags: sourceColumns.has('tags') ? 'COALESCE(tags, \'[]\') AS tags' : "'[]' AS tags",
      enabled: sourceColumns.has('enabled') ? 'COALESCE(enabled, 1) AS enabled' : '1 AS enabled',
      created_at: sourceColumns.has('created_at') ? 'COALESCE(created_at, datetime(\'now\')) AS created_at' : "datetime('now') AS created_at",
      updated_at: sourceColumns.has('updated_at') ? 'COALESCE(updated_at, datetime(\'now\')) AS updated_at' : "datetime('now') AS updated_at",
    };

    db.pragma('foreign_keys = OFF');
    const rebuild = db.transaction(() => {
      db.prepare(`ALTER TABLE tools RENAME TO ${tempTable}`).run();
      db.exec(`
      CREATE TABLE tools (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id            INTEGER NOT NULL DEFAULT 1,
        name                 TEXT NOT NULL,
        slug                 TEXT NOT NULL,
        description          TEXT NOT NULL DEFAULT '',
        implementation_type  TEXT NOT NULL DEFAULT 'bash' CHECK(implementation_type IN ('bash','shell','script','mcp','function','http')),
        implementation_body  TEXT NOT NULL DEFAULT '',
        input_schema         TEXT NOT NULL DEFAULT '{}',
        permissions          TEXT NOT NULL DEFAULT 'read_only' CHECK(permissions IN ('read_only','read_write','exec','network')),
        tags                 TEXT NOT NULL DEFAULT '[]',
        enabled              INTEGER NOT NULL DEFAULT 1,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, slug)
      );
      `);
      db.prepare(`
        INSERT OR IGNORE INTO tools (id, tenant_id, name, slug, description, implementation_type, implementation_body, input_schema, permissions, tags, enabled, created_at, updated_at)
        SELECT ${targetColumns.map((column) => selectExpressionByColumn[column]).join(', ')}
        FROM ${tempTable}
      `).run();
      db.prepare(`DROP TABLE ${tempTable}`).run();
    });
    try {
      rebuild();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tools_tenant_slug ON tools(tenant_id, slug);
      CREATE INDEX IF NOT EXISTS idx_tools_slug ON tools(slug);
      CREATE INDEX IF NOT EXISTS idx_tools_tenant ON tools(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_tools_enabled ON tools(enabled);
    `);
    console.log('[schema] Migrated: rebuilt tools table for current capability execution types');
  };

  if (!tableExists('tools')) {
    db.exec(createToolsTableSql);
  } else {
    const toolsTableSql = getTableSql('tools');
    const toolColumns = new Set(getColumns('tools'));
    const requiredColumns = [
      'id',
      'tenant_id',
      'name',
      'slug',
      'description',
      'implementation_type',
      'implementation_body',
      'input_schema',
      'permissions',
      'tags',
      'enabled',
      'created_at',
      'updated_at',
    ];
    const missingRequiredColumn = requiredColumns.some((column) => !toolColumns.has(column));
    const legacyImplementationCheck = Boolean(toolsTableSql) && (!toolsTableSql.includes("'shell'") || !toolsTableSql.includes("'script'"));
    const legacyGlobalSlugUniqueness = /slug\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(toolsTableSql)
      || hasUniqueIndexExactly('tools', ['slug'])
      || !toolsTableSql.includes('UNIQUE(tenant_id, slug)');
    if (missingRequiredColumn || legacyImplementationCheck || legacyGlobalSlugUniqueness) {
      rebuildToolsTable();
    } else {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tools_tenant_slug ON tools(tenant_id, slug);
        CREATE INDEX IF NOT EXISTS idx_tools_slug ON tools(slug);
        CREATE INDEX IF NOT EXISTS idx_tools_tenant ON tools(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_tools_enabled ON tools(enabled);
      `);
    }
  }

  // agent_tool_assignments table
  const createAgentToolAssignmentsSql = `
    CREATE TABLE IF NOT EXISTS agent_tool_assignments (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id  INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      tool_id   INTEGER NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
      overrides TEXT NOT NULL DEFAULT '{}',
      enabled   INTEGER NOT NULL DEFAULT 1,
      UNIQUE(agent_id, tool_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ata_agent ON agent_tool_assignments(agent_id);
    CREATE INDEX IF NOT EXISTS idx_ata_tool ON agent_tool_assignments(tool_id);
  `;
  const rebuildAgentToolAssignmentsTable = (): void => {
    const sourceColumns = new Set(getColumns('agent_tool_assignments'));
    const tempTable = `agent_tool_assignments_rebuild_${Date.now()}`;
    const targetColumns = ['id', 'agent_id', 'tool_id', 'overrides', 'enabled'];
    const selectExpressionByColumn: Record<string, string> = {
      id: sourceColumns.has('id') ? 'id' : 'NULL AS id',
      agent_id: sourceColumns.has('agent_id') ? 'agent_id' : 'NULL AS agent_id',
      tool_id: sourceColumns.has('tool_id') ? 'tool_id' : 'NULL AS tool_id',
      overrides: sourceColumns.has('overrides') ? 'COALESCE(overrides, \'{}\') AS overrides' : "'{}' AS overrides",
      enabled: sourceColumns.has('enabled') ? 'COALESCE(enabled, 1) AS enabled' : '1 AS enabled',
    };

    db.pragma('foreign_keys = OFF');
    const rebuild = db.transaction(() => {
      db.prepare(`ALTER TABLE agent_tool_assignments RENAME TO ${tempTable}`).run();
      db.exec(`
        CREATE TABLE agent_tool_assignments (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id  INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          tool_id   INTEGER NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
          overrides TEXT NOT NULL DEFAULT '{}',
          enabled   INTEGER NOT NULL DEFAULT 1,
          UNIQUE(agent_id, tool_id)
        );
      `);
      if (sourceColumns.has('agent_id') && sourceColumns.has('tool_id')) {
        db.prepare(`
          INSERT OR IGNORE INTO agent_tool_assignments (id, agent_id, tool_id, overrides, enabled)
          SELECT ${targetColumns.map((column) => selectExpressionByColumn[column]).join(', ')}
          FROM ${tempTable}
          WHERE agent_id IS NOT NULL AND tool_id IS NOT NULL
        `).run();
      }
      db.prepare(`DROP TABLE ${tempTable}`).run();
    });
    try {
      rebuild();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ata_agent ON agent_tool_assignments(agent_id);
      CREATE INDEX IF NOT EXISTS idx_ata_tool ON agent_tool_assignments(tool_id);
    `);
    console.log('[schema] Migrated: rebuilt agent_tool_assignments with current tools foreign key');
  };

  if (!tableExists('agent_tool_assignments')) {
    db.exec(createAgentToolAssignmentsSql);
  } else {
    const assignmentColumns = new Set(getColumns('agent_tool_assignments'));
    const missingAssignmentColumn = ['id', 'agent_id', 'tool_id', 'overrides', 'enabled'].some((column) => !assignmentColumns.has(column));
    if (missingAssignmentColumn || !assignmentToolForeignKeyTargetsTools()) {
      rebuildAgentToolAssignmentsTable();
    } else {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_ata_agent ON agent_tool_assignments(agent_id);
        CREATE INDEX IF NOT EXISTS idx_ata_tool ON agent_tool_assignments(tool_id);
      `);
    }
  }

  const agentsHaveTenantId = tableExists('agents') && getColumns('agents').includes('tenant_id');
  if (agentsHaveTenantId) {
    try {
      const removed = db.prepare(`
        DELETE FROM agent_tool_assignments
        WHERE EXISTS (
          SELECT 1
          FROM agents a
          JOIN tools t ON t.id = agent_tool_assignments.tool_id
          WHERE a.id = agent_tool_assignments.agent_id
            AND a.tenant_id IS NOT NULL
            AND t.tenant_id IS NOT NULL
            AND a.tenant_id <> t.tenant_id
        )
      `).run();
      if (removed.changes > 0) {
        console.warn(`[schema] Removed ${removed.changes} stale cross-tenant tool assignment(s)`);
      }
    } catch (err) {
      console.warn('[schema] Cross-tenant tool assignment cleanup skipped:', err);
    }
  }

  if (!options.provisionDefaults) return;

  // Seed tool registry defaults and keep them up to date for explicit provisioning.
  const upsertTool = db.prepare(`
    INSERT INTO tools (tenant_id, name, slug, description, implementation_type, implementation_body, input_schema, permissions, tags, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(tenant_id, slug) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      implementation_type = excluded.implementation_type,
      implementation_body = excluded.implementation_body,
      input_schema = excluded.input_schema,
      permissions = excluded.permissions,
      tags = excluded.tags,
      enabled = 1,
      updated_at = datetime('now')
  `);
  const assignToolToAgentByName = db.prepare(agentsHaveTenantId ? `
    INSERT INTO agent_tool_assignments (agent_id, tool_id, overrides, enabled)
    SELECT a.id, t.id, '{}', 1
    FROM agents a
    JOIN tools t ON t.slug = ? AND t.tenant_id = a.tenant_id
    WHERE lower(a.name) = lower(?)
      AND NOT EXISTS (
        SELECT 1 FROM agent_tool_assignments ata
        WHERE ata.agent_id = a.id AND ata.tool_id = t.id
      )
  ` : `
    INSERT INTO agent_tool_assignments (agent_id, tool_id, overrides, enabled)
    SELECT a.id, t.id, '{}', 1
    FROM agents a
    JOIN tools t ON t.slug = ? AND t.tenant_id = ${getDefaultTenantId()}
    WHERE lower(a.name) = lower(?)
      AND NOT EXISTS (
        SELECT 1 FROM agent_tool_assignments ata
        WHERE ata.agent_id = a.id AND ata.tool_id = t.id
      )
  `);

  const structuredExploreCodebaseScript = String.raw`import json
import os
import re
from pathlib import Path

IGNORE_DIRS = {
    '.git',
    'node_modules',
    'dist',
    'build',
    '.next',
    'coverage',
    '.turbo',
    '.cache',
    '__pycache__',
    '.venv',
    'venv',
}
TEXT_SUFFIXES = {
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.py',
    '.sh',
    '.json',
    '.md',
    '.yml',
    '.yaml',
}
ENTRY_NAMES = {
    'package.json',
    'tsconfig.json',
    'README.md',
    'src',
    'api',
    'ui',
    'app',
    'server',
    'index.ts',
    'index.js',
    'main.ts',
    'main.js',
}
MAX_FILES = 600
MAX_KEY_FILES = 20
MAX_ENTRY_POINTS = 20
MAX_PATTERN_LINES = 20


def load_input():
    raw = os.environ.get('TOOL_INPUT', '{}')
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def env_value(*names, default=''):
    for name in names:
        value = os.environ.get(name)
        if value not in (None, ''):
            return value
    return default


def coerce_depth(value):
    try:
        return max(1, min(6, int(float(value))))
    except Exception:
        return 2


def tokenize(value):
    return [part.lower() for part in re.findall(r'[A-Za-z0-9_/-]+', value or '') if len(part) >= 3]


def is_text_file(path):
    return path.suffix in TEXT_SUFFIXES or path.name in ENTRY_NAMES


def safe_relative(path, root):
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return os.path.relpath(path, root)


def iter_paths(root, max_entries=MAX_FILES):
    seen = 0
    for current_root, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in IGNORE_DIRS)
        current = Path(current_root)
        for dirname in dirs:
            yield current / dirname
            seen += 1
            if seen >= max_entries:
                return
        for filename in sorted(files):
            yield current / filename
            seen += 1
            if seen >= max_entries:
                return


def path_score(path, root, focus, terms):
    if not focus and not terms:
        return 0
    rel = safe_relative(path, root).lower()
    name = path.name.lower()
    focus_lower = focus.lower()
    score = 0
    if focus_lower and focus_lower in rel:
        score += 50
    if focus_lower and focus_lower in name:
        score += 25
    for term in terms:
        if term in rel:
            score += 3
        if term in name:
            score += 2
    return score


def find_focus_target(root, focus, terms):
    if not focus:
        return root, False
    candidate = (root / focus).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        candidate = root / focus
    if candidate.exists():
        return candidate, True

    best = None
    focus_lower = focus.lower()
    for path in iter_paths(root):
        rel = safe_relative(path, root).lower()
        if focus_lower not in rel and focus_lower not in path.name.lower():
            continue
        score = path_score(path, root, focus, terms)
        if best is None or score > path_score(best, root, focus, terms):
            best = path
    if not best:
        return root, False
    return (best if best.is_dir() else best.parent), True


def walk_for_files(search_root, root, focus, terms, depth):
    entry_points = []
    scored_key_files = []
    fallback_files = []
    visited_files = 0

    for current_root, dirs, files in os.walk(search_root):
        current = Path(current_root)
        dirs[:] = sorted(d for d in dirs if d not in IGNORE_DIRS)
        rel_depth = 0 if current == search_root else len(current.relative_to(search_root).parts)
        if rel_depth >= depth:
            dirs[:] = []

        for dirname in dirs:
            if dirname in ENTRY_NAMES and len(entry_points) < MAX_ENTRY_POINTS:
                entry_points.append(safe_relative(current / dirname, root))

        for filename in sorted(files):
            path = current / filename
            if not is_text_file(path):
                continue
            visited_files += 1
            rel = safe_relative(path, root)
            if filename in ENTRY_NAMES or path.suffix in {'.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.sh'}:
                if len(entry_points) < MAX_ENTRY_POINTS:
                    entry_points.append(rel)
            score = path_score(path, root, focus, terms)
            if score > 0:
                scored_key_files.append((score, rel))
            elif len(fallback_files) < MAX_KEY_FILES:
                fallback_files.append(rel)
            if visited_files >= MAX_FILES:
                dirs[:] = []
                break

    key_files = [rel for _, rel in sorted(scored_key_files, key=lambda item: (-item[0], item[1]))]
    key_files.extend(rel for rel in fallback_files if rel not in key_files)
    return unique_sorted(entry_points, MAX_ENTRY_POINTS), unique_ordered(key_files, MAX_KEY_FILES)


def unique_ordered(values, limit):
    seen = set()
    out = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
        if len(out) >= limit:
            break
    return out


def unique_sorted(values, limit):
    return sorted(dict.fromkeys(values))[:limit]


def read_text(path, max_bytes=200_000):
    try:
        with open(path, 'rb') as handle:
            data = handle.read(max_bytes)
        return data.decode('utf-8', errors='replace')
    except Exception:
        return ''


def build_imports_map(root, key_files):
    imports = {}
    patterns = [
        re.compile(r"^import\s+.*?\s+from\s+['\"]([^'\"]+)['\"]", re.M),
        re.compile(r"^export\s+.*?\s+from\s+['\"]([^'\"]+)['\"]", re.M),
        re.compile(r"require\(\s*['\"]([^'\"]+)['\"]\s*\)"),
    ]
    for rel in key_files[:8]:
        text = read_text(root / rel)
        if not text:
            continue
        matches = []
        for pattern in patterns:
            matches.extend(pattern.findall(text))
        if matches:
            imports[rel] = unique_ordered(matches, 20)
    return imports


def line_matches(line, focus, terms):
    text = line.lower()
    if focus and focus.lower() in text:
        return True
    unique_terms = set(terms)
    minimum_hits = 1 if len(unique_terms) <= 2 else 2
    return sum(1 for term in unique_terms if term in text) >= minimum_hits


def find_relevant_patterns(search_root, root, focus, terms, priority_files=None):
    if not focus and not terms:
        return []
    matches = []
    seen_paths = set()

    def scan_file(path):
        text = read_text(path, max_bytes=120_000)
        if not text:
            return
        rel = safe_relative(path, root)
        for line_number, line in enumerate(text.splitlines(), start=1):
            if line_matches(line, focus, terms):
                matches.append(f'{rel}:{line_number}:{line.strip()[:240]}')
                if len(matches) >= MAX_PATTERN_LINES:
                    return

    for rel in priority_files or []:
        path = root / rel
        if path.is_file() and is_text_file(path):
            seen_paths.add(path.resolve())
            scan_file(path)
            if len(matches) >= MAX_PATTERN_LINES:
                return matches

    scanned = 0
    for path in iter_paths(search_root):
        if not path.is_file() or not is_text_file(path):
            continue
        resolved = path.resolve()
        if resolved in seen_paths:
            continue
        seen_paths.add(resolved)
        scanned += 1
        scan_file(path)
        if len(matches) >= MAX_PATTERN_LINES:
            return matches
        if scanned >= MAX_FILES:
            break
    return matches


def main():
    tool_input = load_input()
    root = Path(env_value('WORKSPACE', 'PWD', default=os.getcwd())).expanduser().resolve()
    focus = str(tool_input.get('focus') or env_value('FOCUS', 'focus', 'TOOL_FOCUS', default='')).strip()
    depth = coerce_depth(tool_input.get('depth') or env_value('DEPTH', 'depth', 'TOOL_DEPTH', default='2'))
    terms = tokenize(focus)

    if not root.exists():
        print(json.dumps({
            'root': str(root),
            'focus': focus or None,
            'depth': depth,
            'error': 'workspace root not found',
        }, indent=2))
        return

    search_root, focus_target_found = find_focus_target(root, focus, terms)
    if not search_root.exists():
        print(json.dumps({
            'root': str(root),
            'focus': focus or None,
            'depth': depth,
            'error': 'focus target not found',
        }, indent=2))
        return

    if search_root.is_file():
        key_files = [safe_relative(search_root, root)] if is_text_file(search_root) else []
        entry_points = key_files[:]
    else:
        entry_points, key_files = walk_for_files(search_root, root, focus, terms, depth)

    print(json.dumps({
        'root': str(root),
        'search_root': str(search_root),
        'focus': focus or None,
        'focus_target_found': focus_target_found,
        'depth': depth,
        'entry_points': entry_points,
        'key_files': key_files,
        'imports_map': build_imports_map(root, key_files),
        'relevant_patterns': find_relevant_patterns(search_root, root, focus, terms, key_files),
    }, indent=2))


if __name__ == '__main__':
    main()
`;

  const seedTx = db.transaction(() => {
    upsertTool.run(
      getDefaultTenantId(),
      'Explore Codebase',
      'explore_codebase',
      'Explore the codebase structure before making changes. Call this at the start of any task to understand entry points, key files, and the call chain relevant to your work. Returns a structured map.',
      'script',
      JSON.stringify({ command: 'python3', inline: structuredExploreCodebaseScript }),
      JSON.stringify({
        type: 'object',
        properties: {
          focus: { type: 'string', description: 'Area of codebase to focus on (file path, module name, or feature)' },
          depth: { type: 'number', description: 'How many levels deep to explore (default 2)' },
        },
        required: [],
      }),
      'read_only',
      JSON.stringify(['filesystem', 'exploration', 'devtools']),
    );
    upsertTool.run(
      getDefaultTenantId(),
      'Bash',
      'bash',
      'Execute an arbitrary bash command. Use for build steps, tests, git operations, and general automation.',
      'bash',
      '${COMMAND}',
      JSON.stringify({ type: 'object', properties: { command: { type: 'string', description: 'The bash command to execute' } }, required: ['command'] }),
      'exec',
      JSON.stringify(['shell', 'automation']),
    );
    upsertTool.run(
      getDefaultTenantId(),
      'File Edit',
      'file_edit',
      'Read, create, or edit a file at a given path. Supports full-file writes and patch-style edits.',
      'function',
      'file_edit_handler',
      JSON.stringify({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path' },
          content: { type: 'string', description: 'New file content (full replace) or patch' },
          mode: { type: 'string', enum: ['write', 'patch', 'read'], description: 'Operation mode' },
        },
        required: ['path'],
      }),
      'read_write',
      JSON.stringify(['filesystem', 'editing']),
    );
    upsertTool.run(
      getDefaultTenantId(),
      'Git Worktree Enter',
      'git_worktree_enter',
      'Create an isolated git worktree for the task and return the created worktree path.',
      'bash',
      'set -euo pipefail\nBRANCH="${BRANCH:?branch is required}"\nBASE="${BASE:-main}"\nREPO="${REPO_PATH:-${WORKSPACE:-${PWD}}}"\nmkdir -p "$REPO/../worktrees"\nWT_PATH="$REPO/../worktrees/$BRANCH"\ngit -C "$REPO" worktree add "$WT_PATH" -b "$BRANCH" "$BASE"\nprintf "branch=%s\\nbase=%s\\nworktree_path=%s\\n" "$BRANCH" "$BASE" "$WT_PATH"',
      JSON.stringify({
        type: 'object',
        properties: {
          branch: { type: 'string', description: 'Branch name to create/checkout in the worktree' },
          base: { type: 'string', description: 'Base branch to branch from (default: main)' },
        },
        required: ['branch'],
      }),
      'exec',
      JSON.stringify(['git', 'worktree', 'devtools']),
    );
    upsertTool.run(
      getDefaultTenantId(),
      'Git Worktree Exit',
      'git_worktree_exit',
      'Remove an isolated git worktree after task completion.',
      'bash',
      'set -euo pipefail\nBRANCH="${BRANCH:?branch is required}"\nREPO="${REPO_PATH:-${WORKSPACE:-${PWD}}}"\nWT_PATH="$REPO/../worktrees/$BRANCH"\ngit -C "$REPO" worktree remove "$WT_PATH" --force\nprintf "branch=%s\\nworktree_path=%s\\nremoved=true\\n" "$BRANCH" "$WT_PATH"',
      JSON.stringify({
        type: 'object',
        properties: {
          branch: { type: 'string' },
        },
        required: ['branch'],
      }),
      'exec',
      JSON.stringify(['git', 'worktree', 'devtools']),
    );

    for (const agentName of ['Forge', 'Kai']) {
      assignToolToAgentByName.run('explore_codebase', agentName);
      assignToolToAgentByName.run('git_worktree_enter', agentName);
      assignToolToAgentByName.run('git_worktree_exit', agentName);
    }
    upsertTool.run(
      getDefaultTenantId(),
      'Local STT Transcription',
      'local_stt_transcribe',
      'Transcribe a local audio file to plain text using host-local speech-to-text tooling. Optimized for Telegram voice notes, but reusable for generic audio files. Returns transcript text on success and clear errors for missing dependencies, unsupported inputs, or transcription failure.',
      'bash',
      `set -euo pipefail

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

fail() {
  local code="$1"
  local message="$2"
  printf '{"ok":false,"error_code":"%s","message":%s}\n' "$code" "$(printf '%s' "$message" | json_escape)"
  exit 0
}

if ! command -v python3 >/dev/null 2>&1; then
  fail missing_runtime 'python3 is required for local transcription but is not installed on this host'
fi

AUDIO_PATH="\${TOOL_AUDIO_PATH:-\${TOOL_PATH:-}}"
LANGUAGE="\${TOOL_LANGUAGE:-}"
MODEL="\${TOOL_MODEL:-base}"
PROMPT="\${TOOL_PROMPT:-}"

if [ -z "$AUDIO_PATH" ]; then
  fail missing_input 'audio_path is required'
fi

case "$AUDIO_PATH" in
  /*) ;;
  *) AUDIO_PATH="$(pwd)/$AUDIO_PATH" ;;
esac

if [ ! -f "$AUDIO_PATH" ]; then
  fail missing_file "audio file not found: $AUDIO_PATH"
fi

case "\${AUDIO_PATH##*.}" in
  ogg|oga|opus|mp3|wav|m4a|mp4|mpeg|mpga|webm) ;;
  *) fail unsupported_format "unsupported audio format for local_stt_transcribe: $AUDIO_PATH" ;;
esac

if ! python3 - <<'PY' >/dev/null 2>&1
import importlib.util, sys
sys.exit(0 if importlib.util.find_spec('whisper') else 1)
PY
then
  fail missing_dependency 'python package whisper is not installed. Install with: python3 -m pip install -U openai-whisper'
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  fail missing_dependency 'ffmpeg is required for local transcription but is not installed. Install with: brew install ffmpeg'
fi

export AUDIO_PATH LANGUAGE MODEL PROMPT
python3 - <<'PY'
import json, os
try:
    import whisper
except Exception as exc:
    print(json.dumps({
        'ok': False,
        'error_code': 'missing_dependency',
        'message': f'Failed to import whisper: {exc}',
    }))
    raise SystemExit(0)

audio_path = os.environ['AUDIO_PATH']
language = os.environ.get('LANGUAGE') or None
model_name = os.environ.get('MODEL') or 'base'
prompt = os.environ.get('PROMPT') or None

try:
    model = whisper.load_model(model_name)
    result = model.transcribe(audio_path, language=language, initial_prompt=prompt, fp16=False)
    text = (result.get('text') or '').strip()
    if not text:
        print(json.dumps({
            'ok': False,
            'error_code': 'empty_transcript',
            'message': 'Transcription completed but returned empty text',
        }))
        raise SystemExit(0)
    payload = {
        'ok': True,
        'text': text,
        'language': result.get('language'),
        'model': model_name,
        'source_path': audio_path,
    }
    print(json.dumps(payload, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({
        'ok': False,
        'error_code': 'transcription_failed',
        'message': f'Local transcription failed: {exc}',
    }, ensure_ascii=False))
PY`,
      JSON.stringify({
        type: 'object',
        properties: {
          audio_path: { type: 'string', description: 'Absolute or workspace-relative path to the local audio file to transcribe' },
          language: { type: 'string', description: 'Optional language hint such as en' },
          model: { type: 'string', description: 'Optional local whisper model name (default: base)' },
          prompt: { type: 'string', description: 'Optional initial transcription prompt' },
        },
        required: ['audio_path'],
      }),
      'exec',
      JSON.stringify(['audio', 'speech_to_text', 'telegram', 'local']),
    );

    assignToolToAgentByName.run('local_stt_transcribe', 'Atlas');
  });

  seedTx();
  console.log('[schema] Ensured tool registry defaults (explore_codebase, bash, file_edit, git_worktree_enter, git_worktree_exit, local_stt_transcribe)');
}

export function provisionDefaultToolRegistry(): void {
  ensureToolRegistryTables({ provisionDefaults: true });
}

async function ensureMcpRegistryTables(options: RegistryProvisionOptions = {}): Promise<void> {
  const db = getRawDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
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
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_tenant_slug ON mcp_servers(tenant_id, slug);
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_tenant ON mcp_servers(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_slug ON mcp_servers(slug);
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled);

    CREATE TABLE IF NOT EXISTS agent_mcp_assignments (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id       INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      mcp_server_id  INTEGER NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
      overrides      TEXT NOT NULL DEFAULT '{}',
      enabled        INTEGER NOT NULL DEFAULT 1,
      UNIQUE(agent_id, mcp_server_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_mcp_assignments_agent ON agent_mcp_assignments(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_mcp_assignments_server ON agent_mcp_assignments(mcp_server_id);
  `);

  if (!options.provisionDefaults) return;

  const serverEntryScript = path.join(path.resolve(__dirname, '../..'), 'dist', 'mcp', 'server.js');
  const nodeExecutable = path.join(NODE_BIN_DIR, 'node');

  db.prepare(`
    INSERT INTO mcp_servers (tenant_id, name, slug, description, transport, command, args, env, cwd, enabled)
    VALUES (?, ?, ?, ?, 'stdio', ?, ?, ?, ?, 1)
    ON CONFLICT(tenant_id, slug) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      transport = excluded.transport,
      command = excluded.command,
      args = excluded.args,
      env = excluded.env,
      cwd = excluded.cwd,
      enabled = 1,
      updated_at = datetime('now')
  `).run(
    await tenantDefaultIdForSchemaInit(db),
    'Agent HQ MCP Server',
    'agent-hq',
    'Local stdio MCP server exposing Agent HQ projects, sprints, tasks, and agents.',
    nodeExecutable,
    JSON.stringify([serverEntryScript]),
    JSON.stringify({ AGENT_HQ_API_URL: 'http://127.0.0.1:3501' }),
    path.resolve(__dirname, '../..'),
  );

  db.prepare(`
    INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id, overrides, enabled)
    SELECT a.id, s.id, '{}', 1
    FROM agents a
    JOIN mcp_servers s ON s.slug = 'agent-hq'
      AND s.tenant_id = a.tenant_id
    WHERE (
      a.system_role = ?
      OR a.openclaw_agent_id = ?
      OR a.session_key = ?
      OR a.name = ?
    )
      AND NOT EXISTS (
        SELECT 1 FROM agent_mcp_assignments ama
        WHERE ama.agent_id = a.id AND ama.mcp_server_id = s.id
      )
  `).run(ATLAS_SYSTEM_ROLE, ATLAS_AGENT_SLUG, ATLAS_SESSION_KEY, ATLAS_AGENT_NAME);

  console.log('[schema] Ensured MCP registry defaults (agent-hq)');
}

export async function provisionDefaultMcpRegistry(): Promise<void> {
  await ensureMcpRegistryTables({ provisionDefaults: true });
}

async function seedInitialData(): Promise<void> {
  const db = getRawDb();
  const existing = db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number };
  if (existing.count === 0) {
    const defaultTenantId = await tenantDefaultIdForSchemaInit(db);
    db.prepare(`
      INSERT INTO agents (tenant_id, name, role, session_key, workspace_path, status, openclaw_agent_id, system_role)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      defaultTenantId,
      ATLAS_AGENT_NAME,
      'Built-in assistant — task routing, coordination, and chat',
      ATLAS_SESSION_KEY,
      ATLAS_WORKSPACE_PATH,
      'idle',
      ATLAS_AGENT_SLUG,
      ATLAS_SYSTEM_ROLE,
    );
    console.log('[schema] Seeded initial Atlas agent');
  }
}

function getAppSetting(key: string): string | null {
  const db = getRawDb();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setAppSetting(key: string, value: string): void {
  const db = getRawDb();
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

function pathExists(target: string): boolean {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function looksLikeAtlasWorkspace(root: string): boolean {
  if (!isDirectory(root)) return false;
  return ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'MEMORY.md', 'TOOLS.md']
    .some(file => pathExists(path.join(root, file)));
}

function mergeMoveIntoAtlasWorkspace(sourcePath: string, targetPath: string): number {
  if (!pathExists(sourcePath)) return 0;

  if (!pathExists(targetPath)) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.renameSync(sourcePath, targetPath);
    return 1;
  }

  const sourceIsDir = isDirectory(sourcePath);
  const targetIsDir = isDirectory(targetPath);
  if (!sourceIsDir || !targetIsDir) return 0;

  let moved = 0;
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    if (entry.name === '.trash') continue;
    moved += mergeMoveIntoAtlasWorkspace(
      path.join(sourcePath, entry.name),
      path.join(targetPath, entry.name),
    );
  }

  try {
    if (fs.readdirSync(sourcePath).length === 0) {
      fs.rmdirSync(sourcePath);
    }
  } catch {
    // Leave non-empty/in-use directories alone.
  }

  return moved;
}

function migrateAtlasWorkspace(sourceRoot: string, targetRoot: string): number {
  if (sourceRoot === targetRoot) return 0;
  if (!looksLikeAtlasWorkspace(sourceRoot)) return 0;

  fs.mkdirSync(targetRoot, { recursive: true });
  let moved = 0;

  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.name === '.trash') continue;
    moved += mergeMoveIntoAtlasWorkspace(
      path.join(sourceRoot, entry.name),
      path.join(targetRoot, entry.name),
    );
  }

  return moved;
}

function replaceTextInFile(filePath: string, searchValue: string, replaceValue: string): boolean {
  if (!pathExists(filePath) || !fs.statSync(filePath).isFile()) return false;
  const original = fs.readFileSync(filePath, 'utf-8');
  if (!original.includes(searchValue)) return false;
  fs.writeFileSync(filePath, original.split(searchValue).join(replaceValue), 'utf-8');
  return true;
}

function migrateOpenClawConfigForAtlas(telegramChatId: string | null): boolean {
  const configPath = path.join(OPENCLAW_DIR, 'openclaw.json');
  if (!pathExists(configPath)) return false;

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      agents?: { list?: Array<Record<string, unknown>> };
      bindings?: Array<Record<string, unknown>>;
    };

    let changed = false;
    const agentList = Array.isArray(parsed.agents?.list) ? parsed.agents?.list : [];
    const mainEntry = agentList.find(entry => entry.id === 'main');
    let atlasEntry = agentList.find(entry => entry.id === ATLAS_AGENT_SLUG);

    if (!atlasEntry && mainEntry) {
      atlasEntry = {
        ...mainEntry,
        id: ATLAS_AGENT_SLUG,
        name: ATLAS_AGENT_NAME,
        workspace: ATLAS_WORKSPACE_PATH,
        agentDir: path.join(OPENCLAW_DIR, 'agents', ATLAS_AGENT_SLUG, 'agent'),
        default: true,
      };
      agentList.push(atlasEntry);
      changed = true;
    }

    if (atlasEntry) {
      if (atlasEntry.name !== ATLAS_AGENT_NAME) {
        atlasEntry.name = ATLAS_AGENT_NAME;
        changed = true;
      }
      if (atlasEntry.workspace !== ATLAS_WORKSPACE_PATH) {
        atlasEntry.workspace = ATLAS_WORKSPACE_PATH;
        changed = true;
      }
      const expectedAgentDir = path.join(OPENCLAW_DIR, 'agents', ATLAS_AGENT_SLUG, 'agent');
      if (atlasEntry.agentDir !== expectedAgentDir) {
        atlasEntry.agentDir = expectedAgentDir;
        changed = true;
      }
      if (atlasEntry.default !== true) {
        atlasEntry.default = true;
        changed = true;
      }
      if (telegramChatId) {
        const heartbeat = typeof atlasEntry.heartbeat === 'object' && atlasEntry.heartbeat !== null
          ? atlasEntry.heartbeat as Record<string, unknown>
          : {};
        if (heartbeat.to !== telegramChatId) {
          heartbeat.to = telegramChatId;
          atlasEntry.heartbeat = heartbeat;
          changed = true;
        }
      }
    }

    if (mainEntry && mainEntry.default !== false) {
      mainEntry.default = false;
      changed = true;
    }

    const bindings = Array.isArray(parsed.bindings) ? parsed.bindings : [];
    let telegramBound = false;
    for (const binding of bindings) {
      const match = binding.match as Record<string, unknown> | undefined;
      const peer = match?.peer as Record<string, unknown> | undefined;
      const isTelegramDirect = match?.channel === 'telegram'
        && peer?.kind === 'direct'
        && typeof peer.id === 'string';
      if (!isTelegramDirect) continue;
      telegramBound = telegramBound || binding.agentId === ATLAS_AGENT_SLUG;
      if (binding.agentId === 'main') {
        binding.agentId = ATLAS_AGENT_SLUG;
        telegramBound = true;
        changed = true;
      }
    }

    if (!telegramBound && telegramChatId) {
      bindings.push({
        type: 'route',
        agentId: ATLAS_AGENT_SLUG,
        match: {
          channel: 'telegram',
          peer: { kind: 'direct', id: telegramChatId },
        },
      });
      parsed.bindings = bindings;
      changed = true;
    }

    if (!changed) return false;
    fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
    return true;
  } catch (err) {
    console.warn('[schema] Task #25: failed to migrate openclaw.json:', err);
    return false;
  }
}

async function migrateAtlasToDedicatedAgent(): Promise<void> {
  if (getAppSetting(ATLAS_MIGRATION_SETTING_KEY) === 'true') return;

  const db = getRawDb();
  const skipExternalMigration = process.env.JEST_WORKER_ID !== undefined || process.env.NODE_ENV === 'test';
  const atlas = await getAtlasAgentRecord();
  const hasLegacyWorkspace = looksLikeAtlasWorkspace(LEGACY_MAIN_WORKSPACE_PATH);
  if (!atlas && !hasLegacyWorkspace) return;

  let changed = false;
  let movedEntries = 0;

  if (atlas) {
    const atlasId = Number(atlas.id);
    const previousSessionKey = String(atlas.session_key ?? '');
    const previousWorkspace = String(atlas.workspace_path ?? '');
    const previousOpenClawId = typeof atlas.openclaw_agent_id === 'string' ? atlas.openclaw_agent_id : '';

    db.prepare(`
      UPDATE agents
      SET system_role = ?,
          session_key = ?,
          workspace_path = ?,
          openclaw_agent_id = ?,
          role = CASE
            WHEN role = '' OR role = 'main' OR role = 'General assistant — main session'
              THEN 'Built-in assistant — task routing, coordination, and chat'
            ELSE role
          END
      WHERE id = ?
    `).run(
      ATLAS_SYSTEM_ROLE,
      ATLAS_SESSION_KEY,
      ATLAS_WORKSPACE_PATH,
      ATLAS_AGENT_SLUG,
      atlasId,
    );

    if (
      previousSessionKey === 'main'
      || previousSessionKey === LEGACY_ATLAS_SESSION_KEY
      || previousWorkspace === LEGACY_MAIN_WORKSPACE_PATH
      || previousOpenClawId === 'main'
      || atlas.system_role !== ATLAS_SYSTEM_ROLE
    ) {
      changed = true;
    }

    if (previousSessionKey && previousSessionKey !== ATLAS_SESSION_KEY) {
      db.prepare(`UPDATE job_instances SET session_key = ? WHERE session_key = ?`).run(ATLAS_SESSION_KEY, previousSessionKey);
      db.prepare(`UPDATE chat_messages SET session_key = ? WHERE session_key = ?`).run(ATLAS_SESSION_KEY, previousSessionKey);
      db.prepare(`UPDATE sessions SET external_key = ? WHERE external_key = ?`).run(ATLAS_SESSION_KEY, previousSessionKey);
    }
  }

  const remapTables: Array<[string, string]> = [
    ['chat_messages', 'session_key'],
    ['sessions', 'external_key'],
    ['job_instances', 'session_key'],
  ];
  for (const [tableName, columnName] of remapTables) {
    db.prepare(`
      UPDATE ${tableName}
      SET ${columnName} = REPLACE(${columnName}, ?, ?)
      WHERE ${columnName} LIKE ?
    `).run(LEGACY_ATLAS_TELEGRAM_PREFIX, ATLAS_TELEGRAM_PREFIX, `${LEGACY_ATLAS_TELEGRAM_PREFIX}%`);
  }

  if (!skipExternalMigration) {
    movedEntries = migrateAtlasWorkspace(LEGACY_MAIN_WORKSPACE_PATH, ATLAS_WORKSPACE_PATH);
    if (movedEntries > 0) changed = true;

    const telegramChatId = getAppSetting('telegram_chat_id');
    if (migrateOpenClawConfigForAtlas(telegramChatId)) changed = true;

    if (replaceTextInFile(
      path.join(OPENCLAW_DIR, 'subagents', 'runs.json'),
      LEGACY_ATLAS_TELEGRAM_PREFIX,
      ATLAS_TELEGRAM_PREFIX,
    )) {
      changed = true;
    }
  }

  setAppSetting(ATLAS_MIGRATION_SETTING_KEY, 'true');
  if (changed) {
    console.log(`[schema] Task #25: migrated Atlas to dedicated agent (workspace entries moved: ${movedEntries})`);
  } else {
    console.log('[schema] Task #25: Atlas migration already satisfied');
  }
}

// ── Task #612: Data-driven lifecycle rules ────────────────────────────────────
// lifecycle_rules replaces the hardcoded canonicalOutcomeRoute map.
// Gate requirements live in sprint_task_transition_requirements, always inside a workflow
// scope. A global `transition_requirements` twin used to sit here as their fallback; migration
// 15 moved it into the dev workflow default and dropped it.
export function ensureLifecycleRulesTable(): void {
  const db = getRawDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS lifecycle_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_type   TEXT,
      from_status TEXT NOT NULL,
      outcome     TEXT NOT NULL,
      to_status   TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      priority    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_lifecycle_rules_lookup
      ON lifecycle_rules(task_type, from_status, outcome);
    CREATE INDEX IF NOT EXISTS idx_lifecycle_rules_type
      ON lifecycle_rules(task_type);
  `);

  // Seed lifecycle_rules from the hardcoded canonicalOutcomeRoute map (idempotent)
  const existingRules = (db.prepare(`SELECT COUNT(*) as n FROM lifecycle_rules`).get() as { n: number }).n;
  if (existingRules === 0) {
    const insertRule = db.prepare(`
      INSERT INTO lifecycle_rules (task_type, from_status, outcome, to_status, priority)
      VALUES (?, ?, ?, ?, ?)
    `);

    const seedRulesTx = db.transaction(() => {
      // Default rules (task_type = NULL → apply to all types)
      const defaults: Array<[null, string, string, string, number]> = [
        [null, 'in_progress', 'completed_for_review', 'review', 0],
        [null, 'in_progress', 'dev_deploy_queued', 'dev_deploy_queued', 0],
        [null, 'dev_deploy_queued', 'dev_deploy_queued', 'dev_deploy_queued', 0],
        [null, 'dev_deploy_queued', 'completed_for_review', 'review', 0],
        [null, 'dev_deploy_queued', 'blocked', 'blocked', 0],
        [null, 'dev_deploy_queued', 'failed', 'failed', 0],
        [null, 'dev_deploying', 'dev_deploy_queued', 'dev_deploying', 0],
        [null, 'dev_deploying', 'completed_for_review', 'review', 0],
        [null, 'dev_deploying', 'blocked', 'blocked', 0],
        [null, 'dev_deploying', 'failed', 'failed', 0],
        [null, 'review', 'qa_pass', 'ready_to_merge', 0],
        [null, 'review', 'qa_fail', 'ready', 0],
        [null, 'review', 'blocked', 'blocked', 0],
        [null, 'review', 'failed', 'failed', 0],
        [null, 'ready_to_merge', 'deployed_live', 'deployed', 0],
        [null, 'ready_to_merge', 'qa_fail', 'ready', 0],
        [null, 'ready_to_merge', 'blocked', 'blocked', 0],
        [null, 'ready_to_merge', 'env_blocked', 'blocked', 0],
        [null, 'ready_to_merge', 'approval_blocked', 'blocked', 0],
        [null, 'ready_to_merge', 'failed', 'failed', 0],
        [null, 'ready_to_merge', 'release_failed', 'failed', 0],
        [null, 'deployed', 'live_verified', 'done', 0],
        [null, 'deployed', 'failed', 'failed', 0],
        [null, 'deployed', 'qa_fail', 'ready', 0],
        [null, 'stalled', 'retry', 'ready', 0],
      ];

      for (const row of defaults) insertRule.run(...row);

    });
    seedRulesTx();
    console.log('[schema] Seeded lifecycle_rules from canonicalOutcomeRoute defaults');
  }
  try {
    const normalizedQaPassRules = db.prepare(`
      UPDATE lifecycle_rules
      SET to_status = 'ready_to_merge', updated_at = datetime('now')
      WHERE from_status = 'review'
        AND outcome = 'qa_pass'
        AND to_status = 'qa_pass'
    `).run();
    const disabledQaPassStatusRules = db.prepare(`
      UPDATE lifecycle_rules
      SET enabled = 0, updated_at = datetime('now')
      WHERE from_status = 'qa_pass'
    `).run();
    if (normalizedQaPassRules.changes > 0 || disabledQaPassStatusRules.changes > 0) {
      console.log(`[schema] Normalized qa_pass status lifecycle rules (updated=${normalizedQaPassRules.changes}, disabled=${disabledQaPassStatusRules.changes})`);
    }
  } catch (err) {
    console.error('[schema] Failed to normalize qa_pass lifecycle rules:', err);
  }
  try {
    const columns = db.prepare(`PRAGMA table_info(lifecycle_rules)`).all() as Array<{ name: string }>;
    if (columns.some(column => column.name === 'lane')) {
      db.exec(`ALTER TABLE lifecycle_rules DROP COLUMN lane`);
      console.log('[schema] Task #743: dropped legacy lifecycle_rules.lane column');
    }
  } catch (err) {
    console.error('[schema] Task #743: failed to drop legacy lifecycle_rules.lane column:', err);
  }

  // Migration 15: move the global gate requirements to the dev workflow, then drop the table.
  //
  // `transition_requirements` had no project, workflow or tenant. Every workflow of every
  // project read it as a fallback whenever its own set for an outcome was empty, and because
  // the fallback REPLACED rather than accumulated, disabling a workflow's last gate handed
  // that outcome to block-severity rows nobody had configured. Mirrors
  // db/pg-migrations/15-drop-global-transition-requirements.sql — see it for the two guards,
  // which are the same here: never touch an outcome the workflow already answers at workflow
  // level, and never insert where some workflow resolves a non-empty set that the global rows
  // are not already a subset of.
  try {
    const hasGlobalRequirements = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='transition_requirements'`
    ).get() as { name?: string } | undefined;

    if (hasGlobalRequirements) {
      const typedRows = (db.prepare(
        `SELECT COUNT(*) AS n FROM transition_requirements WHERE enabled = 1 AND task_type IS NOT NULL`
      ).get() as { n: number }).n;
      if (typedRows > 0) {
        console.warn(
          `[schema] Migration 15: ${typedRows} task-typed global requirement(s) present. `
          + 'Only task_type IS NULL rows are moved to the dev workflow; the rest are dropped.'
        );
      }

      db.exec(`
        INSERT INTO sprint_task_transition_requirements (
          sprint_id, project_id, sprint_type, task_type, outcome, field_name,
          requirement_type, match_field, severity, message, enabled, priority,
          created_at, updated_at
        )
        SELECT
          NULL, w.project_id, 'dev', NULL, g.outcome, g.field_name,
          g.requirement_type, g.match_field, g.severity, g.message, 1, g.priority,
          datetime('now'), datetime('now')
        FROM (SELECT DISTINCT project_id FROM sprints WHERE sprint_type = 'dev') w
        CROSS JOIN (
          SELECT outcome, field_name, requirement_type, match_field,
                 MIN(severity) AS severity, MIN(message) AS message, MIN(priority) AS priority
          FROM transition_requirements
          WHERE enabled = 1 AND task_type IS NULL
          GROUP BY outcome, field_name, requirement_type, COALESCE(match_field, '')
        ) g
        WHERE NOT EXISTS (
          SELECT 1 FROM sprint_task_transition_requirements existing
          WHERE existing.project_id = w.project_id AND existing.sprint_type = 'dev'
            AND existing.sprint_id IS NULL AND existing.task_type IS NULL
            AND existing.enabled = 1 AND existing.outcome = g.outcome
        )
        AND NOT EXISTS (
          SELECT 1 FROM sprints s
          WHERE s.project_id = w.project_id AND s.sprint_type = 'dev'
            AND EXISTS (
              SELECT 1 FROM sprint_task_transition_requirements cur
              WHERE cur.project_id = s.project_id AND cur.sprint_type = 'dev'
                AND (cur.sprint_id = s.id OR cur.sprint_id IS NULL)
                AND cur.task_type IS NULL AND cur.enabled = 1 AND cur.outcome = g.outcome
            )
            AND EXISTS (
              SELECT 1 FROM transition_requirements missing
              WHERE missing.enabled = 1 AND missing.task_type IS NULL
                AND missing.outcome = g.outcome
                AND NOT EXISTS (
                  SELECT 1 FROM sprint_task_transition_requirements have
                  WHERE have.project_id = s.project_id AND have.sprint_type = 'dev'
                    AND (have.sprint_id = s.id OR have.sprint_id IS NULL)
                    AND have.task_type IS NULL AND have.enabled = 1
                    AND have.outcome = missing.outcome
                    AND have.field_name = missing.field_name
                    AND have.requirement_type = missing.requirement_type
                    AND COALESCE(have.match_field, '') = COALESCE(missing.match_field, '')
                )
            )
        );

        DROP INDEX IF EXISTS idx_transition_req_lookup;
        DROP INDEX IF EXISTS idx_transition_req_type;
        DROP TABLE transition_requirements;
      `);
      console.log('[schema] Migration 15: moved global gate requirements to the dev workflow and dropped the table');
    }
  } catch (err) {
    console.error('[schema] Migration 15: failed to drop global transition_requirements:', err);
  }

  // Backfill: ensure deployed_live can be satisfied by either merged_commit or deployed_commit.
  try {
    db.prepare(`
      UPDATE sprint_task_transition_requirements
      SET field_name = 'merged_commit|deployed_commit'
      WHERE outcome = 'deployed_live'
        AND field_name = 'merged_commit'
        AND message LIKE '%or deployed_commit%'
    `).run();
  } catch { /* table may not exist yet */ }

  // Backfill (task #451): Dev deploy queue workflow statuses.
  // Existing sprints can already have sprint-scoped transition rows, so adding
  // lifecycle_rules alone is insufficient; seed the missing sprint rows too.
  try {
    const devDeployStatuses = [
      {
        key: 'dev_deploy_queued',
        label: 'Dev Deploy Queued',
        color: 'amber',
        allowed: ['dev_deploying', 'review', 'blocked', 'failed', 'cancelled'],
      },
      {
        key: 'dev_deploying',
        label: 'Dev Deploying',
        color: 'cyan',
        allowed: ['review', 'dev_deploy_queued', 'blocked', 'failed', 'cancelled'],
      },
    ] as const;

    const devDeployTransitions = [
      ['in_progress', 'dev_deploy_queued', 'dev_deploy_queued'],
      ['dev_deploy_queued', 'dev_deploy_queued', 'dev_deploy_queued'],
      ['dev_deploy_queued', 'completed_for_review', 'review'],
      ['dev_deploy_queued', 'blocked', 'blocked'],
      ['dev_deploy_queued', 'failed', 'failed'],
      ['dev_deploying', 'dev_deploy_queued', 'dev_deploying'],
      ['dev_deploying', 'completed_for_review', 'review'],
      ['dev_deploying', 'blocked', 'blocked'],
      ['dev_deploying', 'failed', 'failed'],
    ] as const;

    const hasLifecycleRule = db.prepare(`
      SELECT id FROM lifecycle_rules
      WHERE task_type IS NULL AND from_status = ? AND outcome = ?
      LIMIT 1
    `);
    const insertLifecycleRule = db.prepare(`
      INSERT INTO lifecycle_rules (task_type, from_status, outcome, to_status, enabled, priority)
      VALUES (NULL, ?, ?, ?, 1, 0)
    `);
    for (const [fromStatus, outcome, toStatus] of devDeployTransitions) {
      if (!hasLifecycleRule.get(fromStatus, outcome)) {
        insertLifecycleRule.run(fromStatus, outcome, toStatus);
      }
    }

    const sprintRows = db.prepare(`SELECT id FROM sprints WHERE sprint_type = 'dev' ORDER BY id ASC`).all() as Array<{ id: number }>;
    const maxStatusOrder = db.prepare(`
      SELECT COALESCE(MAX(stage_order), -1) AS max_order
      FROM sprint_task_statuses
      WHERE sprint_id = ?
    `);
    const hasSprintStatus = db.prepare(`
      SELECT id FROM sprint_task_statuses
      WHERE sprint_id = ? AND status_key = ?
      LIMIT 1
    `);
    const insertSprintStatus = db.prepare(`
      INSERT INTO sprint_task_statuses (
        sprint_id, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, 1, ?, ?, 0, '{}', datetime('now'), datetime('now'))
    `);
    const updateSprintStatus = db.prepare(`
      UPDATE sprint_task_statuses
      SET label = ?,
          color = ?,
          terminal = 0,
          is_system = 1,
          allowed_transitions_json = ?,
          updated_at = datetime('now')
      WHERE sprint_id = ? AND status_key = ?
    `);
    const hasSprintTransition = db.prepare(`
      SELECT id FROM sprint_task_transitions
      WHERE sprint_id = ?
        AND task_type IS NULL
        AND from_status = ?
        AND outcome = ?
      LIMIT 1
    `);
    const insertSprintTransition = db.prepare(`
      INSERT INTO sprint_task_transitions (
        sprint_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at
      ) VALUES (?, NULL, ?, ?, ?, 1, 0, 0, datetime('now'), datetime('now'))
    `);

    const backfillDevDeploySprintRows = db.transaction(() => {
      for (const sprint of sprintRows) {
        let nextStageOrder = Number((maxStatusOrder.get(sprint.id) as { max_order: number }).max_order ?? -1) + 1;
        for (const status of devDeployStatuses) {
          const allowedJson = JSON.stringify(status.allowed);
          if (hasSprintStatus.get(sprint.id, status.key)) {
            updateSprintStatus.run(status.label, status.color, allowedJson, sprint.id, status.key);
          } else {
            insertSprintStatus.run(sprint.id, status.key, status.label, status.color, allowedJson, nextStageOrder);
            nextStageOrder += 1;
          }
        }

        for (const [fromStatus, outcome, toStatus] of devDeployTransitions) {
          if (!hasSprintTransition.get(sprint.id, fromStatus, outcome)) {
            insertSprintTransition.run(sprint.id, fromStatus, outcome, toStatus);
          }
        }
      }
    });
    backfillDevDeploySprintRows();
  } catch (err) {
    console.warn('[schema] Backfill task #451 dev deploy queue workflow skipped:', err);
  }

  // Backfill release blocker routes so release agents can post truthful blocker
  // outcomes from ready_to_merge instead of ending without a lifecycle outcome.
  try {
    const releaseBlockerTransitions = [
      ['ready_to_merge', 'blocked', 'blocked'],
      ['ready_to_merge', 'env_blocked', 'blocked'],
      ['ready_to_merge', 'approval_blocked', 'blocked'],
      ['ready_to_merge', 'failed', 'failed'],
      ['ready_to_merge', 'release_failed', 'failed'],
    ] as const;

    const hasLifecycleRule = db.prepare(`
      SELECT id FROM lifecycle_rules
      WHERE task_type IS NULL AND from_status = ? AND outcome = ?
      LIMIT 1
    `);
    const insertLifecycleRule = db.prepare(`
      INSERT INTO lifecycle_rules (task_type, from_status, outcome, to_status, enabled, priority)
      VALUES (NULL, ?, ?, ?, 1, 0)
    `);
    for (const [fromStatus, outcome, toStatus] of releaseBlockerTransitions) {
      if (!hasLifecycleRule.get(fromStatus, outcome)) {
        insertLifecycleRule.run(fromStatus, outcome, toStatus);
      }
    }

    const devSprints = db.prepare(`SELECT id FROM sprints WHERE sprint_type = 'dev' ORDER BY id ASC`).all() as Array<{ id: number }>;
    const hasSprintTransition = db.prepare(`
      SELECT id FROM sprint_task_transitions
      WHERE sprint_id = ?
        AND task_type IS NULL
        AND from_status = ?
        AND outcome = ?
      LIMIT 1
    `);
    const insertSprintTransition = db.prepare(`
      INSERT INTO sprint_task_transitions (
        sprint_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at
      ) VALUES (?, NULL, ?, ?, ?, 1, 0, 0, datetime('now'), datetime('now'))
    `);
    const updateReadyToMergeAllowed = db.prepare(`
      UPDATE sprint_task_statuses
      SET allowed_transitions_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `);
    const statusRows = db.prepare(`
      SELECT id, allowed_transitions_json
      FROM sprint_task_statuses
      WHERE sprint_id = ? AND status_key = 'ready_to_merge'
    `);
    const parseAllowedTransitions = (raw: string | null): string[] => {
      try {
        const parsed = JSON.parse(raw || '[]');
        return Array.isArray(parsed) ? parsed.map(item => String(item).trim()).filter(Boolean) : [];
      } catch {
        return [];
      }
    };

    const tx = db.transaction(() => {
      for (const sprint of devSprints) {
        for (const [fromStatus, outcome, toStatus] of releaseBlockerTransitions) {
          if (!hasSprintTransition.get(sprint.id, fromStatus, outcome)) {
            insertSprintTransition.run(sprint.id, fromStatus, outcome, toStatus);
          }
        }

        const rows = statusRows.all(sprint.id) as Array<{ id: number; allowed_transitions_json: string | null }>;
        for (const row of rows) {
          const allowed = parseAllowedTransitions(row.allowed_transitions_json);
          let changed = false;
          for (const status of ['blocked', 'failed']) {
            if (!allowed.includes(status)) {
              allowed.push(status);
              changed = true;
            }
          }
          if (changed) updateReadyToMergeAllowed.run(JSON.stringify(allowed), row.id);
        }
      }

      try {
        const typeRows = db.prepare(`
          SELECT id, allowed_transitions_json
          FROM sprint_type_task_statuses
          WHERE sprint_type_key = 'dev' AND status_key = 'ready_to_merge'
        `).all() as Array<{ id: number; allowed_transitions_json: string | null }>;
        const updateTypeStatus = db.prepare(`
          UPDATE sprint_type_task_statuses
          SET allowed_transitions_json = ?, updated_at = datetime('now')
          WHERE id = ?
        `);
        for (const row of typeRows) {
          const allowed = parseAllowedTransitions(row.allowed_transitions_json);
          let changed = false;
          for (const status of ['blocked', 'failed']) {
            if (!allowed.includes(status)) {
              allowed.push(status);
              changed = true;
            }
          }
          if (changed) updateTypeStatus.run(JSON.stringify(allowed), row.id);
        }
      } catch {
        // sprint_type_task_statuses may not exist on older partial DBs.
      }
    });
    tx();
  } catch (err) {
    console.warn('[schema] Backfill release blocker workflow skipped:', err);
  }

  // Backfill cleanup (task #528): remove legacy approved_for_merge visible workflow semantics.
  try {
    db.prepare(`DELETE FROM lifecycle_rules WHERE outcome = 'approved_for_merge'`).run();
    db.prepare(`DELETE FROM sprint_task_transitions WHERE outcome = 'approved_for_merge'`).run();
    db.prepare(`DELETE FROM sprint_task_transition_requirements WHERE outcome = 'approved_for_merge'`).run();
  } catch (err) {
    console.warn('[schema] Backfill task #528 approved_for_merge cleanup skipped:', err);
  }

  // Startup must not re-apply default workflow/status/routing policy to existing
  // tenants or workflow definitions. Starter policy is seeded only during fresh
  // bootstrap/new-tenant setup or explicit admin creation paths.
}

/**
 * ensureProviderConfigTable — Task #573: provider configuration for onboarding.
 * Stores API keys / connection details for Anthropic, OpenAI, Google, Ollama.
 */
async function ensureProviderConfigTable(): Promise<void> {
  const db = getRawDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_config (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id         INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      slug              TEXT NOT NULL CHECK(slug IN ('anthropic','openai','google','openrouter','ollama','openai-codex','mlx-studio','minimax')),
      display_name      TEXT NOT NULL DEFAULT '',
      status            TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','connected','failed')),
      config            TEXT NOT NULL DEFAULT '{}',
      last_validated_at TEXT,
      validation_error  TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_provider_config_slug ON provider_config(slug);
    CREATE INDEX IF NOT EXISTS idx_provider_config_status ON provider_config(status);
  `);

  const defaultTenantId = await tenantDefaultIdForSchemaInit(db);
  const providerCols = (db.prepare(`PRAGMA table_info(provider_config)`).all() as { name: string }[]).map(c => c.name);
  if (!providerCols.includes('tenant_id')) {
    if (activeTenantMode === 'verify') {
      throw new Error('Tenant install/migration required: provider_config.tenant_id is missing');
    }
    db.exec(`ALTER TABLE provider_config ADD COLUMN tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE`);
  }
  if (activeTenantMode === 'verify') {
    const missingTenant = db.prepare(`SELECT 1 FROM provider_config WHERE tenant_id IS NULL LIMIT 1`).get();
    if (missingTenant) throw new Error('Tenant install/migration required: provider_config contains rows without tenant ownership');
  } else {
    db.prepare(`UPDATE provider_config SET tenant_id = ? WHERE tenant_id IS NULL`).run(defaultTenantId);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_config_tenant_slug ON provider_config(tenant_id, slug);
    CREATE INDEX IF NOT EXISTS idx_provider_config_tenant ON provider_config(tenant_id);
  `);

  // Safe migration: expand provider_config.slug CHECK to include new slugs.
  // Runs when the live DDL is missing a slug that the code now supports.
  try {
    const providerDdl = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_config'`
    ).get() as { sql: string } | undefined)?.sql ?? '';
    if (providerDdl && (!providerDdl.includes("'minimax'") || !providerDdl.includes("'openrouter'") || /slug\s+TEXT\s+NOT NULL\s+UNIQUE/i.test(providerDdl))) {
      const cols = (db.prepare(`PRAGMA table_info(provider_config)`).all() as { name: string }[]).map(c => c.name);
      const colList = cols.join(', ');
      db.pragma('foreign_keys = OFF');
      const migrate = db.transaction(() => {
        db.prepare(`
          CREATE TABLE provider_config_new (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id         INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
            slug              TEXT NOT NULL CHECK(slug IN ('anthropic','openai','google','openrouter','ollama','openai-codex','mlx-studio','minimax')),
            display_name      TEXT NOT NULL DEFAULT '',
            status            TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','connected','failed')),
            config            TEXT NOT NULL DEFAULT '{}',
            last_validated_at TEXT,
            validation_error  TEXT,
            created_at        TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `).run();
        db.prepare(`INSERT INTO provider_config_new (${colList}) SELECT ${colList} FROM provider_config`).run();
        db.prepare(`DROP TABLE provider_config`).run();
        db.prepare(`ALTER TABLE provider_config_new RENAME TO provider_config`).run();
        db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_config_tenant_slug ON provider_config(tenant_id, slug)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_provider_config_slug ON provider_config(slug)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_provider_config_tenant ON provider_config(tenant_id)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_provider_config_status ON provider_config(status)`).run();
      });
      migrate();
      db.pragma('foreign_keys = ON');
      console.log('[schema] Migrated: expanded provider_config.slug CHECK to include current provider slugs');
    }
  } catch (err) {
    console.error('[schema] Failed to migrate provider_config slug constraint:', err);
  }
}

/**
 * Runtime-owned provider credentials. Agent HQ stores only routing metadata and
 * an opaque reference to the credential in the runtime's own auth store.
 */
function ensureProviderConnectionsTable(): void {
  const db = getRawDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_connections (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id         INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      provider_slug     TEXT NOT NULL,
      auth_mode         TEXT NOT NULL,
      runtime_type      TEXT NOT NULL,
      external_ref      TEXT NOT NULL,
      display_name      TEXT NOT NULL DEFAULT '',
      status            TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','connected','failed')),
      metadata          TEXT NOT NULL DEFAULT '{}',
      last_validated_at TEXT,
      validation_error  TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, runtime_type, provider_slug, auth_mode, external_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_connections_tenant ON provider_connections(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_provider_connections_lookup ON provider_connections(tenant_id, runtime_type, provider_slug, status);
  `);

  try {
    db.exec(`ALTER TABLE agents ADD COLUMN provider_connection_id INTEGER REFERENCES provider_connections(id) ON DELETE SET NULL`);
    console.log('[schema] Migrated: added agents.provider_connection_id');
  } catch (_) { /* column already exists */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_provider_connection ON agents(provider_connection_id)`);
}

/**
 * ensureGitHubIdentitiesTable — Task #613: per-agent GitHub identity/credential storage.
 *
 * Each row represents a distinct GitHub account (bot user or service account)
 * that an Agent HQ workflow role can use for git operations (PR create, approve,
 * merge). Agents reference this table via agents.github_identity_id.
 *
 * Credential model: fine-grained PATs stored in the `token` column.
 * For production hardening, consider encrypting at rest or using a secrets manager.
 *
 * Workflow role labels (informational): dev, qa, release, shared.
 */
async function ensureGitHubIdentitiesTable(): Promise<void> {
  const db = getRawDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS github_identities (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id         INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      github_username   TEXT NOT NULL,
      token             TEXT NOT NULL DEFAULT '',
      git_author_name   TEXT NOT NULL DEFAULT '',
      git_author_email  TEXT NOT NULL DEFAULT '',
      lane              TEXT NOT NULL DEFAULT 'shared' CHECK(lane IN ('dev','qa','release','shared')),
      notes             TEXT NOT NULL DEFAULT '',
      enabled           INTEGER NOT NULL DEFAULT 1,
      last_validated_at TEXT,
      validation_status TEXT DEFAULT NULL CHECK(validation_status IN (NULL,'valid','failed')),
      validation_error  TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_github_identities_username ON github_identities(github_username);
    CREATE INDEX IF NOT EXISTS idx_github_identities_lane ON github_identities(lane);
    CREATE INDEX IF NOT EXISTS idx_github_identities_enabled ON github_identities(enabled);
  `);

  const defaultTenantId = await tenantDefaultIdForSchemaInit(db);
  const githubCols = (db.prepare(`PRAGMA table_info(github_identities)`).all() as { name: string }[]).map(c => c.name);
  if (!githubCols.includes('tenant_id')) {
    if (activeTenantMode === 'verify') {
      throw new Error('Tenant install/migration required: github_identities.tenant_id is missing');
    }
    db.exec(`ALTER TABLE github_identities ADD COLUMN tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE`);
  }
  if (activeTenantMode === 'verify') {
    const missingTenant = db.prepare(`SELECT 1 FROM github_identities WHERE tenant_id IS NULL LIMIT 1`).get();
    if (missingTenant) throw new Error('Tenant install/migration required: github_identities contains rows without tenant ownership');
  } else {
    db.prepare(`UPDATE github_identities SET tenant_id = ? WHERE tenant_id IS NULL`).run(defaultTenantId);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_github_identities_tenant_username ON github_identities(tenant_id, github_username);
    CREATE INDEX IF NOT EXISTS idx_github_identities_tenant ON github_identities(tenant_id);
  `);

  try {
    const githubDdl = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='github_identities'`
    ).get() as { sql: string } | undefined)?.sql ?? '';
    if (githubDdl && /github_username\s+TEXT\s+NOT NULL\s+UNIQUE/i.test(githubDdl)) {
      const cols = (db.prepare(`PRAGMA table_info(github_identities)`).all() as { name: string }[]).map(c => c.name);
      const colList = cols.join(', ');
      db.pragma('foreign_keys = OFF');
      const migrate = db.transaction(() => {
        db.prepare(`
          CREATE TABLE github_identities_new (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id         INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
            github_username   TEXT NOT NULL,
            token             TEXT NOT NULL DEFAULT '',
            git_author_name   TEXT NOT NULL DEFAULT '',
            git_author_email  TEXT NOT NULL DEFAULT '',
            lane              TEXT NOT NULL DEFAULT 'shared' CHECK(lane IN ('dev','qa','release','shared')),
            notes             TEXT NOT NULL DEFAULT '',
            enabled           INTEGER NOT NULL DEFAULT 1,
            last_validated_at TEXT,
            validation_status TEXT DEFAULT NULL CHECK(validation_status IN (NULL,'valid','failed')),
            validation_error  TEXT,
            created_at        TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `).run();
        db.prepare(`INSERT INTO github_identities_new (${colList}) SELECT ${colList} FROM github_identities`).run();
        db.prepare(`DROP TABLE github_identities`).run();
        db.prepare(`ALTER TABLE github_identities_new RENAME TO github_identities`).run();
        db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_github_identities_tenant_username ON github_identities(tenant_id, github_username)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_github_identities_tenant ON github_identities(tenant_id)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_github_identities_username ON github_identities(github_username)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_github_identities_lane ON github_identities(lane)`).run();
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_github_identities_enabled ON github_identities(enabled)`).run();
      });
      migrate();
      db.pragma('foreign_keys = ON');
      console.log('[schema] Migrated: made github_identities unique per tenant');
    }
  } catch (err) {
    db.pragma('foreign_keys = ON');
    console.error('[schema] Failed to migrate github_identities tenant uniqueness:', err);
  }

  // Add github_identity_id FK to agents table
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN github_identity_id INTEGER REFERENCES github_identities(id) ON DELETE SET NULL`);
    console.log('[schema] Migrated: added github_identity_id to agents');
  } catch (_) { /* column already exists */ }
}

/**
 * ensureFailureDetailAndWorkflowColumns — failure/blocker context and recovery.
 * Failure/blocker semantics are owned by configured task outcomes; this only
 * stores human-readable details and workflow recovery state.
 */
function ensureFailureDetailAndWorkflowColumns(): void {
  const db = getRawDb();

  // Add failure_detail to tasks (human-readable explanation)
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN failure_detail TEXT DEFAULT NULL`);
    console.log('[schema] Migrated: added failure_detail to tasks');
  } catch (_) { /* column already exists */ }

  // ── Task #660: Task Pause — paused_at and pause_reason columns ──────────────
  // paused_at: when the task was paused (NULL = not paused)
  // pause_reason: optional human note explaining why the task is paused
  // Paused tasks are excluded from routing, dispatch, and lifecycle transitions.
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN paused_at TEXT DEFAULT NULL`);
    console.log('[schema] Migrated: added paused_at to tasks (task #660)');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN pause_reason TEXT DEFAULT NULL`);
    console.log('[schema] Migrated: added pause_reason to tasks (task #660)');
  } catch (_) { /* column already exists */ }

  // ── Task #681: Per-agent watchdog timeout overrides ───────────────────────
  // startup_grace_seconds — overrides START_CHECKIN_GRACE_MS for this agent
  // heartbeat_stale_seconds — overrides HEARTBEAT_STALE_MS for this agent
  // NULL = use global defaults
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN startup_grace_seconds INTEGER DEFAULT NULL`);
    console.log('[schema] Migrated: added startup_grace_seconds to agents (task #681)');
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE agents ADD COLUMN heartbeat_stale_seconds INTEGER DEFAULT NULL`);
    console.log('[schema] Migrated: added heartbeat_stale_seconds to agents (task #681)');
  } catch (_) { /* column already exists */ }

  // ── Task #30: Lane-agnostic retries — previous_status tracking ─────────────
  // previous_status: the status the task was in before transitioning to failed or stalled.
  // Used by retry/reopen logic to restore the task to its original position in
  // the workflow instead of always resetting to 'ready'.
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN previous_status TEXT DEFAULT NULL`);
    console.log('[schema] Migrated: added previous_status to tasks (task #30)');
  } catch (_) { /* column already exists */ }
}

/**
 * ensureDataMigration593 — Task #593: Backfill job-owned metadata into agents
 * and update routing/project/sprint relationships.
 *
 * This is the data-integrity pass that fills the gaps left after:
 *   - Phase 0 (Task #459): job columns added to agents, backfilled
 *   - Phase 3 (Task #459): agent_id FK columns added to join tables, partially backfilled
 *   - Phase 4 (Task #592): dispatcher now reads agent_id from routing rules (with job_template fallback)
 *
 * What this migration does:
 *   1. Drop the retired legacy project-level task_routing_rules table.
 *   2. Backfill legacy task ownership columns so old job-owned rows populate
 *      tasks.agent_id and tasks.review_owner_agent_id from job_templates.agent_id
 *      before any runtime authority check relies on agent ownership.
 *   3. Make job_instances.template_id nullable via a safe table rebuild.
 *      This is required before any new instance can be created without a
 *      job_templates row (which will be the case after Phase 5 cleanup).
 *   4. Log a validation summary of all pre-conditions for Phase 5 (safe drop).
 */
export function ensureDataMigration593(): void {
  const db = getRawDb();
  const getTableSql = (name: string): string => {
    return ((db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`).get(name) as { sql?: string } | undefined)?.sql ?? '');
  };
  const getColumns = (name: string): string[] => {
    return (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).map((col) => col.name);
  };
  const getDefaultTenantId = (): number => {
    try {
      const fromSetting = db.prepare(`SELECT value FROM app_settings WHERE key = 'default_tenant_id' LIMIT 1`).get() as { value?: string } | undefined;
      const configured = Number(fromSetting?.value ?? '');
      if (Number.isInteger(configured) && configured > 0) return configured;
    } catch { /* app_settings may not exist in legacy/minimal bootstrap tests */ }
    try {
      const defaultTenant = db.prepare(`SELECT id FROM tenants WHERE is_default = 1 ORDER BY id ASC LIMIT 1`).get() as { id?: number } | undefined;
      const candidate = Number(defaultTenant?.id ?? 0);
      if (Number.isInteger(candidate) && candidate > 0) return candidate;
    } catch { /* tenants may not exist in legacy/minimal bootstrap tests */ }
    return 1;
  };
  const hasUniqueIndexExactly = (tableName: string, columns: string[]): boolean => {
    try {
      const indexes = db.prepare(`PRAGMA index_list(${tableName})`).all() as Array<{ name: string; unique: number }>;
      return indexes.some((index) => {
        if (!index.unique) return false;
        const indexedColumns = (db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>).map((col) => col.name);
        return indexedColumns.length === columns.length && indexedColumns.every((column, idx) => column === columns[idx]);
      });
    } catch {
      return false;
    }
  };

  // ── Step 1: Retire legacy project-level task routing rules after sprint migration ──
  try {
    db.exec(`DROP TABLE IF EXISTS task_routing_rules`);
  } catch (err) {
    console.warn('[schema] Task #370 legacy task_routing_rules drop skipped:', (err as Error).message);
  }

  // ── Step 3: Backfill legacy task ownership onto agent-owned columns ──
  // We explicitly migrate old job-owned rows instead of teaching runtime
  // authority checks to fall back to legacy job_id/review_owner_job_id.
  try {
    const taskCols = new Set(
      (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map((col) => col.name),
    );
    const hasLegacyJobId = taskCols.has('job_id');
    const hasLegacyReviewOwnerJobId = taskCols.has('review_owner_job_id');

    if (hasLegacyJobId) {
      const assignmentColumn = taskCols.has('assigned_agent_id') ? 'assigned_agent_id' : 'agent_id';
      const backfillAgentOwnership = db.prepare(`
        UPDATE tasks
        SET ${assignmentColumn} = (
          SELECT jt.agent_id
          FROM job_templates jt
          WHERE jt.id = tasks.job_id
          LIMIT 1
        )
        WHERE ${assignmentColumn} IS NULL
          AND job_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM job_templates jt
            WHERE jt.id = tasks.job_id
              AND jt.agent_id IS NOT NULL
          )
      `).run();
      if (backfillAgentOwnership.changes > 0) {
        console.log(`[schema] Task #593: backfilled ${assignmentColumn} on ${backfillAgentOwnership.changes} legacy job-owned task(s)`);
      }
    }

    if (hasLegacyReviewOwnerJobId) {
      const backfillReviewOwnership = db.prepare(`
        UPDATE tasks
        SET review_owner_agent_id = (
          SELECT jt.agent_id
          FROM job_templates jt
          WHERE jt.id = tasks.review_owner_job_id
          LIMIT 1
        )
        WHERE review_owner_agent_id IS NULL
          AND review_owner_job_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM job_templates jt
            WHERE jt.id = tasks.review_owner_job_id
              AND jt.agent_id IS NOT NULL
          )
      `).run();
      if (backfillReviewOwnership.changes > 0) {
        console.log(`[schema] Task #593: backfilled review_owner_agent_id on ${backfillReviewOwnership.changes} legacy review-owned task(s)`);
      }
    }

    const agentCols = new Set(
      (db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>).map((col) => col.name),
    );

    if (agentCols.has('project_id') && agentCols.has('enabled')) {
      const assignmentColumn = taskCols.has('assigned_agent_id') ? 'assigned_agent_id' : 'agent_id';
      const viaProject = db.prepare(`
        UPDATE tasks
        SET ${assignmentColumn} = (
          SELECT a.id FROM agents a
          WHERE a.project_id = tasks.project_id
            AND a.enabled = 1
          ORDER BY a.id ASC
          LIMIT 1
        )
        WHERE ${assignmentColumn} IS NULL
          AND status IN ('done', 'cancelled', 'failed')
      `).run();
      if (viaProject.changes > 0) {
        console.log(`[schema] Task #593: backfilled ${assignmentColumn} on ${viaProject.changes} terminal task(s) via project fallback`);
      }
    } else {
      console.log('[schema] Task #593: skipped terminal task agent_id backfill until agents.project_id/enabled exist');
    }
  } catch (err) {
    console.error('[schema] Task #593: step 3 task ownership backfill failed:', err);
  }

  // ── Step 4: Make job_instances.template_id nullable ──
  // NO-OP: Task #579 Phase 5 migration now drops template_id entirely.
  // This step was only needed as a bridge between Phase 3 and Phase 5.

  // ── Task #643 / #852: tenant-owned skills table ──
  // Product-managed skills are tenant-local records. System/shared semantics must be
  // explicit rows in this table (for example source='system'), never implicit reads
  // from the global workspace filesystem API path.
  const createSkillsTableSql = `
    CREATE TABLE IF NOT EXISTS skills (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id    INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      content      TEXT NOT NULL DEFAULT '',
      source       TEXT NOT NULL DEFAULT 'atlas' CHECK(source IN ('atlas','workspace','system')),
      fs_path      TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, name)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_tenant_name ON skills(tenant_id, name);
    CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
    CREATE INDEX IF NOT EXISTS idx_skills_tenant ON skills(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source);
  `;
  if (!tableExists(db, 'skills')) {
    db.exec(createSkillsTableSql);
  } else {
    const skillsTableSql = getTableSql('skills');
    const skillColumns = new Set(getColumns('skills'));
    const hasSkillsTenantFk = (db.prepare(`PRAGMA foreign_key_list(skills)`).all() as Array<{ from: string; table: string; on_delete: string }>)
      .some((fk) => fk.from === 'tenant_id' && fk.table === 'tenants' && fk.on_delete.toUpperCase() === 'CASCADE');
    const needsSkillsRebuild = !skillColumns.has('tenant_id')
      || !hasSkillsTenantFk
      || /name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(skillsTableSql)
      || !skillsTableSql.includes('UNIQUE(tenant_id, name)');
    if (needsSkillsRebuild) {
      const defaultTenantId = getDefaultTenantId();
      const sourceColumns = new Set(getColumns('skills'));
      const tempTable = `skills_rebuild_${Date.now()}`;
      const selectExpressionByColumn: Record<string, string> = {
        id: sourceColumns.has('id') ? 'id' : 'NULL AS id',
        tenant_id: sourceColumns.has('tenant_id') ? `COALESCE(tenant_id, ${defaultTenantId}) AS tenant_id` : `${defaultTenantId} AS tenant_id`,
        name: sourceColumns.has('name') ? `COALESCE(name, 'skill-' || id) AS name` : `'skill-' || id AS name`,
        description: sourceColumns.has('description') ? `COALESCE(description, '') AS description` : `'' AS description`,
        content: sourceColumns.has('content') ? `COALESCE(content, '') AS content` : `'' AS content`,
        source: sourceColumns.has('source') ? `CASE source WHEN 'atlas' THEN 'atlas' WHEN 'workspace' THEN 'workspace' WHEN 'system' THEN 'system' ELSE 'atlas' END AS source` : `'atlas' AS source`,
        fs_path: sourceColumns.has('fs_path') ? 'fs_path' : 'NULL AS fs_path',
        created_at: sourceColumns.has('created_at') ? `COALESCE(created_at, datetime('now')) AS created_at` : `datetime('now') AS created_at`,
        updated_at: sourceColumns.has('updated_at') ? `COALESCE(updated_at, datetime('now')) AS updated_at` : `datetime('now') AS updated_at`,
      };
      db.pragma('foreign_keys = OFF');
      const rebuildSkills = db.transaction(() => {
        db.prepare(`ALTER TABLE skills RENAME TO ${tempTable}`).run();
        db.exec(createSkillsTableSql.replace('CREATE TABLE IF NOT EXISTS skills', 'CREATE TABLE skills'));
        db.prepare(`
          INSERT OR IGNORE INTO skills (id, tenant_id, name, description, content, source, fs_path, created_at, updated_at)
          SELECT ${['id','tenant_id','name','description','content','source','fs_path','created_at','updated_at'].map((column) => selectExpressionByColumn[column]).join(', ')}
          FROM ${tempTable}
        `).run();
        db.prepare(`DROP TABLE ${tempTable}`).run();
      });
      try {
        rebuildSkills();
      } finally {
        db.pragma('foreign_keys = ON');
      }
      console.log('[schema] Migrated: rebuilt skills table with tenant-local uniqueness');
    } else {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_tenant_name ON skills(tenant_id, name);
        CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
        CREATE INDEX IF NOT EXISTS idx_skills_tenant ON skills(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source);
      `);
    }
  }

  // ── Step 5: Validation — log Phase 5 pre-condition status ──
  try {
    const checks = [
      ...((db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).some(col => col.name === 'job_id') ? [{
        label: 'legacy tasks with job_id but no agent_id (non-terminal)',
        sql: `SELECT COUNT(*) as n FROM tasks WHERE job_id IS NOT NULL AND agent_id IS NULL AND status NOT IN ('done','cancelled','failed')`,
        wantZero: true,
      }] : []),
      {
        label: 'sprint_task_routing_rules with no agent_id',
        sql: `SELECT COUNT(*) as n FROM sprint_task_routing_rules WHERE agent_id IS NULL`,
        wantZero: true,
      },
      {
        label: 'job_instances with no agent_id',
        sql: `SELECT COUNT(*) as n FROM job_instances WHERE agent_id IS NULL`,
        wantZero: true,
      },
    ];

    let allPassed = true;
    for (const check of checks) {
      try {
        const row = db.prepare(check.sql).get() as { n: number } | undefined;
        const n = row?.n ?? 0;
        const passed = check.wantZero ? n === 0 : n > 0;
        if (!passed) {
          allPassed = false;
          console.warn(`[schema] Task #593 validation FAIL — ${check.label}: ${n}`);
        }
      } catch { /* table may not exist */ }
    }

    if (allPassed) {
      console.log('[schema] Task #593 validation PASSED — all Phase 5 pre-conditions met');
    } else {
      console.warn('[schema] Task #593 validation: some pre-conditions not yet met (see above)');
    }
  } catch (err) {
    console.error('[schema] Task #593: step 5 validation failed:', err);
  }
}

// ── Task #586: Pipeline Intelligence Telemetry — Event Model ─────────────────
export async function ensurePipelineIntelligenceTelemetry(): Promise<void> {
  const db = getRawDb();

  // 1. task_events table
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      sprint_id   INTEGER,
      agent_id    INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      from_status TEXT,
      to_status   TEXT NOT NULL,
      moved_by    TEXT NOT NULL DEFAULT 'system',
      move_type   TEXT NOT NULL DEFAULT 'automatic'
        CHECK(move_type IN ('automatic','outcome','manual','rescue','dispatch')),
      instance_id INTEGER REFERENCES job_instances(id) ON DELETE SET NULL,
      reason      TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_events_task      ON task_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_events_project   ON task_events(project_id);
    CREATE INDEX IF NOT EXISTS idx_task_events_agent     ON task_events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_task_events_to_status ON task_events(to_status);
    CREATE INDEX IF NOT EXISTS idx_task_events_created   ON task_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_task_events_move_type ON task_events(move_type);
  `);
  console.log('[schema] Task #586: task_events table ensured');

  // 2. integrity_events table
  db.exec(`
    CREATE TABLE IF NOT EXISTS integrity_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      agent_id     INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      instance_id  INTEGER REFERENCES job_instances(id) ON DELETE SET NULL,
      anomaly_type TEXT NOT NULL
        CHECK(anomaly_type IN (
          'missing_review_evidence',
          'missing_qa_evidence',
          'commit_mismatch',
          'deployed_not_verified',
          'stale_outcome_write',
          'branch_missing_on_origin',
          'evidence_placeholder'
        )),
      detail       TEXT,
      resolved     INTEGER NOT NULL DEFAULT 0,
      resolved_at  TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_integrity_events_task         ON integrity_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_integrity_events_project      ON integrity_events(project_id);
    CREATE INDEX IF NOT EXISTS idx_integrity_events_agent        ON integrity_events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_integrity_events_anomaly_type ON integrity_events(anomaly_type);
    CREATE INDEX IF NOT EXISTS idx_integrity_events_created      ON integrity_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_integrity_events_resolved     ON integrity_events(resolved);
  `);
  console.log('[schema] Task #586: integrity_events table ensured');

  // 3. job_instances: failure_stage column
  try {
    const cols = db.prepare(`PRAGMA table_info(job_instances)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'failure_stage')) {
      db.exec(`ALTER TABLE job_instances ADD COLUMN failure_stage TEXT DEFAULT NULL`);
      console.log('[schema] Task #586: added failure_stage to job_instances');
    }
  } catch (err) {
    console.error('[schema] Task #586: failed to add failure_stage:', err);
  }

  // 4. agents: job_instructions tracking
  try {
    const agentCols = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>;
    if (!agentCols.some(c => c.name === 'job_instructions_updated_at')) {
      db.exec(`ALTER TABLE agents ADD COLUMN job_instructions_updated_at TEXT DEFAULT NULL`);
      console.log('[schema] Task #586: added job_instructions_updated_at to agents');
    }
    if (!agentCols.some(c => c.name === 'instructions_version')) {
      db.exec(`ALTER TABLE agents ADD COLUMN instructions_version INTEGER NOT NULL DEFAULT 0`);
      console.log('[schema] Task #586: added instructions_version to agents');
    }
    if (!agentCols.some(c => c.name === 'deleted_at')) {
      db.exec(`ALTER TABLE agents ADD COLUMN deleted_at TEXT DEFAULT NULL`);
      console.log('[schema] Task #404: added deleted_at to agents');
    }
  } catch (err) {
    console.error('[schema] Task #586: agent column migration failed:', err);
  }

  // Task #407: remove legacy pre_instructions storage columns after backfilling canonical fields.
  try {
    const agentCols407 = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>;
    const hasLegacyPreInstructions407 = agentCols407.some((c) => c.name === 'pre_instructions');
    const hasLegacyPreInstructionsUpdatedAt407 = agentCols407.some((c) => c.name === 'pre_instructions_updated_at');
    const hasJobInstructions407 = agentCols407.some((c) => c.name === 'job_instructions');
    const hasJobInstructionsUpdatedAt407 = agentCols407.some((c) => c.name === 'job_instructions_updated_at');

    if (hasLegacyPreInstructions407 && hasJobInstructions407) {
      db.exec(`
        UPDATE agents
        SET job_instructions = CASE
          WHEN (job_instructions IS NULL OR TRIM(job_instructions) = '')
            AND pre_instructions IS NOT NULL
            AND TRIM(pre_instructions) <> ''
          THEN pre_instructions
          ELSE job_instructions
        END
      `);
    }

    if (hasLegacyPreInstructionsUpdatedAt407 && hasJobInstructionsUpdatedAt407) {
      db.exec(`
        UPDATE agents
        SET job_instructions_updated_at = COALESCE(job_instructions_updated_at, pre_instructions_updated_at)
        WHERE pre_instructions_updated_at IS NOT NULL
      `);
    }

    if (hasLegacyPreInstructions407) {
      db.exec(`ALTER TABLE agents DROP COLUMN pre_instructions`);
      console.log('[schema] Task #407: dropped legacy agents.pre_instructions column');
    }
    if (hasLegacyPreInstructionsUpdatedAt407) {
      db.exec(`ALTER TABLE agents DROP COLUMN pre_instructions_updated_at`);
      console.log('[schema] Task #407: dropped legacy agents.pre_instructions_updated_at column');
    }
  } catch (err) {
    console.error('[schema] Task #407: failed to drop legacy pre_instructions columns:', err);
  }

  // 5. tasks: dispatch tracking + manual intervention counter
  try {
    const taskCols = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
    if (!taskCols.some(c => c.name === 'first_dispatched_at')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN first_dispatched_at TEXT DEFAULT NULL`);
      console.log('[schema] Task #586: added first_dispatched_at to tasks');
    }
    if (!taskCols.some(c => c.name === 'total_dispatch_count')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN total_dispatch_count INTEGER NOT NULL DEFAULT 0`);
      console.log('[schema] Task #586: added total_dispatch_count to tasks');
    }
    if (!taskCols.some(c => c.name === 'manual_intervention_count')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN manual_intervention_count INTEGER NOT NULL DEFAULT 0`);
      console.log('[schema] Task #586: added manual_intervention_count to tasks');
    }
  } catch (err) {
    console.error('[schema] Task #586: task column migration failed:', err);
  }

  // ── Task #596: Remove legacy jobs infrastructure ────────────────────────────
  // Drop tables that are no longer referenced. sprint_job_schedules has an FK
  // from sprint_schedule_fires, so drop the dependent table first.
  try {
    db.exec(`DROP TABLE IF EXISTS sprint_schedule_fires`);
    db.exec(`DROP TABLE IF EXISTS routing_config_legacy`);
    db.exec(`DROP TABLE IF EXISTS sprint_job_schedules`);
    db.exec(`DROP TABLE IF EXISTS sprint_job_assignments`);
    console.log('[schema] Task #596: dropped legacy tables (routing_config_legacy, sprint_job_schedules, sprint_job_assignments, sprint_schedule_fires)');
  } catch (err) {
    console.error('[schema] Task #596: drop legacy tables failed:', err);
  }

  // ── Task #616: Retire legacy per-agent schedules ───────────────────────────
  // agents.schedule remains as a compatibility column for older DBs/rows, but
  // recurring task series are now the only active scheduling path.
  try {
    const agentCols616 = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>;
    if (agentCols616.some(c => c.name === 'schedule')) {
      const cleared = db.prepare(`UPDATE agents SET schedule = '' WHERE COALESCE(schedule, '') != ''`).run();
      if (cleared.changes > 0) {
        console.log(`[schema] Task #616: cleared ${cleared.changes} legacy agent schedule(s)`);
      }
    }
  } catch (err) {
    console.error('[schema] Task #616: failed to clear legacy agent schedules:', err);
  }

  // ── Task #53: Drop job_template_id FK column from agents ───────────────────
  // The job_templates table was dropped in Task #596, but agents.job_template_id
  // still carried a REFERENCES job_templates(id) FK. With foreign_keys = ON,
  // any write operation touching agents (including DELETE) causes SQLite to
  // validate the FK against the now-missing table, crashing with:
  //   SqliteError: no such table: main.job_templates
  // Fix: drop the stale column. SQLite >= 3.35.0 supports ALTER TABLE ... DROP COLUMN
  // when the column has no dependencies (indexes, triggers, generated columns).
  // The FK constraint is stored only in the column definition, so DROP COLUMN works.
  try {
    const agentCols53 = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>;
    if (agentCols53.some(c => c.name === 'job_template_id')) {
      db.exec(`ALTER TABLE agents DROP COLUMN job_template_id`);
      console.log('[schema] Task #53: dropped stale job_template_id column from agents');
    }
  } catch (err) {
    console.error('[schema] Task #53: failed to drop job_template_id from agents:', err);
  }

  // Task #449: idempotent receipts for trusted external task event callbacks.
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_task_event_receipts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint    TEXT NOT NULL UNIQUE,
      source         TEXT NOT NULL,
      event          TEXT NOT NULL,
      task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      environment_id TEXT NOT NULL,
      queue_id       TEXT NOT NULL,
      lease_id       TEXT NOT NULL,
      branch         TEXT,
      commit_sha     TEXT,
      review_url     TEXT,
      message        TEXT NOT NULL,
      payload_json   TEXT NOT NULL,
      received_by    TEXT NOT NULL DEFAULT 'system',
      processing_state TEXT NOT NULL DEFAULT 'received',
      processing_error TEXT,
      mapping_id INTEGER,
      mapping_action_kind TEXT,
      mapping_action_target TEXT,
      request_metadata_json TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_external_task_event_receipts_task ON external_task_event_receipts(task_id);
    CREATE INDEX IF NOT EXISTS idx_external_task_event_receipts_source_event ON external_task_event_receipts(source, event);
    CREATE INDEX IF NOT EXISTS idx_external_task_event_receipts_lease ON external_task_event_receipts(lease_id);
  `);
  for (const [column, definition] of [
    ['processing_state', `TEXT NOT NULL DEFAULT 'received'`],
    ['processing_error', 'TEXT'],
    ['mapping_id', 'INTEGER'],
    ['mapping_action_kind', 'TEXT'],
    ['mapping_action_target', 'TEXT'],
    ['request_metadata_json', 'TEXT'],
  ] as const) {
    if (!await tableHasColumn(new SqliteAdapter(db), 'external_task_event_receipts', column)) {
      db.prepare(`ALTER TABLE external_task_event_receipts ADD COLUMN ${column} ${definition}`).run();
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_external_task_event_receipts_processing_state ON external_task_event_receipts(processing_state);`);

  // Task #491/#569: configurable workflow-event routing for internal and callback-driven task state changes.
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_event_mappings (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id            INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      sprint_id             INTEGER REFERENCES sprints(id) ON DELETE CASCADE,
      sprint_type           TEXT,
      source                TEXT,
      event_name            TEXT NOT NULL,
      task_type             TEXT,
      status_includes_json  TEXT NOT NULL DEFAULT '[]',
      status_excludes_json  TEXT NOT NULL DEFAULT '[]',
      action_kind           TEXT NOT NULL DEFAULT 'ignore',
      action_target         TEXT,
      apply_review_evidence INTEGER NOT NULL DEFAULT 0,
      apply_failure_detail  INTEGER NOT NULL DEFAULT 0,
      enabled               INTEGER NOT NULL DEFAULT 1,
      priority              INTEGER NOT NULL DEFAULT 0,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_external_event_mappings_lookup
      ON external_event_mappings(event_name, source, project_id, task_type, enabled, priority);
  `);
  await ensureTableColumn(db, 'external_event_mappings', 'sprint_id', `sprint_id INTEGER REFERENCES sprints(id) ON DELETE CASCADE`);
  await ensureTableColumn(db, 'external_event_mappings', 'sprint_type', `sprint_type TEXT`);
  db.exec(`
    UPDATE external_event_mappings
    SET project_id = COALESCE(project_id, (SELECT s.project_id FROM sprints s WHERE s.id = external_event_mappings.sprint_id)),
        sprint_type = COALESCE(sprint_type, (SELECT s.sprint_type FROM sprints s WHERE s.id = external_event_mappings.sprint_id))
    WHERE sprint_id IS NOT NULL
      AND (project_id IS NULL OR sprint_type IS NULL)
      AND EXISTS (SELECT 1 FROM sprints s WHERE s.id = external_event_mappings.sprint_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_external_event_mappings_scope_lookup
      ON external_event_mappings(project_id, sprint_type, sprint_id, event_name, source, task_type, enabled, priority);
  `);

  // Some legacy task-table constraint migrations rebuild tasks and recreate only
  // historic indexes. Re-assert recurring generated-task indexes after rebuilds.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_generated_lookup
      ON tasks(recurring_series_id, scheduled_for)
      WHERE recurring_series_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tasks_schedule_run
      ON tasks(schedule_run_id)
      WHERE schedule_run_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_generated_occurrence_unique
      ON tasks(recurring_series_id, scheduled_for)
      WHERE recurring_series_id IS NOT NULL
        AND scheduled_for IS NOT NULL
        AND generated_from = 'recurring_task_series';
  `);
  ensureTasksRequireWorkflow(db);
  if (activeTenantMode === 'verify') {
    await verifyTenantSchemaForStartup(new SqliteAdapter(db));
  } else {
    await ensureTenantSchema(new SqliteAdapter(db));
    // Legacy upgrade path: projects.tenant_id is only added by ensureTenantSchema,
    // so repeat the version-history backfill that was skipped earlier in this run.
    await backfillProjectFileVersionHistory(db);
  }
  await ensureNotificationTables(new SqliteAdapter(db));
  // After ensureTenantSchema: the table's tenant_id references tenants(id).
  await ensureRoutingConfigAuditLogTable(new SqliteAdapter(db));

  try {
    migrateAgentSessionKeysToCanonical(db);
  } catch (err) {
    console.error('[schema] Task #91/92: agent session key migration failed:', err);
  }
}

async function backfillProjectFileVersionHistory(db: Database.Database): Promise<void> {
  // Requires projects.tenant_id, which legacy databases gain only once
  // ensureTenantSchema has run. Idempotent: INSERT OR IGNORE + NOT EXISTS,
  // and the UPDATE only touches rows that still need backfilling.
  if (!await tableHasColumn(new SqliteAdapter(db), 'projects', 'tenant_id')) return;
  if (!tableExists(db, 'project_files') || !tableExists(db, 'project_file_versions')) return;

  db.exec(`
    INSERT OR IGNORE INTO project_file_versions (
      tenant_id, project_id, file_id, version_number, filename, original_name, mime_type,
      size_bytes, file_path, created_by, created_at, change_source
    )
    SELECT p.tenant_id, pf.project_id, pf.id, 1, pf.filename, pf.original_name, pf.mime_type,
      pf.size_bytes, pf.file_path, pf.uploaded_by, pf.created_at, 'backfill'
    FROM project_files pf
    JOIN projects p ON p.id = pf.project_id
    WHERE NOT EXISTS (
      SELECT 1 FROM project_file_versions pfv WHERE pfv.file_id = pf.id AND pfv.version_number = 1
    );

    UPDATE project_files
    SET
      updated_by = COALESCE(NULLIF(updated_by, ''), uploaded_by, 'manual'),
      updated_at = COALESCE(NULLIF(updated_at, ''), created_at, datetime('now')),
      current_version = COALESCE(NULLIF(current_version, 0), 1),
      current_version_id = COALESCE(
        current_version_id,
        (SELECT pfv.id FROM project_file_versions pfv WHERE pfv.file_id = project_files.id AND pfv.version_number = project_files.current_version)
      )
    WHERE current_version_id IS NULL OR updated_by IS NULL OR updated_at IS NULL OR current_version IS NULL;
  `);
}
