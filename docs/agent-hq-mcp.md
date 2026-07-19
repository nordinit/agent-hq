# Agent HQ MCP Server

Connect Agent HQ to ChatGPT desktop, Claude desktop, or any MCP-compatible client over stdio.

---

## Overview

The Agent HQ MCP server is a thin adapter between MCP clients and the local Agent HQ API.

Architecture:

```text
MCP client (ChatGPT / Claude / other)
  -> stdio
Agent HQ MCP server
  -> HTTP localhost
Agent HQ API
```

Design goals:
- expose Agent HQ projects, workflows, tasks, notes, workflow-configured task relationships, jobs, and agents to MCP clients
- allow safe task-oriented writes from chat
- keep the server stateless by routing all operations through the existing API
- use Agent HQ naming throughout

v1 assumptions:
- local stdio transport only
- single-user local install
- no remote transport
- no direct database access from the MCP server
- every MCP server process has an Agent HQ API key bound to one Agent HQ agent identity

---

## What You Can Do

Once connected, you can ask things like:
- "What’s on my workflow board?"
- "Show me task #576"
- "Create a task for fixing the login bug in Agency"
- "Move task #580 to in_progress"
- "Add a note to task #576: spec is approved"
- "Start run instance #2551 and post a progress check-in"
- "Record review evidence for task #448 and post completed_for_review"

---

## Scope

### In scope

| Resource | Read | Write | Notes |
|---|---|---|---|
| Projects | Yes | Yes | Full CRUD via typed MCP tools |
| Project Files | Yes | Yes | Use for reusable project-wide reference material |
| Workflows / Boards | Yes | Yes | Full CRUD via workflow tools; sprint-named tools remain legacy aliases |
| Workflow Files | Yes | Yes | Use for specs and artifacts owned by one workflow |
| Tasks | Yes | Yes | Create, update, move status, delete |
| Task Notes | Yes | Yes | Add notes/comments |
| Task Lifecycle Writes | Yes | Yes | Scoped start/check-in/blocker, evidence, and outcome tools |
| Task Relationships | Yes | Yes | Relationship-first tools create/list/delete workflow-configured task relationships |
| Task Blockers | Yes | Yes | Legacy compatibility for one release; prefer relationship tools |
| Task History | Yes | No | Audit trail / history only |
| Agents | Yes | Yes | Includes skill assignment relations, tools, MCP servers |
| Assignment Rules | Yes | Yes | Workflow task-to-agent assignment rules CRUD |
| Routing Transitions | Yes | Yes | Canonical workflow/model-selection routing object CRUD |
| Model Routing | Yes | Yes | Story-point model-routing CRUD |
| Workflow Types | Yes | Yes | First-class workflow definition surface; workflow type tools remain legacy aliases |
| Workflow Templates | Yes | Yes | First-class workflow definition surface |
| Task Field Schemas | Yes | Yes | First-class task-definition surface |

### Still intentionally out of scope

- raw database access
- arbitrary instance control beyond the scoped lifecycle write surfaces
- raw attachment internals outside the typed project-file and workflow-file tools
- browser pool or other internal runtime concerns

---

## Tool Surface

Primary tool names use the `agent_hq_*` namespace. New docs and client configs should use `agent_hq_*` only.

### Read tools

| Tool | Description |
|---|---|
| `agent_hq_list_projects` | List all projects |
| `agent_hq_get_project` | Get a project by ID |
| `agent_hq_list_project_files` | List reusable project-scoped files |
| `agent_hq_get_project_file` | Read project-file metadata |
| `agent_hq_download_project_file` | Download project-file content as base64 and optional text |
| `agent_hq_list_workflows` | List workflows, optionally filtered by project |
| `agent_hq_get_workflow` | Get workflow detail and metrics |
| `agent_hq_list_workflow_files` | List files scoped to one workflow |
| `agent_hq_get_workflow_file` | Read workflow-file metadata |
| `agent_hq_list_workflow_file_versions` | List version history for a workflow file |
| `agent_hq_download_workflow_file` | Download workflow-file content as base64 and optional text |
| `agent_hq_list_sprints` | Legacy alias for listing workflows |
| `agent_hq_get_sprint` | Legacy alias for workflow detail |
| `agent_hq_list_tasks` | List tasks with filters |
| `agent_hq_get_task` | Get full task detail |
| `agent_hq_get_task_notes` | Get notes for a task |
| `agent_hq_get_task_history` | Get task history |
| `agent_hq_get_task_relationship_types` | Resolve valid relationship type keys and dispatch semantics for a task workflow |
| `agent_hq_list_task_relationships` | List generic task relationships for a task |
| `agent_hq_get_workflow_metadata` | Resolve task statuses, task types, outcomes, relationship types, and custom field schema metadata for a workflow |
| `agent_hq_list_transition_requirement_fields` | Resolve gate/evidence fields available to configurable outcome transitions |
| `agent_hq_list_workflow_type_statuses` | List task status labels configured for a workflow type |
| `agent_hq_list_workflow_type_outcomes` | List lifecycle outcome keys configured for a workflow type |
| `agent_hq_list_workflow_type_relationship_types` | Alias for listing relationship types configured for a workflow type |
| `agent_hq_list_workflow_type_field_schemas` | Alias for listing custom task field schemas configured for a workflow type |
| `agent_hq_list_jobs` | List jobs |
| `agent_hq_list_agents` | List registered agents |

