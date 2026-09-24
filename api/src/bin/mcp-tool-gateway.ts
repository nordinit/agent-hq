#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createToolGateway } from '../mcp/toolGateway';

async function main() {
  const config = JSON.parse(process.env.AGENT_HQ_MCP_UPSTREAM ?? '{}');
  if (typeof config.command !== 'string' || !Array.isArray(config.args)
      || !config.args.every((arg: unknown) => typeof arg === 'string')
      || !Array.isArray(config.allowedTools) || !config.allowedTools.every((name: unknown) => typeof name === 'string')) {
    throw new Error('Invalid Agent HQ MCP gateway configuration');
  }
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete env.AGENT_HQ_MCP_UPSTREAM;
  const upstream = new Client({ name: 'agent-hq-tool-gateway', version: '1' });
  await upstream.connect(new StdioClientTransport({ command: config.command, args: config.args, cwd: config.cwd, env, stderr: 'inherit' }));
  const server = createToolGateway(upstream, config.allowedTools);
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
