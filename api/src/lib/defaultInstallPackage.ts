import type Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { seedTenantDefaultWorkflowEventMappings } from '../domains/routing/externalEventMappings';
import { seedSprintTaskPolicy, seedSprintTypeTaskStatuses } from '../domains/routing/policy/seed';
import { policyTransitionsForSprintType } from '../domains/routing/policy/metadata';
import {
  STARTER_BACKLOG_SPRINT_NAME,
  STARTER_FIELD_SCHEMA_SEEDS,
  STARTER_SPRINT_OUTCOME_SEEDS,
  STARTER_SPRINT_TYPE_SEEDS,
  STARTER_SPRINT_TYPE_TASK_TYPE_SEEDS,
  type StarterSprintTypeKey,
} from './starterCatalog';
import { seedStarterWorkflowRelationshipTypes } from './taskRelationshipTypes';
import { buildCanonicalAgentMainSessionKey, slugifySessionKeyPart } from './sessionKeys';
import { AGENT_MCP_CAPABILITY_CATALOG } from './mcpApiAuth';
import { ensureTenantAgentHqMcpServer, repairAgentMcpAssignmentsForTenant } from './tenantContext';
import { buildRuntimeConfigDefaults } from './runtimeOnboarding';

export const DEFAULT_INSTALL_PACKAGE_KEY = 'agent-hq-default';
export const DEFAULT_INSTALL_PACKAGE_VERSION = 1;
export const DEFAULT_INSTALL_PROJECT_NAME = 'Default Project';
export const DEFAULT_INSTALL_PROJECT_DESCRIPTION = 'Starter tenant project for Agent HQ workflows and agents.';

type PackageMode = 'install' | 'reinstall';

export type DefaultInstallPackageResult = {
  package_key: string;
  version: number;
  tenant_id: number;
  mode: PackageMode;
  created: Record<string, number>;
  restored: Record<string, number>;
  updated: Record<string, number>;
  conflicts: Array<{ kind: string; key: string; message: string }>;
};

type StarterAgentSeed = {
  key: 'pm' | 'developer' | 'review' | 'ops';
  name: string;
  role: string;
  jobTitle: string;
  systemRole: string;
  provider: string;
  model: string | null;
  runtimeConfig: Record<string, unknown>;
  capabilityKeys: string[];
};

export const DEFAULT_INSTALL_AGENT_SEEDS: StarterAgentSeed[] = [
  {
    key: 'pm',
    name: 'PM Agent',
    role: 'Product manager and workflow coordinator',
    jobTitle: 'PM Agent',
    systemRole: 'default_pm',
    provider: 'anthropic',
    model: null,
    runtimeConfig: {
      default_work_size: 'small',
      evidence_required: true,
      lifecycle_tools_required: true,
      handoff_summary_required: true,
    },
    capabilityKeys: [
      'discovery.read_catalog',
      'tasks.read_active_context',
      'tasks.write_active_lifecycle',
      'projects.read_active_project',
      'sprints.read_active_sprint',
      'workflow.read_active_configuration',
    ],
  },
  {
    key: 'developer',
    name: 'Developer Agent',
    role: 'Implementation engineer for software delivery tasks',
    jobTitle: 'Developer Agent',
    systemRole: 'default_developer',
    provider: 'anthropic',
    model: null,
    runtimeConfig: {
      default_work_size: 'medium',
      evidence_required: true,
      lifecycle_tools_required: true,
      implementation_evidence_required: true,
    },
    capabilityKeys: [
      'discovery.read_catalog',
      'tasks.read_active_context',
      'tasks.write_active_lifecycle',
      'projects.read_active_project',
      'projects.manage_active_files',
      'sprints.read_active_sprint',
      'workflow.read_active_configuration',
    ],
  },
  {
    key: 'review',
    name: 'Review Agent',
    role: 'Review and QA verifier for completed work',
    jobTitle: 'Review Agent',
    systemRole: 'default_review',
    provider: 'anthropic',
    model: null,
    runtimeConfig: {
      default_work_size: 'medium',
      evidence_required: true,
      lifecycle_tools_required: true,
      verification_evidence_required: true,
    },
    capabilityKeys: [
      'discovery.read_catalog',
      'tasks.read_active_context',
      'tasks.write_active_lifecycle',
      'projects.read_active_project',
      'projects.manage_active_files',
      'sprints.read_active_sprint',
      'workflow.read_active_configuration',
    ],
  },
  {
    key: 'ops',
    name: 'Ops Agent',
    role: 'Operations, release, and incident response agent',
    jobTitle: 'Ops Agent',
    systemRole: 'default_ops',
    provider: 'anthropic',
    model: null,
    runtimeConfig: {
      default_work_size: 'large',
      evidence_required: true,
      lifecycle_tools_required: true,
      operational_evidence_required: true,
    },
    capabilityKeys: [
      'discovery.read_catalog',
      'tasks.read_active_context',
      'tasks.write_active_lifecycle',
      'projects.read_active_project',
      'projects.manage_active_files',
      'sprints.read_active_sprint',
      'workflow.read_active_configuration',
      'external.write_task_events',
    ],
  },
];

