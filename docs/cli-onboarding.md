# Agent HQ CLI Onboarding Contract

This document defines the first-install onboarding experience for the Agent HQ
CLI. It is a product and implementation contract for `agenthq init`; it does
not require the implementation to exist yet.

The onboarding goal is to get a software-delivery team from a fresh install to
a runnable, reviewable Agent HQ instance without making them author raw
assignment rules, transition requirements, or model routing records in the happy
path.

## Command Surface

Primary command:

```bash
agenthq init
```

Compatibility aliases may be supported by the current package name:

```bash
agent-hq init
npx @nordinit/agent-hq init
```

`agenthq init` is the guided setup entrypoint. `agenthq start` remains the
runtime launcher. The init command may offer to start the instance at the end,
but it should not hide configuration generation behind `start`.

## Onboarding Modes

The CLI supports four setup modes. The default is `starter`.

| Mode | Purpose | Prompt budget | Generated scope |
|---|---|---:|---|
| `minimal` | Run Agent HQ with the fewest choices. | 3-5 prompts | Instance, one provider, one local runtime, one project, one fullstack agent, simple ready/review/done workflow. |
| `starter` | Recommended software-delivery MVP. | 8-12 prompts | Instance, providers, OpenClaw/Codex-capable runtime, software project, delivery workflow, PM/dev/QA/release agents, generated assignment rules, model defaults, verification. |
| `full` | Production-minded local install. | 15-25 prompts | Everything in starter plus GitHub identity, branch/deploy policy, evidence gates, notifications, backups, and optional MCP/client integration. |
| `advanced/manual` | Expert-controlled setup. | unbounded | Lets operators edit or import YAML/JSON, inspect generated rules, and opt into raw routing/model/workflow records. |

Mode selection prompt:

```text
Setup level? [starter]
  minimal  - shortest path to a local demo
  starter  - recommended software-delivery MVP
  full     - production-minded local setup
  advanced - review/edit raw config
```

Repair mode is not a separate setup level. It is entered automatically when
`agenthq init` detects an existing partial or unhealthy setup, or explicitly
with:

```bash
agenthq init --repair
```

## Ordered Wizard Sections

The wizard always follows this order. Modes may skip individual prompts inside a
section, but they should not reorder sections.

1. **Instance**
2. **Providers**
3. **Runtimes**
4. **Project / Workflow**
5. **Agents**
6. **Generated Routing**
7. **Model Defaults**
8. **Verification**

This order keeps infrastructure checks before workflow generation, and keeps
review of generated assignment/model policy after the CLI knows which agents
and task types exist.

## Wizard Sections

### 1. Instance

Purpose: decide where Agent HQ stores local state and how the user reaches it.

Prompts and defaults:

| Prompt | Minimal | Starter default | Full default |
|---|---|---|---|
| Instance name | `Local Agent HQ` | current directory or host-derived name | user-provided name |
| Data directory | `~/.agent-hq` | `~/.agent-hq` | prompt, default `~/.agent-hq` |
| UI port | `3500` | `3500` | prompt |
| API port | `3501` | `3501` | prompt |
| Start mode | local | local | local, Docker optional |

Behavior:

- Detect existing `~/.agent-hq/agent-hq.db`, `~/.agent-hq/local.json`, and port
  conflicts.
- Reuse existing state only after showing what will be reused.
- Prefer local mode for first install. Docker is an explicit full/advanced
  choice.
- Generate an instance id or use the API-created id once the local API is
  available.

### 2. Providers

Purpose: collect enough model-provider access for the generated agents to run.

Prompts and defaults for the software-delivery MVP:

| Prompt | Starter default |
|---|---|
| Primary provider | OpenAI |
| Connect now? | yes |
| Credential method | OAuth/device flow when available, otherwise env/secret prompt |
| Fallback provider | skip |

Provider requirements:

- At least one provider must pass a lightweight credential validation before the
  wizard can mark setup verified.
- Secrets must not be printed after entry.
- If the provider flow is skipped, continue only when the selected mode allows
  an unverified setup. Starter should warn and mark verification incomplete.

### 3. Runtimes

Purpose: choose the execution backends agents will use.

Prompts and defaults:

