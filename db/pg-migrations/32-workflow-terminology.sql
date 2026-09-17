-- One-way vocabulary migration. Earlier files and recorded events retain their
-- original provenance; canonical tables, columns and producers use workflow.
-- The runner applies this file and its ledger row in one transaction.

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE '%sprint%' ORDER BY c.relname
  LOOP EXECUTE format('ALTER TABLE %I RENAME TO %I',r.relname,replace(r.relname,'sprint','workflow')); END LOOP;
  FOR r IN SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name LIKE '%sprint%' ORDER BY table_name,column_name
  LOOP EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I',r.table_name,r.column_name,replace(r.column_name,'sprint','workflow')); END LOOP;
  -- Renaming a constraint also renames its backing index.
  FOR r IN SELECT conrelid::regclass AS tbl,conname FROM pg_constraint
    WHERE connamespace='public'::regnamespace AND conname LIKE '%sprint%' ORDER BY conname
  LOOP EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I',r.tbl,r.conname,replace(r.conname,'sprint','workflow')); END LOOP;
  FOR r IN SELECT relname,relkind FROM pg_class WHERE relnamespace='public'::regnamespace
    AND relkind IN ('i','S') AND relname LIKE '%sprint%' ORDER BY relname
  LOOP EXECUTE format('ALTER %s %I RENAME TO %I',CASE r.relkind WHEN 'i' THEN 'INDEX' ELSE 'SEQUENCE' END,r.relname,replace(r.relname,'sprint','workflow')); END LOOP;
  -- PostgreSQL does not rewrite names embedded in SQL/PLpgSQL function bodies.
  -- CREATE OR REPLACE preserves function OIDs and every trigger's attachment.
  FOR r IN SELECT proname,pg_get_functiondef(oid) AS body FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND prokind='f' AND prosrc LIKE '%sprint%'
  LOOP
    -- This pre-existing local variable would collide with the renamed column.
    IF r.proname='telemetry_signal_identity' THEN r.body:=replace(r.body,'workflow_type','selected_workflow_type'); END IF;
    EXECUTE replace(r.body,'sprint','workflow');
  END LOOP;
END $$;

ALTER TABLE project_audit_log DROP CONSTRAINT project_audit_log_entity_type_check;
UPDATE project_audit_log SET entity_type='workflow' WHERE entity_type='sprint';
ALTER TABLE project_audit_log ADD CONSTRAINT project_audit_log_entity_type_check
  CHECK(entity_type IN ('project','workflow','job_template'));

-- Only top-level machine keys are renamed. Titles, labels, custom fields,
-- regex patterns and other user-authored strings are deliberately untouched.
CREATE FUNCTION pg_temp.workflow_keys(value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(value)='object' THEN
    (SELECT COALESCE(jsonb_object_agg(CASE WHEN key IN ('sprint_id','sprint_type','sprint_type_key','sprintId','sprintType')
      THEN replace(replace(key,'sprint','workflow'),'Sprint','Workflow') ELSE key END,item),'{}'::jsonb)
      FROM jsonb_each(value) AS entry(key,item)) ELSE value END
$$;

-- Keep generation UUIDs, activity flags and ownership intact. Otherwise the next
-- catalog read would retire every signal and create unrelated identities.
UPDATE telemetry_signal_generations SET source_table=replace(source_table,'sprint','workflow'),
  source_scope=pg_temp.workflow_keys(source_scope)
  WHERE source_table LIKE '%sprint%' OR source_scope ?| ARRAY['sprint_id','sprint_type','sprint_type_key'];

-- The coverage FK has no ON UPDATE CASCADE. Copy parents before moving children;
-- carry the original capture boundaries and cursors forward unchanged.
INSERT INTO telemetry_capture_sources(source,capture_started_at,producer_version,history_complete,limitations)
  SELECT replace(source,'sprint','workflow'),capture_started_at,producer_version,history_complete,limitations
  FROM telemetry_capture_sources WHERE source LIKE '%sprint%';
UPDATE telemetry_source_coverage SET source=replace(source,'sprint','workflow') WHERE source LIKE '%sprint%';
DELETE FROM telemetry_capture_sources WHERE source LIKE '%sprint%';
UPDATE telemetry_outbox SET source=replace(source,'sprint','workflow') WHERE source LIKE '%sprint%';
UPDATE telemetry_observations SET source=replace(source,'sprint','workflow') WHERE source LIKE '%sprint%';
-- source_key, payloads and retained proofs are immutable event provenance, not
-- SQL table lookups. Keeping them preserves dedupe and supersession links.

-- Reclassify historical audit rows without emitting fabricated config changes.
DO $$
DECLARE mode char;
BEGIN
  SELECT tgenabled INTO mode FROM pg_trigger WHERE tgrelid='routing_config_audit_log'::regclass AND tgname='telemetry_capture';
  ALTER TABLE routing_config_audit_log DISABLE TRIGGER telemetry_capture;
  UPDATE routing_config_audit_log SET entity_table=replace(entity_table,'sprint','workflow') WHERE entity_table LIKE '%sprint%';
  IF mode='O' THEN ALTER TABLE routing_config_audit_log ENABLE TRIGGER telemetry_capture;
  ELSIF mode='A' THEN ALTER TABLE routing_config_audit_log ENABLE ALWAYS TRIGGER telemetry_capture;
  ELSIF mode='R' THEN ALTER TABLE routing_config_audit_log ENABLE REPLICA TRIGGER telemetry_capture;
  END IF;
END $$;

-- Capability names are machine-owned. Retain the exact existing grants.
UPDATE agent_mcp_capability_policies SET capability_key=replace(capability_key,'sprint','workflow')
  WHERE capability_key LIKE '%sprint%';

-- Installed agent policies also embed capability names in runtime configuration.
UPDATE agents SET runtime_config=regexp_replace(runtime_config,'sprints\.([a-z_]+)_sprint','workflows.\1_workflow','g')
  WHERE runtime_config ~ 'sprints\.([a-z_]+)_sprint';

-- Installed instructions and skill packages are executable guidance for API
-- clients. Update their vocabulary too, without rewriting task or chat content.
CREATE FUNCTION pg_temp.workflow_instructions(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(value,
    'Agent HQ is in a sprint-to-workflow compatibility window\.[^\n]+',
    'Agent HQ uses workflow terminology throughout the API, MCP tools, database, and UI. Use workflow_id and workflow_type when selecting a workflow scope.','g'),'SPRINT','WORKFLOW','g'),'Sprint','Workflow','g'),'sprint(?!f)','workflow','g')
$$;
UPDATE agents SET job_instructions=pg_temp.workflow_instructions(job_instructions),
  instructions_version=COALESCE(instructions_version,0)+1,
  job_instructions_updated_at=to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD HH24:MI:SS')
  WHERE job_instructions ~* 'sprint(?!f)';
UPDATE skills SET content=pg_temp.workflow_instructions(content),updated_at=to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD HH24:MI:SS')
  WHERE content ~* 'sprint(?!f)';
UPDATE skill_files SET path=pg_temp.workflow_instructions(path),content=pg_temp.workflow_instructions(content),
  updated_at=to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD HH24:MI:SS')
  WHERE content ~* 'sprint(?!f)' OR path ~* 'sprint(?!f)';
