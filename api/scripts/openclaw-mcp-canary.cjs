/* Opt-in compatibility test. Uses an isolated state directory and a local fake model. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ahq-openclaw-canary-'));
const state = path.join(root, 'state');
const cli = process.env.OPENCLAW_CANARY_BIN || 'openclaw';
const { openClawMcpBundleId: pluginId, openClawMcpServerPrefix: prefix, openClawMcpServerName: serverName, ensureOpenClawMcpWorkspaceBundleEnabled: activate } = require('../dist/runtimes/mcpMaterialization');
const workspace = agent => path.join(root, agent);
const requests = [];
let releaseHeldResponse;
let heldRequest = false;
let heldToolRequested = false;
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, JSON.stringify(value, null, 2)); };
const listen = server => new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',()=>resolve(server.address().port)); });
const fakeModel = http.createServer(async (req,res) => {
  let body=''; for await (const chunk of req) body+=chunk;
  if (req.method === 'GET') { res.end(JSON.stringify({data:[]})); return; }
  const parsed=JSON.parse(body); requests.push(parsed); fs.writeFileSync(path.join(root,'last-model-request.json'),JSON.stringify(parsed,null,2));
  if (!heldRequest && JSON.stringify(parsed.messages).includes('HOLD_CANARY')) { heldRequest=true; await new Promise(resolve=>{releaseHeldResponse=resolve;}); }
  res.writeHead(200, {'content-type':'text/event-stream'});
  if (!heldToolRequested && JSON.stringify(parsed.messages).includes('HOLD_TOOL_CANARY')) {
    const name = parsed.tools?.find(t => t.function?.name.includes('fixture_'))?.function.name;
    assert(name, 'held-tool fixture needs an advertised MCP tool'); heldToolRequested = true;
    for (const choice of [{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'held_fixture',type:'function',function:{name,arguments:'{}'}}]},finish_reason:null},{index:0,delta:{},finish_reason:'tool_calls'}]) {
      res.write('data: '+JSON.stringify({id:'held-tool',object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'fixture',choices:[choice]})+'\n\n');
    }
    res.end('data: [DONE]\n\n');return;
  }
  for (const choice of [{index:0,delta:{role:'assistant',content:'canary complete'},finish_reason:null},{index:0,delta:{},finish_reason:'stop'}]) {
    res.write('data: '+JSON.stringify({id:'canary-'+requests.length,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'fixture',choices:[choice]})+'\n\n');
  }
  res.end('data: [DONE]\n\n');
});
let gateway;
let env;
const callOnce = (args, timeout=90000) => new Promise((resolve,reject)=>{
  const child=spawn(cli,args,{env,stdio:['ignore','pipe','pipe']});
  let out=''; let err='';
  child.stdout.on('data',b=>out+=b); child.stderr.on('data',b=>err+=b);
  const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
  child.once('error',reject);
  child.once('close',(code)=>{
    clearTimeout(timer);if(code===0){resolve(out);return;}
    const failure=new Error(`${args.slice(0,3).join(' ')} failed (${code}): ${(err+'\n'+out).slice(-4500)}`);
    try {failure.gatewayFailure=JSON.parse(out.slice(out.indexOf('{'),out.lastIndexOf('}')+1)).error;}catch{}
    reject(failure);
  });
});
const call=async(args,timeout)=>{
  for(let attempt=0;;attempt++) {
    try{return await callOnce(args,timeout);}catch(error){
      const failure=error.gatewayFailure;
      const maintenance=args[0]==='plugins'&&args[1]==='reload'||args[0]==='gateway'&&['plugins.refresh','plugins.reload'].includes(args[2]);
      if(!maintenance||attempt>=2||failure?.retryable!==true||failure.details?.runtime?.committed===true)throw error;
      await new Promise(resolve=>setTimeout(resolve,Math.min(5000,Math.max(1000,failure.retryAfterMs||0))));
    }
  }
};
function bundle(agent, version, servers=true, options={}) {
  const base=path.join(root,agent,'.openclaw','extensions','agent-hq-mcp');
  writeJson(path.join(base,'.claude-plugin','plugin.json'),{name:pluginId(workspace(agent)),version:'1.0.0',mcpServers:['.mcp.json']});
  writeJson(path.join(base,'.mcp.json'),{mcpServers:servers?{...(options.extra ? {[serverName(workspace(agent), 'second')]:{command:process.execPath,args:[path.join(root,'server.cjs'),'extra'],env:{FIXTURE_CREDENTIAL:'extra'}}}:{}),[serverName(workspace(agent), 'fixture')]:{command:process.execPath,args:[path.join(root,'server.cjs'),version],env:{FIXTURE_CREDENTIAL:options.credential || version},...(options.exclude?{toolFilter:{exclude:['fixture_*']}}:{})}}:{}});
}
(async()=>{
  const modelPort=await listen(fakeModel);
  const socket=http.createServer(); const gatewayPort=await listen(socket); await new Promise(r=>socket.close(r));
  env={PATH:process.env.PATH,USER:process.env.USER,LANG:'en_US.UTF-8',OPENCLAW_STATE_DIR:state,OPENCLAW_HOME:state,OPENCLAW_CONFIG_PATH:path.join(state,'openclaw.json'),OPENCLAW_GATEWAY_TOKEN:'isolated-canary-token',OPENCLAW_NO_RESPAWN:'1',OPENCLAW_SKIP_CHANNELS:'1',OPENCLAW_HIDE_BANNER:'1',OPENCLAW_SUPPRESS_NOTES:'1'};
  fs.writeFileSync(path.join(root,'server.cjs'),`const readline=require('node:readline'); const version=process.argv[2]; readline.createInterface({input:process.stdin}).on('line',line=>{ const m=JSON.parse(line); if(m.id===undefined)return; let result; if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}; else if(m.method==='tools/list')result={tools:[{name:'fixture_'+version+'_'+process.env.FIXTURE_CREDENTIAL,description:'Read-only fixture',inputSchema:{type:'object',properties:{}}}]}; else if(m.method==='tools/call'){if(require('node:fs').existsSync(${JSON.stringify(path.join(root,'hold-tool'))})){require('node:fs').writeFileSync(${JSON.stringify(path.join(root,'tool-held'))},'held');const timer=setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(path.join(root,'release-tool'))})){clearInterval(timer);console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:version}]}}));}},100);return;}result={content:[{type:'text',text:version}]};} else result={}; console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result})); });`);
  bundle('a','one'); bundle('b','other');
  writeJson(env.OPENCLAW_CONFIG_PATH,{
    gateway:{mode:'local',port:gatewayPort,bind:'loopback',auth:{mode:'token',token:'isolated-canary-token'},controlUi:{enabled:false}},
    agents:{ownership:'explicit',defaults:{model:{primary:'fixture/fixture'},workspace:path.join(root,'a'),skipBootstrap:true},entries:{a:{workspace:path.join(root,'a')},b:{workspace:path.join(root,'b')}}},
    plugins:{entries:{[pluginId(workspace('a'))]:{enabled:true},[pluginId(workspace('b'))]:{enabled:true}},slots:{memory:'none'}},
    models:{mode:'replace',providers:{fixture:{api:'openai-completions',baseUrl:`http://127.0.0.1:${modelPort}/v1`,apiKey:'fixture-token',models:[{id:'fixture',name:'Fixture',contextWindow:64000,maxTokens:1000,reasoning:false,input:['text']}]}}},
    tools:{profile:'full',toolSearch:false},
  });
  for (const agent of ['a','b']) assert(activate(env.OPENCLAW_CONFIG_PATH,pluginId(workspace(agent))).ok);
  await call(['plugins','registry','--refresh','--json']);
  console.log('PASS: asynchronous registry fallback accepts scoped bundles');
  const log=fs.openSync(path.join(root,'gateway.log'),'w');
  gateway=spawn(cli,['gateway','run','--port',String(gatewayPort)],{env,stdio:['ignore',log,log]});
  fs.closeSync(log);
  for(let i=0;i<60;i++) { if(gateway.exitCode!==null)throw new Error(fs.readFileSync(path.join(root,'gateway.log'),'utf8').slice(-5000)); try { const r=await fetch(`http://127.0.0.1:${gatewayPort}/health`);if(r.ok)break; }catch{} if(i===59)throw new Error('gateway startup timeout'); await new Promise(r=>setTimeout(r,1000)); }
  if (process.env.OPENCLAW_CANARY_RECOVERY_ONLY !== '1') {
  const run=async(agent,expected)=>{
    // Match Agent HQ's existing admission step for both fresh and reused sessions.
    await call(['gateway','call','sessions.patch','--params',JSON.stringify({key:`agent:${agent}:main`}), '--json']);
    const count=requests.length;
    await call(['agent','--agent',agent,'--message','Reply canary complete.','--json']);
    const calls=requests.slice(count);
    assert(calls.length>0,'fake model must receive a request');
    // Assert the actual model request. tools.effective is a cached diagnostic view
    // (10s fresh / 120s stale in the tested runtime), not an admission receipt.
    const names=calls.flatMap(request=>(request.tools||[]).map(tool=>tool.function?.name||tool.name));
    assert(!names.some(n=>n.startsWith(prefix(workspace(agent==='a'?'b':'a')))), 'foreign agent tools leaked');
    if(expected)for(const value of Array.isArray(expected)?expected:[expected])assert(names.some(n=>n.includes(value)),`expected ${value}, got ${names.join(', ')}`);
    else assert(!names.some(n=>n.includes('fixture_')),`removed tools still present: ${names.join(', ')}`);
    console.log('PASS',agent,expected||'last server removed');
  };
  await run('a','one_one');
  await run('b','other_other');
  bundle('a','two');
  console.log('Applying gateway reload');
  const receipt=await call(['plugins','reload',pluginId(workspace('a')),'--json']);
  console.log('Reload receipt',receipt.slice(-1500));
  await run('a','two_two');
  await run('b','other_other');
  const held=call(['agent','--agent','a','--message','HOLD_CANARY','--json']);
  for(let i=0;!heldRequest&&i<100;i++)await new Promise(r=>setTimeout(r,100));
  assert(heldRequest,'agent A must be active during agent B update');
  bundle('b','next');
  await call(['plugins','reload',pluginId(workspace('b')),'--json']);
  assert(releaseHeldResponse,'active agent A must remain pending during reload');
  releaseHeldResponse(); releaseHeldResponse=null;
  await held;
  await run('b','next_next');
  console.log('PASS: unrelated active session survived plugin reload');
  bundle('a','two',true,{credential:'rotated'});
  await call(['plugins','reload',pluginId(workspace('a')),'--json']);
  await run('a','two_rotated');
  bundle('a','two',true,{exclude:true});
  await call(['plugins','reload',pluginId(workspace('a')),'--json']);
  await call(['gateway','call','sessions.reset','--params',JSON.stringify({key:'agent:a:main'}),'--json']);
  await run('a',null);
  bundle('a','two',false);
  await call(['plugins','reload',pluginId(workspace('a')),'--json']);
  await call(['gateway','call','sessions.reset','--params',JSON.stringify({key:'agent:a:main'}),'--json']);
  await run('a',null);
  bundle('a','membership',true,{extra:true});
  await call(['gateway','call','plugins.refresh','--params','{}','--json']);
  await call(['plugins','reload',pluginId(workspace('a')),'--json']);
  await run('a',['membership_membership','extra_extra']);
  bundle('a','membership');
  await call(['gateway','call','plugins.refresh','--params','{}','--json']);
  await call(['plugins','reload',pluginId(workspace('a')),'--json']);
  await run('a','membership_membership');
  console.log('PASS: add and remove individual MCP servers');

  bundle('c','new_bundle');
  let config = JSON.parse(fs.readFileSync(env.OPENCLAW_CONFIG_PATH));
  config.agents.entries.c={workspace:workspace('c')};
  config.plugins.entries[pluginId(workspace('c'))]={enabled:true};
  writeJson(env.OPENCLAW_CONFIG_PATH,config);
  assert(activate(env.OPENCLAW_CONFIG_PATH,pluginId(workspace('c'))).ok);
  await call(['gateway','call','plugins.refresh','--params','{}','--json']);
  await run('c','new_bundle_new_bundle');
  config=JSON.parse(fs.readFileSync(env.OPENCLAW_CONFIG_PATH));
  config.plugins.entries[pluginId(workspace('c'))]={enabled:false};
  writeJson(env.OPENCLAW_CONFIG_PATH,config);
  fs.renameSync(path.join(workspace('c'),'.openclaw','extensions','agent-hq-mcp'),path.join(root,'removed-c-bundle'));
  await call(['gateway','call','plugins.refresh','--params','{}','--json']);
  const inventoryText=await call(['gateway','call','plugins.list','--params','{}','--json']);
  const inventory=JSON.parse(inventoryText.slice(inventoryText.indexOf('{'),inventoryText.lastIndexOf('}')+1));
  assert(!(inventory.plugins||[]).some(p=>p.id===pluginId(workspace('c'))&&p.runtime?.state==='active'));
  console.log('PASS: new and removed bundle metadata through the running gateway');

  if (process.env.OPENCLAW_CANARY_BUSY_PLUGIN === '1') {
    fs.writeFileSync(path.join(root,'hold-tool'),'1');
    const heldToolStart=requests.length;
    let reloadedWhileBusy=false;
    const heldTool=call(['agent','--agent','a','--message','HOLD_TOOL_CANARY: call the fixture tool, then reply done.','--json'],180000);
    heldTool.catch(()=>{});
    try {
      for(let i=0;!fs.existsSync(path.join(root,'tool-held'))&&i<600;i++)await new Promise(r=>setTimeout(r,100));
      assert(fs.existsSync(path.join(root,'tool-held')),'real MCP tool must be in flight');
      bundle('a','after_drain');
      try {
        const raw=await call(['plugins','reload',pluginId(workspace('a')),'--json']);
        const receipt=JSON.parse(raw.slice(raw.indexOf('{'),raw.lastIndexOf('}')+1));
        assert.equal(receipt.ok,true);assert(receipt.runtime.pluginIds.includes(pluginId(workspace('a'))));
        reloadedWhileBusy=true;
      } catch(error) {
        assert.match(error.message,/did not settle|drain|within 60s/);
        console.log('PASS: busy affected plugin refused reload at its drain deadline');
      }
    } finally { fs.writeFileSync(path.join(root,'release-tool'),'1'); }
    await heldTool;
    assert(requests.slice(heldToolStart).some(request=>request.messages?.some(message=>message.role==='tool'&&JSON.stringify(message.content).includes('membership'))), 'in-flight MCP call must return its original-generation result');
    if(reloadedWhileBusy)console.log('PASS: affected in-flight MCP call completed with its original result across reload (no drain timeout triggered)');
    else await call(['plugins','reload',pluginId(workspace('a')),'--json']);
    await run('a','after_drain_after_drain');
  }

  }

  // Full Agent HQ reconciliation against this real isolated gateway and a disposable database.
  if (process.env.AGENT_HQ_TEST_PG_URL) {
    await new Promise((resolve,reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, 'openclaw-mcp-reconcile-canary.cjs'), root], {
        env: { ...process.env, ...env, OPENCLAW_BIN: cli, GATEWAY_WS_URL: `ws://127.0.0.1:${gatewayPort}`,
          OPENCLAW_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`, AGENT_HQ_ALLOWED_OPENCLAW_BINARIES: path.isAbsolute(cli) ? cli : '' },
        stdio: ['ignore','inherit','inherit','ipc'],
      });
      child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(`reconciliation canary failed (${code})`)));
      child.on('message', async message => {
        if(message !== 'restart-fixture-gateway') return;
        try {
          await new Promise((resolve,reject) => {
            const timer=setTimeout(()=>reject(new Error('fixture gateway stop timed out')),10000);
            gateway.once('close',()=>{clearTimeout(timer);resolve();});gateway.kill('SIGTERM');
          });
          const log=fs.openSync(path.join(root,'gateway.log'),'a');
          gateway=spawn(cli,['gateway','run','--port',String(gatewayPort)],{env,stdio:['ignore',log,log]});fs.closeSync(log);
          for(let i=0;i<60;i++) {
            if(gateway.exitCode!==null)throw new Error('fixture gateway restart failed');
            try {if((await fetch(`http://127.0.0.1:${gatewayPort}/health`)).ok)break;}catch{}
            if(i===59)throw new Error('fixture gateway restart timed out');
            await new Promise(resolve=>setTimeout(resolve,1000));
          }
          child.send('fixture-gateway-restarted');
        } catch(error) { child.kill('SIGTERM');reject(error); }
      });
    });
  }
  console.log('PASS: gateway compatibility canary; evidence:', root);
})().catch(e=>{console.error(e.message);console.error('Fixture evidence:',root);process.exitCode=1;}).finally(async()=>{
  if(releaseHeldResponse)releaseHeldResponse();
  if(gateway&&gateway.exitCode===null){gateway.kill('SIGTERM');await new Promise(resolve=>{const t=setTimeout(()=>{gateway.kill('SIGKILL');resolve();},5000);gateway.once('close',()=>{clearTimeout(t);resolve();});});}
  await new Promise(resolve=>fakeModel.close(resolve));
});