### Write tools

| Tool | Description |
|---|---|
| `agent_hq_create_project` | Create a project |
| `agent_hq_update_project` | Update a project |
| `agent_hq_delete_project` | Delete a project |
| `agent_hq_upload_project_file` | Upload a reusable project-scoped file |
| `agent_hq_replace_project_file` | Replace a project file in place while preserving version history |
| `agent_hq_delete_project_file` | Delete a project-scoped file |
| `agent_hq_create_workflow` | Create a workflow |
| `agent_hq_update_workflow` | Update a workflow |
| `agent_hq_delete_workflow` | Delete a workflow |
| `agent_hq_upload_workflow_file` | Upload a file scoped to one workflow |
| `agent_hq_replace_workflow_file` | Replace a workflow file in place while preserving its canonical file ID and version history |
| `agent_hq_delete_workflow_file` | Delete a workflow-scoped file |
| `agent_hq_create_sprint` | Legacy alias for workflow creation |
| `agent_hq_update_sprint` | Legacy alias for workflow updates |
| `agent_hq_delete_sprint` | Legacy alias for workflow deletion |
| `agent_hq_create_task` | Create a new task |
| `agent_hq_update_task` | Update writable task fields |
| `agent_hq_delete_task` | Delete a task |
| `agent_hq_move_task` | Move a task to a new status |
| `agent_hq_add_task_note` | Add a note to a task |
| `agent_hq_start_task_run` | Start a dispatched run instance |
| `agent_hq_check_in_task_run` | Post a heartbeat or progress check-in |
| `agent_hq_report_task_blocker` | Post a blocker lifecycle check-in |
| `agent_hq_record_review_evidence` | Record review evidence |
| `agent_hq_record_qa_evidence` | Record QA evidence |
| `agent_hq_record_deploy_evidence` | Record deploy evidence |
| `agent_hq_record_live_verification` | Record live verification evidence |
| `agent_hq_post_task_outcome` | Post an outcome with optional inline evidence |
| `agent_hq_create_task_relationship` | Create or update a workflow-configured task relationship |
| `agent_hq_delete_task_relationship` | Delete a generic task relationship |
| `agent_hq_add_blocker` | Legacy compatibility: add `blocked_by` only when configured as dispatch-blocking |
| `agent_hq_remove_blocker` | Legacy compatibility: remove a `blocked_by` compatibility relationship/dependency |
| `agent_hq_create_assignment_rule` | Create a workflow assignment rule |
| `agent_hq_update_assignment_rule` | Update a workflow assignment rule |
| `agent_hq_delete_assignment_rule` | Delete a workflow assignment rule |
| `agent_hq_create_routing_rule` | Compatibility alias: create a workflow assignment rule |
| `agent_hq_update_routing_rule` | Compatibility alias: update a workflow assignment rule |
| `agent_hq_delete_routing_rule` | Compatibility alias: delete a workflow assignment rule |
| `agent_hq_create_routing_transition` | Create a canonical routing transition |
| `agent_hq_update_routing_transition` | Update a canonical routing transition |
| `agent_hq_delete_routing_transition` | Delete a canonical routing transition |
| `agent_hq_create_model_routing_rule` | Create a story-point model-routing rule |
| `agent_hq_update_model_routing_rule` | Update a story-point model-routing rule |
| `agent_hq_delete_model_routing_rule` | Delete a story-point model-routing rule |
| `agent_hq_list_sprint_type_task_types` | List allowed task types for a workflow type using the legacy sprint_type key |
| `agent_hq_update_sprint_type_task_types` | Replace allowed task types for a workflow type using the legacy sprint_type key |
| `agent_hq_create_sprint_type` | Create a workflow type using the legacy workflow type route |
| `agent_hq_update_sprint_type` | Update a workflow type using the legacy workflow type route |
| `agent_hq_delete_sprint_type` | Delete a workflow type using the legacy workflow type route |
| `agent_hq_get_workflow_template` | Get a workflow template |
| `agent_hq_create_workflow_template` | Create a workflow template |
| `agent_hq_update_workflow_template` | Update a workflow template |
| `agent_hq_delete_workflow_template` | Delete a workflow template |
| `agent_hq_list_task_field_schemas` | List task field schemas for a workflow type |
| `agent_hq_get_task_field_schema` | Get a task field schema |
| `agent_hq_create_task_field_schema` | Create a task field schema |
| `agent_hq_update_task_field_schema` | Update a task field schema |
| `agent_hq_delete_task_field_schema` | Delete a task field schema |
| `agent_hq_list_agent_skills` | List skill assignments for an agent |
| `agent_hq_assign_skill_to_agent` | Assign a skill to an agent |
| `agent_hq_remove_skill_from_agent` | Remove a skill from an agent |

### MCP resources

