import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  ensureOperatorToken,
  readEnvValue,
  readOperatorToken,
  signedInUiUrl,
  withOperatorAuth,
} from './operator-token.mjs';
import { runInit } from './onboarding.mjs';

const CLI = new URL('../bin/cli.js', import.meta.url);
const mode = (file) => statSync(file).mode & 0o777;

test('first use generates a 256-bit token in a 0600 env file, and later uses keep it', () => {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'agent-hq-token-')), '.agent-hq');
  const first = ensureOperatorToken(dataDir, {});
  assert.equal(first.created, true);
  assert.match(first.token, /^[0-9a-f]{64}$/);
  assert.equal(first.file, join(dataDir, '.env'));
  assert.equal(mode(first.file), 0o600);
  assert.equal(mode(dataDir), 0o700);

  const second = ensureOperatorToken(dataDir, {});
  assert.deepEqual(second, { token: first.token, created: false, file: first.file });
  assert.equal(readOperatorToken(dataDir, {}), first.token);
});

test('an existing env file keeps its other settings and is tightened to 0600', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-hq-token-'));
  const file = join(dataDir, '.env');
  writeFileSync(file, 'AGENT_HQ_UI_PORT=3600', { mode: 0o644 });
  const { token } = ensureOperatorToken(dataDir, {});
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^AGENT_HQ_UI_PORT=3600\n/);
  assert.equal(readEnvValue(text, 'AGENT_HQ_OPERATOR_TOKEN'), token);
  assert.equal(mode(file), 0o600);

  chmodSync(file, 0o644);
  ensureOperatorToken(dataDir, {});
  assert.equal(mode(file), 0o600);
});

test('a token in the environment wins and is never written to disk', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-hq-token-'));
  const token = 'e'.repeat(64);
  assert.deepEqual(ensureOperatorToken(dataDir, { AGENT_HQ_OPERATOR_TOKEN: token }), {
    token, created: false, file: join(dataDir, '.env'),
  });
  assert.equal(existsSync(join(dataDir, '.env')), false);
});

test('reading never creates a token, and short tokens are refused', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-hq-token-'));
  assert.equal(readOperatorToken(dataDir, {}), null);
  assert.equal(existsSync(join(dataDir, '.env')), false);
  assert.throws(() => readOperatorToken(dataDir, { AGENT_HQ_OPERATOR_TOKEN: 'short' }), /at least 32/);
});

test('dotenv parsing takes the last assignment and strips quotes', () => {
  assert.equal(readEnvValue('A=1\nexport A="2"\n# A=3\n', 'A'), '2');
  assert.equal(readEnvValue("B='x y'", 'B'), 'x y');
  assert.equal(readEnvValue('AB=1', 'A'), null);
});

test('the signed-in URL goes through /login, which drops the token from the address bar', () => {
  assert.equal(signedInUiUrl('http://localhost:3500', 'abc'), 'http://localhost:3500/login?token=abc');
  assert.equal(signedInUiUrl('http://localhost:3500', null), 'http://localhost:3500/login');
});

test('API calls carry the operator token', async () => {
  const seen = [];
  const fetchAsOperator = withOperatorAuth(async (url, init) => { seen.push(init.headers); return new Response('{}'); }, 'tok');
  await fetchAsOperator('http://localhost:3501/api/v1/providers', { headers: { 'Content-Type': 'application/json' } });
  assert.deepEqual(seen, [{ 'Content-Type': 'application/json', Authorization: 'Bearer tok' }]);
});

test('onboarding authenticates every API call as the operator', async () => {
  const authorizations = [];
  const fetchImpl = async (url, init = {}) => {
    authorizations.push(init.headers?.Authorization);
    if (url.endsWith('/api/v1/setup/onboarding/skip')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    throw new Error(`Unexpected request: ${url}`);
  };
  await runInit({ skipProvider: true }, {
    fetch: fetchImpl,
    io: { close() {} },
    noExit: true,
    operatorToken: 'f'.repeat(64),
  });
  assert.ok(authorizations.length > 0);
  assert.ok(authorizations.every((value) => value === `Bearer ${'f'.repeat(64)}`));
});

function cliHarness() {
  const home = mkdtempSync(join(tmpdir(), 'agent-hq-cli-token-'));
  const bin = join(home, 'bin');
  const log = join(home, 'calls.log');
  mkdirSync(bin, { recursive: true });
  // Docker records the token Compose receives; the browser opener records the URL it was given.
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nprintf "docker %s token=%s\\n" "$*" "$AGENT_HQ_OPERATOR_TOKEN" >> "$CALLS_LOG"\nexit 0\n');
  for (const opener of ['open', 'xdg-open']) {
    writeFileSync(join(bin, opener), '#!/bin/sh\nprintf "open %s\\n" "$*" >> "$CALLS_LOG"\nexit 0\n');
    chmodSync(join(bin, opener), 0o755);
  }
  chmodSync(join(bin, 'docker'), 0o755);
  const env = { ...process.env, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, CALLS_LOG: log };
  delete env.AGENT_HQ_OPERATOR_TOKEN;
  return { home, log, env };
}

test('start generates the token, hands it to Compose, and token/open reuse it', () => {
  const harness = cliHarness();
  const run = (...args) => spawnSync(process.execPath, [CLI.pathname, ...args], { env: harness.env, encoding: 'utf8' });

  const start = run('start');
  assert.equal(start.status, 0, start.stderr || start.stdout);
  const envFile = join(harness.home, '.agent-hq', '.env');
  assert.equal(mode(envFile), 0o600);
  const token = readEnvValue(readFileSync(envFile, 'utf8'), 'AGENT_HQ_OPERATOR_TOKEN');
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.match(readFileSync(harness.log, 'utf8'), new RegExp(`docker compose up -d --remove-orphans token=${token}`));

  const printed = run('token');
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, `${token}\n`);

  const open = run('open');
  assert.equal(open.status, 0, open.stderr);
  assert.doesNotMatch(open.stdout, new RegExp(token), 'the token is not echoed to the terminal');
  assert.match(readFileSync(harness.log, 'utf8'), new RegExp(`open http://localhost:3500/login\\?token=${token}`));

  const restart = run('restart');
  assert.equal(restart.status, 0, restart.stderr || restart.stdout);
  assert.equal(readEnvValue(readFileSync(envFile, 'utf8'), 'AGENT_HQ_OPERATOR_TOKEN'), token);

  const plugin = JSON.parse(readFileSync(join(harness.home, '.openclaw', 'openclaw.json'), 'utf8'))
    .plugins.entries['agent-hq-capability-tools'];
  assert.deepEqual(plugin.config, { apiUrl: 'http://127.0.0.1:3501', apiTokenFile: envFile });
});

test('token fails clearly before the first start', () => {
  const harness = cliHarness();
  const result = spawnSync(process.execPath, [CLI.pathname, 'token'], { env: harness.env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /agent-hq start/);
});