const DEFAULT_AGENT_DOCS: Record<string, string> = {
  'SOUL.md': [
    '# SOUL.md - Agent HQ Starter Agent',
    '',
    'You are a starter Agent HQ agent. Work from explicit task contracts, keep tenant data isolated, and leave durable evidence for handoffs.',
    '',
  ].join('\n'),
  'IDENTITY.md': [
    '# IDENTITY.md',
    '',
    '- **Name:**',
    '- **Role:** Agent HQ starter agent',
    '- **Vibe:** Practical, careful, evidence-based',
    '- **Emoji:**',
    '',
  ].join('\n'),
  'USER.md': [
    '# USER.md',
    '',
    'Record tenant-specific operator preferences here as they are learned.',
    '',
  ].join('\n'),
  'TOOLS.md': [
    '# TOOLS.md',
    '',
    'Record tenant-local tool notes, environment details, and operational shortcuts here.',
    '',
  ].join('\n'),
  'AGENTS.md': [
    '# AGENTS.md',
    '',
    'Follow the Agent HQ task contract supplied at dispatch time. Use lifecycle tools for task notes, evidence, check-ins, and outcomes.',
    '',
  ].join('\n'),
};

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`).get(table));
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
}

function addCount(target: Record<string, number>, key: string, amount = 1): void {
  target[key] = (target[key] ?? 0) + amount;
}

function ensurePackageLedger(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS default_package_applications (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id        INTEGER NOT NULL,
      package_key      TEXT NOT NULL,
      package_version  INTEGER NOT NULL,
      applied_at       TEXT NOT NULL DEFAULT (datetime('now')),
      mode             TEXT NOT NULL DEFAULT 'install',
      created_json     TEXT NOT NULL DEFAULT '{}',
      restored_json    TEXT NOT NULL DEFAULT '{}',
      updated_json     TEXT NOT NULL DEFAULT '{}',
      conflicts_json   TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_default_package_applications_tenant
      ON default_package_applications(tenant_id, package_key, package_version);
  `);
}

function createResult(tenantId: number, mode: PackageMode): DefaultInstallPackageResult {
  return {
    package_key: DEFAULT_INSTALL_PACKAGE_KEY,
    version: DEFAULT_INSTALL_PACKAGE_VERSION,
    tenant_id: tenantId,
    mode,
    created: {},
    restored: {},
    updated: {},
    conflicts: [],
  };
}

function tenantPredicate(db: Database.Database, table: string): string {
  return tableHasColumn(db, table, 'tenant_id') ? 'AND tenant_id = ?' : '';
}

function tenantArgs(db: Database.Database, table: string, tenantId: number): unknown[] {
  return tableHasColumn(db, table, 'tenant_id') ? [tenantId] : [];
}

function ensureWorkflowTypes(db: Database.Database, tenantId: number, result: DefaultInstallPackageResult): void {
  const hasTenant = tableHasColumn(db, 'sprint_types', 'tenant_id');
  const select = db.prepare(`
    SELECT id, name, description, is_system
    FROM sprint_types
    WHERE key = ?
      ${tenantPredicate(db, 'sprint_types')}
    LIMIT 1
  `);
  const insert = db.prepare(hasTenant
    ? `INSERT INTO sprint_types (tenant_id, key, name, description, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`
    : `INSERT INTO sprint_types (key, name, description, is_system, created_at, updated_at) VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))`);
  const update = db.prepare(`
    UPDATE sprint_types
    SET name = ?, description = ?, is_system = 1, updated_at = datetime('now')
    WHERE key = ?
      ${tenantPredicate(db, 'sprint_types')}
  `);

  for (const seed of STARTER_SPRINT_TYPE_SEEDS) {
    const existing = select.get(seed.key, ...tenantArgs(db, 'sprint_types', tenantId)) as { id: number; name: string; description: string; is_system: number } | undefined;
    if (!existing) {
      insert.run(...(hasTenant ? [tenantId] : []), seed.key, seed.name, seed.description);
      addCount(result.created, 'workflow_types');
      continue;
    }
    if (existing.is_system === 1) {
      update.run(seed.name, seed.description, seed.key, ...tenantArgs(db, 'sprint_types', tenantId));
      addCount(result.updated, 'workflow_types');
    } else if (existing.name !== seed.name || existing.description !== seed.description) {
      result.conflicts.push({ kind: 'workflow_type', key: seed.key, message: 'Tenant-authored workflow type differs from the default package; left unchanged.' });
    }
  }
}

