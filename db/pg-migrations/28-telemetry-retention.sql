-- Retention is a monotonic evidence boundary: extending a policy cannot recreate
-- observations already discarded. Frozen query artifacts have their own TTL.
CREATE TABLE telemetry_retention_state (
  tenant_id bigint PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  retained_from timestamptz NOT NULL,
  last_swept_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX telemetry_retention_sweep ON telemetry_retention_state(last_swept_at);
CREATE INDEX telemetry_observations_retention ON telemetry_observations(tenant_id,occurred_at,id);
CREATE INDEX telemetry_outbox_retention ON telemetry_outbox(tenant_id,occurred_at,id);

-- A correction can move a fact outside retention. Discard its superseded
-- ancestors too, so removing the correction cannot resurrect an incorrect fact.
CREATE FUNCTION telemetry_discarded_ancestry(owner_tenant bigint,root_keys text[]) RETURNS text[]
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE discarded(source_key) AS (
    SELECT unnest(root_keys)
    UNION
    SELECT COALESCE(o.payload->>'supersedes_source_key',r.payload->>'supersedes_source_key')
    FROM discarded d LEFT JOIN telemetry_outbox o ON o.tenant_id=owner_tenant AND o.source_key=d.source_key
    LEFT JOIN telemetry_observations r ON r.tenant_id=owner_tenant AND r.source_key=d.source_key
    WHERE COALESCE(o.payload->>'supersedes_source_key',r.payload->>'supersedes_source_key') IS NOT NULL
  ) SELECT COALESCE(array_agg(source_key),ARRAY[]::text[]) FROM discarded
$$;
