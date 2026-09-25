# Agent HQ — Infrastructure

Operational architecture, data model, and execution flow for Agent HQ.

This document is the implementation-facing companion to `README.md` and
[ARCHITECTURE_OVERVIEW.md](ARCHITECTURE_OVERVIEW.md). For installation, see
[SELF_HOSTING.md](SELF_HOSTING.md).

---

## 1. System overview

Agent HQ is an orchestration layer that sits between human planning and AI agent execution.

It provides:
- task/project/workflow state
- deterministic routing rules
- job execution tracking
- run observability and artifacts
- release-truth gating
- contract-driven dispatch (workflow + transport separation)
- task board and workflow board UX

---

## 2. Runtime topology

```text
┌────────────────────────────────────────────────────────────┐
│                        Agent HQ UI                         │
│               Next.js · default 127.0.0.1:3500             │
│                                                            │
│  Dashboard | Agents | Teams | Tasks | Projects | Workflows │
│  Workflow Definitions | Task Routing | Model Routing       │
│  Telemetry | Capabilities | Workspaces | Chat | Settings   │
└─────────────────────────┬──────────────────────────────────┘
                          │ HTTP (server-side proxy, operator token)
                          ▼
┌────────────────────────────────────────────────────────────┐
│                       Agent HQ API                         │
│          Express/TypeScript · default 127.0.0.1:3501       │
│                                                            │
│  /api/v1 REST · /mcp (Streamable HTTP MCP) · MCP OAuth     │
│                                                            │
│  Responsibilities:                                         │
│  - task persistence + lifecycle                            │
│  - routing rule resolution                                 │
│  - job dispatch via runtime abstraction                    │
│  - instance lifecycle (start/check-in/outcome/complete)    │
│  - contract generation (workflow + transport)              │
│  - release evidence + integrity                            │
│  - runtime end-event ingestion for transcript truth        │
│  - telemetry capture and queries                           │
└───────────────┬───────────────────────┬────────────────────┘
                │                       │
                ▼                       ▼
         PostgreSQL 17           Agent runtimes
                                  │
                                  ├─ OpenClaw gateway (WebSocket, default port 18789)
                                  ├─ Claude Code (local `claude` CLI process)
                                  ├─ Codex (local `codex` CLI process)
                                  ├─ Hermes (local `hermes` CLI process)
                                  └─ Webhook (HTTP POST to a configured URL)
```

---

## 3. Processes, ports, and background work

Agent HQ runs as two processes, the API and the UI, plus PostgreSQL. The Docker Compose stack
adds a one-shot migration container that must succeed before the API starts.

| Service | Default | Notes |
|--------|---------|-------|
| UI | `127.0.0.1:3500` | `PORT`, `AGENT_HQ_UI_HOST`; reaches the API at `AGENT_HQ_INTERNAL_BASE_URL` |
| API | `127.0.0.1:3501` | `PORT`, `HOST` |
| PostgreSQL | `DATABASE_URL` | PostgreSQL 17; not published to the host by Compose |
| OpenClaw gateway | `127.0.0.1:18789` | `OPENCLAW_GATEWAY_URL`, or the port in `~/.openclaw/openclaw.json` |

Compose publishes the UI and API ports on `AGENT_HQ_BIND_ADDRESS` (default `127.0.0.1`).
`ecosystem.dev.config.js` runs a second instance on 3510/3511 against
`AGENT_HQ_DEV_DATABASE_URL`, for installs that keep a development copy beside production.

The API process also runs the background loops. They start only after the startup schema
check passes:

| Loop | Interval | What it does |
|---|---|---|
| Reconciler | ~12s | Runtime execution reconciliation, missing-outcome handling after a runtime ends, recurring task series, per-project dispatch, review routing, orphaned in-progress recovery, token backfill |
| Watchdog | 60s | Startup, heartbeat, and execution-timeout detection; stops and records stale runs |
| Worktree prune | 30 min | Removes orphaned task worktrees |
| Workflow check | 5 min | Completes workflows that reached their time or run limit |
| Telemetry workers | continuous | Project captured observations; run queued telemetry queries |

`AGENT_HQ_DISABLE_AUTOMATION=1` turns off the reconciler and watchdog (telemetry capture keeps
running). Task mutations also trigger an immediate dispatch pass for the affected project.

