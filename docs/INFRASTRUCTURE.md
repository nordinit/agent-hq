# Agent HQ — Infrastructure

Operational architecture, data model, and execution flow for Agent HQ.

This document is the implementation-facing companion to `README.md`.

---

## 1. System overview

Agent HQ is a local orchestration layer that sits between human planning and AI agent execution.

It provides:
- task/project/sprint state
- deterministic routing rules
- job execution tracking
- run observability and artifacts
- release-truth gating
- contract-driven dispatch (workflow + transport separation)
- task board and sprint board UX

---

## 2. Runtime topology

```text
┌────────────────────────────────────────────────────────────┐
│                        Agent HQ UI                         │
│                  Next.js · localhost:3500                   │
│                                                            │
│  Dashboard | Tasks | Agents | Chat | Sprints | Routing     │
│  Capabilities | Workspaces | Telemetry | Projects | Logs   │
└─────────────────────────┬──────────────────────────────────┘
                          │ HTTP
                          ▼
┌────────────────────────────────────────────────────────────┐
│                       Agent HQ API                         │
│               Express/TypeScript · localhost:3501           │
│                                                            │
│  Routes: tasks, agents, instances, projects, sprints,      │
│          routing, telemetry, logs, chat, tools,             │
│          dispatch, providers, github-identities, browser    │
│                                                            │
│  Responsibilities:                                         │
│  - task persistence + lifecycle                            │
│  - routing rule resolution                                 │
│  - job dispatch via runtime abstraction                    │
│  - instance lifecycle (start/heartbeat/outcome/complete)   │
│  - contract generation (workflow + transport)               │
│  - release evidence + integrity                            │
│  - runtime end-event ingestion for transcript truth         │
└───────────────┬───────────────────────┬────────────────────┘
                │                       │
                ▼                       ▼
        SQLite database         Agent Runtimes
         agent-hq.db              │
                                  ├─ OpenClaw Gateway (localhost:18789)
                                  │    └─ local agents via hooks protocol
                                  ├─ Claude Code (local subprocess)
                                  ├─ Hermes (local CLI subprocess)
                                  └─ Webhook (generic HTTP)
```

---

## 3. Host environment

- **Machine:** Mac mini (Apple Silicon / arm64)
- **OS:** macOS / Darwin 24.6.0
- **Node:** v24.14.0
- **Repo path:** `~/agent-hq` ← canonical working repo

---

## 4. Ports

| Service | Port | Notes |
|--------|------|------|
| Agent HQ Production UI | 3500 | live Next.js app |
| Agent HQ Production API | 3501 | live Express API |
| Agent HQ Dev UI | 3510 | implementation + QA/review environment |
| Agent HQ Dev API | 3511 | implementation + QA/review environment |
| OpenClaw Gateway | 18789 | runtime, chat, hook-backed orchestration |
## 5. Key directories

| Purpose | Path |
|--------|------|
| Agent HQ repo | `~/agent-hq` |
| SQLite DB | `~/agent-hq/agent-hq.db` |
| OpenClaw root | `~/.openclaw/` |
| Agent sessions | `~/.openclaw/agents/*/sessions/` |
| Agent workspaces | `~/.openclaw/workspace-*` |

---

## 6. Major subsystems

### 6.1 Task system
Tasks are the canonical work units. They store project/sprint placement, agent assignment, task type, blockers, dependencies, notes, attachments, release evidence, routing metadata, story points, and observability metadata.

### 6.2 Routing system
Routing is deterministic, built from:
- **sprint task transitions** — sprint + task_type + from_status + outcome -> to_status
- **sprint task routing rules** — sprint + task_type + status → agent (multi-rule, priority-ordered)
- **transition requirements** — evidence gates per outcome, with sprint-specific rows preferred over global fallback rows
- **system policies** — stall detection, auto-retry, dispatched_unclaim

### 6.3 Contract system (task #632)
Separates **workflow semantics** from **runtime transport**.

**Workflow contract** (`services/contracts/workflowContract.ts`):
- Reads the configured workflow for the task's sprint, task type, and current status
- `resolveWorkflow()` returns the current workflow phase and valid configured outcomes
- `resolveEvidenceRequirements()` returns the configured gate fields for those outcomes
- Treats workflow phase as derived contract phrasing only; phases do not create evidence requirements

**Transport adapters** (`services/contracts/transportAdapters.ts`):
- `local` — runtime has local Agent HQ MCP/capability access
- `remote-direct` — HTTP dispatch to an external URL; agents still report lifecycle through Agent HQ MCP/capability tools
- `resolveTransportMode()` selects transport from runtime type + config

