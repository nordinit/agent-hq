# Agent HQ MCP Server

Connect Agent HQ to ChatGPT desktop, Claude desktop, or any MCP-compatible client — locally over stdio, or remotely over Streamable HTTP.

---

## Overview

The Agent HQ MCP server is a thin adapter between MCP clients and the Agent HQ API. It is served over two transports that share one tool surface:

```text
Local client (Claude Desktop / ChatGPT desktop / CLI)
  -> stdio
Agent HQ MCP server (api/src/mcp/server.ts)
  -> HTTP localhost
Agent HQ API

Remote client (Claude connector / ChatGPT custom connector)
  -> HTTPS
Agent HQ API /mcp  (api/src/mcp/httpServer.ts)
  -> in-process HTTP
Agent HQ API /api/v1
```

Design goals:
- expose Agent HQ projects, workflows, tasks, notes, workflow-configured task relationships, jobs, and agents to MCP clients
- expose recurring task series so scheduled task automation can be managed without opening the UI
- allow safe task-oriented writes from chat
- keep the server stateless by routing all operations through the existing API
- use Agent HQ naming throughout

Assumptions:
- every MCP server process or request carries an Agent HQ API key bound to one Agent HQ agent identity
- no direct database access from the MCP server; every tool call goes through the REST API and its capability policy
- the stdio transport serves one local client; the HTTP transport serves any number of remote ones, authenticated per request

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
| Workflows / Boards | Yes | Yes | Full CRUD via workflow tools |
| Workflow Files | Yes | Yes | Use for specs and artifacts owned by one workflow |
| Tasks | Yes | Yes | Create, update, move status, delete |
| Recurring Task Series | Yes | Yes | Create and manage scheduled task automation |
| Task Notes | Yes | Yes | Add notes/comments |
| Task Lifecycle Writes | Yes | Yes | Scoped start/check-in/blocker, evidence, and outcome tools |
| Task Relationships | Yes | Yes | Relationship-first tools create/list/delete workflow-configured task relationships |
| Task Blockers | Yes | Yes | Legacy compatibility for one release; prefer relationship tools |
| Task History | Yes | No | Audit trail / history only |
| Agents | Yes | Yes | Includes skill assignment relations, tools, MCP servers |
| Assignment Rules | Yes | Yes | Workflow task-to-agent assignment rules CRUD |
| Routing Transitions | Yes | Yes | Canonical workflow/model-selection routing object CRUD |
| Model Routing | Yes | Yes | Story-point model-routing CRUD |
| Workflow Types | Yes | Yes | First-class workflow definition surface |
| Workflow Templates | Yes | Yes | First-class workflow definition surface |
| Task Field Schemas | Yes | Yes | First-class task-definition surface |

### Still intentionally out of scope

- raw database access
- arbitrary instance control beyond the scoped lifecycle write surfaces
- raw attachment internals outside the typed project-file and workflow-file tools
- browser pool or other internal runtime concerns

---

## Tool Surface

Every tool answers to exactly one name in the `agent_hq_*` namespace.

