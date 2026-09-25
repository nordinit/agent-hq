import test from 'node:test';
import assert from 'node:assert/strict';
import { readTokenFile, resolveAgentHqApiAccess } from './api-credential.js';

const files = {
  '/home/op/.agent-hq/.env': '# Agent HQ\nAGENT_HQ_OPERATOR_TOKEN="abc123"\nOTHER=1\n',
  '/home/op/token': 'raw-token\n',
};
const readFile = (file) => {
  if (!(file in files)) throw new Error(`ENOENT: ${file}`);
  return files[file];
};

test('reads the operator token from the CLI env file or from a bare token file', () => {
  assert.equal(readTokenFile('/home/op/.agent-hq/.env', readFile), 'abc123');
  assert.equal(readTokenFile('/home/op/token', readFile), 'raw-token');
});

test('prefers plugin config, which stays out of the environment tools inherit', () => {
  const env = { AGENT_HQ_API_URL: 'http://api:3501/', AGENT_HQ_API_TOKEN: 'from-env' };
  assert.deepEqual(resolveAgentHqApiAccess({ apiTokenFile: '/home/op/.agent-hq/.env' }, env, readFile), {
    baseUrl: 'http://api:3501',
    token: 'abc123',
  });
  assert.deepEqual(resolveAgentHqApiAccess({ apiUrl: 'http://127.0.0.1:3511', apiToken: 'inline' }, env, readFile), {
    baseUrl: 'http://127.0.0.1:3511',
    token: 'inline',
  });
  assert.deepEqual(resolveAgentHqApiAccess({}, env, readFile), { baseUrl: 'http://api:3501', token: 'from-env' });
  assert.deepEqual(resolveAgentHqApiAccess(undefined, {}, readFile), { baseUrl: 'http://127.0.0.1:3501', token: null });
});

test('an unreadable token file is an error, not a silent unauthenticated call', () => {
  assert.throws(() => resolveAgentHqApiAccess({ apiTokenFile: '/missing' }, {}, readFile), /ENOENT/);
});
