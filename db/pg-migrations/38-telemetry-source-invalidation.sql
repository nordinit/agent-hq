-- Source membership belongs to a retained calculation, including excluded proof
-- rows. Access/deletion revocation is independent of live metric membership.
ALTER TABLE telemetry_query_results ADD COLUMN sources_complete boolean NOT NULL DEFAULT false;
ALTER TABLE telemetry_query_results ADD COLUMN source_count integer NOT NULL DEFAULT 0;
CREATE TABLE telemetry_query_sources (
  tenant_id bigint NOT NULL,
  query_id text NOT NULL,
  source_type text NOT NULL,
  source_id bigint NOT NULL,
  project_id bigint,
  PRIMARY KEY (query_id,source_type,source_id),
  FOREIGN KEY (tenant_id,query_id) REFERENCES telemetry_query_results(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX telemetry_query_sources_identity ON telemetry_query_sources(tenant_id,source_type,source_id);

-- Match the canonical access path used by loadMetricData: a run belongs to its
-- task's project, or its agent's project when it has no task.
CREATE VIEW telemetry_source_context AS
  SELECT 'tasks'::text AS source_type,t.id AS source_id,t.tenant_id,t.project_id,
    'workflows'::text AS parent_type,t.workflow_id AS parent_id FROM tasks t
  UNION ALL SELECT 'workflows',w.id,w.tenant_id,w.project_id,'projects',w.project_id FROM workflows w
  UNION ALL SELECT 'projects',p.id,p.tenant_id,p.id,NULL::text,NULL::bigint FROM projects p
  UNION ALL SELECT 'agents',a.id,a.tenant_id,a.project_id,'projects',a.project_id FROM agents a
  UNION ALL SELECT 'job_instances',j.id,j.tenant_id,COALESCE(t.project_id,a.project_id),
    CASE WHEN j.task_id IS NOT NULL THEN 'tasks' ELSE 'agents' END,COALESCE(j.task_id,j.agent_id)
    FROM job_instances j LEFT JOIN tasks t ON t.id=j.task_id AND t.tenant_id=j.tenant_id
    LEFT JOIN agents a ON a.id=j.agent_id AND a.tenant_id=j.tenant_id
  UNION ALL SELECT 'runtime_executions',r.id,r.tenant_id,COALESCE(t.project_id,a.project_id),'job_instances',j.id
    FROM runtime_executions r JOIN job_instances j ON j.id=r.instance_id AND j.tenant_id=r.tenant_id
    LEFT JOIN tasks t ON t.id=j.task_id AND t.tenant_id=j.tenant_id
    LEFT JOIN agents a ON a.id=j.agent_id AND a.tenant_id=j.tenant_id;

CREATE FUNCTION telemetry_expand_sources(selected_tenant bigint, roots jsonb)
RETURNS TABLE(source_type text,source_id bigint,project_id bigint) LANGUAGE sql STABLE AS $$
  WITH RECURSIVE sources AS (
    SELECT c.* FROM jsonb_to_recordset(roots) AS r(source_type text,source_id bigint)
      JOIN telemetry_source_context c USING(source_type,source_id) WHERE c.tenant_id=selected_tenant
    UNION
    SELECT c.* FROM sources s JOIN telemetry_source_context c
      ON c.source_type=s.parent_type AND c.source_id=s.parent_id AND c.tenant_id=selected_tenant
  ) SELECT source_type,source_id,project_id FROM sources
$$;

CREATE FUNCTION telemetry_invalidate_source(selected_tenant bigint, selected_type text, selected_id bigint, deleted boolean)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF selected_tenant IS NULL THEN RETURN; END IF;
  -- Publication takes the shared side of this lock, checks current access, and
  -- inserts the proof and its source manifest atomically. A concurrent mutation
  -- either revokes that proof after publication or is observed before publication.
  PERFORM pg_advisory_xact_lock(hashtextextended('telemetry-proof:'||selected_tenant::text,0));
  DELETE FROM telemetry_query_results q WHERE q.tenant_id=selected_tenant
    AND EXISTS (SELECT 1 FROM telemetry_query_sources s WHERE s.query_id=q.id
      AND s.source_type=selected_type AND s.source_id=selected_id)
    AND (deleted OR EXISTS (
      SELECT 1 FROM telemetry_query_sources s LEFT JOIN telemetry_source_context c
        ON c.tenant_id=s.tenant_id AND c.source_type=s.source_type AND c.source_id=s.source_id
      WHERE s.query_id=q.id AND (c.source_id IS NULL OR c.project_id IS DISTINCT FROM s.project_id)
    ));
END;
$$;

-- Reconstruct legacy manifests from all retained contributors, observations and
-- task access guards. Opaque/incomplete results remain explicitly unavailable.
CREATE FUNCTION pg_temp.telemetry_legacy_roots(proof jsonb, tasks bigint[])
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH cards AS (
    SELECT value AS card FROM jsonb_array_elements(CASE WHEN jsonb_typeof(proof->'results')='array'
      THEN proof->'results' ELSE jsonb_build_array(proof) END)
  ), contributors AS (
    SELECT value AS row FROM cards CROSS JOIN LATERAL jsonb_array_elements(COALESCE(card->'contributors','[]'::jsonb))
  ), identities AS (
    SELECT CASE row->>'entity_kind' WHEN 'task' THEN 'tasks' WHEN 'run' THEN 'job_instances'
      WHEN 'runtime_execution' THEN 'runtime_executions' WHEN 'workflow' THEN 'workflows'
      WHEN 'project' THEN 'projects' WHEN 'agent' THEN 'agents' END AS source_type,
      (row->>'entity_id')::bigint AS source_id FROM contributors
    UNION SELECT 'tasks',unnest(tasks)
    UNION SELECT CASE o.entity_type WHEN 'task' THEN 'tasks' WHEN 'run' THEN 'job_instances'
      WHEN 'runtime_execution' THEN 'runtime_executions' END,o.entity_id
      FROM contributors CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(row->'observation_ids','[]'::jsonb)) ids
      JOIN telemetry_observations o ON o.id=ids.value::bigint
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object('source_type',source_type,'source_id',source_id)),'[]'::jsonb)
      FROM identities WHERE source_type IS NOT NULL AND source_id IS NOT NULL
