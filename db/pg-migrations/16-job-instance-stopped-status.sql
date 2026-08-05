-- A stopped run is terminal and may be retained as such by transcript imports and
-- runtime adapters. The SQLite-era schema accepted this value, but the PostgreSQL
-- baseline's CHECK constraint omitted it.

BEGIN;

ALTER TABLE job_instances
  DROP CONSTRAINT IF EXISTS job_instances_status_check;

ALTER TABLE job_instances
  ADD CONSTRAINT job_instances_status_check
  CHECK (status IN ('queued', 'dispatched', 'running', 'done', 'failed', 'cancelled', 'stopped'));

COMMIT;