Hermes runtime support is implemented as a local CLI-backed adapter. Host setup, runtime config, lifecycle assumptions, and troubleshooting notes live in [Hermes Runtime Support](hermes-runtime.md).

### 6.4 Job dispatch / run tracking
Job instances track: dispatched/started/completed timestamps, session key, heartbeats, artifacts, token usage, abort state, and worktree path.

### 6.5 Release truth
Evidence gates are config-driven. Code validates configured requirement rows and does not infer required evidence from workflow phase labels, status names, or outcome names.

Canonical evidence fields:
- Review: `review_branch`, `review_commit`, `review_url`
- QA: `qa_verified_commit`, `qa_tested_url`
- Deploy: `merged_commit`, `deployed_commit`, `deploy_target`, `deployed_at`
- Live verification: `live_verified_by`, `live_verified_at`

Requirement rows can be blocking or warning-only. `required` checks can use `field_a|field_b` when either evidence field is acceptable, `match` checks compare one field to another, and `from_status` checks ensure an outcome is only accepted from the configured task status.

Dev environment: `3510/3511`. Production: `3500/3501`.

### 6.6 Telemetry
Task cycle time, QA breakdown, model usage, agent efficiency, creation/outcome quality tracking.

---

## 7. Core routes

| Route file | Prefix | Purpose |
|---|---|---|
| `agents.ts` | `/api/v1/agents` | CRUD, provision, claude-md, docs |
| `artifacts.ts` | `/api/v1/artifacts` | Workspace file browsing |
| `browser.ts` | `/api/v1/browser` | Playwright browser pool |
| `chat.ts` | `/api/v1/chat` | WebSocket chat proxy + transcript |
| `dispatch.ts` | `/api/v1/dispatch` | Manual trigger, reconcile, status, log |
| `github-identities.ts` | `/api/v1/github-identities` | Per-agent GitHub credential CRUD |
| `instances.ts` | `/api/v1/instances` | Lifecycle: start, check-in, complete, stop |
| `jobs.ts` | `/api/v1/jobs` | Job template CRUD (legacy compat) |
| `logs.ts` | `/api/v1/logs` | System log viewer |
| `model-routing.ts` | `/api/v1/model-routing` | Story point → model mapping |
| `project-files.ts` | `/api/v1/projects/:id/files` | Project file uploads |
| `projects.ts` | `/api/v1/projects` | Project CRUD + stats |
| `providers.ts` | `/api/v1/providers` | Provider config CRUD + validation |
| `routing.ts` | `/api/v1/routing` | Rules, transitions, statuses, types, requirements, policies |
| `settings.ts` | `/api/v1/settings` | Telegram config |
| `setup.ts` | `/api/v1/setup` | Onboarding/health check |
| `skills.ts` | `/api/v1/skills` | Skill directory management |
| `sprints.ts` | `/api/v1/sprints` | Sprint CRUD + metrics + scheduling |
| `tasks.ts` | `/api/v1/tasks` | Task CRUD + outcome + evidence + integrity + notes + blockers + attachments |
| `telemetry.ts` | `/api/v1/telemetry` | Task/run analytics |
| `tools.ts` | `/api/v1/tools` | Tool registry CRUD + agent assignments |

---

## 8. Data model

