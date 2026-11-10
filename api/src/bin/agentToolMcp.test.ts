import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  buildToolDefinitions,
  jsonSchemaFromInputSchema,
  mcpToolNameFromSlug,
  resolveAgentId,
  resolveHardcodedToolSlugs,
  resolveWorkingDirectory,
  zodInputSchema,
  type AgentToolRecord,
} from './agent-tool-mcp';

function makeTool(overrides: Partial<AgentToolRecord> = {}): AgentToolRecord {
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
    input_schema: '{}',
    permissions: 'read_only',
    tags: '[]',
    enabled: 1,
    overrides: '{}',
    assignment_enabled: 1,
    ...overrides,
  };
}

/** Diagnostics go to stderr by design; keep them out of the test report. */
let stderr: jest.SpyInstance;

beforeEach(() => {
  stderr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stderr.mockRestore();
});

describe('jsonSchemaFromInputSchema', () => {
  it('returns the stored schema when it parses to an object', () => {
    const schema = jsonSchemaFromInputSchema(JSON.stringify({
      type: 'object',
      properties: { focus: { type: 'string' } },
      required: ['focus'],
    }));

    expect(schema).toEqual({
      type: 'object',
      properties: { focus: { type: 'string' } },
      required: ['focus'],
    });
  });

  it('falls back to an empty object schema for malformed, absent and non-object values', () => {
    expect(jsonSchemaFromInputSchema('{not json')).toEqual({ type: 'object' });
    expect(jsonSchemaFromInputSchema(undefined)).toEqual({ type: 'object' });
    expect(jsonSchemaFromInputSchema(null)).toEqual({ type: 'object' });
    expect(jsonSchemaFromInputSchema('')).toEqual({ type: 'object' });
    expect(jsonSchemaFromInputSchema('[1,2,3]')).toEqual({ type: 'object' });
    expect(jsonSchemaFromInputSchema('"a string"')).toEqual({ type: 'object' });
  });
});

