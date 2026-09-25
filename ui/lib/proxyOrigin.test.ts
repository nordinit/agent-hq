import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSameOriginProxyRequest } from './proxyOrigin.ts';

test('server-side callers without an Origin pass', () => {
  assert.equal(isSameOriginProxyRequest(new Headers({ host: 'localhost:3500' })), true);
});

test('the UI’s own pages pass', () => {
  assert.equal(isSameOriginProxyRequest(new Headers({ host: 'localhost:3500', origin: 'http://localhost:3500' })), true);
  assert.equal(isSameOriginProxyRequest(new Headers({ host: '127.0.0.1:3500', 'x-forwarded-host': 'hq.example.com', origin: 'https://hq.example.com' })), true);
});

test('other websites and opaque origins are refused', () => {
  assert.equal(isSameOriginProxyRequest(new Headers({ host: 'localhost:3500', origin: 'https://evil.example' })), false);
  assert.equal(isSameOriginProxyRequest(new Headers({ host: 'localhost:3500', origin: 'http://localhost:3501' })), false);
  assert.equal(isSameOriginProxyRequest(new Headers({ host: 'localhost:3500', origin: 'null' })), false);
});
