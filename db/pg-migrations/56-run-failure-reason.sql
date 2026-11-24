-- Why a run failed, as one of a few stable reasons, so telemetry can count failures by cause.
-- The reason is derived from the run's own recorded fields each time a run snapshot is taken, so
-- every past run is classified without a backfill, and refining the rules only needs a new
-- version of this function.
--   provider_limit  the model provider refused the run: usage, quota or rate limits
--   host_error      the host failed under the run: disk full, database I/O, the process vanished
--   not_authorized  execution authority refused the launch: unpublished or unbound revisions
--   setup_failed    the launch could not be prepared: credentials, MCP preflight, workspace, routing
--   timeout         the watchdog ended a run that stopped making progress
--   no_outcome      the runtime finished without posting the required lifecycle outcome
--   stopped         an operator or the system stopped the run
--   runtime_error   any other failure the runtime reported
CREATE OR REPLACE FUNCTION runs.run_failure_reason(
  status text, error text, runtime_end_error text, lifecycle_handoff_status text, runtime_end_source text
) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    WHEN status IS NULL OR status NOT IN ('failed', 'stopped') THEN NULL
    WHEN detail ~* '(provider limit|usage limit|rate[ _-]?limit|out_of_credits|insufficient_quota|quota exceeded)' THEN 'provider_limit'
    WHEN detail ~* '(ENOSPC|no space left on device|interrupted system call|could not open file|no longer present on)' THEN 'host_error'
    WHEN detail ~* '(executable assignment overrides|no active grant|execution profile changed|requires explicit host\.execute|execution grant denied)' THEN 'not_authorized'
    WHEN detail ~* '(credential preparation failed|failed preflight|startup probe failed|workspace creation failed|materialized mcp servers|dispatch preparation|runtime routing overrides|refused to start)' THEN 'setup_failed'
    WHEN detail ~* '(^|\s)watchdog:' OR detail ~* 'timed? ?out' THEN 'timeout'
    WHEN lifecycle_handoff_status = 'missing' OR detail ~* 'without required lifecycle outcome' THEN 'no_outcome'
    WHEN status = 'stopped' OR runtime_end_source = 'manual_stop' OR detail ~* 'run stopped' THEN 'stopped'
    ELSE 'runtime_error'
  END
  FROM (SELECT concat_ws(' ', runtime_end_error, error) AS detail) AS d
$$;

CREATE OR REPLACE FUNCTION telemetry.telemetry_run_snapshot(row_data jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE result jsonb; agent_snapshot jsonb;
BEGIN
  result := telemetry_pick(row_data, ARRAY['id','agent_id','task_id','status','created_at','dispatched_at',
    'completed_at','started_at','task_outcome','token_input','token_output','token_total',
    'effective_model','effective_thinking_level','effective_fast_mode','failure_class','failure_stage',
    'runtime_ended_at','runtime_end_success','runtime_end_source','lifecycle_outcome_posted_at',
    'runtime_completed_at','lifecycle_handoff_status','semantic_outcome_missing']);
  result := result || jsonb_build_object('failure_reason', runs.run_failure_reason(row_data->>'status', row_data->>'error',
    row_data->>'runtime_end_error', row_data->>'lifecycle_handoff_status', row_data->>'runtime_end_source'));
  SELECT jsonb_build_object('instructions_version',a.instructions_version,
    'instructions_fingerprint',md5(a.job_instructions),'runtime_type',a.runtime_type)
    INTO agent_snapshot FROM agents a
    WHERE a.id = (row_data->>'agent_id')::bigint AND a.tenant_id = (row_data->>'tenant_id')::bigint;
  RETURN result || jsonb_build_object('agent_config_at_observation',agent_snapshot);
END $$;