| Resource URI | Description |
|---|---|
| `agent-hq://workflow/statuses` | Legacy/default task status seed reference only. Task statuses are workflow-configurable; use `agent_hq_get_workflow_metadata` for tenant/workflow/task-specific values. |
| `agent-hq://workflow/task-types` | Legacy/default task type seed reference plus global system enums for task priority and story points. Task types are workflow-configurable; use `agent_hq_get_workflow_metadata` for tenant/workflow/task-specific values. |
| `agent-hq://projects/summary` | Compact project list |

### System vs workflow-defined values

These values are global system vocabulary and are intentionally static in the MCP catalog:
- `priority`: task priority (`low`, `medium`, `high`)
- `story_points`: supported story point values
- workflow lifecycle `status`: board/workflow lifecycle values such as `planning`, `active`, `paused`, `complete`, and `closed`

These values are tenant/workflow configurable and must be resolved from metadata tools before validation or UI display:
- task `status`
- task `task_type`
- lifecycle/outcome keys used by `agent_hq_post_task_outcome`
- relationship type keys
- custom task field schemas

Do not treat a global task status enum as authoritative. A workflow record can still have a static lifecycle status such as `planning`, `active`, `paused`, `complete`, or `closed`, while tasks inside that workflow can use a configurable status set such as `todo`, `ready`, `in_progress`, `review`, `ready_to_merge`, `done`, or a tenant-defined alternative. Always resolve the task's workflow metadata first.

Super-admin MCP keys with `admin.cross_tenant` may pass `tenant_id` to workflow metadata/read helpers such as `agent_hq_get_workflow_metadata`, `agent_hq_list_workflow_type_statuses`, `agent_hq_list_workflow_type_outcomes`, `agent_hq_list_workflow_type_relationship_types`, and `agent_hq_list_workflow_type_field_schemas`. Tenant-bound MCP keys cannot pass explicit tenant selectors, even for their own tenant; the server returns an authorization error instead.

---

## File Scopes

Use project files for material that applies across the whole project: product context, shared research, API references, brand assets, and reusable runbooks. Use workflow files for material owned by a single workflow: implementation specs, QA artifacts, handoff packages, and temporary working documents that should not clutter the broader project library.

Workflow-file handoff path for agents:
1. Resolve project and workflow context from `agent_hq_get_task`, `agent_hq_get_task_context`, or `agent_hq_get_workflow`. Tool schemas use `workflow_id`; legacy task fields may still call this `sprint_id`.
2. Upload with `agent_hq_upload_workflow_file` using `project_id`, `workflow_id`, `filename`, `content_base64`, and optional `mime_type` / `uploaded_by`.
3. Reference files in notes or instructions by both workflow ID and file ID or filename, for example: `workflow_id=42 file_id=9 spec.md`.
4. Update an existing artifact with `agent_hq_replace_workflow_file`; this keeps the same workflow file ID and records a new version.
5. Read current content with `agent_hq_download_workflow_file`; inspect history with `agent_hq_list_workflow_file_versions`.

Workflow-file API and MCP responses include `scope: "workflow"`, `tenant_id`, `project_id`, `workflow_id`, filename, MIME type, size, current version, and timestamps so callers can distinguish them from project files.

---

## Dynamic Workflow Recipe

Use this recipe before creating, updating, linking, or moving tasks in configurable workflows:

1. Resolve tenant and task context from the MCP identity and the current task or project. Tenant-bound keys should omit `tenant_id`; only super-admin keys can pass it.
2. Resolve workflow context with `agent_hq_get_task`, `agent_hq_get_task_context`, `agent_hq_get_workflow`, or `agent_hq_list_workflows`. Treat `sprint_id` as the current compatibility field for workflow IDs when a tool schema exposes only `sprint_id`.
3. Call `agent_hq_get_workflow_metadata` with the resolved `sprint_id`, and include `task_type` when the write depends on task-type-specific fields.
4. Resolve custom field schemas from the metadata response or with `agent_hq_list_workflow_type_field_schemas` / `agent_hq_get_task_field_schema`. Submit only accepted `custom_fields` keys and types.
5. Resolve relationship types with `agent_hq_get_task_relationship_types` for task-specific linking, or `agent_hq_list_workflow_type_relationship_types` when configuring a workflow type. Use relationship keys and dispatch semantics from the response.
6. Resolve transition requirements with `agent_hq_list_transition_requirement_fields` and the outcome metadata. Check required gate/evidence payload keys before posting an outcome.
7. Use `dry_run: true` on supported writes to preview validation and transition behavior. Supported preview surfaces include `agent_hq_create_task`, `agent_hq_update_task`, `agent_hq_move_task`, `agent_hq_post_task_outcome`, routing rules, routing transitions, transition requirements, and workflow/external event mappings.
8. Submit the real write only after the metadata, schema, relationship, and gate requirements match the intended workflow.

Preferred task lifecycle transition path:

```json
{
  "tool": "agent_hq_post_task_outcome",
  "arguments": {
    "task_id": 864,
    "outcome": "completed_for_review",
    "summary": "Implemented docs and deployed to Dev for review.",
    "payload": {
      "review_branch": "forge-fullstack/task-864-mcp-settings-docs-add-dynamic-workflow-r",
      "review_commit": "abc1234"
    },
    "dry_run": true
  }
}
```