function ensureWorkflowDefinitionRows(db: Database.Database, tenantId: number, result: DefaultInstallPackageResult): void {
  const fieldHasTenant = tableHasColumn(db, 'task_field_schemas', 'tenant_id');
  const fieldSelect = db.prepare(`
    SELECT id, schema_json, is_system
    FROM task_field_schemas
    WHERE sprint_type_key = ? AND task_type IS NULL
      ${tenantPredicate(db, 'task_field_schemas')}
    LIMIT 1
  `);
  const fieldInsert = db.prepare(fieldHasTenant
    ? `INSERT INTO task_field_schemas (tenant_id, sprint_type_key, task_type, schema_json, is_system, created_at, updated_at) VALUES (?, ?, NULL, ?, 1, datetime('now'), datetime('now'))`
    : `INSERT INTO task_field_schemas (sprint_type_key, task_type, schema_json, is_system, created_at, updated_at) VALUES (?, NULL, ?, 1, datetime('now'), datetime('now'))`);
  const fieldUpdate = db.prepare(`
    UPDATE task_field_schemas
    SET schema_json = ?, is_system = 1, updated_at = datetime('now')
    WHERE sprint_type_key = ? AND task_type IS NULL
      ${tenantPredicate(db, 'task_field_schemas')}
  `);

  for (const seed of STARTER_FIELD_SCHEMA_SEEDS) {
    const schemaJson = JSON.stringify(seed.schema);
    const existing = fieldSelect.get(seed.sprintType, ...tenantArgs(db, 'task_field_schemas', tenantId)) as { id: number; schema_json: string; is_system: number } | undefined;
    if (!existing) {
      fieldInsert.run(...(fieldHasTenant ? [tenantId] : []), seed.sprintType, schemaJson);
      addCount(result.created, 'field_schemas');
    } else if (existing.is_system === 1) {
      fieldUpdate.run(schemaJson, seed.sprintType, ...tenantArgs(db, 'task_field_schemas', tenantId));
      addCount(result.updated, 'field_schemas');
    } else if (existing.schema_json !== schemaJson) {
      result.conflicts.push({ kind: 'field_schema', key: seed.sprintType, message: 'Tenant-authored field schema differs from the default package; left unchanged.' });
    }
  }

  const taskTypeHasTenant = tableHasColumn(db, 'sprint_type_task_types', 'tenant_id');
  const taskTypeSelect = db.prepare(`
    SELECT id, is_system
    FROM sprint_type_task_types
    WHERE sprint_type_key = ? AND task_type = ?
      ${tenantPredicate(db, 'sprint_type_task_types')}
    LIMIT 1
  `);
  const taskTypeInsert = db.prepare(taskTypeHasTenant
    ? `INSERT INTO sprint_type_task_types (tenant_id, sprint_type_key, task_type, is_system, created_at, updated_at) VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))`
    : `INSERT INTO sprint_type_task_types (sprint_type_key, task_type, is_system, created_at, updated_at) VALUES (?, ?, 1, datetime('now'), datetime('now'))`);
  for (const seed of STARTER_SPRINT_TYPE_TASK_TYPE_SEEDS) {
    for (const taskType of seed.taskTypes) {
      const existing = taskTypeSelect.get(seed.sprintType, taskType, ...tenantArgs(db, 'sprint_type_task_types', tenantId));
      if (existing) continue;
      taskTypeInsert.run(...(taskTypeHasTenant ? [tenantId] : []), seed.sprintType, taskType);
      addCount(result.created, 'task_types');
    }
  }

  const outcomeHasTenant = tableHasColumn(db, 'sprint_type_outcomes', 'tenant_id');
  const outcomeSelect = db.prepare(`
    SELECT id, is_system, label, description, enabled, behavior, badge_variant, stage_order, metadata_json
    FROM sprint_type_outcomes
    WHERE sprint_type_key = ? AND task_type IS ? AND outcome_key = ?
      ${tenantPredicate(db, 'sprint_type_outcomes')}
    LIMIT 1
  `);
  const outcomeInsert = db.prepare(outcomeHasTenant
    ? `INSERT INTO sprint_type_outcomes (tenant_id, sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, badge_variant, stage_order, is_system, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'))`
    : `INSERT INTO sprint_type_outcomes (sprint_type_key, task_type, outcome_key, label, description, enabled, behavior, badge_variant, stage_order, is_system, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'))`);
  const outcomeUpdate = db.prepare(`
    UPDATE sprint_type_outcomes
    SET label = ?, description = ?, enabled = ?, behavior = ?, badge_variant = ?, stage_order = ?, is_system = 1, metadata_json = ?, updated_at = datetime('now')
    WHERE sprint_type_key = ? AND task_type IS ? AND outcome_key = ?
      ${tenantPredicate(db, 'sprint_type_outcomes')}
  `);
  for (const seed of STARTER_SPRINT_OUTCOME_SEEDS) {
    for (const outcome of seed.outcomes) {
      const taskType = outcome.task_type ?? null;
      const enabled = outcome.enabled ?? 1;
      const behavior = outcome.behavior ?? (taskType ? 'extend' : 'base');
      const badge = outcome.badge_variant ?? null;
      const metadataJson = JSON.stringify(outcome.metadata ?? {});
      const existing = outcomeSelect.get(seed.sprintType, taskType, outcome.outcome_key, ...tenantArgs(db, 'sprint_type_outcomes', tenantId)) as { is_system: number } | undefined;
      if (!existing) {
        outcomeInsert.run(...(outcomeHasTenant ? [tenantId] : []), seed.sprintType, taskType, outcome.outcome_key, outcome.label, outcome.description, enabled, behavior, badge, outcome.stage_order, metadataJson);
        addCount(result.created, 'outcomes');
      } else if (existing.is_system === 1) {
        outcomeUpdate.run(outcome.label, outcome.description, enabled, behavior, badge, outcome.stage_order, metadataJson, seed.sprintType, taskType, outcome.outcome_key, ...tenantArgs(db, 'sprint_type_outcomes', tenantId));
        addCount(result.updated, 'outcomes');
      } else {
        result.conflicts.push({ kind: 'outcome', key: `${seed.sprintType}:${outcome.outcome_key}`, message: 'Tenant-authored outcome differs from the default package; left unchanged.' });
      }
    }
  }

  for (const sprintType of STARTER_SPRINT_TYPE_SEEDS) {
    seedSprintTypeTaskStatuses(db, sprintType.key, { tenantId });
  }
  seedStarterWorkflowRelationshipTypes(db, { tenantId });
}

