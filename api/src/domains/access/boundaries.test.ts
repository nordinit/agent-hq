import express from 'express';
import type {Server} from 'http';
import {setupTestDb,teardownTestDb} from '../../db/testDb';
import {getDb} from '../../db/client';
import {authenticateTestApiRequest} from '../../lib/testApiAuth';
import {authorizeMcpApiRequestIfPresent,issueMcpApiKeyForAgent,replaceAgentMcpPermissionPolicy} from '../../lib/mcpApiAuth';
import {isProjectRead,sensitiveOperation,safeResponse} from './operations';
import {canDiscoverTool} from '../../mcp/toolPermissions';
import executionRouter from '../../routes/execution';
import {createExecutableDraft,publishExecutable,bindExecutable,requirePublishedProfile} from '../execution/authority';
import {issueExecutionCredential} from '../execution/credentials';
import {projectContext} from './projectContext';

describe('separate project observation and executable authority',()=>{
  let server:Server,base:string,networkEffects=0,networkCredential='';const keys:Record<string,string>={};
  beforeEach(async()=>{
    const db=await setupTestDb();
    networkEffects=0;
    networkCredential='';
    await db.run("INSERT INTO tenants(id,name,slug,is_default) VALUES(1,'One','one',1),(2,'Two','two',0)");
    await db.run("INSERT INTO app_settings(key,value) VALUES('default_tenant_id','1'),('active_tenant_id','1')");
    await db.run("INSERT INTO projects(id,tenant_id,name) VALUES(101,1,'Agency'),(301,1,'Pred Mkt Trader'),(401,2,'Other tenant')");
    await db.run("INSERT INTO workflows(id,tenant_id,project_id,name) VALUES(201,1,101,'Agency workflow'),(202,1,301,'Trader workflow')");
    for(const [id,name] of [[11,'observer'],[12,'author'],[13,'executor'],[14,'publisher'],[16,'admin']] as const){
      await db.run('INSERT INTO agents(id,tenant_id,project_id,name,session_key,enabled) VALUES(?,1,101,?,?,1)',id,name,'agent:'+name+':main');
      keys[name]=(await issueMcpApiKeyForAgent(db,id,name,name==='admin'?'admin':'scoped')).apiKey;
    }
    await replaceAgentMcpPermissionPolicy(db,11,['projects.read_all']);
    await replaceAgentMcpPermissionPolicy(db,12,['tools.register','tools.read']);
    await replaceAgentMcpPermissionPolicy(db,13,['tools.read','tools.execute','host.execute']);
    await replaceAgentMcpPermissionPolicy(db,14,['tools.read','tools.publish','tools.assign']);
    const app=express();app.use('/api/v1',authenticateTestApiRequest());app.use(express.json());app.use('/api/v1',authorizeMcpApiRequestIfPresent);
    app.use('/api/v1/execution',executionRouter);
    app.post('/side-effect',(req,res)=>{networkEffects++;networkCredential=req.get('authorization')??'';res.json({ok:true});});
    app.get('/api/v1/projects/:id',async(req,res)=>{const row=await getDb().get('SELECT id,name FROM projects WHERE id=? AND tenant_id=?',req.params.id,1);if(!row)return res.sendStatus(404);return res.json({...row,runtime_config:{env:{SECRET:'private'}},custom_fields_json:'{"secret":"hidden"}',custom_fields:{secret:'hidden',qualified:7}});});
    app.all('/api/v1/*',(_req,res)=>res.json({reached:true}));
    await new Promise<void>(resolve=>{server=app.listen(0,'127.0.0.1',()=>{base='http://127.0.0.1:'+(server.address() as any).port;resolve();});});
  });
  afterEach(async()=>{await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));await teardownTestDb();});
  const request=async(who:string,method:string,path:string,body?:unknown,headers:Record<string,string>={})=>{
    const r=await fetch(base+'/api/v1'+path,{method,headers:{authorization:'Bearer '+keys[who],'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:r.status,body:await r.json().catch(()=>null) as any};
  };
  async function tool(){const db=getDb();const r=await db.run("INSERT INTO tools(tenant_id,name,slug,implementation_type,implementation_body,input_schema,permissions,enabled) VALUES(1,'Fixture','fixture','bash','printf original',?, 'read_only',1)",JSON.stringify({type:'object',properties:{value:{type:'string'}},additionalProperties:false}));return Number(r.lastInsertId);}
  it('reads a second project without writes, execution, callbacks, raw config or another tenant',async()=>{
    const r=await request('observer','GET','/projects/301');expect(r.status).toBe(200);expect(r.body.name).toBe('Pred Mkt Trader');
    expect(r.body).not.toHaveProperty('runtime_config');expect(r.body).not.toHaveProperty('custom_fields_json');expect(r.body.custom_fields).toEqual({qualified:7});
    expect((await request('observer','GET','/projects/401')).status).toBe(404);
    for(const [m,p,b] of [['PUT','/projects/301',{name:'changed'}],['POST','/tools/1/test',{input:{}}],['POST','/instances/1/check-in',{}],['GET','/settings/gateway/config',undefined],['GET','/artifacts/file',undefined]] as const)expect((await request('observer',m,p,b)).status).toBe(403);
  });
  it('does not let an admin key inherit host/registration/execution authority',async()=>{
    expect((await request('admin','GET','/projects/301')).status).toBe(200);
    for(const [method,path,body] of [['POST','/tools',{name:'new'}],['POST','/tools/1/test',{input:{}}],['POST','/runtime-drivers/diagnose',{}],['PUT','/agents/13',{runtime_config:{permissionMode:'bypass'}}]] as const)expect((await request('admin',method,path,body)).status).toBe(403);
    expect((await request('admin','POST','/tools/%31/test/',{input:{}})).status).toBe(403);
    expect((await request('admin','PUT','/agents/1e1',{runtime_config:{command:'unapproved'}})).status).toBe(403);
    expect(canDiscoverTool('agent_hq_test_tool',new Set(['admin.full_access']))).toBe(false);
    expect(canDiscoverTool('agent_hq_get_project',new Set(['projects.read_all']))).toBe(true);
  });
  it('lets an author register a draft without publishing, binding or invoking it',async()=>{
    const id=await tool();const draft=await request('author','POST','/execution/revisions',{resource_kind:'tool',resource_id:id});expect(draft.status).toBe(201);
    expect((await request('author','POST','/execution/revisions/'+draft.body.id+'/publish',{digest:draft.body.digest})).status).toBe(403);
    expect((await request('author','POST','/execution/bindings',{subject_kind:'agent',subject_id:12,revision_id:draft.body.id})).status).toBe(403);
    expect((await request('author','POST','/execution/invoke',{tool_id:id,revision_id:draft.body.id,input:{}})).status).toBe(403);
  });
  it('pins executable content, validates inputs and denies a cached revision immediately after revocation',async()=>{
    const db=getDb(),id=await tool();const revision=(await createExecutableDraft(db,1,'tool',id,'operator'))!;
    await publishExecutable(db,1,String(revision.id),String(revision.digest),'operator');await bindExecutable(db,1,'agent',13,String(revision.id),'operator');
    await db.run("UPDATE tools SET implementation_body='printf revised' WHERE id=?",id);
    const payload={tool_id:id,revision_id:revision.id,input:{value:'safe'}};
    const first=await request('executor','POST','/execution/invoke',payload);expect(first.status).toBe(200);expect(first.body.content[0].text).toBe('original');
    expect((await request('executor','POST','/execution/invoke',{...payload,input:{unexpected:'bad'}})).status).toBe(403);
    expect((await request('executor','PUT','/tools/'+id,{implementation_body:'printf tampered'})).status).toBe(403);
    expect((await request('publisher','POST','/execution/revisions/'+revision.id+'/revoke',{})).status).toBe(200);
    expect((await request('executor','POST','/execution/invoke',payload)).status).toBe(403);
    await expect(db.run("UPDATE executable_revisions SET snapshot='{}' WHERE id=?",revision.id)).rejects.toThrow('immutable');
    const audit=await db.all<{decision:string}>("SELECT decision FROM execution_audit WHERE action='invoke' AND revision_id=? ORDER BY id",revision.id);expect(audit.map(x=>x.decision)).toEqual(['allowed','denied','denied']);
  });
  it('cannot use a run credential for business APIs or after its owning run ends',async()=>{
    const db=getDb(),run='7ceff427-ad3b-4f20-bf84-344fd412d1f5';
    const ji=await db.run("INSERT INTO job_instances(agent_id,tenant_id,status,run_id) VALUES(13,1,'running',?)",run);
    keys.run=await issueExecutionCredential(db,13,Number(ji.lastInsertId),run);
    const headers={'x-agent-hq-instance-id':String(ji.lastInsertId),'x-agent-hq-durable-run-id':run};
    expect((await request('run','GET','/projects/101',undefined,headers)).status).toBe(403);
    expect((await request('run','GET','/execution/agent-tools',undefined,headers)).status).toBe(200);
    await db.run("UPDATE job_instances SET status='done' WHERE id=?",ji.lastInsertId);
    expect((await request('run','GET','/execution/agent-tools',undefined,headers)).status).toBe(403);
  });
  it('does not confuse arbitrary GETs, caller labels or a cwd with observation authority',()=>{
    expect(isProjectRead('GET','/settings/gateway/config')).toBe(false);
    expect(sensitiveOperation('POST','/tools/1/test')?.requirements).toEqual(['tools.execute','host.execute']);
    expect(safeResponse({env:{x:'secret'},command:'shell',name:'safe'},'registry')).toEqual({name:'safe'});
  });
  it('does not perform HTTP effects for an unassigned or revoked tool',async()=>{
    const db=getDb();
    const credential='Bearer fixture-private-version-token';
    const row=await db.run("INSERT INTO tools(tenant_id,name,slug,implementation_type,implementation_body,input_schema) VALUES(1,'HTTP','http-fixture','http',?,'{}')",JSON.stringify({url:base+'/side-effect',method:'POST',headers:{Authorization:credential}}));
    const id=Number(row.lastInsertId),revision=(await createExecutableDraft(db,1,'tool',id,'operator'))!;
    const stored=await db.get('SELECT snapshot FROM executable_revisions WHERE id=?',revision.id);
    expect(JSON.stringify(stored)).not.toContain(credential);
    expect(JSON.stringify(stored)).toContain('$secret_ref');
    expect(JSON.stringify((await request('publisher','GET','/execution/revisions/'+revision.id)).body)).not.toContain(credential);
    await publishExecutable(db,1,String(revision.id),String(revision.digest),'operator');
    const payload={tool_id:id,revision_id:revision.id,input:{}};
    expect((await request('author','POST','/execution/invoke',payload)).status).toBe(403);
    expect((await request('executor','POST','/execution/invoke',payload)).status).toBe(403);
    expect(networkEffects).toBe(0);
    await bindExecutable(db,1,'agent',13,String(revision.id),'operator');
    expect((await request('executor','POST','/execution/invoke',payload)).status).toBe(200);
    expect(networkEffects).toBe(1);
    expect(networkCredential).toBe(credential);
    await request('publisher','POST','/execution/revisions/'+revision.id+'/revoke',{});
    expect((await request('executor','POST','/execution/invoke',payload)).status).toBe(403);
    expect(networkEffects).toBe(1);
  });
  it('rechecks team membership, expiry, effective assignments and executable overrides',async()=>{
    const db=getDb(),id=await tool(),revision=(await createExecutableDraft(db,1,'tool',id,'operator'))!;
    await publishExecutable(db,1,String(revision.id),String(revision.digest),'operator');
    await db.run("INSERT INTO teams(id,tenant_id,name,slug) VALUES(5,1,'Execution','execution'),(6,2,'Foreign','foreign')");
    await expect(bindExecutable(db,1,'team',6,String(revision.id),'operator')).rejects.toThrow('tenant');
    await db.run('INSERT INTO team_members(team_id,agent_id) VALUES(5,13)');
    await bindExecutable(db,1,'team',5,String(revision.id),'operator');
    const payload={tool_id:id,revision_id:revision.id,input:{}};
    expect((await request('executor','POST','/execution/invoke',payload)).status).toBe(200);
    await db.run("UPDATE team_tool_assignments SET overrides=? WHERE team_id=5",JSON.stringify({env:{BASH_ENV:'/tmp/unapproved'}}));
    expect((await request('executor','POST','/execution/invoke',payload)).status).toBe(403);
    await db.run("UPDATE team_tool_assignments SET overrides='{}' WHERE team_id=5");
    await db.run('UPDATE team_members SET enabled=0 WHERE team_id=5');
    expect((await request('executor','POST','/execution/invoke',payload)).status).toBe(403);
    await db.run('UPDATE team_members SET enabled=1 WHERE team_id=5');
    await db.run("UPDATE execution_bindings SET expires_at=now()-interval '1 second' WHERE subject_kind='team' AND subject_id=5");
    expect((await request('executor','POST','/execution/invoke',payload)).status).toBe(403);
    await bindExecutable(db,1,'agent',13,String(revision.id),'operator');
    await db.run('DELETE FROM agent_tool_assignments WHERE agent_id=13 AND tool_id=?',id);
    await db.run('UPDATE team_members SET enabled=0 WHERE team_id=5');
    expect((await request('executor','POST','/execution/invoke',payload)).status).toBe(403);
  });
  it('holds changed runtime instructions and skill content until a new profile is approved',async()=>{
    const db=getDb();
    await db.run("INSERT INTO skills(tenant_id,name,content) VALUES(1,'approved-skill','Reviewed content')");
    await db.run('UPDATE agents SET skill_names=? WHERE id=13',JSON.stringify(['approved-skill']));
    const original=await db.get<{job_instructions:string|null}>('SELECT job_instructions FROM agents WHERE id=13');
    const revision=(await createExecutableDraft(db,1,'agent_runtime',13,'operator'))!;
    await publishExecutable(db,1,String(revision.id),String(revision.digest),'operator');
    await bindExecutable(db,1,'agent',13,String(revision.id),'operator');
    await expect(requirePublishedProfile(db,13,'agent_runtime',13)).resolves.toHaveProperty('id',revision.id);
    await db.run("UPDATE agents SET job_instructions='Changed instruction' WHERE id=13");
    await expect(requirePublishedProfile(db,13,'agent_runtime',13)).rejects.toThrow('profile changed');
    await db.run('UPDATE agents SET job_instructions=? WHERE id=13',original!.job_instructions);
    await expect(requirePublishedProfile(db,13,'agent_runtime',13)).resolves.toHaveProperty('id',revision.id);
    await db.run("UPDATE skills SET content='Unreviewed content' WHERE name='approved-skill'");
    await expect(requirePublishedProfile(db,13,'agent_runtime',13)).rejects.toThrow('profile changed');
  });
  it('denies self elevation and delegation beyond held authority',async()=>{
    await replaceAgentMcpPermissionPolicy(getDb(),14,['permissions.manage','discovery.read_catalog']);
    expect((await request('publisher','PUT','/agents/14/mcp-permissions',{enabled_capabilities:[]})).body.code).toBe('self_elevation_denied');
    expect((await request('publisher','PUT','/agents/13/mcp-permissions',{enabled_capabilities:['host.execute']})).body.code).toBe('delegation_denied');
    expect((await request('publisher','DELETE','/agents/13/mcp-permissions')).body.code).toBe('delegation_denied');
    expect((await request('admin','GET','/tenants')).status).toBe(403);
  });
  it('checks current MCP tool allowlists on every mediated call',async()=>{
    const db=getDb();
    const source=await db.run("INSERT INTO mcp_servers(tenant_id,name,slug,command,args) VALUES(1,'MCP fixture','fixture-mcp',?,'[]')",process.execPath);
    const id=Number(source.lastInsertId),revision=(await createExecutableDraft(db,1,'mcp_server',id,'operator'))!;
    await publishExecutable(db,1,String(revision.id),String(revision.digest),'operator');
    await bindExecutable(db,1,'agent',13,String(revision.id),'operator');
    await db.run('UPDATE agent_mcp_assignments SET overrides=? WHERE agent_id=13 AND mcp_server_id=?',JSON.stringify({tool_allowlist:['allowed','removed']}),id);
    const payload={resource_kind:'mcp_server',resource_id:id,revision_id:revision.id,phase:'call',tool_name:'removed'};
    expect((await request('executor','POST','/execution/authorize',payload)).status).toBe(200);
    await db.run('UPDATE agent_mcp_assignments SET overrides=? WHERE agent_id=13 AND mcp_server_id=?',JSON.stringify({tool_allowlist:['allowed']}),id);
    expect((await request('executor','POST','/execution/authorize',payload)).status).toBe(403);
    await db.run('UPDATE mcp_servers SET enabled=0 WHERE id=?',id);
    expect((await request('executor','POST','/execution/authorize',{...payload,tool_name:'allowed'})).status).toBe(403);
  });
  it('keeps existing writes project scoped when all-project observation is added',async()=>{
    const db=getDb();
    await db.run("INSERT INTO tasks(id,tenant_id,project_id,workflow_id,title) VALUES(2001,1,101,201,'Agency task'),(2002,1,301,202,'Trader task')");
    await replaceAgentMcpPermissionPolicy(db,11,['projects.read_all','tasks.manage_project_tasks']);
    expect((await request('observer','PUT','/tasks/2001',{priority:'high'})).status).toBe(200);
    expect((await request('observer','PUT','/tasks/2002',{priority:'high'})).status).toBe(403);
  });
  it('returns bounded project context with persisted latest-run evidence and tenant checks',async()=>{
    const db=getDb();
    await db.run("INSERT INTO tasks(id,tenant_id,project_id,workflow_id,title,status) VALUES(2001,1,301,202,'First','blocked'),(2002,1,301,202,'Second','done')");
    await db.run("INSERT INTO job_instances(agent_id,tenant_id,task_id,status) VALUES(13,1,2002,'done')");
    const context=await projectContext(db,1,301,1);
    expect(context.status_counts).toEqual([{status:'blocked',count:1},{status:'done',count:1}]);
    expect(context.recent_tasks).toHaveLength(1);expect(context.attention).toHaveLength(1);
    expect((context.recent_tasks[0] as any).latest_instance_status).toBe('done');
    await expect(projectContext(db,1,401)).rejects.toThrow('not found');
    await expect(projectContext(db,1,301,1000)).rejects.toThrow('limit');
  });
});