### 8.1 agents
1:1 mapping between identity and execution configuration. Merged from job_templates (task #459).

Key fields: id, name, role, session_key, workspace_path, status, runtime_type, runtime_config, Remote Gateway URL (`hooks_url` compatibility column), Remote Gateway Auth Header (`hooks_auth_header` compatibility column), github_identity_id, model, project_id, dispatch_mode, job_instructions, skill_names, enabled, timeout_seconds, os_user. The legacy `schedule` column is internal/deprecated; recurring task series own scheduling.

Legacy/internal compatibility: older databases may still retain `agents.job_title` and `agents.sprint_id`, but new agent configuration must not use them. Agents belong to projects; sprint-specific dispatch is configured with `sprint_task_routing_rules` using project/sprint or sprint type + task type + status → agent.

### 8.2 job_instances
Concrete runs. Key fields: id, agent_id, task_id, status, session_key, dispatched_at, started_at, completed_at, run_id, task_outcome, token_total, effective_model, payload_sent, response, error, abort_*, worktree_path.

### 8.3 tasks
Key fields: id, title, description, status, priority, agent_id, project_id, sprint_id, task_type, story_points, active_instance_id, retry_count, max_retries, routing_reason, review_owner_agent_id. Release evidence: review_branch/commit/url, qa_verified_commit/tested_url, merged_commit, deployed_commit/at/target, live_verified_at/by, evidence_json.

### 8.4 Routing tables
- `sprint_task_transitions` — primary workflow transitions (sprint, task_type, from_status, outcome, to_status)
- `sprint_task_routing_rules` — primary task→agent routing (sprint, task_type, status, agent, priority)
- `sprint_task_transition_requirements` — sprint-specific evidence gates per outcome
- `transition_requirements` — global fallback evidence gates per outcome
- `routing_config` / `lifecycle_rules` — legacy configuration tables retained for compatibility and migration; runtime task outcome routing must use explicit `sprint_task_transitions`
- `system_policies` — stall detection, auto-retry

### 8.5 Observability tables
- `instance_artifacts` — per-instance stage, summary, commit, branch, heartbeat timestamps, stale flag
- `chat_messages` — transcript with event types (text, thought, tool_call, tool_result, turn_start, system, error)
- `logs` — execution logs per instance/agent
- `task_creation_events` / `task_outcome_metrics` — telemetry

### 8.6 Supporting tables
projects, sprints, sprint_job_schedules, sprint_job_assignments, task_notes, task_history, task_dependencies, task_attachments, provider_config, github_identities, tools, agent_tool_assignments, story_point_model_routing, app_settings, security_events, dispatch_log.

---

## 9. Task lifecycle

### Statuses
`todo → ready → dispatched → in_progress → review → ready_to_merge → deployed → done`

Also: `stalled`, `failed`, `cancelled`.

### Statuses, Outcomes, Workflow Phases
Statuses are task board states. Outcomes are agent-reported transition requests such as `completed_for_review`, `qa_pass`, `approved_for_merge`, `deployed_live`, `live_verified`, `blocked`, or `failed`. `qa_pass` is a QA outcome, not a board status; the standard Development route moves `review + qa_pass` directly to `ready_to_merge`. Workflow phase is derived internally from status and outcome configuration for contract phrasing; it is not persisted on transition rows and does not control dispatch.

The configured transition rows decide which outcomes are valid from each status and where they move the task next. The configured requirement rows decide which evidence fields block that outcome.

---

## 10. Dispatch model

Fully autonomous — no external cron jobs.

- **Reconciler** runs every ~60s: eligibility + dispatch across all projects
- **Eligibility pass**: promotes ready tasks, gates retries, auto-advances QA-passed tasks
- **Dispatcher**: selects eligible tasks, resolves runtime, builds contract, fires via runtime.dispatch()
- Task mutations trigger opportunistic background dispatch immediately

### Runtime dispatch

| Runtime | Method | Stop |
|---|---|---|
| OpenClaw | POST /hooks/agent on gateway | Abort via hooks protocol |
| Claude Code | Local subprocess | Kill process |
| Webhook | POST to dispatchUrl | POST to abortUrl (if configured) |

### Model routing
Story-point-based: 1-2pt → haiku, 3-4pt → sonnet, 5+pt → opus. Agent override takes precedence.

---

## 11. Scheduler and watchdog

| Module | Function | Interval |
|---|---|---|
| scheduler | Legacy per-agent job scheduler disabled; recurring task series scheduler owns scheduled task creation | startup no-op |
| sprintScheduler | Sprint-specific job scheduling | Per trigger config |
| watchdog | Stalled/timeout detection, worktree cleanup, Telegram alerts | 60s poll |
| reconciler | Eligibility + dispatch sweep | ~60s |

Watchdog thresholds: startup grace 60min, execution timeout per-agent (default 20min), heartbeat stale 30min, worktree cleanup >24hr.

---

## 12. GitHub identity management

Per-agent GitHub credentials (task #613): `github_identities` table with fine-grained PATs per lane (dev, qa, release, shared). `injectGitHubCredentials()` writes env file to workspace. `buildGitHubIdentityContext()` adds instructions to dispatch prompt.

---

## 13. CI/CD

Push to `main` triggers self-hosted GitHub Actions: pull → build API → restart API → build UI → restart UI → health check. Process manager: PM2.

---

## 14. Documentation maintenance rule

Update this document when changing: dispatch/contract architecture, routing semantics, release gating, schema fields, stop/run control, runtime integrations, or major UX structure. Code wins over docs when they disagree.
