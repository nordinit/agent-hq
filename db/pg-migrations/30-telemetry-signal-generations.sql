-- Canonical signal identities survive label edits, never key reuse. Global
-- statuses have no tenant owner; scoped signals retain their real source owner.
CREATE TABLE telemetry_signal_generations (
  generation uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_table text NOT NULL,
  source_id text NOT NULL,
  tenant_id bigint REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('status','outcome')),
  signal_key text NOT NULL,
  source_scope jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz
);
CREATE UNIQUE INDEX telemetry_signal_current ON telemetry_signal_generations(source_table,source_id) WHERE active;
CREATE INDEX telemetry_signal_owner ON telemetry_signal_generations(tenant_id,kind,signal_key) WHERE active;

CREATE FUNCTION telemetry_sync_signal_generation(source_name text,row_data jsonb,is_deleted boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE source_key text; owner_tenant bigint; signal_kind text; signal_name text; identity_scope jsonb;
  previous telemetry_signal_generations%ROWTYPE; is_enabled boolean := true;
BEGIN
  signal_kind:=CASE WHEN source_name='sprint_type_outcomes' THEN 'outcome' ELSE 'status' END;
  source_key:=CASE WHEN source_name='task_statuses' THEN row_data->>'name' ELSE row_data->>'id' END;
  signal_name:=COALESCE(row_data->>'status_key',row_data->>'outcome_key',row_data->>'name');
  owner_tenant:=(row_data->>'tenant_id')::bigint;
  IF source_name='sprint_task_statuses' THEN SELECT tenant_id INTO owner_tenant FROM sprints WHERE id=(row_data->>'sprint_id')::bigint; END IF;
  identity_scope:=telemetry_pick(row_data,ARRAY['tenant_id','sprint_id','sprint_type_key','task_type']);
  is_enabled:=NOT is_deleted AND COALESCE(row_data->>'enabled','1')<>'0' AND COALESCE(row_data->>'behavior','')<>'disable';
  -- One global lock orders global and tenant signal writes with catalog reads.
  PERFORM pg_advisory_xact_lock(hashtextextended('telemetry:signals',0));
  SELECT * INTO previous FROM telemetry_signal_generations WHERE source_table=source_name AND source_id=source_key AND active FOR UPDATE;
  IF previous.generation IS NOT NULL AND (NOT is_enabled OR previous.signal_key<>signal_name
    OR previous.tenant_id IS DISTINCT FROM owner_tenant OR previous.source_scope<>identity_scope) THEN
    UPDATE telemetry_signal_generations SET active=false,retired_at=clock_timestamp() WHERE generation=previous.generation;
    UPDATE telemetry_catalog_entries entry SET retired_at=clock_timestamp()
      WHERE entry.retired_at IS NULL AND entry.source_key='signal:'||previous.generation::text;
    previous.generation:=NULL;
  END IF;
  IF is_enabled AND previous.generation IS NULL THEN
    INSERT INTO telemetry_signal_generations(source_table,source_id,tenant_id,kind,signal_key,source_scope)
      VALUES(source_name,source_key,owner_tenant,signal_kind,signal_name,identity_scope);
  END IF;
END $$;

CREATE FUNCTION telemetry_track_signal_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN PERFORM telemetry_sync_signal_generation(TG_TABLE_NAME,to_jsonb(OLD),true);RETURN OLD; END IF;
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='task_statuses' AND to_jsonb(OLD)->>'name' IS DISTINCT FROM to_jsonb(NEW)->>'name' THEN
    PERFORM telemetry_sync_signal_generation(TG_TABLE_NAME,to_jsonb(OLD),true);
  END IF;
  PERFORM telemetry_sync_signal_generation(TG_TABLE_NAME,to_jsonb(NEW));RETURN NEW;
END $$;
CREATE TRIGGER telemetry_signal_generation BEFORE INSERT OR UPDATE OR DELETE ON task_statuses FOR EACH ROW EXECUTE FUNCTION telemetry_track_signal_generation();
CREATE TRIGGER telemetry_signal_generation BEFORE INSERT OR UPDATE OR DELETE ON sprint_type_task_statuses FOR EACH ROW EXECUTE FUNCTION telemetry_track_signal_generation();
CREATE TRIGGER telemetry_signal_generation BEFORE INSERT OR UPDATE OR DELETE ON sprint_task_statuses FOR EACH ROW EXECUTE FUNCTION telemetry_track_signal_generation();
CREATE TRIGGER telemetry_signal_generation BEFORE INSERT OR UPDATE OR DELETE ON sprint_type_outcomes FOR EACH ROW EXECUTE FUNCTION telemetry_track_signal_generation();
SELECT telemetry_sync_signal_generation('task_statuses',to_jsonb(s)) FROM task_statuses s;
SELECT telemetry_sync_signal_generation('sprint_type_task_statuses',to_jsonb(s)) FROM sprint_type_task_statuses s;
SELECT telemetry_sync_signal_generation('sprint_task_statuses',to_jsonb(s)) FROM sprint_task_statuses s;
SELECT telemetry_sync_signal_generation('sprint_type_outcomes',to_jsonb(s)) FROM sprint_type_outcomes s;

CREATE FUNCTION telemetry_signal_identity(task_data jsonb,signal_kind text,signal_name text) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE owner_tenant bigint:=(task_data->>'tenant_id')::bigint; workflow bigint:=(task_data->>'sprint_id')::bigint;
  workflow_type text; selected_table text; selected_id text; identity text;
BEGIN
  IF signal_name IS NULL THEN RETURN NULL; END IF;
  SELECT sprint_type INTO workflow_type FROM sprints WHERE id=workflow AND tenant_id=owner_tenant;
  IF signal_kind='status' THEN
    SELECT 'sprint_task_statuses',id::text INTO selected_table,selected_id FROM sprint_task_statuses WHERE sprint_id=workflow AND status_key=signal_name ORDER BY id DESC LIMIT 1;
    IF selected_id IS NULL THEN
      SELECT 'sprint_type_task_statuses',id::text INTO selected_table,selected_id FROM sprint_type_task_statuses
        WHERE tenant_id=owner_tenant AND sprint_type_key=workflow_type AND status_key=signal_name ORDER BY id DESC LIMIT 1;
    END IF;
    IF selected_id IS NULL THEN SELECT 'task_statuses',name INTO selected_table,selected_id FROM task_statuses WHERE name=signal_name; END IF;
  ELSE
    SELECT 'sprint_type_outcomes',id::text INTO selected_table,selected_id FROM sprint_type_outcomes
      WHERE tenant_id=owner_tenant AND sprint_type_key=workflow_type AND outcome_key=signal_name
        AND (task_type IS NULL OR task_type='' OR task_type=task_data->>'task_type')
      ORDER BY CASE WHEN task_type=task_data->>'task_type' THEN 0 ELSE 1 END,id DESC LIMIT 1;
  END IF;
  IF selected_id IS NULL THEN RETURN 'unregistered:'||signal_kind||':'||signal_name; END IF;
  SELECT generation::text INTO identity FROM telemetry_signal_generations WHERE source_table=selected_table AND source_id=selected_id AND active
    AND EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname=selected_table
      AND t.tgname='telemetry_signal_generation' AND t.tgenabled IN ('O','A'));
  -- A disabled or missing producer is unknown, not an unregistered raw key.
  RETURN identity;