`agent_hq_move_task` remains a compatibility helper for direct status moves and older callers. New configurable workflow clients should prefer `agent_hq_post_task_outcome` because outcomes encode the configured transition route, gate evidence, and lifecycle semantics.

---

## Task Write Behavior

### Create task

Tool: `agent_hq_create_task`

Typical writable fields:
- `title` (required)
- `project_id` (required)
- `description`
- `workflow_id` in new workflow-facing docs/tools; `sprint_id` remains the compatibility field currently used by routing/task APIs
- `priority`
- `task_type`
- `story_points`
- `custom_fields`

For configurable workflow/task-type fields, resolve the schema before creating:

```json
{
  "tool": "agent_hq_get_workflow_metadata",
  "arguments": {
    "sprint_id": 42,
    "task_type": "backend"
  }
}
```

Representative metadata response shape:

```json
{
  "ok": true,
  "data": {
    "workflow": {
      "id": 42,
      "workflow_type": "dev",
      "status": "active"
    },
    "task_statuses": [
      { "key": "ready", "label": "Ready", "terminal": false },
      { "key": "review", "label": "Review", "terminal": false }
    ],
    "task_types": [
      { "key": "backend", "label": "Backend" },
      { "key": "fullstack", "label": "Fullstack" }
    ],
    "outcomes": [
      {
        "outcome_key": "completed_for_review",
        "label": "Completed for review",
        "from_statuses": ["ready", "in_progress"],
        "to_status": "review",
        "required_fields": ["review_branch", "review_commit"]
      }
    ],
    "relationship_types": [
      {
        "key": "blocked_by",
        "label": "Blocked by",
        "direction_semantics": "target_blocks_source",
        "affects_dispatch_eligibility": true
      }
    ],
    "field_schema": {
      "task_type": "backend",
      "fields": [
        { "key": "target_surface", "type": "select", "required": false, "options": ["api", "ui"] }
      ]
    }
  }
}
```

Then pass only fields accepted by the resolved task field schema:

```json
{
  "tool": "agent_hq_create_task",
  "arguments": {
    "title": "Implement API retry policy",
    "project_id": 86,
    "sprint_id": 42,
    "task_type": "backend",
    "custom_fields": {
      "target_surface": "api",
      "risk_score": 2
    }
  }
}
```

### Update task

Tool: `agent_hq_update_task`

Typical writable fields:
- `title`
- `description`
- `priority`
- `workflow_id` in workflow-facing contexts; `sprint_id` remains the compatibility field currently used by routing/task APIs
- `task_type`
- `story_points`
- `custom_fields`

`project_id` should not be changed after creation.

`custom_fields` updates are merged with existing custom field values so clients can send only the fields they are changing. The server validates the resulting custom field set against the resolved workflow/task-type field schema. Missing required fields, unknown fields, invalid field types, and invalid select values return `validation_errors` with per-field details.

Example partial custom-field update after resolving the schema:

```json
{
  "tool": "agent_hq_update_task",
  "arguments": {
    "task_id": 123,
    "custom_fields": {
      "target_surface": "ui"
    }
  }
}
```

### Move task

Tool: `agent_hq_move_task`

- accepts `task_id` and a non-empty target `status` string
- status values are workflow-defined; call `agent_hq_get_workflow_metadata` for the task workflow before treating a value as valid
- server validates the status or outcome transition against the task workflow
- invalid status/outcome attempts return machine-readable `allowed_values` plus `metadata_tool: "agent_hq_get_workflow_metadata"`
- prefer `agent_hq_post_task_outcome` for lifecycle handoffs, because outcomes are the configured workflow transition contract
- supports `dry_run: true`; use it to preview the move before writing task state

### Notes and task relationships

- `agent_hq_add_task_note` adds a note/comment to a task
- `agent_hq_get_task_relationship_types` returns relationship type keys valid for the task's workflow, including `direction_semantics` and `affects_dispatch_eligibility`
- `agent_hq_create_task_relationship` creates or updates a relationship with a workflow-configured `relationship_type_key`
- `agent_hq_list_task_relationships` and `agent_hq_delete_task_relationship` inspect and remove relationship records
- `agent_hq_add_blocker`, `agent_hq_remove_blocker`, and `agent_hq_create_task.blockers` are legacy compatibility for one release. New agents should not use blocker-first tools; blocker compatibility only affects dispatch when the workflow defines `blocked_by` as a dispatch-blocking relationship type.

Relationship-first dependency example:

```json
{
  "tool": "agent_hq_get_task_relationship_types",
  "arguments": { "task_id": 123 }
}
```

```json
{
  "ok": true,
  "data": {
    "relationship_types": [
      {
        "key": "blocked_by",
        "label": "Blocked by",
        "inverse_label": "Blocks",
        "direction_semantics": "target_blocks_source",
        "affects_dispatch_eligibility": true,
        "active_statuses": ["todo", "ready", "in_progress"],
        "resolved_statuses": ["done"]
      }
    ]
  }
}
```