function workspacePathForAgent(tenantSlug: string, agentKey: string): string {
  const home = process.env.HOME ?? os.homedir();
  const openclawRoot = process.env.WORKSPACE_PARENT ?? path.join(home, '.openclaw');
  return path.join(openclawRoot, `workspace-${slugifySessionKeyPart(tenantSlug, 'tenant')}-${agentKey}`);
}

function ensureDocs(workspacePath: string, seed: StarterAgentSeed): void {
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'memory'), { recursive: true });
  for (const [filename, content] of Object.entries(DEFAULT_AGENT_DOCS)) {
    const target = path.join(workspacePath, filename);
    if (fs.existsSync(target)) continue;
    const hydrated = filename === 'IDENTITY.md'
      ? content.replace('- **Name:**', `- **Name:** ${seed.name}`).replace('- **Role:** Agent HQ starter agent', `- **Role:** ${seed.role}`)
      : content;
    fs.writeFileSync(target, hydrated, 'utf-8');
  }
}

function ensureProject(db: Database.Database, tenantId: number, result: DefaultInstallPackageResult): number {
  const existing = db.prepare(`
    SELECT id, description, context_md
    FROM projects
    WHERE tenant_id = ? AND lower(name) = lower(?)
    ORDER BY id ASC
    LIMIT 1
  `).get(tenantId, DEFAULT_INSTALL_PROJECT_NAME) as { id: number; description: string; context_md: string } | undefined;
  if (existing) return existing.id;

  const legacy = db.prepare(`
    SELECT id
    FROM projects
    WHERE tenant_id = ? AND lower(name) = lower('Agent HQ')
    ORDER BY id ASC
    LIMIT 1
  `).get(tenantId) as { id: number } | undefined;
  if (legacy) {
    db.prepare(`
      UPDATE projects
      SET name = ?, description = CASE WHEN description IS NULL OR trim(description) = '' THEN ? ELSE description END
      WHERE id = ?
    `).run(DEFAULT_INSTALL_PROJECT_NAME, DEFAULT_INSTALL_PROJECT_DESCRIPTION, legacy.id);
    addCount(result.restored, 'projects');
    return legacy.id;
  }

  const inserted = db.prepare(`
    INSERT INTO projects (tenant_id, name, description, context_md)
    VALUES (?, ?, ?, ?)
  `).run(tenantId, DEFAULT_INSTALL_PROJECT_NAME, DEFAULT_INSTALL_PROJECT_DESCRIPTION, 'Starter workspace for this tenant.');
  addCount(result.created, 'projects');
  return Number(inserted.lastInsertRowid);
}

function ensureBacklog(db: Database.Database, tenantId: number, projectId: number, result: DefaultInstallPackageResult): number {
  const existing = db.prepare(`
    SELECT id
    FROM sprints
    WHERE tenant_id = ? AND project_id = ? AND (lower(name) = lower(?) OR sprint_type = 'generic')
    ORDER BY CASE WHEN lower(name) = lower(?) THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `).get(tenantId, projectId, STARTER_BACKLOG_SPRINT_NAME, STARTER_BACKLOG_SPRINT_NAME) as { id: number } | undefined;
  if (existing) {
    seedSprintTaskPolicy(db, existing.id);
    return existing.id;
  }
  const inserted = db.prepare(`
    INSERT INTO sprints (tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value)
    VALUES (?, ?, ?, '', 'generic', 'active', 'time', 'ongoing')
  `).run(tenantId, projectId, STARTER_BACKLOG_SPRINT_NAME);
  const sprintId = Number(inserted.lastInsertRowid);
  seedSprintTaskPolicy(db, sprintId);
  addCount(result.created, 'workflows');
  return sprintId;
}