Tools used to carry aliases — the `atlas_*` names from before the product was renamed, plus `sprint`/`workflow` and `routing_rule`/`assignment_rule` spellings. 192 tools were registered under 434 names, and since every name is a full tool definition, that more than doubled what a client loaded to reach the same capability. Each tool now has one name, chosen for fit rather than for history: collections read as `list_`, single records as `get_`, workflow over sprint, assignment rule over routing rule.

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
| `agent_hq_list_tasks` | List tasks with filters |
| `agent_hq_search_project_tasks` | Search only the authenticated agent's assigned project for bounded exact-match task dedupe |
| `agent_hq_get_task` | Get full task detail |
| `agent_hq_get_task_notes` | Get notes for a task |
| `agent_hq_get_task_history` | Get task history |
| `agent_hq_list_recurring_task_series` | List recurring task series with project/workflow/enabled filters |
| `agent_hq_get_recurring_task_series` | Get recurring task series detail with recent run history |
| `agent_hq_get_recurring_task_series_history` | List generated-run history for one recurring task series |
| `agent_hq_get_task_relationship_types` | Resolve valid relationship type keys and dispatch semantics for a task workflow |
| `agent_hq_list_task_relationships` | List generic task relationships for a task |
| `agent_hq_get_workflow_metadata` | Resolve task statuses, task types, outcomes, relationship types, and custom field schema metadata for a workflow |
| `agent_hq_list_transition_requirement_fields` | Resolve gate/evidence fields available to configurable outcome transitions |
| `agent_hq_list_workflow_type_statuses` | List task status labels configured for a workflow type |
| `agent_hq_list_workflow_type_outcomes` | List lifecycle outcome keys configured for a workflow type |
| `agent_hq_list_workflow_type_relationship_types` | Alias for listing relationship types configured for a workflow type |
| `agent_hq_list_workflow_type_field_schemas` | Alias for listing custom task field schemas configured for a workflow type |
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
| `agent_hq_create_recurring_task_series` | Create a recurring task series with schedule, timezone, workflow, initial generated-task status, overlap policy, enabled state, and optional agent assignment |
| `agent_hq_update_recurring_task_series` | Update recurring task series configuration |
| `agent_hq_enable_recurring_task_series` | Enable scheduling for a recurring task series |
| `agent_hq_disable_recurring_task_series` | Disable scheduling for a recurring task series |
| `agent_hq_run_recurring_task_series_now` | Trigger a recurring task series immediately and create a task now |
| `agent_hq_add_blocker` | Legacy compatibility: add `blocked_by` only when configured as dispatch-blocking |
| `agent_hq_remove_blocker` | Legacy compatibility: remove a `blocked_by` compatibility relationship/dependency |
| `agent_hq_create_assignment_rule` | Create a workflow assignment rule |
| `agent_hq_update_assignment_rule` | Update a workflow assignment rule |
| `agent_hq_delete_assignment_rule` | Delete a workflow assignment rule |
| `agent_hq_create_assignment_rule` | Compatibility alias: create a workflow assignment rule |
| `agent_hq_update_assignment_rule` | Compatibility alias: update a workflow assignment rule |
| `agent_hq_delete_assignment_rule` | Compatibility alias: delete a workflow assignment rule |
| `agent_hq_create_routing_transition` | Create a canonical routing transition |
| `agent_hq_update_routing_transition` | Update a canonical routing transition |
| `agent_hq_delete_routing_transition` | Delete a canonical routing transition |
| `agent_hq_create_model_routing_rule` | Create a story-point model-routing rule |
| `agent_hq_update_model_routing_rule` | Update a story-point model-routing rule |
| `agent_hq_delete_model_routing_rule` | Delete a story-point model-routing rule |
| `agent_hq_list_workflow_type_task_types` | List allowed task types for a workflow type using the legacy sprint_type key |
| `agent_hq_update_workflow_type_task_types` | Replace allowed task types for a workflow type using the legacy sprint_type key |
| `agent_hq_create_workflow_type` | Create a workflow type using the legacy workflow type route |
| `agent_hq_update_workflow_type` | Update a workflow type using the legacy workflow type route |
| `agent_hq_delete_workflow_type` | Delete a workflow type using the legacy workflow type route |
| `agent_hq_list_workflow_type_field_schemas` | List task field schemas for a workflow type |
| `agent_hq_get_workflow_type_field_schema` | Get a task field schema |
| `agent_hq_create_workflow_type_field_schema` | Create a task field schema |
| `agent_hq_update_workflow_type_field_schema` | Update a task field schema |
| `agent_hq_delete_workflow_type_field_schema` | Delete a task field schema |
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

### Project-scoped task search for dedupe

Use `agent_hq_search_project_tasks` when a runtime agent must reuse an existing follow-up task before creating another one. The tool requires the explicit `tasks.search_project_tasks` capability, which is disabled by default for scoped runtime agents. The server resolves `project_id` from the authenticated MCP agent identity; the tool does not accept a caller-supplied project scope and cannot mutate tasks, relationships, lifecycle state, notes, evidence, proposals, or messages.

