-- agents.schedule held a per-agent cron expression for the retired generic
-- scheduled-agent runner. Recurring task series replaced that runner: the
-- scheduler module had become a no-op that only logged, and every agent write
-- path stored ''. Nothing reads the column. Production had no agent with a
-- non-empty value on 2026-11-05 (0 of 39). No trigger or view references it.
ALTER TABLE agents DROP COLUMN IF EXISTS schedule;
