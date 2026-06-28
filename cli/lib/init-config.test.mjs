import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildInitConfig,
  buildSetupPlan,
  defaultConfigPath,
  loadInitInputConfig,
  mergeInitConfig,
  redactSecrets,
  validateInitConfig,
} from './init-config.mjs';

test('builds and validates starter config with secret references only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hq-init-'));
  const config = buildInitConfig({ level: 'starter', inputConfig: { instance: { dataDir: dir }, project: { name: 'Acme' } } });

  assert.equal(config.setupLevel, 'starter');
  assert.equal(config.instance.dataDir, dir);
  assert.equal(config.project.name, 'Acme');
  assert.equal(config.workflow.template, 'software-delivery-mvp');
  assert.equal(validateInitConfig(config).ok, true);
});

test('merges existing config without dropping local choices', () => {
  const merged = mergeInitConfig(
    {
      instance: { name: 'Existing', dataDir: '/tmp/agent-hq', uiPort: 4444 },
      providers: [{ slug: 'openai', credential: { secretRef: 'env:OPENAI_API_KEY' }, required: true }],
      runtime: { kind: 'openclaw' },
    },
    {
      instance: { apiPort: 4555 },
      providers: [{ slug: 'anthropic', credential: { secretRef: 'env:ANTHROPIC_API_KEY' } }],
      runtime: { localWorktrees: true },
    },
  );

  assert.equal(merged.instance.name, 'Existing');
  assert.equal(merged.instance.uiPort, 4444);
  assert.equal(merged.instance.apiPort, 4555);
  assert.deepEqual(merged.providers.map((provider) => provider.slug), ['openai', 'anthropic']);
  assert.deepEqual(merged.runtime, { kind: 'openclaw', localWorktrees: true });
});

test('rejects raw provider secrets in config input', () => {
  const config = buildInitConfig({
    level: 'minimal',
    inputConfig: {
      providers: [{ slug: 'openai', apiKey: 'sk-raw-secret' }],
    },
  });

  const validation = validateInitConfig(config);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /raw secret/);
});

test('loads non-interactive JSON config and reports malformed input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hq-init-'));
  const goodPath = join(dir, 'init.json');
  writeFileSync(goodPath, JSON.stringify({ project: { name: 'Loaded' } }));

  assert.equal(loadInitInputConfig(goodPath).project.name, 'Loaded');

  const badPath = join(dir, 'bad.json');
  writeFileSync(badPath, '[');
  assert.throws(() => loadInitInputConfig(badPath), /Could not parse init input config file/);
});

test('dry-run setup plan marks writes and verification as skipped', () => {
  const config = buildInitConfig({ level: 'full', inputConfig: { instance: { dataDir: '/tmp/agent-hq-plan' } } });
  const plan = buildSetupPlan(config, null, { dryRun: true });

  assert.equal(plan.dryRun, true);
  assert.equal(plan.configPath, defaultConfigPath('/tmp/agent-hq-plan'));
  assert.equal(plan.actions.find((action) => action.id === 'write-local-config').skipped, true);
  assert.equal(plan.actions.find((action) => action.id === 'verify-setup').skipped, true);
});

test('redacts raw secret-looking fields before persistence', () => {
  const redacted = redactSecrets({
    providers: [{ slug: 'example', token: 'raw', credential: { secretRef: 'env:EXAMPLE_TOKEN' } }],
  });

  assert.equal(redacted.providers[0].token, '[redacted]');
  assert.equal(redacted.providers[0].credential.secretRef, 'env:EXAMPLE_TOKEN');
});
