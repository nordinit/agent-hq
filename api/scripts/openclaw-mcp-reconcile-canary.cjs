/* Called only by the isolated gateway fixture. Uses disposable PostgreSQL databases. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const { PostgresAdapter } = require('../dist/db/adapter/PostgresAdapter');
const fixtures = require('../dist/db/pg/testFixture');
const gateway = require('../dist/runtimes/openclaw/gatewayClient');
const calls = [];
const originalRpc = gateway.gatewayRpcCall;
const mode = process.argv[3];
gateway.gatewayRpcCall = async params => {
  if (params.method.startsWith('plugins.')) calls.push(params.method);
  const result = await originalRpc(params);
  if (mode === 'crash-after-publication' && params.method === 'plugins.reload' && result.ok) process.exit(87);
  return result;
};
const { reconcileOpenClawMcp, resetOpenClawMcpReconciliationForTests } = require('../dist/services/openclawMcpReconciliation');
const root = process.argv[2];
assert(root && path.basename(root).startsWith('ahq-openclaw-canary-'), 'must use an isolated fixture');
assert(path.resolve(process.env.OPENCLAW_STATE_DIR).startsWith(path.resolve(root) + path.sep));
process.env.AGENT_HQ_OPENCLAW_MCP_RECONCILIATION_MODE = 'on-change';
let db;
let pool;
const child = (childMode, databaseUrl) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [__filename, root, childMode], {
    env: { ...process.env, OPENCLAW_CANARY_DATABASE_URL: databaseUrl }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; p.stdout.on('data', b => output += b); p.stderr.on('data', b => output += b);
  const timer = setTimeout(() => p.kill('SIGKILL'), 120000);
  p.once('error', reject); p.once('close', code => { clearTimeout(timer); code === 87 ? resolve() : reject(new Error('crash fixture failed: ' + output.slice(-2500))); });
});
async function waitForGateway() {
  const deadline=Date.now()+45000;
  let response;
  do {
    response=await originalRpc({method:'health',timeoutMs:5000});
    if(response.ok)return;
    await new Promise(resolve=>setTimeout(resolve,500));
  } while(Date.now()<deadline);
  throw new Error(response.error||'fixture gateway RPC readiness timed out');
}
(async () => {
  if (mode) {
    const url = process.env.OPENCLAW_CANARY_DATABASE_URL;
    assert(new URL(url).pathname.startsWith('/agent_hq_test_'), 'must use a disposable test database');
    pool = new Pool({ connectionString: url }); db = new PostgresAdapter(pool);
  } else {
    db = await fixtures.getTestDb();
    await db.run("INSERT INTO tenants (id,name,slug,is_default) VALUES (1,'Canary','canary',1)");
    await db.run("INSERT INTO agents (id,tenant_id,name,session_key) VALUES (1,1,'Canary A','agent:a:main')");
  }
  const bundlePath = path.join(root, 'a', '.openclaw', 'extensions', 'agent-hq-mcp', '.mcp.json');
  const bundlePluginId = JSON.parse(fs.readFileSync(path.join(path.dirname(bundlePath), '.claude-plugin', 'plugin.json'))).name;
  const input = { db, agentId: 1, bundlePath, bundlePluginId, configPath: process.env.OPENCLAW_CONFIG_PATH };
  if (mode === 'crash-before-rpc') {
    const run = db.run.bind(db);
    db.run = async (...args) => { const result = await run(...args); if (args[0].includes('INSERT INTO openclaw_mcp_reconciliation')) process.exit(87); return result; };
  }
  if (mode) { await reconcileOpenClawMcp({ ...input, force: true }); throw new Error('fixture did not crash'); }
  await waitForGateway();
  await reconcileOpenClawMcp(input);
  assert.deepEqual(calls, ['plugins.refresh', 'plugins.reload']);
  const before = fs.statSync(bundlePath).mtimeMs;
  for (let i = 0; i < 10; i++) await reconcileOpenClawMcp(input);
  assert.equal(calls.length, 2); assert.equal(fs.statSync(bundlePath).mtimeMs, before);
  console.log('PASS: real reconciliation skips ten unchanged admissions without refresh/reload');
  if (process.send) {
  const countBeforeRestart=calls.length;
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('fixture restart response timed out')),90000);
    process.once('message',message=>{clearTimeout(timer);message==='fixture-gateway-restarted'?resolve():reject(new Error('unexpected fixture response'));});
    process.send('restart-fixture-gateway');
  });
  gateway.__resetGatewayConnectionPoolForTests();
  await waitForGateway();
  await reconcileOpenClawMcp(input);
  assert.equal(calls.length,countBeforeRestart+1);
  assert.equal(calls.at(-1),'plugins.reload');
  console.log('PASS: real gateway restart invalidates the cached receipt and re-establishes admission');
  } else console.log('SKIP: standalone helper has no fixture gateway restart controller');
  await child('crash-before-rpc', fixtures.workerDatabaseUrl());
  resetOpenClawMcpReconciliationForTests(); await reconcileOpenClawMcp(input);
  console.log('PASS: killed process before RPC recovers its persisted pending revision');
  await child('crash-after-publication', fixtures.workerDatabaseUrl());
  resetOpenClawMcpReconciliationForTests(); const count = calls.length;
  await assert.rejects(reconcileOpenClawMcp(input), /interrupted after mutation began/);
  assert.equal(calls.length, count);
  // Explicit fixture recovery after inspecting the actual runtime; never a business action.
  assert.equal((await originalRpc({ method: 'plugins.list', rpcParams: {} })).ok, true);
  await reconcileOpenClawMcp({ ...input, force: true });
  console.log('PASS: killed process after publication is held until inspected and explicitly reconciled');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  gateway.__resetGatewayConnectionPoolForTests();
  if (process.connected) process.disconnect();
  if (pool) await pool.end();
  else await fixtures.dropWorkerDatabase();
});