```json
{
  "tool": "agent_hq_create_task_relationship",
  "arguments": {
    "task_id": 123,
    "target_task_id": 122,
    "relationship_type_key": "blocked_by",
    "metadata": {
      "reason": "Waiting on API contract"
    }
  }
}
```

When `affects_dispatch_eligibility` is true, dispatch checks use the configured `direction_semantics`, `active_statuses`, and `resolved_statuses`. The legacy blocker tools are temporary aliases over this model, not the canonical dependency API.

### Lifecycle writes

Prefer the typed lifecycle tools over `agent_hq_api_request` or hand-built curl JSON:

- `agent_hq_start_task_run`
- `agent_hq_check_in_task_run`
- `agent_hq_report_task_blocker`
- `agent_hq_record_review_evidence`
- `agent_hq_record_qa_evidence`
- `agent_hq_record_deploy_evidence`
- `agent_hq_record_live_verification`
- `agent_hq_post_task_outcome`

These tools map directly to the existing lifecycle HTTP endpoints, keep payload construction structured, and preserve the current API compatibility path for older runtimes.

Outcome dry-run shape:

```json
{
  "ok": true,
  "data": {
    "dry_run": true,
    "task_id": 864,
    "outcome": "completed_for_review",
    "from_status": "in_progress",
    "to_status": "review",
    "valid": false,
    "missing_required_fields": ["review_commit"],
    "required_fields": ["review_branch", "review_commit"],
    "would_write": {
      "task_status": "review",
      "history": true,
      "instance_state": "completed"
    }
  }
}
```

### Canonical routing and schema endpoints behind the MCP tools

These typed MCP tools map to explicit, self-describing API surfaces so clients do not need to guess hidden paths:
- workflow assignment rules: `/api/v1/routing/assignment-rules`
- compatibility aliases for assignment rules: `/api/v1/routing/rules`, `/api/v1/assignment-rules`, `/api/v1/routing-rules`
- canonical workflow routing transitions: `/api/v1/routing/transitions`
- canonical story-point model routing: `/api/v1/model-routing`
- compatibility aliases for canonical model routing: `/api/v1/routing/model-routing`, `/api/v1/routing/story-point-routing`
- agent skill assignment relation surface: `/api/v1/agents/:id/skills`
- task field schema surfaces: `/api/v1/sprints/types/:key/field-schemas`
- top-level schema aliases for external clients: `/api/v1/task-field-schemas`, `/api/v1/task-field-definitions`

---

## Response Format

All tools should return a consistent envelope.

Success:

```json
{
  "ok": true,
  "data": {}
}
```

Error:

```json
{
  "ok": false,
  "error": "Descriptive error message"
}
```

Response shaping rules:
- use snake_case
- keep list responses concise
- return full detail only from detail tools
- include pagination metadata where relevant (`total`, `hasMore`, `limit`, `offset`)
- make errors actionable

Example invalid transition error:

```json
{
  "ok": false,
  "error": "Invalid status transition from 'todo' to 'done'. Valid transitions: todo -> ready, todo -> cancelled"
}
```

---

## Safety and Guardrails

### Safe by default

- read tools are idempotent, but still require the agent-bound MCP API key
- destructive delete operations are not exposed
- admin/system configuration operations are not exposed
- broad admin or setup actions are denied for normal task-agent MCP keys even if a typed tool exists
- lifecycle writes are exposed through typed MCP tools and enforced server-side against the active dispatched task and instance scope

### Configurable MCP read scopes

Agent HQ MCP credentials can be configured from the agent detail MCP access panel. The default runtime policy remains least-privilege task context access, while trusted admin agents keep backward-compatible full access. Administrators can grant these additional read-only scopes without granting `admin.full_access`:

| Scope key | UI label | Grants |
|---|---|---|
| `mcp_servers.read` | Read MCP server registry | `GET /api/v1/mcp-servers`, `GET /api/v1/mcp-servers/:id`, and `GET /api/v1/agents/:id/mcp-servers` for the key tenant. MCP server `env` values are redacted for non-`admin.full_access` MCP callers. |
| `agents.read` | Read agent registry | `GET /api/v1/agents`, `GET /api/v1/agents/:id`, and `GET /api/v1/agents/:id/mcp-permissions` for the key tenant. Credential material such as remote gateway auth headers is redacted for non-`admin.full_access` MCP callers. |
| `tools.read` | Read tool registry | `GET /api/v1/tools`, `GET /api/v1/tools/:id`, `GET /api/v1/tools/audit/duplicates`, and `GET /api/v1/agents/:id/tools` for the key tenant, including readback needed for duplicate-tool and assignment audits. |

Turning off a scope returns `403` with `code: "mcp_scope_denied"` and `details.required_capability` naming the missing scope. These scopes never authorize create, update, delete, assignment mutation, credential disclosure, secret/environment value disclosure, or cross-tenant access. Cross-tenant selectors still require `admin.cross_tenant`; broad tenant-local mutation still requires `admin.full_access`.

### Write guardrails

