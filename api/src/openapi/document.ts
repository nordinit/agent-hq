type JsonSchema = Record<string, unknown>;

type OpenApiOperation = {
  tags: string[];
  summary: string;
  description?: string;
  operationId: string;
  parameters?: JsonSchema[];
  requestBody?: JsonSchema;
  responses: Record<string, JsonSchema>;
};

type OpenApiDocument = {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{ url: string; description: string }>;
  tags: Array<{ name: string; description: string }>;
  security?: Array<Record<string, string[]>>;
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    securitySchemes: Record<string, JsonSchema>;
    parameters: Record<string, JsonSchema>;
    schemas: Record<string, JsonSchema>;
    responses: Record<string, JsonSchema>;
  };
};

const jsonContent = (schema: JsonSchema, example?: unknown): JsonSchema => ({
  content: {
    'application/json': {
      schema,
      ...(example === undefined ? {} : { example }),
    },
  },
});

const response = (description: string, schema: JsonSchema, example?: unknown): JsonSchema => ({
  description,
  ...jsonContent(schema, example),
});

const requestBody = (schema: JsonSchema, example?: unknown, required = true): JsonSchema => ({
  required,
  ...jsonContent(schema, example),
});

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (schema: JsonSchema): JsonSchema => ({ type: 'array', items: schema });

const idParam = (name: string, description: string): JsonSchema => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'integer', minimum: 1 },
});

const stringQuery = (name: string, description: string): JsonSchema => ({
  name,
  in: 'query',
  required: false,
  description,
  schema: { type: 'string' },
});

const intQuery = (name: string, description: string): JsonSchema => ({
  name,
  in: 'query',
  required: false,
  description,
  schema: { type: 'integer', minimum: 0 },
});

const boolQuery = (name: string, description: string): JsonSchema => ({
  name,
  in: 'query',
  required: false,
  description,
  schema: { type: 'boolean' },
});

const okResponse = response('Operation succeeded.', ref('OkResponse'), { ok: true });
const errorResponseRef = { $ref: '#/components/responses/Error' };
const notFoundResponseRef = { $ref: '#/components/responses/NotFound' };

