import type { AgentMcpCapabilityKey } from '../lib/mcpApiAuth';

/** OR of AND clauses. Resource, tenant, field and active-run checks still run in REST. */
export type ToolPermissionRequirement = readonly (readonly AgentMcpCapabilityKey[])[];
const requirements = new Map<string, ToolPermissionRequirement>();

// These are audited declarations, not guesses from names, domains or HTTP path strings.
// Keep explicit names so a newly registered tool cannot accidentally acquire access.
function declare(names: readonly string[], alternatives: ToolPermissionRequirement): void {
  for (const shortName of names) {
    const name = `agent_hq_${shortName}`;
    if (requirements.has(name)) throw new Error(`Duplicate MCP permission declaration: ${name}`);
    requirements.set(name, alternatives);
  }
}
const any = (...capabilities: AgentMcpCapabilityKey[]): ToolPermissionRequirement => capabilities.map(key => [key]);

declare(['get_task', 'get_task_context', 'get_task_notes', 'get_task_history', 'get_task_instances',
  'get_task_relationship_types', 'list_task_relationships'],
any('tasks.read_active_context', 'tasks.read_project_context', 'tasks.manage_project_tasks'));
declare(['get_task_active_owner'], any('tasks.read_active_context', 'tasks.read_project_context'));
declare(['create_task'], any('tasks.create', 'tasks.manage_project_tasks'));
declare(['update_task'], any('tasks.manage_project_tasks', 'tasks.write_active_custom_fields'));
declare(['delete_task', 'create_task_relationship', 'delete_task_relationship'], any('tasks.manage_project_tasks'));
declare(['search_project_tasks'], any('tasks.search_project_tasks'));
declare(['list_projects', 'list_workflows', 'list_tasks', 'get_workflow_metadata'], any('projects.read_project_board'));
declare(['get_project'], any('projects.read_active_project'));
declare(['get_workflow'], any('workflows.read_active_workflow'));
// update_workflow accepts a status-only patch; move_task has an outcome fallback.
declare(['set_workflow_status'], any('workflows.pause_active_workflow', 'workflows.complete_active_workflow'));
declare(['update_workflow'], any('workflows.pause_active_workflow'));
declare(['move_task'], any('tasks.write_active_lifecycle', 'tasks.write_project_lifecycle'));
declare(['add_task_note'], any('tasks.write_active_lifecycle', 'tasks.write_project_lifecycle', 'tasks.write_project_notes'));
declare(['post_task_outcome', 'record_deploy_evidence', 'record_live_verification', 'record_qa_evidence', 'record_review_evidence'],
any('tasks.write_active_lifecycle', 'tasks.write_project_lifecycle'));
declare(['start_task_run', 'check_in_task_run', 'report_task_blocker'], any('tasks.write_active_lifecycle'));
declare(['list_project_files', 'get_project_file', 'download_project_file', 'upload_project_file', 'replace_project_file',
  'delete_project_file', 'list_project_file_versions', 'list_workflow_files', 'get_workflow_file', 'download_workflow_file',
  'upload_workflow_file', 'replace_workflow_file', 'delete_workflow_file', 'list_workflow_file_versions'], any('projects.manage_active_files'));
