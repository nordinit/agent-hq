-- Removes tables that do not fit the data model.
--
-- 1. Legacy tables with no writer and no reader.
--    dev_db_sync_audit        never written; empty in production.
--    telemetry_schema_config  the retired v1 telemetry singleton, unreachable since its API returned 410.
--    task_creation_events     written only by the removed task creation-event endpoints.
DROP TABLE dev_db_sync_audit;
DROP TABLE telemetry_schema_config;
DROP TABLE task_creation_events;

-- 2. The OpenClaw transcript read position belongs to the run. It moves onto the run's
--    instance_artifacts row, which already holds the liveness timestamps the same ingest pass
--    derives, so the duplicate heartbeat and meaningful-output copies are not carried over.
--    A run without an artifacts row re-reads its transcript from line 0 if it is ever polled
--    again; that is safe because ingested events upsert by deterministic id.
ALTER TABLE instance_artifacts ADD COLUMN transcript_cursor JSONB;
ALTER TABLE instance_artifacts ADD CONSTRAINT ck_instance_artifacts_transcript_cursor_object
  CHECK (transcript_cursor IS NULL OR jsonb_typeof(transcript_cursor) = 'object');

UPDATE instance_artifacts ia
   SET transcript_cursor = jsonb_build_object(
         'session_file', s.session_file,
         'line_index', s.last_line_index,
         'last_event_at', s.last_event_at)
  FROM openclaw_transcript_ingest_state s
 WHERE s.instance_id = ia.instance_id;

DROP TABLE openclaw_transcript_ingest_state;

-- 3. The MCP sync tables describe an agent's MCP configuration reaching its runtime, so they
--    are named for the agent they configure. Only OpenClaw agents are enqueued today, which the
--    enqueue_openclaw_mcp_sync_* function names keep saying.
ALTER TABLE openclaw_mcp_sync_queue RENAME TO agent_mcp_sync_queue;
ALTER TABLE agent_mcp_sync_queue RENAME CONSTRAINT openclaw_mcp_sync_queue_pkey TO agent_mcp_sync_queue_pkey;
ALTER TABLE agent_mcp_sync_queue RENAME CONSTRAINT openclaw_mcp_sync_queue_agent_id_fkey TO agent_mcp_sync_queue_agent_id_fkey;

ALTER TABLE openclaw_mcp_reconciliation RENAME TO agent_mcp_reconciliation;
ALTER TABLE agent_mcp_reconciliation RENAME CONSTRAINT openclaw_mcp_reconciliation_pkey TO agent_mcp_reconciliation_pkey;
ALTER TABLE agent_mcp_reconciliation RENAME CONSTRAINT openclaw_mcp_reconciliation_agent_id_fkey TO agent_mcp_reconciliation_agent_id_fkey;
ALTER TABLE agent_mcp_reconciliation RENAME CONSTRAINT openclaw_mcp_reconciliation_state_check TO agent_mcp_reconciliation_state_check;
ALTER TABLE agent_mcp_reconciliation RENAME CONSTRAINT openclaw_mcp_reconciliation_operation_phase_check TO agent_mcp_reconciliation_operation_phase_check;

ALTER TABLE openclaw_mcp_recovery RENAME TO agent_mcp_recovery;
ALTER SEQUENCE openclaw_mcp_recovery_id_seq RENAME TO agent_mcp_recovery_id_seq;
ALTER INDEX openclaw_mcp_recovery_active RENAME TO agent_mcp_recovery_active;
ALTER TABLE agent_mcp_recovery RENAME CONSTRAINT openclaw_mcp_recovery_pkey TO agent_mcp_recovery_pkey;
ALTER TABLE agent_mcp_recovery RENAME CONSTRAINT openclaw_mcp_recovery_agent_id_fkey TO agent_mcp_recovery_agent_id_fkey;
ALTER TABLE agent_mcp_recovery RENAME CONSTRAINT openclaw_mcp_recovery_state_check TO agent_mcp_recovery_state_check;
ALTER TABLE agent_mcp_recovery RENAME CONSTRAINT openclaw_mcp_recovery_escalation_notification_id_fkey TO agent_mcp_recovery_escalation_notification_id_fkey;
ALTER TABLE agent_mcp_recovery RENAME CONSTRAINT openclaw_mcp_recovery_resolution_notification_id_fkey TO agent_mcp_recovery_resolution_notification_id_fkey;

ALTER TABLE openclaw_mcp_recovery_tasks RENAME TO agent_mcp_recovery_tasks;
ALTER TABLE agent_mcp_recovery_tasks RENAME CONSTRAINT openclaw_mcp_recovery_tasks_pkey TO agent_mcp_recovery_tasks_pkey;
ALTER TABLE agent_mcp_recovery_tasks RENAME CONSTRAINT openclaw_mcp_recovery_tasks_recovery_id_fkey TO agent_mcp_recovery_tasks_recovery_id_fkey;
ALTER TABLE agent_mcp_recovery_tasks RENAME CONSTRAINT openclaw_mcp_recovery_tasks_task_id_fkey TO agent_mcp_recovery_tasks_task_id_fkey;

-- Function bodies name tables as text, so a rename does not reach them. This is the only
-- function that writes the queue directly; the trigger functions all call it.
CREATE OR REPLACE FUNCTION enqueue_openclaw_mcp_sync_agents(agent_ids BIGINT[]) RETURNS void LANGUAGE sql AS $$
  INSERT INTO agent_mcp_sync_queue (agent_id)
    SELECT id FROM agents WHERE id = ANY(agent_ids) AND runtime_type = 'openclaw' AND deleted_at IS NULL
  ON CONFLICT (agent_id) DO UPDATE SET revision = agent_mcp_sync_queue.revision + 1,
    attempts = 0, retry_at = now(), error = NULL;
$$;

-- Fail the migration rather than leave a function pointing at a table that no longer exists.
DO $$
DECLARE stale TEXT;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO stale
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.prosrc ~ '\m(openclaw_mcp_(sync_queue|reconciliation|recovery|recovery_tasks)|openclaw_transcript_ingest_state|dev_db_sync_audit|telemetry_schema_config|task_creation_events)\M';
  IF stale IS NOT NULL THEN
    RAISE EXCEPTION 'functions still reference retired tables: %', stale;
  END IF;
END $$;