$$;
DO $$
DECLARE q record; roots jsonb;
BEGIN
  FOR q IN SELECT * FROM telemetry_query_results WHERE state='complete' AND result IS NOT NULL LOOP
    roots:=pg_temp.telemetry_legacy_roots(q.result,q.task_ids);
    INSERT INTO telemetry_query_sources(tenant_id,query_id,source_type,source_id,project_id)
      SELECT q.tenant_id,q.id,s.* FROM telemetry_expand_sources(q.tenant_id,roots) s ON CONFLICT DO NOTHING;
    UPDATE telemetry_query_results SET source_count=(SELECT count(*) FROM telemetry_query_sources WHERE query_id=q.id),sources_complete=
      COALESCE((jsonb_typeof(q.result->'contributors')='array' OR jsonb_typeof(q.result->'results')='array'),false)
      AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(roots) AS r(source_type text,source_id bigint)
        LEFT JOIN telemetry_source_context c ON c.tenant_id=q.tenant_id AND c.source_type=r.source_type AND c.source_id=r.source_id
        WHERE c.source_id IS NULL)
      WHERE id=q.id;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION telemetry_purge_task_results() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM telemetry_invalidate_source(OLD.tenant_id,'tasks',OLD.id,true);
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION telemetry_capture_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_row jsonb := '{}'::jsonb; new_row jsonb := '{}'::jsonb; row_data jsonb;
  old_safe jsonb := '{}'::jsonb; new_safe jsonb := '{}'::jsonb; task_row jsonb; instance_row jsonb;
  tenant bigint; task bigint; project bigint; workflow bigint; agent bigint; entity bigint;
  entity_kind text; event_kind text; key_text text; old_tenant bigint;
  now_at timestamptz := clock_timestamp(); happened_at timestamptz;
  payload_data jsonb; changed jsonb; outbox_id bigint; other_tenant bigint; affected_ids bigint[];
  supersedes_key text; previous_payload jsonb; previous_cause text; previous_time timestamptz;
  previous_project bigint; previous_workflow bigint; previous_agent bigint;
  config_keys text[] := ARRAY['id','key','name','status','status_key','label','terminal','is_default_entry',
    'stage_order','workflow_id','workflow_type','workflow_type_key','project_id','task_type','from_status',
    'to_status','outcome','outcome_key','field_name','requirement_type','match_field','severity','enabled',
    'priority','agent_id','source','event_name','action_kind','action_target','behavior','relationship_type_key',
    'category','affects_dispatch_eligibility','direction_semantics','active_statuses_json','resolved_statuses_json',
    'allowed_transitions_json','status_includes_json','status_excludes_json','model','instructions_version','runtime_type'];