---

## 4. Key paths

| Purpose | Default |
|--------|------|
| CLI data directory | `~/.agent-hq/` (operator token in `.env`, `config.json`, `local.json`, native-mode `source/`, the packaged `docker-compose.yml`) |
| Agent contract templates | `agent-contracts/` in the repository, or `AGENT_CONTRACT_ROOT` |
| Uploaded files | `uploads/` in the repository, or `AGENT_HQ_UPLOADS_DIR` |
| Starter agent workspaces | `~/.openclaw/workspace-<tenant>-<agent>`, or under `WORKSPACE_PARENT` |
| Task worktrees | `task-<id>` under the agent's workspace (or the OS user's workspaces directory when the agent runs as a separate OS user) |
| OpenClaw configuration | `~/.openclaw/openclaw.json`, or `OPENCLAW_CONFIG_PATH` |

---

## 5. Major subsystems

### 5.1 Task system
Tasks are the canonical work units. They store project/workflow placement, agent assignment, task type, relationships, notes, attachments, release evidence, routing metadata, story points, and observability metadata.

### 5.2 Routing system
Routing is deterministic, built from:
- **workflow task transitions** — workflow + task_type + from_status + outcome → to_status
- **assignment rules** (`workflow_task_routing_rules`) — workflow + task_type + status → agent (multi-rule, priority-ordered). A status with no matching rule does not dispatch.
- **transition requirements** — evidence gates per outcome and task type, scoped to a workflow or workflow type. There is no global fallback.
- **workflow event mappings** (`external_event_mappings`) — runtime, dispatcher, and external events mapped to a status change or an outcome.

Transitions, rules, and requirements can be scoped to a workflow type within a project or to a
single workflow. Teams can stamp a routing template onto the workflows they own; the template is
materialized as ordinary assignment rules.

Background passes never change a task's visible status. Visible movement comes from outcomes,
workflow events, or operator edits.

### 5.3 Contract system
Separates **workflow semantics** from **runtime transport**.

**Workflow contract** (`services/contracts/workflowContract.ts`):
- Reads the configured workflow for the task's workflow, task type, and current status
- `resolveWorkflow()` returns the current workflow phase and valid configured outcomes
- `resolveEvidenceRequirements()` returns the configured gate fields for those outcomes
- Treats workflow phase as derived contract phrasing only; phases do not create evidence requirements

**Transport adapters** (`services/contracts/transportAdapters.ts`):
- `local` — runtime has local Agent HQ MCP/capability access
- `remote-direct` — HTTP dispatch to an external URL; agents still report lifecycle through Agent HQ MCP/capability tools
- `resolveTransportMode()` selects transport from runtime type + config

Contract text is rendered from the templates in `agent-contracts/` (one per starter workflow type), which operators can edit.

Hermes runtime setup, config, and troubleshooting live in [Hermes Runtime Support](hermes-runtime.md). The cross-runtime run contract for local CLI runtimes is in [architecture/agent-runtime-boundary-v1.md](architecture/agent-runtime-boundary-v1.md).

### 5.4 Job dispatch / run tracking
Job instances track: dispatched/started/completed timestamps, session key, heartbeats, artifacts, token usage, abort state, and worktree path. Local CLI runtimes also record durable runtime executions and checkpoints so a restarted API can decide what happened to a run.

### 5.5 Release truth
Evidence gates are config-driven. Code validates configured requirement rows and does not infer required evidence from workflow phase labels, status names, or outcome names.

Canonical evidence is stored and returned through workflow-defined `custom_fields` plus resolved field schema metadata:
- Review: `review_branch`, `review_commit`, `review_url`
- QA: `qa_verified_commit`, `qa_tested_url`
- Deploy: `merged_commit`, `deployed_commit`, `deploy_target`, `deployed_at`
- Live verification: `live_verified_by`, `live_verified_at`

Requirement rows can be blocking (`block`) or warning-only (`warn`). `required` checks can use `field_a|field_b` when either evidence field is acceptable, `match` checks compare one field to another, and `from_status` checks ensure an outcome is only accepted from the configured task status.

The starter Development workflow gates `completed_for_review` on `review_branch` and `review_commit`, and `qa_pass` on status `review` plus a `qa_verified_commit` that matches `review_commit`.

