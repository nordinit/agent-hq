-- Current inventories often need outcome evidence, not entire historical task
-- snapshots. Store a lossless projection for that expression subset at capture
-- time, so reads never have to detoast every unrelated snapshot.
CREATE FUNCTION telemetry_outcome_evidence(data jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT telemetry_pick(data, ARRAY['supersedes_source_key']) || jsonb_build_object(
    'before', telemetry_pick(CASE WHEN jsonb_typeof(data->'before')='object' THEN data->'before' ELSE '{}'::jsonb END, ARRAY['project_id','outcome','outcome_identity']),
    'after', telemetry_pick(CASE WHEN jsonb_typeof(data->'after')='object' THEN data->'after' ELSE '{}'::jsonb END, ARRAY['project_id','outcome','outcome_identity']),
    'context', telemetry_pick(CASE WHEN jsonb_typeof(data->'context')='object' THEN data->'context' ELSE '{}'::jsonb END, ARRAY['project_id','outcome','outcome_identity'])
  )
$$;

-- Nullable during upgrade: the reader computes the identical projection for
-- old rows until the bounded backfill finishes. Adding this column needs no
-- table rewrite, and old API releases can keep inserting observations.
ALTER TABLE telemetry_observations ADD COLUMN outcome_evidence jsonb;
CREATE FUNCTION telemetry_capture_outcome_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.outcome_evidence := telemetry_outcome_evidence(NEW.payload);
  RETURN NEW;
END $$;
CREATE TRIGGER telemetry_observation_outcome_evidence
BEFORE INSERT OR UPDATE OF payload ON telemetry_observations
FOR EACH ROW EXECUTE FUNCTION telemetry_capture_outcome_evidence();
