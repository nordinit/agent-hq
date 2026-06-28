import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = new URL('../bin/cli.js', import.meta.url);

test('repair preserves existing provider secret references unless explicitly changed', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-hq-init-home-'));
  const configDir = join(home, '.agent-hq');
  const configPath = join(configDir, 'config.json');
  const repairPath = join(home, 'repair.json');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({
    configVersion: 1,
    setupLevel: 'starter',
    instance: { name: 'Existing', dataDir: configDir, uiPort: 3500, apiPort: 3501 },
    providers: [{ slug: 'openai', credential: { secretRef: 'env:QA_OPENAI_KEY' }, required: true }],
    runtime: { kind: 'openclaw' },
    project: { name: 'Existing Project' },
    workflow: { template: 'software-delivery-mvp' },
    agents: [{ role: 'backend', name: 'Backend Agent' }],
    modelDefaults: { policy: 'balanced' },
  }, null, 2)}\n`);
  writeFileSync(repairPath, `${JSON.stringify({
    providers: [{ slug: 'anthropic', credential: { secretRef: 'env:ANTHROPIC_API_KEY' } }],
  })}\n`);

  execFileSync(process.execPath, [CLI.pathname, 'init', '--non-interactive', '--config', repairPath, '--repair', '--yes'], {
    env: { ...process.env, HOME: home },
    stdio: 'pipe',
  });

  const written = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(written.providers.map((provider) => provider.slug), ['openai', 'anthropic']);
  assert.equal(written.providers[0].credential.secretRef, 'env:QA_OPENAI_KEY');
});

test('malformed non-interactive config reports a clean CLI error', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-hq-init-home-'));
  const badConfig = join(home, 'bad.json');
  writeFileSync(badConfig, '[');

  const result = spawnSync(process.execPath, [CLI.pathname, 'init', '--non-interactive', '--config', badConfig, '--dry-run'], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not parse init input config file/);
  assert.doesNotMatch(result.stderr, /at loadJsonObjectFile/);
});
