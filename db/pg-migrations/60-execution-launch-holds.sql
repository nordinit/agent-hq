-- A launch Agent HQ refused because the agent may not run on this machine or its setup is not
-- approved. The check happens before a run exists, so without this row the refusal reached only
-- the API log. One row per task: its latest refusal. Dispatch deletes the row once the task's
-- launch checks pass, and the task page and board show it only while dispatch keeps refreshing it.
CREATE TABLE IF NOT EXISTS access.execution_launch_holds (
    task_id bigint PRIMARY KEY REFERENCES tasks.tasks(id) ON DELETE CASCADE,
    tenant_id bigint NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
    agent_id bigint NOT NULL REFERENCES agents.agents(id) ON DELETE CASCADE,
    resource_kind text NOT NULL CHECK (resource_kind IN ('agent_runtime', 'workflow_setup')),
    resource_id bigint NOT NULL,
    reason_code text NOT NULL,
    -- Plain-language reason shown on the task; detail is the refusal message itself.
    reason text NOT NULL,
    detail text NOT NULL,
    attempts integer NOT NULL DEFAULT 1,
    first_refused_at timestamptz NOT NULL DEFAULT now(),
    last_refused_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS execution_launch_holds_agent_idx
    ON access.execution_launch_holds (tenant_id, agent_id, last_refused_at DESC);
