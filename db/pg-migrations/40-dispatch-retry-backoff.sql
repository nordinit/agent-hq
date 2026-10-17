-- Startup failures now retry indefinitely with an increasing wait capped at ten
-- minutes. Release only pauses created by the old dispatch retry limit. Preserve
-- operator pauses, workflow statuses, retry counts, and the last failure time.
WITH prior AS MATERIALIZED (
  SELECT id, tenant_id, paused_at, pause_reason
  FROM tasks
  WHERE paused_at IS NOT NULL
    AND active_instance_id IS NULL
    AND pause_reason LIKE 'Dispatch startup retry limit reached (%'
), recovered AS (
  UPDATE tasks t
  SET paused_at = NULL, pause_reason = NULL,
      updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
  FROM prior
  WHERE t.id = prior.id
  RETURNING t.id, t.tenant_id, prior.paused_at, prior.pause_reason
), history AS (
  INSERT INTO task_history (task_id, tenant_id, changed_by, field, old_value, new_value)
  SELECT r.id, r.tenant_id, 'migration:40-dispatch-retry-backoff', v.field, v.old_value, NULL
  FROM recovered r
  CROSS JOIN LATERAL (VALUES
    ('paused_at', r.paused_at),
    ('pause_reason', r.pause_reason)
  ) v(field, old_value)
  RETURNING task_id
)
INSERT INTO task_notes (task_id, tenant_id, author, content)
SELECT id, tenant_id, 'Agent HQ',
  'Removed the former startup retry-limit pause. Automatic startup retries now use increasing waits capped at ten minutes, with no attempt limit. Existing workflow routing and operator pauses still govern dispatch.'
FROM recovered;
