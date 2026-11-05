-- Keep same agent. When a workflow type turns this on, a task coming back to a status it has been
-- worked in before can only be dispatched to the agent that worked it there, instead of whichever
-- eligible agent is free first. Off keeps the first-free-agent behaviour.
ALTER TABLE workflow_types ADD COLUMN keep_same_agent bigint NOT NULL DEFAULT 0;

-- The agent that owns each status of each task, recorded whether or not the setting is on so that
-- turning it on later already knows who worked what. Two writers:
--   dispatch: the agent a run is dispatched to owns the status the run was dispatched for;
--   run:      when the task changes status while that run is still going (the start callback moving
--             it into a working status), the run's agent owns the new status too.
-- An outcome ends its run, so it never makes anyone an owner.
-- No backfill: a historical run does not record which status it was dispatched for.
CREATE TABLE task_status_owners (
  task_id bigint NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  status text NOT NULL,
  agent_id bigint NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  instance_id bigint REFERENCES job_instances (id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('dispatch', 'run')),
  tenant_id bigint,
  created_at text NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at text NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (task_id, status)
);

CREATE INDEX idx_task_status_owners_agent ON task_status_owners (agent_id);
