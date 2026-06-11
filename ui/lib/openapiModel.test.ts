import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOpenApiOperations } from './openapiModel.ts';

const document = {
  openapi: '3.0.3',
  info: {
    title: 'Agent HQ API',
    version: '1.0.0',
  },
  servers: [{ url: '/api/v1' }],
  security: [{ sessionCookie: [] }],
  tags: [
    { name: 'Tasks', description: 'Task workflow APIs.' },
    { name: 'Projects', description: 'Project APIs.' },
  ],
  components: {
    parameters: {
      TaskId: {
        name: 'id',
        in: 'path',
        required: true,
        description: 'Task ID.',
        schema: { type: 'integer', minimum: 1 },
      },
    },
    responses: {
      Error: {
        description: 'Request failed.',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorResponse' },
            example: { error: 'Request failed' },
          },
        },
      },
    },
    schemas: {
      Task: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          title: { type: 'string' },
        },
      },
      TaskCreateRequest: {
        type: 'object',
        properties: {
          title: { type: 'string', default: 'New task' },
          priority: { type: 'string', enum: ['high', 'normal'] },
        },
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          error: { type: 'string' },
        },
      },
    },
  },
  paths: {
    '/tasks': {
      get: {
        tags: ['Tasks'],
        summary: 'List tasks',
        operationId: 'listTasks',
        parameters: [
          {
            name: 'status',
            in: 'query',
            description: 'Filter by status.',
            schema: { type: 'string' },
            example: 'in_progress',
          },
        ],
        responses: {
          '200': {
            description: 'Task list.',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/Task' },
                },
              },
            },
          },
          default: { $ref: '#/components/responses/Error' },
        },
      },
      post: {
        tags: ['Tasks'],
        summary: 'Create task',
        operationId: 'createTask',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/TaskCreateRequest' },
              example: { title: 'Ship parser', priority: 'high' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Created task.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Task' },
              },
            },
          },
        },
      },
    },
    '/tasks/{id}': {
      parameters: [{ $ref: '#/components/parameters/TaskId' }],
      get: {
        tags: ['Tasks', 'Projects'],
        summary: 'Read task',
        operationId: 'getTask',
        responses: {
          '200': {
            description: 'Task.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Task' },
                examples: {
                  sample: {
                    value: { id: 1, title: 'Example' },
                  },
                },
              },
            },
          },
        },
      },
      delete: {
        tags: ['Tasks'],
        summary: 'Delete task',
        operationId: 'deleteTask',
        security: [],
        responses: {
          '204': { description: 'Deleted.' },
        },
      },
    },
    '/tasks/{taskId}/notes': {
      post: {
        tags: ['Tasks'],
        summary: 'Add task note',
        responses: {
          '200': { description: 'Added.' },
        },
      },
    },
  },
};

test('parses endpoint groups and operation details for representative operations', () => {
  const model = parseOpenApiOperations(document);

  assert.equal(model.title, 'Agent HQ API');
  assert.equal(model.serverUrl, '/api/v1');
  assert.deepEqual(model.groups.map(group => [group.name, group.endpointCount]), [
    ['Tasks', 5],
    ['Projects', 1],
  ]);
  assert.equal(model.groups[0].description, 'Task workflow APIs.');
  assert.equal(model.operations.length, 5);

  const listTasks = model.operations.find(operation => operation.operationId === 'listTasks');
  assert.ok(listTasks);
  assert.equal(listTasks.method, 'get');
  assert.equal(listTasks.safety, 'safe');
  assert.deepEqual(listTasks.queryParameters.map(parameter => [parameter.name, parameter.required, parameter.example]), [
    ['status', false, 'in_progress'],
  ]);
  assert.deepEqual(listTasks.responses.map(response => response.statusCode), ['200', 'default']);
  assert.deepEqual(listTasks.responses[0].mediaTypes[0].schemaRefs, ['Task']);
  assert.deepEqual(listTasks.responses[1].mediaTypes[0].example, { error: 'Request failed' });
  assert.deepEqual(listTasks.security, [[{ scheme: 'sessionCookie', scopes: [] }]]);
});

test('normalizes POST request body schemas and examples for the request builder', () => {
  const model = parseOpenApiOperations(document);
  const createTask = model.operations.find(operation => operation.operationId === 'createTask');

  assert.ok(createTask);
  assert.equal(createTask.method, 'post');
  assert.equal(createTask.safety, 'mutating');
  assert.equal(createTask.requestBody?.required, true);
  assert.equal(createTask.requestBody?.json?.contentType, 'application/json');
  assert.equal(createTask.requestBody?.json?.schemaName, 'TaskCreateRequest');
  assert.deepEqual(createTask.requestBody?.json?.initialValue, { title: 'Ship parser', priority: 'high' });
  assert.match(createTask.searchText, /taskcreaterequest/);
});

test('merges path-level parameters, multi-tag groups, response examples, and operation security', () => {
  const model = parseOpenApiOperations(document);
  const getTask = model.operations.find(operation => operation.operationId === 'getTask');

  assert.ok(getTask);
  assert.deepEqual(getTask.tags, ['Tasks', 'Projects']);
  assert.deepEqual(getTask.pathParameters.map(parameter => [parameter.name, parameter.required, parameter.schema?.type]), [
    ['id', true, 'integer'],
  ]);
  assert.deepEqual(getTask.responses[0].mediaTypes[0].examples, {
    sample: { id: 1, title: 'Example' },
  });
  assert.ok(model.groups.find(group => group.name === 'Projects')?.operations.includes(getTask));

  const deleteTask = model.operations.find(operation => operation.operationId === 'deleteTask');
  assert.ok(deleteTask);
  assert.equal(deleteTask.safety, 'destructive');
  assert.deepEqual(deleteTask.security, []);
});

test('handles missing optional OpenAPI fields and infers path parameters without crashing', () => {
  const model = parseOpenApiOperations({
    paths: {
      '/health': {
        get: {},
      },
      '/projects/{projectId}/tasks': {
        post: {
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    title: { type: 'string', default: 'Untitled' },
                    notify: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  assert.equal(model.title, 'Agent HQ API');
  assert.equal(model.version, 'unknown');
  assert.equal(model.groups[0].name, 'Untagged');
  assert.equal(model.operations[0].id, 'getHealth');
  assert.equal(model.operations[0].summary, 'GET /health');
  assert.deepEqual(model.operations[1].pathParameters.map(parameter => [parameter.name, parameter.required, parameter.schema?.type]), [
    ['projectId', true, 'string'],
  ]);
  assert.deepEqual(model.operations[1].requestBody?.json?.initialValue, {
    title: 'Untitled',
    notify: false,
  });
});
