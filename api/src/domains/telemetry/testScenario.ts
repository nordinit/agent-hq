import type {Db} from '../../db/adapter/types';

/** Synthetic, migration-backed scenario shared by integration tests and UI smoke. */
export async function seedTelemetryScenario(db:Db){
  // Test resets truncate registry rows while preserving installed triggers.
  // Restore the known instrumentation boundary before generating this scenario.
  await db.run(`INSERT INTO telemetry_capture_sources(source,capture_started_at)
    SELECT c.relname,clock_timestamp() FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE t.tgname='telemetry_capture' AND NOT t.tgisinternal ON CONFLICT(source) DO NOTHING`);
  await db.exec(`
    INSERT INTO tenants(id,name,slug,is_default) VALUES(1,'Telemetry test','telemetry-test',1),(2,'Other tenant','other-telemetry',0);
    INSERT INTO app_settings(key,value) VALUES('default_tenant_id','1'),('active_tenant_id','1');
    INSERT INTO projects(id,tenant_id,name) VALUES(11,1,'Editorial'),(12,1,'Proposals'),(22,2,'Private project');
    INSERT INTO sprint_types(tenant_id,key,name) VALUES(1,'content','Content review'),(2,'content','Private content');
    INSERT INTO sprint_type_task_types(tenant_id,sprint_type_key,task_type) VALUES(1,'content','article'),(2,'content','article');
    INSERT INTO task_field_schemas(id,tenant_id,sprint_type_key,schema_json) VALUES
      (701,1,'content','{"fields":[{"key":"amount","label":"Proposal amount","type":"number"},{"key":"revisions","label":"Revision count","type":"number"},{"key":"needs_changes","label":"Needs changes","type":"checkbox"}]}'),
      (702,2,'content','{"fields":[{"key":"private_amount","label":"Private amount","type":"number"}]}');
    INSERT INTO sprints(id,tenant_id,project_id,name,sprint_type) VALUES(111,1,11,'Content approval','content'),(112,1,12,'Proposal delivery','content'),(222,2,22,'Private workflow','content');
    INSERT INTO agents(id,tenant_id,name,job_title,session_key,project_id,runtime_type) VALUES(101,1,'Editor','Editor','telemetry:editor',11,'openclaw'),(102,1,'Proposal writer','Writer','telemetry:writer',12,'openclaw'),(202,2,'Private agent','Private','telemetry:private',22,'openclaw');
    INSERT INTO sprint_type_task_statuses(tenant_id,sprint_type_key,status_key,label,terminal) VALUES
      (1,'content','review','Review',0),(1,'content','approved','Approved',1),(1,'content','done','Done',1),(1,'content','submitted','Submitted',1),(1,'content','rejected','Rejected',1),(1,'content','cancelled','Cancelled',1);
    INSERT INTO sprint_type_outcomes(tenant_id,sprint_type_key,outcome_key,label) VALUES(1,'content','changes_requested','Changes requested');
    INSERT INTO tasks(id,tenant_id,title,status,project_id,sprint_id,task_type,assigned_agent_id,custom_fields_json) VALUES
      (1001,1,'A — direct approval','review',11,111,'article',101,'{"amount":10,"revisions":0,"needs_changes":false}'),
      (1002,1,'B — revised approval','review',11,111,'article',101,'{"amount":20,"revisions":0,"needs_changes":false}'),
      (1003,1,'C — recovered runtime','review',11,111,'article',101,'{"amount":30,"revisions":0,"needs_changes":false}'),
      (1004,1,'D — rejected','review',11,111,'article',101,'{"amount":40,"revisions":0,"needs_changes":false}'),
      (1005,1,'E — unfinished','review',11,111,'article',101,'{"amount":50,"revisions":0,"needs_changes":false}'),
      (1006,1,'F — cancelled','review',11,111,'article',101,'{"amount":60,"revisions":0,"needs_changes":false}'),
      (1101,1,'Proposal submitted','review',12,112,'article',102,'{"amount":100}'),
      (2001,2,'Private task','review',22,222,'article',202,'{"private_amount":999999}');
    INSERT INTO task_history(tenant_id,task_id,field,old_value,new_value) VALUES(1,1002,'lifecycle_outcome',NULL,'changes_requested');
    UPDATE tasks SET custom_fields_json='{"amount":20,"revisions":1,"needs_changes":true}' WHERE id=1002;
    INSERT INTO job_instances(id,tenant_id,task_id,agent_id,status,runtime_end_success,started_at,runtime_ended_at) VALUES(501,1,1003,101,'failed',0,'2026-09-09 10:00:00','2026-09-09 10:00:10');
    INSERT INTO runtime_executions(tenant_id,instance_id,boundary_json,boundary_fingerprint,runtime_type,driver,backend,execution_target_id,state,started_at) VALUES(1,501,'{}','synthetic','openclaw','openclaw','local','test','running','2026-09-09 10:00:00');
    UPDATE runtime_executions SET state='failed' WHERE instance_id=501;
    UPDATE tasks SET status='approved' WHERE id IN(1001,1002,1003);
    UPDATE tasks SET status='rejected' WHERE id=1004;
    UPDATE tasks SET status='cancelled' WHERE id=1006;
    UPDATE tasks SET status='submitted' WHERE id=1101;
  `);
}
