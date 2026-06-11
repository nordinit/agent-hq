import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeOpenApiDocument } from './docsSummary.ts';

test('summarizes OpenAPI operations by method and tag', () => {
  const summary = summarizeOpenApiDocument({
    openapi: '3.0.3',
    info: {
      title: 'Agent HQ API',
      version: '1.2.3',
    },
    servers: [{ url: '/api/v1' }],
    tags: [
      { name: 'Tasks', description: 'Task workflow APIs.' },
      { name: 'Agents', description: 'Agent configuration APIs.' },
    ],
    components: {
      schemas: {
        Task: { type: 'object' },
        Agent: { type: 'object' },
      },
    },
    paths: {
      '/tasks': {
        get: { tags: ['Tasks'], summary: 'List tasks' },
        post: { tags: ['Tasks'], summary: 'Create task' },
        parameters: [],
      },
      '/agents/{id}': {
        get: { tags: ['Agents'], summary: 'Read agent' },
        patch: { tags: ['Agents', 'Tasks'], summary: 'Update assignment' },
      },
    },
  });

  assert.equal(summary.title, 'Agent HQ API');
  assert.equal(summary.version, '1.2.3');
  assert.equal(summary.openapiVersion, '3.0.3');
  assert.equal(summary.serverUrl, '/api/v1');
  assert.equal(summary.pathCount, 2);
  assert.equal(summary.endpointCount, 4);
  assert.equal(summary.schemaCount, 2);
  assert.equal(summary.tagCount, 2);
  assert.deepEqual(summary.methods, [
    { method: 'get', count: 2 },
    { method: 'post', count: 1 },
    { method: 'patch', count: 1 },
  ]);
  assert.deepEqual(summary.groups.map(group => [group.name, group.endpointCount]), [
    ['Tasks', 3],
    ['Agents', 2],
  ]);
  assert.equal(summary.groups[0].description, 'Task workflow APIs.');
  assert.deepEqual(summary.operations.map(operation => [operation.method, operation.path, operation.summary]), [
    ['get', '/tasks', 'List tasks'],
    ['post', '/tasks', 'Create task'],
    ['get', '/agents/{id}', 'Read agent'],
    ['patch', '/agents/{id}', 'Update assignment'],
  ]);
  assert.deepEqual(summary.groups[0].operations.map(operation => operation.summary), [
    'List tasks',
    'Create task',
    'Update assignment',
  ]);
});

test('falls back gracefully for sparse OpenAPI documents', () => {
  const summary = summarizeOpenApiDocument({
    paths: {
      '/health': {
        get: {},
        trace: {},
        'x-internal': {},
      },
    },
  });

  assert.equal(summary.title, 'Agent HQ API');
  assert.equal(summary.version, 'unknown');
  assert.equal(summary.serverUrl, '/api/v1');
  assert.equal(summary.endpointCount, 2);
  assert.equal(summary.schemaCount, 0);
  assert.equal(summary.tagCount, 1);
  assert.deepEqual(summary.groups, [
    {
      name: 'Untagged',
      description: null,
      endpointCount: 2,
      methods: [
        { method: 'get', count: 1 },
        { method: 'trace', count: 1 },
      ],
      operations: [
        {
          method: 'get',
          path: '/health',
          summary: 'GET /health',
          description: null,
          operationId: null,
          tags: ['Untagged'],
          primaryTag: 'Untagged',
        },
        {
          method: 'trace',
          path: '/health',
          summary: 'TRACE /health',
          description: null,
          operationId: null,
          tags: ['Untagged'],
          primaryTag: 'Untagged',
        },
      ],
    },
  ]);
});