- MCP API keys are stored server-side as hashes and map to exactly one Agent HQ agent
- the MCP server sends the key as bearer auth on every Agent HQ API request
- Agent HQ resolves the API key to the trusted agent identity before applying writes
- MCP-authenticated task writes ignore client-supplied `changed_by`, `authorized_by`, or legacy `authority_by` spoofing and use the resolved agent identity instead
- required fields must be validated
- task status transitions must be validated server-side
- writes are recorded in history/audit surfaces with the resolved agent slug
- rate limiting should apply server-side

What v1 does not need:
- custom confirmation flows inside the MCP server
- undo / rollback support
- per-field ACL complexity beyond normal writable field validation

---

## Prerequisites

- Agent HQ is installed and running locally
- Node.js 18+ installed
- Agent HQ API reachable at `http://localhost:3501` or your configured local port

---

## Build

```bash
cd /path/to/agent-hq/api
npm install
npm run build
```

This builds the MCP server to:

```text
api/dist/mcp/server.js
```

---

## Client Setup

### Claude Desktop

Add to Claude desktop config:

macOS path:
`~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "agent-hq": {
      "command": "node",
      "args": ["/absolute/path/to/agent-hq/api/dist/mcp/server.js"],
      "env": {
        "AGENT_HQ_MCP_API_KEY": "ahq_mcp_..."
      }
    }
  }
}
```

Restart Claude Desktop after saving.

### ChatGPT Desktop

In ChatGPT Desktop settings, add an MCP integration with:

- Command: `node`
- Args: `/absolute/path/to/agent-hq/api/dist/mcp/server.js`
- Env: `AGENT_HQ_MCP_API_KEY=ahq_mcp_...`

### Alternate `npx` setup

```json
{
  "mcpServers": {
    "agent-hq": {
      "command": "npx",
      "args": ["--yes", "agent-hq-mcp"],
      "env": {
        "AGENT_HQ_MCP_API_KEY": "ahq_mcp_..."
      }
    }
  }
}
```

---

## Configuration

The MCP server supports config via environment variables and optional local config file.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `AGENT_HQ_API_URL` | `http://localhost:3501` | Agent HQ API base URL |
| `AGENT_HQ_MCP_API_KEY` | none | Required agent-bound MCP API key |
| `MCP_RATE_LIMIT_RPM` | `60` | Max requests per minute |

Example:

```json
{
  "mcpServers": {
    "agent-hq": {
      "command": "node",
      "args": ["/path/to/agent-hq/api/dist/mcp/server.js"],
      "env": {
        "AGENT_HQ_API_URL": "http://localhost:9999",
        "AGENT_HQ_MCP_API_KEY": "ahq_mcp_..."
      }
    }
  }
}
```

### Config file

Create:

```text
~/.agent-hq/mcp.json
```

Example:

```json
{
  "api_url": "http://localhost:3501",
  "api_key": "ahq_mcp_...",
  "rate_limit_rpm": 120
}
```

Environment variables take precedence over config file values.

### Agent-bound key materialization

For OpenClaw agents, Agent HQ materializes the assigned `agent-hq` MCP server into the agent workspace `.mcp.json`. During materialization it issues or reuses a key for that specific agent and writes it to the server env as `AGENT_HQ_MCP_API_KEY`.

The runtime trust boundary is:

```text
AGENT_HQ_MCP_API_KEY
  -> mcp_api_keys.key_hash
  -> agents.id
  -> resolved agent slug / Atlas authority
  -> task history, audit actor, and protected write checks
```

Missing, invalid, disabled, revoked, unmapped, or disabled-agent keys are rejected with a clear authorization error. For Atlas, the resolved key grants Atlas authority for protected task status writes while the audit actor remains the resolved agent slug (`atlas`).

### Legacy compatibility

Current implementation may still read legacy fallback names for backward compatibility, but new configuration should use Agent HQ names only.

---

## Smoke Test

Run the MCP server manually and send `initialize` plus `tools/list` over stdio:

```bash
cd /path/to/agent-hq/api

printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' \
  | node dist/mcp/server.js
```

Expected result:
- valid JSON-RPC responses
- Agent HQ tool list returned
- server ready over stdio

---

## Debugging

MCP protocol traffic uses stdout, so logs should go to stderr.

Example:

```bash
node dist/mcp/server.js 2>&1 1>/dev/null
```

Expected log shape:

```text
[agent-hq-mcp] Starting, API: http://localhost:3501 | Rate limit: 60 req/min | Auth: configured
[agent-hq-mcp] MCP server connected, ready for tool calls via stdio.
```

Useful checks:
- confirm `api/dist/mcp/server.js` exists
- confirm the API is reachable at `AGENT_HQ_API_URL`
- confirm `AGENT_HQ_MCP_API_KEY` is present in the MCP server env
- confirm the client config points at the built server path
- confirm the client was restarted after config changes

---

## Rate Limiting

Default rate limit:
- 60 requests per minute
- process-level token bucket

Typical rate limit error:

```json
{
  "ok": false,
  "error": "Rate limit exceeded. Maximum 60 requests per minute."
}
```

---

## API Mapping

Routing/admin configuration tools that read or mutate tenant-owned config accept optional `tenant_id` selectors for super-admin MCP keys only. This includes assignment rules, automatic routing transitions, transition/gate requirements, and workflow event mappings. Regular tenant-bound MCP keys are denied when they pass `tenant_id`, even for their own tenant, and normal browser/API requests cannot use explicit tenant selectors.

