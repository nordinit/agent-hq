import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildToolExecutionEnv,
  normalizeMaterializedTools,
  resolveOpenClawAgentId,
  resolveExecutionTimeoutMs,
  toOpenClawToolDefinition,
} from './tool-contract.js';

test('normalizes API materialized tools and filters unsupported execution types', () => {
  const tools = normalizeMaterializedTools({
    tools: [
      { slug: 'run_shell', execution_type: 'shell' },
      { slug: 'remote', execution_type: 'http' },
      { slug: 'legacy_mcp', execution_type: 'mcp' },
      { slug: 'missing' },
    ],
  });

  assert.deepEqual(tools.map((tool) => tool.slug), ['run_shell', 'remote']);
});

test('transforms API response rows into OpenClaw native tool definitions', () => {
  const definition = toOpenClawToolDefinition({
    id: 10,
    tool_id: 10,
    assignment_id: 20,
    name: 'Example Tool',
    slug: 'example_tool',
    description: 'Example description',
    input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    tags: ['ops'],
    permissions: 'exec',
    enabled: true,
    assignment_enabled: true,
    execution_type: 'shell',
    execution_payload: { type: 'shell', command: 'echo "$TOOL_INPUT"' },
  });

  assert.equal(definition.name, 'example_tool');
  assert.deepEqual(definition, {
    name: 'example_tool',
    label: 'Example Tool',
    description: 'Example description',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
    metadata: {
      tags: ['ops'],
      permissions: 'exec',
      agentHqToolId: 10,
      agentHqAssignmentId: 20,
    },
  });
});

test('resolves the active OpenClaw agent id from plugin tool context', () => {
  assert.equal(resolveOpenClawAgentId({ agentId: 'Atlas' }), 'atlas');
  assert.equal(resolveOpenClawAgentId({ agent: { id: 'worker_1' } }), 'worker_1');
  assert.equal(resolveOpenClawAgentId({ sessionKey: 'agent:atlas:main' }), 'atlas');
  assert.equal(resolveOpenClawAgentId({ sessionKey: 'main' }), null);
  assert.equal(resolveOpenClawAgentId({ agentId: '../bad' }), null);
});

test('builds shell execution env with raw and TOOL_ input variables', () => {
  const env = buildToolExecutionEnv(
    { repo_path: '/tmp/worktree', health_check: true, 'bad-name': 'skip', PATH: '/malicious' },
    { EXECUTION_FLAG: '1' },
    { PATH: '/usr/bin' },
  );

  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.EXECUTION_FLAG, '1');
  assert.equal(env.repo_path, '/tmp/worktree');
  assert.equal(env.health_check, 'true');
  assert.equal(env['bad-name'], undefined);
  assert.equal(env.TOOL_REPO_PATH, '/tmp/worktree');
  assert.equal(env.TOOL_HEALTH_CHECK, 'true');
  assert.equal(env.TOOL_BAD_NAME, 'skip');
  assert.equal(env.TOOL_INPUT, JSON.stringify({
    repo_path: '/tmp/worktree',
    health_check: true,
    'bad-name': 'skip',
    PATH: '/malicious',
  }));
});

test('keeps Agent HQ credentials in the gateway environment away from tool processes', () => {
  const gatewayEnv = {
    PATH: '/usr/bin',
    HOME: '/home/op',
    AGENT_HQ_API_URL: 'http://127.0.0.1:3501',
    AGENT_HQ_API_TOKEN: 'operator-token',
    AGENT_HQ_OPERATOR_TOKEN: 'operator-token',
    AGENT_HQ_MCP_API_KEY: 'ahq_mcp_gateway',
    AGENT_HQ_PLUGIN_API_TOKEN: 'operator-token',
    AGENT_HQ_POSTGRES_PASSWORD: 'pg-secret',
    AGENT_HQ_DATABASE_URL: 'postgresql://agenthq:pg-secret@db/agent_hq',
    agent_hq_api_token: 'operator-token',
  };
  // An input named like a stripped credential still cannot put a value there.
  const env = buildToolExecutionEnv({ AGENT_HQ_API_TOKEN: 'from-input' }, {}, gatewayEnv);

  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/op');
  assert.equal(env.AGENT_HQ_API_URL, 'http://127.0.0.1:3501');
  for (const name of [
    'AGENT_HQ_API_TOKEN',
    'AGENT_HQ_OPERATOR_TOKEN',
    'AGENT_HQ_MCP_API_KEY',
    'AGENT_HQ_PLUGIN_API_TOKEN',
    'AGENT_HQ_POSTGRES_PASSWORD',
    'AGENT_HQ_DATABASE_URL',
    'agent_hq_api_token',
  ]) {
    assert.equal(env[name], undefined, name);
  }
  assert.equal(Object.values(env).some((value) => String(value).includes('operator-token')), false);
  assert.equal(gatewayEnv.AGENT_HQ_API_TOKEN, 'operator-token', 'the gateway environment itself is not modified');
});

test('a tool definition may still set its own environment explicitly', () => {
  const env = buildToolExecutionEnv({}, { AGENT_HQ_MCP_API_KEY: 'ahq_mcp_tool_owned' }, { AGENT_HQ_MCP_API_KEY: 'ahq_mcp_gateway' });
  assert.equal(env.AGENT_HQ_MCP_API_KEY, 'ahq_mcp_tool_owned');
});

test('resolves a 3 minute default timeout for materialized tool executions', () => {
  assert.equal(resolveExecutionTimeoutMs({}), 180_000);
  assert.equal(resolveExecutionTimeoutMs({ timeoutMs: 0 }), 180_000);
  assert.equal(resolveExecutionTimeoutMs({ timeoutMs: 2_500 }), 2_500);
});