BEGIN
  IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
  row_data := CASE WHEN TG_OP = 'DELETE' THEN old_row ELSE new_row END;
  tenant := (row_data->>'tenant_id')::bigint;
  entity := (row_data->>'id')::bigint;
  task := COALESCE((row_data->>'task_id')::bigint,
    (row_data->>'source_task_id')::bigint,(row_data->>'blocked_id')::bigint);
  workflow := (row_data->>'workflow_id')::bigint;
  project := (row_data->>'project_id')::bigint;
  agent := (row_data->>'agent_id')::bigint;
  IF TG_TABLE_NAME='projects' THEN project:=entity;
  ELSIF TG_TABLE_NAME='workflows' THEN workflow:=entity;
  ELSIF TG_TABLE_NAME='agents' THEN agent:=entity; END IF;
  entity_kind := 'configuration';
  event_kind := 'configuration.changed';
  happened_at := now_at;

  IF TG_OP='DELETE' AND TG_TABLE_NAME IN ('job_instances','runtime_executions') THEN
    entity_kind := CASE TG_TABLE_NAME WHEN 'job_instances' THEN 'run' ELSE 'runtime_execution' END;
    tenant := COALESCE(tenant,(SELECT tenant_id FROM telemetry_outbox
      WHERE entity_type=entity_kind AND entity_id=entity LIMIT 1));
    DELETE FROM telemetry_outbox WHERE entity_type=entity_kind AND entity_id=entity;
    DELETE FROM telemetry_observations WHERE entity_type=entity_kind AND entity_id=entity;
    IF tenant IS NOT NULL AND to_regclass('public.telemetry_query_results') IS NOT NULL THEN
      PERFORM telemetry_invalidate_source(tenant, TG_TABLE_NAME, entity, true);
    END IF;
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'task_statuses' THEN
    IF TG_OP='UPDATE' AND old_row->'terminal' IS NOT DISTINCT FROM new_row->'terminal'
      AND old_row->'name' IS NOT DISTINCT FROM new_row->'name' THEN RETURN NULL; END IF;
    SELECT array_agg(DISTINCT blocked_id) INTO affected_ids FROM task_dependencies;
    outbox_id := nextval(pg_get_serial_sequence('telemetry_outbox','id'));
    PERFORM telemetry_refresh_dependencies(affected_ids,'global-terminality:'||outbox_id,
      NULLIF(current_setting('agent_hq.telemetry_causation_id',true),''));
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'tasks' THEN
    task := entity;
    task_row := row_data;
    IF tenant IS NULL THEN SELECT tenant_id INTO tenant FROM workflows WHERE id = workflow; END IF;
    -- A hard deletion follows the canonical retention policy. Keep a minimal
    -- tombstone, never the deleted task's custom fields or frozen proof data.
    IF TG_OP = 'DELETE' THEN
      DELETE FROM telemetry_outbox WHERE task_id = task;
      DELETE FROM telemetry_observations WHERE task_id = task;
      IF to_regclass('public.telemetry_query_results') IS NOT NULL THEN
        PERFORM telemetry_invalidate_source(tenant, TG_TABLE_NAME, entity, true);
      END IF;
      old_safe := jsonb_build_object('id',task);
    ELSE
      new_safe := telemetry_task_snapshot(new_row || jsonb_build_object('tenant_id',tenant));
      IF TG_OP = 'UPDATE' THEN
        old_safe := telemetry_task_snapshot(old_row || jsonb_build_object('tenant_id',COALESCE((old_row->>'tenant_id')::bigint,tenant)));
      END IF;
    END IF;
    entity_kind := 'task';
    event_kind := CASE TG_OP WHEN 'INSERT' THEN 'task.created' WHEN 'DELETE' THEN 'task.deleted' ELSE 'task.changed' END;
    old_tenant := (old_row->>'tenant_id')::bigint;
    IF old_tenant IS NOT NULL AND old_tenant <> tenant THEN
      DELETE FROM telemetry_outbox WHERE task_id = task;
      DELETE FROM telemetry_observations WHERE task_id = task;
      old_safe := '{}'::jsonb;
      event_kind := 'task.bootstrap';
    END IF;
  ELSIF TG_TABLE_NAME = 'job_instances' THEN
    entity_kind := 'run';
    event_kind := CASE TG_OP WHEN 'INSERT' THEN 'run.created' WHEN 'DELETE' THEN 'run.deleted' ELSE 'run.changed' END;
    IF TG_OP <> 'DELETE' THEN new_safe := telemetry_run_snapshot(new_row); END IF;
    IF TG_OP <> 'INSERT' THEN old_safe := telemetry_run_snapshot(old_row); END IF;
  ELSIF TG_TABLE_NAME = 'runtime_executions' THEN
    SELECT to_jsonb(j) INTO instance_row FROM job_instances j WHERE id = (row_data->>'instance_id')::bigint;
    task := (instance_row->>'task_id')::bigint;
    agent := (instance_row->>'agent_id')::bigint;
    entity_kind := 'runtime_execution';
    event_kind := CASE TG_OP WHEN 'INSERT' THEN 'runtime.created' WHEN 'DELETE' THEN 'runtime.deleted' ELSE 'runtime.changed' END;
    new_safe := telemetry_pick(new_row,ARRAY['id','instance_id','runtime_type','driver','backend','state',
      'boundary_version','boundary_fingerprint','started_at','ended_at','created_at']);
    old_safe := telemetry_pick(old_row,ARRAY['id','instance_id','runtime_type','driver','backend','state',
      'boundary_version','boundary_fingerprint','started_at','ended_at','created_at']);
    happened_at := telemetry_timestamp(row_data->>'ended_at',now_at);
  ELSIF TG_TABLE_NAME = 'task_history' THEN
    -- Canonical task mutations already capture status/fields. Only the accepted
    -- semantic outcome is distinct evidence; notes/error strings are excluded.
    IF row_data->>'field' <> 'lifecycle_outcome' OR TG_OP = 'DELETE' THEN RETURN NULL; END IF;
    entity_kind := 'task'; entity := task; event_kind := 'task.outcome';
    new_safe := jsonb_build_object('outcome',row_data->'new_value');
    old_safe := jsonb_build_object('outcome',old_row->'new_value');
  ELSIF TG_TABLE_NAME = 'external_task_event_receipts' THEN
    -- Only accepted receipts represent an event, not every request/retry.
    IF row_data->>'processing_state' NOT IN ('processed','applied','ignored','completed') OR TG_OP = 'DELETE' THEN RETURN NULL; END IF;
    entity_kind := 'task'; entity := task; event_kind := 'task.external_event';
    new_safe := telemetry_pick(new_row,ARRAY['source','event','processing_state','mapping_id','mapping_action_kind','mapping_action_target','fingerprint']);
    old_safe := telemetry_pick(old_row,ARRAY['source','event','processing_state','mapping_id','mapping_action_kind','mapping_action_target','fingerprint']);
  ELSIF TG_TABLE_NAME IN ('task_relationships','task_dependencies') THEN
    entity_kind := 'task'; entity := task;
    event_kind := CASE TG_OP WHEN 'INSERT' THEN 'task.relationship_added' WHEN 'DELETE' THEN 'task.relationship_removed' ELSE 'task.relationship_changed' END;
    new_safe := telemetry_pick(new_row,ARRAY['source_task_id','target_task_id','relationship_type_key','blocker_id','blocked_id']);
    old_safe := telemetry_pick(old_row,ARRAY['source_task_id','target_task_id','relationship_type_key','blocker_id','blocked_id']);
    SELECT tenant_id INTO other_tenant FROM tasks WHERE id = COALESCE((row_data->>'target_task_id')::bigint,(row_data->>'blocker_id')::bigint);
  ELSIF TG_TABLE_NAME = 'task_field_schemas' THEN
    new_safe := telemetry_pick(new_row,ARRAY['id','workflow_type_key','task_type']) || jsonb_build_object('schema',telemetry_schema_snapshot(new_row->>'schema_json'));
    old_safe := telemetry_pick(old_row,ARRAY['id','workflow_type_key','task_type']) || jsonb_build_object('schema',telemetry_schema_snapshot(old_row->>'schema_json'));
  ELSIF TG_TABLE_NAME = 'routing_config_audit_log' THEN
    IF TG_OP <> 'INSERT' THEN RETURN NULL; END IF;
    workflow := (row_data->>'workflow_id')::bigint;
    new_safe := telemetry_pick(row_data,ARRAY['entity_table','entity_id','entity_key','action','workflow_type','workflow_id','batch_id']) ||
      jsonb_build_object('before_fingerprint',md5(row_data->>'before_json'),'after_fingerprint',md5(row_data->>'after_json'));
    old_safe := '{}'::jsonb;
  ELSE
    new_safe := telemetry_pick(new_row,config_keys);
    old_safe := telemetry_pick(old_row,config_keys);
    IF TG_TABLE_NAME = 'agents' THEN
      new_safe := new_safe || jsonb_build_object('instructions_fingerprint',md5(new_row->>'job_instructions'));
      old_safe := old_safe || jsonb_build_object('instructions_fingerprint',md5(old_row->>'job_instructions'));
    END IF;
    IF TG_OP = 'DELETE' AND TG_TABLE_NAME IN ('projects','workflows','agents') THEN
      -- Honor canonical entity retention, including historical run snapshots.
      IF TG_TABLE_NAME = 'projects' THEN
        DELETE FROM telemetry_outbox WHERE tenant_id=tenant AND project_id=entity;
        DELETE FROM telemetry_observations WHERE tenant_id=tenant AND project_id=entity;
        project := entity;
      ELSIF TG_TABLE_NAME = 'workflows' THEN
        DELETE FROM telemetry_outbox WHERE tenant_id=tenant AND workflow_id=entity;
        DELETE FROM telemetry_observations WHERE tenant_id=tenant AND workflow_id=entity;
        workflow := entity;
      ELSE
        DELETE FROM telemetry_outbox WHERE tenant_id=tenant AND
          ((agent_id=entity AND entity_type IN ('run','runtime_execution')) OR (source='agents' AND entity_id=entity));
        DELETE FROM telemetry_observations WHERE tenant_id=tenant AND
          ((agent_id=entity AND entity_type IN ('run','runtime_execution')) OR (source='agents' AND entity_id=entity));
      END IF;
      IF to_regclass('public.telemetry_query_results') IS NOT NULL THEN
        PERFORM telemetry_invalidate_source(tenant, TG_TABLE_NAME, entity, true);
      END IF;
      old_safe := jsonb_build_object('id',entity);
      new_safe := '{}'::jsonb;
      event_kind := 'configuration.deleted';
    END IF;
  END IF;

  IF task IS NOT NULL AND task_row IS NULL THEN SELECT to_jsonb(t) INTO task_row FROM tasks t WHERE id = task; END IF;
  IF task_row IS NOT NULL THEN
    IF tenant IS NOT NULL AND (task_row->>'tenant_id')::bigint IS NOT NULL
      AND tenant <> (task_row->>'tenant_id')::bigint THEN RETURN NULL; END IF;
    tenant := COALESCE(tenant,(task_row->>'tenant_id')::bigint);
    project := (task_row->>'project_id')::bigint;
    workflow := (task_row->>'workflow_id')::bigint;
    agent := COALESCE(agent,(task_row->>'agent_id')::bigint);
  END IF;
  IF tenant IS NULL AND workflow IS NOT NULL THEN
    SELECT tenant_id,project_id INTO tenant,project FROM workflows WHERE id = workflow;
  END IF;
  IF tenant IS NULL AND project IS NOT NULL THEN SELECT tenant_id INTO tenant FROM projects WHERE id = project; END IF;
  IF task_row IS NULL AND agent IS NOT NULL AND entity_kind IN ('run','runtime_execution') THEN
    SELECT tenant_id,project_id INTO other_tenant,project FROM agents WHERE id=agent;
    IF tenant IS NOT NULL AND other_tenant IS DISTINCT FROM tenant THEN RETURN NULL; END IF;
    tenant := COALESCE(tenant,other_tenant);
  END IF;
  IF tenant IS NULL AND agent IS NOT NULL THEN SELECT tenant_id INTO tenant FROM agents WHERE id = agent; END IF;
  -- Global legacy configuration has no tenant owner. It is discoverable in the
  -- catalog, but cannot silently be assigned to an arbitrary tenant's history.
  IF tenant IS NULL OR NOT EXISTS (SELECT 1 FROM tenants WHERE id = tenant) THEN RETURN NULL; END IF;
  IF other_tenant IS NOT NULL AND other_tenant <> tenant THEN RETURN NULL; END IF;
  -- Revoke only proofs whose recorded sources lost access. Same-project run
  -- linking preserves point-in-time results; metric filters run on recalculation.
  IF TG_OP='UPDATE' AND to_regclass('public.telemetry_query_results') IS NOT NULL
    AND TG_TABLE_NAME IN ('tasks','agents','workflows','job_instances','runtime_executions')
    AND (old_row->'tenant_id' IS DISTINCT FROM new_row->'tenant_id'
      OR old_row->'project_id' IS DISTINCT FROM new_row->'project_id'
      OR old_row->'task_id' IS DISTINCT FROM new_row->'task_id'
      OR old_row->'agent_id' IS DISTINCT FROM new_row->'agent_id'
      OR old_row->'instance_id' IS DISTINCT FROM new_row->'instance_id') THEN
    PERFORM telemetry_invalidate_source(tenant, TG_TABLE_NAME, entity, false);
    IF (old_row->>'tenant_id')::bigint IS DISTINCT FROM tenant THEN
      PERFORM telemetry_invalidate_source((old_row->>'tenant_id')::bigint, TG_TABLE_NAME, entity, false);
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND old_safe = new_safe
    AND NOT (TG_TABLE_NAME='task_history' AND old_row->'created_at' IS DISTINCT FROM new_row->'created_at') THEN RETURN NULL; END IF;

  IF TG_OP='UPDATE' AND (TG_TABLE_NAME='task_history' OR
    (TG_TABLE_NAME='runtime_executions' AND old_row->>'state' IN ('succeeded','failed','cancelled','lost')
      AND old_row->'state'=new_row->'state' AND old_row->'ended_at' IS DISTINCT FROM new_row->'ended_at')) THEN
    SELECT source_key,payload,causation_id,occurred_at,project_id,workflow_id,agent_id
      INTO supersedes_key,previous_payload,previous_cause,previous_time,previous_project,previous_workflow,previous_agent
      FROM telemetry_outbox WHERE tenant_id=tenant AND source=TG_TABLE_NAME
        AND (source_key LIKE TG_TABLE_NAME||':'||(row_data->>'id')||':%'
          OR source_key='backfill:'||TG_TABLE_NAME||':'||(row_data->>'id')) ORDER BY id DESC LIMIT 1;
    IF supersedes_key IS NOT NULL THEN
      old_safe := COALESCE(previous_payload->'before','{}'::jsonb);
      project := previous_project; workflow := previous_workflow; agent := previous_agent;
      IF TG_TABLE_NAME='task_history' THEN
        happened_at := CASE WHEN old_row->'created_at' IS DISTINCT FROM new_row->'created_at'
          THEN telemetry_timestamp(new_row->>'created_at',previous_time) ELSE previous_time END;
      END IF;
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(key),'[]'::jsonb) INTO changed FROM (
    SELECT key FROM jsonb_object_keys(old_safe || new_safe) key
    WHERE old_safe->key IS DISTINCT FROM new_safe->key
  ) fields;
  payload_data := jsonb_build_object('before',old_safe,'after',new_safe,'changed_fields',changed,
    'context',CASE WHEN task_row IS NULL AND entity_kind IN ('run','runtime_execution')
      THEN jsonb_build_object('project_id',project,'agent_id',agent,'task_id',task)
      WHEN task_row IS NULL OR (TG_TABLE_NAME = 'tasks' AND TG_OP = 'DELETE')
      THEN '{}'::jsonb ELSE telemetry_task_snapshot(task_row || jsonb_build_object('tenant_id',tenant)) END,
    'transaction_id',txid_current()::text,
    'outcome_agent_id',NULLIF(current_setting('agent_hq.telemetry_outcome_agent_id',true),'')::bigint);
  IF supersedes_key IS NOT NULL THEN payload_data := payload_data || jsonb_build_object(
    'supersedes_source_key',supersedes_key,'context',COALESCE(previous_payload->'context','{}'::jsonb),
    'outcome_agent_id',previous_payload->'outcome_agent_id',
    'historical_context_known',COALESCE(previous_payload->'historical_context_known','true'::jsonb)); END IF;
  -- An oversized declared schema cannot inflate every canonical mutation without
  -- bound. Preserve the lifecycle fact while making missing field proof explicit.
  IF octet_length(payload_data::text) > 262144 THEN
    payload_data := jsonb_build_object('before',telemetry_pick(old_safe,ARRAY['id','status','project_id','workflow_id','task_type']),
      'after',telemetry_pick(new_safe,ARRAY['id','status','project_id','workflow_id','task_type']),
      'changed_fields',changed,'fields_complete',false,'truncated',true);
  END IF;
  outbox_id := nextval(pg_get_serial_sequence('telemetry_outbox','id'));
  key_text := TG_TABLE_NAME || ':' || COALESCE((row_data->>'id'),md5(row_data::text)) || ':' || outbox_id::text;
  INSERT INTO telemetry_outbox(id,tenant_id,source,source_key,entity_type,entity_id,task_id,
    project_id,workflow_id,agent_id,kind,occurred_at,causation_id,payload)
  VALUES(outbox_id,tenant,TG_TABLE_NAME,key_text,entity_kind,COALESCE(entity,workflow,project,tenant),task,
    project,workflow,agent,event_kind,happened_at,
    COALESCE(NULLIF(current_setting('agent_hq.telemetry_causation_id',true),''),previous_cause),payload_data);

  IF TG_TABLE_NAME='tasks' AND TG_OP='UPDATE' AND
    (old_row->'status' IS DISTINCT FROM new_row->'status' OR old_row->'workflow_id' IS DISTINCT FROM new_row->'workflow_id') THEN
    SELECT array_agg(blocked_id) INTO affected_ids FROM task_dependencies WHERE blocker_id=task;
  ELSIF TG_TABLE_NAME='task_dependencies' THEN
    affected_ids := ARRAY[task];
  ELSIF TG_TABLE_NAME IN ('workflow_task_statuses','workflow_type_task_statuses') AND
    (TG_OP<>'UPDATE' OR old_row->'terminal' IS DISTINCT FROM new_row->'terminal' OR old_row->'status_key' IS DISTINCT FROM new_row->'status_key') THEN
    SELECT array_agg(DISTINCT d.blocked_id) INTO affected_ids FROM task_dependencies d
      JOIN tasks t ON t.id=d.blocked_id WHERE t.tenant_id=tenant;
  END IF;
  IF affected_ids IS NOT NULL THEN
    PERFORM telemetry_refresh_dependencies(affected_ids,'dependency-effect:'||outbox_id,
      NULLIF(current_setting('agent_hq.telemetry_causation_id',true),''));
  END IF;
  RETURN NULL;
END $$;
