-- Runtime lifecycle bookkeeping is tenant-owned data. The historical baseline omitted
-- tenant_id from task_events and integrity_events even though every row has a required task,
-- and it omitted the missing_lifecycle_handoff anomaly emitted by lifecycleHandoff.ts.

ALTER TABLE task_events
  ADD COLUMN IF NOT EXISTS tenant_id bigint;

ALTER TABLE integrity_events
  ADD COLUMN IF NOT EXISTS tenant_id bigint;

UPDATE task_events event
SET tenant_id = task.tenant_id
FROM tasks task
WHERE task.id = event.task_id
  AND event.tenant_id IS NULL;

UPDATE integrity_events event
SET tenant_id = task.tenant_id
FROM tasks task
WHERE task.id = event.task_id
  AND event.tenant_id IS NULL;

ALTER TABLE task_events
  ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE integrity_events
  ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE task_events
  DROP CONSTRAINT IF EXISTS fk_task_events_tenant;

ALTER TABLE task_events
  ADD CONSTRAINT fk_task_events_tenant
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE integrity_events
  DROP CONSTRAINT IF EXISTS fk_integrity_events_tenant;

ALTER TABLE integrity_events
  ADD CONSTRAINT fk_integrity_events_tenant
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE integrity_events
  DROP CONSTRAINT IF EXISTS integrity_events_anomaly_type_check;

ALTER TABLE integrity_events
  ADD CONSTRAINT integrity_events_anomaly_type_check CHECK (anomaly_type IN (
    'missing_review_evidence',
    'missing_qa_evidence',
    'commit_mismatch',
    'deployed_not_verified',
    'stale_outcome_write',
    'branch_missing_on_origin',
    'evidence_placeholder',
    'missing_lifecycle_handoff'
  ));

CREATE INDEX IF NOT EXISTS idx_task_events_tenant
  ON task_events(tenant_id);

CREATE INDEX IF NOT EXISTS idx_integrity_events_tenant
  ON integrity_events(tenant_id);
