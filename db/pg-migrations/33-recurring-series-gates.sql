-- A recurring search can require its run evidence without gating unrelated ops tasks.
ALTER TABLE workflow_task_transition_requirements
  ADD COLUMN recurring_series_id BIGINT REFERENCES recurring_task_series(id) ON DELETE CASCADE;
