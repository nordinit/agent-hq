import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const CLI = new URL('../bin/cli.js', import.meta.url);

function dockerHarness() {
  const home = mkdtempSync(join(tmpdir(), 'agent-hq-cli-mode-'));
  const bin = join(home, 'bin');
  const log = join(home, 'docker.log');
  mkdirSync(bin, { recursive: true });
  const docker = join(bin, 'docker');
  writeFileSync(docker, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_LOG"\nexit 0\n');
  chmodSync(docker, 0o755);
  return {
    log,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      DOCKER_LOG: log,
    },
  };
}

test('plain stop and status address the default Docker deployment', () => {
  const harness = dockerHarness();
  for (const command of ['stop', 'status']) {
    const result = spawnSync(process.execPath, [CLI.pathname, command], {
      env: harness.env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }

  const calls = readFileSync(harness.log, 'utf8');
  assert.match(calls, /compose down/);
  assert.match(calls, /compose ps/);
});

test('--no-docker keeps stop and status in explicitly selected native mode', () => {
  const harness = dockerHarness();
  for (const command of ['stop', 'status']) {
    const result = spawnSync(process.execPath, [CLI.pathname, command, '--no-docker'], {
      env: harness.env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }

  assert.throws(() => readFileSync(harness.log, 'utf8'));
});

test('plain start never falls back to native mode when Docker is unavailable', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-hq-cli-no-docker-'));
  const result = spawnSync(process.execPath, [CLI.pathname, 'start'], {
    env: {
      ...process.env,
      HOME: home,
      PATH: '',
      DATABASE_URL: 'postgresql://localhost/agent_hq',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Native mode is never selected implicitly/);
  assert.match(result.stderr, /--no-docker/);
});
