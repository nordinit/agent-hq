ALTER TABLE runs.job_instances
  ADD COLUMN IF NOT EXISTS token_usage_status text CHECK (token_usage_status IN ('recorded', 'partial', 'unavailable')),
  ADD COLUMN IF NOT EXISTS token_usage_reason text,
  ADD COLUMN IF NOT EXISTS token_cached_input bigint;
