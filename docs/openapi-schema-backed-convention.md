# Schema-backed OpenAPI generation convention

Status: proposed convention for Task #654

## Goal

Agent HQ should reduce drift between Express handlers, validation schemas, and the published OpenAPI document by making each documented route declare a small, typed contract next to the route implementation. The contract should reuse the same Zod schemas that request validation and response shaping use. The existing `api/src/openapi/document.ts` builder should remain the aggregation layer while routes migrate incrementally from handwritten operations to route/schema-backed fragments.

This convention is intentionally pragmatic: it does not require replacing the router stack, blocking current docs console work, or documenting unsafe internal routes.

## Source-of-truth rule

For new or migrated routes, the source of truth is:

1. Zod schemas for path params, query params, request body, and named responses.
2. Route metadata for method, path, operation ID, tags, summary, description, examples, and visibility.
3. The Express handler using those same schemas through validation middleware or explicit `safeParse` calls.

The OpenAPI document builder consumes route contracts and emits OpenAPI operations. It remains responsible for top-level document metadata, tag ordering/descriptions, shared security schemes, shared error responses, and compatibility with the docs console.

## Contract shape

Route contracts should live in the same module as the route when the route is small, or in a nearby `*.contract.ts` file when the router is large.

```ts
import { z } from 'zod';
import { defineRouteContract } from '../openapi/routeContract';

export const route = defineRouteContract({
  method: 'GET',
  path: '/api/v1/projects/:project_id/tasks',
  operationId: 'listProjectTasks',
  tags: ['Tasks'],
  summary: 'List tasks for a project.',
  description: 'Returns project-scoped tasks with optional workflow/status filters.',

  // `public` routes are eligible for `/openapi.json`.
  // `internal` routes are intentionally omitted from the public document.
  // `deferred` routes are omitted until redaction/auth/examples are approved.
  visibility: 'public',

  params: z.object({
    project_id: z.coerce.number().int().positive().describe('Project ID'),
  }),
  query: z.object({
    status: z.string().optional().describe('Filter by task status'),
    workflow_id: z.coerce.number().int().positive().optional().describe('Filter by workflow ID'),
    limit: z.coerce.number().int().min(1).max(100).default(50).describe('Maximum rows to return'),
  }),
  responses: {
    200: {
      description: 'Task list.',
      schema: TaskListResponseSchema,
      example: {
        ok: true,
        tasks: [{ id: 654, title: 'Design schema-backed OpenAPI generation convention', status: 'in_progress' }],
      },
    },
    default: { ref: 'Error' },
  },
});
```

Recommended TypeScript shape:

```ts
export type RouteVisibility = 'public' | 'internal' | 'deferred' | 'unsafe';

export type RouteContract = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;              // Express path, e.g. /api/v1/tasks/:task_id
  operationId: string;       // stable and unique
  tags: string[];            // must exist in the document tag registry
  summary: string;
  description?: string;
  visibility: RouteVisibility;
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  responses: Record<number | 'default', RouteResponseContract>;
  examples?: Record<string, unknown>; // optional named examples for richer docs
  security?: OpenApiSecurityRequirement[];
};
```

## Visibility and intentional exclusion

Every route contract must declare one visibility value:

- `public`: included in public self-hosted OpenAPI output.
- `internal`: intentionally excluded because it is a runtime callback, local filesystem/artifact route, browser/runtime control route, raw log/transcript route, credential/token route, or another internal control-plane route.
- `deferred`: excluded for now, but potentially public after auth, redaction, and examples are approved.
- `unsafe`: excluded and expected to remain undocumented publicly unless the product/security posture changes.

Internal/deferred/unsafe contracts are still useful because they give route inventory tests a canonical reason for exclusion. The OpenAPI aggregator should filter to `visibility === 'public'` for `/openapi.json`, and route coverage tests should assert that every mounted route is either documented or explicitly excluded.

Example internal route contract:

```ts
export const runtimeCallbackContract = defineRouteContract({
  method: 'POST',
  path: '/api/v1/runtime/callbacks/:token',
  operationId: 'receiveRuntimeCallback',
  tags: ['Runtime'],
  summary: 'Receive runtime callback events.',
  visibility: 'internal',
  internalReason: 'Callback token and runtime payload semantics are internal control-plane behavior.',
  params: z.object({ token: z.string().min(1) }),
  body: RuntimeCallbackPayloadSchema,
  responses: { 200: { description: 'Accepted.', schema: OkResponseSchema } },
});
```

## Schema declaration rules

1. Use Zod objects for params, query, and bodies. Prefer `z.coerce.number()` / `z.coerce.boolean()` for Express string inputs when handlers already coerce.
2. Reuse response schemas from service/domain serializers instead of inventing docs-only schemas. If the handler returns masked/omitted fields, the response schema should model the masked/omitted shape.
3. Use `.describe()` on public fields whose meaning is not obvious. Use descriptions for sensitive fields that explain whether the value is masked, omitted, or a placeholder.
4. Examples must be safe: no secrets, runtime tokens, hook auth headers, local filesystem paths, raw logs, private transcripts, or real customer/task data.
5. Keep `operationId` stable once published. Rename only with an explicit compatibility note.
6. Prefer canonical workflow route/field names in new public docs. Sprint aliases can remain compatibility operations only when product needs them documented.

## GET route example

```ts
// api/src/routes/projects.contract.ts
import { z } from 'zod';
import { defineRouteContract } from '../openapi/routeContract';

const ProjectParamsSchema = z.object({
  project_id: z.coerce.number().int().positive().describe('Project ID'),
});

const ProjectTasksQuerySchema = z.object({
  status: z.string().optional().describe('Optional workflow status filter'),
  workflow_id: z.coerce.number().int().positive().optional().describe('Optional workflow ID filter'),
  limit: z.coerce.number().int().min(1).max(100).default(50).describe('Maximum rows to return'),
});

const ProjectTaskSummarySchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  status: z.string(),
  priority: z.string().nullable(),
  workflow_id: z.number().int().positive().nullable(),
});

export const ProjectTasksResponseSchema = z.object({
  ok: z.literal(true),
  tasks: z.array(ProjectTaskSummarySchema),
});

export const listProjectTasksContract = defineRouteContract({
  method: 'GET',
  path: '/api/v1/projects/:project_id/tasks',
  operationId: 'listProjectTasks',
  tags: ['Tasks'],
  summary: 'List project tasks.',
  visibility: 'public',
  params: ProjectParamsSchema,
  query: ProjectTasksQuerySchema,
  responses: {
    200: {
      description: 'Project task list.',
      schema: ProjectTasksResponseSchema,
      example: {
        ok: true,
        tasks: [
          { id: 654, title: 'Design schema-backed OpenAPI generation convention', status: 'in_progress', priority: 'low', workflow_id: 12 },
        ],
      },
    },
    default: { ref: 'Error' },
  },
});
```

```ts
// api/src/routes/projects.ts
router.get(
  '/:project_id/tasks',
  validateRequest(listProjectTasksContract),
  async (req, res) => {
    const { project_id } = req.validated.params;
    const { status, workflow_id, limit } = req.validated.query;
    const tasks = await taskService.listProjectTasks({ project_id, status, workflow_id, limit });
    res.json(ProjectTasksResponseSchema.parse({ ok: true, tasks }));
  },
);
```

## POST route example

```ts
// api/src/routes/tasks.contract.ts
import { z } from 'zod';
import { defineRouteContract } from '../openapi/routeContract';

export const CreateTaskBodySchema = z.object({
  project_id: z.number().int().positive().describe('Project ID'),
  workflow_id: z.number().int().positive().optional().describe('Workflow ID. Prefer workflow_id over legacy sprint_id.'),
  title: z.string().min(1).max(240),
  description: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  task_type: z.string().optional(),
});

export const TaskMutationResponseSchema = z.object({
  ok: z.literal(true),
  task: z.object({
    id: z.number().int().positive(),
    project_id: z.number().int().positive(),
    workflow_id: z.number().int().positive().nullable(),
    title: z.string(),
    status: z.string(),
  }),
});

export const createTaskContract = defineRouteContract({
  method: 'POST',
  path: '/api/v1/tasks',
  operationId: 'createTask',
  tags: ['Tasks'],
  summary: 'Create a task.',
  description: 'Creates a task in a project. New clients should use workflow_id instead of legacy sprint_id.',
  visibility: 'public',
  body: CreateTaskBodySchema,
  examples: {
    body: {
      project_id: 1,
      workflow_id: 12,
      title: 'Add route contract coverage',
      description: 'Migrate the task creation route to a schema-backed OpenAPI contract.',
      priority: 'medium',
      task_type: 'implementation',
    },
  },
  responses: {
    201: {
      description: 'Created task.',
      schema: TaskMutationResponseSchema,
      example: {
        ok: true,
        task: { id: 655, project_id: 1, workflow_id: 12, title: 'Add route contract coverage', status: 'todo' },
      },
    },
    400: { ref: 'Error' },
    422: { ref: 'Error' },
    default: { ref: 'Error' },
  },
});
```