END $$;

ALTER FUNCTION telemetry_task_snapshot(jsonb) RENAME TO telemetry_task_snapshot_without_signal_identities;
ALTER TABLE tasks ADD COLUMN telemetry_status_identity text;
CREATE FUNCTION telemetry_track_task_status_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' OR OLD.telemetry_status_identity IS NULL OR OLD.status IS DISTINCT FROM NEW.status
    OR OLD.sprint_id IS DISTINCT FROM NEW.sprint_id OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    NEW.telemetry_status_identity:=telemetry_signal_identity(to_jsonb(NEW),'status',NEW.status);
  ELSE NEW.telemetry_status_identity:=OLD.telemetry_status_identity; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER telemetry_task_status_identity BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION telemetry_track_task_status_identity();
CREATE FUNCTION telemetry_task_snapshot(row_data jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT telemetry_task_snapshot_without_signal_identities(row_data) || jsonb_build_object('status_identity',
    CASE WHEN EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='telemetry_task_status_identity' AND tgenabled IN ('O','A'))
      AND ((row_data->>'telemetry_status_identity')='unregistered:status:'||(row_data->>'status')
        OR EXISTS(SELECT 1 FROM telemetry_signal_generations WHERE generation::text=row_data->>'telemetry_status_identity'
          AND kind='status' AND signal_key=row_data->>'status')) THEN row_data->>'telemetry_status_identity' ELSE NULL END)
$$;
-- Existing task state is bootstrapped now. The capture trigger records this
-- identity-only change without fabricating a status-entry transition.
UPDATE tasks SET telemetry_status_identity=telemetry_signal_identity(to_jsonb(tasks),'status',status);

-- Enrich the bounded outbox payload in the same canonical transaction, without
-- rewriting the existing capture function or importing old signal identities.
CREATE FUNCTION telemetry_capture_outcome_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE task_data jsonb; identity text; previous jsonb;
BEGIN
  IF NEW.kind='task.outcome' AND NEW.provenance='observed' THEN
    SELECT to_jsonb(t) INTO task_data FROM tasks t WHERE tenant_id=NEW.tenant_id AND id=NEW.task_id;
    IF NEW.payload->>'supersedes_source_key' IS NOT NULL THEN
      SELECT payload INTO previous FROM telemetry_outbox WHERE tenant_id=NEW.tenant_id AND source_key=NEW.payload->>'supersedes_source_key';
      IF previous->'after'->'outcome'=NEW.payload->'after'->'outcome' THEN identity:=previous->'after'->>'outcome_identity';
      ELSE
        SELECT generation::text INTO identity FROM telemetry_signal_generations
          WHERE tenant_id=NEW.tenant_id AND kind='outcome' AND signal_key=NEW.payload->'after'->>'outcome'
            AND source_scope->>'sprint_type_key'=NEW.payload->'context'->>'workflow_type'
            AND (COALESCE(source_scope->>'task_type','')='' OR source_scope->>'task_type'=NEW.payload->'context'->>'task_type')
            AND created_at<=NEW.occurred_at AND (retired_at IS NULL OR retired_at>NEW.occurred_at)
          ORDER BY CASE WHEN source_scope->>'task_type'=NEW.payload->'context'->>'task_type' THEN 0 ELSE 1 END,created_at DESC LIMIT 1;
      END IF;
    ELSE identity:=telemetry_signal_identity(task_data,'outcome',NEW.payload->'after'->>'outcome'); END IF;
    NEW.payload:=jsonb_set(NEW.payload,'{after,outcome_identity}',COALESCE(to_jsonb(identity),'null'::jsonb));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER telemetry_outcome_identity BEFORE INSERT ON telemetry_outbox FOR EACH ROW EXECUTE FUNCTION telemetry_capture_outcome_identity();
INSERT INTO telemetry_capture_sources(source,capture_started_at,limitations) VALUES('telemetry_signals',clock_timestamp(),'Status/outcome identities before this boundary are unknown.');