describe('zodInputSchema', () => {
  it('enforces declared required properties and their types', () => {
    const schema = zodInputSchema({
      type: 'object',
      properties: {
        focus: { type: 'string', description: 'what to look at' },
        depth: { type: 'integer' },
        mode: { type: 'string', enum: ['fast', 'slow'] },
      },
      required: ['focus'],
    });

    expect(schema.parse({ focus: 'routing', depth: 3, mode: 'fast' })).toEqual({
      focus: 'routing',
      depth: 3,
      mode: 'fast',
    });
    expect(schema.safeParse({ depth: 3 }).success).toBe(false);
    expect(schema.safeParse({ focus: 'routing', mode: 'sideways' }).success).toBe(false);
  });

  it('treats undeclared properties as optional', () => {
    const schema = zodInputSchema({
      type: 'object',
      properties: { depth: { type: 'integer' } },
    });

    expect(schema.parse({})).toEqual({});
  });

  it('passes unknown keys through so an incomplete schema cannot strip tool input', () => {
    const declared = zodInputSchema({
      type: 'object',
      properties: { focus: { type: 'string' } },
      required: ['focus'],
    });
    expect(declared.parse({ focus: 'routing', undeclared: 42 })).toEqual({ focus: 'routing', undeclared: 42 });

    const empty = zodInputSchema({ type: 'object' });
    expect(empty.parse({ anything: { nested: true } })).toEqual({ anything: { nested: true } });
  });

  it('accepts any value for properties it cannot model', () => {
    const schema = zodInputSchema({
      type: 'object',
      properties: { weird: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
      required: ['weird'],
    });

    expect(schema.parse({ weird: { deeply: ['nested'] } })).toEqual({ weird: { deeply: ['nested'] } });
  });
});

describe('mcpToolNameFromSlug', () => {
  it('leaves already-valid slugs alone', () => {
    expect(mcpToolNameFromSlug('deploy_service', 7)).toBe('deploy_service');
    expect(mcpToolNameFromSlug('deploy-service', 7)).toBe('deploy-service');
  });

  it('replaces characters the Messages API rejects', () => {
    expect(mcpToolNameFromSlug('ops.deploy service', 7)).toBe('ops_deploy_service');
    expect(mcpToolNameFromSlug('  spaced  ', 7)).toBe('spaced');
  });

  it('falls back to the tool id when nothing usable survives', () => {
    expect(mcpToolNameFromSlug('***', 7)).toBe('tool_7');
    expect(mcpToolNameFromSlug('', 7)).toBe('tool_7');
  });

  it('bounds the name so the mcp__server__tool prefix still fits', () => {
    expect(mcpToolNameFromSlug('a'.repeat(200), 7)).toHaveLength(48);
  });
});

describe('buildToolDefinitions', () => {
  it('registers one definition per assigned tool', () => {
    const definitions = buildToolDefinitions([
      makeTool({ id: 1, slug: 'first' }),
      makeTool({ id: 2, slug: 'second' }),
    ]);

    expect(definitions.map((definition) => definition.name)).toEqual(['first', 'second']);
    expect(definitions[0].tool.id).toBe(1);
  });

  it('drops slugs that collide with a built-in tool, case-insensitively', () => {
    const definitions = buildToolDefinitions(
      [makeTool({ id: 1, slug: 'Bash' }), makeTool({ id: 2, slug: 'deploy' })],
      { hardcodedToolSlugs: new Set(['bash']) },
    );

    expect(definitions.map((definition) => definition.name)).toEqual(['deploy']);
  });

  it('drops a later tool whose sanitised name is already claimed', () => {
    const definitions = buildToolDefinitions([
      makeTool({ id: 1, slug: 'ops.deploy' }),
      makeTool({ id: 2, slug: 'ops deploy' }),
      makeTool({ id: 3, slug: 'ops_rollback' }),
    ]);

    expect(definitions.map((definition) => definition.name)).toEqual(['ops_deploy', 'ops_rollback']);
    expect(definitions[0].tool.id).toBe(1);
  });

  it('prefers a description supplied by the assignment overrides', () => {
    const [definition] = buildToolDefinitions([
      makeTool({ overrides: JSON.stringify({ description: 'Tenant-specific wording' }) }),
    ]);

    expect(definition.description).toBe('Tenant-specific wording');
  });

  it('keeps the tool description when overrides are absent or malformed', () => {
    expect(buildToolDefinitions([makeTool({ overrides: '{}' })])[0].description).toBe('Example');
    expect(buildToolDefinitions([makeTool({ overrides: 'not json' })])[0].description).toBe('Example');
  });

  it('still exposes a tool whose input_schema is malformed', () => {
    const [definition] = buildToolDefinitions([makeTool({ input_schema: '{"type":' })]);

    expect(definition.name).toBe('example_tool');
    expect(definition.inputSchema.parse({ anything: 1 })).toEqual({ anything: 1 });
  });
});

describe('argv and env resolution', () => {
  it('reads the agent id from --agent-id in both spellings', () => {
    expect(resolveAgentId(['--agent-id', '42'], {})).toBe(42);
    expect(resolveAgentId(['--agent-id=42'], {})).toBe(42);
    expect(resolveAgentId(['--cwd', '/tmp', '--agent-id', '42'], {})).toBe(42);
  });

  it('falls back to AGENT_HQ_TOOL_AGENT_ID and prefers argv over it', () => {
    expect(resolveAgentId([], { AGENT_HQ_TOOL_AGENT_ID: '7' })).toBe(7);
    expect(resolveAgentId(['--agent-id', '42'], { AGENT_HQ_TOOL_AGENT_ID: '7' })).toBe(42);
  });

  it('returns null for anything that is not a positive integer id', () => {
    expect(resolveAgentId([], {})).toBeNull();
    expect(resolveAgentId(['--agent-id'], {})).toBeNull();
    expect(resolveAgentId(['--agent-id', 'abc'], {})).toBeNull();
    expect(resolveAgentId(['--agent-id', '0'], {})).toBeNull();
    expect(resolveAgentId(['--agent-id', '-3'], {})).toBeNull();
    expect(resolveAgentId(['--agent-id', '1.5'], {})).toBeNull();
    expect(resolveAgentId([], { AGENT_HQ_TOOL_AGENT_ID: '' })).toBeNull();
  });

  it('defaults the working directory to the process cwd', () => {
    expect(resolveWorkingDirectory([], {})).toBe(process.cwd());
    expect(resolveWorkingDirectory([], { AGENT_HQ_TOOL_CWD: '/from/env' })).toBe('/from/env');
    expect(resolveWorkingDirectory(['--cwd', '/from/argv'], { AGENT_HQ_TOOL_CWD: '/from/env' })).toBe('/from/argv');
  });

  it('parses the built-in slug skip list case-insensitively', () => {
    expect(resolveHardcodedToolSlugs({ AGENT_HQ_TOOL_SKIP_SLUGS: 'Bash, Read ,,Write' }))
      .toEqual(new Set(['bash', 'read', 'write']));
    expect(resolveHardcodedToolSlugs({})).toEqual(new Set());
  });
});