declare(['analyze_agent_capabilities'], [['agents.manage_project_agents', 'mcp_capability_policies.read'], ['agents.manage_project_agents', 'mcp_capability_policies.write']]);
declare(['create_agent', 'delete_agent', 'get_agent', 'get_agent_docs', 'list_agents', 'update_agent'], any('agents.manage_project_agents'));
declare(['get_agent_mcp_capability_policy'], any('mcp_capability_policies.read', 'mcp_capability_policies.write'));
declare(['create_agent_mcp_capability_policy', 'update_agent_mcp_capability_policy', 'delete_agent_mcp_capability_policy'],
any('mcp_capability_policies.write'));
declare(['get_assignment_rule', 'list_assignment_rules'], any('routing_rules.read_project_scope', 'routing_rules.manage_project_scope'));
declare(['create_assignment_rule', 'update_assignment_rule', 'delete_assignment_rule'], any('routing_rules.manage_project_scope'));
declare(['create_routing_transition', 'delete_routing_transition', 'get_routing_transition', 'list_routing_transitions', 'update_routing_transition'],
any('routing_transitions.manage_project_scope'));
declare(['get_routing_graph', 'trace_routing', 'trace_task_path', 'analyze_routing_graph'], any('workflow.analyze_routing_graph'));
declare(['get_routing_audit', 'preview_routing_change'], any('workflow.edit_routing_config'));
declare(['list_transition_requirements'], any('transition_requirements.manage_project_scope', 'workflow.read_active_configuration'));
declare(['create_transition_requirement', 'update_transition_requirement', 'delete_transition_requirement'], any('transition_requirements.manage_project_scope'));
declare(['get_workflow_config', 'get_workflow_type', 'list_workflow_types', 'list_workflow_type_task_types',
  'get_workflow_type_field_schema', 'list_workflow_type_field_schemas', 'get_workflow_type_status', 'list_workflow_type_statuses',
  'get_resolved_workflow_type_statuses', 'get_workflow_type_outcome', 'list_workflow_type_outcomes', 'get_resolved_workflow_type_outcomes',
  'get_workflow_type_relationship_type', 'list_workflow_type_relationship_types'], any('workflow_definitions.read_project_scope'));
declare(['create_workflow_type', 'update_workflow_type', 'delete_workflow_type', 'update_workflow_type_task_types',
  'create_workflow_type_field_schema', 'update_workflow_type_field_schema', 'delete_workflow_type_field_schema',
  'create_workflow_type_status', 'update_workflow_type_status', 'delete_workflow_type_status',
  'create_workflow_type_outcome', 'update_workflow_type_outcome', 'delete_workflow_type_outcome',
  'create_workflow_type_relationship_type', 'update_workflow_type_relationship_type', 'delete_workflow_type_relationship_type'],
any('workflow_definitions.manage_project_scope'));
declare(['get_recurring_task_series', 'get_recurring_task_series_history', 'list_recurring_task_series'], any('recurring_task_series.read_project_scope'));
declare(['create_recurring_task_series', 'update_recurring_task_series', 'disable_recurring_task_series', 'enable_recurring_task_series',
  'run_recurring_task_series_now'], any('recurring_task_series.manage_project_scope'));
declare(['get_external_task_event_receipt', 'list_external_task_event_receipts'], any('external.manage_project_task_events'));
declare(['get_telemetry_contributors', 'get_telemetry_coverage', 'get_telemetry_metric', 'get_telemetry_profile', 'get_telemetry_query',
  'get_telemetry_report', 'list_telemetry_bindings', 'list_telemetry_catalog', 'list_telemetry_routing_signals', 'list_telemetry_metrics', 'list_telemetry_profiles',
  'list_telemetry_reports', 'list_telemetry_snapshots', 'preview_telemetry_binding'], any('telemetry.read'));
declare(['cancel_telemetry_query', 'preview_telemetry_metric', 'query_telemetry_metrics', 'validate_telemetry_definition'], any('telemetry.query'));
declare(['archive_telemetry_metric', 'archive_telemetry_profile', 'revise_telemetry_metric', 'revise_telemetry_profile',
  'save_telemetry_binding', 'save_telemetry_metric', 'save_telemetry_profile'], any('telemetry.manage_metrics'));
declare(['archive_telemetry_report', 'freeze_telemetry_report', 'revise_telemetry_report', 'save_telemetry_report', 'archive_telemetry_dashboard', 'revise_telemetry_dashboard', 'save_telemetry_dashboard'], any('telemetry.manage_reports'));
declare(['get_telemetry_dashboard', 'list_telemetry_dashboards'], any('telemetry.read'));
declare(['export_telemetry_definitions'], any('telemetry.export'));
declare(['import_telemetry_definitions'], [['telemetry.manage_metrics', 'telemetry.manage_reports']]);

