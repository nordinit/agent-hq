# Agent HQ CLI Onboarding Contract

This document defines the first-install onboarding experience for the Agent HQ
CLI. It is a product and implementation contract for `agent-hq init`; it does
not require the implementation to exist yet.

The onboarding goal is to get a team from a fresh install to a runnable,
reviewable Agent HQ instance using one or more opinionated starter templates:
Development, Ops, and Lead Generation. The happy path asks owner-mapping
questions instead of raw assignment rules, transition requirements, or model
routing records.

## Command Surface

Primary command:

```bash
agent-hq init
```

Package runners may also invoke the same binary:

```bash
npx @nordinit/agent-hq init
```

`agent-hq init` is the guided setup entrypoint. `agent-hq start` remains the
runtime launcher. The init command may offer to start the instance at the end,
but it should not hide configuration generation behind `start`.

## Onboarding Modes

The MVP CLI supports one guided starter experience, plus skip/manual fallback
when a user intentionally bypasses starter setup.

| Path | Purpose | Prompt budget | Generated scope |
|---|---|---:|---|
| `starter` | Recommended first setup. | 8-14 prompts | Providers, OpenClaw runtime, one project, selected Development/Ops/Lead Generation workflows, starter agents/roles, owner-based routing, model defaults, verification preview. |
| `manual/skip` | Bypass starter records. | 1 prompt | Marks onboarding complete for operators who will configure records later through supported APIs/UI. |

Template selection prompt:

```text
Select starter template(s) [development]
  development      - software delivery with dev lifecycle and evidence gates
  ops              - business ops issue/change-order flow
  lead-generation  - prospect intake, research, outreach, approval, follow-up
  blank            - manual shell
```

Repair mode is not a separate setup level. It is entered automatically when
`agent-hq init` detects an existing partial or unhealthy setup, or explicitly
with:

```bash
agent-hq init --repair
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
- Prefer local mode for first install. Docker is an explicit self-hosting
  choice outside the starter prompts.
- Generate an instance id or use the API-created id once the local API is
  available.

### 2. Providers

Purpose: collect enough model-provider access for the generated agents to run.

Prompts and defaults for the starter experience:

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

Prompts and defaults:

| Prompt | Starter default |
|---|---|
| Project name | current directory name or `Agent HQ Project` |
| Repository path | current directory if it is a Git repo, otherwise skip |
| Workflow templates | `development` |
| Template choices | `development`, `ops`, `lead-generation`, `blank` |

Generated starter template coverage:

```text
Development:
  statuses: todo, ready, in_progress, dev_deploy_queued, dev_deploying,
            review, qa_pass, ready_to_merge, deployed, done
  task types: backend, frontend, fullstack, qa
  evidence gates: review, QA, deploy, live verification

Ops:
  statuses: todo, intake, triage, risk_review, impact_review, action_plan,
            stakeholder_update, human_approval, blocked, stalled, done
  task types: ops, data, pm_operational, adhoc

Lead Generation:
  statuses: intake, qualification, research, outreach_draft, human_approval,
            sent, follow_up, done
  task types: lead, research, outreach, proposal, follow_up

