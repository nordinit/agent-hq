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

test('resolves a 3 minute default timeout for materialized tool executions', () => {
  assert.equal(resolveExecutionTimeoutMs({}), 180_000);
  assert.equal(resolveExecutionTimeoutMs({ timeoutMs: 0 }), 180_000);
  assert.equal(resolveExecutionTimeoutMs({ timeoutMs: 2_500 }), 2_500);
});