// OpenAPI source of truth for the initial self-hosted public API surface.
// Add future public routes by extending the component schemas first, then adding
// operations under paths. Keep routes listed as internal/deferred in
// docs/api-public-scope-inventory.md and docs/api-public-docs-policy.md out of
// this document until their redaction, auth, and examples are approved.
export const openApiDocument: OpenApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Agent HQ API',
    version: '1.0.0',
    description: [
      'Public self-hosted REST API for Agent HQ operator workflows.',
      'The document intentionally excludes runtime callback hooks, local filesystem artifact routes, logs, gateway tokens, credential registries, and other internal-only endpoints.',
    ].join(' '),
  },
  servers: [
    { url: '/', description: 'Same-origin Agent HQ API server' },
  ],
  security: [],
  tags: [
    { name: 'Health', description: 'Service health and discovery.' },
    { name: 'Setup', description: 'First-run setup state.' },
    { name: 'Providers', description: 'AI provider configuration with masked secret responses.' },
    { name: 'Tenants', description: 'Tenant isolation context. Tenant endpoints are canonical; company endpoints remain deprecated compatibility aliases.' },
    { name: 'Projects', description: 'Project configuration and project metrics.' },
    { name: 'Project Files', description: 'Project-scoped file metadata and uploads.' },
    { name: 'Workflows', description: 'Workflow lifecycle and workflow metadata. These are the preferred endpoints for boards and operating cycles.' },
    { name: 'Sprints', description: 'Legacy aliases for workflow lifecycle and metadata endpoints. Existing sprint clients remain supported.' },
    { name: 'Workflow Definitions', description: 'Workflow type, status, field schema, relationship, and outcome definitions. Sprint type routes remain legacy aliases during compatibility.' },
    { name: 'Tasks', description: 'Task records, workflow outcomes, evidence, notes, blockers, attachments, and history.' },
    { name: 'Agents', description: 'Agent configuration, skills, tool assignments, and routing config.' },
    { name: 'Skills', description: 'Installed Agent HQ skill definitions.' },
    { name: 'Tools', description: 'Reusable local tool definitions and agent assignments.' },
    { name: 'Routing', description: 'Workflow assignment rules, statuses, transitions, and event mappings.' },
    { name: 'Chat', description: 'Self-hosted chat attachment and session-message APIs.' },
    { name: 'Sessions', description: 'Captured runtime session metadata and messages.' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Read API process health.',
        operationId: 'getHealth',
        responses: {
          '200': response('The API process is healthy.', ref('HealthResponse'), {
            ok: true,
            service: 'Agent HQ API',
            ts: '2026-05-21T16:00:00.000Z',
          }),
        },
      },
    },
    '/mcp/catalog': {
      get: {
        tags: ['Health'],
        summary: 'Read the Agent HQ MCP catalog.',
        operationId: 'getMcpCatalog',
        responses: {
          '200': response('MCP catalog.', ref('McpCatalog')),
          default: errorResponseRef,
        },
      },
    },
    '/mcp/catalog/health': {
      get: {
        tags: ['Health'],
        summary: 'Read MCP catalog summary health.',
        operationId: 'getMcpCatalogHealth',
        responses: {
          '200': response('MCP catalog summary.', ref('McpCatalogHealth'), {
            ok: true,
            server: 'agent-hq',
            tool_count: 12,
            resource_count: 2,
            domains: ['tasks', 'routing'],
          }),
          default: errorResponseRef,
        },
      },
    },
    '/setup/status': {
      get: {
        tags: ['Setup'],
        summary: 'Read first-run setup status.',
        operationId: 'getSetupStatus',
        responses: {
          '200': response('Setup status.', ref('SetupStatus')),
          default: errorResponseRef,
        },
      },
    },
    '/setup/onboarding/complete': {
      post: {
        tags: ['Setup'],
        summary: 'Mark onboarding complete after provider and Atlas gates pass.',
        operationId: 'completeOnboarding',
        requestBody: requestBody(ref('EmptyObject'), {}, false),
        responses: {
          '200': response('Onboarding completed.', ref('OnboardingCompleteResponse')),
          '422': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/setup/onboarding/skip': {
      post: {
        tags: ['Setup'],
        summary: 'Skip the guided wizard for manual setup; creates an unprovisioned Atlas agent and marks onboarding complete without the provider gate.',
        operationId: 'skipOnboarding',
        requestBody: requestBody(ref('EmptyObject'), {}, false),
        responses: {
          '200': response('Onboarding skipped for manual setup.', ref('OnboardingSkipResponse')),
          default: errorResponseRef,
        },
      },
    },
    '/providers': {
      get: {
        tags: ['Providers'],
        summary: 'List configured AI providers.',
        operationId: 'listProviders',
        responses: {
          '200': response('Provider list.', ref('ProviderListResponse')),
          default: errorResponseRef,
        },
      },
      post: {
        tags: ['Providers'],
        summary: 'Create and validate an AI provider configuration.',
        operationId: 'createProvider',
        requestBody: requestBody(ref('ProviderCreateRequest'), {
          slug: 'openai',
          display_name: 'OpenAI',
          config: { api_key: 'sk-...' },
        }),
        responses: {
          '201': response('Created provider with masked config.', ref('ProviderMutationResponse')),
          '400': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/providers/gate': {
      get: {
        tags: ['Providers'],
        summary: 'Read provider onboarding gate status.',
        operationId: 'getProviderGate',
        responses: {
          '200': response('Provider gate summary.', ref('ProviderGate')),
          default: errorResponseRef,
        },
      },
    },
    '/providers/{slug}/models': {
      get: {
        tags: ['Providers'],
        summary: 'List assignable model options for a connected provider.',
        operationId: 'listProviderModels',
        parameters: [{
          name: 'slug',
          in: 'path',
          required: true,
          description: 'Provider slug.',
          schema: { type: 'string' },
        }],
        responses: {
          '200': response('Provider-scoped agent model options.', ref('ModelListResponse')),
          '400': errorResponseRef,
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/providers/{id}': {
      get: {
        tags: ['Providers'],
        summary: 'Read a provider configuration.',
        operationId: 'getProvider',
        parameters: [idParam('id', 'Provider ID.')],
        responses: {
          '200': response('Provider with masked config.', ref('Provider')),
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
      put: {
        tags: ['Providers'],
        summary: 'Update and revalidate a provider configuration.',
        operationId: 'updateProvider',
        parameters: [idParam('id', 'Provider ID.')],
        requestBody: requestBody(ref('ProviderUpdateRequest'), {
          display_name: 'OpenAI production',
          config: { api_key: 'sk-...' },
        }),
        responses: {
          '200': response('Updated provider with masked config.', ref('ProviderMutationResponse')),
          '400': errorResponseRef,
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
      delete: {
        tags: ['Providers'],
        summary: 'Delete a provider configuration.',
        operationId: 'deleteProvider',
        parameters: [idParam('id', 'Provider ID.')],
        responses: {
          '200': response('Provider deleted.', ref('ProviderDeleteResponse')),
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/providers/{id}/validate': {
      post: {
        tags: ['Providers'],
        summary: 'Validate a stored provider configuration.',
        operationId: 'validateProvider',
        parameters: [idParam('id', 'Provider ID.')],
        requestBody: requestBody(ref('EmptyObject'), {}, false),
        responses: {
          '200': response('Provider validation result.', ref('ProviderValidationResponse')),
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/tenants': {
      get: {
        tags: ['Tenants'],
        summary: 'List tenants and the active tenant context.',
        description: 'Canonical tenant list endpoint. `/api/v1/companies` remains available as a deprecated compatibility alias for existing clients.',
        operationId: 'listTenants',
        responses: {
          '200': response('Tenant list.', ref('TenantListResponse'), {
            tenants: [
              { id: 1, name: 'Default Tenant', slug: 'default', is_default: 1, project_count: 1, task_count: 0, agent_count: 1 },
            ],
            active_tenant_id: 1,
          }),
          default: errorResponseRef,
        },
      },
      post: {
        tags: ['Tenants'],
        summary: 'Create a tenant and seed its starter workspace.',
        description: 'Canonical tenant creation endpoint. `/api/v1/companies` remains available as a deprecated compatibility alias for existing clients.',
        operationId: 'createTenant',
        requestBody: requestBody(ref('TenantCreateRequest'), {
          name: 'Acme Ops',
          slug: 'acme-ops',
          set_active: true,
        }),
        responses: {
          '201': response('Created tenant.', ref('TenantMutationResponse'), {
            tenant: { id: 2, name: 'Acme Ops', slug: 'acme-ops', is_default: 0 },
            active_tenant_id: 2,
          }),
          '400': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/tenants/active': {
      get: {
        tags: ['Tenants'],
        summary: 'Read the active tenant context.',
        operationId: 'getActiveTenant',
        responses: {
          '200': response('Active tenant.', ref('TenantMutationResponse')),
          default: errorResponseRef,
        },
      },
      put: {
        tags: ['Tenants'],
        summary: 'Set the active tenant context.',
        description: '`tenant_id` is canonical. `company_id` remains accepted as a deprecated request-body alias for existing clients.',
        operationId: 'setActiveTenant',
        requestBody: requestBody(ref('TenantSelectRequest'), { tenant_id: 2 }),
        responses: {
          '200': response('Active tenant selected.', ref('TenantMutationResponse')),
          '400': errorResponseRef,
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/tenants/{id}/select': {
      post: {
        tags: ['Tenants'],
        summary: 'Select an active tenant by id.',
        operationId: 'selectTenant',
        parameters: [idParam('id', 'Tenant ID.')],
        requestBody: requestBody(ref('EmptyObject'), {}, false),
        responses: {
          '200': response('Tenant selected.', ref('TenantMutationResponse')),
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/tenants/{id}': {
      delete: {
        tags: ['Tenants'],
        summary: 'Delete a non-default tenant.',
        description: 'Deletes tenant-owned records. `confirmation` must match the tenant name exactly. `company_name` remains accepted as a deprecated request-body alias for existing clients.',
        operationId: 'deleteTenant',
        parameters: [idParam('id', 'Tenant ID.')],
        requestBody: requestBody(ref('TenantDeleteRequest'), { confirmation: 'Acme Ops' }),
        responses: {
          '200': response('Tenant deleted.', ref('TenantDeleteResponse')),
          '400': errorResponseRef,
          '404': notFoundResponseRef,
          '409': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/projects': {
      get: {
        tags: ['Projects'],
        summary: 'List projects.',
        operationId: 'listProjects',
        responses: {
          '200': response('Project list.', arrayOf(ref('Project'))),
          default: errorResponseRef,
        },
      },
      post: {
        tags: ['Projects'],
        summary: 'Create a project and starter backlog/routing.',
        operationId: 'createProject',
        requestBody: requestBody(ref('ProjectCreateRequest'), {
          name: 'Agent HQ Docs Site',
          description: 'Documentation and SDK readiness work.',
          repo_url: 'https://github.com/example/agent-hq-docs',
          repo_access_mode: 'clone',
        }),
        responses: {
          '201': response('Created project.', ref('Project')),
          '400': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/projects/default': {
      get: {
        tags: ['Projects'],
        summary: 'Read the default project.',
        operationId: 'getDefaultProject',
        responses: {
          '200': response('Default project.', ref('DefaultProjectResponse')),
          default: errorResponseRef,
        },
      },
    },
    '/projects/{id}': {
      get: {
        tags: ['Projects'],
        summary: 'Read project details.',
        operationId: 'getProject',
        parameters: [idParam('id', 'Project ID.')],
        responses: {
          '200': response('Project.', ref('Project')),
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
      put: {
        tags: ['Projects'],
        summary: 'Update project metadata and repository configuration.',
        operationId: 'updateProject',
        parameters: [idParam('id', 'Project ID.')],
        requestBody: requestBody(ref('ProjectUpdateRequest'), {
          name: 'Agent HQ Docs Site',
          repo_access_mode: 'worktree',
        }),
        responses: {
          '200': response('Updated project.', ref('Project')),
          '400': errorResponseRef,
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
      delete: {
        tags: ['Projects'],
        summary: 'Delete a project.',
        operationId: 'deleteProject',
        parameters: [
          idParam('id', 'Project ID.'),
          boolQuery('force', 'Force deletion of dependent records when supported.'),
        ],
        responses: {
          '200': response('Project deleted.', ref('ProjectDeleteResponse')),
          '409': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/projects/{id}/default': {
      put: {
        tags: ['Projects'],
        summary: 'Set the default project.',
        operationId: 'setDefaultProject',
        parameters: [idParam('id', 'Project ID.')],
        responses: {
          '200': response('Default project set.', ref('DefaultProjectResponse')),
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/projects/{id}/metrics': {
      get: {
        tags: ['Projects'],
        summary: 'Read project aggregate metrics.',
        operationId: 'getProjectMetrics',
        parameters: [idParam('id', 'Project ID.')],
        responses: {
          '200': response('Project metrics.', ref('ProjectMetrics')),
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/projects/{id}/files': {
      get: {
        tags: ['Project Files'],
        summary: 'List uploaded project files.',
        operationId: 'listProjectFiles',
        parameters: [idParam('id', 'Project ID.')],
        responses: {
          '200': response('Project files.', arrayOf(ref('ProjectFile'))),
          default: errorResponseRef,
        },
      },
      post: {
        tags: ['Project Files'],
        summary: 'Upload a project file.',
        operationId: 'uploadProjectFile',
        parameters: [idParam('id', 'Project ID.')],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: { file: { type: 'string', format: 'binary' } },
              },
            },
          },
        },
        responses: {
          '201': response('Uploaded project file metadata.', ref('ProjectFile')),
          '400': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/projects/{id}/files/{fileId}': {
      get: {
        tags: ['Project Files'],
        summary: 'Read uploaded project file metadata.',
        operationId: 'getProjectFile',
        parameters: [
          idParam('id', 'Project ID.'),
          idParam('fileId', 'Project file ID.'),
        ],
        responses: {
          '200': response('Project file metadata.', ref('ProjectFile')),
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
      put: {
        tags: ['Project Files'],
        summary: 'Replace the current project file content and record a new version.',
        operationId: 'replaceProjectFile',
        parameters: [
          idParam('id', 'Project ID.'),
          idParam('fileId', 'Project file ID.'),
        ],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: {
                  file: { type: 'string', format: 'binary' },
                  uploaded_by: { type: 'string' },
                  updated_by: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': response('Updated project file metadata.', ref('ProjectFile')),
          '400': errorResponseRef,
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
      delete: {
        tags: ['Project Files'],
        summary: 'Delete an uploaded project file.',
        operationId: 'deleteProjectFile',
        parameters: [
          idParam('id', 'Project ID.'),
          idParam('fileId', 'Project file ID.'),
        ],
        responses: {
          '200': okResponse,
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/projects/{id}/files/{fileId}/versions': {
      get: {
        tags: ['Project Files'],
        summary: 'List project file version history.',
        operationId: 'listProjectFileVersions',
        parameters: [
          idParam('id', 'Project ID.'),
          idParam('fileId', 'Project file ID.'),
        ],
        responses: {
          '200': response('Project file versions.', arrayOf(ref('ProjectFileVersion'))),
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/projects/{id}/files/{fileId}/download': {
      get: {
        tags: ['Project Files'],
        summary: 'Download uploaded project file content.',
        operationId: 'downloadProjectFile',
        parameters: [
          idParam('id', 'Project ID.'),
          idParam('fileId', 'Project file ID.'),
        ],
        responses: {
          '200': {
            description: 'Project file bytes.',
            content: {
              'application/octet-stream': {
                schema: { type: 'string', format: 'binary' },
              },
            },
          },
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/sprints': {
      get: {
        tags: ['Sprints'],
        summary: 'List sprints (legacy workflow alias).',
        description: 'Legacy alias for listing workflows. Prefer GET /api/v1/workflows in new clients.',
        operationId: 'listSprints',
        parameters: [
          intQuery('project_id', 'Filter by project ID.'),
          stringQuery('status', 'Filter by sprint status.'),
        ],
        responses: {
          '200': response('Sprint list.', arrayOf(ref('Sprint'))),
          default: errorResponseRef,
        },
      },
      post: {
        tags: ['Sprints'],
        summary: 'Create a sprint (legacy workflow alias).',
        description: 'Legacy alias for creating a workflow. Prefer POST /api/v1/workflows in new clients.',
        operationId: 'createSprint',
        requestBody: requestBody(ref('SprintCreateRequest'), {
          project_id: 1,
          name: 'Docs Site Sprint',
          goal: 'Publish self-hosting docs',
          sprint_type: 'dev',
        }),
        responses: {
          '201': response('Created sprint.', ref('Sprint')),
          '400': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/sprints/{id}': {
      get: {
        tags: ['Sprints'],
        summary: 'Read sprint details (legacy workflow alias).',
        description: 'Legacy alias for reading workflow details. Prefer GET /api/v1/workflows/{id} in new clients.',
        operationId: 'getSprint',
        parameters: [idParam('id', 'Sprint ID.')],
        responses: {
          '200': response('Sprint.', ref('Sprint')),
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
      put: {
        tags: ['Sprints'],
        summary: 'Update a sprint (legacy workflow alias).',
        description: 'Legacy alias for updating a workflow. Prefer PUT /api/v1/workflows/{id} in new clients.',
        operationId: 'updateSprint',
        parameters: [idParam('id', 'Sprint ID.')],
        requestBody: requestBody(ref('SprintUpdateRequest'), { status: 'active' }),
        responses: {
          '200': response('Updated sprint.', ref('Sprint')),
          '400': errorResponseRef,
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
      delete: {
        tags: ['Sprints'],
        summary: 'Delete a sprint (legacy workflow alias).',
        description: 'Legacy alias for deleting a workflow. Prefer DELETE /api/v1/workflows/{id} in new clients.',
        operationId: 'deleteSprint',
        parameters: [idParam('id', 'Sprint ID.')],
        responses: {
          '200': okResponse,
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/sprints/{id}/metrics': {
      get: {
        tags: ['Sprints'],
        summary: 'Read sprint aggregate metrics (legacy workflow alias).',
        description: 'Legacy alias for workflow metrics. Prefer GET /api/v1/workflows/{id}/metrics in new clients.',
        operationId: 'getSprintMetrics',
        parameters: [idParam('id', 'Sprint ID.')],
        responses: {
          '200': response('Sprint metrics.', ref('SprintMetrics')),
          default: errorResponseRef,
        },
      },
    },
    '/sprints/{id}/close': {
      post: {
        tags: ['Sprints'],
        summary: 'Close a sprint (legacy workflow alias).',
        description: 'Legacy alias for closing a workflow. Prefer POST /api/v1/workflows/{id}/close in new clients.',
        operationId: 'closeSprint',
        parameters: [idParam('id', 'Sprint ID.')],
        requestBody: requestBody(ref('EmptyObject'), {}, false),
        responses: {
          '200': response('Closed sprint result.', ref('SprintLifecycleResponse')),
          default: errorResponseRef,
        },
      },
    },
    '/sprints/{id}/complete': {
      post: {
        tags: ['Sprints'],
        summary: 'Complete a sprint if completion criteria pass (legacy workflow alias).',
        description: 'Legacy alias for completing a workflow. Prefer POST /api/v1/workflows/{id}/complete in new clients.',
        operationId: 'completeSprint',
        parameters: [idParam('id', 'Sprint ID.')],
        requestBody: requestBody(ref('EmptyObject'), {}, false),
        responses: {
          '200': response('Completed sprint result.', ref('SprintLifecycleResponse')),
          '409': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/workflows': {
      get: {
        tags: ['Workflows'],
        summary: 'List workflows.',
        operationId: 'listWorkflows',
        parameters: [
          intQuery('project_id', 'Filter by project ID.'),
          stringQuery('status', 'Filter by workflow status.'),
        ],
        responses: {
          '200': response('Workflow list.', arrayOf(ref('Workflow'))),
          default: errorResponseRef,
        },
      },
      post: {
        tags: ['Workflows'],
        summary: 'Create a workflow.',
        operationId: 'createWorkflow',
        requestBody: requestBody(ref('WorkflowCreateRequest'), {
          project_id: 1,
          name: 'Docs Site Workflow',
          goal: 'Publish self-hosting docs',
          workflow_type: 'dev',
        }),
        responses: {
          '201': response('Created workflow.', ref('Workflow')),
          '400': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/workflows/{id}': {
      get: {
        tags: ['Workflows'],
        summary: 'Read workflow details.',
        operationId: 'getWorkflow',
        parameters: [idParam('id', 'Workflow ID.')],
        responses: {
          '200': response('Workflow.', ref('Workflow')),
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
      put: {
        tags: ['Workflows'],
        summary: 'Update a workflow.',
        operationId: 'updateWorkflow',
        parameters: [idParam('id', 'Workflow ID.')],
        requestBody: requestBody(ref('WorkflowUpdateRequest'), { status: 'active' }),
        responses: {
          '200': response('Updated workflow.', ref('Workflow')),
          '400': errorResponseRef,
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
      delete: {
        tags: ['Workflows'],
        summary: 'Delete a workflow.',
        operationId: 'deleteWorkflow',
        parameters: [idParam('id', 'Workflow ID.')],
        responses: {
          '200': okResponse,
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/workflows/{id}/metrics': {
      get: {
        tags: ['Workflows'],
        summary: 'Read workflow aggregate metrics.',
        operationId: 'getWorkflowMetrics',
        parameters: [idParam('id', 'Workflow ID.')],
        responses: {
          '200': response('Workflow metrics.', ref('WorkflowMetrics')),
          default: errorResponseRef,
        },
      },
    },
    '/workflows/{id}/close': {
      post: {
        tags: ['Workflows'],
        summary: 'Close a workflow.',
        operationId: 'closeWorkflow',
        parameters: [idParam('id', 'Workflow ID.')],
        requestBody: requestBody(ref('EmptyObject'), {}, false),
        responses: {
          '200': response('Closed workflow result.', ref('WorkflowLifecycleResponse')),
          default: errorResponseRef,
        },
      },
    },
    '/workflows/{id}/complete': {
      post: {
        tags: ['Workflows'],
        summary: 'Complete a workflow if completion criteria pass.',
        operationId: 'completeWorkflow',
        parameters: [idParam('id', 'Workflow ID.')],
        requestBody: requestBody(ref('EmptyObject'), {}, false),
        responses: {
          '200': response('Completed workflow result.', ref('WorkflowLifecycleResponse')),
          '409': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/sprints/types/list': {
      get: {
        tags: ['Workflow Definitions'],
        summary: 'List workflow type definitions.',
        description: 'Lists reusable workflow definitions. This route is a sprint-type compatibility path until workflow-definition routes are added.',
        operationId: 'listSprintTypes',
        responses: {
          '200': response('Sprint type list.', arrayOf(ref('SprintTypeDefinition'))),
          default: errorResponseRef,
        },
      },
    },
    '/sprints/types/{key}': {
      get: {
        tags: ['Workflow Definitions'],
        summary: 'Read a workflow type definition.',
        description: 'Reads a reusable workflow definition. This route is a sprint-type compatibility path until workflow-definition routes are added.',
        operationId: 'getSprintType',
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': response('Sprint type definition.', ref('SprintTypeDefinition')),
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/sprints/types/{key}/field-schemas': {
      get: {
        tags: ['Workflow Definitions'],
        summary: 'List task field schemas for a workflow type.',
        description: 'Lists task field schemas for a reusable workflow definition. This route is a sprint-type compatibility path until workflow-definition routes are added.',
        operationId: 'listSprintTypeFieldSchemas',
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': response('Field schemas.', arrayOf(ref('TaskFieldSchema'))),
          default: errorResponseRef,
        },
      },
      post: {
        tags: ['Workflow Definitions'],
        summary: 'Create a task field schema for a workflow type.',
        description: 'Creates a task field schema for a reusable workflow definition. This route is a sprint-type compatibility path until workflow-definition routes are added.',
        operationId: 'createSprintTypeFieldSchema',
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: requestBody(ref('TaskFieldSchemaCreateRequest'), {
          task_type: 'backend',
          schema: { fields: [{ key: 'component', type: 'text', label: 'Component' }] },
        }),
        responses: {
          '201': response('Created field schema.', ref('TaskFieldSchema')),
          '400': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/tasks': {
      get: {
        tags: ['Tasks'],
        summary: 'List tasks.',
        operationId: 'listTasks',
        parameters: [
          intQuery('project_id', 'Filter by project ID.'),
          intQuery('sprint_id', 'Filter by sprint ID.'),
          intQuery('limit', 'Maximum rows to return.'),
          intQuery('offset', 'Rows to skip.'),
          boolQuery('exclude_done', 'Exclude completed tasks.'),
        ],
        responses: {
          '200': response('Task list or paginated task list.', {
            oneOf: [arrayOf(ref('Task')), ref('TaskListResponse')],
          }),
          default: errorResponseRef,
        },
      },
      post: {
        tags: ['Tasks'],
        summary: 'Create a task.',
        operationId: 'createTask',
        requestBody: requestBody(ref('TaskCreateRequest'), {
          title: 'Generate OpenAPI document',
          description: 'Expose a self-hosted OpenAPI document for docs tooling.',
          project_id: 1,
          sprint_id: 2,
          task_type: 'backend',
          priority: 'high',
        }),
        responses: {
          '201': response('Created task.', ref('Task')),
          '400': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/tasks/search': {
      get: {
        tags: ['Tasks'],
        summary: 'Search tasks for lightweight pickers.',
        operationId: 'searchTasks',
        parameters: [
          stringQuery('q', 'Search query.'),
          intQuery('exclude_id', 'Task ID to exclude.'),
          intQuery('limit', 'Maximum rows to return.'),
        ],
        responses: {
          '200': response('Task search results.', arrayOf(ref('TaskSearchResult'))),
          default: errorResponseRef,
        },
      },
    },
    '/tasks/completed-recent': {
      get: {
        tags: ['Tasks'],
        summary: 'List recently completed tasks.',
        operationId: 'listRecentlyCompletedTasks',
        parameters: [intQuery('hours', 'Lookback window in hours.')],
        responses: {
          '200': response('Recently completed tasks.', arrayOf(ref('Task'))),
          default: errorResponseRef,
        },
      },
    },
    '/tasks/field-schema/resolve': {
      get: {
        tags: ['Tasks'],
        summary: 'Resolve task field schema for a sprint/task type.',
        operationId: 'resolveTaskFieldSchema',
        parameters: [
          intQuery('sprint_id', 'Sprint ID.'),
          stringQuery('task_type', 'Task type key.'),
          stringQuery('sprint_type', 'Sprint type key.'),
        ],
        responses: {
          '200': response('Resolved task field schema.', ref('ResolvedTaskFieldSchema')),
          default: errorResponseRef,
        },
      },
    },
    '/tasks/{id}': {
      get: {
        tags: ['Tasks'],
        summary: 'Read task details.',
        operationId: 'getTask',
        parameters: [idParam('id', 'Task ID.')],
        responses: {
          '200': response('Task.', ref('Task')),
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
      put: {
        tags: ['Tasks'],
        summary: 'Update task fields.',
        description: 'Generic status moves may be rejected by workflow policy; use /tasks/{id}/outcome for semantic workflow handoffs.',
        operationId: 'updateTask',
        parameters: [idParam('id', 'Task ID.')],
        requestBody: requestBody(ref('TaskUpdateRequest'), {
          title: 'Generate and serve Agent HQ OpenAPI document',
          status: 'in_progress',
        }),
        responses: {
          '200': response('Updated task.', ref('Task')),
          '400': errorResponseRef,
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
      delete: {
        tags: ['Tasks'],
        summary: 'Delete a task.',
        operationId: 'deleteTask',
        parameters: [
          idParam('id', 'Task ID.'),
          stringQuery('deleted_by', 'Actor label recorded for deletion.'),
        ],
        responses: {
          '200': okResponse,
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/tasks/{id}/context': {
      get: {
        tags: ['Tasks'],
        summary: 'Build task context for an operator or scoped MCP agent.',
        operationId: 'getTaskContext',
        parameters: [
          idParam('id', 'Task ID.'),
          stringQuery('mode', 'Context mode: summary or full.'),
          intQuery('limit', 'Optional per-section limit.'),
        ],
        responses: {
          '200': response('Task context.', ref('TaskContext')),
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/tasks/{id}/outcome': {
      post: {
        tags: ['Tasks'],
        summary: 'Apply a workflow outcome with optional evidence atomically.',
        operationId: 'applyTaskOutcome',
        parameters: [idParam('id', 'Task ID.')],
        requestBody: requestBody(ref('TaskOutcomeRequest'), {
          outcome: 'completed_for_review',
          changed_by: 'cinder-backend',
          review_branch: 'cinder-backend/task-597-generate-and-serve-agent-hq-openapi-docu',
          review_commit: 'abc1234',
          review_url: 'http://127.0.0.1:3510',
        }),
        responses: {
          '200': response('Task outcome result.', ref('TaskOutcomeResponse')),
          '400': errorResponseRef,
          '409': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/tasks/{id}/review-evidence': {
      put: {
        tags: ['Tasks'],
        summary: 'Store review handoff evidence.',
        operationId: 'recordTaskReviewEvidence',
        parameters: [idParam('id', 'Task ID.')],
        requestBody: requestBody(ref('ReviewEvidenceRequest'), {
          review_branch: 'feature/openapi',
          review_commit: 'abc1234',
          review_url: 'http://127.0.0.1:3510',
          summary: 'OpenAPI endpoint ready for QA.',
        }),
        responses: {
          '200': response('Updated task evidence.', ref('Task')),
          '400': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/tasks/{id}/notes': {
      get: {
        tags: ['Tasks'],
        summary: 'List task notes.',
        operationId: 'listTaskNotes',
        parameters: [idParam('id', 'Task ID.')],
        responses: {
          '200': response('Task notes.', arrayOf(ref('TaskNote'))),
          default: errorResponseRef,
        },
      },
      post: {
        tags: ['Tasks'],
        summary: 'Add a task note.',
        operationId: 'addTaskNote',
        parameters: [idParam('id', 'Task ID.')],
        requestBody: requestBody(ref('TaskNoteCreateRequest'), {
          author: 'cinder-backend',
          content: 'Summary: implementation completed and tests passed.',
        }),
        responses: {
          '201': response('Created note.', ref('TaskNote')),
          '400': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/tasks/{id}/blockers': {
      post: {
        tags: ['Tasks'],
        summary: 'Add a task blocker.',
        operationId: 'addTaskBlocker',
        parameters: [idParam('id', 'Task ID.')],
        requestBody: requestBody(ref('TaskBlockerRequest'), { blocker_id: 41 }),
        responses: {
          '200': okResponse,
          '400': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/tasks/{id}/history': {
      get: {
        tags: ['Tasks'],
        summary: 'List task history.',
        operationId: 'listTaskHistory',
        parameters: [idParam('id', 'Task ID.')],
        responses: {
          '200': response('Task history entries.', arrayOf(ref('TaskHistoryEntry'))),
          default: errorResponseRef,
        },
      },
    },
    '/agents': {
      get: {
        tags: ['Agents'],
        summary: 'List agents.',
        operationId: 'listAgents',
        parameters: [boolQuery('include_deleted', 'Include archived agents.')],
        responses: {
          '200': response('Agent list.', arrayOf(ref('Agent'))),
          default: errorResponseRef,
        },
      },
      post: {
        tags: ['Agents'],
        summary: 'Create an agent.',
        operationId: 'createAgent',
        requestBody: requestBody(ref('AgentCreateRequest'), {
          name: 'Cinder',
          role: 'backend engineer',
          runtime_type: 'openclaw',
          project_id: 1,
        }),
        responses: {
          '201': response('Created agent.', ref('Agent')),
          '400': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/agents/{id}': {
      get: {
        tags: ['Agents'],
        summary: 'Read agent details.',
        operationId: 'getAgent',
        parameters: [
          idParam('id', 'Agent ID.'),
          boolQuery('include_deleted', 'Allow archived agent lookup.'),
        ],
        responses: {
          '200': response('Agent.', ref('Agent')),
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
      put: {
        tags: ['Agents'],
        summary: 'Update an agent.',
        operationId: 'updateAgent',
        parameters: [idParam('id', 'Agent ID.')],
        requestBody: requestBody(ref('AgentUpdateRequest'), {
          role: 'backend/API/runtime engineer',
          enabled: true,
        }),
        responses: {
          '200': response('Updated agent.', ref('Agent')),
          '400': errorResponseRef,
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
      delete: {
        tags: ['Agents'],
        summary: 'Delete or archive an idle agent.',
        operationId: 'deleteAgent',
        parameters: [idParam('id', 'Agent ID.')],
        responses: {
          '200': okResponse,
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/agents/{id}/skills': {
      get: {
        tags: ['Agents'],
        summary: 'List skills assigned to an agent.',
        operationId: 'listAgentSkills',
        parameters: [idParam('id', 'Agent ID.')],
        responses: {
          '200': response('Assigned skills.', arrayOf(ref('Skill'))),
          default: errorResponseRef,
        },
      },
      post: {
        tags: ['Agents'],
        summary: 'Assign a skill to an agent.',
        operationId: 'assignAgentSkill',
        parameters: [idParam('id', 'Agent ID.')],
        requestBody: requestBody(ref('AgentSkillAssignRequest'), { skill_name: 'github' }),
        responses: {
          '200': response('Updated skill assignment state.', ref('AgentSkillAssignmentResponse')),
          '400': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/skills': {
      get: {
        tags: ['Skills'],
        summary: 'List installed skill definitions.',
        operationId: 'listSkills',
        responses: {
          '200': response('Skill list.', arrayOf(ref('Skill'))),
          default: errorResponseRef,
        },
      },
      post: {
        tags: ['Skills'],
        summary: 'Create a skill definition.',
        operationId: 'createSkill',
        requestBody: requestBody(ref('SkillCreateRequest'), {
          name: 'release-notes',
          description: 'Generate release notes from task history.',
          content: '# Release notes skill\n',
        }),
        responses: {
          '201': response('Created skill.', ref('Skill')),
          '400': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/tools': {
      get: {
        tags: ['Tools'],
        summary: 'List reusable local tool definitions.',
        operationId: 'listTools',
        responses: {
          '200': response('Tool list.', arrayOf(ref('Tool'))),
          default: errorResponseRef,
        },
      },
      post: {
        tags: ['Tools'],
        summary: 'Create a reusable local tool definition.',
        operationId: 'createTool',
        requestBody: requestBody(ref('ToolCreateRequest'), {
          name: 'Read docs',
          slug: 'read-docs',
          implementation_type: 'shell',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        }),
        responses: {
          '201': response('Created tool.', ref('Tool')),
          '400': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/routing/rules': {
      get: {
        tags: ['Routing'],
        summary: 'List assignment rules.',
        operationId: 'listRoutingRules',
        responses: {
          '200': response('Assignment rules.', arrayOf(ref('RoutingRule'))),
          default: errorResponseRef,
        },
      },
      post: {
        tags: ['Routing'],
        summary: 'Create an assignment rule.',
        operationId: 'createRoutingRule',
        requestBody: requestBody(ref('RoutingRuleCreateRequest'), {
          project_id: 1,
          task_type: 'backend',
          agent_id: 94,
          priority: 10,
        }),
        responses: {
          '201': response('Created assignment rule.', ref('RoutingRule')),
          '400': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/routing/assignment-rules': {
      get: {
        tags: ['Routing'],
        summary: 'List assignment rules. Alias for /routing/rules.',
        operationId: 'listAssignmentRules',
        responses: {
          '200': response('Assignment rules.', arrayOf(ref('RoutingRule'))),
          default: errorResponseRef,
        },
      },
      post: {
        tags: ['Routing'],
        summary: 'Create an assignment rule. Alias for /routing/rules.',
        operationId: 'createAssignmentRule',
        requestBody: requestBody(ref('RoutingRuleCreateRequest'), {
          project_id: 1,
          task_type: 'backend',
          agent_id: 94,
          priority: 10,
        }),
        responses: {
          '201': response('Created assignment rule.', ref('RoutingRule')),
          '400': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/routing/statuses': {
      get: {
        tags: ['Routing'],
        summary: 'List workflow statuses.',
        operationId: 'listWorkflowStatuses',
        responses: {
          '200': response('Workflow statuses.', arrayOf(ref('WorkflowStatus'))),
          default: errorResponseRef,
        },
      },
    },
    '/routing/transitions': {
      get: {
        tags: ['Routing'],
        summary: 'List workflow transitions.',
        operationId: 'listWorkflowTransitions',
        responses: {
          '200': response('Workflow transitions.', arrayOf(ref('WorkflowTransition'))),
          default: errorResponseRef,
        },
      },
    },
    '/routing/transition-requirements': {
      get: {
        tags: ['Routing'],
        summary: 'List workflow transition gate requirements.',
        operationId: 'listTransitionRequirements',
        responses: {
          '200': response('Transition requirements.', arrayOf(ref('TransitionRequirement'))),
          default: errorResponseRef,
        },
      },
    },
    '/routing/workflow-event-mappings': {
      get: {
        tags: ['Routing'],
        summary: 'List workflow event mappings.',
        operationId: 'listWorkflowEventMappings',
        parameters: [
          intQuery('project_id', 'Filter by project ID.'),
          stringQuery('source', 'Filter by event source.'),
          stringQuery('event_name', 'Filter by event name.'),
          stringQuery('task_type', 'Filter by task type.'),
        ],
        responses: {
          '200': response('Workflow event mappings.', ref('WorkflowEventMappingListResponse')),
          default: errorResponseRef,
        },
      },
    },
    '/chat/attachments': {
      post: {
        tags: ['Chat'],
        summary: 'Upload a chat attachment.',
        operationId: 'uploadChatAttachment',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: {
                  file: { type: 'string', format: 'binary' },
                  instance_id: { type: 'integer' },
                  agent_id: { type: 'integer' },
                  uploaded_by: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '201': response('Uploaded chat attachment.', ref('ChatAttachmentUploadResponse')),
          '400': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/chat/instances/{id}/send': {
      post: {
        tags: ['Chat'],
        summary: 'Send a message or attachment references into an instance session.',
        operationId: 'sendChatInstanceMessage',
        parameters: [idParam('id', 'Instance ID.')],
        requestBody: requestBody(ref('ChatSendRequest'), {
          message: 'Please summarize the current task state.',
          attachment_ids: [101],
        }),
        responses: {
          '200': okResponse,
          '502': errorResponseRef,
          default: errorResponseRef,
        },
      },
    },
    '/chat/sessions': {
      get: {
        tags: ['Chat'],
        summary: 'List chat sessions.',
        operationId: 'listChatSessions',
        parameters: [
          intQuery('agent_id', 'Filter by agent ID.'),
          intQuery('limit', 'Maximum rows to return.'),
        ],
        responses: {
          '200': response('Chat sessions.', arrayOf(ref('ChatSession'))),
          default: errorResponseRef,
        },
      },
    },
    '/sessions': {
      get: {
        tags: ['Sessions'],
        summary: 'List captured runtime sessions.',
        operationId: 'listSessions',
        parameters: [
          intQuery('agent_id', 'Filter by agent ID.'),
          intQuery('task_id', 'Filter by task ID.'),
          intQuery('limit', 'Maximum rows to return.'),
          intQuery('offset', 'Rows to skip.'),
        ],
        responses: {
          '200': response('Runtime sessions.', arrayOf(ref('Session'))),
          default: errorResponseRef,
        },
      },
    },
    '/sessions/{id}': {
      get: {
        tags: ['Sessions'],
        summary: 'Read captured runtime session detail.',
        operationId: 'getSession',
        parameters: [idParam('id', 'Session ID.')],
        responses: {
          '200': response('Runtime session.', ref('Session')),
          '404': notFoundResponseRef,
          default: errorResponseRef,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      McpApiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description: 'Scoped MCP API key for runtime clients. Local browser/operator flows may be unauthenticated in self-hosted mode.',
      },
      BearerApiKey: {
        type: 'http',
        scheme: 'bearer',
        description: 'Alternative MCP API key transport using Authorization: Bearer <key>.',
      },
    },
    parameters: {
      Id: idParam('id', 'Numeric resource ID.'),
    },
    responses: {
      Error: {
        description: 'Error response. Many existing handlers return a loose shape while route-specific validation is being tightened.',
        ...jsonContent(ref('ErrorResponse'), { error: 'Validation failed' }),
      },
      NotFound: {
        description: 'Resource was not found.',
        ...jsonContent(ref('ErrorResponse'), { error: 'Not found' }),
      },
    },
    schemas: {
      EmptyObject: { type: 'object', additionalProperties: false },
      OkResponse: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      },
      ErrorResponse: {
        type: 'object',
        description: 'Shared loose error shape used across current handlers.',
        properties: {
          ok: { type: 'boolean' },
          code: { type: 'string' },
          error: { type: 'string' },
          details: {},
        },
        additionalProperties: true,
      },
      HealthResponse: {
        type: 'object',
        required: ['ok', 'service', 'ts'],
        properties: {
          ok: { type: 'boolean' },
          service: { type: 'string' },
          ts: { type: 'string', format: 'date-time' },
        },
      },
      McpCatalog: {
        type: 'object',
        required: ['server', 'tools', 'resources'],
        properties: {
          server: { type: 'string' },
          tools: { type: 'array', items: { type: 'object', additionalProperties: true } },
          resources: { type: 'array', items: { type: 'object', additionalProperties: true } },
          domains: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: true,
      },
      McpCatalogHealth: {
        type: 'object',
        required: ['ok', 'server', 'tool_count', 'resource_count', 'domains'],
        properties: {
          ok: { type: 'boolean' },
          server: { type: 'string' },
          tool_count: { type: 'integer' },
          resource_count: { type: 'integer' },
          domains: { type: 'array', items: { type: 'string' } },
        },
      },
      SetupStatus: {
        type: 'object',
        required: ['hasProjects', 'hasAgents', 'has_atlas_agent', 'onboarding_completed', 'onboarding_provider_gate_passed', 'connected_provider_count'],
        properties: {
          hasProjects: { type: 'boolean' },
          hasAgents: { type: 'boolean' },
          has_atlas_agent: { type: 'boolean' },
          onboarding_completed: { type: 'boolean' },
          onboarding_provider_gate_passed: { type: 'boolean' },
          connected_provider_count: { type: 'integer' },
        },
      },
      OnboardingCompleteResponse: {
        type: 'object',
        required: ['ok', 'onboarding_completed', 'onboarding_provider_gate_passed', 'connected_provider_count'],
        properties: {
          ok: { type: 'boolean' },
          onboarding_completed: { type: 'boolean' },
          onboarding_provider_gate_passed: { type: 'boolean' },
          connected_provider_count: { type: 'integer' },
        },
      },
      OnboardingSkipResponse: {
        type: 'object',
        required: ['ok', 'onboarding_completed', 'atlas_created', 'onboarding_provider_gate_passed', 'connected_provider_count'],
        properties: {
          ok: { type: 'boolean' },
          onboarding_completed: { type: 'boolean' },
          atlas_created: { type: 'boolean' },
          onboarding_provider_gate_passed: { type: 'boolean' },
          connected_provider_count: { type: 'integer' },
        },
      },
      ProviderSlug: {
        type: 'string',
        enum: ['anthropic', 'openai', 'google', 'openrouter', 'ollama', 'openai-codex', 'mlx-studio', 'minimax'],
      },
      Provider: {
        type: 'object',
        required: ['id', 'slug', 'display_name', 'config'],
        properties: {
          id: { type: 'integer' },
          slug: ref('ProviderSlug'),
          display_name: { type: 'string' },
          status: { type: 'string', nullable: true },
          config: {
            type: 'object',
            description: 'Masked provider configuration. Secret values are not returned in full.',
            additionalProperties: true,
          },
          validation_error: { type: 'string', nullable: true },
          created_at: { type: 'string', nullable: true },
          updated_at: { type: 'string', nullable: true },
        },
        additionalProperties: true,
      },
      ProviderCreateRequest: {
        type: 'object',
        required: ['slug', 'config'],
        properties: {
          slug: ref('ProviderSlug'),
          display_name: { type: 'string' },
          config: { type: 'object', additionalProperties: true },
        },
      },
      ProviderUpdateRequest: {
        type: 'object',
        properties: {
          display_name: { type: 'string' },
          config: { type: 'object', additionalProperties: true },
        },
      },
      ProviderGate: {
        type: 'object',
        required: ['onboarding_provider_gate_passed', 'connected_count'],
        properties: {
          onboarding_provider_gate_passed: { type: 'boolean' },
          connected_count: { type: 'integer' },
        },
      },
      ProviderListResponse: {
        type: 'object',
        required: ['providers', 'onboarding_provider_gate_passed', 'connected_count'],
        properties: {
          providers: arrayOf(ref('Provider')),
          onboarding_provider_gate_passed: { type: 'boolean' },
          connected_count: { type: 'integer' },
        },
      },
      ProviderMutationResponse: {
        type: 'object',
        properties: {
          provider: ref('Provider'),
          validation: { type: 'object', additionalProperties: true },
          reload: { type: 'object', additionalProperties: true },
          onboarding_provider_gate_passed: { type: 'boolean' },
          connected_count: { type: 'integer' },
        },
        additionalProperties: true,
      },
      ProviderValidationResponse: {
        type: 'object',
        required: ['ok', 'status', 'onboarding_provider_gate_passed'],
        properties: {
          ok: { type: 'boolean' },
          status: { type: 'string' },
          error: { type: 'string', nullable: true },
          onboarding_provider_gate_passed: { type: 'boolean' },
        },
      },
      ProviderDeleteResponse: {
        type: 'object',
        required: ['ok', 'onboarding_provider_gate_passed'],
        properties: {
          ok: { type: 'boolean' },
          onboarding_provider_gate_passed: { type: 'boolean' },
        },
      },
      ModelListResponse: {
        type: 'object',
        required: ['models'],
        properties: {
          models: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'label'],
              properties: { id: { type: 'string' }, label: { type: 'string' } },
            },
          },
        },
      },
      Project: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          context_md: { type: 'string', nullable: true },
          repo_path: { type: 'string', nullable: true, description: 'Self-hosted local path. Avoid exposing in public examples.' },
          repo_url: { type: 'string', nullable: true },
          repo_access_mode: { type: 'string', enum: ['worktree', 'clone'], nullable: true },
          is_default: { type: 'boolean' },
          created_at: { type: 'string', nullable: true },
          updated_at: { type: 'string', nullable: true },
        },
        additionalProperties: true,
      },
      Tenant: {
        type: 'object',
        required: ['id', 'name', 'slug', 'is_default'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          slug: { type: 'string' },
          is_default: { type: 'integer', enum: [0, 1] },
          created_at: { type: 'string', nullable: true },
          updated_at: { type: 'string', nullable: true },
          project_count: { type: 'integer' },
          task_count: { type: 'integer' },
          agent_count: { type: 'integer' },
        },
        additionalProperties: true,
      },
      TenantCreateRequest: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          slug: { type: 'string' },
          set_active: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      TenantSelectRequest: {
        type: 'object',
        description: 'Provide tenant_id. company_id is accepted only as a deprecated compatibility alias.',
        properties: {
          tenant_id: { type: 'integer', minimum: 1 },
          company_id: {
            type: 'integer',
            minimum: 1,
            deprecated: true,
            description: 'Deprecated compatibility alias. Prefer tenant_id.',
          },
        },
        additionalProperties: false,
      },
      TenantDeleteRequest: {
        type: 'object',
        description: 'Provide confirmation with the exact tenant name. company_name is accepted only as a deprecated compatibility alias.',
        properties: {
          confirmation: { type: 'string', description: 'Exact tenant name required to confirm deletion.' },
          company_name: {
            type: 'string',
            deprecated: true,
            description: 'Deprecated compatibility alias. Prefer confirmation.',
          },
        },
        additionalProperties: false,
      },
      TenantListResponse: {
        type: 'object',
        required: ['tenants', 'active_tenant_id'],
        properties: {
          tenants: arrayOf(ref('Tenant')),
          active_tenant_id: { type: 'integer' },
        },
      },
      TenantMutationResponse: {
        type: 'object',
        required: ['tenant', 'active_tenant_id'],
        properties: {
          tenant: ref('Tenant'),
          active_tenant_id: { type: 'integer' },
        },
      },
      TenantDeleteResponse: {
        type: 'object',
        required: ['ok', 'deleted_tenant', 'active_tenant_id', 'active_tenant_changed', 'deletion_semantics', 'deleted_counts', 'tenants'],
        properties: {
          ok: { type: 'boolean' },
          deleted_tenant: ref('Tenant'),
          active_tenant_id: { type: 'integer' },
          active_tenant_changed: { type: 'boolean' },
          deletion_semantics: { type: 'string', enum: ['hard_delete_tenant_owned_records'] },
          deleted_counts: { type: 'object', additionalProperties: { type: 'integer' } },
          tenants: arrayOf(ref('Tenant')),
        },
      },
      ProjectCreateRequest: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          context_md: { type: 'string' },
          repo_path: { type: 'string' },
          repo_url: { type: 'string' },
          repo_access_mode: { type: 'string', enum: ['worktree', 'clone'] },
        },
      },
      ProjectUpdateRequest: {
        allOf: [ref('ProjectCreateRequest')],
        description: 'Any subset of project create fields. Unsupported fields are rejected.',
      },
      DefaultProjectResponse: {
        type: 'object',
        required: ['project', 'default_project_id'],
        properties: {
          project: ref('Project'),
          default_project_id: { type: 'integer' },
        },
      },
      ProjectDeleteResponse: {
        type: 'object',
        required: ['ok', 'deleted', 'project_id', 'forced'],
        properties: {
          ok: { type: 'boolean' },
          deleted: { type: 'boolean' },
          project_id: { type: 'integer' },
          forced: { type: 'boolean' },
        },
      },
      ProjectMetrics: {
        type: 'object',
        additionalProperties: {
          anyOf: [
            { type: 'integer' },
            { type: 'number' },
            { type: 'string' },
            { type: 'boolean' },
            { type: 'string', nullable: true },
          ],
        },
      },
      ProjectFile: {
        type: 'object',
        required: ['id', 'filename'],
        properties: {
          id: { type: 'integer' },
          project_id: { type: 'integer' },
          filename: { type: 'string' },
          original_name: { type: 'string', nullable: true },
          mime_type: { type: 'string', nullable: true },
          size_bytes: { type: 'integer', nullable: true },
          created_at: { type: 'string', nullable: true },
          uploaded_by: { type: 'string', nullable: true },
          updated_at: { type: 'string', nullable: true },
          updated_by: { type: 'string', nullable: true },
          current_version: { type: 'integer', nullable: true },
          current_version_id: { type: 'integer', nullable: true },
        },
        additionalProperties: true,
      },
      ProjectFileVersion: {
        type: 'object',
        required: ['id', 'project_id', 'file_id', 'version_number'],
        properties: {
          id: { type: 'integer' },
          tenant_id: { type: 'integer' },
          project_id: { type: 'integer' },
          file_id: { type: 'integer' },
          version_number: { type: 'integer' },
          filename: { type: 'string' },
          original_name: { type: 'string', nullable: true },
          mime_type: { type: 'string', nullable: true },
          size_bytes: { type: 'integer', nullable: true },
          created_by: { type: 'string', nullable: true },
          created_at: { type: 'string', nullable: true },
          change_source: { type: 'string', nullable: true },
        },
        additionalProperties: true,
      },
      Sprint: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'integer' },
          project_id: { type: 'integer', nullable: true },
          name: { type: 'string' },
          goal: { type: 'string', nullable: true },
          sprint_type: { type: 'string', nullable: true },
          workflow_id: { type: 'integer', nullable: true },
          workflow_type: { type: 'string', nullable: true },
          status: { type: 'string', nullable: true },
          length_kind: { type: 'string', nullable: true },
          length_value: { type: 'integer', nullable: true },
          repo_path: { type: 'string', nullable: true, description: 'Workflow-owned local repository path for worktree mode.' },
          repo_url: { type: 'string', nullable: true, description: 'Workflow-owned git URL for clone mode.' },
          repo_access_mode: { type: 'string', enum: ['worktree', 'clone'], nullable: true, description: 'Workflow-owned repository access mode. Project and agent repo fields are legacy fallbacks.' },
          created_at: { type: 'string', nullable: true },
          updated_at: { type: 'string', nullable: true },
        },
        additionalProperties: true,
      },
      SprintCreateRequest: {
        type: 'object',
        required: ['project_id', 'name'],
        properties: {
          project_id: { type: 'integer' },
          name: { type: 'string' },
          goal: { type: 'string' },
          sprint_type: { type: 'string' },
          workflow_type: { type: 'string' },
          source_sprint_id: { type: 'integer' },
          source_workflow_id: { type: 'integer' },
          status: { type: 'string' },
          length_kind: { type: 'string' },
          length_value: { type: 'integer' },
          repo_path: { type: 'string', nullable: true },
          repo_url: { type: 'string', nullable: true },
          repo_access_mode: { type: 'string', enum: ['worktree', 'clone'], nullable: true },
        },
      },
      SprintUpdateRequest: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          goal: { type: 'string' },
          sprint_type: { type: 'string' },
          workflow_type: { type: 'string' },
          status: { type: 'string' },
          length_kind: { type: 'string' },
          length_value: { type: 'integer' },
          repo_path: { type: 'string', nullable: true },
          repo_url: { type: 'string', nullable: true },
          repo_access_mode: { type: 'string', enum: ['worktree', 'clone'], nullable: true },
        },
      },
      SprintMetrics: {
        type: 'object',
        additionalProperties: true,
      },
      Workflow: {
        allOf: [ref('Sprint')],
        description: 'Workflow record. During the sprint-to-workflow compatibility period, responses include workflow fields alongside legacy sprint fields where supported.',
      },
      WorkflowCreateRequest: {
        allOf: [ref('SprintCreateRequest')],
        description: 'Workflow create request. Prefer workflow_type and source_workflow_id; sprint_type and source_sprint_id remain accepted legacy aliases.',
      },
      WorkflowUpdateRequest: {
        allOf: [ref('SprintUpdateRequest')],
        description: 'Workflow update request. Prefer workflow_type; sprint_type remains an accepted legacy alias.',
      },
      WorkflowMetrics: {
        allOf: [ref('SprintMetrics')],
        description: 'Workflow aggregate metrics. Shape matches legacy sprint metrics during compatibility.',
      },
      SprintLifecycleResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          sprint: ref('Sprint'),
          message: { type: 'string' },
        },
        additionalProperties: true,
      },
      WorkflowLifecycleResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          workflow: ref('Workflow'),
          sprint: ref('Sprint'),
          message: { type: 'string' },
        },
        additionalProperties: true,
        description: 'Workflow lifecycle response. The legacy sprint property may be present for compatibility.',
      },
      SprintTypeDefinition: {
        type: 'object',
        required: ['key', 'label'],
        properties: {
          key: { type: 'string' },
          label: { type: 'string' },
          description: { type: 'string', nullable: true },
          statuses: { type: 'array', items: ref('WorkflowStatus') },
          outcomes: { type: 'array', items: ref('WorkflowOutcome') },
        },
        additionalProperties: true,
      },
      TaskFieldSchema: {
        type: 'object',
        required: ['id', 'sprint_type_key', 'schema'],
        properties: {
          id: { type: 'integer' },
          sprint_type_key: { type: 'string' },
          task_type: { type: 'string', nullable: true },
          schema: { type: 'object', additionalProperties: true },
        },
        additionalProperties: true,
      },
      TaskFieldSchemaCreateRequest: {
        type: 'object',
        required: ['schema'],
        properties: {
          task_type: { type: 'string' },
          schema: { type: 'object', additionalProperties: true },
        },
      },
      Task: {
        type: 'object',
        required: ['id', 'title', 'status', 'sprint_id'],
        properties: {
          id: { type: 'integer' },
          title: { type: 'string' },
          description: { type: 'string', nullable: true },
          status: { type: 'string' },
          priority: { type: 'string', nullable: true },
          task_type: { type: 'string', nullable: true },
          project_id: { type: 'integer', nullable: true },
          sprint_id: { type: 'integer' },
          assigned_agent_id: { type: 'integer', nullable: true },
          agent_id: { type: 'integer', nullable: true },
          assigned_agent_name: { type: 'string', nullable: true },
          active_agent_name: { type: 'string', nullable: true },
          active_instance_id: { type: 'integer', nullable: true },
          story_points: { type: 'integer', nullable: true },
          custom_fields: { type: 'object', nullable: true, additionalProperties: true },
          review_branch: { type: 'string', nullable: true },
          review_commit: { type: 'string', nullable: true },
          review_url: { type: 'string', nullable: true },
          qa_verified_commit: { type: 'string', nullable: true },
          qa_tested_url: { type: 'string', nullable: true },
          created_at: { type: 'string', nullable: true },
          updated_at: { type: 'string', nullable: true },
        },
        additionalProperties: true,
      },
      TaskCreateRequest: {
        type: 'object',
        required: ['title', 'sprint_id'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          project_id: { type: 'integer' },
          sprint_id: { type: 'integer' },
          task_type: { type: 'string' },
          priority: { type: 'string' },
          story_points: { type: 'integer' },
          custom_fields: { type: 'object', additionalProperties: true },
        },
        additionalProperties: true,
      },
      TaskUpdateRequest: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string' },
          priority: { type: 'string' },
          task_type: { type: 'string' },
          sprint_id: { type: 'integer' },
          agent_id: { type: 'integer', nullable: true },
          custom_fields: { type: 'object', additionalProperties: true },
        },
        additionalProperties: true,
      },
      TaskListResponse: {
        type: 'object',
        required: ['tasks', 'total', 'hasMore', 'limit', 'offset'],
        properties: {
          tasks: arrayOf(ref('Task')),
          total: { type: 'integer' },
          hasMore: { type: 'boolean' },
          limit: { type: 'integer' },
          offset: { type: 'integer' },
        },
      },
      TaskSearchResult: {
        type: 'object',
        required: ['id', 'title', 'status'],
        properties: {
          id: { type: 'integer' },
          title: { type: 'string' },
          status: { type: 'string' },
        },
      },
      ResolvedTaskFieldSchema: {
        type: 'object',
        properties: {
          sprint_type: { type: 'string', nullable: true },
          allowed_task_types: { type: 'array', items: { type: 'string' } },
          fields: { type: 'array', items: { type: 'object', additionalProperties: true } },
          schema: { type: 'object', additionalProperties: true },
        },
        additionalProperties: true,
      },
      TaskContext: {
        type: 'object',
        additionalProperties: true,
        description: 'Task context may include private notes, history, run output, and lease/evidence details. Treat as self-hosted admin-scoped data.',
      },
      TaskOutcomeRequest: {
        type: 'object',
        required: ['outcome'],
        properties: {
          outcome: { type: 'string' },
          changed_by: { type: 'string' },
          summary: { type: 'string' },
          review_branch: { type: 'string' },
          review_commit: { type: 'string' },
          review_url: { type: 'string' },
          qa_verified_commit: { type: 'string' },
          qa_tested_url: { type: 'string' },
          merged_commit: { type: 'string' },
          deployed_commit: { type: 'string' },
          deploy_target: { type: 'string' },
          deployed_at: { type: 'string', format: 'date-time' },
          live_verified_by: { type: 'string' },
          live_verified_at: { type: 'string', format: 'date-time' },
        },
        additionalProperties: true,
      },
      TaskOutcomeResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          task: ref('Task'),
          result: { type: 'object', additionalProperties: true },
        },
        additionalProperties: true,
      },
      ReviewEvidenceRequest: {
        type: 'object',
        required: ['review_branch', 'review_commit'],
        properties: {
          review_branch: { type: 'string' },
          review_commit: { type: 'string' },
          review_url: { type: 'string' },
          summary: { type: 'string' },
          changed_by: { type: 'string' },
        },
      },
      TaskNote: {
        type: 'object',
        required: ['id', 'task_id', 'content'],
        properties: {
          id: { type: 'integer' },
          task_id: { type: 'integer' },
          author: { type: 'string', nullable: true },
          content: { type: 'string' },
          created_at: { type: 'string', nullable: true },
        },
        additionalProperties: true,
      },
      TaskNoteCreateRequest: {
        type: 'object',
        required: ['content'],
        properties: {
          author: { type: 'string' },
          content: { type: 'string' },
        },
      },
      TaskBlockerRequest: {
        type: 'object',
        required: ['blocker_id'],
        properties: { blocker_id: { type: 'integer' } },
      },
      TaskHistoryEntry: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          task_id: { type: 'integer' },
          actor: { type: 'string', nullable: true },
          event_type: { type: 'string', nullable: true },
          changes: { type: 'object', nullable: true, additionalProperties: true },
          created_at: { type: 'string', nullable: true },
        },
        additionalProperties: true,
      },
      Agent: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          role: { type: 'string', nullable: true },
          job_title: { type: 'string', nullable: true },
          session_key: { type: 'string', nullable: true },
          workspace_path: { type: 'string', nullable: true },
          runtime_type: { type: 'string', nullable: true },
          runtime_config: { type: 'object', nullable: true, additionalProperties: true },
          project_id: { type: 'integer', nullable: true },
          provider_id: { type: 'integer', nullable: true },
          model: { type: 'string', nullable: true },
          enabled: { type: 'boolean' },
          deleted_at: { type: 'string', nullable: true },
        },
        additionalProperties: true,
      },
      AgentCreateRequest: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          role: { type: 'string' },
          session_key: { type: 'string' },
          workspace_path: { type: 'string' },
          runtime_type: { type: 'string' },
          runtime_config: { type: 'object', additionalProperties: true },
          project_id: { type: 'integer' },
          provider_id: { type: 'integer' },
          model: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        additionalProperties: true,
      },
      AgentUpdateRequest: {
        allOf: [ref('AgentCreateRequest')],
        description: 'Any subset of mutable agent fields. Repository ownership fields are project-owned and rejected here.',
      },
      AgentSkillAssignRequest: {
        type: 'object',
        properties: {
          skill_name: { type: 'string' },
          skill_id: { type: 'integer' },
        },
      },
      AgentSkillAssignmentResponse: {
        type: 'object',
        additionalProperties: true,
      },
      Skill: {
        type: 'object',
        required: ['name'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          content: { type: 'string', nullable: true },
        },
        additionalProperties: true,
      },
      SkillCreateRequest: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          content: { type: 'string' },
        },
        additionalProperties: true,
      },
      Tool: {
        type: 'object',
        required: ['id', 'name', 'slug', 'implementation_type'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          slug: { type: 'string' },
          description: { type: 'string', nullable: true },
          implementation_type: { type: 'string' },
          input_schema: { type: 'object', nullable: true, additionalProperties: true },
          permissions: { type: 'object', nullable: true, additionalProperties: true },
          tags: { type: 'array', items: { type: 'string' } },
          enabled: { type: 'boolean' },
        },
        additionalProperties: true,
      },
      ToolCreateRequest: {
        type: 'object',
        required: ['name', 'slug', 'implementation_type'],
        properties: {
          name: { type: 'string' },
          slug: { type: 'string' },
          description: { type: 'string' },
          implementation_type: { type: 'string' },
          implementation_body: { type: 'string', description: 'May contain local commands; do not include secrets.' },
          input_schema: { type: 'object', additionalProperties: true },
          permissions: { type: 'object', additionalProperties: true },
          tags: { type: 'array', items: { type: 'string' } },
          enabled: { type: 'boolean' },
        },
      },
      RoutingRule: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'integer' },
          project_id: { type: 'integer', nullable: true },
          sprint_id: { type: 'integer', nullable: true },
          task_type: { type: 'string', nullable: true },
          agent_id: { type: 'integer', nullable: true },
          priority: { type: 'integer', nullable: true },
          enabled: { type: 'boolean' },
        },
        additionalProperties: true,
      },
      RoutingRuleCreateRequest: {
        type: 'object',
        properties: {
          project_id: { type: 'integer' },
          sprint_id: { type: 'integer' },
          task_type: { type: 'string' },
          agent_id: { type: 'integer' },
          priority: { type: 'integer' },
          enabled: { type: 'boolean' },
        },
        additionalProperties: true,
      },
      WorkflowStatus: {
        type: 'object',
        required: ['key'],
        properties: {
          key: { type: 'string' },
          label: { type: 'string' },
          category: { type: 'string', nullable: true },
          color: { type: 'string', nullable: true },
        },
        additionalProperties: true,
      },
      WorkflowOutcome: {
        type: 'object',
        required: ['outcome'],
        properties: {
          outcome: { type: 'string' },
          label: { type: 'string' },
          from_status: { type: 'string', nullable: true },
          to_status: { type: 'string', nullable: true },
        },
        additionalProperties: true,
      },
      WorkflowTransition: {
        type: 'object',
        required: ['id', 'outcome'],
        properties: {
          id: { type: 'integer' },
          outcome: { type: 'string' },
          from_status: { type: 'string' },
          to_status: { type: 'string' },
        },
        additionalProperties: true,
      },
      TransitionRequirement: {
        type: 'object',
        required: ['id', 'field_key'],
        properties: {
          id: { type: 'integer' },
          transition_id: { type: 'integer' },
          field_key: { type: 'string' },
          required: { type: 'boolean' },
        },
        additionalProperties: true,
      },
      WorkflowEventMapping: {
        type: 'object',
        required: ['id', 'event_name'],
        properties: {
          id: { type: 'integer' },
          project_id: { type: 'integer', nullable: true },
          source: { type: 'string', nullable: true },
          event_name: { type: 'string' },
          task_type: { type: 'string', nullable: true },
          action_kind: { type: 'string', nullable: true },
          action_target: { type: 'string', nullable: true },
          enabled: { type: 'boolean' },
          priority: { type: 'integer' },
        },
        additionalProperties: true,
      },
      WorkflowEventMappingListResponse: {
        type: 'object',
        required: ['mappings'],
        properties: {
          mappings: arrayOf(ref('WorkflowEventMapping')),
        },
        additionalProperties: true,
      },
      ChatAttachmentUploadResponse: {
        type: 'object',
        required: ['ok', 'attachment'],
        properties: {
          ok: { type: 'boolean' },
          attachment: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              filename: { type: 'string' },
              url: { type: 'string' },
            },
            additionalProperties: true,
          },
        },
      },
      ChatSendRequest: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          attachment_ids: { type: 'array', items: { type: 'integer' } },
        },
      },
      ChatSession: {
        type: 'object',
        properties: {
          session_key: { type: 'string' },
          agent_id: { type: 'integer', nullable: true },
          channel: { type: 'string', nullable: true },
          last_message_at: { type: 'string', nullable: true },
        },
        additionalProperties: true,
      },
      Session: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          session_key: { type: 'string' },
          agent_id: { type: 'integer', nullable: true },
          task_id: { type: 'integer', nullable: true },
          instance_id: { type: 'integer', nullable: true },
          created_at: { type: 'string', nullable: true },
          updated_at: { type: 'string', nullable: true },
        },
        additionalProperties: true,
      },
    },
  },
};

function withVersionedApiPaths(paths: OpenApiDocument['paths']): OpenApiDocument['paths'] {
  return Object.fromEntries(Object.entries(paths).map(([path, operations]) => [
    path === '/health' ? path : `/api/v1${path}`,
    operations,
  ]));
}

export function getOpenApiDocument(): OpenApiDocument {
  return {
    ...openApiDocument,
    paths: withVersionedApiPaths(openApiDocument.paths),
  };
}