| Prompt | Starter default |
|---|---|
| Runtime for local agents | OpenClaw |
| Install or repair OpenClaw integration? | yes |
| Enable Agent HQ capability tools plugin? | yes |
| Allow local worktree execution? | yes |
| Additional runtime | skip |

Behavior:

- Verify required binaries and versions.
- Repair OpenClaw plugin configuration when safe.
- Do not silently grant broad tool permissions. Show the plugin/tool policy
  being applied.
- Full mode may add Claude Code, Hermes, webhook, or custom runtimes.

### 4. Project / Workflow

Purpose: define the first useful board without asking the user to design a
schema from scratch.

Prompts and defaults for software delivery:

| Prompt | Starter default |
|---|---|
| Work type | software delivery |
| Project name | current directory name or `Agent HQ Project` |
| Repository path | current directory if it is a Git repo, otherwise skip |
| Workflow template | `software-delivery-mvp` |
| Setup level for workflow | starter |
| Include release lane? | yes |
| Require QA before release? | yes |

Generated software-delivery MVP:

```text
Statuses:
todo -> ready -> in_progress -> review -> qa_pass -> ready_to_merge -> deployed -> done

Fallback / recovery status:
blocked

Task types:
frontend, backend, fullstack, qa, pm, ops, adhoc

Outcomes:
completed_for_review, qa_pass, qa_fail, approved_for_merge, deployed_live,
live_verified, blocked, failed

Evidence gates:
completed_for_review requires review_branch, review_commit
qa_pass requires qa_verified_commit, qa_tested_url
deployed_live requires deployed_commit, deploy_target, deployed_at
live_verified requires live_verified_by, live_verified_at
```

Minimal mode reduces the workflow to:

```text
todo -> ready -> in_progress -> review -> done
```

with task types:

```text
fullstack, adhoc
```

### 5. Agents

Purpose: create role-based agents from templates.

Prompts and defaults for starter:

| Prompt | Starter default |
|---|---|
| Agent naming style | suggested names |
| PM/planning agent | enabled |
| Frontend agent | enabled |
| Backend agent | enabled |
| Fullstack agent | enabled |
| QA agent | enabled |
| Release/ops agent | enabled |
| Runtime per agent | selected local runtime |
| Shared provider/model defaults | use generated model defaults |

Starter generated agents:

| Role | Handles |
|---|---|
| PM | `pm`, `pm_analysis`, `pm_operational`, blocked triage |
| Frontend | `frontend` implementation from `ready` |
| Backend | `backend` implementation from `ready` |
| Fullstack | `fullstack`, `adhoc` implementation from `ready` |
| QA | `review` verification for implementation task types |
| Release/Ops | `ready_to_merge`, deploy verification, operational tasks |

Minimal mode creates one fullstack agent and one lightweight PM/operator owner.

Full mode asks whether to split agents by repository, provider, runtime,
environment, or project lane.

### 6. Generated Routing

Purpose: show the rules the CLI will create without asking the user to write
them.

Starter generated assignment rules:

```text
frontend + ready -> frontend agent
backend + ready -> backend agent
fullstack + ready -> fullstack agent
adhoc + ready -> fullstack agent
pm + ready -> PM agent
ops + ready -> release/ops agent

frontend + review -> QA agent
backend + review -> QA agent
fullstack + review -> QA agent
adhoc + review -> QA agent

frontend + ready_to_merge -> release/ops agent
backend + ready_to_merge -> release/ops agent
fullstack + ready_to_merge -> release/ops agent
adhoc + ready_to_merge -> release/ops agent

any supported task type + blocked -> PM agent
```

Starter generated transitions and lifecycle moves:

```text
ready + dispatch start -> in_progress
in_progress + completed_for_review -> review
in_progress + blocked -> blocked
in_progress + failed -> blocked
review + qa_pass -> qa_pass
review + qa_fail -> ready
review + blocked -> blocked
qa_pass + approved_for_merge -> ready_to_merge
ready_to_merge + deployed_live -> deployed
deployed + live_verified -> done
blocked + resolved -> ready
```

Review screen:

```text
Agent HQ will create:
- 1 project
- 1 software-delivery workflow
- 6 agents
- 14 assignment rules
- 11 outcome transitions
- 4 evidence gates
- 3 model routing defaults

View details? [y/N]
Apply this setup? [Y/n]
```

