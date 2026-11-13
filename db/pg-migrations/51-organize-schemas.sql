-- Groups the tables into schemas by what they describe, so the model can be read by area.
--
-- Application SQL names tables without a schema. The search path resolves them, set here as the
-- database default (for psql and DBeaver) and by every Agent HQ pool (db/pg/schemas.ts), since a
-- database cloned from a template does not inherit ALTER DATABASE settings. Table names stay
-- unique across schemas, so an unqualified name can only mean one table.
--
-- public comes first and keeps only schema_migrations: the runner finds its ledger through
-- current_schema(), and a later migration that creates a table without a schema puts it in
-- public, where the schema layout test rejects it.
--
-- SET SCHEMA changes catalog entries only. Indexes, constraints, owned sequences and row types
-- move with their table; triggers, foreign keys and the view refer to objects by OID.

CREATE SCHEMA core;
COMMENT ON SCHEMA core IS 'Tenants, projects and instance-wide settings, providers and identities.';
CREATE SCHEMA agents;
COMMENT ON SCHEMA agents IS 'Agents, teams, tools, skills, MCP servers and the sync of MCP configuration to runtimes.';
CREATE SCHEMA workflow;
COMMENT ON SCHEMA workflow IS 'Workflow definitions: types, statuses, transitions, routing and task field schemas.';
CREATE SCHEMA tasks;
COMMENT ON SCHEMA tasks IS 'Tasks and their history, notes, events, relationships and recurring series.';
CREATE SCHEMA runs;
COMMENT ON SCHEMA runs IS 'Job instances and everything a run produces: artifacts, dispatches, executions, sessions, logs, notifications.';
CREATE SCHEMA chat;
COMMENT ON SCHEMA chat IS 'Chat sessions, messages and attachments.';
CREATE SCHEMA access;
COMMENT ON SCHEMA access IS 'Credentials and execution authority: MCP API keys, OAuth grants, executable revisions and secrets.';
CREATE SCHEMA telemetry;
COMMENT ON SCHEMA telemetry IS 'Telemetry capture, definitions, catalog, observations and query results.';

-- core: tenants, projects and instance-wide settings, providers and identities
ALTER TABLE tenants SET SCHEMA core;
ALTER TABLE projects SET SCHEMA core;
ALTER TABLE project_files SET SCHEMA core;
ALTER TABLE project_file_versions SET SCHEMA core;
ALTER TABLE project_audit_log SET SCHEMA core;
ALTER TABLE app_settings SET SCHEMA core;
ALTER TABLE system_policies SET SCHEMA core;
ALTER TABLE provider_config SET SCHEMA core;
ALTER TABLE provider_connections SET SCHEMA core;
ALTER TABLE github_identities SET SCHEMA core;
ALTER TABLE security_events SET SCHEMA core;

-- agents: agents, teams, tools, skills, MCP servers and the sync of MCP configuration to runtimes
ALTER TABLE agents SET SCHEMA agents;
ALTER TABLE agent_mcp_assignments SET SCHEMA agents;
ALTER TABLE agent_mcp_capability_policies SET SCHEMA agents;
ALTER TABLE agent_tool_assignments SET SCHEMA agents;
ALTER TABLE tools SET SCHEMA agents;
ALTER TABLE skills SET SCHEMA agents;
ALTER TABLE skill_files SET SCHEMA agents;
ALTER TABLE mcp_servers SET SCHEMA agents;
ALTER TABLE teams SET SCHEMA agents;
ALTER TABLE team_members SET SCHEMA agents;
ALTER TABLE team_routing_rules SET SCHEMA agents;
ALTER TABLE team_mcp_assignments SET SCHEMA agents;
ALTER TABLE team_tool_assignments SET SCHEMA agents;
ALTER TABLE default_package_applications SET SCHEMA agents;
ALTER TABLE agent_mcp_sync_queue SET SCHEMA agents;
ALTER TABLE agent_mcp_reconciliation SET SCHEMA agents;
ALTER TABLE agent_mcp_recovery SET SCHEMA agents;
ALTER TABLE agent_mcp_recovery_tasks SET SCHEMA agents;

-- workflow: workflow definitions: types, statuses, transitions, routing and task field schemas
ALTER TABLE workflows SET SCHEMA workflow;
ALTER TABLE workflow_types SET SCHEMA workflow;
ALTER TABLE workflow_type_outcomes SET SCHEMA workflow;
ALTER TABLE workflow_type_relationship_types SET SCHEMA workflow;
ALTER TABLE workflow_type_task_statuses SET SCHEMA workflow;
ALTER TABLE workflow_type_task_types SET SCHEMA workflow;
ALTER TABLE workflow_task_routing_rules SET SCHEMA workflow;
ALTER TABLE workflow_task_statuses SET SCHEMA workflow;
ALTER TABLE workflow_task_transitions SET SCHEMA workflow;
ALTER TABLE workflow_task_transition_requirements SET SCHEMA workflow;
ALTER TABLE workflow_task_transition_requirement_tombstones SET SCHEMA workflow;
ALTER TABLE workflow_files SET SCHEMA workflow;
ALTER TABLE workflow_file_versions SET SCHEMA workflow;
ALTER TABLE routing_config SET SCHEMA workflow;
ALTER TABLE routing_config_audit_log SET SCHEMA workflow;
ALTER TABLE routing_transitions SET SCHEMA workflow;
ALTER TABLE story_point_model_routing SET SCHEMA workflow;
ALTER TABLE lifecycle_rules SET SCHEMA workflow;
ALTER TABLE task_field_schemas SET SCHEMA workflow;
ALTER TABLE task_statuses SET SCHEMA workflow;

