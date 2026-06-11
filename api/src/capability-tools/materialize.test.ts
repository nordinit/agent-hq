import { materializeAssignedCapabilityTool, materializeAssignedToolForOpenClaw } from './materialize';
import type { AgentToolRecord } from '../runtimes/toolInjection';

function makeTool(overrides: Partial<AgentToolRecord>): AgentToolRecord {
  return {
    id: 10,
    tenant_id: 1,
    agent_tenant_id: 1,
    assignment_id: 20,
    name: 'Example Tool',
    slug: 'example_tool',
    description: 'Example',
    implementation_type: 'bash',
    implementation_body: 'echo hello',
    input_schema: '{"type":"object","properties":{"name":{"type":"string"}}}',
    permissions: 'exec',
    tags: '["ops"]',
    enabled: 1,
    overrides: '{}',
    assignment_enabled: 1,
    ...overrides,
  };
}

describe('materializeAssignedCapabilityTool', () => {
  it('maps bash tools to shell execution', () => {
    const result = materializeAssignedCapabilityTool(makeTool({ implementation_type: 'bash' }));
    expect(result.execution).toEqual({ type: 'shell', command: 'echo hello', cwd: undefined, env: undefined, timeoutMs: 180_000 });
  });

  it('parses script execution payloads', () => {
    const result = materializeAssignedCapabilityTool(makeTool({
      implementation_type: 'script',
      implementation_body: JSON.stringify({ command: 'python3', args: ['script.py'], cwd: '/tmp' }),
    }));

    expect(result.execution).toEqual({
      type: 'script',
      command: 'python3',
      inline: undefined,
      args: ['script.py'],
      cwd: '/tmp',
      env: undefined,
      timeoutMs: 180_000,
    });
  });

  it('parses http execution payloads', () => {
    const result = materializeAssignedCapabilityTool(makeTool({
      implementation_type: 'http',
      implementation_body: JSON.stringify({ url: 'https://example.com', method: 'post', headers: { Authorization: 'Bearer token' } }),
    }));

    expect(result.execution).toEqual({
      type: 'http',
      url: 'https://example.com',
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
      body: undefined,
      timeoutMs: 180_000,
    });
  });

  it('preserves explicit positive execution timeouts', () => {
    const result = materializeAssignedCapabilityTool(makeTool({
      implementation_type: 'shell',
      implementation_body: JSON.stringify({ command: 'echo hello', timeoutMs: 1_000 }),
    }));

    expect(result.execution).toMatchObject({
      type: 'shell',
      timeoutMs: 1_000,
    });
  });

  it('flattens the payload for the OpenClaw-native materialized tools endpoint', () => {
    const result = materializeAssignedToolForOpenClaw(makeTool({
      implementation_type: 'script',
      implementation_body: JSON.stringify({ inline: 'print("hi")', command: 'python3', args: ['-u'] }),
    }));

    expect(result).toEqual({
      id: 10,
      tool_id: 10,
      assignment_id: 20,
      name: 'Example Tool',
      slug: 'example_tool',
      description: 'Example',
      input_schema: { type: 'object', properties: { name: { type: 'string' } } },
      tags: ['ops'],
      permissions: 'exec',
      enabled: true,
      assignment_enabled: true,
      execution_type: 'script',
      execution_payload: {
        type: 'script',
        command: 'python3',
        inline: 'print("hi")',
        args: ['-u'],
        cwd: undefined,
        env: undefined,
        timeoutMs: 180_000,
      },
    });
  });

  it('normalizes malformed JSON fields into predictable JSON values', () => {
    const result = materializeAssignedToolForOpenClaw(makeTool({
      input_schema: '{malformed',
      tags: 'not-json',
    }));

    expect(result.input_schema).toEqual({ type: 'object', additionalProperties: true });
    expect(result.tags).toEqual([]);
  });
});