function ensureStarterWorkflows(db: Database.Database, tenantId: number, projectId: number, result: DefaultInstallPackageResult): Map<StarterSprintTypeKey, number> {
  const workflowNames: Record<StarterSprintTypeKey, string> = {
    generic: STARTER_BACKLOG_SPRINT_NAME,
    dev: 'Development',
    ops: 'Operations',
  };
  const workflows = new Map<StarterSprintTypeKey, number>();
  const insert = db.prepare(`
    INSERT INTO sprints (tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value)
    VALUES (?, ?, ?, '', ?, 'active', 'time', 'ongoing')
  `);

  for (const seed of STARTER_SPRINT_TYPE_SEEDS) {
    const existing = db.prepare(`
      SELECT id
      FROM sprints
      WHERE tenant_id = ?
        AND project_id = ?
        AND sprint_type = ?
      ORDER BY CASE WHEN lower(name) = lower(?) THEN 0 ELSE 1 END, id ASC
      LIMIT 1
    `).get(tenantId, projectId, seed.key, workflowNames[seed.key]) as { id: number } | undefined;

    const sprintId = existing?.id ?? Number(insert.run(tenantId, projectId, workflowNames[seed.key], seed.key).lastInsertRowid);
    if (!existing) addCount(result.created, 'workflows');
    seedSprintTaskPolicy(db, sprintId);
    workflows.set(seed.key, sprintId);
  }

  return workflows;
}