Safe replay pattern for recurring task #959:
1. Call `agent_hq_search_project_tasks` with `workflow_id`, `task_type`, `nonterminal_only: true`, and `custom_fields` containing an exact `crm_lead_id` or `external_project_id`.
2. If a result is returned, reuse the returned task ID and do not create a duplicate follow-up.
3. If no result is returned, create the follow-up with the typed task creation tool. Do not take external bid, proposal, or message actions as part of this dedupe check.

### Recurring task series over MCP

Use the recurring task series tools when an external client needs scheduled task automation without using the UI. A create call requires the target `project_id`, `workflow_id`, generated-task template fields, `status_on_create`, `schedule_expression`, and `timezone`. Optional fields include `enabled`, `overlap_policy`, and `agent_id`.

Example create payload:

```json
{
  "project_id": 12,
  "workflow_id": 34,
  "title_template": "Daily sales follow-up",
  "description_template": "Review new CRM leads and create follow-up tasks.",
  "task_type": "sales",
  "priority": "high",
  "story_points": 2,
  "status_on_create": "ready",
  "schedule_expression": "every day 09:00",
  "timezone": "America/New_York",
  "enabled": true,
  "overlap_policy": "skip_if_active",
  "agent_id": 7,
  "changed_by": "mcp-client"
}
```

Supported schedules are the same as the API/UI recurring task scheduler: `every N minutes`, `every day HH:mm`, and `every <weekday> HH:mm`. Resolve `task_type` and `status_on_create` for the target workflow with `agent_hq_get_workflow_metadata` before creating or updating a series.

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
4. Resolve custom field schemas from the metadata response or with `agent_hq_list_workflow_type_field_schemas` / `agent_hq_get_workflow_type_field_schema`. Submit only accepted `custom_fields` keys and types.
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
- `status` (optional initial workflow status; omit to use the workflow/default creation status)
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
    "status": "ready",
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

## Remote Transport (Streamable HTTP)

The API serves the same tool surface over MCP's Streamable HTTP transport at `/mcp`, so remote clients — Claude connectors, ChatGPT custom connectors, anything speaking Streamable HTTP — can reach an Agent HQ install published at an HTTPS URL. No separate process: the transport is mounted inside the API (`api/src/mcp/httpServer.ts`) and is enabled by default.

```text
POST https://<your-agent-hq-host>/mcp
Authorization: Bearer ahq_mcp_...
Accept: application/json, text/event-stream
```

Properties worth knowing before pointing a connector at it:

- **The transport authenticates; it does not authorize.** Every tool call still travels through `/api/v1` carrying the caller's own MCP key, so `authorizeMcpApiRequestIfPresent` and the agent's capability policy apply exactly as they do for a local stdio client. A key that cannot move a task over stdio cannot move it from a phone.
- **Servers are built per request** (stateless transport, no session id). Remote connectors reconnect freely, and per-request construction keeps one client's identity from outliving its request.
- **Keys are read from `Authorization: Bearer` or `x-api-key` directly.** Unlike `/api/v1`, this route does not require the `x-agent-hq-mcp-client` marker header — remote connectors send a plain bearer token and nothing else.
- **Rate limiting is per key**, defaulting to 120 requests/minute.

Publishing the endpoint (TLS, a public hostname, tunnel or reverse proxy) is deployment work outside this document. Both major clients connect from the vendor's cloud rather than from your device, so `localhost` and VPN-only hosts are unreachable to them.

### Tool profiles

The full catalog registers ~186 tools. That is the right surface for a local client driving the whole product and the wrong one for a remote connector, which loads every tool definition into the conversation before the user has asked for anything.

A profile is a named allow-list of exposed tool names (`api/src/mcp/toolProfiles.ts`):

