import { buildEffectiveAccess } from '../accessView';
import { z } from 'zod';
import { registerTelemetryTools } from './telemetry';
import type { McpToolHandler, McpToolResult } from '../registrar';
import { AgentHqApiClient } from '../apiClient';
import { telemetryDefinitionExamples } from '../../domains/telemetry/definitionContract';
import { getTelemetryDefinitionContract } from '../../domains/telemetry/definitionContract';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentHqMcpServer } from '../serverFactory';
import { getMcpCatalog } from '../catalog';

function expectResolvableReferences(document: any) {
  const visit = (value: any) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string') {
      expect(value.$ref.startsWith('#')).toBe(true);
      const target = value.$ref === '#' ? document : value.$ref.slice(2).split('/').reduce((node: any, key: string) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], document);
      expect(target).toBeDefined();
    }
    Object.values(value).forEach(visit);
  };
  visit(document);
}

function registry() {
  const api = { telemetryGet: jest.fn(async () => ({ value: 0.5, numerator: 2, denominator: 4 })), telemetryWrite: jest.fn(async () => ({ query_id: 'retained', value: 0.5, numerator: 2, denominator: 4 })) };
  const tools = new Map<string, { handler: McpToolHandler; schema: Record<string, z.ZodTypeAny>; paths: string[] }>();
  registerTelemetryTools({ api: api as unknown as AgentHqApiClient,
    wrap: <T>(fn: () => Promise<T>): (() => Promise<McpToolResult>) => async () => ({ content: [{ type: 'text', text: JSON.stringify(await fn()) }] }),
    registerTool(names, _description, schema, handler, options) { for (const name of names) tools.set(name, { handler, schema, paths: options?.rest_paths ?? [] }); }, registerResource() {},
  });
  return { api, tools };
}

