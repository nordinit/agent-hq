# Agent HQ OpenAPI Document

The API serves the self-hosted OpenAPI document from:

- `/openapi.json`
- `/api/v1/openapi.json`

The in-product API console lives at Settings > API (`/settings/api`). Legacy `/docs` traffic redirects there.

The current source of truth lives in `api/src/openapi/document.ts`. New and migrated route groups should follow the schema-backed route contract convention in `docs/openapi-schema-backed-convention.md`: route-local Zod schemas define params, query, request bodies, responses, examples, tags, and public/internal visibility, while `document.ts` remains the OpenAPI aggregation layer during incremental migration.

The document intentionally follows the public scope inventory in `docs/api-public-scope-inventory.md` and the public API documentation policy in `docs/api-public-docs-policy.md`; internal callback hooks, logs, browser controls, telemetry, artifact file access, credential registries, gateway tokens, and other deferred route groups should stay out of the published spec until their auth, redaction, and examples are approved.

Workflow endpoints are the preferred board/operating-cycle surface in the published document. Sprint endpoints and `sprint_*` fields remain documented as legacy compatibility aliases where existing clients still depend on them.

## Tenant Context

Agent HQ supports logical tenants through tenant-owned rows in the shared database. Existing installations are backfilled into a default tenant, and new tenants are created through the canonical tenant API:

- `GET /api/v1/tenants` — list tenants and the active tenant id.
- `POST /api/v1/tenants` — create a tenant. Payload: `{ "name": "...", "slug": "...", "set_active": true }`. The slug is retry-safe: repeating the same slug returns and reseeds the existing tenant instead of duplicating starter data.
- `GET /api/v1/tenants/active` — resolve the active tenant.
- `PUT /api/v1/tenants/active` — select an active tenant with `{ "tenant_id": 123 }`.
- `POST /api/v1/tenants/:id/select` — select an active tenant by id.
- `DELETE /api/v1/tenants/:id` — delete a non-default tenant. Payload: `{ "confirmation": "<exact tenant name>" }`. Deletion is a hard delete of tenant-owned records because the current tenant model has no archive column; Settings blocks the default tenant, and deleting the active tenant switches the active context to a remaining tenant.

Tenant context for normal browser/API requests comes from the active tenant in `app_settings`, falling back to the default tenant. Use `PUT /api/v1/tenants/active` or `POST /api/v1/tenants/:id/select` to switch that context. Tenant selector query parameters and headers (`tenant_id`, legacy `company_id`, `X-Agent-HQ-Tenant-ID`, `X-Tenant-ID`) are not accepted for normal requests; they are reserved for trusted cross-tenant MCP/admin access. Tenant-owned data includes projects, workflows/sprints, tasks, agents, routing rules, model routing, tools, MCP servers, recurring task series, sessions, and external event mappings. Host-global provider/runtime configuration remains global unless a product decision explicitly scopes it later.

Creating a tenant seeds a clean starter Agent HQ workspace: an `Agent HQ` project plus the standard Backlog workflow and starter workflow/task policy created by the existing project bootstrap path.

Legacy `/api/v1/companies` routes and request-body aliases such as `company_id` remain available for existing clients, but they are compatibility-only. New clients and public examples should use `/api/v1/tenants` and `tenant_id`.

## Adding Future Routes

1. Classify the route against `docs/api-public-docs-policy.md` as public, internal-deferred, unsafe-to-document, or deprecated compatibility.
2. Add or tighten reusable schemas in `components.schemas` first.
3. Add the route operation under `paths` with request bodies, path/query parameters, status-code responses, and safe examples.
4. Keep examples free of secrets, runtime tokens, local filesystem paths, hook auth headers, real repo/task data, private transcript content, and raw logs.
5. Add schema descriptions for sensitive self-hosted fields that are intentionally returned, and document whether secret-like fields are omitted, masked, or placeholders.
6. Add focused test expectations in `api/src/openapi/openapi.test.ts` when the route introduces a new core schema, sensitive exclusion rule, or promoted deferred category.
7. Run `npm test -- --runInBand src/openapi/openapi.test.ts` and `npm run build` from `api/`.
