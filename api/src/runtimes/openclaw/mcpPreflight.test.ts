import fs from 'fs';
import os from 'os';
import path from 'path';
import { probeOpenClawMcpBundle } from './mcpPreflight';

describe('OpenClaw exact bundle preflight', () => {
  let root: string;
  let bundlePath: string;
  let server: Record<string, unknown>;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ahq-exact-probe-'));
    bundlePath = path.join(root, '.mcp.json');
    const script = path.join(root, 'fixture.cjs');
    fs.writeFileSync(script, `const rl=require('readline').createInterface({input:process.stdin});
      rl.on('line',line=>{ const m=JSON.parse(line); if(!m.id)return;
        const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:
        {tools:[{name:process.env.FIXTURE_TOOL,inputSchema:{type:'object'}}]};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n'); });`);
    server = { command: process.execPath, args: [script], env: { FIXTURE_TOOL: 'read_current' } };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  function probe(required = ['read_current']) {
    fs.writeFileSync(bundlePath, JSON.stringify({ agentHqServerNames: { crm: 'ahq-test-crm' }, mcpServers: { 'ahq-test-crm': server } }));
    return probeOpenClawMcpBundle({ bundlePath, workingDirectory: root, serverNames: ['crm'], requiredToolsByServerName: { crm: required } });
  }
  it('launches the aliased bundle command and credential environment without a global registry', async () => {
    await expect(probe()).resolves.toBeUndefined();
  });
  it('fails when the exact server does not advertise required tools', async () => {
    await expect(probe(['read_missing'])).rejects.toThrow('read_missing');
  });
  it('honors wildcard include and exclude filters before launch', async () => {
    server.toolFilter = { include: ['read_*'] };
    await expect(probe()).resolves.toBeUndefined();
    server.toolFilter = { include: ['*'], exclude: ['read_*'] };
    await expect(probe()).rejects.toThrow('filters required');
  });
  it('rejects malformed or absent bundle configuration', async () => {
    fs.writeFileSync(bundlePath, '{bad');
    await expect(probeOpenClawMcpBundle({ bundlePath, workingDirectory: root, serverNames: ['crm'], requiredToolsByServerName: {} })).rejects.toThrow();
  });
});