function ensureAgent(db: Database.Database, tenantId: number, tenantSlug: string, projectId: number, seed: StarterAgentSeed, result: DefaultInstallPackageResult): number {
  const runtimeSlug = `${slugifySessionKeyPart(tenantSlug, 'tenant')}-${seed.key}`;
  const sessionKey = buildCanonicalAgentMainSessionKey({
    projectSlug: `${slugifySessionKeyPart(tenantSlug, 'tenant')}-default-project`,
    agentName: seed.name,
    role: seed.jobTitle,
  });
  const workspacePath = workspacePathForAgent(tenantSlug, seed.key);
  const runtimeConfig = { ...seed.runtimeConfig, ...buildRuntimeConfigDefaults(db) };
  ensureDocs(workspacePath, seed);
  const deletedFilter = tableHasColumn(db, 'agents', 'deleted_at') ? "AND (deleted_at IS NULL OR deleted_at = '')" : '';
  const existing = db.prepare(`
    SELECT id
    FROM agents
    WHERE tenant_id = ?
      AND (system_role = ? OR session_key = ? OR openclaw_agent_id = ? OR lower(name) = lower(?))
      ${deletedFilter}
    ORDER BY CASE WHEN system_role = ? THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `).get(tenantId, seed.systemRole, sessionKey, runtimeSlug, seed.name, seed.systemRole) as { id: number } | undefined;
  const hasJobInstructions = tableHasColumn(db, 'agents', 'job_instructions');
  const instructions = [
    `You are the ${seed.name} for the tenant's default Agent HQ package.`,
    '',
    'Use the active task contract as the source of truth. Keep work tenant-scoped, record meaningful evidence, and do not assume host-specific paths or external integrations.',
  ].join('\n');
  if (existing) {
    db.prepare(`
      UPDATE agents
      SET project_id = COALESCE(project_id, ?),
          role = CASE WHEN role IS NULL OR trim(role) = '' THEN ? ELSE role END,
          job_title = CASE WHEN job_title IS NULL OR trim(job_title) = '' THEN ? ELSE job_title END,
          system_role = COALESCE(system_role, ?),
          runtime_type = COALESCE(runtime_type, 'openclaw'),
          runtime_config = CASE WHEN runtime_config IS NULL OR trim(runtime_config) = '' THEN ? ELSE runtime_config END,
          openclaw_agent_id = CASE WHEN openclaw_agent_id IS NULL OR trim(openclaw_agent_id) = '' THEN ? ELSE openclaw_agent_id END,
          session_key = CASE WHEN session_key IS NULL OR trim(session_key) = '' THEN ? ELSE session_key END,
          workspace_path = CASE WHEN workspace_path IS NULL OR trim(workspace_path) = '' THEN ? ELSE workspace_path END,
          preferred_provider = CASE WHEN preferred_provider IS NULL OR trim(preferred_provider) = '' THEN ? ELSE preferred_provider END,
          model = COALESCE(model, ?),
          ${hasJobInstructions ? `job_instructions = CASE WHEN job_instructions IS NULL OR trim(job_instructions) = '' THEN ? ELSE job_instructions END,` : ''}
          enabled = COALESCE(enabled, 1),
          status = CASE WHEN status IS NULL OR trim(status) = '' THEN 'idle' ELSE status END,
          last_active = COALESCE(last_active, datetime('now'))
      WHERE id = ?
    `).run(...(hasJobInstructions
      ? [projectId, seed.role, seed.jobTitle, seed.systemRole, JSON.stringify(runtimeConfig), runtimeSlug, sessionKey, workspacePath, seed.provider, seed.model, instructions, existing.id]
      : [projectId, seed.role, seed.jobTitle, seed.systemRole, JSON.stringify(runtimeConfig), runtimeSlug, sessionKey, workspacePath, seed.provider, seed.model, existing.id]));
    addCount(result.restored, 'agents');
    return existing.id;
  }

  const columns = [
    'tenant_id', 'project_id', 'name', 'role', 'job_title', 'session_key', 'workspace_path', 'status',
    'openclaw_agent_id', 'runtime_type', 'runtime_config', 'preferred_provider', 'model',
    'system_role', 'enabled', 'timeout_seconds', 'skill_names', 'sort_rules',
  ];
  const values: unknown[] = [
    tenantId, projectId, seed.name, seed.role, seed.jobTitle, sessionKey, workspacePath, 'idle',
    runtimeSlug, 'openclaw', JSON.stringify(runtimeConfig), seed.provider, seed.model,
    seed.systemRole, 1, 900, '[]', '[]',
  ];
  if (hasJobInstructions) {
    columns.push('job_instructions');
    values.push(instructions);
  }
  const inserted = db.prepare(`INSERT INTO agents (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...values);
  addCount(result.created, 'agents');
  return Number(inserted.lastInsertRowid);
}

function ensureAgentCapabilities(db: Database.Database, agentId: number, seed: StarterAgentSeed, result: DefaultInstallPackageResult): void {
  if (!tableExists(db, 'agent_mcp_capability_policies')) return;
  const validKeys = new Set<string>(AGENT_MCP_CAPABILITY_CATALOG.map((capability) => capability.key));
  const desired = new Set(seed.capabilityKeys.filter((key) => validKeys.has(key)));
  const insert = db.prepare(`
    INSERT INTO agent_mcp_capability_policies (agent_id, capability_key, enabled, created_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(agent_id, capability_key) DO NOTHING
  `);
  for (const capability of AGENT_MCP_CAPABILITY_CATALOG) {
    const resultRow = insert.run(agentId, capability.key, desired.has(capability.key) ? 1 : 0);
    if (resultRow.changes > 0) addCount(result.created, 'agent_capability_policies');
  }
}

function ensureAgentHqMcpAssignment(db: Database.Database, tenantId: number, agentId: number, result: DefaultInstallPackageResult): void {
  if (!tableExists(db, 'mcp_servers') || !tableExists(db, 'agent_mcp_assignments') || !tableHasColumn(db, 'mcp_servers', 'tenant_id')) return;
  const serverId = ensureTenantAgentHqMcpServer(db, tenantId);
  if (!serverId) return;
  repairAgentMcpAssignmentsForTenant(db, tenantId, agentId);
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO agent_mcp_assignments (agent_id, mcp_server_id, overrides, enabled)
    VALUES (?, ?, '{}', 1)
  `).run(agentId, serverId);
  if (inserted.changes > 0) addCount(result.created, 'agent_mcp_assignments');
}

function ensureRouting(db: Database.Database, tenantId: number, projectId: number, agentsByKey: Map<StarterAgentSeed['key'], number>, result: DefaultInstallPackageResult): void {
  const pm = agentsByKey.get('pm')!;
  const developer = agentsByKey.get('developer')!;
  const review = agentsByKey.get('review')!;
  const ops = agentsByKey.get('ops')!;
  const rules: Array<{ sprintType: StarterSprintTypeKey; taskType: string; status: string; agentId: number; priority: number }> = [
    { sprintType: 'generic', taskType: 'adhoc', status: 'ready', agentId: pm, priority: 100 },
    { sprintType: 'generic', taskType: 'other', status: 'ready', agentId: pm, priority: 100 },
    { sprintType: 'generic', taskType: 'backend', status: 'ready', agentId: developer, priority: 100 },
    { sprintType: 'generic', taskType: 'frontend', status: 'ready', agentId: developer, priority: 100 },
    { sprintType: 'generic', taskType: 'fullstack', status: 'ready', agentId: developer, priority: 100 },
    { sprintType: 'generic', taskType: 'qa', status: 'ready', agentId: review, priority: 100 },
    { sprintType: 'dev', taskType: 'backend', status: 'ready', agentId: developer, priority: 100 },
    { sprintType: 'dev', taskType: 'frontend', status: 'ready', agentId: developer, priority: 100 },
    { sprintType: 'dev', taskType: 'fullstack', status: 'ready', agentId: developer, priority: 100 },
    { sprintType: 'dev', taskType: 'qa', status: 'ready', agentId: review, priority: 100 },
    { sprintType: 'ops', taskType: 'ops', status: 'ready', agentId: ops, priority: 100 },
    { sprintType: 'ops', taskType: 'adhoc', status: 'ready', agentId: pm, priority: 100 },
    { sprintType: 'ops', taskType: 'other', status: 'ready', agentId: pm, priority: 100 },
    { sprintType: 'ops', taskType: 'qa', status: 'ready', agentId: review, priority: 100 },
  ];

  for (const sprintType of STARTER_SPRINT_TYPE_SEEDS.map(seed => seed.key)) {
    for (const taskType of STARTER_SPRINT_TYPE_TASK_TYPE_SEEDS.find(seed => seed.sprintType === sprintType)?.taskTypes ?? []) {
      rules.push({ sprintType, taskType, status: 'review', agentId: review, priority: 100 });
      if (sprintType === 'dev') {
        rules.push({ sprintType, taskType, status: 'qa_pass', agentId: ops, priority: 100 });
        rules.push({ sprintType, taskType, status: 'ready_to_merge', agentId: ops, priority: 100 });
      }
    }
  }

  const hasTenant = tableHasColumn(db, 'sprint_task_routing_rules', 'tenant_id');
  const exists = db.prepare(`
    SELECT id
    FROM sprint_task_routing_rules
    WHERE project_id = ?
      AND sprint_id IS NULL
      AND sprint_type = ?
      AND task_type = ?
      AND status = ?
      AND agent_id = ?
      ${hasTenant ? 'AND tenant_id = ?' : ''}
    LIMIT 1
  `);
  const insert = db.prepare(hasTenant
    ? `
      INSERT OR IGNORE INTO sprint_task_routing_rules (
        tenant_id, sprint_id, project_id, sprint_type, task_type, status, agent_id, priority, is_system, created_at, updated_at
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
    `
    : `
      INSERT OR IGNORE INTO sprint_task_routing_rules (
        sprint_id, project_id, sprint_type, task_type, status, agent_id, priority, is_system, created_at, updated_at
      ) VALUES (NULL, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
    `);
  for (const rule of rules) {
    const existing = exists.get(projectId, rule.sprintType, rule.taskType, rule.status, rule.agentId, ...(hasTenant ? [tenantId] : []));
    if (existing) continue;
    const inserted = insert.run(...(hasTenant ? [tenantId] : []), projectId, rule.sprintType, rule.taskType, rule.status, rule.agentId, rule.priority);
    if (inserted.changes > 0) addCount(result.created, 'routing_rules');
  }
}

function ensureAutomaticTransitions(db: Database.Database, tenantId: number, workflows: Map<StarterSprintTypeKey, number>, result: DefaultInstallPackageResult): void {
  if (!tableExists(db, 'sprint_task_transitions')) return;
  const hasTenant = tableHasColumn(db, 'sprint_task_transitions', 'tenant_id');
  const hasScope = tableHasColumn(db, 'sprint_task_transitions', 'project_id') && tableHasColumn(db, 'sprint_task_transitions', 'sprint_type');
  const sprintRows = db.prepare(`SELECT id, project_id, sprint_type FROM sprints WHERE id = ?`);
  const exists = db.prepare(`
    SELECT id
    FROM sprint_task_transitions
    WHERE sprint_id = ?
      AND task_type IS ?
      AND from_status = ?
      AND outcome = ?
      ${hasTenant ? 'AND tenant_id = ?' : ''}
    LIMIT 1
  `);
  const insert = db.prepare(hasTenant
    ? (hasScope
      ? `INSERT INTO sprint_task_transitions (tenant_id, sprint_id, project_id, sprint_type, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`
      : `INSERT INTO sprint_task_transitions (tenant_id, sprint_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`)
    : (hasScope
      ? `INSERT INTO sprint_task_transitions (sprint_id, project_id, sprint_type, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`
      : `INSERT INTO sprint_task_transitions (sprint_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`));

  for (const [sprintType, sprintId] of workflows.entries()) {
    const sprint = sprintRows.get(sprintId) as { id: number; project_id: number; sprint_type: string } | undefined;
    if (!sprint) continue;
    for (const row of policyTransitionsForSprintType(sprintType)) {
      const existing = exists.get(sprintId, row.task_type ?? null, row.from_status, row.outcome, ...(hasTenant ? [tenantId] : []));
      if (existing) continue;
      const args = hasTenant
        ? (hasScope
          ? [tenantId, sprintId, sprint.project_id, sprint.sprint_type, row.task_type ?? null, row.from_status, row.outcome, row.to_status, row.enabled, row.priority]
          : [tenantId, sprintId, row.task_type ?? null, row.from_status, row.outcome, row.to_status, row.enabled, row.priority])
        : (hasScope
          ? [sprintId, sprint.project_id, sprint.sprint_type, row.task_type ?? null, row.from_status, row.outcome, row.to_status, row.enabled, row.priority]
          : [sprintId, row.task_type ?? null, row.from_status, row.outcome, row.to_status, row.enabled, row.priority]);
      const inserted = insert.run(...args);
      if (inserted.changes > 0) addCount(result.created, 'automatic_transitions');
    }
  }
}

function ensureModelRouting(db: Database.Database, tenantId: number, projectId: number, result: DefaultInstallPackageResult): void {
  if (!tableExists(db, 'story_point_model_routing')) return;
  const hasTenant = tableHasColumn(db, 'story_point_model_routing', 'tenant_id');
  const hasFastMode = tableHasColumn(db, 'story_point_model_routing', 'fast_mode');
  const rows = [
    { maxPoints: 2, model: 'anthropic/claude-haiku-4-5', thinking: 'low', fastMode: 1, label: 'Default small work' },
    { maxPoints: 5, model: 'anthropic/claude-sonnet-4-6', thinking: 'medium', fastMode: 0, label: 'Default medium work' },
    { maxPoints: 13, model: 'anthropic/claude-opus-4-6', thinking: 'high', fastMode: 0, label: 'Default large work' },
  ];
  const exists = db.prepare(`
    SELECT id
    FROM story_point_model_routing
    WHERE project_id = ?
      AND sprint_id IS NULL
      AND sprint_type IS NULL
      AND max_points = ?
      AND provider = 'anthropic'
      ${hasTenant ? 'AND tenant_id = ?' : ''}
    LIMIT 1
  `);
  const columns = [
    ...(hasTenant ? ['tenant_id'] : []),
    'project_id',
    'sprint_id',
    'sprint_type',
    'max_points',
    'provider',
    'model',
    'fallback_model',
    'thinking_level',
    ...(hasFastMode ? ['fast_mode'] : []),
    'label',
    'created_at',
    'updated_at',
  ];
  const insert = db.prepare(`
    INSERT INTO story_point_model_routing (${columns.join(', ')})
    VALUES (${columns.map((column) => column === 'created_at' || column === 'updated_at' ? "datetime('now')" : '?').join(', ')})
  `);
  for (const row of rows) {
    if (exists.get(projectId, row.maxPoints, ...(hasTenant ? [tenantId] : []))) continue;
    const values = [
      ...(hasTenant ? [tenantId] : []),
      projectId,
      null,
      null,
      row.maxPoints,
      'anthropic',
      row.model,
      null,
      row.thinking,
      ...(hasFastMode ? [row.fastMode] : []),
      row.label,
    ];
    const inserted = insert.run(...values);
    if (inserted.changes > 0) addCount(result.created, 'model_routing');
  }
}

function recordLedger(db: Database.Database, result: DefaultInstallPackageResult): void {
  ensurePackageLedger(db);
  db.prepare(`
    INSERT INTO default_package_applications (
      tenant_id, package_key, package_version, mode, created_json, restored_json, updated_json, conflicts_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    result.tenant_id,
    result.package_key,
    result.version,
    result.mode,
    JSON.stringify(result.created),
    JSON.stringify(result.restored),
    JSON.stringify(result.updated),
    JSON.stringify(result.conflicts),
  );
}

export function applyDefaultInstallPackage(
  db: Database.Database,
  tenantId: number,
  options: { mode?: PackageMode } = {},
): DefaultInstallPackageResult {
  const result = createResult(tenantId, options.mode ?? 'install');
  const tenant = db.prepare(`SELECT slug FROM tenants WHERE id = ? LIMIT 1`).get(tenantId) as { slug: string } | undefined;
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);

  const tx = db.transaction(() => {
    ensureWorkflowTypes(db, tenantId, result);
    ensureWorkflowDefinitionRows(db, tenantId, result);
    const projectId = ensureProject(db, tenantId, result);
    const sprintId = ensureBacklog(db, tenantId, projectId, result);
    const workflows = ensureStarterWorkflows(db, tenantId, projectId, result);
    workflows.set('generic', sprintId);
    const agentsByKey = new Map<StarterAgentSeed['key'], number>();
    for (const seed of DEFAULT_INSTALL_AGENT_SEEDS) {
      const agentId = ensureAgent(db, tenantId, tenant.slug, projectId, seed, result);
      agentsByKey.set(seed.key, agentId);
      ensureAgentCapabilities(db, agentId, seed, result);
      ensureAgentHqMcpAssignment(db, tenantId, agentId, result);
    }
    ensureRouting(db, tenantId, projectId, agentsByKey, result);
    ensureAutomaticTransitions(db, tenantId, workflows, result);
    ensureModelRouting(db, tenantId, projectId, result);
    for (const workflowId of workflows.values()) {
      seedSprintTaskPolicy(db, workflowId);
    }
    seedTenantDefaultWorkflowEventMappings(db, tenantId);
    recordLedger(db, result);
  });
  tx();
  return result;
}
