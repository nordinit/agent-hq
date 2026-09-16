import { z } from 'zod';
import { registerTelemetryTools } from './telemetry';
import type { McpToolHandler, McpToolResult } from '../registrar';
import { AgentHqApiClient } from '../apiClient';

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
  test('every registered tool names the concrete v2 API it invokes', () => {
    const { tools } = registry();
    expect(tools.size).toBeGreaterThanOrEqual(25);
    for (const tool of tools.values()) expect(tool.paths.every(path => path.startsWith('/api/v1/telemetry/v2/'))).toBe(true);
  });
});