| Profile | Names exposed | Use |
|---|---|---|
| `full` | all ~186 | stdio server default; unchanged behaviour |
| `mobile` | 24 | HTTP transport default: board reads, task writes, recurring task series |

The `mobile` profile deliberately omits the configuration surfaces (agents, skills, routing, workflow definitions, teams, tools, MCP servers), file upload/download, and the dispatch-scoped lifecycle writes — evidence, outcomes, run check-ins — which only mean something for an agent that owns a dispatched run.

A profile narrows what a client can *see*. It is not an authorization boundary; the capability policy is.

### Scoped identity

Give a remote client its own agent identity rather than reusing Atlas's. A connector's key lives outside the machine, in the vendor's connector config, which makes it the key most likely to leak and the one least worth granting broadly. A separate identity is separately revocable, appears on its own in the audit trail, and — unlike anything named Atlas, which `isTrustedMcpIdentity` resolves to trusted-admin defaults — starts from the scoped-runtime policy.

```bash
cd api
npx tsx src/bin/provision-remote-mcp-identity.ts --project-id <id>
```

The script is idempotent. It creates (or updates) an agent named `Claude Mobile`, writes the capability policy paired with the tool profile, and issues an MCP key, printing it once. Re-run with `--rotate-key` to replace a key and revoke the old ones — Agent HQ stores only hashes, so a lost key cannot be printed again.

The identity is created enabled because `resolveMcpApiIdentityForKey` refuses a key mapped to a disabled agent; a disabled identity is one whose connector can never authenticate. Nothing dispatches to it regardless — automatic assignment runs through assignment rules, and none names this agent. Keep it out of assignment rules and teams and it stays a credential rather than a worker.

The policy the `mobile` profile pairs with:

| Capability | Grants |
|---|---|
| `discovery.read_catalog` | catalog/health discovery |
| `projects.read_project_board` | the tenant project list, plus task/workflow/metadata collections scoped to the assigned project |
| `projects.read_active_project` | project detail |
| `sprints.read_active_sprint` | workflow detail |
| `sprints.pause_active_sprint` | pause, resume, and reopen a workflow in the assigned project |
| `sprints.complete_active_sprint` | complete or close a workflow in the assigned project |
| `agents.manage_project_agents` | list/read/create/update/delete agents in the assigned project, including job instructions |
| `workflow_definitions.read_project_scope` | workflow definition reads — type, task types, field schemas, statuses, outcomes, relationship types |
| `tasks.read_project_context` | task detail, notes, history, relationships |
| `tasks.manage_project_tasks` | create/update/delete tasks and relationships in the assigned project |
| `tasks.write_project_notes` | notes on any task in the assigned project |
| `tasks.search_project_tasks` | bounded exact-match dedupe search |
| `recurring_task_series.*` | read and manage scheduled task automation in the assigned project |

Absent by design: every `admin.*` key, and `tasks.write_active_lifecycle` — a connector should not report evidence or an outcome for a run it is not executing.

Several capabilities were added for this shape of client. `projects.read_project_board` covers the collection reads a board view needs; every other read capability resolves to a single record or to the agent's own dispatched task, which is right for a runtime agent and leaves a remote client unable to answer "what is on my board" without an admin key. Each collection that can name a project must name the assigned one. `tasks.write_project_notes` lets an identity comment on work it is not executing, and stops at notes.

The two `sprints.*_active_sprint` writes back `agent_hq_set_workflow_status`. Both resolve scope the same way — the workflow attached to the caller's active dispatched task, or any workflow inside its assigned project — and both are off by default for scoped runtime keys, so a dispatched agent gets workflow lifecycle control only when an operator grants it. They are separate because the transitions are not equivalent: pausing is a reversible hold, while completing stamps the end date and stands the workflow's agents down, so an agent that may say "hold on" does not thereby get to say "this cycle is finished."

Neither is in `SCOPED_MCP_POLICY_MUTABLE_CAPABILITIES`, so a scoped policy editor cannot grant workflow lifecycle control to itself or another agent; that stays an administrative act.