-- tasks: tasks and their history, notes, events, relationships and recurring series
ALTER TABLE tasks SET SCHEMA tasks;
ALTER TABLE task_history SET SCHEMA tasks;
ALTER TABLE task_notes SET SCHEMA tasks;
ALTER TABLE task_events SET SCHEMA tasks;
ALTER TABLE task_dependencies SET SCHEMA tasks;
ALTER TABLE task_relationships SET SCHEMA tasks;
ALTER TABLE task_attachments SET SCHEMA tasks;
ALTER TABLE task_outcome_metrics SET SCHEMA tasks;
ALTER TABLE task_status_owners SET SCHEMA tasks;
ALTER TABLE recurring_task_series SET SCHEMA tasks;
ALTER TABLE recurring_task_runs SET SCHEMA tasks;
ALTER TABLE external_event_mappings SET SCHEMA tasks;
ALTER TABLE external_task_event_receipts SET SCHEMA tasks;

-- runs: job instances and everything a run produces: artifacts, dispatches, executions, sessions, logs, notifications
ALTER TABLE job_instances SET SCHEMA runs;
ALTER TABLE instance_artifacts SET SCHEMA runs;
ALTER TABLE dispatch_log SET SCHEMA runs;
ALTER TABLE dispatch_context_bundles SET SCHEMA runs;
ALTER TABLE runtime_executions SET SCHEMA runs;
ALTER TABLE runtime_checkpoints SET SCHEMA runs;
ALTER TABLE sessions SET SCHEMA runs;
ALTER TABLE session_messages SET SCHEMA runs;
ALTER TABLE logs SET SCHEMA runs;
ALTER TABLE notification_records SET SCHEMA runs;
ALTER TABLE notification_deliveries SET SCHEMA runs;

-- chat: chat sessions, messages and attachments
ALTER TABLE canonical_chat_sessions SET SCHEMA chat;
ALTER TABLE chat_messages SET SCHEMA chat;
ALTER TABLE chat_attachments SET SCHEMA chat;

-- access: credentials and execution authority: MCP API keys, OAuth grants, executable revisions and secrets
ALTER TABLE mcp_api_keys SET SCHEMA access;
ALTER TABLE mcp_oauth_clients SET SCHEMA access;
ALTER TABLE mcp_oauth_grants SET SCHEMA access;
ALTER TABLE mcp_oauth_authorization_codes SET SCHEMA access;
ALTER TABLE executable_revisions SET SCHEMA access;
ALTER TABLE executable_secret_values SET SCHEMA access;
ALTER TABLE execution_bindings SET SCHEMA access;
ALTER TABLE execution_credential_scopes SET SCHEMA access;
ALTER TABLE execution_audit SET SCHEMA access;

-- telemetry: telemetry capture, definitions, catalog, observations and query results
ALTER TABLE telemetry_binding_audit SET SCHEMA telemetry;
ALTER TABLE telemetry_capture_sources SET SCHEMA telemetry;
ALTER TABLE telemetry_catalog_entries SET SCHEMA telemetry;
ALTER TABLE telemetry_catalog_revisions SET SCHEMA telemetry;
ALTER TABLE telemetry_definition_revisions SET SCHEMA telemetry;
ALTER TABLE telemetry_definitions SET SCHEMA telemetry;
ALTER TABLE telemetry_field_generations SET SCHEMA telemetry;
ALTER TABLE telemetry_metric_bindings SET SCHEMA telemetry;
ALTER TABLE telemetry_observations SET SCHEMA telemetry;
ALTER TABLE telemetry_outbox SET SCHEMA telemetry;
ALTER TABLE telemetry_query_results SET SCHEMA telemetry;
ALTER TABLE telemetry_query_sources SET SCHEMA telemetry;
ALTER TABLE telemetry_retention_state SET SCHEMA telemetry;
ALTER TABLE telemetry_settings SET SCHEMA telemetry;
ALTER TABLE telemetry_signal_generations SET SCHEMA telemetry;
ALTER TABLE telemetry_source_coverage SET SCHEMA telemetry;

