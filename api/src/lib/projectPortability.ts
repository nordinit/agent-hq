import fs from 'fs';
import path from 'path';
import { normalizeRepoConfig } from './repoConfig';
import { writeProjectAudit } from './projectAudit';
import { nowTimestamp } from './timestamps';
import { type Db } from "../db/adapter/types";
import { tableExists as sharedTableExists, columnExists as sharedColumnExists, tableColumns as sharedTableColumns, indexExists as sharedIndexExists } from "../db/introspection";

const REPO_ROOT = path.resolve(__dirname, '../../..');
const UPLOADS_BASE = process.env.AGENT_HQ_PROJECT_UPLOADS_DIR ?? path.join(REPO_ROOT, 'uploads', 'projects');

export const PROJECT_MANIFEST_SCHEMA_VERSION = 'agent_hq.project_manifest.v1';
const TENANT_SCOPED_PROJECT_CONFIG_TABLES = [
  'sprints',
  'agents',
  'routing_config',
  'sprint_task_routing_rules',
  'sprint_task_transitions',
  'sprint_task_transition_requirements',
  'story_point_model_routing',
  'external_event_mappings',
  'recurring_task_series',
] as const;

type Row = Record<string, unknown>;
type WarningSeverity = 'info' | 'warning' | 'error';

export interface ProjectImportWarning {
  code: string;
  message: string;
  severity: WarningSeverity;
  section?: string;
  ref?: string;
}

export interface ProjectImportPreview {
  valid: boolean;
  schema_version: string | null;
  source_project: { id: number | string | null; name: string | null };
  proposed_project_name: string;
  counts: {
    agents: number;
    workflows: number;
    routing_rules: number;
    routing_config: number;
    workflow_transitions: number;
    transition_requirements: number;
    task_routing_rules: number;
    model_routing: number;
    workflow_event_mappings: number;
    recurring_templates: number;
    files: number;
    unresolved_dependencies: number;
  };
  warnings: ProjectImportWarning[];
}

async function tableExists(db: Db, table: string): Promise<boolean> {
    return await sharedTableExists(db, table);
}

async function tableColumns(db: Db, table: string): Promise<Set<string>> {
    return new Set(await sharedTableColumns(db, table));
}

async function tableHasColumns(db: Db, table: string, columns: string[]): Promise<boolean> {
  const existing = await tableColumns(db, table);
  return columns.every((column) => existing.has(column));
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stringifyStable(value: unknown): string {
  return JSON.stringify(sortStable(value));
}

function sortStable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortStable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, inner]) => [key, sortStable(inner)]),
  );
}

async function selectRows(db: Db, table: string, whereSql: string, params: unknown[] = [], orderSql = 'id ASC'): Promise<Row[]> {
  if (!await tableExists(db, table)) return [];
  return await db.all(`SELECT * FROM ${table} ${whereSql} ORDER BY ${orderSql}`, ...params) as Row[];
}

function countSection(manifest: ProjectManifest, key: keyof ProjectManifest): number {
  const value = manifest[key];
  return Array.isArray(value) ? value.length : 0;
}

