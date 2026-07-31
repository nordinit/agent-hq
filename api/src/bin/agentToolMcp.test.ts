import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  buildToolDefinitions,
  executeAgentTool,
  jsonSchemaFromInputSchema,
  mcpToolNameFromSlug,
  registerAgentTools,
  resolveAgentId,
  resolveHardcodedToolSlugs,
  resolveWorkingDirectory,
  zodInputSchema,
  type AgentToolDefinition,
  type AgentToolRecord,
  type McpTextResult,
  type ToolRegistrarLike,
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

describe('executeAgentTool', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(path.join(os.tmpdir(), 'agent-tool-mcp-test-'));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('runs bash tools in the supplied working directory', () => {
    writeFileSync(path.join(workdir, 'marker.txt'), 'inside-the-run-cwd', 'utf8');

    const result = executeAgentTool(makeTool({ implementation_body: 'cat marker.txt' }), {}, workdir);

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: 'inside-the-run-cwd' }]);
  });

  it('exposes the tool input as TOOL_INPUT and per-key TOOL_* variables', () => {
    const result = executeAgentTool(
      makeTool({ implementation_body: 'printf "%s|%s|%s" "$TOOL_INPUT" "$TOOL_FOCUS" "$TOOL_DEPTH"' }),
      { focus: 'routing', depth: 3 },
      workdir,
    );

    expect(result.content[0].text).toBe(`${JSON.stringify({ focus: 'routing', depth: 3 })}|routing|3`);
  });

  it('runs shell tools, including the capability payload body form', () => {
    const raw = executeAgentTool(
      makeTool({ implementation_type: 'shell', implementation_body: 'printf raw-body' }),
      {},
      workdir,
    );
    expect(raw).toEqual({ content: [{ type: 'text', text: 'raw-body' }] });

    const payload = executeAgentTool(
      makeTool({
        implementation_type: 'shell',
        implementation_body: JSON.stringify({ command: 'printf payload-body', timeoutMs: 5_000 }),
      }),
      {},
      workdir,
    );
    expect(payload).toEqual({ content: [{ type: 'text', text: 'payload-body' }] });
  });

  it('reports a failing command as an error result with stderr, without throwing', () => {
    const result = executeAgentTool(
      makeTool({ slug: 'failing_tool', implementation_body: 'echo boom >&2; exit 3' }),
      {},
      workdir,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error executing tool "failing_tool"');
    expect(result.content[0].text).toContain('boom');
  });

  it('rejects an empty implementation body', () => {
    const result = executeAgentTool(makeTool({ implementation_body: '' }), {}, workdir);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Error: tool has no implementation body');
  });

  it('runs inline script tools', () => {
    const result = executeAgentTool(
      makeTool({
        implementation_type: 'script',
        implementation_body: JSON.stringify({
          command: process.execPath,
          inline: 'process.stdout.write(process.env.TOOL_INPUT || "");',
        }),
      }),
      { focus: 'routing' },
      workdir,
    );

    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify({ focus: 'routing' }) }] });
  });

  it('reports unsupported implementation types instead of executing them', () => {
    expect(executeAgentTool(makeTool({ implementation_type: 'function' }), {}, workdir)).toEqual({
      content: [{ type: 'text', text: 'Error: function tools are not yet supported at runtime' }],
      isError: true,
    });

    expect(executeAgentTool(makeTool({ implementation_type: 'http' }), {}, workdir)).toEqual({
      content: [{ type: 'text', text: 'Error: unsupported implementation type "http"' }],
      isError: true,
    });
  });
});

describe('registerAgentTools', () => {
  it('registers each definition and executes the matching tool on call', async () => {
    const registered: { name: string; config: { description?: string; inputSchema?: unknown } }[] = [];
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<McpTextResult> | McpTextResult>();
    const server: ToolRegistrarLike = {
      registerTool(name, config, cb) {
        registered.push({ name, config });
        handlers.set(name, cb);
        return undefined;
      },
    };

    const definitions: AgentToolDefinition[] = buildToolDefinitions([
      makeTool({ id: 1, slug: 'echo_input', description: 'Echo', implementation_body: 'printf "%s" "$TOOL_INPUT"' }),
    ]);
    registerAgentTools(server, definitions, os.tmpdir());

    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe('echo_input');
    expect(registered[0].config.description).toBe('Echo');
    expect(registered[0].config.inputSchema).toBe(definitions[0].inputSchema);

    const result = await handlers.get('echo_input')!({ focus: 'routing' });
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify({ focus: 'routing' }) }] });
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
