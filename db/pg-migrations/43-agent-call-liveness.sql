-- Deliberately do not backfill from runtime telemetry: only inbound agent calls
-- may write these timestamps. Legacy active runs retain their startup baseline.
ALTER TABLE job_instances ADD COLUMN first_agent_call_at TEXT;
ALTER TABLE job_instances ADD COLUMN last_agent_call_at TEXT;