async function insertDynamic(db: Db, table: string, values: Row): Promise<number> {
  const columns = await tableColumns(db, table);
  const filtered = Object.fromEntries(Object.entries(values).filter(([key]) => columns.has(key) && values[key] !== undefined));
  const keys = Object.keys(filtered);
  if (keys.length === 0) throw new Error(`No insertable columns for ${table}`);
  const placeholders = keys.map(() => '?').join(', ');
  const result = await db.run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`, ...keys.map((key) => filtered[key]));
  return Number(result.lastInsertId);
}

function countRows(manifest: Partial<ProjectManifest> | null, key: keyof ProjectManifest['routing']): number {
  const value = manifest?.routing?.[key];
  return Array.isArray(value) ? value.length : 0;
}

function portableProject(row: Row): ProjectManifest['project'] {
  return {
    source_id: Number(row.id),
    name: String(row.name ?? ''),
    description: String(row.description ?? ''),
    context_md: String(row.context_md ?? ''),
    repo_config: {
      mode: (row.repo_access_mode as 'worktree' | 'clone' | null) ?? null,
      path: (row.repo_path as string | null) ?? null,
      url: (row.repo_url as string | null) ?? null,
    },
  };
}

function portableAgent(row: Row): ProjectManifest['agents'][number] {
  return {
    ref: `agent:${row.id}`,
    name: String(row.name ?? ''),
    role: String(row.role ?? ''),
    job_title: String(row.job_title ?? ''),
    job_instructions: String(row.job_instructions ?? ''),
    system_role: (row.system_role as string | null) ?? null,
    runtime_type: String(row.runtime_type ?? 'openclaw'),
    runtime_config: parseJson(row.runtime_config, {}),
    model: (row.model as string | null) ?? null,
    preferred_provider: (row.preferred_provider as string | null) ?? null,
    skill_names: parseJson(row.skill_names, []),
    dispatch_mode: String(row.dispatch_mode ?? 'agentTurn'),
    schedule: String(row.schedule ?? ''),
    timeout_seconds: Number(row.timeout_seconds ?? 900),
    startup_grace_seconds: row.startup_grace_seconds == null ? null : Number(row.startup_grace_seconds),
    heartbeat_stale_seconds: row.heartbeat_stale_seconds == null ? null : Number(row.heartbeat_stale_seconds),
    stall_threshold_min: Number(row.stall_threshold_min ?? 30),
    max_retries: Number(row.max_retries ?? 3),
    sort_rules: parseJson(row.sort_rules, []),
    enabled: Number(row.enabled ?? 0) === 1,
    tools: [],
    mcp_servers: [],
  };
}

function portableWorkflow(row: Row): ProjectManifest['workflows'][number] {
  return {
    ref: `workflow:${row.id}`,
    name: String(row.name ?? ''),
    goal: String(row.goal ?? ''),
    sprint_type: String(row.sprint_type ?? 'generic'),
    workflow_template_key: (row.workflow_template_key as string | null) ?? null,
    status: String(row.status ?? 'planning'),
    length_kind: String(row.length_kind ?? 'time'),
    length_value: String(row.length_value ?? ''),
    repo_config: {
      mode: (row.repo_access_mode as 'worktree' | 'clone' | null) ?? null,
      path: (row.repo_path as string | null) ?? null,
      url: (row.repo_url as string | null) ?? null,
    },
    field_schemas: [],
  };
}

function replaceRefs(row: Row, sprintIdToRef: Map<number, string>, agentIdToRef: Map<number, string>): Row {
  const next: Row = { ...row };
  delete next.id;
  delete next.created_at;
  delete next.updated_at;
  delete next.project_id;
  if (typeof row.sprint_id === 'number') next.workflow_ref = sprintIdToRef.get(row.sprint_id) ?? null;
  delete next.sprint_id;
  if (typeof row.agent_id === 'number') next.agent_ref = agentIdToRef.get(row.agent_id) ?? null;
  delete next.agent_id;
  return next;
}

export interface ProjectManifest {
  schema_version: typeof PROJECT_MANIFEST_SCHEMA_VERSION;
  project: {
    source_id: number;
    name: string;
    description: string;
    context_md: string;
    repo_config: { mode: 'worktree' | 'clone' | null; path: string | null; url: string | null };
  };
  agents: Array<{
    ref: string;
    name: string;
    role: string;
    job_title: string;
    job_instructions: string;
    system_role: string | null;
    runtime_type: string;
    runtime_config: unknown;
    model: string | null;
    preferred_provider: string | null;
    skill_names: unknown;
    dispatch_mode: string;
    schedule: string;
    timeout_seconds: number;
    startup_grace_seconds: number | null;
    heartbeat_stale_seconds: number | null;
    stall_threshold_min: number;
    max_retries: number;
    sort_rules: unknown;
    enabled: boolean;
    tools: Array<{ slug: string; name: string; enabled: boolean; overrides: unknown }>;
    mcp_servers: Array<{ slug: string; name: string; enabled: boolean; overrides: unknown }>;
  }>;
  workflows: Array<{
    ref: string;
    name: string;
    goal: string;
    sprint_type: string;
    workflow_template_key: string | null;
    status: string;
    length_kind: string;
    length_value: string;
    repo_config?: { mode: 'worktree' | 'clone' | null; path: string | null; url: string | null };
    field_schemas: Array<{ sprint_type_key: string; task_type: string | null; schema: unknown; is_system: boolean }>;
  }>;
  routing: {
    status_routes: Row[];
    transitions: Row[];
    transition_requirements: Row[];
    task_routing_rules: Row[];
    story_point_model_routing: Row[];
    external_event_mappings: Row[];
  };
  recurring_task_templates: Row[];
  files: Array<{
    ref: string;
    filename: string;
    original_name: string;
    mime_type: string;
    size_bytes: number;
    uploaded_by: string;
    payload_base64?: string;
  }>;
}

export async function exportProjectManifest(db: Db, projectId: number, includeFiles: boolean): Promise<{ manifest: ProjectManifest; warnings: ProjectImportWarning[] }> {
  const project = await db.get('SELECT * FROM projects WHERE id = ?', projectId) as Row | undefined;
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const warnings: ProjectImportWarning[] = [];
  const agents = (await selectRows(db, 'agents', 'WHERE project_id = ?', [projectId], 'name ASC, id ASC')).map(portableAgent);
  const workflows = (await selectRows(db, 'sprints', 'WHERE project_id = ?', [projectId], 'name ASC, id ASC')).map(portableWorkflow);
  const agentIdToRef = new Map((await selectRows(db, 'agents', 'WHERE project_id = ?', [projectId])).map((row) => [Number(row.id), `agent:${row.id}`]));
  const sprintIdToRef = new Map((await selectRows(db, 'sprints', 'WHERE project_id = ?', [projectId])).map((row) => [Number(row.id), `workflow:${row.id}`]));
  const agentsByRef = new Map(agents.map((agent) => [agent.ref, agent]));
  const workflowsByType = new Map(workflows.map((workflow) => [workflow.sprint_type, workflow]));

  for (const assignment of await selectRows(db, 'agent_tool_assignments', 'WHERE agent_id IN (SELECT id FROM agents WHERE project_id = ?)', [projectId], 'id ASC')) {
    const tool = await db.get('SELECT slug, name FROM tools WHERE id = ?', assignment.tool_id) as { slug: string; name: string } | undefined;
    const agent = agentsByRef.get(`agent:${assignment.agent_id}`);
    if (tool && agent) {
      agent.tools.push({ slug: tool.slug, name: tool.name, enabled: Number(assignment.enabled ?? 1) === 1, overrides: parseJson(assignment.overrides, {}) });
    }
  }

  for (const assignment of await selectRows(db, 'agent_mcp_assignments', 'WHERE agent_id IN (SELECT id FROM agents WHERE project_id = ?)', [projectId], 'id ASC')) {
    const server = await db.get('SELECT slug, name FROM mcp_servers WHERE id = ?', assignment.mcp_server_id) as { slug: string; name: string } | undefined;
    const agent = agentsByRef.get(`agent:${assignment.agent_id}`);
    if (server && agent) {
      agent.mcp_servers.push({ slug: server.slug, name: server.name, enabled: Number(assignment.enabled ?? 1) === 1, overrides: parseJson(assignment.overrides, {}) });
    }
  }

  if (await tableExists(db, 'task_field_schemas')) {
    for (const schema of await selectRows(db, 'task_field_schemas', 'WHERE sprint_type_key IN (SELECT DISTINCT sprint_type FROM sprints WHERE project_id = ?)', [projectId], 'sprint_type_key ASC, task_type ASC, id ASC')) {
      const workflow = workflowsByType.get(String(schema.sprint_type_key));
      if (workflow) {
        workflow.field_schemas.push({
          sprint_type_key: String(schema.sprint_type_key),
          task_type: (schema.task_type as string | null) ?? null,
          schema: parseJson(schema.schema_json, {}),
          is_system: Number(schema.is_system ?? 0) === 1,
        });
      }
    }
  }

  const files = (await selectRows(db, 'project_files', 'WHERE project_id = ?', [projectId], 'original_name ASC, id ASC')).map((file) => {
    const entry: ProjectManifest['files'][number] = {
      ref: `file:${file.id}`,
      filename: String(file.filename ?? ''),
      original_name: String(file.original_name ?? file.filename ?? ''),
      mime_type: String(file.mime_type ?? 'application/octet-stream'),
      size_bytes: Number(file.size_bytes ?? 0),
      uploaded_by: String(file.uploaded_by ?? 'import'),
    };
    if (includeFiles) {
      const filePath = String(file.file_path ?? '');
      if (filePath && fs.existsSync(filePath)) {
        entry.payload_base64 = fs.readFileSync(filePath).toString('base64');
      } else {
        warnings.push({ code: 'missing_file_payload', severity: 'warning', section: 'files', ref: entry.ref, message: `File payload is missing on disk for ${entry.original_name}.` });
      }
    }
    return entry;
  });

  const routing = {
    status_routes: (await selectRows(db, 'routing_config', 'WHERE project_id = ?', [projectId])).map((row) => replaceRefs(row, sprintIdToRef, agentIdToRef)),
    transitions: (await selectRows(db, 'sprint_task_transitions', 'WHERE project_id = ?', [projectId])).map((row) => replaceRefs(row, sprintIdToRef, agentIdToRef)),
    transition_requirements: (await selectRows(db, 'sprint_task_transition_requirements', 'WHERE project_id = ?', [projectId])).map((row) => replaceRefs(row, sprintIdToRef, agentIdToRef)),
    task_routing_rules: (await selectRows(db, 'sprint_task_routing_rules', 'WHERE project_id = ?', [projectId])).map((row) => replaceRefs(row, sprintIdToRef, agentIdToRef)),
    story_point_model_routing: (await selectRows(db, 'story_point_model_routing', 'WHERE project_id = ?', [projectId])).map((row) => replaceRefs(row, sprintIdToRef, agentIdToRef)),
    external_event_mappings: (await selectRows(db, 'external_event_mappings', 'WHERE project_id = ?', [projectId])).map((row) => replaceRefs(row, sprintIdToRef, agentIdToRef)),
  };

  const recurring_task_templates = (await selectRows(db, 'recurring_task_series', 'WHERE project_id = ?', [projectId])).map((row) => replaceRefs(row, sprintIdToRef, agentIdToRef));
  const manifest = sortStable({
    schema_version: PROJECT_MANIFEST_SCHEMA_VERSION,
    project: portableProject(project),
    agents,
    workflows,
    routing,
    recurring_task_templates,
    files,
  }) as ProjectManifest;

  return { manifest, warnings };
}

export async function validateProjectManifest(db: Db, input: unknown, options: { projectName?: string; importFiles?: boolean } = {}): Promise<ProjectImportPreview> {
  const warnings: ProjectImportWarning[] = [];
  const manifest = input as Partial<ProjectManifest> | null;
  if (!manifest || typeof manifest !== 'object') {
    return {
      valid: false,
      schema_version: null,
      source_project: { id: null, name: null },
      proposed_project_name: options.projectName ?? 'Imported Project',
      counts: {
        agents: 0,
        workflows: 0,
        routing_rules: 0,
        routing_config: 0,
        workflow_transitions: 0,
        transition_requirements: 0,
        task_routing_rules: 0,
        model_routing: 0,
        workflow_event_mappings: 0,
        recurring_templates: 0,
        files: 0,
        unresolved_dependencies: 1,
      },
      warnings: [{ code: 'invalid_manifest', severity: 'error', message: 'Manifest must be a JSON object.' }],
    };
  }

  if (manifest.schema_version !== PROJECT_MANIFEST_SCHEMA_VERSION) {
    warnings.push({ code: 'unsupported_schema_version', severity: 'error', message: `Unsupported schema_version ${String(manifest.schema_version ?? 'missing')}.` });
  }
  if (!manifest.project?.name) {
    warnings.push({ code: 'missing_project', severity: 'error', message: 'Manifest project.name is required.' });
  }
  if (manifest.project?.repo_config?.mode === 'worktree' && manifest.project.repo_config.path) {
    warnings.push({ code: 'deprecated_project_repo_config', severity: 'warning', section: 'project', message: 'Project-level repository configuration is deprecated and will not be imported. Configure repository access on workflows.' });
  }
  for (const workflow of manifest.workflows ?? []) {
    if (workflow.repo_config?.mode === 'worktree' && workflow.repo_config.path) {
      warnings.push({
        code: 'local_workflow_repo_path',
        severity: 'warning',
        section: 'workflows',
        ref: workflow.ref,
        message: `Workflow ${workflow.name || workflow.ref} uses local worktree path ${workflow.repo_config.path}; confirm this exists on the target host.`,
      });
    }
  }

  const toolSlugs = new Set(await tableExists(db, 'tools') ? (await db.all('SELECT slug FROM tools') as Array<{ slug: string }>).map((row) => row.slug) : []);
  const mcpSlugs = new Set(await tableExists(db, 'mcp_servers') ? (await db.all('SELECT slug FROM mcp_servers') as Array<{ slug: string }>).map((row) => row.slug) : []);

  for (const agent of manifest.agents ?? []) {
    for (const tool of agent.tools ?? []) {
      if (!toolSlugs.has(tool.slug)) warnings.push({ code: 'missing_tool', severity: 'warning', section: 'agents', ref: agent.ref, message: `Tool ${tool.slug} is not available; assignment will be unresolved.` });
    }
    for (const server of agent.mcp_servers ?? []) {
      if (!mcpSlugs.has(server.slug)) warnings.push({ code: 'missing_mcp_server', severity: 'warning', section: 'agents', ref: agent.ref, message: `MCP server ${server.slug} is not available; assignment will be unresolved.` });
    }
  }

  for (const file of manifest.files ?? []) {
    if (options.importFiles && !file.payload_base64) {
      warnings.push({ code: 'missing_file_payload', severity: 'warning', section: 'files', ref: file.ref, message: `File ${file.original_name} has no payload and will not be imported.` });
    }
  }

  const routingConfig = countRows(manifest, 'status_routes');
  const workflowTransitions = countRows(manifest, 'transitions');
  const transitionRequirements = countRows(manifest, 'transition_requirements');
  const taskRoutingRules = countRows(manifest, 'task_routing_rules');
  const modelRouting = countRows(manifest, 'story_point_model_routing');
  const workflowEventMappings = countRows(manifest, 'external_event_mappings');
  const routingCount = routingConfig + workflowTransitions + transitionRequirements + taskRoutingRules + modelRouting + workflowEventMappings;
  const unresolved = warnings.filter((warning) => warning.code.startsWith('missing_') || warning.severity === 'error').length;
  return {
    valid: !warnings.some((warning) => warning.severity === 'error'),
    schema_version: typeof manifest.schema_version === 'string' ? manifest.schema_version : null,
    source_project: { id: manifest.project?.source_id ?? null, name: manifest.project?.name ?? null },
    proposed_project_name: options.projectName?.trim() || (manifest.project?.name ? `${manifest.project.name} Import` : 'Imported Project'),
    counts: {
      agents: countSection(manifest as ProjectManifest, 'agents'),
      workflows: countSection(manifest as ProjectManifest, 'workflows'),
      routing_rules: routingCount,
      routing_config: routingConfig,
      workflow_transitions: workflowTransitions,
      transition_requirements: transitionRequirements,
      task_routing_rules: taskRoutingRules,
      model_routing: modelRouting,
      workflow_event_mappings: workflowEventMappings,
      recurring_templates: countSection(manifest as ProjectManifest, 'recurring_task_templates'),
      files: countSection(manifest as ProjectManifest, 'files'),
      unresolved_dependencies: unresolved,
    },
    warnings,
  };
}

export async function importProjectManifest(
  db: Db,
  input: unknown,
  options: { projectName?: string; enableAgents?: boolean; activateWorkflows?: boolean; importFiles?: boolean; tenantId?: number; actor?: string } = {},
): Promise<{ project_id: number; preview: ProjectImportPreview; id_map: { agents: Record<string, number>; workflows: Record<string, number> } }> {
  const preview = await validateProjectManifest(db, input, { projectName: options.projectName, importFiles: options.importFiles });
  if (!preview.valid) throw Object.assign(new Error('Manifest validation failed'), { status: 400, preview });
  const manifest = input as ProjectManifest;
  const agentIdMap: Record<string, number> = {};
  const workflowIdMap: Record<string, number> = {};
  const projectName = preview.proposed_project_name;

  const project_id = await db.withTransaction(async (db) => {
    const projectId = await insertDynamic(db, 'projects', {
          tenant_id: options.tenantId ?? null,
          name: projectName,
          description: manifest.project.description ?? '',
          context_md: manifest.project.context_md ?? '',
        });

    for (const workflow of manifest.workflows ?? []) {
      const workflowRepoConfig = normalizeRepoConfig({
        repo_access_mode: workflow.repo_config?.mode,
        repo_path: workflow.repo_config?.mode === 'worktree' ? workflow.repo_config.path : null,
        repo_url: workflow.repo_config?.mode === 'clone' ? workflow.repo_config.url : null,
      });
      const workflowId = await insertDynamic(db, 'sprints', {
              tenant_id: options.tenantId ?? null,
              project_id: projectId,
              name: workflow.name,
              goal: workflow.goal ?? '',
              sprint_type: workflow.sprint_type ?? 'generic',
              workflow_template_key: workflow.workflow_template_key ?? null,
              status: options.activateWorkflows ? (workflow.status || 'planning') : 'planning',
              length_kind: workflow.length_kind ?? 'time',
              length_value: workflow.length_value ?? '',
              repo_path: workflowRepoConfig.repo_path,
              repo_url: workflowRepoConfig.repo_url,
              repo_access_mode: workflowRepoConfig.repo_access_mode,
            });
      workflowIdMap[workflow.ref] = workflowId;
      if (await tableExists(db, 'task_field_schemas')) {
        for (const schema of workflow.field_schemas ?? []) {
          const existing = await db.get(`
            SELECT id FROM task_field_schemas
            WHERE sprint_type_key = ?
              AND (task_type = ? OR (task_type IS NULL AND ? IS NULL))
            LIMIT 1
          `, schema.sprint_type_key, schema.task_type ?? null, schema.task_type ?? null);
          if (!existing) {
            await insertDynamic(db, 'task_field_schemas', {
                            sprint_type_key: schema.sprint_type_key,
                            task_type: schema.task_type ?? null,
                            schema_json: stringifyStable(schema.schema ?? {}),
                            is_system: schema.is_system ? 1 : 0,
                            updated_at: nowTimestamp(),
                          });
          }
        }
      }
    }

    for (const agent of manifest.agents ?? []) {
      const sessionKey = `imported:${projectId}:${agent.ref.replace(/[^a-zA-Z0-9_.:-]/g, '_')}`;
      const agentId = await insertDynamic(db, 'agents', {
              tenant_id: options.tenantId ?? null,
              name: agent.name,
              role: agent.role ?? '',
              session_key: sessionKey,
              workspace_path: '',
              status: 'idle',
              runtime_type: agent.runtime_type ?? 'openclaw',
              runtime_config: stringifyStable(agent.runtime_config ?? {}),
              model: agent.model ?? null,
              preferred_provider: agent.preferred_provider ?? null,
              job_title: agent.job_title ?? '',
              job_instructions: agent.job_instructions ?? '',
              system_role: agent.system_role ?? null,
              skill_names: stringifyStable(agent.skill_names ?? []),
              dispatch_mode: agent.dispatch_mode ?? 'agentTurn',
              schedule: agent.schedule ?? '',
              timeout_seconds: agent.timeout_seconds ?? 900,
              startup_grace_seconds: agent.startup_grace_seconds ?? null,
              heartbeat_stale_seconds: agent.heartbeat_stale_seconds ?? null,
              stall_threshold_min: agent.stall_threshold_min ?? 30,
              max_retries: agent.max_retries ?? 3,
              sort_rules: stringifyStable(agent.sort_rules ?? []),
              enabled: options.enableAgents ? 1 : 0,
              project_id: projectId,
            });
      agentIdMap[agent.ref] = agentId;

      for (const tool of agent.tools ?? []) {
        const resolved = await tableExists(db, 'tools') ? await db.get('SELECT id FROM tools WHERE slug = ?', tool.slug) as { id: number } | undefined : undefined;
        if (resolved) await insertDynamic(db, 'agent_tool_assignments', { agent_id: agentId, tool_id: resolved.id, overrides: stringifyStable(tool.overrides ?? {}), enabled: 0 });
      }
      for (const server of agent.mcp_servers ?? []) {
        const resolved = await tableExists(db, 'mcp_servers') ? await db.get('SELECT id FROM mcp_servers WHERE slug = ?', server.slug) as { id: number } | undefined : undefined;
        if (resolved) await insertDynamic(db, 'agent_mcp_assignments', { agent_id: agentId, mcp_server_id: resolved.id, overrides: stringifyStable(server.overrides ?? {}), enabled: 0 });
      }
    }

    const scopedRow = async (table: string, row: Row): Promise<Row> => {
      const next: Row = { ...row, project_id: projectId };
      if ((await tableColumns(db, table)).has('tenant_id')) {
        next.tenant_id = options.tenantId ?? null;
      }
      if ('workflow_ref' in next) {
        next.sprint_id = typeof next.workflow_ref === 'string' ? workflowIdMap[next.workflow_ref] ?? null : null;
        delete next.workflow_ref;
      }
      if ('agent_ref' in next) {
        next.agent_id = typeof next.agent_ref === 'string' ? agentIdMap[next.agent_ref] ?? null : null;
        delete next.agent_ref;
      }
      return next;
    };

    for (const row of manifest.routing?.status_routes ?? []) await insertDynamic(db, 'routing_config', await scopedRow('routing_config', row));
    for (const row of manifest.routing?.transitions ?? []) await insertDynamic(db, 'sprint_task_transitions', await scopedRow('sprint_task_transitions', row));
    for (const row of manifest.routing?.transition_requirements ?? []) await insertDynamic(db, 'sprint_task_transition_requirements', await scopedRow('sprint_task_transition_requirements', row));
    for (const row of manifest.routing?.task_routing_rules ?? []) await insertDynamic(db, 'sprint_task_routing_rules', await scopedRow('sprint_task_routing_rules', row));
    for (const row of manifest.routing?.story_point_model_routing ?? []) await insertDynamic(db, 'story_point_model_routing', await scopedRow('story_point_model_routing', row));
    for (const row of manifest.routing?.external_event_mappings ?? []) await insertDynamic(db, 'external_event_mappings', await scopedRow('external_event_mappings', row));
    for (const row of manifest.recurring_task_templates ?? []) await insertDynamic(db, 'recurring_task_series', { ...(await scopedRow('recurring_task_series', row)), enabled: 0, next_run_at: null, last_run_at: null });

    if (options.importFiles) {
      const dir = path.join(UPLOADS_BASE, String(projectId));
      fs.mkdirSync(dir, { recursive: true });
      for (const file of manifest.files ?? []) {
        if (!file.payload_base64) continue;
        const safeBase = path.basename(file.original_name || file.filename).replace(/[^a-zA-Z0-9_.-]/g, '_');
        const filename = `import-${projectId}-${safeBase}`;
        const filePath = path.join(dir, filename);
        fs.writeFileSync(filePath, Buffer.from(file.payload_base64, 'base64'));
        await insertDynamic(db, 'project_files', {
                    project_id: projectId,
                    filename,
                    original_name: file.original_name || filename,
                    mime_type: file.mime_type || 'application/octet-stream',
                    size_bytes: fs.statSync(filePath).size,
                    file_path: filePath,
                    uploaded_by: options.actor ?? 'import',
                  });
      }
    }

    await writeProjectAudit(db, projectId, 'project', projectId, 'created', options.actor ?? 'api', {
            import: true,
            source_project_id: manifest.project.source_id,
            source_project_name: manifest.project.name,
            schema_version: manifest.schema_version,
            agents_enabled: Boolean(options.enableAgents),
            workflows_activated: Boolean(options.activateWorkflows),
          });
    return projectId;
  });

  return { project_id, preview, id_map: { agents: agentIdMap, workflows: workflowIdMap } };
}

export async function repairImportedProjectTenantScope(
  db: Db,
  input: { projectId: number; tenantId?: number | null },
): Promise<{ project_id: number; tenant_id: number | null; updated: Record<string, number> }> {
  const project = await db.get('SELECT id, tenant_id FROM projects WHERE id = ?', input.projectId) as { id: number; tenant_id: number | null } | undefined;
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
  const tenantId = input.tenantId !== undefined ? input.tenantId : project.tenant_id ?? null;
  const updated: Record<string, number> = {};

  await db.withTransaction(async (db) => {
    for (const table of TENANT_SCOPED_PROJECT_CONFIG_TABLES) {
      if (!await tableHasColumns(db, table, ['project_id', 'tenant_id'])) continue;
      const result = await db.run(`
        UPDATE ${table}
        SET tenant_id = ?
        WHERE project_id = ?
          AND (tenant_id IS NOT ?)
      `, tenantId, project.id, tenantId);
      updated[table] = result.changes;
    }
  });

  return { project_id: project.id, tenant_id: tenantId, updated };
}

export function manifestJson(manifest: ProjectManifest): string {
  return `${JSON.stringify(sortStable(manifest), null, 2)}\n`;
}
