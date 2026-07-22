import { getMcpCatalog } from './catalog';
import { registerAgentHqMcpCatalog } from './registerCatalog';
import { registerTasksTools } from './domains/tasks';
import { toJSONSchema, type ZodTypeAny } from 'zod';

describe('Agent HQ MCP admin-page catalog coverage', () => {
  beforeAll(() => {
    registerAgentHqMcpCatalog();
  });

  it('advertises typed CRUD/read helpers for task routing, workflow mappings, contracts, and sprint definitions', () => {
    const catalog = getMcpCatalog();
    const byName = new Map(catalog.tools.map(tool => [tool.canonical_name, tool]));
    const expectedTools = [
      'agent_hq_list_routing_rules',
      'agent_hq_get_routing_rule',
      'agent_hq_create_routing_rule',
      'agent_hq_update_routing_rule',
      'agent_hq_delete_routing_rule',
      'agent_hq_list_model_routing_rules',
      'agent_hq_get_model_routing_rule',
      'agent_hq_create_model_routing_rule',
      'agent_hq_update_model_routing_rule',
      'agent_hq_delete_model_routing_rule',
      'agent_hq_list_workflows',
      'agent_hq_get_workflow',
      'agent_hq_create_workflow',
      'agent_hq_update_workflow',
      'agent_hq_delete_workflow',
      'agent_hq_list_project_files',
      'agent_hq_get_project_file',
      'agent_hq_download_project_file',
      'agent_hq_upload_project_file',
      'agent_hq_delete_project_file',
      'agent_hq_replace_project_file',
      'agent_hq_list_workflow_files',
      'agent_hq_get_workflow_file',
      'agent_hq_list_workflow_file_versions',
      'agent_hq_download_workflow_file',
      'agent_hq_upload_workflow_file',
      'agent_hq_delete_workflow_file',
      'agent_hq_replace_workflow_file',
      'agent_hq_list_workflow_event_mappings',
      'agent_hq_get_workflow_event_mapping',
      'agent_hq_create_workflow_event_mapping',
      'agent_hq_update_workflow_event_mapping',
      'agent_hq_delete_workflow_event_mapping',
      'agent_hq_get_agent_dispatch_contract',
      'agent_hq_update_agent_dispatch_contract',
      'agent_hq_get_workflow_config',
      'agent_hq_get_workflow_metadata',
      'agent_hq_get_task_instances',
      'agent_hq_get_task_active_owner',
      'agent_hq_list_transition_requirement_fields',
      'agent_hq_get_transition_requirements',
      'agent_hq_create_transition_requirement',
      'agent_hq_update_transition_requirement',
      'agent_hq_delete_transition_requirement',
      'agent_hq_list_sprint_type_statuses',
      'agent_hq_get_resolved_sprint_type_statuses',
      'agent_hq_get_sprint_type_status',
      'agent_hq_create_sprint_type_status',
      'agent_hq_update_sprint_type_status',
      'agent_hq_delete_sprint_type_status',
      'agent_hq_list_sprint_type_outcomes',
      'agent_hq_get_resolved_sprint_type_outcomes',
      'agent_hq_get_sprint_type_outcome',
      'agent_hq_create_sprint_type_outcome',
      'agent_hq_update_sprint_type_outcome',
      'agent_hq_delete_sprint_type_outcome',
      'agent_hq_list_sprint_type_relationship_types',
      'agent_hq_get_sprint_type_relationship_type',
      'agent_hq_create_sprint_type_relationship_type',
      'agent_hq_update_sprint_type_relationship_type',
      'agent_hq_delete_sprint_type_relationship_type',
      'agent_hq_get_agent_mcp_capability_policy',
      'agent_hq_create_agent_mcp_capability_policy',
      'agent_hq_update_agent_mcp_capability_policy',
      'agent_hq_delete_agent_mcp_capability_policy',
    ];

    for (const toolName of expectedTools) {
      expect(byName.get(toolName)).toBeTruthy();
      expect(byName.get(toolName)?.aliases.some(alias => alias.startsWith('atlas_'))).toBe(true);
      expect(byName.get(toolName)?.domain).not.toBe('advanced');
    }

    const advancedOnlyPaths = new Set(byName.get('agent_hq_api_request')?.rest_paths ?? []);
    expect(advancedOnlyPaths).toEqual(new Set(['/api/v1/*']));

    expect(byName.get('agent_hq_list_workflows')?.domain).toBe('workflows');
    expect(byName.get('agent_hq_upload_project_file')?.domain).toBe('project_files');
    expect(byName.get('agent_hq_upload_workflow_file')?.domain).toBe('workflow_files');
    expect(byName.get('agent_hq_replace_project_file')?.description).toContain('version-history');
    expect(byName.get('agent_hq_replace_workflow_file')?.description).toContain('version-history');
    expect(byName.get('agent_hq_get_sprints')?.description).toContain('Legacy alias');
    expect(byName.get('agent_hq_get_task_instances')?.rest_paths).toEqual(['/api/v1/tasks/:id/instances']);
    expect(byName.get('agent_hq_get_task_instances')?.description).toContain('Read project task context');
    expect(byName.get('agent_hq_get_task_active_owner')?.rest_paths).toEqual(['/api/v1/tasks/:id/active-owner']);
    expect(byName.get('agent_hq_get_task_active_owner')?.description).toContain('Read project task context');
    expect(byName.get('agent_hq_get_agent_mcp_capability_policy')?.description).toContain('MCP capability policy read access');
    expect(byName.get('agent_hq_create_agent_mcp_capability_policy')?.description).toContain('safe non-admin capability keys');
    expect(byName.get('agent_hq_update_agent_mcp_capability_policy')?.args.map(arg => arg.name).sort()).toEqual(['agent_id', 'enabled_capabilities']);
    expect(byName.get('agent_hq_delete_agent_mcp_capability_policy')?.rest_paths).toEqual(['/api/v1/agents/:id/mcp-permissions']);

    const assignmentRules = byName.get('agent_hq_list_routing_rules');
    expect(assignmentRules?.domain).toBe('assignment_rules');
    expect(assignmentRules?.description).toContain('assignment rules');
    expect(assignmentRules?.description).toContain('routing_rules.manage_project_scope');
    expect(assignmentRules?.aliases).toEqual(expect.arrayContaining([
      'agent_hq_list_assignment_rules',
      'atlas_list_assignment_rules',
      'atlas_list_routing_rules',
    ]));
    expect(assignmentRules?.rest_paths).toEqual(expect.arrayContaining([
      '/api/v1/routing/assignment-rules',
      '/api/v1/assignment-rules',
      '/api/v1/routing/rules',
    ]));

    const gateRequirements = byName.get('agent_hq_get_transition_requirements');
    expect(gateRequirements?.description).toContain('transition_requirements.manage_project_scope');
    expect(gateRequirements?.description).toContain('explicit project_id and sprint_type scope');
    expect(gateRequirements?.rest_paths).toEqual(['/api/v1/routing/transition-requirements']);
    expect(gateRequirements?.args.find(arg => arg.name === 'project_id')?.required).toBe(true);
    expect(gateRequirements?.args.find(arg => arg.name === 'sprint_type')?.required).toBe(true);
    expect(byName.get('agent_hq_update_transition_requirement')?.args.find(arg => arg.name === 'project_id')?.required).toBe(true);
    expect(byName.get('agent_hq_update_transition_requirement')?.args.find(arg => arg.name === 'sprint_type')?.required).toBe(true);
  });

  it('keeps scoped routing-rule schemas aligned with the current routing API', () => {
    const catalog = getMcpCatalog();
    const requiredScopeArgs = ['tenant_id', 'project_id', 'sprint_type', 'sprint_id', 'scope', 'status', 'task_type'];

    for (const toolName of ['agent_hq_list_routing_rules', 'agent_hq_get_routing_rule', 'agent_hq_delete_routing_rule']) {
      const argNames = new Set(catalog.tools.find(tool => tool.canonical_name === toolName)?.args.map(arg => arg.name) ?? []);
      for (const argName of requiredScopeArgs) {
        expect(argNames.has(argName)).toBe(true);
      }
    }
  });

  it('advertises super-admin tenant selectors on routing admin config tools', () => {
    const catalog = getMcpCatalog();
    const tenantSelectableTools = [
      'agent_hq_list_routing_rules',
      'agent_hq_create_routing_rule',
      'agent_hq_list_routing_transitions',
      'agent_hq_create_routing_transition',
      'agent_hq_get_transition_requirements',
      'agent_hq_create_transition_requirement',
      'agent_hq_update_transition_requirement',
      'agent_hq_delete_transition_requirement',
      'agent_hq_list_workflow_event_mappings',
      'agent_hq_create_workflow_event_mapping',
      'agent_hq_get_workflow_metadata',
      'agent_hq_list_transition_requirement_fields',
      'agent_hq_list_sprint_types',
      'agent_hq_list_sprint_type_task_types',
      'agent_hq_list_sprint_type_statuses',
      'agent_hq_get_sprint_type_status',
      'agent_hq_list_sprint_type_outcomes',
      'agent_hq_get_sprint_type_outcome',
      'agent_hq_list_sprint_type_relationship_types',
      'agent_hq_get_sprint_type_relationship_type',
      'agent_hq_list_task_field_schemas',
      'agent_hq_get_task_field_schema',
    ];

    for (const toolName of tenantSelectableTools) {
      const tool = catalog.tools.find(item => item.canonical_name === toolName);
      expect(tool?.args.map(arg => arg.name)).toContain('tenant_id');
      expect(tool?.description).toContain('super-admin MCP only');
    }
  });

  it('keeps workflow-named aliases for legacy sprint-type metadata read tools', () => {
    const catalog = getMcpCatalog();
    const byName = new Map(catalog.tools.map(tool => [tool.canonical_name, tool]));

    expect(byName.get('agent_hq_list_sprint_types')?.aliases).toContain('agent_hq_list_workflow_types');
    expect(byName.get('agent_hq_list_sprint_type_statuses')?.aliases).toContain('agent_hq_list_workflow_type_statuses');
    expect(byName.get('agent_hq_list_sprint_type_outcomes')?.aliases).toContain('agent_hq_list_workflow_type_outcomes');
    expect(byName.get('agent_hq_list_sprint_type_relationship_types')?.aliases).toContain('agent_hq_list_workflow_type_relationship_types');
    expect(byName.get('agent_hq_list_task_field_schemas')?.aliases).toContain('agent_hq_list_workflow_type_field_schemas');
  });

  it('advertises the normal outcome tool with only stable runtime fields', () => {
    const catalog = getMcpCatalog();
    const tool = catalog.tools.find(item => item.canonical_name === 'agent_hq_post_task_outcome');
    expect(tool).toBeTruthy();
    expect(tool?.args.map(arg => arg.name).sort()).toEqual(['dry_run', 'outcome', 'payload', 'summary', 'task_id']);
  });

  it('advertises move_task status as workflow-resolved string, not a global enum', () => {
    const catalog = getMcpCatalog();
    const tool = catalog.tools.find(item => item.canonical_name === 'agent_hq_move_task');
    const status = tool?.args.find(arg => arg.name === 'status');

    expect(status?.schema).toMatchObject({ type: 'string', minLength: 1 });
    expect(status?.schema).not.toHaveProperty('enum');
    expect(status?.description).toContain('agent_hq_get_workflow_metadata');
    expect(catalog.enums).toMatchObject({
      task_statuses_source: 'workflow_metadata',
      task_statuses_metadata_tool: 'agent_hq_get_workflow_metadata',
      task_priorities_source: 'global_system_enum',
      task_story_points_source: 'global_system_enum',
      workflow_lifecycle_statuses_source: 'global_system_enum',
      task_types_source: 'workflow_definition_config',
      task_types_metadata_tool: 'agent_hq_get_workflow_metadata',
    });
    expect(catalog.enums).not.toHaveProperty('task_statuses');
  });

  it('registers live move_task status as a non-empty string before backend workflow validation', () => {
    const schemas = new Map<string, Record<string, ZodTypeAny>>();

    registerTasksTools({
      api: {} as never,
      registerTool(names, _description, schema) {
        schemas.set(names[0], schema);
      },
      registerResource: jest.fn(),
      wrap: (fn) => async () => ({ content: [{ type: 'text', text: JSON.stringify(await fn()) }] }),
    });

    const statusSchema = schemas.get('agent_hq_move_task')?.status;
    const jsonSchema = toJSONSchema(statusSchema!) as Record<string, unknown>;

    expect(jsonSchema).toMatchObject({ type: 'string', minLength: 1 });
    expect(jsonSchema).not.toHaveProperty('enum');
    expect(statusSchema?.safeParse('workflow_custom_status').success).toBe(true);
    expect(statusSchema?.safeParse('').success).toBe(false);
  });

  it('advertises custom_fields on task create and update schemas', () => {
    const schemas = new Map<string, Record<string, ZodTypeAny>>();

    registerTasksTools({
      api: {} as never,
      registerTool(names, _description, schema) {
        schemas.set(names[0], schema);
      },
      registerResource: jest.fn(),
      wrap: (fn) => async () => ({ content: [{ type: 'text', text: JSON.stringify(await fn()) }] }),
    });

    for (const toolName of ['agent_hq_create_task', 'agent_hq_update_task']) {
      const customFieldsSchema = schemas.get(toolName)?.custom_fields;
      const jsonSchema = toJSONSchema(customFieldsSchema!) as Record<string, unknown>;

      expect(jsonSchema).toMatchObject({ type: 'object' });
      expect(customFieldsSchema?.safeParse({ target_surface: 'api', risk_score: 2 }).success).toBe(true);
      expect(customFieldsSchema?.safeParse(['target_surface']).success).toBe(false);
    }
  });

  it('advertises optional workflow-resolved status on task create schema', () => {
    const schemas = new Map<string, Record<string, ZodTypeAny>>();

    registerTasksTools({
      api: {} as never,
      registerTool(names, _description, schema) {
        schemas.set(names[0], schema);
      },
      registerResource: jest.fn(),
      wrap: (fn) => async () => ({ content: [{ type: 'text', text: JSON.stringify(await fn()) }] }),
    });

    const statusSchema = schemas.get('agent_hq_create_task')?.status;
    const jsonSchema = toJSONSchema(statusSchema!) as Record<string, unknown>;

    expect(jsonSchema).toMatchObject({ type: 'string', minLength: 1 });
    expect(jsonSchema).not.toHaveProperty('enum');
    expect(statusSchema?.safeParse(undefined).success).toBe(true);
    expect(statusSchema?.safeParse('ready').success).toBe(true);
    expect(statusSchema?.safeParse('field_reported').success).toBe(true);
    expect(statusSchema?.safeParse('').success).toBe(false);
  });

  it('serializes argument docs with required flags, descriptions, and enum choices', () => {
    const catalog = getMcpCatalog();
    const byName = new Map(catalog.tools.map(tool => [tool.canonical_name, tool]));

    const createProject = byName.get('agent_hq_create_project');
    const projectName = createProject?.args.find(arg => arg.name === 'name');
    const projectDescription = createProject?.args.find(arg => arg.name === 'description');
    expect(projectName?.required).toBe(true);
    expect(projectName?.description).toBe('Project name');
    expect(projectName?.schema).toMatchObject({ type: 'string', minLength: 1 });
    expect(projectDescription?.required).toBe(false);

    const createWorkflow = byName.get('agent_hq_create_workflow');
    const status = createWorkflow?.args.find(arg => arg.name === 'status');
    expect(status?.required).toBe(false);
    expect(status?.schema).toMatchObject({ enum: ['planning', 'active', 'paused', 'complete', 'closed'] });

    const routingRules = byName.get('agent_hq_list_routing_rules');
    const tenantSelector = routingRules?.args.find(arg => arg.name === 'tenant_id');
    expect(tenantSelector?.required).toBe(false);
    expect(tenantSelector?.description).toContain('super-admin MCP keys');
  });
});
