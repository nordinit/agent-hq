-- integrity_events recorded handoff and evidence anomalies (missing lifecycle handoff, stale
-- outcome writes, missing QA evidence). Its only reader was the v1 telemetry API, which has been
-- removed, and no row was ever resolved. Missing handoffs are measured by the telemetry engine's
-- core.missing_handoffs.v1 metric from the same runtime signal; the other checks were rare or
-- belonged to evidence rules now expressed as workflow gates. The application no longer writes
-- the table. Dropping it removes its indexes and its foreign keys to tasks, agents, projects,
-- job_instances and tenants; nothing references it.
DROP TABLE integrity_events;
