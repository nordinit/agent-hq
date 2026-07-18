import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const managerSource = readFileSync(join(here, '..', 'features', 'settings', 'ProviderConnectionsManager.tsx'), 'utf8');
const subscriptionSource = readFileSync(join(here, '..', 'features', 'settings', 'RuntimeProviderConnections.tsx'), 'utf8');

test('Claude subscription authentication is embedded in the Anthropic provider panel', () => {
  assert.match(managerSource, /meta\.slug === 'anthropic'[\s\S]*?<RuntimeProviderConnections/);
  assert.equal((managerSource.match(/<RuntimeProviderConnections/g) ?? []).length, 1);
  assert.match(managerSource, /Claude subscription connected/);
});

test('Claude subscription authentication explains the terminal and refresh workflow', () => {
  assert.match(subscriptionSource, /Claude Subscription \(OAuth\)/);
  assert.match(subscriptionSource, /1\. Run this command in a terminal\./);
  assert.match(subscriptionSource, /2\. Complete the Anthropic sign-in prompts in that terminal\./);
  assert.match(subscriptionSource, /3\. Return here and refresh profiles\./);
  assert.match(subscriptionSource, /Refresh profiles/);
});

test('Claude subscription setup supports runtime and authenticated profile selection', () => {
  assert.match(subscriptionSource, /id="anthropic-subscription-runtime"/);
  assert.match(subscriptionSource, /id="anthropic-subscription-profile"/);
  assert.match(subscriptionSource, /api\.getProviderAuthInstructions/);
  assert.match(subscriptionSource, /api\.discoverProviderConnections/);
  assert.match(subscriptionSource, /Connect profile/);
});
