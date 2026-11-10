# Project observation and executable authority

This change implements the API/MCP permission redesign. Deployment and granting
ChatGPT Mobile new access are separate actions. Migration 49 grants nothing and
approves no existing executable.

## Authority model

| Capability | Authority |
| --- | --- |
| `projects.read_all` | Curated, redacted board/status/context reads within one tenant |
| `tools.read` | Sanitized registry and assignment metadata |
| `tools.register` | Author draft tool and MCP launch definitions |
| `tools.publish` | Review, publish or revoke an exact immutable revision digest |
| `tools.assign` | Bind a published revision to an agent or team; disable a binding |
| `tools.execute` | Invoke an approved assigned registry tool |
| `host.configure` | Author protected runtime, setup, workspace and provider configuration |
| `host.execute` | Launch approved host processes and perform host probes |
| `host.files.read` | Workspace files, raw run context and transcripts |
| `runs.dispatch` | Delegate executable work and routing in addition to ordinary project scope |
| `permissions.manage` | Change another identity's grants within existing delegation limits |
| `admin.cross_tenant` | Existing separate cross-tenant authority; requires a super-admin key |

All new capabilities default off for every key role. `admin.full_access` means
tenant business administration and cannot override an explicit boundary.
Host administration and permission administration remain independent.

`projects.read_all` does not broaden any existing project write grant. It does
not grant project files, workspace files, raw prompts/transcripts, credentials,
diagnostic probes or callbacks. Structured secret-bearing fields and known
credential formats are redacted. Ordinary project prose remains project data;
redaction does not classify every possible secret someone pastes into free text.

Creating executable work, changing authoritative instructions, enabling schedules
and changing worker routing require explicit delegation authority. Existing
project, tenant, lifecycle evidence and active-run ownership checks still apply.
Identity binding fields require an operator credential. MCP identities cannot
change their own policy, delegate a capability they lack, or restore implicit
role defaults with DELETE. The old `mcp_capability_policies.write` key is retained
as a compatibility key and no longer authorizes writes.

## Revision lifecycle

1. Edit the draft registry/configuration through the existing v1 APIs.
2. Create a revision with `POST /api/v1/execution/revisions` using
   `resource_kind` and `resource_id`.
3. Review `GET /api/v1/execution/revisions/:id`. Source review requires
   `tools.publish`; environment/header credential values are masked. The digest
   binds immutable secret references/versions, not plaintext credential values. Never embed credentials
   in source code or command arguments to work around masking.
4. Publish with `POST /revisions/:id/publish` and the reviewed `digest`.
5. Bind with `POST /bindings`, specifying `subject_kind`, `subject_id`,
   `revision_id` and optional future `expires_at`.
6. Grant the recipient explicit execution authority separately.

The supported kinds are `tool`, `mcp_server`, `agent_runtime` and
`workflow_setup`. Runtime launches require the agent profile and, for task
dispatch, the workflow setup profile. Each profile must match current protected
configuration. Runtime profiles include referenced team context, skill package
content and credential-reference versions. Changes hold subsequent launches or
chat turns until reviewed again.

Tool/MCP edits do not replace pinned execution content. Registry and assignment
edits no longer automatically refresh host MCP processes. Provisioning creates
configuration and visibly holds activation for approval; it does not grant the
new recipient execution authority. Use the separately authorized MCP sync after
publication and binding when a materialized runtime needs refreshing.

Revoking a revision, disabling/removing an effective assignment, disabling a
binding, removing team membership or expiring a binding blocks the next mediated
invocation. MCP calls recheck current tool allowlists, including calls from a
cached tool list. MCP resource discovery/reads also recheck authorization.
Revocation does not terminate an already-running process or undo an external
effect. Drain or stop those processes explicitly.

## Execution contract

Registry tools run through one broker for REST tests, native registry MCP and
OpenClaw capability tools. The native stdio bridge has no database client or
local executor. Its credential is bound to its current owned run and expires
after one hour; business APIs, other runs and completed runs are refused.

Published stdio MCP definitions launch through an authorization gateway. Agent
or team bindings and explicit authority are checked before launch and each
mediated call. Shared MCP configurations use the assigned agent identity; a
shared gateway is not a substitute for an isolated OS account. Existing
Agent HQ lifecycle credentials remain governed by their own API grants and run
ownership checks.

Shell, inline/script and HTTP registry tools are supported. Inputs are validated
before effects against a bounded schema subset. Unsupported schema constructs
fail closed. Input is available as `TOOL_INPUT` JSON and normalized `TOOL_*`
variables; input cannot choose cwd, launch environment or HTTP URL. Bare input
environment variables from old OpenClaw tools must be migrated to this contract.
Timeouts are capped at 180 seconds and output at 1 MiB. HTTP redirects are
refused. Execution failures do not echo commands, environments or credentials.

Environment/header credentials and structured secret fields live in a private
server-side value table. Published snapshots contain references and version
hashes; the execution service resolves them only within the tenant. This is
reference separation, not database encryption; database access and encryption
remain deployment controls.

