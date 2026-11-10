#!/usr/bin/env node
import {agentRunHeaders,runIdentitySourceFromEnv} from '../lib/agentRunIdentity';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createToolGateway } from '../mcp/toolGateway';
import {sanitizedRuntimeProcessEnv} from '../runtimes/environment';

async function main() {
  const config = JSON.parse(process.env.AGENT_HQ_MCP_UPSTREAM ?? '{}');
  if (typeof config.command !== 'string' || !Array.isArray(config.args)
      || !config.args.every((arg: unknown) => typeof arg === 'string')
      || (config.allowedTools!==null && (!Array.isArray(config.allowedTools) || !config.allowedTools.every((name: unknown) => typeof name === 'string')))) {
    throw new Error('Invalid Agent HQ MCP gateway configuration');
  }
  const env:NodeJS.ProcessEnv={...sanitizedRuntimeProcessEnv()};
  for(const key of ['AGENT_HQ_INSTANCE_ID','AGENT_HQ_DURABLE_RUN_ID','AGENT_HQ_RUN_IDENTITY_FILE'])if(process.env[key])env[key]=process.env[key];
  Object.assign(env,config.env??{});
  const identity=runIdentitySourceFromEnv(process.env);
  const authorize=async(phase:'launch'|'call',toolName?:string)=>{
    const base=process.env.AGENT_HQ_INTERNAL_BASE_URL??'http://127.0.0.1:3501';
    const url=new URL(base);if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Invalid execution broker.');
    const response=await fetch(base.replace(/\/$/,'')+'/api/v1/execution/authorize',{method:'POST',headers:{authorization:'Bearer '+process.env.AGENT_HQ_EXECUTION_API_KEY,'content-type':'application/json',...agentRunHeaders(identity())},body:JSON.stringify({resource_kind:'mcp_server',resource_id:Number(process.env.AGENT_HQ_EXECUTION_SERVER_ID),revision_id:process.env.AGENT_HQ_EXECUTION_REVISION_ID,phase,tool_name:toolName}),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('MCP execution grant was denied or revoked.');
  };
  await authorize('launch');
  const upstream = new Client({ name: 'agent-hq-tool-gateway', version: '1' });
  await upstream.connect(new StdioClientTransport({ command: config.command, args: config.args, cwd: config.cwd, env:env as Record<string,string>, stderr: 'inherit' }));
  const server = createToolGateway(upstream, config.allowedTools,toolName=>authorize('call',toolName));
  await server.connect(new StdioServerTransport());
  const close = async () => { await upstream.close(); process.exit(0); };
  server.onclose = () => void close();
  process.on('SIGTERM', () => void close());
  process.on('SIGINT', () => void close());
}

main().catch(() => {
  // Never print launch configuration or credentials.
  console.error('Agent HQ MCP tool gateway failed to start');
  process.exitCode = 1;
});
