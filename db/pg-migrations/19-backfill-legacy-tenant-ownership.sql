-- Legacy databases can contain tenant-owned rows whose tenant_id predates tenant isolation.
-- Startup deliberately verifies this invariant without repairing it, so the one-time repair
-- belongs here: an explicit, atomic migration that can be audited before it runs.

DO $migration$
DECLARE
  configured_default text;
  default_tenant_id bigint;
  default_tenant_count bigint;
  owned_table text;
  remaining bigint;
  needs_repair boolean := false;
  owned_tables constant text[] := ARRAY[
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
    'sprint_types',
    'task_field_schemas',
    'sprint_type_task_types',
    'sprint_type_task_statuses',
    'sprint_type_outcomes',
    'sprint_type_relationship_types'
  ];
  -- These columns are intentionally nullable in the folded baseline. Runtime writers derive
  -- tenant ownership from their parent records, but retaining the baseline shape avoids turning
  -- this data repair into an unrelated type-tightening migration.
  baseline_nullable_tables constant text[] := ARRAY[
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
    'recurring_task_series'
  ];
BEGIN
  -- Fresh installs run schema migrations before the explicit installer creates a tenant. An
  -- empty database needs no ownership repair and must not make migrations seed configuration.
  FOREACH owned_table IN ARRAY owned_tables LOOP
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I WHERE tenant_id IS NULL)',
      owned_table
    ) INTO needs_repair;
    EXIT WHEN needs_repair;
  END LOOP;

  IF needs_repair THEN
  SELECT count(*) INTO default_tenant_count
  FROM tenants
  WHERE is_default = 1;

  IF default_tenant_count <> 1 THEN
    RAISE EXCEPTION
      'Tenant ownership repair requires exactly one default tenant; found %',
      default_tenant_count;
  END IF;

  SELECT value INTO configured_default
  FROM app_settings
  WHERE key = 'default_tenant_id';

  IF configured_default IS NULL OR configured_default !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION
      'Tenant ownership repair requires app_settings.default_tenant_id to be a positive integer';
  END IF;

  SELECT id INTO default_tenant_id
  FROM tenants
  WHERE id = configured_default::bigint
    AND is_default = 1;

  IF default_tenant_id IS NULL THEN
    RAISE EXCEPTION
      'app_settings.default_tenant_id (%) does not identify the one default tenant',
      configured_default;
  END IF;

  -- A NULL-owned row can name several parents. Refuse ambiguity instead of silently choosing
  -- one tenant according to update order.
  IF EXISTS (
    SELECT 1
    FROM agents child
    LEFT JOIN projects project ON project.id = child.project_id
    LEFT JOIN sprints sprint ON sprint.id = child.sprint_id
    WHERE child.tenant_id IS NULL
      AND project.tenant_id IS NOT NULL
      AND sprint.tenant_id IS NOT NULL
      AND project.tenant_id <> sprint.tenant_id
  ) THEN
    RAISE EXCEPTION 'Cannot repair agents: project and sprint ownership conflict';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM tasks child
    LEFT JOIN sprints sprint ON sprint.id = child.sprint_id
    LEFT JOIN projects project ON project.id = child.project_id
    LEFT JOIN agents agent ON agent.id = child.agent_id
    WHERE child.tenant_id IS NULL
      AND (
        SELECT count(DISTINCT candidate)
        FROM unnest(ARRAY[sprint.tenant_id, project.tenant_id, agent.tenant_id]) candidate
        WHERE candidate IS NOT NULL
      ) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot repair tasks: sprint, project, and agent ownership conflict';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM job_instances child
    LEFT JOIN tasks task ON task.id = child.task_id
    LEFT JOIN agents agent ON agent.id = child.agent_id
    WHERE child.tenant_id IS NULL
      AND task.tenant_id IS NOT NULL
      AND agent.tenant_id IS NOT NULL
      AND task.tenant_id <> agent.tenant_id
  ) THEN
    RAISE EXCEPTION 'Cannot repair job_instances: task and agent ownership conflict';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM logs child
    LEFT JOIN job_instances instance ON instance.id = child.instance_id
    LEFT JOIN agents agent ON agent.id = child.agent_id
    WHERE child.tenant_id IS NULL
      AND instance.tenant_id IS NOT NULL
      AND agent.tenant_id IS NOT NULL
      AND instance.tenant_id <> agent.tenant_id
  ) THEN
    RAISE EXCEPTION 'Cannot repair logs: instance and agent ownership conflict';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM chat_messages child
    LEFT JOIN job_instances instance ON instance.id = child.instance_id
    LEFT JOIN agents agent ON agent.id = child.agent_id
    WHERE child.tenant_id IS NULL
      AND instance.tenant_id IS NOT NULL
      AND agent.tenant_id IS NOT NULL
      AND instance.tenant_id <> agent.tenant_id
  ) THEN
    RAISE EXCEPTION 'Cannot repair chat_messages: instance and agent ownership conflict';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM sessions child
    LEFT JOIN tasks task ON task.id = child.task_id
    LEFT JOIN job_instances instance ON instance.id = child.instance_id
    LEFT JOIN projects project ON project.id = child.project_id
    LEFT JOIN agents agent ON agent.id = child.agent_id
    WHERE child.tenant_id IS NULL
      AND (
        SELECT count(DISTINCT candidate)
        FROM unnest(ARRAY[task.tenant_id, instance.tenant_id, project.tenant_id, agent.tenant_id]) candidate
        WHERE candidate IS NOT NULL
      ) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot repair sessions: parent ownership conflicts';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM recurring_task_series child
    LEFT JOIN sprints sprint ON sprint.id = child.sprint_id
    LEFT JOIN projects project ON project.id = child.project_id
    LEFT JOIN agents agent ON agent.id = child.agent_id
    WHERE child.tenant_id IS NULL
      AND (
        SELECT count(DISTINCT candidate)
        FROM unnest(ARRAY[sprint.tenant_id, project.tenant_id, agent.tenant_id]) candidate
        WHERE candidate IS NOT NULL
      ) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot repair recurring_task_series: parent ownership conflicts';
  END IF;

  -- Root records have no stronger owner. Fill them first so dependent rows can inherit a
  -- concrete tenant through their foreign-key relationships.
  UPDATE projects SET tenant_id = default_tenant_id WHERE tenant_id IS NULL;

  UPDATE sprints child
  SET tenant_id = project.tenant_id
  FROM projects project
  WHERE child.tenant_id IS NULL AND project.id = child.project_id;

  UPDATE agents child
  SET tenant_id = project.tenant_id
  FROM projects project
  WHERE child.tenant_id IS NULL AND project.id = child.project_id;

  UPDATE agents child
  SET tenant_id = sprint.tenant_id
  FROM sprints sprint
  WHERE child.tenant_id IS NULL AND sprint.id = child.sprint_id;

  UPDATE tasks child
  SET tenant_id = sprint.tenant_id
  FROM sprints sprint
  WHERE child.tenant_id IS NULL AND sprint.id = child.sprint_id;

  UPDATE tasks child
  SET tenant_id = project.tenant_id
  FROM projects project
  WHERE child.tenant_id IS NULL AND project.id = child.project_id;

  UPDATE tasks child
  SET tenant_id = agent.tenant_id
  FROM agents agent
  WHERE child.tenant_id IS NULL AND agent.id = child.agent_id;

  UPDATE job_instances child
  SET tenant_id = task.tenant_id
  FROM tasks task
  WHERE child.tenant_id IS NULL AND task.id = child.task_id;

  UPDATE job_instances child
  SET tenant_id = agent.tenant_id
  FROM agents agent
  WHERE child.tenant_id IS NULL AND agent.id = child.agent_id;

  UPDATE task_history child
  SET tenant_id = task.tenant_id
  FROM tasks task
  WHERE child.tenant_id IS NULL AND task.id = child.task_id;

  UPDATE task_notes child
  SET tenant_id = task.tenant_id
  FROM tasks task
  WHERE child.tenant_id IS NULL AND task.id = child.task_id;

  UPDATE task_events child
  SET tenant_id = task.tenant_id
  FROM tasks task
  WHERE child.tenant_id IS NULL AND task.id = child.task_id;

  UPDATE integrity_events child
  SET tenant_id = task.tenant_id
  FROM tasks task
  WHERE child.tenant_id IS NULL AND task.id = child.task_id;

  UPDATE task_creation_events child
  SET tenant_id = task.tenant_id
  FROM tasks task
  WHERE child.tenant_id IS NULL AND task.id = child.task_id;

  UPDATE task_outcome_metrics child
  SET tenant_id = task.tenant_id
  FROM tasks task
  WHERE child.tenant_id IS NULL AND task.id = child.task_id;

  UPDATE logs child
  SET tenant_id = instance.tenant_id
  FROM job_instances instance
  WHERE child.tenant_id IS NULL AND instance.id = child.instance_id;

  UPDATE logs child
  SET tenant_id = agent.tenant_id
  FROM agents agent
  WHERE child.tenant_id IS NULL AND agent.id = child.agent_id;

  UPDATE chat_messages child
  SET tenant_id = instance.tenant_id
  FROM job_instances instance
  WHERE child.tenant_id IS NULL AND instance.id = child.instance_id;

  UPDATE chat_messages child
  SET tenant_id = agent.tenant_id
  FROM agents agent
  WHERE child.tenant_id IS NULL AND agent.id = child.agent_id;

  UPDATE sessions child
  SET tenant_id = task.tenant_id
  FROM tasks task
  WHERE child.tenant_id IS NULL AND task.id = child.task_id;

  UPDATE sessions child
  SET tenant_id = instance.tenant_id
  FROM job_instances instance
  WHERE child.tenant_id IS NULL AND instance.id = child.instance_id;

  UPDATE sessions child
  SET tenant_id = project.tenant_id
  FROM projects project
  WHERE child.tenant_id IS NULL AND project.id = child.project_id;

  UPDATE sessions child
  SET tenant_id = agent.tenant_id
  FROM agents agent
  WHERE child.tenant_id IS NULL AND agent.id = child.agent_id;

  UPDATE routing_config child
  SET tenant_id = project.tenant_id
  FROM projects project
  WHERE child.tenant_id IS NULL AND project.id = child.project_id;

  UPDATE sprint_task_routing_rules child
  SET tenant_id = sprint.tenant_id
  FROM sprints sprint
  WHERE child.tenant_id IS NULL AND sprint.id = child.sprint_id;

  UPDATE sprint_task_routing_rules child
  SET tenant_id = project.tenant_id
  FROM projects project
  WHERE child.tenant_id IS NULL AND project.id = child.project_id;

  UPDATE sprint_task_routing_rules child
  SET tenant_id = agent.tenant_id
  FROM agents agent
  WHERE child.tenant_id IS NULL AND agent.id = child.agent_id;

  UPDATE sprint_task_transitions child
  SET tenant_id = sprint.tenant_id
  FROM sprints sprint
  WHERE child.tenant_id IS NULL AND sprint.id = child.sprint_id;

  UPDATE sprint_task_transitions child
  SET tenant_id = project.tenant_id
  FROM projects project
  WHERE child.tenant_id IS NULL AND project.id = child.project_id;

  UPDATE sprint_task_transition_requirements child
  SET tenant_id = sprint.tenant_id
  FROM sprints sprint
  WHERE child.tenant_id IS NULL AND sprint.id = child.sprint_id;

  UPDATE sprint_task_transition_requirements child
  SET tenant_id = project.tenant_id
  FROM projects project
  WHERE child.tenant_id IS NULL AND project.id = child.project_id;

  UPDATE story_point_model_routing child
  SET tenant_id = sprint.tenant_id
  FROM sprints sprint
  WHERE child.tenant_id IS NULL AND sprint.id = child.sprint_id;

  UPDATE story_point_model_routing child
  SET tenant_id = project.tenant_id
  FROM projects project
  WHERE child.tenant_id IS NULL AND project.id = child.project_id;

  UPDATE external_event_mappings child
  SET tenant_id = sprint.tenant_id
  FROM sprints sprint
  WHERE child.tenant_id IS NULL AND sprint.id = child.sprint_id;

  UPDATE external_event_mappings child
  SET tenant_id = project.tenant_id
  FROM projects project
  WHERE child.tenant_id IS NULL AND project.id = child.project_id;

  UPDATE recurring_task_series child
  SET tenant_id = sprint.tenant_id
  FROM sprints sprint
  WHERE child.tenant_id IS NULL AND sprint.id = child.sprint_id;

  UPDATE recurring_task_series child
  SET tenant_id = project.tenant_id
  FROM projects project
  WHERE child.tenant_id IS NULL AND project.id = child.project_id;

  UPDATE recurring_task_series child
  SET tenant_id = agent.tenant_id
  FROM agents agent
  WHERE child.tenant_id IS NULL AND agent.id = child.agent_id;

  -- Rows that genuinely predate tenant isolation can have no tenant-bearing parent. Their
  -- historical owner is the configured default tenant, matching the old explicit repair while
  -- avoiding a hard-coded tenant id.
  FOREACH owned_table IN ARRAY owned_tables LOOP
    EXECUTE format(
      'UPDATE %I SET tenant_id = $1 WHERE tenant_id IS NULL',
      owned_table
    ) USING default_tenant_id;
  END LOOP;

  END IF;

  -- An earlier pre-release draft tightened all ownership columns. Preserve the baseline's
  -- deliberate nullability and make this migration safe to re-run while that draft is reconciled.
  FOREACH owned_table IN ARRAY baseline_nullable_tables LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN tenant_id DROP NOT NULL',
      owned_table
    );
  END LOOP;

  -- Enforce the startup verifier's data invariant without broad schema tightening. Any unexpected
  -- table shape or unresolved row aborts the entire migration transaction.
  FOREACH owned_table IN ARRAY owned_tables LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE tenant_id IS NULL',
      owned_table
    ) INTO remaining;
    IF remaining <> 0 THEN
      RAISE EXCEPTION '% still contains % row(s) without tenant ownership', owned_table, remaining;
    END IF;
  END LOOP;
END
$migration$;