describe('telemetry MCP uses the shared REST API', () => {
  test('query and preview forward the same definition and scoped filters without recalculating values', async () => {
    const { api, tools } = registry();
    const args = { definition: { version: 1, key: 'first_pass' }, scope: { project_id: 86 }, timezone: 'UTC', filter: { field: 'status', op: 'eq', value: 'submitted' } };
    const result = await tools.get('agent_hq_query_telemetry_metrics')!.handler(args);
    expect(api.telemetryWrite).toHaveBeenLastCalledWith('POST', '/queries', args);
    expect(JSON.parse(result.content[0].text)).toEqual({ query_id: 'retained', value: 0.5, numerator: 2, denominator: 4 });
    await tools.get('agent_hq_preview_telemetry_metric')!.handler(args);
    expect(api.telemetryWrite).toHaveBeenLastCalledWith('POST', '/queries/preview', args);
  });
  test('revision writes carry optimistic concurrency and do not mutate the original definition', async () => {
    const { api, tools } = registry();
    await tools.get('agent_hq_revise_telemetry_metric')!.handler({ definition_id: 'metric/one', expected_revision_id: 'old', definition: { key: 'new' } });
    expect(api.telemetryWrite).toHaveBeenCalledWith('POST', '/metrics/metric%2Fone/revisions', { expected_revision_id: 'old', definition: { key: 'new' } });
  });
  test('contributors use the retained query identifier and paging/filter contract', async () => {
    const { api, tools } = registry();
    await tools.get('agent_hq_get_telemetry_contributors')!.handler({ query_id: 'q', offset: 20, limit: 20, included: false });
    expect(api.telemetryGet).toHaveBeenCalledWith('/queries/q/contributors', { offset: 20, limit: 20, included: false });
    expect(z.object(tools.get('agent_hq_get_telemetry_contributors')!.schema).safeParse({ query_id: 'q', limit: 201 }).success).toBe(false);
  });
  test('profile, binding and snapshot writes go through ordinary shared endpoints', async () => {
    const { api, tools } = registry();
    const binding = { family_key: 'quality', scope: { project_id: 86, workflow_id: 42 }, metric_revision_id: 'metric-v1', profile_revision_id: 'profile-v2', expected_version: 3 };
    await tools.get('agent_hq_save_telemetry_binding')!.handler(binding);
    expect(api.telemetryWrite).toHaveBeenLastCalledWith('PUT', '/bindings', binding);
    const preview={family_key:binding.family_key,scope:binding.scope,override:{disabled:true}};
    await tools.get('agent_hq_preview_telemetry_binding')!.handler(preview);
    expect(api.telemetryWrite).toHaveBeenLastCalledWith('POST','/bindings/preview',preview);
    await tools.get('agent_hq_freeze_telemetry_report')!.handler({ report_id: 'report', query_id: 'query' });
    expect(api.telemetryWrite).toHaveBeenLastCalledWith('POST', '/reports/report/snapshots', { query_id: 'query' });
  });
  test('snapshot revision guard survives MCP argument validation and reaches REST', async () => {
    const { api, tools } = registry();
    const tool = tools.get('agent_hq_freeze_telemetry_report')!;
    const args = z.object(tool.schema).parse({ report_id: 'report/one', query_id: 'query', report_revision_id: 'revision-expected' });
    await tool.handler(args);
    expect(api.telemetryWrite).toHaveBeenLastCalledWith('POST', '/reports/report%2Fone/snapshots', { query_id: 'query', report_revision_id: 'revision-expected' });
    expect(z.object(tool.schema).safeParse({ report_id: 'report', query_id: 'query', report_revision_id: '' }).success).toBe(false);
  });
  test('metric tools preserve typed definitions, combined scope, regex and agent grouping', async () => {
    const { api, tools } = registry();
    const definition = telemetryDefinitionExamples.lead_search_count.definition;
    const scope = { project_id: 86, workflow_type: 'lead_generation', task_type: 'ops' };
    const query = { definition, scope, filter: telemetryDefinitionExamples.combined_filter.filter, group_by: [{ field: 'agent_id' }] };
    for (const [name, path] of [['query_telemetry_metrics', '/queries'], ['preview_telemetry_metric', '/queries/preview']]) {
      const tool = tools.get(`agent_hq_${name}`)!;
      const parsed = z.object(tool.schema).parse(query);
      expect(parsed).toEqual(query);
      await tool.handler(parsed);
      expect(api.telemetryWrite).toHaveBeenLastCalledWith('POST', path, query);
    }
    const validate = tools.get('agent_hq_validate_telemetry_definition')!;
    expect(z.object(validate.schema).parse({ definition, scope })).toEqual({ definition, scope });
  });
  test.each([
    ['metric', telemetryDefinitionExamples.profile_metric.definition],
    ['metric', telemetryDefinitionExamples.component_metric.definition],
    ['profile', telemetryDefinitionExamples.profile.definition],
    ['report', telemetryDefinitionExamples.dashboard.definition],
  ])('save and revise %s preserve their specific definition contract', async (kind, definition) => {
    const { api, tools } = registry();
    for (const revise of [false, true]) {
      const tool = tools.get(`agent_hq_${revise ? 'revise' : 'save'}_telemetry_${kind}`)!;
      const args = revise ? { definition_id: 'saved', expected_revision_id: 'previous', definition } : { key: 'example', name: 'Example', definition };
      const parsed = z.object(tool.schema).parse(args);
      expect(parsed).toEqual(args);
      await tool.handler(parsed);
      expect(api.telemetryWrite).toHaveBeenLastCalledWith('POST', `/${kind}s${revise ? '/saved/revisions' : ''}`, revise ? { expected_revision_id: 'previous', definition } : args);
    }
  });
  test('every registered tool names the concrete v2 API it invokes', () => {
    const { tools } = registry();
    expect(tools.size).toBeGreaterThanOrEqual(25);
    for (const tool of tools.values()) expect(tool.paths.every(path => path.startsWith('/api/v1/telemetry/v2/'))).toBe(true);
  });
  test('MCP tools/list and catalog publish usable recursive schemas, and tools/call preserves inputs', async () => {
    const { api } = registry();
    const server = createAgentHqMcpServer({ api: api as unknown as AgentHqApiClient, hasApiKey: true, resolveAccess: async () => buildEffectiveAccess({ identity: { agent_id: 1, agent_slug: 'test', key_id: 1, key_role: 'scoped', tenant_id: 1, project_id: 1 }, policy_mode: 'explicit', default_policy: 'scoped_runtime', scopes: [], enabled_capabilities: ['telemetry.read', 'telemetry.query', 'telemetry.manage_metrics', 'telemetry.manage_reports', 'telemetry.export'] }) });
    const client = new Client({ name: 'telemetry-contract-test', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = (await client.listTools()).tools.filter(tool => tool.name.includes('_telemetry_'));
      expect(listed).toHaveLength(30);
      for (const tool of listed) expectResolvableReferences(tool.inputSchema);
      const definition = listed.find(tool => tool.name === 'agent_hq_validate_telemetry_definition')!.inputSchema.properties!.definition as any;
      expect(definition.properties).toHaveProperty('journey');
      expect(definition.properties.attribution.enum).toContain('assigned_agent_at_entry');
      for (const tool of getMcpCatalog().tools.filter(tool => tool.domain === 'telemetry')) {
        for (const arg of tool.args) expectResolvableReferences(arg.schema);
      }
      for (const schema of Object.values(getTelemetryDefinitionContract().schemas)) expectResolvableReferences(schema);
      const args = { definition: telemetryDefinitionExamples.first_pass_by_entry_agent.definition };
      const result = await client.callTool({ name: 'agent_hq_validate_telemetry_definition', arguments: args });
      expect(result.isError).not.toBe(true);
      expect(api.telemetryWrite).toHaveBeenLastCalledWith('POST', '/definitions/validate', args);
      await client.callTool({ name: 'agent_hq_freeze_telemetry_report', arguments: { report_id: 'report', query_id: 'query', report_revision_id: 'expected' } });
      expect(api.telemetryWrite).toHaveBeenLastCalledWith('POST', '/reports/report/snapshots', { query_id: 'query', report_revision_id: 'expected' });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