Raw routing-rule editing is deferred to advanced/manual mode, the UI, or an
explicit export/edit/import command.

### 7. Model Defaults

Purpose: generate a sensible model policy without forcing first-time users to
learn the model-routing schema.

Starter defaults:

| Work class | Default policy |
|---|---|
| PM / planning | balanced reasoning model, medium thinking |
| Implementation | strong coding model, medium thinking |
| QA / review | strong reasoning model, medium/high thinking based on task size |
| Release / ops | strong reasoning model, medium thinking |
| Small/low-risk tasks | cheaper model when available |
| High priority or high story points | stronger model, higher thinking |

Prompt:

```text
Model policy? [balanced]
  economical - prefer lower cost for small tasks
  balanced   - use stronger models where mistakes are expensive
  quality    - prefer strongest configured models
```

The CLI should materialize this as model-routing defaults at the highest safe
scope:

1. workflow-specific rules when a workflow exists
2. workflow-type defaults for reusable templates
3. project fallback only when workflow scope is not available

### 8. Verification

Purpose: prove the generated setup can operate.

Verification checks:

- API starts and responds.
- UI starts and serves the expected port.
- Database is reachable.
- Provider gate passes for at least one connected provider.
- Runtime adapter health check passes.
- Agent HQ capability tools plugin is available when OpenClaw is selected.
- Generated project, workflow, agents, assignment rules, transitions, evidence
  gates, and model defaults can be read back from the API.
- A dry-run sample task resolves to the expected agent and model route.

Starter sample route checks:

```text
backend task, status ready -> backend agent
frontend task, status review -> QA agent
fullstack task, status ready_to_merge -> release/ops agent
pm task, status ready -> PM agent
```

The final success screen includes:

```text
Agent HQ is ready.
UI:  http://localhost:3500
API: http://localhost:3501
Project: <project name>
Workflow: Software Delivery MVP
Next: agenthq open
```

If verification is incomplete, the CLI must state exactly which check failed
and whether the setup is usable, repairable, or blocked.

## Output Artifacts

The CLI may write these files:

| File | Purpose |
|---|---|
| `~/.agent-hq/agent-hq.db` | Local SQLite system of record. |
| `~/.agent-hq/local.json` | Runtime process state, ports, mode, source path. |
| `~/.agent-hq/init-plan.json` | Last generated setup plan before apply. Safe to inspect. |
| `~/.agent-hq/init-result.json` | Last applied setup summary and verification result. Safe to inspect. |
| `~/.agent-hq/source/` | Cached source checkout for local mode. |
| `~/.agent-hq/openclaw-plugin/` | Managed copy of the Agent HQ OpenClaw plugin when needed. |
| `~/.openclaw/openclaw.json` | OpenClaw plugin and tool policy updates when approved. |
| `.agent-hq/project.yaml` | Optional project-local declarative export in full/advanced mode. |

The API/database remains the source of truth after apply. The optional
project-local YAML is an export/import convenience, not a hidden second source
of truth.

## Secrets Policy

Secrets include provider API keys, OAuth refresh/access tokens, GitHub tokens,
webhook signing secrets, and runtime credentials.

Rules:

- Never store secrets in `.agent-hq/project.yaml`, `init-plan.json`, terminal
  transcripts, task notes, or generated docs.
- Prefer provider OAuth/device flows or existing runtime credential stores.
- If a local secret file is unavoidable, write it under `~/.agent-hq/secrets/`
  with owner-only permissions (`0600` for files, `0700` for directories).
- Store only secret references in the database or generated config.
- Redact secret values in all review screens. Show provider, account label, and
  validation status instead.
- Do not copy provider credentials into OpenClaw config unless that config is
  the selected credential store and the user approves it.
- Repair mode must validate secret presence without printing secret values.

## CLI vs UI vs YAML Boundaries

Keep in the CLI:

- first-run questions
- local runtime and port checks
- provider connection bootstrap
- template selection
- generation of project/workflow/agent/routing/model defaults
- concise plan review and apply
- repair of local init state
- verification and dry-run route checks

Defer to the UI:

- detailed workflow editing
- drag/drop board customization
- manual assignment-rule inspection and editing
- agent prompt/job-instruction refinement
- provider rotation and disconnect flows after first setup
- telemetry, run history, and audit review

