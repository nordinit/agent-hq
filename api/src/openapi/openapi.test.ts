import express from 'express';
import type { Server } from 'http';
import SwaggerParser from '@apidevtools/swagger-parser';
import { getOpenApiDocument } from './document';
import openApiRouter from './router';

function collectRefs(value: unknown, refs: string[] = []): string[] {
  if (!value || typeof value !== 'object') return refs;
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
    return refs;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.$ref === 'string') refs.push(record.$ref);
  for (const nested of Object.values(record)) collectRefs(nested, refs);
  return refs;
}

function validateOpenApiDocument(document: ReturnType<typeof getOpenApiDocument>): void {
  expect(document.openapi).toMatch(/^3\./);
  expect(document.info.title).toBe('Agent HQ API');
  expect(Object.keys(document.paths).length).toBeGreaterThan(20);
  expect(document.components.schemas.Task).toBeDefined();
  expect(document.components.schemas.Project).toBeDefined();
  expect(document.components.schemas.ErrorResponse).toBeDefined();

  for (const [path, methods] of Object.entries(document.paths)) {
    expect(path.startsWith('/')).toBe(true);
    expect(path).not.toContain(':');
    expect(path).not.toMatch(/^\/api\/v1\/(instances|dispatch|browser|logs|telemetry|artifacts|settings|github-identities|mcp-servers)(\/|$)/);

    for (const [method, operation] of Object.entries(methods)) {
      expect(['get', 'post', 'put', 'delete', 'patch']).toContain(method);
      expect(operation.operationId).toEqual(expect.any(String));
      expect(operation.summary).toEqual(expect.any(String));
      expect(operation.responses).toBeDefined();
      expect(Object.keys(operation.responses).length).toBeGreaterThan(0);
    }
  }

  const schemaNames = new Set(Object.keys(document.components.schemas));
  const responseNames = new Set(Object.keys(document.components.responses));
  for (const ref of collectRefs(document)) {
    if (ref.startsWith('#/components/schemas/')) {
      expect(schemaNames.has(ref.replace('#/components/schemas/', ''))).toBe(true);
    } else if (ref.startsWith('#/components/responses/')) {
      expect(responseNames.has(ref.replace('#/components/responses/', ''))).toBe(true);
    } else {
      throw new Error(`Unsupported OpenAPI ref: ${ref}`);
    }
  }
}

describe('Agent HQ OpenAPI document', () => {
  it('is a valid OpenAPI 3.x document with resolved local refs', async () => {
    const document = getOpenApiDocument();

    validateOpenApiDocument(document);
    const parserDocument = JSON.parse(JSON.stringify(document)) as Parameters<typeof SwaggerParser.validate>[0];
    await expect(SwaggerParser.validate(parserDocument)).resolves.toBeDefined();
  });

  it('documents representative task request and response schemas', () => {
    const document = getOpenApiDocument();
    const taskSchema = document.components.schemas.Task as Record<string, unknown>;
    const createSchema = document.components.schemas.TaskCreateRequest as Record<string, unknown>;
    const outcomeSchema = document.components.schemas.TaskOutcomeRequest as Record<string, unknown>;
    const taskPath = document.paths['/api/v1/tasks'];
    const outcomeProperties = outcomeSchema.properties as Record<string, unknown>;

    expect(taskSchema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['id', 'title', 'status']),
    });
    expect(createSchema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['title']),
    });
    expect(taskPath.post.requestBody).toMatchObject({
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/TaskCreateRequest' },
        },
      },
    });
    expect(taskPath.post.responses['201']).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/Task' },
        },
      },
    });
    expect(outcomeProperties.payload).toMatchObject({
      type: 'object',
      additionalProperties: true,
    });
    for (const legacyField of [
      'review_branch',
      'review_commit',
      'review_url',
      'qa_verified_commit',
      'qa_tested_url',
      'merged_commit',
      'deployed_commit',
      'deploy_target',
      'deployed_at',
      'live_verified_by',
      'live_verified_at',
    ]) {
      expect(outcomeProperties).not.toHaveProperty(legacyField);
    }
  });

  it('documents workflows as the first-class board lifecycle surface while keeping sprint aliases', () => {
    const document = getOpenApiDocument();
    const tagNames = document.tags.map(tag => tag.name);

    expect(tagNames).toContain('Workflows');
    expect(tagNames).toContain('Sprints');
    expect(document.paths['/api/v1/workflows'].get.summary).toBe('List workflows.');
    expect(document.paths['/api/v1/workflows'].get.responses['200']).toMatchObject({
      content: {
        'application/json': {
          schema: { type: 'array', items: { $ref: '#/components/schemas/Workflow' } },
        },
      },
    });
    expect(document.paths['/api/v1/sprints'].get.description).toContain('Legacy alias');
    expect(document.components.schemas.Workflow).toBeDefined();
    expect(document.components.schemas.WorkflowLifecycleResponse).toBeDefined();
  });

  it('documents Codex as a runtime and exposes no-model-spend runtime diagnostics', () => {
    const document = getOpenApiDocument();
    const agentSchema = document.components.schemas.Agent as Record<string, any>;
    const createSchema = document.components.schemas.AgentCreateRequest as Record<string, any>;

    expect(agentSchema.properties.runtime_type.enum).toContain('codex');
    expect(createSchema.properties.runtime_type.enum).toContain('codex');
    expect(document.paths['/api/v1/runtime-drivers/diagnose'].post).toMatchObject({
      operationId: 'diagnoseRuntimeDriver',
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/RuntimeDriverDiagnostic' },
            },
          },
        },
      },
    });
  });

  it('serves the same document from root and versioned OpenAPI routes', async () => {
    const app = express();
    app.use(openApiRouter);
    app.use('/api/v1', openApiRouter);

    let server: Server | null = null;
    const baseUrl = await new Promise<string>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });

    try {
      const [rootResponse, versionedResponse] = await Promise.all([
        fetch(`${baseUrl}/openapi.json`),
        fetch(`${baseUrl}/api/v1/openapi.json`),
      ]);

      expect(rootResponse.status).toBe(200);
      expect(versionedResponse.status).toBe(200);
      expect(rootResponse.headers.get('content-type')).toContain('application/json');

      const rootDocument = await rootResponse.json() as ReturnType<typeof getOpenApiDocument>;
      const versionedDocument = await versionedResponse.json() as ReturnType<typeof getOpenApiDocument>;
      expect(versionedDocument).toEqual(rootDocument);
      validateOpenApiDocument(rootDocument);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => err ? reject(err) : resolve());
      });
    }
  });
});
