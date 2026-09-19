import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AGENT_MCP_CAPABILITY_CATALOG } from '../lib/mcpApiAuth';
import { getMcpCatalog } from './catalog';
import { registerAgentHqMcpCatalog } from './registerCatalog';
import { canDiscoverTool, declaredToolNames, getToolPermissionRequirement } from './toolPermissions';
import { createMcpRegistrar } from './registrar';

const permits = (name: string, ...capabilities: string[]) => canDiscoverTool(`agent_hq_${name}`, new Set(capabilities));

test('every product tool has explicit metadata and every declared capability exists', () => {
  registerAgentHqMcpCatalog();
  expect(declaredToolNames()).toEqual(getMcpCatalog().tools.map(tool => tool.canonical_name).sort());
  const known = new Set(AGENT_MCP_CAPABILITY_CATALOG.map(capability => capability.key));
  for (const name of declaredToolNames()) {
    const requirement = getToolPermissionRequirement(name);
    expect(requirement.length).toBeGreaterThan(0);
    for (const clause of requirement) {
      expect(clause.length).toBeGreaterThan(0);
      for (const key of clause) expect(known.has(key)).toBe(true);
    }
    expect(canDiscoverTool(name, new Set())).toBe(false);
    expect(canDiscoverTool(name, new Set(['admin.full_access']))).toBe(true);
  }
});

test('missing declarations fail closed even for admin and cannot register', () => {
  expect(permits('unreviewed', 'admin.full_access')).toBe(false);
  const server = new McpServer({ name: 'test', version: '1' });
  const registrar = createMcpRegistrar(server, { authorizeTool: async () => {}, authenticateResource: async () => {} });
  expect(() => registrar.registerTool(['agent_hq_unreviewed'], '', {}, async () => ({ content: [] })))
    .toThrow('Missing MCP permission declaration');
});

test.each([
  ['get_task', ['tasks.read_active_context'], true],
  ['get_task', ['tasks.manage_project_tasks'], true],
  ['get_task_active_owner', ['tasks.manage_project_tasks'], false],
  ['create_task', ['tasks.read_project_context'], false],
  ['create_task', ['tasks.create'], true],
  ['update_task', ['tasks.write_active_custom_fields'], true],
  ['delete_task', ['tasks.write_active_custom_fields'], false],
  ['move_task', ['tasks.write_project_lifecycle'], true],
  ['post_task_outcome', ['tasks.write_project_notes'], false],
  ['start_task_run', ['tasks.write_project_lifecycle'], false],
  ['get_workflow_type', ['workflow_definitions.read_project_scope'], true],
  ['create_workflow_type_field_schema', ['workflow_definitions.read_project_scope'], false],
  ['create_workflow_type_field_schema', ['workflow_definitions.manage_project_scope'], true],
  ['get_workflow_type', ['workflow_definitions.manage_project_scope'], false],
  ['import_telemetry_definitions', ['telemetry.manage_metrics'], false],
  ['import_telemetry_definitions', ['telemetry.manage_reports'], false],
  ['import_telemetry_definitions', ['telemetry.manage_metrics', 'telemetry.manage_reports'], true],
  ['get_assignment_rule', ['routing_rules.manage_project_scope'], true],
  ['list_routing_transitions', ['workflow.read_active_configuration'], false],
  ['list_transition_requirements', ['workflow.read_active_configuration'], true],
  ['update_workflow', ['workflows.complete_active_workflow'], false],
  ['update_workflow', ['workflows.pause_active_workflow'], true],
  ['api_request', ['tasks.manage_project_tasks'], false],
])('%s visibility for %j is %s', (name, grants, allowed) => {
  expect(permits(name as string, ...grants as string[])).toBe(allowed);
});
