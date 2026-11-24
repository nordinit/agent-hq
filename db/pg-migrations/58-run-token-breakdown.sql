-- Run snapshots gain comparable token counts and the usage status recorded since migration 55.
-- Runtimes report cache reads differently: Codex counts them inside input_tokens, Claude Code
-- reports them separately (runtimes/runTokenUsage.ts). The stored columns stay as each runtime
-- reports them; snapshots add counts that mean the same thing for every runtime:
--   tokens_fresh_in   input tokens that were not cache reads
--   tokens_cached_in  cache-read input tokens
--   token_usage_status  recorded, partial or unavailable (NULL before usage tracking)
-- The runtime comes from the run's own execution record, so it stays right if an agent later
-- changes runtime.
CREATE OR REPLACE FUNCTION telemetry.telemetry_run_snapshot(row_data jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE result jsonb; agent_snapshot jsonb; run_runtime text; input bigint; cached bigint;
BEGIN
  result := telemetry_pick(row_data, ARRAY['id','agent_id','task_id','status','created_at','dispatched_at',
    'completed_at','started_at','task_outcome','token_input','token_output','token_total',
    'effective_model','effective_thinking_level','effective_fast_mode','failure_class','failure_stage',
    'runtime_ended_at','runtime_end_success','runtime_end_source','lifecycle_outcome_posted_at',
    'runtime_completed_at','lifecycle_handoff_status','semantic_outcome_missing','token_usage_status']);
  result := result || jsonb_build_object('failure_reason', runs.run_failure_reason(row_data->>'status', row_data->>'error',
    row_data->>'runtime_end_error', row_data->>'lifecycle_handoff_status', row_data->>'runtime_end_source'));
  input := (row_data->>'token_input')::bigint;
  cached := (row_data->>'token_cached_input')::bigint;
  IF input IS NOT NULL OR cached IS NOT NULL THEN
    SELECT r.runtime_type INTO run_runtime FROM runtime_executions r
      WHERE r.tenant_id = (row_data->>'tenant_id')::bigint AND r.instance_id = (row_data->>'id')::bigint;
  END IF;
  result := result || jsonb_build_object(
    'tokens_cached_in', cached,
    'tokens_fresh_in', CASE WHEN input IS NULL THEN NULL
      WHEN run_runtime = 'codex' THEN GREATEST(input - COALESCE(cached, 0), 0) ELSE input END);
  SELECT jsonb_build_object('instructions_version',a.instructions_version,
    'instructions_fingerprint',md5(a.job_instructions),'runtime_type',a.runtime_type)
    INTO agent_snapshot FROM agents a
    WHERE a.id = (row_data->>'agent_id')::bigint AND a.tenant_id = (row_data->>'tenant_id')::bigint;
  RETURN result || jsonb_build_object('agent_config_at_observation',agent_snapshot);
END $$;
