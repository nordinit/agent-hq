-- Catalog identity follows canonical writes, including a remove/re-add between
-- catalog reads. Labels preserve identity; key/type lifecycle changes do not.
CREATE TABLE telemetry_field_generations (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  schema_id bigint NOT NULL,
  field_key text NOT NULL,
  field_type text NOT NULL,
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,schema_id,field_key)
);
CREATE INDEX telemetry_field_generations_current ON telemetry_field_generations(tenant_id,schema_id) WHERE active;

CREATE FUNCTION telemetry_sync_schema_generations(owner_tenant bigint,owner_schema bigint,raw_schema text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE field jsonb; fields jsonb; field_name text; field_kind text; seen text[] := ARRAY[]::text[];
BEGIN
  IF owner_tenant IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('telemetry:catalog:'||owner_tenant,0));
  fields := CASE WHEN jsonb_typeof(telemetry_json(raw_schema)->'fields')='array'
    THEN telemetry_json(raw_schema)->'fields' ELSE '[]'::jsonb END;
  FOR field IN SELECT value FROM jsonb_array_elements(fields) LOOP
    field_name := field->>'key'; field_kind := COALESCE(field->>'type','text');
    IF field_name IS NULL OR field_name='' OR NOT field_kind IN ('text','textarea','url','select','number','checkbox') THEN CONTINUE; END IF;
    seen := array_append(seen,field_name);
    INSERT INTO telemetry_field_generations(tenant_id,schema_id,field_key,field_type)
    VALUES(owner_tenant,owner_schema,field_name,field_kind)
    ON CONFLICT(tenant_id,schema_id,field_key) DO UPDATE SET
      generation=CASE WHEN telemetry_field_generations.active AND telemetry_field_generations.field_type=EXCLUDED.field_type
        THEN telemetry_field_generations.generation ELSE gen_random_uuid() END,
      field_type=EXCLUDED.field_type,active=true,updated_at=clock_timestamp();
  END LOOP;
  UPDATE telemetry_field_generations SET active=false,updated_at=clock_timestamp()
    WHERE tenant_id=owner_tenant AND schema_id=owner_schema AND active AND NOT field_key=ANY(seen);
  UPDATE telemetry_catalog_entries entry SET retired_at=clock_timestamp()
    WHERE entry.tenant_id=owner_tenant AND entry.retired_at IS NULL
      AND entry.descriptor->'source'->>'schema_id'=owner_schema::text
      AND NOT EXISTS(SELECT 1 FROM telemetry_field_generations generation
        WHERE generation.tenant_id=owner_tenant AND generation.schema_id=owner_schema
          AND generation.field_key=entry.descriptor->'source'->>'field_key' AND generation.active
          AND generation.generation::text=entry.descriptor->'source'->>'generation');
END $$;

CREATE FUNCTION telemetry_track_schema_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM telemetry_sync_schema_generations(OLD.tenant_id,OLD.id,'{"fields":[]}');
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    PERFORM telemetry_sync_schema_generations(OLD.tenant_id,OLD.id,'{"fields":[]}');
  END IF;
  PERFORM telemetry_sync_schema_generations(NEW.tenant_id,NEW.id,NEW.schema_json);
  RETURN NEW;
END $$;
CREATE TRIGGER telemetry_schema_generation BEFORE INSERT OR UPDATE OR DELETE ON task_field_schemas
  FOR EACH ROW EXECUTE FUNCTION telemetry_track_schema_generation();

-- Pre-generation identities cannot certify an unobserved prior remove/re-add.
-- Their immutable descriptors remain available for their older captured facts.
SELECT telemetry_sync_schema_generations(tenant_id,id,schema_json) FROM task_field_schemas;

-- Keep the existing bounded field extraction and enrich its descriptors with the
-- canonical generation recorded in the same transaction as the schema/task write.
ALTER FUNCTION telemetry_task_snapshot(jsonb) RENAME TO telemetry_task_snapshot_without_generations;
CREATE FUNCTION telemetry_task_snapshot(row_data jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE snapshot jsonb; descriptors jsonb;
BEGIN
  snapshot := telemetry_task_snapshot_without_generations(row_data);
  SELECT COALESCE(jsonb_agg(field.value || CASE WHEN generation.generation IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('generation',generation.generation::text) END),'[]'::jsonb)
    INTO descriptors
    FROM jsonb_array_elements(snapshot->'field_descriptors') field
    LEFT JOIN telemetry_field_generations generation ON generation.tenant_id=(row_data->>'tenant_id')::bigint
      AND generation.schema_id=(field.value->>'schema_id')::bigint AND generation.field_key=field.value->>'key'
      AND generation.field_type=field.value->>'type' AND generation.active;
  RETURN jsonb_set(snapshot,'{field_descriptors}',descriptors);
END $$;
