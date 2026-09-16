import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { Db } from '../db/adapter/types';
import { setupTestDb,teardownTestDb } from '../db/testDb';
let db:Db;
jest.mock('../db/client',()=>({getDb:()=>db}));
import telemetryRouter from './telemetry';

let server:Server,base:string;
beforeAll(async()=>{
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{if(req.headers['x-test-project'])req.telemetryProjectId=Number(req.headers['x-test-project']);next();});
  app.use('/telemetry',telemetryRouter);
  server=app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/telemetry`;
});
afterAll(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});

beforeEach(async()=>{
  db=await setupTestDb();
  await db.run(`INSERT INTO tenants(id,name,slug,is_default) VALUES(1,'One','one',1),(2,'Two','two',0)`);
  await db.run(`INSERT INTO app_settings(key,value) VALUES('active_tenant_id','1'),('default_tenant_id','1')`);
  for(const [id,tenantId,label] of [[11,1,'OWN'],[12,1,'PRIVATE SAME TENANT'],[22,2,'PRIVATE TENANT']] as const){
    await db.run(`INSERT INTO projects(id,tenant_id,name) VALUES(?,?,?)`,id,tenantId,label);
    await db.run(`INSERT INTO sprints(id,tenant_id,project_id,name) VALUES(?,?,?,?)`,id,tenantId,id,label);
    await db.run(`INSERT INTO agents(id,tenant_id,project_id,name,session_key) VALUES(?,?,?,?,?)`,id,tenantId,id,label,`session:${id}`);
    await db.run(`INSERT INTO tasks(id,tenant_id,project_id,sprint_id,agent_id,title,status,dispatched_at,routing_reason)
      VALUES(?,?,?,?,?,?,'failed',to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD HH24:MI:SS'),'test route')`,id,tenantId,id,id,id,label);
    await db.run(`INSERT INTO job_instances(id,tenant_id,task_id,agent_id,status,dispatched_at,failure_stage)
      VALUES(?,?,?,?,'failed',to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD HH24:MI:SS'),'review')`,id,tenantId,id,id);
    await db.run(`INSERT INTO task_creation_events(tenant_id,task_id,project_id,sprint_id,source) VALUES(?,?,?,?,'manual')`,tenantId,id,id,id);
    await db.run(`INSERT INTO task_outcome_metrics(tenant_id,task_id,project_id,sprint_id,first_pass_qa) VALUES(?,?,?,?,1)`,tenantId,id,id,id);
    await db.run(`INSERT INTO task_events(tenant_id,task_id,project_id,agent_id,from_status,to_status) VALUES(?,?,?,?,'draft','review'),(?,?,?,?,'changes','review')`,tenantId,id,id,id,tenantId,id,id,id);
    await db.run(`INSERT INTO integrity_events(id,tenant_id,task_id,project_id,agent_id,anomaly_type,detail)
      VALUES(?,?,?,?,?,'missing_lifecycle_handoff',?)`,id,tenantId,id,id,id,label);
    await db.run(`INSERT INTO sessions(id,tenant_id,external_key,runtime,agent_id,task_id,instance_id,project_id,status,title)
      VALUES(?,?,?,'openclaw',?,?,?,?,'failed',?)`,id,tenantId,`session:${id}`,id,id,id,id,label);
    await db.run(`INSERT INTO sprint_task_routing_rules(tenant_id,sprint_id,project_id,status,agent_id) VALUES(?,?,?,'draft',?)`,tenantId,id,id,id);
  }
});
afterEach(async()=>{await teardownTestDb();});

async function request(path:string,options:{project?:number;method?:string;body?:unknown}={}){
    const response=await fetch(base+path,{
      method:options.method??'GET',headers:{'Content-Type':'application/json',...(options.project===undefined?{}:{'x-test-project':String(options.project)})},
      ...(options.body===undefined?{}:{body:JSON.stringify(options.body)}),
    });
    return {status:response.status,body:await response.json() as any,deprecated:response.headers.get('Deprecation')};
}

