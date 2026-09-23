-- Keep the provider's cancellation address separate from the logical session key.
SET LOCAL lock_timeout = '5s';
ALTER TABLE job_instances ADD COLUMN runtime_abort_target jsonb;
ALTER TABLE job_instances ADD COLUMN stop_requested_at text;
