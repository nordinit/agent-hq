# Agent HQ OpenAPI Document

The API serves the self-hosted OpenAPI document from:

- `/openapi.json`
- `/api/v1/openapi.json`

The in-product API console lives at Settings > API (`/settings/api`). Legacy `/docs` traffic redirects there.

The document is written by hand in `api/src/openapi/document.ts`. A proposed convention for generating it from route-local Zod schemas was not adopted; it is kept in [archive/openapi-schema-backed-convention.md](archive/openapi-schema-backed-convention.md).

The document covers a public subset of the API. Internal callback hooks, logs, browser controls, telemetry, artifact file access, credential registries, gateway tokens, and other deferred route groups stay out of the published spec until their auth, redaction, and examples are approved.

Workflow endpoints are the board/operating-cycle surface in the published document.

## Tenant Context

Agent HQ supports logical tenants through tenant-owned rows in the shared database. Existing installations are backfilled into a default tenant, and new tenants are created through the canonical tenant API:

- `GET /api/v1/tenants` — list tenants and the active tenant id.
- `POST /api/v1/tenants` — create a tenant. Payload: `{ "name": "...", "slug": "...", "set_active": true }`. The slug is retry-safe: repeating the same slug returns the existing tenant without duplicating or reconciling its operator-owned starter configuration.
- `GET /api/v1/tenants/active` — resolve the active tenant.
- `PUT /api/v1/tenants/active` — select an active tenant with `{ "tenant_id": 123 }`.
- `POST /api/v1/tenants/:id/select` — select an active tenant by id.
- `DELETE /api/v1/tenants/:id` — delete a non-default tenant. Payload: `{ "confirmation": "<exact tenant name>" }`. Deletion is a hard delete of tenant-owned records because the current tenant model has no archive column; Settings blocks the default tenant, and deleting the active tenant switches the active context to a remaining tenant.

Tenant context for normal browser/API requests comes from the active tenant in `app_settings`, falling back to the default tenant. Use `PUT /api/v1/tenants/active` or `POST /api/v1/tenants/:id/select` to switch that context. Tenant selector query parameters and headers (`tenant_id`, legacy `company_id`, `X-Agent-HQ-Tenant-ID`, `X-Tenant-ID`) are not accepted for normal requests; they are reserved for trusted cross-tenant MCP/admin access. Tenant-owned data includes projects, workflows, tasks, agents, routing rules, model routing, tools, MCP servers, recurring task series, sessions, and external event mappings. Host-global provider/runtime configuration remains global unless a product decision explicitly scopes it later.

Creating a tenant installs the default package for it: a `Default Project` with the starter Backlog, Development, Operations, and Lead Generation workflows, starter agents, and their routing.

Legacy `/api/v1/companies` routes and request-body aliases such as `company_id` remain available for existing clients, but they are compatibility-only. New clients and public examples should use `/api/v1/tenants` and `tenant_id`.

## Adding Future Routes

1. Classify the route as public, internal-deferred, unsafe-to-document, or deprecated compatibility. Only public routes belong in the document.
2. Add or tighten reusable schemas in `components.schemas` first.
3. Add the route operation under `paths` with request bodies, path/query parameters, status-code responses, and safe examples.
4. Keep examples free of secrets, runtime tokens, local filesystem paths, hook auth headers, real repo/task data, private transcript content, and raw logs.
5. Add schema descriptions for sensitive self-hosted fields that are intentionally returned, and document whether secret-like fields are omitted, masked, or placeholders.
6. Add focused test expectations in `api/src/openapi/openapi.test.ts` when the route introduces a new core schema, sensitive exclusion rule, or promoted deferred category.
7. Run `npm test -- --runInBand src/openapi/openapi.test.ts` and `npm run build` from `api/`.
