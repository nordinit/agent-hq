-- runtime_failed is built into Agent HQ. A run that dies always posts it, and it routes like every
-- other outcome: a runtime_failed transition from the task's status moves the task, and with none the
-- task stays where it is and is dispatched again. The workflow event mappings that used to decide what
-- a dead run does (event runtime_failed, or any mapping that posted the outcome) are no longer read,
-- so remove them rather than leave configuration that looks live and does nothing.
DELETE FROM external_event_mappings
WHERE (source = 'agent_hq_runtime' AND event_name = 'runtime_failed')
   OR (action_kind = 'outcome' AND action_target = 'runtime_failed');
