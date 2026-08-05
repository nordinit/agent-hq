import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import {
  exportProjectManifest,
  importProjectManifest,
  manifestJson,
  repairImportedProjectTenantScope,
  validateProjectManifest,
} from './projectPortability';

let tempDir: string;

beforeEach(async () => {
  // tempDir isolates uploaded files; setupTestDb() owns the PostgreSQL fixture state.
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-portability-'));
  process.env.AGENT_HQ_PROJECT_UPLOADS_DIR = path.join(tempDir, 'uploads');
  await setupTestDb();
});

afterEach(async () => {
  await teardownTestDb();
  delete process.env.AGENT_HQ_PROJECT_UPLOADS_DIR;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function seedPortableProject(): Promise<number> {
  const db = getDb();
  // Every fixture row below is scoped to tenant 1, so create that foreign-key parent explicitly.
  await db.run(`
    INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default', 'default', 1)
    ON CONFLICT DO NOTHING
  `);

  const projectId = Number((await db.run(`
    INSERT INTO projects (tenant_id, name, description, context_md, repo_path, repo_access_mode)
    VALUES (1, 'Portable Source', 'Source description', '# Context', '/tmp/source-worktree', 'worktree')
  `)).lastInsertId);

  const sprintId = Number((await db.run(`
    INSERT INTO sprints (tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value)
    VALUES (1, ?, 'Enhancements', 'Ship portability', 'dev', 'active', 'runs', '5')
  `, projectId)).lastInsertId);

  const agentId = Number((await db.run(`
    INSERT INTO agents (
      tenant_id, name, role, session_key, workspace_path, runtime_type, runtime_config,
      model, preferred_provider, job_title, job_instructions, skill_names, enabled,
      timeout_seconds, stall_threshold_min, max_retries, sort_rules, project_id
    )
    VALUES (
      1, 'Cinder', 'Backend Engineer', 'agent:cinder:test', '', 'claude-code', '{"reasoning":"high"}',
      'claude-sonnet-4-5', 'anthropic', 'Backend Engineer', 'Build APIs', '["github"]', 1,
      1200, 45, 2, '["priority"]', ?
    )
  `, projectId)).lastInsertId);

  const toolId = Number((await db.run(`
    INSERT INTO tools (tenant_id, name, slug, implementation_type, implementation_body, enabled)
    VALUES (1, 'Repo Search', 'repo_search', 'bash', 'rg "$QUERY"', 1)
  `)).lastInsertId);
  const mcpId = Number((await db.run(`
    INSERT INTO mcp_servers (tenant_id, name, slug, command, args, env, enabled)
    VALUES (1, 'Agent HQ', 'agent_hq', 'node', '[]', '{}', 1)
  `)).lastInsertId);
  await db.run(`INSERT INTO agent_tool_assignments (agent_id, tool_id, overrides, enabled) VALUES (?, ?, '{"limit":10}', 1)`, agentId, toolId);
  await db.run(`INSERT INTO agent_mcp_assignments (agent_id, mcp_server_id, overrides, enabled) VALUES (?, ?, '{}', 1)`, agentId, mcpId);

  await db.run(`
    INSERT INTO routing_config (tenant_id, project_id, from_status, outcome, to_status, enabled)
    VALUES (1, ?, 'in_progress', 'completed_for_review', 'review', 1)
  `, projectId);
  await db.run(`
    INSERT INTO sprint_task_transitions (tenant_id, project_id, sprint_id, sprint_type, task_type, from_status, outcome, to_status, priority)
    VALUES (1, ?, ?, 'dev', 'enhancement', 'ready', 'completed_for_review', 'review', 20)
  `, projectId, sprintId);
  await db.run(`
    INSERT INTO sprint_task_transition_requirements (tenant_id, project_id, sprint_id, sprint_type, task_type, outcome, field_name, requirement_type, severity, message, priority)
    VALUES (1, ?, ?, 'dev', 'enhancement', 'completed_for_review', 'review_commit', 'required', 'block', 'Commit is required', 30)
  `, projectId, sprintId);
  await db.run(`
    INSERT INTO sprint_task_routing_rules (tenant_id, project_id, sprint_id, sprint_type, task_type, status, agent_id, priority)
    VALUES (1, ?, ?, 'dev', 'enhancement', 'ready', ?, 10)
  `, projectId, sprintId, agentId);
  await db.run(`
    INSERT INTO story_point_model_routing (tenant_id, project_id, sprint_id, sprint_type, max_points, provider, model, label)
    VALUES (1, ?, ?, 'dev', 5, 'anthropic', 'claude-sonnet-4-5', 'Default')
  `, projectId, sprintId);
  await db.run(`
    INSERT INTO external_event_mappings (
      tenant_id, project_id, source, event_name, task_type, status_includes_json, status_excludes_json,
      action_kind, action_target, apply_review_evidence, apply_failure_detail, enabled, priority
    )
    VALUES (1, ?, 'dev_environment_lease_manager', 'deployed_for_qa', 'enhancement', '[]', '["done"]', 'outcome', 'completed_for_review', 1, 0, 1, 40)
  `, projectId);
  await db.run(`
    INSERT INTO recurring_task_series (
      tenant_id, project_id, sprint_id, title_template, description_template, task_type, priority,
      story_points, status_on_create, schedule_expression, timezone, enabled, agent_id
    )
    VALUES (1, ?, ?, 'Weekly cleanup', 'Clean up docs', 'dev', 'medium', 2, 'ready', '0 9 * * 1', 'America/New_York', 1, ?)
  `, projectId, sprintId, agentId);

  await db.run(`
    INSERT INTO tasks (project_id, sprint_id, title, description, status, priority, task_type, story_points)
    VALUES (?, ?, 'Live task must not export', 'Runtime state', 'in_progress', 'high', 'dev', 3)
  `, projectId, sprintId);
  await db.run(`
    INSERT INTO job_instances (agent_id, status, session_key, payload_sent, response)
    VALUES (?, 'running', 'run:live', '{"secret":"runtime"}', 'still running')
  `, agentId);

  return projectId;
}

it('exports a deterministic v1 manifest without live execution state', async () => {
  const projectId = await seedPortableProject();
  const first = (await exportProjectManifest(getDb(), projectId, false)).manifest;
  const second = (await exportProjectManifest(getDb(), projectId, false)).manifest;

  expect(manifestJson(first)).toBe(manifestJson(second));
  expect(first.schema_version).toBe('agent_hq.project_manifest.v1');
  expect(first.project).toMatchObject({ name: 'Portable Source', context_md: '# Context' });
  expect(first.agents).toHaveLength(1);
  expect(first.workflows).toHaveLength(1);
  expect(first.routing.task_routing_rules).toHaveLength(1);
  expect(first.routing.transitions).toHaveLength(1);
  expect(first.routing.transition_requirements).toHaveLength(1);
  expect(first.routing.story_point_model_routing).toHaveLength(1);
  expect(first.routing.external_event_mappings).toHaveLength(1);
  expect(first.recurring_task_templates).toHaveLength(1);

  const serialized = manifestJson(first);
  expect(serialized).not.toContain('Live task must not export');
  expect(serialized).not.toContain('run:live');
  expect(serialized).not.toContain('payload_sent');
  expect(serialized).not.toContain('job_instances');
});

it('previews missing dependencies and imports equivalent portable config with remapped ids disabled by default', async () => {
  const db = getDb();
  const projectId = await seedPortableProject();
  const manifest = (await exportProjectManifest(db, projectId, false)).manifest;
  const missingDependencyManifest = {
    ...manifest,
    agents: manifest.agents.map((agent) => ({
      ...agent,
      tools: [{ ...agent.tools[0], slug: 'missing_tool' }],
    })),
  };

  const warningPreview = await validateProjectManifest(db, missingDependencyManifest);
  expect(warningPreview.valid).toBe(true);
  expect(warningPreview.counts).toMatchObject({
    routing_rules: 6,
    routing_config: 1,
    task_routing_rules: 1,
    workflow_transitions: 1,
    transition_requirements: 1,
    model_routing: 1,
    workflow_event_mappings: 1,
  });
  expect(warningPreview.warnings).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'missing_tool' }),
    expect.objectContaining({ code: 'deprecated_project_repo_config' }),
  ]));

  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (2, 'EcoPool', 'ecopool', 0)`);

  const result = await importProjectManifest(db, manifest, { projectName: 'Portable Copy', tenantId: 2, actor: 'test' });
  expect(result.project_id).not.toBe(projectId);
  expect(Object.values(result.id_map.agents)[0]).not.toBe(Number(manifest.agents[0].ref.replace('agent:', '')));
  expect(Object.values(result.id_map.workflows)[0]).not.toBe(Number(manifest.workflows[0].ref.replace('workflow:', '')));

  const importedProject = await db.get(`SELECT name, context_md, repo_access_mode, repo_path, tenant_id FROM projects WHERE id = ?`, result.project_id);
  expect(importedProject).toMatchObject({
    name: 'Portable Copy',
    context_md: '# Context',
    repo_access_mode: null,
    repo_path: null,
    tenant_id: 2,
  });

  const importedAgent = await db.get(`SELECT id, tenant_id, enabled, runtime_type, model, project_id FROM agents WHERE project_id = ?`, result.project_id) as {
    id: number;
    tenant_id: number;
    enabled: number;
    runtime_type: string;
    model: string;
    project_id: number;
  };
  expect(importedAgent).toMatchObject({ tenant_id: 2, enabled: 0, runtime_type: 'claude-code', model: 'claude-sonnet-4-5', project_id: result.project_id });

  const importedSprint = await db.get(`SELECT id, tenant_id, status, sprint_type FROM sprints WHERE project_id = ?`, result.project_id) as { id: number; tenant_id: number; status: string; sprint_type: string };
  expect(importedSprint).toMatchObject({ tenant_id: 2, status: 'planning', sprint_type: 'dev' });

  const assignment = await db.get(`SELECT enabled FROM agent_tool_assignments WHERE agent_id = ?`, importedAgent.id) as { enabled: number };
  expect(assignment.enabled).toBe(0);
  const recurring = await db.get(`SELECT tenant_id, enabled, next_run_at FROM recurring_task_series WHERE project_id = ?`, result.project_id) as { tenant_id: number; enabled: number; next_run_at: string | null };
  expect(recurring).toMatchObject({ tenant_id: 2, enabled: 0, next_run_at: null });
  const routing = await db.get(`SELECT agent_id, sprint_id FROM sprint_task_routing_rules WHERE project_id = ?`, result.project_id);
  expect(routing).toMatchObject({ agent_id: importedAgent.id, sprint_id: importedSprint.id });
  for (const table of [
    'routing_config',
    'sprint_task_routing_rules',
    'sprint_task_transitions',
    'sprint_task_transition_requirements',
    'story_point_model_routing',
    'external_event_mappings',
    'recurring_task_series',
  ]) {
    const tenantCounts = await db.all(`SELECT tenant_id, COUNT(*) AS count FROM ${table} WHERE project_id = ? GROUP BY tenant_id ORDER BY tenant_id`, result.project_id) as Array<{ tenant_id: number; count: number }>;
    expect(tenantCounts).toEqual([{ tenant_id: 2, count: 1 }]);
  }
  await db.run(`UPDATE routing_config SET tenant_id = 1 WHERE project_id = ?`, result.project_id);
  await db.run(`UPDATE sprint_task_routing_rules SET tenant_id = 1 WHERE project_id = ?`, result.project_id);
  await db.run(`UPDATE sprint_task_transitions SET tenant_id = 1 WHERE project_id = ?`, result.project_id);
  await db.run(`UPDATE sprint_task_transition_requirements SET tenant_id = 1 WHERE project_id = ?`, result.project_id);
  await db.run(`UPDATE story_point_model_routing SET tenant_id = 1 WHERE project_id = ?`, result.project_id);
  await db.run(`UPDATE external_event_mappings SET tenant_id = 1 WHERE project_id = ?`, result.project_id);
  await db.run(`UPDATE recurring_task_series SET tenant_id = 1 WHERE project_id = ?`, result.project_id);
  const repair = await repairImportedProjectTenantScope(db, { projectId: result.project_id });
  expect(repair).toMatchObject({
    project_id: result.project_id,
    tenant_id: 2,
    updated: {
      routing_config: 1,
      sprint_task_routing_rules: 1,
      sprint_task_transitions: 1,
      sprint_task_transition_requirements: 1,
      story_point_model_routing: 1,
      external_event_mappings: 1,
      recurring_task_series: 1,
    },
  });
  for (const table of [
    'routing_config',
    'sprint_task_routing_rules',
    'sprint_task_transitions',
    'sprint_task_transition_requirements',
    'story_point_model_routing',
    'external_event_mappings',
    'recurring_task_series',
  ]) {
    const badRows = await db.get(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ? AND tenant_id != 2`, result.project_id) as { count: number };
    expect(badRows.count).toBe(0);
  }

  const importedLiveTasks = await db.get(`SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?`, result.project_id) as { count: number };
  expect(importedLiveTasks.count).toBe(0);
  const audit = await db.get(`SELECT changes FROM project_audit_log WHERE project_id = ? ORDER BY id DESC LIMIT 1`, result.project_id) as { changes: string };
  expect(JSON.parse(audit.changes)).toMatchObject({ import: true, schema_version: 'agent_hq.project_manifest.v1' });
});