Only a sanitized ambient environment is inherited. Definition-specific launch
environments require publication. Discoverable local executable entrypoints,
file arguments and dependency lockfiles are hashed and rechecked. These pins
do not lock every transitive dependency or remote download performed by arbitrary
approved code. Review and pin external dependency versions in the managed
release/package environment before approving it.

A temporary cwd is not an OS sandbox. Code runs with the service account's OS
permissions; API capabilities do not imply root and cannot constrain an owner
with direct process/filesystem/database access. OS accounts, filesystem/network
confinement and installed runtime executable policy remain deployment controls.

Permission changes record before/after capability sets. Publication, binding,
revocation, invocation decisions/results and explicit host authorization are
recorded in append-only `execution_audit`. Audit metadata excludes request input,
source bodies and credential values. UI policy saves use a revision hash;
stale saves return 409. API/MCP clients can supply `expected_revision`, returned
as `revision` by the policy read, to get the same concurrency check.

## Inventory and API organization

Run from `api/`:

```sh
npm run catalog:generate
npm run catalog:check
```

The checked-in manifest is
`api/src/domains/access/operations.generated.json`. The generator also exports
the complete human-readable function list and detailed private inventory into
`api/operation-inventory/`. These local exports are ignored by git. HTTP verbs
are traced through MCP handlers and the API client; source contracts are hashed
so client/handler changes require inventory review. Aliases, canonical paths,
retired routes and dynamic OAuth/HTTP/WebSocket transports are distinguished.

CI runs the drift check through API lint. Unknown MCP names, missing capability
declarations, unclassified registrations and method/path/source-contract drift
fail verification. Generic `api_request` is explicitly dynamic and still reaches
the same request authorization. Unknown API operations cannot use business-admin
fallback. Hints and catalog metadata are guidance, never authorization.

The private operation catalog is paginated at
`GET /api/v1/execution/operations`, with `owner`, `effect`, `limit` and `offset`.
Follow `has_more`; there is no page-count limit. Public OpenAPI remains its
reviewed subset; no internal operation was automatically published.

Navigation groups are Projects/Work, Runs/Lifecycle, Automation, Workflow
Policy/Routing, Agents/Teams, Capability Registry, Observability, Host/Providers
and Identity/Access. Existing v1 URLs and MCP names remain available. Retired
workflow job/schedule writes point to task/recurring-series APIs. Prefer explicit
workflow lifecycle actions over direct status patches.

`get_project_context` provides bounded counts, recent/latest-run evidence,
attention items, timestamps and coverage limitations. `list_tasks` requests the
summary projection with stable bounded paging. General `search_tasks` remains
separate from exact-match `search_project_tasks` deduplication.

## Deployment and migration sequence

1. Back up the database and preserve authenticated operator recovery access.
   Rehearse the rollout on a restored database. Verify API/UI use the same
   operator token without printing its value.
2. Inventory current key roles, assignments and active runs. After applying the
   additive migration, use `GET /api/v1/execution/readiness` as the operator or
   a caller with `permissions.manage`. It contains no plaintext keys or hashes.
   Review team grants as well as direct grants. Inventory unauthenticated callers
   from report-mode logs separately.
3. Pause new dispatches and deliberately drain/stop legacy unmediated workers,
   MCP processes and cached OpenClaw capability tools. A code deployment cannot
   retroactively mediate processes that are already running.
4. Build and migrate explicitly. API startup rejects missing/drifted migrations;
   it does not silently alter the schema. Migration 49 is additive and performs
   no auto-approval or capability migration.
5. Review trusted automation individually: runtime/workflow profiles, tool/MCP
   revisions, dependency versions, assignment filters, bindings and recipient
   capabilities. Existing unapproved automation is held, not silently promoted.
6. Rematerialize approved MCP definitions and install the broker-only OpenClaw
   capability plugin. Restart caches/processes so no legacy local executor remains.
7. Migrate every caller to operator or scoped authentication and set
   `AGENT_HQ_AUTH_MODE=enforce`. Verify an anonymous request is refused and the
   UI, CLI, callbacks and scoped agents still work. Sensitive/delegated operations
   require explicit credentials even in report mode, but report mode still
   permits other anonymous legacy access and is not a secure cutover.
8. Verify positive and negative cases through REST, HTTP/OAuth MCP, stdio MCP and
   each enabled runtime. Check audit rows and refresh policy previews after
   changes. Resume approved automation and monitor held/error states.

Rollback should keep the additive schema, approval history and explicit gates.
Pause affected automation or deploy a forward fix; do not restore anonymous
access, the admin execution bypass or legacy local executors as a rollback.

ChatGPT Mobile agent `99974450` receives no automatic change. After deployment
and verification, separately preview adding `projects.read_all` while preserving
the existing Agency-only write grants. Keep registration, publication,
assignment, invocation, host, delegation, permission-administration and
cross-tenant grants off unless separately authorized.
