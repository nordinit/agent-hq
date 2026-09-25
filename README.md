# Agent HQ

**Agent HQ is an open-source control plane for AI agents doing real work.**

Route tasks to agents, enforce evidence gates, track runs, and automatically move work forward based on agent outcomes and external events.

Agent HQ sits between your planning system and your AI agent runtimes. It gives every agent run structured context, deterministic workflow rules, verifiable handoffs, and operator visibility.

![Agent HQ overview](docs/assets/agent-hq-social-preview.svg)

---

## Why Agent HQ exists

AI agents can now write code, run tests, call tools, update files, and operate inside real environments.

The hard part is no longer just “how do I run an agent?”

The hard part is:

- Which agent should receive this task?
- What context should it get?
- What outcome is it allowed to post?
- What evidence must it provide?
- What happens next?
- When should a human review the work?
- How do I audit what happened?

Agent HQ turns agent execution into a governed workflow.

Instead of ad hoc prompts and one-off agent runs, Agent HQ gives you a configurable task lifecycle:

```text
task → route → agent run → evidence → outcome → transition → next status / next agent
```

---

## What you can build with Agent HQ

Agent HQ is highly configurable, and a fresh install comes with a starter setup: a Default Project with Backlog, Development, Operations, and Lead Generation workflows, four starter agents (PM, Developer, Review, Ops), and the assignment rules, transitions, and gates that connect them.

Example, from the starter Development workflow:

```text
ready
  → the Developer agent is dispatched and works in an isolated task worktree
  → the agent records review evidence and posts completed_for_review
  → Agent HQ checks the gate: review_branch and review_commit must be set
  → task moves to review
  → the Review agent is dispatched
  → qa_pass (with qa_verified_commit matching review_commit) moves the task to ready_to_merge
  → qa_fail routes the task back to ready, which dispatches the Developer agent again
  → deployed_live and live_verified outcomes move the task to deployed, then done
```

The same workflow model can also be used for:

- autonomous software delivery
- QA and release pipelines
- research workflows
- operations workflows
- support escalation workflows
- compliance review workflows
- AI agency delivery pipelines
- human-in-the-loop agent processes

---

## Core features

| Capability | What it does |
|---|---|
| **Task orchestration** | Organize work into projects, workflows, tasks, task types, statuses, and priorities. |
| **No-code workflow configuration** | Configure task types, custom fields, statuses, outcomes, assignment rules, transitions, and gates through the UI. |
| **Deterministic task assignment** | Assign tasks to agents based on workflow, task type, and current status. |
| **Outcome-driven transitions** | Map agent-posted outcomes to the next task status. |
| **Evidence gates** | Require specific fields, or matching values, before an outcome can move a task forward. |
| **Workflow events** | Map runtime, deployment, or integration events to status changes or outcomes. |
| **Multiple runtimes** | Dispatch work to OpenClaw, Claude Code, Codex, Hermes, or webhook agents. |
| **MCP server** | Agents and MCP clients call back into Agent HQ to start runs, check in, record evidence, post notes, and submit outcomes. |
| **Worktree-backed execution** | For code workflows, Agent HQ creates an isolated git worktree or clone per task. |
| **Teams** | Group agents with a shared goal, shared tool and MCP grants, and a routing template for the workflows the team owns. |
| **Configurable telemetry** | Define your own metrics, reports, and dashboard pages, and drill into the records behind every number. |
| **Project export/import** | Export a project's workflows, agents, routing, and model routing as a JSON manifest and import it elsewhere with a preview. |
| **Open-source self-hosting** | Run Agent HQ locally or with Docker Compose under the MIT License. |

---

## Quickstart

Install the Agent HQ CLI:

```bash
npm install -g @nordinit/agent-hq
agent-hq start
agent-hq open
```

`agent-hq start` uses Docker Compose (PostgreSQL 17 included) when Docker is available. On first start it generates an operator token and keeps it in `~/.agent-hq/.env`. `agent-hq open` opens the UI at `http://localhost:3500` already signed in.