-- Functions and the view follow the tables they serve.
ALTER FUNCTION enqueue_openclaw_mcp_sync_agents(agent_ids bigint[]) SET SCHEMA agents;
ALTER FUNCTION enqueue_openclaw_mcp_sync_for_agent() SET SCHEMA agents;
ALTER FUNCTION enqueue_openclaw_mcp_sync_for_agent_row() SET SCHEMA agents;
ALTER FUNCTION enqueue_openclaw_mcp_sync_for_server() SET SCHEMA agents;
ALTER FUNCTION enqueue_openclaw_mcp_sync_for_team(team_ids bigint[]) SET SCHEMA agents;
ALTER FUNCTION enqueue_openclaw_mcp_sync_for_team_assignment() SET SCHEMA agents;
ALTER FUNCTION enqueue_openclaw_mcp_sync_for_team_row() SET SCHEMA agents;
ALTER FUNCTION protect_executable_revision() SET SCHEMA access;
ALTER FUNCTION protect_execution_audit() SET SCHEMA access;
ALTER FUNCTION telemetry_capture_change() SET SCHEMA telemetry;
ALTER FUNCTION telemetry_capture_outcome_evidence() SET SCHEMA telemetry;
ALTER FUNCTION telemetry_capture_outcome_identity() SET SCHEMA telemetry;
ALTER FUNCTION telemetry_dependency_state(row_data jsonb) SET SCHEMA telemetry;
ALTER FUNCTION telemetry_discarded_ancestry(owner_tenant bigint, root_keys text[]) SET SCHEMA telemetry;
ALTER FUNCTION telemetry_expand_sources(selected_tenant bigint, roots jsonb) SET SCHEMA telemetry;
ALTER FUNCTION telemetry_invalidate_source(selected_tenant bigint, selected_type text, selected_id bigint, deleted boolean) SET SCHEMA telemetry;
ALTER FUNCTION telemetry_json(raw text) SET SCHEMA telemetry;
ALTER FUNCTION telemetry_outcome_evidence(data jsonb) SET SCHEMA telemetry;
ALTER FUNCTION telemetry_pick(row_data jsonb, keys text[]) SET SCHEMA telemetry;
ALTER FUNCTION telemetry_purge_task_results() SET SCHEMA telemetry;
ALTER FUNCTION telemetry_refresh_dependencies(affected_ids bigint[], source_prefix text, cause text) SET SCHEMA telemetry;
ALTER FUNCTION telemetry_run_snapshot(row_data jsonb) SET SCHEMA telemetry;
ALTER FUNCTION telemetry_schema_snapshot(raw text) SET SCHEMA telemetry;
ALTER FUNCTION telemetry_signal_identity(task_data jsonb, signal_kind text, signal_name text) SET SCHEMA telemetry;
ALTER FUNCTION telemetry_sync_schema_generations(owner_tenant bigint, owner_schema bigint, raw_schema text) SET SCHEMA telemetry;
ALTER FUNCTION telemetry_sync_signal_generation(source_name text, row_data jsonb, is_deleted boolean) SET SCHEMA telemetry;
ALTER FUNCTION telemetry_task_snapshot(row_data jsonb) SET SCHEMA telemetry;
ALTER FUNCTION telemetry_task_snapshot_without_generations(row_data jsonb) SET SCHEMA telemetry;
ALTER FUNCTION telemetry_task_snapshot_without_signal_identities(row_data jsonb) SET SCHEMA telemetry;
ALTER FUNCTION telemetry_timestamp(raw text, fallback timestamp with time zone) SET SCHEMA telemetry;
ALTER FUNCTION telemetry_track_schema_generation() SET SCHEMA telemetry;
ALTER FUNCTION telemetry_track_signal_generation() SET SCHEMA telemetry;
ALTER FUNCTION telemetry_track_task_status_identity() SET SCHEMA telemetry;
ALTER VIEW telemetry_source_context SET SCHEMA telemetry;

-- telemetry_capture_change() probes for the query-result table by its qualified name, which
-- would quietly stop matching once the table left public and skip result invalidation.
DO $$
BEGIN
  EXECUTE replace(pg_get_functiondef('telemetry.telemetry_capture_change()'::regprocedure),
    'public.telemetry_query_results', 'telemetry.telemetry_query_results');
END $$;

-- New sessions (psql, DBeaver) get the search path from the database; this session needs it now
-- for anything the runner does after this migration.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = public, core, agents, workflow, tasks, runs, chat, access, telemetry', current_database());
END $$;
SELECT set_config('search_path', 'public, core, agents, workflow, tasks, runs, chat, access, telemetry', false);

-- Fail rather than leave anything behind in public or pointing at it.
DO $$
DECLARE leftover TEXT;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO leftover FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     AND c.relname <> 'schema_migrations';
  IF leftover IS NOT NULL THEN RAISE EXCEPTION 'relations left in public: %', leftover; END IF;

  SELECT string_agg(p.proname, ', ') INTO leftover FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;
  IF leftover IS NOT NULL THEN RAISE EXCEPTION 'functions left in public: %', leftover; END IF;

  SELECT string_agg(p.proname, ', ') INTO leftover FROM pg_proc p
   WHERE p.pronamespace::regnamespace::text IN ('core', 'agents', 'workflow', 'tasks', 'runs', 'chat', 'access', 'telemetry')
     AND p.prosrc ~ '\mpublic\.';
  IF leftover IS NOT NULL THEN RAISE EXCEPTION 'functions still name public objects: %', leftover; END IF;
END $$;