// Administrative endpoints and the unrestricted REST escape hatch.
declare(['add_blocker', 'remove_blocker', 'api_request', 'provision_full_agent', 'sync_agent_mcp',
  'create_project', 'update_project', 'delete_project', 'create_workflow', 'delete_workflow',
  'create_workflow_event_mapping', 'update_workflow_event_mapping', 'delete_workflow_event_mapping',
  'get_workflow_event_mapping', 'list_workflow_event_mappings', 'get_agent_dispatch_contract', 'update_agent_dispatch_contract',
  'list_transition_requirement_fields',
  'add_team_member', 'apply_workflow_team_routing', 'assign_mcp_server_to_team', 'assign_tool_to_team', 'create_team',
  'create_team_routing_rule', 'delete_team', 'delete_team_routing_rule', 'get_agent_effective_capabilities', 'get_team',
  'list_agent_teams', 'list_team_mcp_servers', 'list_team_members', 'list_team_routing_rules', 'list_team_tools', 'list_teams',
  'preview_team_context', 'remove_mcp_server_from_team', 'remove_team_member', 'remove_tool_from_team', 'set_workflow_team',
  'update_team', 'update_team_member',
  'assign_mcp_server_to_agent', 'create_mcp_server', 'delete_mcp_server', 'get_mcp_server', 'list_agent_mcp_servers',
  'list_mcp_servers', 'remove_mcp_server_from_agent', 'update_mcp_server',
  'assign_skill_to_agent', 'create_skill', 'delete_skill', 'get_skill', 'list_agent_skills', 'list_skills', 'remove_skill_from_agent', 'update_skill',
  'assign_tool_to_agent', 'create_tool', 'delete_tool', 'get_tool', 'list_agent_tools', 'list_tools', 'remove_tool_from_agent', 'test_tool', 'update_tool',
  'create_model_routing_rule', 'delete_model_routing_rule', 'get_model_routing_rule', 'list_model_routing_rules', 'update_model_routing_rule'],
any('admin.full_access'));