### 5.6 Telemetry
Configurable telemetry (`/api/v1/telemetry/v2`): database triggers capture observations from canonical tables into an outbox inside the writer's transaction; versioned metric, profile, report, and dashboard definitions are evaluated against them, and every result keeps its contributing records. See [telemetry-capture-inventory.md](telemetry-capture-inventory.md), [telemetry-analysis-and-dashboards.md](telemetry-analysis-and-dashboards.md), and [dashboard-pages.md](dashboard-pages.md).

### 5.7 Authentication
Every `/api/v1` request carries the operator token or an agent MCP key; `/mcp` authenticates its own key or OAuth grant. See [SELF_HOSTING.md#authentication](SELF_HOSTING.md#authentication).

---

## 6. Core routes

All routes are under `api/src/routes/`.

| Route file | Prefix | Purpose |
|---|---|---|
| `agents.ts` | `/api/v1/agents` | Agent CRUD, provisioning, docs, MCP access |
| `artifacts.ts` | `/api/v1/artifacts` | Workspace file browsing and editing |
| `chat.ts` | `/api/v1/chat` | Chat send/abort, transcripts, attachments, WebSocket proxy |
| `dispatch.ts` | `/api/v1/dispatch` | Manual trigger, reconcile, status, log |
| `external-task-events.ts` | `/api/v1/external` | Workflow events from trusted external systems |
| `github-identities.ts` | `/api/v1/github-identities` | GitHub credential CRUD |
| `instances.ts` | `/api/v1/instances` | Lifecycle: start, check-in, complete, stop |
| `logs.ts` | `/api/v1/logs` | System log viewer |
| `mcp-servers.ts` | `/api/v1/mcp-servers` | External MCP server registry and agent assignments |
| `model-routing.ts` | `/api/v1/model-routing` | Model routing rules (scope + story points → model settings) |
| `project-files.ts` | `/api/v1/projects/:id/files` | Project file uploads |
| `projects.ts` | `/api/v1/projects` | Project CRUD, stats, export/import |
| `provider-connections.ts` | `/api/v1/provider-connections` | Runtime provider connections and validation |
| `providers.ts` | `/api/v1/providers` | Provider config CRUD + validation |
| `recurring-task-series.ts` | `/api/v1/recurring-task-series` | Recurring task schedules |
| `routing.ts` | `/api/v1/routing` | Rules, transitions, statuses, requirements, graph, preview, trace, audit |
| `runtime-drivers.ts` | `/api/v1/runtime-drivers` | Runtime diagnostics |
| `sessions.ts` | `/api/v1/sessions` | Canonical chat/run sessions and transcript ingest |
| `settings.ts` | `/api/v1/settings` | Telegram, notifications, OpenClaw gateway config |
| `setup.ts` | `/api/v1/setup` | Onboarding and health checks |
| `skills.ts` | `/api/v1/skills` | Skill directory management |
| `tasks.ts` | `/api/v1/tasks` | Task CRUD + outcome + evidence + integrity + notes + relationships + attachments |
| `teams.ts` | `/api/v1/teams` | Teams, members, shared grants, routing templates |
| `telemetry-v2.ts` | `/api/v1/telemetry/v2` | Configurable telemetry: catalog, metrics, profiles, reports, dashboard pages, queries, export/import |
| `tenants.ts` | `/api/v1/tenants` | Tenants and the active tenant |
| `tools.ts` | `/api/v1/tools` | Tool registry CRUD + agent assignments |
| `workflow-files.ts` | `/api/v1/projects/:projectId/workflows/:workflowId/files` | Workflow-scoped file uploads and version history |
| `workflows.ts` | `/api/v1/workflows` | Workflow CRUD + metrics; workflow types under `/types` |

The MCP catalog is served at `/api/v1/mcp/catalog`, the OpenAPI document at `/openapi.json`,
and the health check at `/health`.

---

## 7. Data model

### 7.1 agents
One row per agent identity and its execution configuration.

Key fields: id, tenant_id, project_id, name, role, session_key, workspace_path, status, runtime_type, runtime_config, Remote Gateway URL (`hooks_url` compatibility column), Remote Gateway Auth Header (`hooks_auth_header` compatibility column), github_identity_id, model, preferred_provider, dispatch_mode, job_instructions, skill_names, enabled, timeout_seconds, os_user. The legacy `schedule` column is internal/deprecated; recurring task series own scheduling.

Legacy/internal compatibility: older databases may still retain `agents.job_title` and `agents.workflow_id`, but new agent configuration must not use them. Agents belong to projects; workflow-specific dispatch is configured with `workflow_task_routing_rules` using project/workflow or workflow type + task type + status → agent.

### 7.2 job_instances
Concrete runs. Key fields: id, agent_id, task_id, status, session_key, dispatched_at, started_at, completed_at, run_id, task_outcome, token_total, effective_model, payload_sent, response, error, abort_*, runtime_abort_target, worktree_path. `runtime_executions` and `runtime_checkpoints` hold the durable execution record for local CLI runs; `dispatch_context_bundles` keeps the context each run was given.

### 7.3 tasks
Key fields: id, title, description, status, priority, agent_id, project_id, workflow_id, task_type, story_points, active_instance_id, retry_count, max_retries, routing_reason, review_owner_agent_id, custom_fields_json. Lifecycle/release evidence such as review branch/commit/url, QA verified commit/tested URL, deploy commit/target/timestamp, and live verification metadata is canonical in `custom_fields_json` and exposed through task `custom_fields`.

### 7.4 Routing tables
- `workflow_task_transitions` — workflow transitions (workflow, task_type, from_status, outcome, to_status)
- `workflow_task_routing_rules` — task→agent assignment rules (workflow, task_type, status, agent, priority)
- `workflow_task_transition_requirements` — evidence gates per outcome, scoped to a workflow type
  or a single workflow. The only place gates live: a global `transition_requirements` fallback
  was moved into the dev workflow default and dropped by migration 15.
- `external_event_mappings` — workflow event mappings
- `story_point_model_routing` — model routing rules
- `routing_config_audit_log` — audit trail of routing configuration changes
- `routing_config` / `lifecycle_rules` / `routing_transitions` — legacy configuration tables retained for compatibility and migration; runtime task outcome routing uses explicit `workflow_task_transitions`
- `system_policies` — retained from the baseline schema; no current reader or writer

### 7.5 Observability tables
- `instance_artifacts` — per-instance stage, summary, commit, branch, heartbeat timestamps, stale flag
- `chat_messages` — transcript with event types (text, thought, tool_call, tool_result, turn_start, system, error)
- `logs` — execution logs per instance/agent
- `telemetry_*` — configurable telemetry (`/api/v1/telemetry/v2`): versioned definitions, captured observations, retained query results, coverage
- `task_outcome_metrics` — legacy per-task summary; task creation maintains `spawned_defects`, read by task reads and reflection context
- `task_events` — task status transitions, read by routing traces and telemetry backfill
- `task_creation_events`, `telemetry_schema_config` — retained legacy data; no current writer or reader

See [telemetry-legacy-consumers.md](telemetry-legacy-consumers.md) for the removed v1 telemetry API.

### 7.6 Supporting tables
tenants, projects, workflows, workflow types and their statuses/outcomes/task types/relationship types, task_field_schemas, task_notes, task_history, task_relationships, task_dependencies, task_attachments, project_files, workflow_files, recurring_task_series, recurring_task_runs, teams, team_members, provider_config, provider_connections, github_identities, tools, agent_tool_assignments, mcp_servers, agent_mcp_assignments, agent_mcp_capability_policies, mcp_api_keys, mcp_oauth_*, skills, app_settings, notification_records, security_events, dispatch_log.

Schema changes are numbered files in `db/pg-migrations/`; see
[database-migration-runbook.md](database-migration-runbook.md).

---

## 8. Task lifecycle

### Statuses
The starter Development workflow uses:

`todo → ready → in_progress → review → ready_to_merge → deployed → done`

Also: `dev_deploy_queued`, `dev_deploying`, `blocked`, `stalled`, `needs_attention`, `failed`, `cancelled`.

Other workflow types define their own statuses. The starter Generic (Backlog) workflow uses
`todo`, `ready`, `in_progress`, `review`, and `done`; Operations and Lead Generation have their
own status sets.

### Statuses, Outcomes, Workflow Phases
Statuses are task board states. Outcomes are agent-reported transition requests such as `completed_for_review`, `qa_pass`, `qa_fail`, `deployed_live`, `live_verified`, `blocked`, or `failed`. `qa_pass` is a QA outcome, not a board status; the starter Development route moves `review + qa_pass` directly to `ready_to_merge`. Workflow phase is derived internally from status and outcome configuration for contract phrasing; it is not persisted on transition rows and does not control dispatch.

The configured transition rows decide which outcomes are valid from each status and where they move the task next. The configured requirement rows decide which evidence fields block that outcome.

When a run starts, the default `agent_started` workflow event mapping moves the task to `in_progress`.

---

## 9. Dispatch model

Fully autonomous — no external cron jobs.

- **Reconciler** runs every ~12s: runtime reconciliation, recurring series, and a dispatch pass per project
- **Dispatcher**: selects eligible tasks, resolves the agent from assignment rules, resolves the runtime, builds the contract, and fires `runtime.dispatch()`
- **Eligible tasks** are in a non-terminal status, have no active run, are not paused, belong to an active workflow, and are not blocked by an unfinished related task. A task whose status has no assignment rule is skipped; an `in_progress` task with no live run is resolved with the workflow's `ready` rules.
- Repo-required workflow types (the starter Development type) block dispatch until the workflow has `repo_path` or `repo_url`
- Task mutations trigger an immediate dispatch pass for the affected project

### Runtime dispatch

| Runtime | Method | Stop |
|---|---|---|
| OpenClaw | `chat.send` on the gateway WebSocket, into an agent-scoped session | `chat.abort` RPC |
| Claude Code | Local `claude --print` process with stream-json output | SIGTERM to the process group, SIGKILL after a grace period |
| Codex | Local `codex exec --json` process | SIGTERM to the process group, SIGKILL after a grace period |
| Hermes | Local `hermes` CLI process | SIGTERM to the process group, SIGKILL after a grace period |
| Webhook | POST to `dispatchUrl` | POST to `abortUrl` (if configured) |

The runtime is chosen by `agents.runtime_type` (`api/src/runtimes/index.ts`); an unset value means `openclaw`.

### Model routing
Model routing rules (`story_point_model_routing`) are scoped to a project, a workflow type (within
a project or for all projects), or a single workflow; the most specific scope wins. Within a scope, a rule for the
agent's preferred provider wins over a provider-less rule, and the smallest `max_points`
bucket that covers the task's story points is chosen. A rule sets the model, thinking level,
fast mode, max turns, and max budget. A matching rule's model takes precedence over the agent's
own model. The default install adds project rules for up to 2, 5, and 13 story points.

---

## 10. Watchdog

| Check | Default |
|---|---|
| Poll interval | 60s |
| Start check-in grace | 5 min (per-agent override) |
| Heartbeat stale | 10 min (per-agent override) |
| Execution timeout | 20 min, or the agent's `timeout_seconds` |
| Orphaned worktree prune | every 30 min |

The legacy per-agent job scheduler is disabled; the recurring task series scheduler, run from the
reconciler, owns scheduled task creation.

---

## 11. GitHub identity management

`github_identities` holds fine-grained GitHub tokens per lane (for example dev, qa, release,
shared). An agent uses its own identity (`agents.github_identity_id`), or else the first enabled
`shared` identity. `injectGitHubCredentials()` writes the token and git config into the task
workspace. Which delivery paths reach the agent depends on the runtime; see
[github-identity-runtime-support.md](github-identity-runtime-support.md).

---

## 12. CI and releases

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests: API lint, tests
against PostgreSQL 17, and build; the workflow terminology check; UI verify and build; CLI and
OpenClaw plugin tests; and Docker image builds. CI does not deploy anything.

`.github/workflows/release-images.yml` builds and pushes the multi-arch API and UI images to
Docker Hub on version tags or a manual run. Deploying a self-hosted install is an operator
step; see [SELF_HOSTING.md](SELF_HOSTING.md#upgrades).

---

## 13. Documentation maintenance rule

Update this document when changing: dispatch/contract architecture, routing semantics, release gating, schema fields, stop/run control, runtime integrations, or major UX structure. Code wins over docs when they disagree.
