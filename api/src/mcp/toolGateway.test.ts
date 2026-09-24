import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createToolGateway } from './toolGateway';

test('Agent HQ filters discovery and rejects a direct call to an ungranted tool before upstream execution', async () => {
  const source = new McpServer({ name: 'crm', version: '1' });
  let executions = 0;
  for (const name of ['correction', 'submission']) source.registerTool(name, {}, async () => {
    executions++;
    return { content: [{ type: 'text', text: name }] };
  });
  const upstream = new Client({ name: 'upstream', version: '1' });
  const [upClient, upServer] = InMemoryTransport.createLinkedPair();
  await source.connect(upServer); await upstream.connect(upClient);
  const gateway = createToolGateway(upstream, ['correction']);
  const client = new Client({ name: 'agent', version: '1' });
  const [downClient, downServer] = InMemoryTransport.createLinkedPair();
  await gateway.connect(downServer); await client.connect(downClient);
  try {
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['correction']);
    expect((await client.callTool({ name: 'submission' })).isError).toBe(true);
    expect(executions).toBe(0);
    expect((await client.callTool({ name: 'correction' })).isError).not.toBe(true);
    expect(executions).toBe(1);
  } finally { await client.close(); await gateway.close(); await upstream.close(); await source.close(); }
});