const boundaryTools: Record<string,ToolPermissionRequirement> = {
  get_project_context:any('projects.read_all','projects.read_active_project','admin.full_access'),
  list_operations:any('discovery.read_catalog'),
  get_executable_revision:any('tools.publish'),
  get_execution_readiness:any('permissions.manage'),
  search_tasks:any('projects.read_all'),list_execution_bindings:any('tools.read'),remove_execution_binding:any('tools.assign'),
  list_permission_presets:any('discovery.read_catalog'),
  list_executable_revisions:any('tools.read'), create_executable_revision:any('tools.register'),
  publish_executable_revision:any('tools.publish'), revoke_executable_revision:any('tools.publish'),
  bind_executable_revision:any('tools.assign'), invoke_executable_revision:[['tools.execute','host.execute']],
};
for(const [name,requirement] of Object.entries(boundaryTools)) declare([name],requirement);
const explicitToolRequirements:Record<string,ToolPermissionRequirement> = {
 get_agent_docs:any('host.files.read'),
 create_tool:any('tools.register'),update_tool:any('tools.register'),delete_tool:[['tools.register','tools.publish']],
 create_mcp_server:any('tools.register'),update_mcp_server:any('tools.register'),delete_mcp_server:[['tools.register','tools.publish']],
 create_agent:[['host.configure','host.execute']],delete_agent:[['host.configure','host.execute']],
 test_tool:[['tools.execute','host.execute']],
 assign_tool_to_agent:any('tools.assign'),remove_tool_from_agent:any('tools.assign'),assign_tool_to_team:any('tools.assign'),remove_tool_from_team:any('tools.assign'),
 assign_mcp_server_to_agent:any('tools.assign'),remove_mcp_server_from_agent:any('tools.assign'),assign_mcp_server_to_team:any('tools.assign'),remove_mcp_server_from_team:any('tools.assign'),
 provision_full_agent:[['host.configure','host.execute']],sync_agent_mcp:[['host.configure','host.execute']],
 create_agent_mcp_capability_policy:any('permissions.manage'),update_agent_mcp_capability_policy:any('permissions.manage'),delete_agent_mcp_capability_policy:any('permissions.manage'),
};
for(const name of ['list_tools','get_tool','list_mcp_servers','get_mcp_server','list_agent_tools','list_agent_mcp_servers','list_skills','get_skill','list_agent_skills','list_teams','get_team','list_team_members','list_team_tools','list_team_mcp_servers','list_agent_teams','list_model_routing_rules','get_model_routing_rule']) explicitToolRequirements[name]=any('tools.read');
for(const name of ['create_skill','update_skill','delete_skill','assign_skill_to_agent','remove_skill_from_agent']) explicitToolRequirements[name]=[['host.configure','tools.publish']];
const delegatedTools=['create_task','create_assignment_rule','update_assignment_rule','create_routing_transition','update_routing_transition','create_workflow_type','update_workflow_type','update_workflow_type_task_types','create_workflow_type_field_schema','update_workflow_type_field_schema','create_workflow_type_status','update_workflow_type_status','create_workflow_type_outcome','update_workflow_type_outcome','create_workflow_type_relationship_type','update_workflow_type_relationship_type','create_recurring_task_series','update_recurring_task_series','enable_recurring_task_series','add_team_member','update_team_member','set_workflow_team','apply_workflow_team_routing','create_team_routing_rule','create_model_routing_rule','update_model_routing_rule'];
for(const name of delegatedTools) {
  const previous=requirements.get('agent_hq_'+name)??[];
  explicitToolRequirements[name]=[...previous.map(clause=>[...clause,'runs.dispatch','host.execute'] as AgentMcpCapabilityKey[]),['admin.full_access','runs.dispatch','host.execute']];
}
explicitToolRequirements.run_recurring_task_series_now=[['runs.dispatch','host.execute']];
for(const [name,requirement] of Object.entries(explicitToolRequirements)) requirements.set('agent_hq_'+name,requirement);
for(const name of ['get_project','get_workflow','get_task','get_task_context','get_task_history','get_task_notes','get_task_instances','get_task_active_owner','get_task_relationship_types','list_task_relationships','list_projects','list_workflows','list_tasks','get_workflow_metadata','list_agents','get_agent','list_recurring_task_series','get_recurring_task_series','get_recurring_task_series_history']) {
 const key='agent_hq_'+name; requirements.set(key,[...(requirements.get(key)??[]),['projects.read_all']]);
}
for(const name of ['get_telemetry_contributors','get_telemetry_coverage','get_telemetry_metric','get_telemetry_profile','get_telemetry_query','get_telemetry_report','list_telemetry_bindings','list_telemetry_catalog','list_telemetry_routing_signals','list_telemetry_metrics','list_telemetry_profiles','list_telemetry_reports','list_telemetry_snapshots','get_telemetry_dashboard','list_telemetry_dashboards']) {
 const key='agent_hq_'+name;requirements.set(key,[...(requirements.get(key)??[]),['projects.read_all']]);
}
const explicitTools=new Set([...Object.keys(explicitToolRequirements),...Object.keys(boundaryTools)].map(n=>'agent_hq_'+n));

export function getToolPermissionRequirement(name: string): ToolPermissionRequirement {
  const requirement = requirements.get(name);
  if (!requirement) throw new Error(`Missing MCP permission declaration: ${name}`);
  return requirement;
}

export function canDiscoverTool(name: string, enabled: ReadonlySet<string>): boolean {
  const requirement = requirements.get(name);
  if (!requirement) return false;
  return (!explicitTools.has(name) && enabled.has('admin.full_access')) || requirement.some(clause => clause.every(key => enabled.has(key)));
}

export function declaredToolNames(): string[] { return [...requirements.keys()].sort(); }