### Where MCP authority comes from

Authority is a property of the **key**, not of the agent it belongs to. `mcp_api_keys.role` is the only input:

| role | effect |
|---|---|
| `scoped` | default. The capability policy is the whole answer. |
| `admin` | trusted: resolves to the `trusted_admin` default policy. |
| `super_admin` | trusted, and permitted across tenants. |

It used to be derived from the agent record — `system_role` of `admin` or `atlas`, a slug of `atlas`, or a name equal to `Atlas`. All three are ordinary writable columns, so any capability that could edit an agent was a latent privilege escalation: rename an agent to `Atlas` and it came back an administrator. The authorization layer had to defend itself by enumerating fields that were unsafe to write, which is the wrong shape — authority should come from the credential presented, not from data that credential can edit.

Consequences worth knowing:

- **Editing an agent can no longer promote it.** `agents.manage_project_agents` writes the agent record freely, and the record is exactly what authority is not read from.
- **`system_role` still matters elsewhere** — Atlas dispatch behaviour, workspace provisioning, tenant bootstrap — it just confers nothing over MCP.
- **An agent can hold keys of different roles.** Request-time authorization always reads the presented key. The permissions UI, which describes an agent rather than a call, reports the strongest role among that agent's live keys.
- **Anything unrecognised reads as `scoped`.** An unknown role value, a missing column, or a build running one migration behind all resolve to least authority rather than failing open.

Issue an administrative key deliberately: `issueMcpApiKeyForAgent(db, agentId, name, 'admin')`. The default is `scoped`, so no path mints authority by omission. The one environment-driven exception is the configured bootstrap key, which becomes `super_admin` only when `AGENT_HQ_MCP_API_KEY_GLOBAL_ADMIN` is set.

Migration 24 backfills existing keys from the old rules, so identities that were administrative before the change stay administrative after it. Migration 25 then drops the columns it read from — `mcp_api_keys.global_admin` and `agents.global_mcp_admin` — because a privilege column that still exists is one someone will eventually write to and expect to work. That also removes the rollback path: the pre-24 build selects `global_admin` unconditionally, so restoring it means restoring the columns first. **Run `npm run db:migrate` before restarting the API** — the new code probes for the column and treats every key as `scoped` when it is missing, so restarting first would strip administrative access until the migration lands.

### Managing project agents over MCP

`agents.manage_project_agents` covers the roster and each agent's record — job instructions, role, model, skills, workspace and routing configuration — plus its docs bundle, for agents in the assigned project.

The write guard is the whole design. `resolveAgentIdentityFields` derives trust from the agent row itself: a `system_role` of `admin` or `atlas`, a `global_mcp_admin` flag, or a name or slug matching the Atlas identity all make an agent trusted, and a trusted agent resolves to the `trusted_admin` default policy under which nearly every capability — `admin.full_access` included — is enabled. A grant that let a connector write those fields would not be project-scoped at all; it would let the connector promote its own row and come back as an administrator.

So any create or update carrying `system_role`, `global_mcp_admin`, `key_global_admin`, `tenant_id` or `session_key` is refused outright, as is one naming the agent `Atlas` or slugging it `atlas`. `project_id` must name the assigned project, and a create must name it explicitly. **If a new input to `resolveAgentIdentityFields` is ever added, it has to be added to `AGENT_TRUST_BEARING_FIELDS` in the same change.**

Out of scope, and left to administrative keys: `/provision`, `/provision-full` and `/mcp/sync`, which build workspaces and credentials; and `/mcp-permissions` and `/mcp-tool-allowlists`, which decide what an agent may do over MCP. The line is that this capability edits what an agent is *told to do*, not what it is *allowed to do* or where it runs from.

Note it does not exclude the connector's own row: an identity holding this can edit, disable or delete itself. That cannot escalate — the trust guard applies to its own row too — but it can lock the connector out until an operator restores it from the canvas.

### Editing workflow definitions over MCP

