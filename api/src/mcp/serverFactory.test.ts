import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentHqApiClient } from './apiClient';
import { buildEffectiveAccess } from './accessView';
import { createAgentHqMcpServer } from './serverFactory';
import { getMcpCatalog } from './catalog';

test('long-lived server refreshes before listing and calling; catalog stays caller-specific', async () => {
  let grants = ['tasks.read_active_context'];
  let unavailable = false;
  const api = {
    getTask: jest.fn(async () => ({ id: 1 })),
    getEffectiveAccess: jest.fn(async () => {
      if (unavailable) throw new Error('Permission lookup unavailable');
      return buildEffectiveAccess({ identity: { agent_id: 1, agent_slug: 'worker', key_id: 1, key_role: 'scoped', tenant_id: 1, project_id: 1 },
        policy_mode: 'explicit', default_policy: 'scoped_runtime', enabled_capabilities: grants, scopes: [] });
    }),
  };
  const server = createAgentHqMcpServer({ api: api as unknown as AgentHqApiClient, hasApiKey: true });
  const notify = jest.spyOn(server, 'sendToolListChanged');
  const client = new Client({ name: 'stdio-access-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const initial = await client.listTools();
    expect(initial.tools.map(tool => tool.name)).toContain('agent_hq_get_task');
    expect(initial.tools.map(tool => tool.name)).not.toContain('agent_hq_delete_task');
    await client.callTool({ name: 'agent_hq_get_task', arguments: { task_id: 1 } });
    expect(api.getTask).toHaveBeenCalledTimes(1);
    grants = [];
    const denied = await client.callTool({ name: 'agent_hq_get_task', arguments: { task_id: 1 } });
    expect(denied.isError).toBe(true);
    expect(api.getTask).toHaveBeenCalledTimes(1);
    expect((await client.listTools()).tools).toEqual([]);
    expect(notify).toHaveBeenCalled();
    grants = ['workflow_definitions.manage_project_scope'];
    const changed = await client.listTools();
    expect(changed.tools.map(tool => tool.name)).toContain('agent_hq_create_workflow_type');
    const resource = await client.readResource({ uri: 'agent-hq://catalog' });
    const content = resource.contents[0];
    if (!('text' in content)) throw new Error('Expected a text resource');
    const catalog = JSON.parse(content.text);
    expect(catalog.tools.map((tool: { canonical_name: string }) => tool.canonical_name).sort()).toEqual(changed.tools.map(tool => tool.name).sort());
    expect(getMcpCatalog().tools.length).toBeGreaterThan(catalog.tools.length);
    unavailable = true;
    await expect(client.listTools()).rejects.toThrow('Permission lookup unavailable');
    await expect(client.readResource({ uri: 'agent-hq://catalog' })).rejects.toThrow('Permission lookup unavailable');
    const failed = await client.callTool({ name: 'agent_hq_get_task', arguments: { task_id: 1 } });
    expect(failed.isError).toBe(true);
    expect(api.getTask).toHaveBeenCalledTimes(1);
  } finally { await client.close(); await server.close(); }
});