```

### 5. Agents

Purpose: create role-based agents from owner mappings.

Prompts and defaults for starter:

| Prompt | Starter default |
|---|---|
| Implementation owner | Developer Agent |
| Review/QA owner | Review Agent |
| Release owner | Release Agent |
| PM/triage owner | PM Agent |
| Ops execution owner | Ops Agent |
| Prospect research owner | Research Agent |
| Outreach/proposal owner | Outreach Agent |
| Human approval owner | Approval Owner |
| Runtime per agent | selected local runtime |
| Shared provider/model defaults | use generated model defaults |

Starter generated agents:

| Role | Handles |
|---|---|
| Developer | Development implementation tasks from `ready` |
| Review | QA, risk review, and validation checkpoints |
| Release | Development `ready_to_merge` and release handoff |
| PM | Intake, qualification, triage, and ambiguous work |
| Ops | Action plans and stakeholder updates |
| Research | Prospect/account research |
| Outreach | Outreach, proposal drafts, sent/follow-up |
| Approval | Human approval checkpoints |

### 6. Generated Routing

Purpose: show the rules the CLI will create without asking the user to write
them.

Starter sample route checks:

```text
backend + ready -> implementation owner
backend + review -> review owner
backend + ready_to_merge -> release owner
ops + triage -> PM owner
ops + action_plan -> ops owner
ops + human_approval -> approval owner
research + research -> research owner
proposal + human_approval -> approval owner
```

Starter generated transitions and lifecycle moves include:

```text
in_progress + completed_for_review -> review
review + qa_pass -> ready_to_merge
review + qa_fail -> ready
ready_to_merge + deployed_live -> deployed
deployed + live_verified -> done
action_plan + completed -> stakeholder_update
stakeholder_update + completed -> human_approval
human_approval + completed -> done
outreach_draft + completed -> human_approval
sent + completed -> follow_up
```

Review screen:

```text
Agent HQ will create:
- 1 project
- selected workflows
- starter agents/roles for selected owner mappings
- owner-based assignment rules
- transitions and evidence gates
- model routing defaults

View details? [y/N]
Apply this setup? [Y/n]
```

Raw routing-rule editing is deferred to the UI or future follow-up commands.

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
Workflows: Development, Ops, Lead Generation
Next: agent-hq open
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
The API/database remains the source of truth after apply. Reproducible
onboarding plan export/import is a future follow-up, not a parallel MVP setup
path.

## Secrets Policy

Secrets include provider API keys, OAuth refresh/access tokens, GitHub tokens,
webhook signing secrets, and runtime credentials.

Rules:

- Never store secrets in `init-plan.json`, terminal
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

## CLI vs UI Boundaries

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

Defer to follow-up features after the starter experience is stable:

- reproducible onboarding plan export/import
- versioned workflow definitions and bulk migration
- raw assignment-rule CRUD
- raw model-routing CRUD
- raw workflow transition/gate editing
- database repair beyond guided checks
- destructive reset or migration operations

Possible future commands:

```bash
agent-hq init --plan-only
agent-hq routing validate
agent-hq doctor
```

## Happy Path Transcript

```text
$ agent-hq init

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
Starter templates? [development] development,ops

Agents
Who owns implementation work? [Developer Agent]
Who owns review/QA? [Review Agent]
Who owns releases? [Release Agent]
Who owns PM/triage? [PM Agent]
Who owns operations execution? [Ops Agent]
Who gives human approval? [Approval Owner]
Model policy? [balanced]

Review plan
Agent HQ will create:
- project: acme-web
- workflows: Development, Ops
- agents: Developer, Review, Release, PM, Ops, Approval
- assignment rules: implementation, review, release, ops action, approval lanes
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
Next: agent-hq open
```

## Repair Mode Transcript

```text
$ agent-hq init --repair

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
Next: agent-hq open
```

## Non-Goals For First Implementation

- Building a full no-code workflow editor in the terminal.
- Exposing every routing/model/workflow table field in the happy path.
- Supporting every possible work domain in first-run prompts.
- Migrating production self-hosted installs automatically without an explicit
  repair path.
- Treating generated files as the runtime source of truth.

## Acceptance Checklist

- `agent-hq init` offers one starter flow with Development, Ops, Lead
  Generation, and blank/manual fallback.
- Wizard sections run in the required order: instance, providers, runtimes,
  project/workflow, agents, generated routing, model defaults, verification.
- Starter defaults can create one or more workflows without raw routing-rule
  authoring.
- Generated assignment rules, transitions, evidence gates, and model defaults
  are reviewed before apply.
- Output artifacts and secrets handling are explicit.
- The contract states what stays in CLI and what is deferred to UI or later
  follow-up commands.
- Happy path and repair mode terminal transcripts are included.