Supported high-blast-radius writes accept `dry_run: true` for read-only preview. `agent_hq_post_task_outcome` previews configured outcome routing, proposed status/evidence changes, validation errors, and missing gate requirements without writing task state, notes, history, runtime receipts, or instance state. Assignment rules, routing transitions, transition requirements, and workflow/external event mappings preview validation plus affected config row summaries without writing config rows. Model-routing and workflow-type/task-definition writes do not yet expose `dry_run`; use their read tools first and treat those writes as mutating.

| MCP Tool | HTTP Method | Endpoint |
|---|---|---|
| `agent_hq_list_projects` | GET | `/api/v1/projects` |
| `agent_hq_get_project` | GET | `/api/v1/projects/:id` plus metrics endpoint if needed |
| `agent_hq_create_project` | POST | `/api/v1/projects` |
| `agent_hq_update_project` | PUT | `/api/v1/projects/:id` |
| `agent_hq_delete_project` | DELETE | `/api/v1/projects/:id` |
| `agent_hq_list_workflows` | GET | `/api/v1/workflows` |
| `agent_hq_get_workflow` | GET | `/api/v1/workflows/:id` plus metrics endpoint if needed |
| `agent_hq_create_workflow` | POST | `/api/v1/workflows` |
| `agent_hq_update_workflow` | PUT | `/api/v1/workflows/:id` |
| `agent_hq_delete_workflow` | DELETE | `/api/v1/workflows/:id` |
| `agent_hq_list_sprints` | GET | `/api/v1/sprints` legacy alias |
| `agent_hq_get_sprint` | GET | `/api/v1/sprints/:id` legacy alias |
| `agent_hq_create_sprint` | POST | `/api/v1/sprints` legacy alias |
| `agent_hq_update_sprint` | PUT | `/api/v1/sprints/:id` legacy alias |
| `agent_hq_delete_sprint` | DELETE | `/api/v1/sprints/:id` legacy alias |
| `agent_hq_list_agents` | GET | `/api/v1/agents` |
| `agent_hq_get_agent` | GET | `/api/v1/agents/:id` |
| `agent_hq_list_mcp_servers` | GET | `/api/v1/mcp-servers` |
| `agent_hq_get_mcp_server` | GET | `/api/v1/mcp-servers/:id` |
| `agent_hq_list_agent_mcp_servers` | GET | `/api/v1/agents/:id/mcp-servers` |
| `agent_hq_list_tools` | GET | `/api/v1/tools` |
| `agent_hq_get_tool` | GET | `/api/v1/tools/:id` |
| `agent_hq_audit_duplicate_tools` | GET | `/api/v1/tools/audit/duplicates` |
| `agent_hq_list_agent_tools` | GET | `/api/v1/agents/:id/tools` |
| `agent_hq_list_assignment_rules` | GET | `/api/v1/routing/assignment-rules?sprint_id=:sprintId` |
| `agent_hq_get_assignment_rule` | GET | `/api/v1/routing/assignment-rules/:id?sprint_id=:sprintId` |
| `agent_hq_create_assignment_rule` | POST | `/api/v1/routing/assignment-rules` |
| `agent_hq_update_assignment_rule` | PUT | `/api/v1/routing/assignment-rules/:id` |
| `agent_hq_delete_assignment_rule` | DELETE | `/api/v1/routing/assignment-rules/:id` |
| `agent_hq_list_routing_rules` | GET | `/api/v1/routing/rules?sprint_id=:sprintId` compatibility alias |
| `agent_hq_get_routing_rule` | GET | `/api/v1/routing/rules/:id?sprint_id=:sprintId` compatibility alias |
| `agent_hq_create_routing_rule` | POST | `/api/v1/routing/rules` compatibility alias |
| `agent_hq_update_routing_rule` | PUT | `/api/v1/routing/rules/:id` compatibility alias |
| `agent_hq_delete_routing_rule` | DELETE | `/api/v1/routing/rules/:id` compatibility alias |
| `agent_hq_list_routing_transitions` | GET | `/api/v1/routing/transitions` |
| `agent_hq_get_routing_transition` | GET | `/api/v1/routing/transitions/:id` |
| `agent_hq_create_routing_transition` | POST | `/api/v1/routing/transitions` |
| `agent_hq_update_routing_transition` | PUT | `/api/v1/routing/transitions/:id` |
| `agent_hq_delete_routing_transition` | DELETE | `/api/v1/routing/transitions/:id` |
| `agent_hq_list_model_routing_rules` | GET | `/api/v1/model-routing` |
| `agent_hq_get_model_routing_rule` | GET | `/api/v1/model-routing/:id` |
| `agent_hq_create_model_routing_rule` | POST | `/api/v1/model-routing` |
| `agent_hq_update_model_routing_rule` | PUT | `/api/v1/model-routing/:id` |
| `agent_hq_delete_model_routing_rule` | DELETE | `/api/v1/model-routing/:id` |
| `agent_hq_list_sprint_types` | GET | `/api/v1/sprints/types/list` |
| `agent_hq_list_sprint_type_task_types` | GET | `/api/v1/sprints/types/:key/task-types` |
| `agent_hq_update_sprint_type_task_types` | PUT | `/api/v1/sprints/types/:key/task-types` |
| `agent_hq_create_sprint_type` | POST | `/api/v1/sprints/types` |
| `agent_hq_update_sprint_type` | PUT | `/api/v1/sprints/types/:key` |
| `agent_hq_delete_sprint_type` | DELETE | `/api/v1/sprints/types/:key` |
| `agent_hq_list_workflow_templates` | GET | `/api/v1/sprints/workflow-templates` or `/api/v1/sprints/types/:key/workflow-templates` |
| `agent_hq_get_workflow_template` | GET | `/api/v1/sprints/types/:key/workflow-templates/:templateId` |
| `agent_hq_create_workflow_template` | POST | `/api/v1/sprints/types/:key/workflow-templates` |
| `agent_hq_update_workflow_template` | PUT | `/api/v1/sprints/types/:key/workflow-templates/:templateId` |
| `agent_hq_delete_workflow_template` | DELETE | `/api/v1/sprints/types/:key/workflow-templates/:templateId` |
| `agent_hq_list_task_field_schemas` | GET | `/api/v1/sprints/types/:key/field-schemas` |
| `agent_hq_get_task_field_schema` | GET | `/api/v1/sprints/types/:key/field-schemas/:schemaId` |
| `agent_hq_create_task_field_schema` | POST | `/api/v1/sprints/types/:key/field-schemas` |
| `agent_hq_update_task_field_schema` | PUT | `/api/v1/sprints/types/:key/field-schemas/:schemaId` |
| `agent_hq_delete_task_field_schema` | DELETE | `/api/v1/sprints/types/:key/field-schemas/:schemaId` |
| `agent_hq_list_tasks` | GET | `/api/v1/tasks` |
| `agent_hq_get_task` | GET | `/api/v1/tasks/:id` |
| `agent_hq_delete_task` | DELETE | `/api/v1/tasks/:id` |
| `agent_hq_get_task_notes` | GET | `/api/v1/tasks/:id/notes` |
| `agent_hq_get_task_history` | GET | `/api/v1/tasks/:id/history` |
| `agent_hq_list_jobs` | GET | `/api/v1/jobs` |
| `agent_hq_list_agents` | GET | `/api/v1/agents` |
| `agent_hq_create_task` | POST | `/api/v1/tasks` |
| `agent_hq_update_task` | PUT | `/api/v1/tasks/:id` |
| `agent_hq_move_task` | PUT | `/api/v1/tasks/:id` |
| `agent_hq_add_task_note` | POST | `/api/v1/tasks/:id/notes` |
| `agent_hq_start_task_run` | PUT | `/api/v1/instances/:id/start` |
| `agent_hq_check_in_task_run` | POST | `/api/v1/instances/:id/check-in` |
| `agent_hq_report_task_blocker` | POST | `/api/v1/instances/:id/check-in` |
| `agent_hq_record_review_evidence` | PUT | `/api/v1/tasks/:id/review-evidence` |
| `agent_hq_record_qa_evidence` | PUT | `/api/v1/tasks/:id/qa-evidence` |
| `agent_hq_record_deploy_evidence` | PUT | `/api/v1/tasks/:id/deploy-evidence` |
| `agent_hq_record_live_verification` | PUT | `/api/v1/tasks/:id/live-verification` |
| `agent_hq_post_task_outcome` | POST | `/api/v1/tasks/:id/outcome` |
| `agent_hq_get_task_relationship_types` | GET | `/api/v1/tasks/:id/relationship-types` |
| `agent_hq_list_task_relationships` | GET | `/api/v1/tasks/:id/relationships` |
| `agent_hq_create_task_relationship` | POST | `/api/v1/tasks/:id/relationships` |
| `agent_hq_delete_task_relationship` | DELETE | `/api/v1/tasks/:id/relationships/:relationshipId` |
| `agent_hq_add_blocker` | POST | `/api/v1/tasks/:id/blockers` |
| `agent_hq_remove_blocker` | DELETE | `/api/v1/tasks/:id/blockers/:blocker_id` |
| `agent_hq_list_agent_skills` | GET | `/api/v1/agents/:id/skills` |
| `agent_hq_assign_skill_to_agent` | POST | `/api/v1/agents/:id/skills` |
| `agent_hq_remove_skill_from_agent` | DELETE | `/api/v1/agents/:id/skills/:skillName` |

---

## Naming Guidance

Use these names in docs, config, and user-facing communication:
- Agent HQ MCP server
- `agent_hq_*` tool names
- `agent-hq://...` resource URIs
- `AGENT_HQ_API_URL`
- `~/.agent-hq/mcp.json`

Avoid legacy product naming in new docs.

---

## Summary

Agent HQ MCP is a local stdio MCP server that exposes a broad first-class control surface for Agent HQ through typed tools and self-describing resources. It routes everything through the existing API, covers core planning, routing, capability, and assignment objects, and minimizes the need for clients to guess raw REST calls.
