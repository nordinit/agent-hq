-- Dashboard documents share immutable revision storage, but are never executed
-- as telemetry reports. Their block tree references independently pinned metrics.
ALTER TABLE telemetry_definitions DROP CONSTRAINT telemetry_definitions_kind_check;
ALTER TABLE telemetry_definitions ADD CONSTRAINT telemetry_definitions_kind_check
  CHECK (kind IN ('metric', 'profile', 'report', 'dashboard'));
