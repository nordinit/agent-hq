import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const managerSource = readFileSync(join(here, '..', 'features', 'settings', 'ProviderConnectionsManager.tsx'), 'utf8');
const subscriptionSource = readFileSync(join(here, '..', 'features', 'settings', 'RuntimeProviderConnections.tsx'), 'utf8');

test('runtime-owned subscription authentication is a top-level provider surface', () => {
  assert.equal((managerSource.match(/<RuntimeProviderConnections/g) ?? []).length, 1);
  assert.match(managerSource, /Claude subscription connected/);
});

test('runtime subscription authentication explains the terminal and refresh workflow', () => {
  assert.match(subscriptionSource, /Runtime Subscription Authentication/);
  assert.match(subscriptionSource, /1\. Run this command in a terminal\./);
  assert.match(subscriptionSource, /2\. Complete the provider sign-in prompts in that terminal\./);
  assert.match(subscriptionSource, /3\. Return here and refresh profiles\./);
  assert.match(subscriptionSource, /Refresh profiles/);
});

test('subscription setup supports runtime and authenticated profile selection', () => {
  assert.match(subscriptionSource, /id="runtime-subscription-runtime"/);
  assert.match(subscriptionSource, /id="runtime-subscription-profile"/);
  assert.match(subscriptionSource, /api\.getProviderAuthInstructions/);
  assert.match(subscriptionSource, /api\.discoverProviderConnections/);
  assert.match(subscriptionSource, /Connect profile/);
});

test('Codex subscription state does not mark the Anthropic provider connected', () => {
  assert.match(
    subscriptionSource,
    /item\.provider_slug === 'anthropic' && item\.status === 'connected'/,
  );
});

test('changing runtime starts from a clean driver config and selects a target-runtime credential', () => {
  const agentsSource = readFileSync(join(here, '..', 'app', 'agents', 'page.tsx'), 'utf8');
  assert.match(agentsSource, /connection\.runtime_type === rt && connection\.status === 'connected'/);
  assert.match(agentsSource, /runtime_config: nextRuntimeConfig/);
  assert.match(agentsSource, /provider_connection_id: nextConnection \? String\(nextConnection\.id\) : ''/);
  assert.doesNotMatch(agentsSource, /runtime_config: rt === 'claude-code'[\s\S]{0,200}normalizeClaudeRuntimeConfig\(f\.runtime_config\)/);
});