You can also run without a global install:

```bash
npx @nordinit/agent-hq start
```

Common commands:

```bash
agent-hq start      # start Agent HQ (Docker by default)
agent-hq restart
agent-hq status
agent-hq stop
agent-hq open       # open the UI, signed in
agent-hq token      # print the operator token
```

To run the API and UI as native Node processes against your own PostgreSQL server, use `agent-hq start --no-docker` with `DATABASE_URL` set. See [`cli/README.md`](cli/README.md).

`agent-hq onboard` connects a model provider and a runtime and creates starter records through the API. `agent-hq init` writes a first-install setup plan to `~/.agent-hq/config.json` (`--dry-run` prints it without writing). The design contract for the guided setup is [`docs/cli-onboarding.md`](docs/cli-onboarding.md); not all of it is implemented yet.

---

## Docker Compose

For a persistent self-hosted Docker setup from a source checkout:

```bash
git clone https://github.com/nordinit/agent-hq.git
cd agent-hq
cp .env.example .env
# In .env, set AGENT_HQ_OPERATOR_TOKEN to the output of `openssl rand -hex 32`,
# and set AGENT_HQ_POSTGRES_PASSWORD to a long URL-safe random value.
docker compose up --build -d
```

Compose refuses to start without `AGENT_HQ_OPERATOR_TOKEN`. This starts:

| Service | Description | Default port |
|---|---|---|
| `agent-hq-postgres` | PostgreSQL 17 | not published |
| `agent-hq-migrate` | One-shot schema install/upgrade; the API starts only after it succeeds | none |
| `agent-hq-api` | Express/TypeScript API | `127.0.0.1:3501` |
| `agent-hq-ui` | Next.js UI | `127.0.0.1:3500` |

Ports are published on `127.0.0.1` by default (`AGENT_HQ_BIND_ADDRESS`). Open `http://localhost:3500` and sign in with the operator token.

PostgreSQL data persists in the `agent-hq-postgres-data` volume; workspaces, editable contract templates, and uploaded files persist in `agent-hq-workspaces`, `agent-hq-contracts`, and `agent-hq-uploads`.

The Docker images contain Node and the built API and UI only: there are no `git`, `claude`, `codex`, `hermes`, or `openclaw` binaries in them. Claude Code, Codex, and Hermes agents, repo-backed workflows (task worktrees and clones), and OpenClaw MCP setup (the API calls the `openclaw` CLI) need a native install on the host where the agents run: `agent-hq start --no-docker`, or a source checkout. Webhook agents work from Docker. To reach an OpenClaw gateway on the host from the API container, set a host-reachable `OPENCLAW_GATEWAY_URL` (see `docker-compose.override.yml.example`).

See [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md) for configuration, external PostgreSQL, backups, and upgrades.

---

## Security and authentication

Agents run real CLIs with shell access on the host, so operator access to Agent HQ is effectively shell access.