A workflow definition is the type plus everything hanging off it, and `workflow_definitions.read_project_scope` / `workflow_definitions.manage_project_scope` cover the whole tree:

| Sub-resource | Read | Edit |
|---|---|---|
| the type itself | `GET /types`, `GET /types/:key` | `POST /types`, `PUT`/`DELETE /types/:key` |
| task types | `GET /types/:key/task-types` | `PUT /types/:key/task-types` |
| field schemas | `GET .../field-schemas[/:schemaId]` | `POST`/`PUT`/`DELETE` |
| statuses and their metadata | `GET .../statuses[/:statusKey]` | `POST`/`PUT`/`DELETE` |
| outcomes | `GET .../outcomes[/:outcomeId]` | `POST`/`PUT`/`DELETE` |
| relationship types | `GET .../relationship-types[/:id]` | `POST`/`PUT`/`DELETE` |

All three path spellings (`/sprints`, `/workflows`, `/workflow-definitions`) resolve identically.

Scope comes from the type named in the path: it must exist in the caller's tenant and belong to the assigned project. A child row inherits that scope, so only the keyless `POST /types` — which brings a definition into being — has to name a `project_id` explicitly. A key that does not resolve is refused as absent whatever the method, including POST, so a request-supplied scope can never stand in for a definition that is not there.

`manage_project_scope` is off by default for scoped runtime keys and is not in `SCOPED_MCP_POLICY_MUTABLE_CAPABILITIES`, so an agent cannot grant it to itself. That default is worth keeping deliberately: statuses and outcomes are the transition graph, so this capability decides how work is allowed to flow, not just how it is labelled.

Reads have a second door regardless: `agent_hq_get_workflow_metadata` returns the resolved statuses, transitions, outcomes and relationship types in one call and is covered by `projects.read_project_board`, which is why the phone profile can render a board without any definition-editing grant.

### Workflow lifecycle over MCP

`agent_hq_set_workflow_status` takes a `workflow_id`, a target `status`, and an optional `note` recorded on the audit entry. The status routes the call, because the transitions are not the same kind of write:

| Status | Endpoint | Effect |
|---|---|---|
| `planning`, `active`, `paused` | `PUT /api/v1/workflows/:id` | status field write; no end date, no agent stand-down |
| `complete` | `POST /api/v1/workflows/:id/complete` | stamps `ended_at`, disables the workflow's agents |
| `closed` | `POST /api/v1/workflows/:id/close` | stamps `ended_at` |

Setting `active` on a `complete` or `closed` workflow reopens it — there is deliberately no terminal-state guard, matching what the canvas allows.

`PUT /api/v1/workflows/:id` under `sprints.pause_active_sprint` accepts a body of `status` and `note` and nothing else, and only a non-terminal `status`. A patch that also carries `name`, `goal`, `repo_url`, `ended_at`, or `project_id` falls through to the administrative deny, so the pause grant cannot rename a workflow, rewrite its repo configuration, or move it to another project. Reaching `complete` or `closed` through the field write is refused for the same reason the tool routes them elsewhere: it would leave a workflow that reads as finished but never ended. General workflow editing remains `agent_hq_update_workflow` on an administrative key.

### OAuth for connectors

Claude and ChatGPT offer two auth modes for a custom connector: OAuth, or none. Neither has a
field for a static bearer token, so a published `/mcp` needs an authorization server. Agent HQ
runs one in-process, built on the MCP SDK's `mcpAuthRouter`.

Turn it on by telling Agent HQ the URL it is published at:

```bash
AGENT_HQ_PUBLIC_URL=https://hq.example.com
```

Nothing else is required. The issuer has to be the URL clients actually reach — it goes into
signed metadata and every redirect — so it is read from configuration rather than guessed from a
Host header. With it unset, OAuth stays off and `/mcp` accepts direct MCP keys only.

Then set the operator password, which is what the consent screen checks:

```bash
cd api
npx tsx src/bin/set-operator-password.ts            # prompts, no shell history
npx tsx src/bin/set-operator-password.ts --generate # or print a strong one
```

