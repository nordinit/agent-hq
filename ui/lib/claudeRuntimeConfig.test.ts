import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_CLAUDE_ALLOWED_TOOLS,
  claudeRuntimeConfigToJson,
  serializeClaudeRuntimeConfig,
} from './claudeRuntimeConfig.ts';

test('Claude runtime UI defaults match the API productive allowlist', () => {
  assert.deepEqual([...DEFAULT_CLAUDE_ALLOWED_TOOLS], [
    'Bash',
    'Edit',
    'Glob',
    'Grep',
    'Read',
    'WebFetch',
    'WebSearch',
    'Write',
  ]);
});

test('Claude runtime config serialization preserves an explicit empty allowedTools boundary', () => {
  assert.deepEqual(serializeClaudeRuntimeConfig({ allowedTools: [] }), {
    allowedTools: [],
  });
  assert.deepEqual(
    JSON.parse(claudeRuntimeConfigToJson({ allowedTools: [] })),
    { allowedTools: [] },
  );
});

test('Claude runtime config serialization keeps omission distinct from an empty list', () => {
  assert.equal(Object.hasOwn(serializeClaudeRuntimeConfig({}), 'allowedTools'), false);
  assert.equal(Object.hasOwn(JSON.parse(claudeRuntimeConfigToJson({})), 'allowedTools'), false);
});

test('Claude runtime config serialization copies mutable form state', () => {
  const allowedTools = ['Read'];
  const serialized = serializeClaudeRuntimeConfig({ allowedTools });
  allowedTools.push('Bash');
  assert.deepEqual(serialized.allowedTools, ['Read']);
});

test('Claude runtime config serialization preserves hardened advanced fields', () => {
  const serialized = serializeClaudeRuntimeConfig({
    claudeBin: '/opt/agent-hq/bin/claude',
    claudeConfigDir: '/var/lib/agent-hq/claude/agent-7',
    providerConnectionExternalRef: 'claude:opaque-profile',
    disallowedTools: ['WebSearch'],
    extraArgs: ['--debug'],
    env: { FEATURE_FLAG: 'enabled' },
    killGraceMs: 0,
  });

  assert.deepEqual(serialized, {
    claudeBin: '/opt/agent-hq/bin/claude',
    claudeConfigDir: '/var/lib/agent-hq/claude/agent-7',
    providerConnectionExternalRef: 'claude:opaque-profile',
    disallowedTools: ['WebSearch'],
    extraArgs: ['--debug'],
    env: { FEATURE_FLAG: 'enabled' },
    killGraceMs: 0,
  });
});