it.each(['/overview','/review','/sessions','/pipeline-health','/bottlenecks','/failures','/integrity','/routing','/templates','/events','/recommendations'])(
  'contains the legacy %s response to the authorized project',async(path)=>{
    const result=await request(path,{project:11});
    expect(result.status).toBe(200);
    expect(result.deprecated).toBe('true');
    expect(JSON.stringify(result.body)).not.toContain('PRIVATE');
    if(path==='/overview')expect(result.body.total_created).toBe(1);
    if(path==='/review')expect(result.body.total).toBe(1);
    if(path==='/sessions')expect(result.body.totals.total_sessions).toBe(1);
    if(path==='/integrity')expect(result.body.total_anomalies).toBe(1);
    if(path==='/events')expect(result.body.total).toBe(2);
    if(path==='/recommendations')expect(result.body.task_count).toBe(1);
  });

it('keeps tenant-wide compatibility reads inside the active tenant',async()=>{
  expect((await request('/overview')).body.total_created).toBe(2);
  expect((await request('/events')).body.total).toBe(4);
  expect((await request('/sessions')).body.totals.total_sessions).toBe(2);
});

it('rejects foreign project/workflow filters and foreign task drilldowns',async()=>{
  expect((await request('/review?project_id=22')).status).toBe(404);
  expect((await request('/overview?project_id=12',{project:11})).status).toBe(403);
  expect((await request('/overview?sprint_id=12',{project:11})).status).toBe(404);
  expect((await request('/review/12',{project:11})).status).toBe(404);
});

it('redacts linked tasks outside a project during legacy drilldown',async()=>{
  await db.run(`INSERT INTO task_dependencies(blocker_id,blocked_id) VALUES(12,11),(22,11)`);
  const result=await request('/review/11',{project:11});
  expect(result.status).toBe(200);expect(result.body.task.blockers).toEqual([]);
  expect(JSON.stringify(result.body)).not.toContain('PRIVATE');
});

it('refuses cross-scope integrity creation/resolution and nonexistent tasks',async()=>{
  const body={task_id:12,anomaly_type:'missing_lifecycle_handoff'};
  expect((await request('/integrity-events',{project:11,method:'POST',body})).status).toBe(404);
  expect((await request('/integrity-events',{method:'POST',body:{...body,task_id:22}})).status).toBe(404);
  expect((await request('/integrity-events',{method:'POST',body:{...body,task_id:999}})).status).toBe(404);
  expect((await request('/integrity-events/12/resolve',{project:11,method:'PUT',body:{}})).status).toBe(404);
  expect(await db.value(`SELECT resolved FROM integrity_events WHERE id=12`)).toBe(0);
  expect((await request('/integrity-events/11/resolve',{project:11,method:'PUT',body:{}})).status).toBe(200);
});

it('keeps compatibility metric writes inside the credential project',async()=>{
  expect((await request('/outcome-metrics/12',{project:11,method:'PUT',body:{first_pass_qa:0}})).status).toBe(404);
  expect((await request('/creation-events/12',{project:11,method:'PUT',body:{source:'manual'}})).status).toBe(404);
  expect((await request('/outcome-metrics/11',{project:11,method:'PUT',body:{first_pass_qa:0,job_id:22}})).status).toBe(404);
  expect(await db.value(`SELECT first_pass_qa FROM task_outcome_metrics WHERE task_id=12`)).toBe(1);
});

it('retires the disconnected singleton schema without copying it into canonical fields',async()=>{
  expect((await request('/schema-config')).status).toBe(410);
  expect((await request('/schema-config/')).status).toBe(410);
  expect((await request('/Schema-Config')).status).toBe(410);
  expect((await request('/schema-config',{method:'PUT',body:{fields:[]}})).status).toBe(410);
  expect(await db.value('SELECT COUNT(*) FROM telemetry_schema_config')).toBe(0);
});