Endpoints, all mounted at the root:

| Path | Purpose |
|---|---|
| `/.well-known/oauth-authorization-server` | RFC 8414 authorization server metadata |
| `/.well-known/oauth-protected-resource/mcp` | RFC 9728 protected resource metadata |
| `/authorize` | Authorization endpoint; redirects to the consent screen |
| `/oauth/consent` | Consent screen — the operator password is checked here |
| `/token` | Authorization code and refresh token grants |
| `/register` | Dynamic client registration (RFC 7591) |
| `/revoke` | Token revocation (RFC 7009) |

The flow a connector runs: it POSTs to `/mcp` without a token, gets a 401 whose
`WWW-Authenticate` carries `resource_metadata=…`, follows that to the protected-resource
document, finds the authorization server, registers itself, and sends the operator to
`/authorize`. The operator sees which client is asking, which Agent HQ identity it will act as,
and what that identity can reach, then enters the operator password. The code comes back to the
client, which exchanges it with its PKCE verifier for tokens.

#### Design notes

**The access token is an MCP API key.** There is no separate token table. An issued access token
is a row in `mcp_api_keys` with `expires_at` and `oauth_grant_id` set, so identity resolution, the
capability policy, and the audit actor are the same code a local stdio client goes through. What
the connector may touch is the identity's capability policy, not anything OAuth decides — widening
a phone's reach is a policy edit.

**Public clients only.** No client secret is issued or stored. Confidential clients would require
a secret this server can compare in the clear, and PKCE — which OAuth 2.1 requires of every client
anyway — is what actually binds the token request to the software that started the flow.

**Refresh tokens rotate, and reuse kills the family.** Each refresh issues a new token and marks
the old one superseded, keeping its hash so a replay is recognisable. Presenting a superseded or
revoked token revokes every grant in the rotation chain along with its access tokens: a client
replaying a token it should have discarded is either buggy or compromised, and those are
indistinguishable from the server's side.

**One endpoint, many identities.** The connector chooses nothing; the operator does. Every agent
provisioned as a remote MCP client (`role = 'Remote MCP client'`) is offered on the consent screen
with its project and capability list, so Claude and ChatGPT can hit the same `/mcp` and act as
different identities with different audit actors. A returning client pre-selects whatever it
connected as last. The posted agent id is always validated against that eligibility list — an id
outside it is refused rather than defaulted, because an agent like Atlas resolves to trusted-admin
defaults and would bypass the capability policy entirely.

**The operator password is not user auth.** One password, scrypt-hashed in `app_settings`, with an
in-process lockout after five failures. It exists because Agent HQ has no login and an
authorization endpoint that authorizes anyone who reaches it is not an authorization endpoint. If
real user auth arrives, this is the piece it replaces.

| Variable | Default | Description |
|---|---|---|
| `AGENT_HQ_PUBLIC_URL` | none | Public HTTPS URL of this install. Enables OAuth. |
| `AGENT_HQ_OAUTH_ENABLED` | `1` | Set to `0` to keep OAuth off even with a public URL |
| `AGENT_HQ_OAUTH_AGENT_SLUG` | `claude-mobile` | Identity pre-selected on the consent screen |
| `AGENT_HQ_OAUTH_ALLOW_DCR` | `1` | Set to `0` to require pre-registered clients |
| `AGENT_HQ_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` | Access token lifetime |

### Smoke test

```bash
curl -sS -X POST http://127.0.0.1:3501/mcp \
  -H "Authorization: Bearer ahq_mcp_..." \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A valid key returns the profile's tool list. No key returns HTTP 401 with a JSON-RPC error and a `WWW-Authenticate` header.

---

## Configuration

The MCP server supports config via environment variables and optional local config file.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `AGENT_HQ_API_URL` | `http://localhost:3501` | Agent HQ API base URL |
| `AGENT_HQ_MCP_API_KEY` | none | Required agent-bound MCP API key |
| `MCP_RATE_LIMIT_RPM` | `60` | Max requests per minute |
| `AGENT_HQ_MCP_TOOL_PROFILE` | `full` | stdio server tool profile |

