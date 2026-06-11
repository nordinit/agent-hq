import { executeToolImplementation, type AgentToolRecord } from './toolInjection';

function makeTool(overrides: Partial<AgentToolRecord>): AgentToolRecord {
  return {
    id: 1,
    tenant_id: 1,
    agent_tenant_id: 1,
    assignment_id: 1,
    name: 'Script Tool',
    slug: 'script_tool',
    description: 'Script test',
    implementation_type: 'script',
    implementation_body: JSON.stringify({
      command: process.execPath,
      inline: 'process.stdout.write(process.env.TOOL_INPUT || "");',
    }),
    input_schema: '{}',
    permissions: 'read_only',
    tags: '[]',
    enabled: 1,
    overrides: '{}',
    assignment_enabled: 1,
    ...overrides,
  };
}

describe('executeToolImplementation', () => {
  it('executes inline script tools with structured input in the environment', () => {
    const result = executeToolImplementation(makeTool({}), { focus: 'routing', depth: 3 });

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ focus: 'routing', depth: 3 }) },
    ]);
  });
});