```ts
// api/src/routes/tasks.ts
router.post(
  '/',
  validateRequest(createTaskContract),
  async (req, res) => {
    const input = req.validated.body;
    const task = await taskService.createTask(input);
    res.status(201).json(TaskMutationResponseSchema.parse({ ok: true, task }));
  },
);
```

## OpenAPI aggregation

Keep `api/src/openapi/document.ts` as the aggregation layer, but split responsibilities:

- `document.ts`: top-level document metadata, tags, servers, shared security, shared components, compatibility helpers, and aggregation of generated operations.
- `routeContract.ts`: helper types and `defineRouteContract()` identity function for type safety.
- `zodToOpenApi.ts`: converts Zod schemas to JSON Schema/OpenAPI schemas, using Zod 4 JSON Schema conversion where possible and a small compatibility shim for OpenAPI nullable/default/description behavior.
- `registry.ts`: collects public route contracts from route modules, filters by visibility, validates unique operation IDs, and emits `paths` fragments.

The builder should support both generated fragments and current handwritten fragments during migration:

```ts
export const openApiDocument = buildOpenApiDocument({
  manualPaths,
  routeContracts,
  includeVisibility: ['public'],
});
```

Manual paths can continue to serve the docs console while individual routes migrate. A migrated route should not exist in both `manualPaths` and `routeContracts` unless the test suite intentionally asserts identical output during a short transition.

## Migration plan

1. Add the contract helper and registry without changing the published document output.
2. Add route inventory tests that classify mounted routes as `public`, `internal`, `deferred`, or `unsafe`; start with warnings or a small allowlist so this does not block current docs console work.
3. Pick one low-risk route group, such as health/setup/providers, and move its schemas from handwritten `components.schemas` into Zod response/request schemas while preserving the generated OpenAPI output shape.
4. Wire those route contracts into the aggregator and remove only the equivalent handwritten operations after snapshot/structural tests pass.
5. Migrate larger groups incrementally: projects, workflows, tasks, agents/tools, routing, chat/sessions. Prefer public canonical workflow endpoints before legacy sprint aliases.
6. For each migrated route, make the Express validation path consume the same contract schemas or document why the handler cannot yet do so.
7. Keep deferred/internal route groups excluded until the public docs policy approves redaction, auth, and examples.
8. After enough coverage exists, change the route inventory test from warning/allowlist mode to enforcing that every mounted route is either documented or intentionally excluded.

## Verification expectations

For each migrated route group:

- `api/src/openapi/openapi.test.ts` should validate the OpenAPI document and assert core operation details that matter for public docs.
- Route tests should cover validation behavior for params/query/body when schemas are newly attached to handlers.
- A route inventory test should verify public routes are represented in generated paths and non-public routes have an explicit visibility reason.
- Run `npm test -- --runInBand src/openapi/openapi.test.ts` and `npm run build` from `api/`.

## Decision summary

- Use Zod-backed route contracts as the route/schema/docs convention.
- Declare params, query, body, response schemas, examples, tags, operation metadata, and visibility in each contract.
- Support intentional exclusion through required `visibility` and exclusion reason metadata for non-public routes.
- Keep the current OpenAPI document builder as the aggregation layer.
- Migrate incrementally by mixing generated route fragments with the existing handwritten document until route groups are safely moved.