Defer to YAML/import-export:

- repeatable team templates
- versioned workflow definitions
- bulk project/agent/rule migration
- reviewable changes in infrastructure repositories

Defer to advanced/manual commands:

- raw assignment-rule CRUD
- raw model-routing CRUD
- raw workflow transition/gate editing
- database repair beyond guided checks
- destructive reset or migration operations

Suggested advanced commands:

```bash
agenthq init --advanced
agenthq init --plan-only
agenthq init --export .agent-hq/project.yaml
agenthq init --from .agent-hq/project.yaml
agenthq routing validate
agenthq doctor
```

## Happy Path Transcript

```text
$ agenthq init

Agent HQ first-time setup

Setup level? [starter]
Project name? [acme-web]
Work type? [software delivery]
Repository path? [/Users/alex/acme-web]

Instance
UI port? [3500]
API port? [3501]
Data directory? [~/.agent-hq]

Providers
Primary provider? [OpenAI]
Connect OpenAI now? [Y/n] y
OpenAI connected as alex@example.com.

Runtimes
Use OpenClaw for local agents? [Y/n] y
OpenClaw found.
Enable Agent HQ capability tools plugin? [Y/n] y

Workflow
Template? [software-delivery-mvp]
Require QA before release? [Y/n] y
Include release lane? [Y/n] y

Agents
Create PM, frontend, backend, fullstack, QA, and release/ops agents? [Y/n] y
Model policy? [balanced]

Review plan
Agent HQ will create:
- project: acme-web
- workflow: Software Delivery MVP
- agents: PM, Frontend, Backend, Fullstack, QA, Release/Ops
- assignment rules: implementation, review, release, and blocked triage lanes
- evidence gates: review, QA, deploy, live verification
- model defaults: planning, implementation, QA/release

View generated rules? [y/N] n
Apply this setup? [Y/n] y

Applying setup...
✓ database ready
✓ provider connected
✓ OpenClaw plugin enabled
✓ project created
✓ workflow created
✓ agents created
✓ assignment rules generated
✓ model defaults generated
✓ sample routes verified

Agent HQ is ready.
UI:  http://localhost:3500
API: http://localhost:3501
Next: agenthq open
```

## Repair Mode Transcript

```text
$ agenthq init --repair

Agent HQ repair

Found existing setup:
- data directory: ~/.agent-hq
- database: present
- local state: API pid missing, UI pid running
- UI port 3500: in use by Agent HQ
- API port 3501: not responding
- OpenClaw plugin: configured, plugin path missing
- provider gate: no connected provider

Repair actions:
- stop stale UI process record
- restart API and UI
- restore managed OpenClaw plugin copy
- re-check provider connection

Continue? [Y/n] y

Repairing...
✓ cleared stale process state
✓ API started on http://localhost:3501
✓ UI responding on http://localhost:3500
✓ OpenClaw plugin restored
! provider gate incomplete

Connect a provider now? [Y/n] y
Primary provider? [OpenAI]
OpenAI connected as alex@example.com.

Verifying setup...
✓ provider connected
✓ runtime health check passed
✓ generated workflow readable
✓ sample backend task routes to Backend agent

Agent HQ is repaired.
UI:  http://localhost:3500
Next: agenthq open
```

## Non-Goals For First Implementation

- Building a full no-code workflow editor in the terminal.
- Exposing every routing/model/workflow table field in the happy path.
- Supporting every possible work domain in first-run prompts.
- Migrating production self-hosted installs automatically without an explicit
  repair or advanced mode.
- Treating generated YAML as the runtime source of truth.

## Acceptance Checklist

- `agenthq init` offers `minimal`, `starter`, `full`, and `advanced/manual`.
- Wizard sections run in the required order: instance, providers, runtimes,
  project/workflow, agents, generated routing, model defaults, verification.
- Starter defaults produce a software-delivery MVP without raw routing-rule
  authoring.
- Generated assignment rules, transitions, evidence gates, and model defaults
  are reviewed before apply.
- Output artifacts and secrets handling are explicit.
- The contract states what stays in CLI and what is deferred to UI, YAML, or
  advanced commands.
- Happy path and repair mode terminal transcripts are included.
