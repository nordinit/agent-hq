import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCurlSnippet,
  buildDefaultTryItParameterValues,
  buildSameOriginTryItPath,
  buildTryItRequest,
  isDestructiveOperation,
  isMutatingHttpMethod,
} from './apiTryIt.ts';

test('buildSameOriginTryItPath defaults OpenAPI paths to the same-origin API v1 proxy', () => {
  assert.equal(buildSameOriginTryItPath('/health'), '/api/v1/health');
  assert.equal(buildSameOriginTryItPath('/api/v1/health'), '/api/v1/health');
});

test('buildTryItRequest substitutes path params and appends query params', () => {
  const result = buildTryItRequest({
    method: 'get',
    path: '/tasks/{task_id}',
    parameters: [
      { name: 'task_id', location: 'path', required: true },
      { name: 'include_notes', location: 'query', required: false },
    ],
    parameterValues: {
      'path:task_id': '655',
      'query:include_notes': 'true',
    },
  });

  assert.deepEqual(result.validationErrors, []);
  assert.equal(result.url, '/api/v1/tasks/655?include_notes=true');
  assert.equal(result.init.method, 'GET');
});

test('buildTryItRequest catches missing required params before sending', () => {
  const result = buildTryItRequest({
    method: 'get',
    path: '/tasks/{task_id}',
    parameters: [{ name: 'task_id', location: 'path', required: true }],
    parameterValues: { 'path:task_id': '' },
  });

  assert.equal(result.validationErrors.length, 1);
  assert.match(result.validationErrors[0], /task_id/);
  assert.equal(result.url, '/api/v1/tasks/{task_id}');
});

test('buildTryItRequest does not double-prefix operation paths that already include API v1', () => {
  const result = buildTryItRequest({
    method: 'get',
    path: '/api/v1/projects',
    parameters: [],
    parameterValues: {},
  });

  assert.deepEqual(result.validationErrors, []);
  assert.equal(result.url, '/api/v1/projects');
  assert.equal(result.init.method, 'GET');
});

test('buildTryItRequest validates and compacts JSON request bodies', () => {
  const result = buildTryItRequest({
    method: 'post',
    path: '/api/v1/projects',
    parameters: [],
    parameterValues: {},
    requestBodyRequired: true,
    bodyText: '{ "name": "Demo" }',
  });

  assert.deepEqual(result.validationErrors, []);
  assert.equal(result.url, '/api/v1/projects');
  assert.equal(result.init.method, 'POST');
  assert.equal(result.init.body, '{"name":"Demo"}');
});

test('buildTryItRequest rejects invalid required JSON request bodies', () => {
  const result = buildTryItRequest({
    method: 'post',
    path: '/projects',
    parameters: [],
    parameterValues: {},
    requestBodyRequired: true,
    bodyText: '{',
  });

  assert.deepEqual(result.validationErrors, ['Request body must be valid JSON before sending.']);
});

test('buildDefaultTryItParameterValues uses available examples and schema fallbacks', () => {
  assert.deepEqual(
    buildDefaultTryItParameterValues([
      { name: 'q', location: 'query', required: false, example: 'agent' },
      { name: 'limit', location: 'query', required: false, schemaObject: { type: 'integer' } },
    ]),
    { 'query:q': 'agent', 'query:limit': '0' },
  );
});

test('buildTryItRequest applies a selected same-origin base URL without double API prefix', () => {
  const result = buildTryItRequest({
    method: 'get',
    path: '/api/v1/projects',
    parameters: [],
    parameterValues: {},
    baseUrl: 'http://localhost:3510/api/v1',
  });

  assert.equal(result.url, 'http://localhost:3510/api/v1/projects');
});

test('buildCurlSnippet mirrors method, url, headers, and compact JSON body', () => {
  const request = buildTryItRequest({
    method: 'post',
    path: '/projects',
    parameters: [{ name: 'X-Agent-HQ-Token', location: 'header', required: false }],
    parameterValues: { 'header:X-Agent-HQ-Token': 'token-123' },
    requestBodyRequired: true,
    bodyText: '{ "name": "Demo" }',
    baseUrl: 'http://localhost:3510/api/v1',
  });

  assert.equal(
    buildCurlSnippet(request),
    "curl --request POST 'http://localhost:3510/api/v1/projects' \\\n  --header 'accept: application/json' \\\n  --header 'content-type: application/json' \\\n  --header 'x-agent-hq-token: token-123' \\\n  --data-raw '{\"name\":\"Demo\"}'",
  );
});

test('mutating and destructive helpers classify unsafe operations', () => {
  assert.equal(isMutatingHttpMethod('POST'), true);
  assert.equal(isMutatingHttpMethod('get'), false);
  assert.equal(isDestructiveOperation('delete', '/tasks/{id}'), true);
  assert.equal(isDestructiveOperation('post', '/tasks/{id}/cancel'), true);
  assert.equal(isDestructiveOperation('post', '/projects'), false);
});
