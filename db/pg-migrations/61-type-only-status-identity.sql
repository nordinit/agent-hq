-- Statuses are defined only on the workflow type (workflow_type_task_statuses). The app no longer
-- reads or writes per-workflow rows (workflow_task_statuses); this makes the two telemetry functions
-- that still preferred them agree:
--   telemetry_signal_identity   a task's status identity is its type's status row (then the global
--                               task_statuses row), never a per-workflow row
--   telemetry_dependency_state  a blocker is resolved by its type's terminal flag (then global)
-- Existing per-workflow rows are kept, unused, so telemetry history recorded against them still
-- resolves; status selectors match by status key across both.
CREATE OR REPLACE FUNCTION telemetry.telemetry_dependency_state(row_data jsonb) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  SELECT jsonb_build_object(
    'unresolved_dependencies',CASE WHEN COALESCE(bool_and(COALESCE(b.tenant_id=(row_data->>'tenant_id')::bigint,false)),true)
      THEN COUNT(*) FILTER (WHERE COALESCE(ts.terminal,gs.terminal,0)<>1) ELSE NULL END,
    'dependencies_within_project',COALESCE(bool_and(b.project_id IS NOT DISTINCT FROM (row_data->>'project_id')::bigint),true),
    'dependencies_within_tenant',COALESCE(bool_and(COALESCE(b.tenant_id=(row_data->>'tenant_id')::bigint,false)),true))
  FROM task_dependencies d JOIN tasks b ON b.id=d.blocker_id JOIN workflows s ON s.id=b.workflow_id
  LEFT JOIN LATERAL (SELECT terminal FROM workflow_type_task_statuses WHERE workflow_type_key=s.workflow_type
    AND status_key=b.status AND (tenant_id=b.tenant_id OR tenant_id IS NULL)
    ORDER BY CASE WHEN tenant_id IS NULL THEN 0 ELSE 1 END DESC,id DESC LIMIT 1) ts ON true
  LEFT JOIN task_statuses gs ON gs.name=b.status
  WHERE d.blocked_id=(row_data->>'id')::bigint
$$;

CREATE OR REPLACE FUNCTION telemetry.telemetry_signal_identity(task_data jsonb, signal_kind text, signal_name text) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE owner_tenant bigint:=(task_data->>'tenant_id')::bigint; workflow bigint:=(task_data->>'workflow_id')::bigint;
  selected_workflow_type text; selected_table text; selected_id text; identity text;
BEGIN
  IF signal_name IS NULL THEN RETURN NULL; END IF;
  SELECT workflow_type INTO selected_workflow_type FROM workflows WHERE id=workflow AND tenant_id=owner_tenant;
  IF signal_kind='status' THEN
    SELECT 'workflow_type_task_statuses',id::text INTO selected_table,selected_id FROM workflow_type_task_statuses
      WHERE tenant_id=owner_tenant AND workflow_type_key=selected_workflow_type AND status_key=signal_name ORDER BY id DESC LIMIT 1;
    IF selected_id IS NULL THEN SELECT 'task_statuses',name INTO selected_table,selected_id FROM task_statuses WHERE name=signal_name; END IF;
  ELSE
    SELECT 'workflow_type_outcomes',id::text INTO selected_table,selected_id FROM workflow_type_outcomes
      WHERE tenant_id=owner_tenant AND workflow_type_key=selected_workflow_type AND outcome_key=signal_name
        AND (task_type IS NULL OR task_type='' OR task_type=task_data->>'task_type')
      ORDER BY CASE WHEN task_type=task_data->>'task_type' THEN 0 ELSE 1 END,id DESC LIMIT 1;
  END IF;
  IF selected_id IS NULL THEN RETURN 'unregistered:'||signal_kind||':'||signal_name; END IF;
  SELECT generation::text INTO identity FROM telemetry_signal_generations WHERE source_table=selected_table AND source_id=selected_id AND active
    AND EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname=selected_table
      AND t.tgname='telemetry_signal_generation' AND t.tgenabled IN ('O','A'));
  -- A disabled or missing producer is unknown, not an unregistered raw key.
  RETURN identity;
END $$;