- **Operator token.** Every `/api/v1` request needs `AGENT_HQ_OPERATOR_TOKEN` (as `Authorization: Bearer <token>`) or an agent's MCP API key, which is limited to the capabilities granted to that agent. The API refuses to start without a token of at least 32 characters. `agent-hq start` generates one. The UI has a sign-in page for the same token; the UI server attaches it to API calls and never sends it to the browser.
- **Loopback by default.** The API and UI listen on `127.0.0.1` (`HOST` and `AGENT_HQ_UI_HOST` for native installs, `AGENT_HQ_BIND_ADDRESS` for Compose). The API refuses cross-origin browser requests unless the origin is listed in `AGENT_HQ_ALLOWED_ORIGINS`. Put TLS in front before exposing either beyond the host.
- **Confined host paths.** Agent workspaces, runtime config homes, and runtime executables must be in allowed locations; extra ones are listed in `AGENT_HQ_ALLOWED_*` variables (see [Host paths and runtime executables](docs/SELF_HOSTING.md#host-paths-and-runtime-executables)).
- **Remote MCP connectors.** Publish only `/mcp` and the MCP OAuth endpoints, never the whole API port. OAuth is enabled when `AGENT_HQ_PUBLIC_URL` is set.
- **Upgrades.** `AGENT_HQ_AUTH_MODE=report` serves requests that enforcement would refuse and logs each caller, so existing scripts can be found and fixed before switching back to `enforce` (the default).

See [`SECURITY.md`](SECURITY.md) for the security model and how to report a vulnerability, and [Authentication](docs/SELF_HOSTING.md#authentication) for details.

---

## The Agent HQ workflow model

Agent HQ separates work definition, workflow policy, and runtime execution.

### 1. Work

Work is organized into:

```text
Project → Workflow → Task → Agent Run
```

A task can include:

- title
- description
- priority
- task type
- status
- story points
- custom fields
- attachments
- notes
- relationships to other tasks
- evidence fields
- run history

A workflow can represent any lifecycle, not just software delivery.

---

### 2. Workflow policy

Workflow behavior is configured on the **Task Routing** page. Rules can be scoped to a workflow type (for example, every Development workflow in a project) or to a single workflow.

#### Assignment rules

Assignment rules decide which agent receives a task.

A rule maps:

```text
workflow + task type + current status → agent
```

Dispatch happens only where an assignment rule matches the task's status. A status with no matching rule never dispatches. (One exception: an `in_progress` task with no live run is resolved with its workflow's `ready` rules.)

From the starter Development workflow:

```text
Development + backend/frontend/fullstack + ready → Developer Agent
Development + qa + ready → Review Agent
Development + each task type + review → Review Agent
Development + each task type + ready_to_merge → Ops Agent
```

#### Automatic transitions

Transitions decide how a task moves after an agent posts an outcome.

A transition maps:

```text
current status + agent outcome + task type → next status
```

From the starter Development workflow:

```text
in_progress + completed_for_review → review
review + qa_pass → ready_to_merge
review + qa_fail → ready
ready_to_merge + deployed_live → deployed
deployed + live_verified → done
```

When a run starts, the default `agent_started` event mapping moves the task to `in_progress`.

#### Evidence gates

Evidence gates define what must be true before an outcome can move a task forward. A gate row can require a field (or either of two fields), require one field to match another, or require the task to be in a given status. Each row has severity `block` (the outcome is refused) or `warn`.

From the starter Development workflow:

```text
completed_for_review:
  require review_branch
  require review_commit
  (review_url is optional)

qa_pass:
  require status review
  require qa_verified_commit and review_commit
  require qa_verified_commit to match review_commit
```

Gates are scoped to a workflow type or a single workflow. There is no global fallback: an outcome with no gate rows is not gated.

This makes agent workflows verifiable instead of purely prompt-based.

#### Workflow events

Events from Agent HQ itself or from trusted external systems can also move tasks. A mapping turns an event into a status change or an outcome, which then passes through the same transitions and gates.

Example, from the shipped default mappings:

```text
dev_environment_lease_manager reports deployed_for_qa
  → Agent HQ applies the reported review evidence
  → Agent HQ posts completed_for_review
  → task moves to review
```

External systems report events through `POST /api/v1/external/task-events`; see [`docs/external-task-events.md`](docs/external-task-events.md). Events are useful for:

- deploy systems
- CI/CD
- runtime failures
- environment managers
- webhook integrations
- internal automation systems

The Task Routing page also has a routing graph, a preview of a routing change before it is saved, and a trace of the path a task took.

---

### 3. Runtime execution

Agents are runtime-agnostic. Each agent record names one of the supported runtimes:

| Runtime | How Agent HQ runs it |
|---|---|
| `openclaw` (default) | Sends the task to an agent session on an OpenClaw gateway |
| `claude-code` | Runs the Claude Code CLI (`claude --print`) as a local process |
| `codex` | Runs the Codex CLI (`codex exec`) as a local process |
| `hermes` | Runs the Hermes CLI as a local process; see [`docs/hermes-runtime.md`](docs/hermes-runtime.md) |
| `webhook` | POSTs the task to a URL you configure, with an optional abort URL |

There is no runtime plugin interface. To connect an agent system that is not listed, use the `webhook` runtime, or implement the `AgentRuntime` interface in `api/src/runtimes/` and register it in `api/src/runtimes/index.ts`. The default install and the onboarding flow assume OpenClaw.

Each dispatched agent run receives:

- task context
- project context
- workflow contract
- allowed outcomes
- required evidence
- callback tools
- runtime-specific instructions

The runtime does the work. Agent HQ governs the lifecycle.

---

## Example: autonomous development workflow

The starter Development workflow uses these statuses:

```text
todo
  → ready
  → in_progress
  → review
  → ready_to_merge
  → deployed
  → done
```

It also has `dev_deploy_queued`, `dev_deploying`, `blocked`, `stalled`, `needs_attention`, `failed`, and `cancelled`.

Example loop:

1. A PM creates a backend task.
2. The task is moved to `ready`.
3. An assignment rule assigns it to the Developer agent.
4. Agent HQ dispatches the task with the project, task, workflow, and evidence contract.
5. The run starts and the task moves to `in_progress`. The agent works in an isolated worktree of the workflow's repository.
6. The agent records review evidence: branch, commit, and optionally a review URL.
7. The agent posts `completed_for_review`.
8. Agent HQ checks the configured evidence gates.
9. The task moves to `review`.
10. The Review agent receives the task.
11. The Review agent records the commit it verified and posts `qa_pass` or `qa_fail`.
12. `qa_pass` moves the task directly to `ready_to_merge`.
13. `qa_fail` moves it back to `ready`, which dispatches the Developer agent again.
14. The Ops agent receives `ready_to_merge` tasks. `deployed_live` (gated on a merged or deployed commit, a deploy target, and a deploy time) moves the task to `deployed`.
15. `live_verified` (gated on the deployed commit, who verified it, and when) moves the task to `done`. The starter has no assignment rule for `deployed`; add one if an agent should verify releases.

---

## UI overview

Agent HQ includes an operator UI for configuring and monitoring agent workflows.

| Page | What it does |
|---|---|
| **Dashboard** | Configurable dashboard pages built from metrics, saved views, and operational blocks; select a number to see the records behind it. See [`docs/dashboard-pages.md`](docs/dashboard-pages.md). |
| **Agents** | Create and configure agents and their runtimes. |
| **Agent detail** | Edit identity, runtime and execution settings, Agent HQ MCP access, skills, tools, and MCP servers; view run history, logs, and identity documents. |
| **Teams** | Group agents with a goal, charter, member roles, shared tool and MCP grants, and a routing template for the workflows the team owns. |
| **Tasks** | Kanban-style task board with workflow sections, and a detail page per task. |
| **Recurring Tasks** | Schedule recurring task creation into fixed workflows. |
| **Projects** | Manage project context, project files, agents, workflows, and the project audit log. |
| **Workflows** | Manage workflow instances. Each workflow has Overview, Tasks, Files (workflow-scoped files with version history), and Metrics tabs. |
| **Workflow Definitions** | Configure workflow types: allowed task types, status labels, task fields, relationship types, and run outcomes, with a per-type Metrics tab. Gates and routing live on Task Routing. |
| **Task Routing** | Edit assignment rules, automatic transitions, gate requirements, workflow events, and the agent contract; view the routing graph and trace tasks. |
| **Model Routing** | Pick model, thinking level, fast mode, turn limit, and budget by scope and story points. |
| **Telemetry** | Build metrics, analyze them by agent and over time, save reports, manage scoped meanings and profiles, check coverage, and import/export definitions. |
| **Capabilities** | Manage skills, tools, and MCP servers. |
| **Workspaces** | Browse and edit agent workspace files. |
| **Chat** | Send messages to agents or into a running task, attach files, and read transcripts with linked task context. |
| **Settings** | Tabs for Tenants, Display, Providers, OpenClaw Gateway, Notifications, GitHub, Logs, API (the OpenAPI console at `/settings/api`), and MCP. Telegram is connected at `/settings/connections`. |

---

## Architecture

```mermaid
flowchart LR
    Human["Operator / PM"]
    UI["Agent HQ UI<br/>Tasks · Agents · Routing · Telemetry"]
    API["Agent HQ API<br/>REST · lifecycle · MCP · transcripts"]
    DB[("PostgreSQL 17<br/>Agent HQ system of record")]
    Reconciler["Reconciler<br/>eligible work"]
    Dispatcher["Dispatcher<br/>resolve route + launch run"]
    Watchdog["Watchdog<br/>stale run recovery"]
    OpenClaw["OpenClaw runtime"]
    Claude["Claude Code runtime"]
    Codex["Codex runtime"]
    Hermes["Hermes runtime"]
    Webhook["Webhook runtime"]

    Human --> UI
    UI --> API
    API <--> DB
    API --> Reconciler
    Reconciler --> Dispatcher
    API --> Dispatcher
    API --> Watchdog
    Dispatcher --> OpenClaw
    Dispatcher --> Claude
    Dispatcher --> Codex
    Dispatcher --> Hermes
    Dispatcher --> Webhook
    OpenClaw --> API
    Claude --> API
    Codex --> API
    Hermes --> API
    Webhook --> API
```

Agent HQ has four main layers:

| Layer | Responsibility |
|---|---|
| **UI** | Operator surface for configuring workflows, agents, tasks, routing, and telemetry. |
| **API** | System of record for task state, lifecycle transitions, transcripts, MCP endpoints, and runtime integration. |
| **Reconciler / Dispatcher / Watchdog** | Finds eligible tasks, resolves routes, launches runs, and recovers stale or orphaned runs. |
| **Agent runtimes** | Execute the actual task using OpenClaw, Claude Code, Codex, Hermes, or a webhook agent. |

See [`docs/ARCHITECTURE_OVERVIEW.md`](docs/ARCHITECTURE_OVERVIEW.md) for a deeper system overview.

---

## Agent contract

Agent HQ dispatches tasks with a generated contract. The templates live in `agent-contracts/` and can be edited.

The contract tells the agent:

- what task it is working on
- what project/workflow context matters
- which outcomes are valid
- what evidence is required
- how to report progress
- how to write notes
- how to record evidence
- how to post the final outcome

Agents do not need to rely on final-message parsing.

Instead, Agent HQ provides lifecycle tools such as:

- `agent_hq_start_task_run`
- `agent_hq_check_in_task_run`
- `agent_hq_report_task_blocker`
- `agent_hq_record_review_evidence`, `agent_hq_record_qa_evidence`, `agent_hq_record_deploy_evidence`, `agent_hq_record_live_verification`
- `agent_hq_add_task_note`
- `agent_hq_post_task_outcome`

The workflow contract separates:

```text
workflow semantics
  from
runtime transport
```

That means the same workflow model can work across different agent runtimes.

---

## Worktree-backed agent dispatch

For software projects, Agent HQ can give each task its own checkout.

When a workflow has repository configuration, Agent HQ dispatches work into an isolated task workspace instead of letting multiple agents mutate the same checkout.

This is useful for:

- coding agents
- review agents
- QA agents
- release agents
- parallel implementation tasks
- safer autonomous development workflows

Current behavior:

- Workflows own repository configuration. `repo_path` points to a local git checkout (worktree mode, using native `git worktree`); `repo_url` makes Agent HQ clone the repository per task (clone mode).
- Workflow types can require a repository. The starter Development type does, so its tasks do not dispatch until the workflow has `repo_path` or `repo_url` set.
- New task branches start from `origin/<base branch>` when it exists (default `main`), falling back to the local branch.
- Installing dependencies in a task workspace is a separate, opt-in workflow setting; see [`docs/operations/workflow-environment-setup.md`](docs/operations/workflow-environment-setup.md).
- The watchdog removes orphaned worktrees.

---

## Model routing

Model routing rules choose model settings from a task's scope and size.

Inputs:

- scope: a project, a workflow type, or a single workflow (a workflow rule overrides a workflow-type rule, which overrides a project rule)
- a story-point threshold: the smallest `max_points` bucket that covers the task's story points wins
- the agent's preferred provider: only rules for that provider or for no provider apply, and a provider-specific rule wins a tie

Outputs:

- model (a provider-qualified name such as `anthropic/claude-sonnet-4-6`)
- thinking level
- fast mode
- max turns
- max budget (USD)

A matching rule's model takes precedence over the agent's own model. The default install adds project rules for up to 2, 5, and 13 story points.

This lets teams reserve higher-cost or higher-reasoning models for harder work while keeping simpler work efficient.

---

## Capabilities, skills, and MCP servers

Agent HQ manages what each agent can use:

- skills
- tools (a registry of bash, MCP, and function tools, assigned per agent or per team)
- external MCP servers
- the OpenClaw capability-tools plugin, which exposes an agent's assigned tools inside OpenClaw
- Agent HQ MCP access, granted per agent as capability permissions

This lets you define what each agent is allowed to use while keeping workflow orchestration centralized.

### Agent HQ MCP server

Agent HQ's own MCP server exposes more than 200 tools for projects, workflows, tasks, lifecycle, routing, agents, teams, and telemetry. Each caller authenticates with an agent's MCP API key and sees only the tools its permissions allow.

- **stdio:** `node api/dist/mcp/server.js` (built from `api/src/mcp/server.ts`) with `AGENT_HQ_MCP_API_KEY` set, for local clients.
- **Streamable HTTP:** `/mcp` on the API port, on by default, key required. OAuth for remote connectors is enabled when `AGENT_HQ_PUBLIC_URL` is set.
- **Catalog:** `GET /api/v1/mcp/catalog` lists every tool with its arguments and required permissions.

See [`docs/agent-hq-mcp.md`](docs/agent-hq-mcp.md).

---

## Telemetry

Telemetry is configurable rather than a fixed set of reports. You define metrics over tasks, workflow activity, projects, agents, and runs, using your own statuses, outcomes, and custom fields. Every number can be expanded into the records that contributed to it.

- **Metrics** are versioned definitions; saved views and reports pin a metric revision.
- **Analyze** breaks a metric down by agent and over time.
- **Dashboards** are configurable pages of metrics, saved views, comparison tables, and operational blocks.
- **Import/export** moves metric, report, profile, and dashboard definitions between installs.

The same features are available through the REST API (`/api/v1/telemetry/v2`) and MCP tools. See [`docs/telemetry-analysis-and-dashboards.md`](docs/telemetry-analysis-and-dashboards.md) and [`docs/dashboard-pages.md`](docs/dashboard-pages.md).

---

## Philosophy

Agent HQ is designed around:

- deterministic behavior over magical behavior
- visible state over hidden state
- auditable transitions over silent mutation
- workflow rules over prompt-only control
- evidence-backed handoffs over blind trust
- operator control over uncontrolled autonomy
- release truth that reflects reality, not aspiration

---

## License

Agent HQ is open source under the [MIT License](LICENSE). Copyright (c) 2026 Nord Initiatives LLC.

The license covers the code, not the Agent HQ name or logo.

---

## Development

### Requirements

- Node.js 22 (CI uses 22; the UI tests need 22.6 or newer)
- npm
- Git
- PostgreSQL 17, with a role that has `CREATEDB` for running the API tests
- Docker, only if you want to test the Compose stack
- OpenClaw, Claude Code, Codex, or Hermes if you want to run agents locally

### Local development setup

```bash
git clone https://github.com/nordinit/agent-hq.git
cd agent-hq
cp .env.example .env
# In .env, set:
#   DATABASE_URL=postgresql://user:password@127.0.0.1:5432/agent_hq_dev
#   AGENT_HQ_OPERATOR_TOKEN=<output of `openssl rand -hex 32`>

cd api
npm ci
npm run build
npm run db:install   # installs the schema and starter records into DATABASE_URL

cd ../ui
npm ci
```

The API reads the repository-root `.env`. The UI does not, so pass it the API address and the same token.

Run the API:

```bash
cd api
npm run dev
```

Run the UI:

```bash
cd ui
AGENT_HQ_INTERNAL_BASE_URL=http://localhost:3501 \
AGENT_HQ_OPERATOR_TOKEN=<same token as .env> \
npm run dev -- -H 127.0.0.1
```

`-H 127.0.0.1` keeps the Next.js development server on loopback; without it, it listens on all interfaces.

Default ports:

```text
UI:  http://localhost:3500
API: http://localhost:3501
```

### Verification

API (tests need a PostgreSQL server where they can create and drop databases):

```bash
cd api
npm run lint
AGENT_HQ_TEST_PG_URL=postgresql://user:password@127.0.0.1:5432/postgres npm test
npm run build
```

UI:

```bash
cd ui
npm run verify   # unit tests + lint
npm run build
```

CLI and OpenClaw plugin, and the terminology check (from the repository root):

```bash
npm run test:cli
(cd plugins/openclaw-capability-tools && npm test)
node scripts/check-workflow-terminology.mjs
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution guidelines.

---

## Roadmap ideas

Agent HQ is actively evolving. Areas of interest include:

- richer approval gates
- shadow mode
- hosted runners
- private runners
- workflow marketplace
- organization template libraries
- deeper GitHub/GitLab integrations
- user accounts, stronger RBAC, and enterprise controls
- more runtime adapters
- more MCP integration packs

---

## FAQ

### Is Agent HQ an agent framework?

Not exactly.

Agent HQ does not try to replace your agent runtime. It orchestrates work across runtimes.

Use Agent HQ when you want to decide:

```text
which task goes to which agent,
what evidence is required,
what outcome is valid,
and what happens next.
```

### Is Agent HQ a Jira replacement?

Not necessarily.

Agent HQ can be used as a task system, but its main purpose is to govern agent-executed work. It can sit alongside planning tools or become the control plane for workflows where agents do the work.

### Does Agent HQ run the agents?

Agent HQ dispatches work to configured runtimes.

The runtime performs the actual work. Agent HQ provides the task context, workflow contract, callback tools, evidence gates, status transitions, logs, and operator visibility.

### Can I use my own agent runtime?

Yes, in two ways. The `webhook` runtime POSTs each task to a URL you run; your agent reports progress and outcomes back through the Agent HQ MCP tools or REST API. Or implement the `AgentRuntime` interface in `api/src/runtimes/` and add it to the runtime registry. There is no plugin mechanism for loading runtimes from outside the codebase.

### Can non-developers configure workflows?

Yes.

Task types, fields, statuses, outcomes, assignment rules, transitions, gates, and event mappings are configurable through the UI.

---

## Links

- Documentation index: [`docs/README.md`](docs/README.md)
- Architecture overview: [`docs/ARCHITECTURE_OVERVIEW.md`](docs/ARCHITECTURE_OVERVIEW.md)
- Self-hosting: [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md)
- MCP server: [`docs/agent-hq-mcp.md`](docs/agent-hq-mcp.md)
- Hermes runtime: [`docs/hermes-runtime.md`](docs/hermes-runtime.md)
- CLI: [`cli/README.md`](cli/README.md)
- Security: [`SECURITY.md`](SECURITY.md)
- Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- License: [`LICENSE`](LICENSE)
