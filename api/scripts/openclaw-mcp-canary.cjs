/* Opt-in compatibility test. Uses an isolated state directory and a local fake model. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ahq-openclaw-canary-'));
const state = path.join(root, 'state');
const cli = process.env.OPENCLAW_CANARY_BIN || '/Users/nordini/.nvm/versions/node/v24.18.0/bin/openclaw';
const { openClawMcpBundleId: pluginId, openClawMcpServerPrefix: prefix, openClawMcpServerName: serverName, ensureOpenClawMcpWorkspaceBundleEnabled: activate } = require('../dist/runtimes/mcpMaterialization');
const workspace = agent => path.join(root, agent);
const requests = [];
let releaseHeldResponse;
let heldRequest = false;
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, JSON.stringify(value, null, 2)); };
const listen = server => new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',()=>resolve(server.address().port)); });
const fakeModel = http.createServer(async (req,res) => {
  let body=''; for await (const chunk of req) body+=chunk;
  if (req.method === 'GET') { res.end(JSON.stringify({data:[]})); return; }
  const parsed=JSON.parse(body); requests.push(parsed);
  if (!heldRequest && JSON.stringify(parsed.messages).includes('HOLD_CANARY')) { heldRequest=true; await new Promise(resolve=>{releaseHeldResponse=resolve;}); }
  res.writeHead(200, {'content-type':'text/event-stream'});
  for (const choice of [{index:0,delta:{role:'assistant',content:'canary complete'},finish_reason:null},{index:0,delta:{},finish_reason:'stop'}]) {
    res.write('data: '+JSON.stringify({id:'canary-'+requests.length,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'fixture',choices:[choice]})+'\n\n');
  }
  res.end('data: [DONE]\n\n');
});
let gateway;
let env;
const call = (args, timeout=90000) => new Promise((resolve,reject)=>{
  const child=spawn(cli,args,{env,stdio:['ignore','pipe','pipe']});
  let out=''; let err='';
  child.stdout.on('data',b=>out+=b); child.stderr.on('data',b=>err+=b);
  const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
  child.once('error',reject);
  child.once('close',(code)=>{clearTimeout(timer);code===0?resolve(out):reject(new Error(`${args.slice(0,3).join(' ')} failed (${code}): ${(err+'\n'+out).slice(-4500)}`));});
});
function bundle(agent, version, servers=true, options={}) {
  const base=path.join(root,agent,'.openclaw','extensions','agent-hq-mcp');
  writeJson(path.join(base,'.claude-plugin','plugin.json'),{name:pluginId(workspace(agent)),version:'1.0.0',mcpServers:['.mcp.json']});
  writeJson(path.join(base,'.mcp.json'),{mcpServers:servers?{[serverName(workspace(agent), 'fixture')]:{command:process.execPath,args:[path.join(root,'server.cjs'),version],env:{FIXTURE_CREDENTIAL:options.credential || version},...(options.exclude?{toolFilter:{exclude:['fixture_*']}}:{})}}:{}});
}
(async()=>{
  const modelPort=await listen(fakeModel);
  const socket=http.createServer(); const gatewayPort=await listen(socket); await new Promise(r=>socket.close(r));
  env={PATH:process.env.PATH,USER:process.env.USER,LANG:'en_US.UTF-8',OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:path.join(state,'openclaw.json'),OPENCLAW_GATEWAY_TOKEN:'isolated-canary-token',OPENCLAW_NO_RESPAWN:'1',OPENCLAW_SKIP_CHANNELS:'1',OPENCLAW_HIDE_BANNER:'1',OPENCLAW_SUPPRESS_NOTES:'1'};
  fs.writeFileSync(path.join(root,'server.cjs'),`const readline=require('node:readline'); const version=process.argv[2]; readline.createInterface({input:process.stdin}).on('line',line=>{ const m=JSON.parse(line); if(m.id===undefined)return; let result; if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}; else if(m.method==='tools/list')result={tools:[{name:'fixture_'+version+'_'+process.env.FIXTURE_CREDENTIAL,description:'Read-only fixture',inputSchema:{type:'object',properties:{}}}]}; else if(m.method==='tools/call')result={content:[{type:'text',text:version}]}; else result={}; console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result})); });`);
  bundle('a','one'); bundle('b','other');
  writeJson(env.OPENCLAW_CONFIG_PATH,{
    gateway:{mode:'local',port:gatewayPort,bind:'loopback',auth:{mode:'token',token:'isolated-canary-token'},controlUi:{enabled:false}},
    agents:{ownership:'explicit',defaults:{model:{primary:'fixture/fixture'},workspace:path.join(root,'a'),skipBootstrap:true},entries:{a:{workspace:path.join(root,'a')},b:{workspace:path.join(root,'b')}}},
    plugins:{entries:{[pluginId(workspace('a'))]:{enabled:true},[pluginId(workspace('b'))]:{enabled:true}},slots:{memory:'none'}},
    models:{mode:'replace',providers:{fixture:{api:'openai-completions',baseUrl:`http://127.0.0.1:${modelPort}/v1`,apiKey:'fixture-token',models:[{id:'fixture',name:'Fixture',contextWindow:64000,maxTokens:1000,reasoning:false,input:['text']}]}}},
    tools:{profile:'full'},
  });
  for (const agent of ['a','b']) assert(activate(env.OPENCLAW_CONFIG_PATH,pluginId(workspace(agent))).ok);
  await call(['plugins','registry','--refresh','--json']);
  console.log('PASS: asynchronous registry fallback accepts scoped bundles');
  const log=fs.openSync(path.join(root,'gateway.log'),'w');
  gateway=spawn(cli,['gateway','run','--port',String(gatewayPort)],{env,stdio:['ignore',log,log]});
  fs.closeSync(log);
  for(let i=0;i<60;i++) { if(gateway.exitCode!==null)throw new Error(fs.readFileSync(path.join(root,'gateway.log'),'utf8').slice(-5000)); try { const r=await fetch(`http://127.0.0.1:${gatewayPort}/health`);if(r.ok)break; }catch{} if(i===59)throw new Error('gateway startup timeout'); await new Promise(r=>setTimeout(r,1000)); }
  const run=async(agent,expected)=>{
    const count=requests.length;
    await call(['agent','--agent',agent,'--message','Reply canary complete.','--json']);
    const calls=requests.slice(count);
    assert(calls.length>0,'fake model must receive a request');
    const effective=await call(['gateway','call','tools.effective','--params',JSON.stringify({sessionKey:`agent:${agent}:main`,agentId:agent}),'--json']);
    const payload=JSON.parse(effective.slice(effective.indexOf('{'),effective.lastIndexOf('}')+1));
    const names=(payload.groups||[]).flatMap(g=>(g.tools||[]).map(t=>t.id||t.name));
    if(!names.length)console.log('Effective catalog',JSON.stringify(payload).slice(-3500));
    assert(!names.some(n=>n.startsWith(prefix(workspace(agent==='a'?'b':'a')))), 'foreign agent tools leaked');
    if(expected)assert(names.some(n=>n.includes(expected)),`expected ${expected}, got ${names.join(', ')}`);
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
  console.log('PASS: gateway compatibility canary; evidence:', root);
})().catch(e=>{console.error(e.message);console.error('Fixture evidence:',root);process.exitCode=1;}).finally(async()=>{
  if(releaseHeldResponse)releaseHeldResponse();
  if(gateway&&gateway.exitCode===null){gateway.kill('SIGTERM');await new Promise(resolve=>{const t=setTimeout(()=>{gateway.kill('SIGKILL');resolve();},5000);gateway.once('close',()=>{clearTimeout(t);resolve();});});}
  await new Promise(resolve=>fakeModel.close(resolve));
});
