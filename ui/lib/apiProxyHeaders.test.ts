import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDownstreamResponseHeaders,
  buildUpstreamRequestHeaders,
  operatorAuthorizationHeaders,
} from './apiProxyHeaders.ts';

const TOKEN = '0123456789abcdef'.repeat(4);

test('the proxy speaks to the API as the operator', () => {
  const headers = buildUpstreamRequestHeaders(new Headers({ accept: 'application/json', 'content-type': 'application/json' }), TOKEN);
  assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(headers.get('accept'), 'application/json');
  assert.equal(headers.get('content-type'), 'application/json');
});

test('browser credentials, the session cookie and Origin never reach the API', () => {
  const headers = buildUpstreamRequestHeaders(new Headers({
    authorization: 'Bearer something-the-page-chose',
    'x-api-key': 'ahq_mcp_other_agent',
    'x-agent-hq-mcp-client': 'page',
    cookie: 'agent_hq_session_abc=v1.1.sig; theme=dark',
    origin: 'http://localhost:3500',
    host: 'localhost:3500',
    connection: 'keep-alive',
  }), TOKEN);
  assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`);
  for (const name of ['x-api-key', 'x-agent-hq-mcp-client', 'cookie', 'origin', 'host', 'connection']) {
    assert.equal(headers.has(name), false, name);
  }
});

test('responses lose only hop-by-hop headers', () => {
  const headers = buildDownstreamResponseHeaders(new Headers({ 'content-type': 'image/png', 'transfer-encoding': 'chunked', connection: 'close' }));
  assert.equal(headers.get('content-type'), 'image/png');
  assert.equal(headers.has('transfer-encoding'), false);
  assert.equal(headers.has('connection'), false);
});

test('server-side calls add the operator credential only when one is configured', () => {
  assert.deepEqual(operatorAuthorizationHeaders(TOKEN), { authorization: `Bearer ${TOKEN}` });
  assert.deepEqual(operatorAuthorizationHeaders(null), {});
});