The HTTP transport is configured on the API process, not the stdio server:

| Variable | Default | Description |
|---|---|---|
| `AGENT_HQ_MCP_HTTP_ENABLED` | `1` | Set to `0` to unmount `/mcp` |
| `AGENT_HQ_MCP_HTTP_TOOL_PROFILE` | `mobile` | Tool profile exposed to remote clients |
| `AGENT_HQ_MCP_HTTP_RATE_LIMIT_RPM` | `120` | Per-key request ceiling |
| `AGENT_HQ_MCP_HTTP_ALLOWED_HOSTS` | none | Comma-separated Host allow-list; enables DNS rebinding protection |
| `AGENT_HQ_INTERNAL_BASE_URL` | `http://127.0.0.1:<port>` | Base URL the tool handlers call back into |

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
| `agent_hq_list_assignment_rules` | GET | `/api/v1/routing/assignment-rules?sprint_id=:sprintId` |
| `agent_hq_get_assignment_rule` | GET | `/api/v1/routing/assignment-rules/:id?sprint_id=:sprintId` |
| `agent_hq_create_assignment_rule` | POST | `/api/v1/routing/assignment-rules` |
| `agent_hq_update_assignment_rule` | PUT | `/api/v1/routing/assignment-rules/:id` |
| `agent_hq_delete_assignment_rule` | DELETE | `/api/v1/routing/assignment-rules/:id` |
| `agent_hq_list_assignment_rules` | GET | `/api/v1/routing/rules?sprint_id=:sprintId` compatibility alias |
| `agent_hq_get_assignment_rule` | GET | `/api/v1/routing/rules/:id?sprint_id=:sprintId` compatibility alias |
| `agent_hq_create_assignment_rule` | POST | `/api/v1/routing/rules` compatibility alias |
| `agent_hq_update_assignment_rule` | PUT | `/api/v1/routing/rules/:id` compatibility alias |
| `agent_hq_delete_assignment_rule` | DELETE | `/api/v1/routing/rules/:id` compatibility alias |
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
| `agent_hq_list_workflow_types` | GET | `/api/v1/sprints/types/list` |
| `agent_hq_list_workflow_type_task_types` | GET | `/api/v1/sprints/types/:key/task-types` |
| `agent_hq_update_workflow_type_task_types` | PUT | `/api/v1/sprints/types/:key/task-types` |
| `agent_hq_create_workflow_type` | POST | `/api/v1/sprints/types` |
| `agent_hq_update_workflow_type` | PUT | `/api/v1/sprints/types/:key` |
| `agent_hq_delete_workflow_type` | DELETE | `/api/v1/sprints/types/:key` |
| `agent_hq_list_workflow_type_field_schemas` | GET | `/api/v1/sprints/types/:key/field-schemas` |
| `agent_hq_get_workflow_type_field_schema` | GET | `/api/v1/sprints/types/:key/field-schemas/:schemaId` |
| `agent_hq_create_workflow_type_field_schema` | POST | `/api/v1/sprints/types/:key/field-schemas` |
| `agent_hq_update_workflow_type_field_schema` | PUT | `/api/v1/sprints/types/:key/field-schemas/:schemaId` |
| `agent_hq_delete_workflow_type_field_schema` | DELETE | `/api/v1/sprints/types/:key/field-schemas/:schemaId` |
| `agent_hq_list_tasks` | GET | `/api/v1/tasks` |
| `agent_hq_get_task` | GET | `/api/v1/tasks/:id` |
| `agent_hq_delete_task` | DELETE | `/api/v1/tasks/:id` |
| `agent_hq_get_task_notes` | GET | `/api/v1/tasks/:id/notes` |
| `agent_hq_get_task_history` | GET | `/api/v1/tasks/:id/history` |
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
